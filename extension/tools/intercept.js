// intercept_add / intercept_list / intercept_remove 的胶水实现，以及 Fetch.requestPaused 的处理与 Service Worker 重启后的恢复。
// 依赖（chrome、ok、err、ensureCdp、store、markAttached、sleep）通过参数注入。
//
// 铁律：每个被暂停的请求必须被放行、失败或应答，否则页面请求会一直卡住（实验 X3 实测）。
// 所以 handlePaused 里任何异常都落到 continueRequest，规则查不到时宁可放行并关掉 Fetch。

import { validateRule, planResponse, formatRule, MAX_RULES_PER_TAB } from '../lib/intercept.js';

const STORAGE_KEY = 'intercept:v1';
const ENABLE_PARAMS = { patterns: [{ urlPattern: '*' }] };

export function createInterceptTools({ chrome, ok, err, ensureCdp, store, markAttached, sleep }) {
  const send = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
  // tabId -> 提示文案：重启恢复时被丢弃规则的标签页，intercept_list 读一次后清除
  const lost = new Map();
  // 已对"没有规则却仍在暂停请求"的标签页发过 Fetch.disable，避免重复发
  const disabledStray = new Set();

  async function persist() {
    try { await chrome.storage.session.set({ [STORAGE_KEY]: store.dump() }); } catch { /* 快照写失败只影响重启后的恢复 */ }
  }

  // Service Worker 每次启动都会跑一次：读快照，对每个原本生效的标签页先 Fetch.disable（放开所有在途暂停请求，
  // 包括定时器已随旧实例消失的 delay 请求），再按快照重新 Fetch.enable。调试器已不在的标签页丢弃规则并记提示。
  async function recover() {
    let snapshot;
    try { snapshot = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY]; } catch { /* 当作没有快照 */ }
    store.load(snapshot);
    let changed = false;
    for (const tabId of store.tabIds()) {
      if (!store.isActive(tabId)) continue;
      try {
        await send(tabId, 'Fetch.disable');
        await send(tabId, 'Fetch.enable', ENABLE_PARAMS);
        markAttached(tabId);
      } catch {
        store.dropTab(tabId);
        lost.set(tabId, 'Interception was turned off because the extension restarted and the debugger session on this tab was gone; its rules were dropped. Add them again with intercept_add.');
        changed = true;
      }
    }
    if (changed) await persist();
  }
  const ready = recover().catch(() => {});

  async function handlePaused(tabId, params) {
    const { requestId } = params;
    const cont = () => send(tabId, 'Fetch.continueRequest', { requestId }).catch(() => {});
    try {
      await ready;
      // 只设了请求阶段的 pattern，响应阶段的暂停不该出现；出现就直接放行
      if (params.responseStatusCode !== undefined || params.responseErrorReason !== undefined) return await cont();
      if (!store.has(tabId)) {
        await cont();
        if (!disabledStray.has(tabId)) {
          disabledStray.add(tabId);
          await send(tabId, 'Fetch.disable').catch(() => {});
        }
        return;
      }
      const plan = planResponse(store, tabId, params.request ?? {});
      if (plan.type === 'fail') {
        await send(tabId, 'Fetch.failRequest', { requestId, errorReason: plan.rule.errorReason });
      } else if (plan.type === 'fulfill') {
        await send(tabId, 'Fetch.fulfillRequest', { requestId, ...plan.params });
      } else if (plan.type === 'delay') {
        await sleep(plan.rule.delayMs);
        await send(tabId, 'Fetch.continueRequest', { requestId });
      } else {
        await cont();
      }
    } catch {
      await cont();
    }
  }

  async function toolAdd(args) {
    const { tabId } = args;
    if (!tabId) return err('tabId required');
    const { spec, error } = validateRule(args);
    if (error) return err(error);
    await ready;

    const wasKnown = store.has(tabId);
    const needEnable = !store.isActive(tabId);
    let rule;
    try { rule = store.add(tabId, spec); } catch (e) { return err(e.message); }
    disabledStray.delete(tabId);
    lost.delete(tabId);

    // 先入库再 Fetch.enable：enable 之后到达的暂停请求要能查到规则，否则会被当成"无规则"放行并关掉 Fetch
    if (needEnable) {
      try {
        await ensureCdp(tabId);
        await send(tabId, 'Fetch.enable', ENABLE_PARAMS);
        // await 期间调试器可能被断开并把标签页标成未生效，enable 成功后以此为准
        store.setActive(tabId, true);
      } catch (e) {
        store.remove(tabId, rule.id);
        if (wasKnown) store.setActive(tabId, false);
        return err(`Cannot enable interception on tab ${tabId}: ${e.message}. The rule was not added.`);
      }
    }
    await persist();
    const total = store.list(tabId).length;
    const lines = [`Added ${formatRule(rule)}`, `${total} rule${total === 1 ? '' : 's'} on tab ${tabId} (max ${MAX_RULES_PER_TAB}). The first matching rule wins.`];
    if (rule.action === 'fulfill') lines.push('Cross-origin requests get access-control-allow-origin echoed back and CORS preflights are answered automatically.');
    return ok([{ type: 'text', text: lines.join('\n') }]);
  }

  async function toolList(args) {
    const { tabId } = args;
    if (!tabId) return err('tabId required');
    await ready;
    const rules = store.list(tabId);
    const notes = [];
    if (lost.has(tabId)) { notes.push(lost.get(tabId)); lost.delete(tabId); }
    if (!rules.length) {
      return ok([{ type: 'text', text: ['No intercept rules on this tab.', ...notes].join('\n') }]);
    }
    const state = store.isActive(tabId) ? 'ON' : 'OFF';
    const lines = [`Intercept rules on tab ${tabId} (interception ${state}):`, ...rules.map((r) => `  ${formatRule(r)}`)];
    if (state === 'OFF') {
      lines.push('Interception is not active: the debugger was detached (DevTools opened, tab crashed). Call intercept_add to turn it back on for all rules, or intercept_remove to clear them.');
    }
    return ok([{ type: 'text', text: [...lines, ...notes].join('\n') }]);
  }

  async function toolRemove(args) {
    const { tabId, ruleId } = args;
    if (!tabId) return err('tabId required');
    await ready;
    if (ruleId !== undefined && !store.list(tabId).some((r) => r.id === ruleId)) {
      return err(`No rule ${ruleId} on tab ${tabId}; call intercept_list to see the rule ids`);
    }
    const wasActive = store.isActive(tabId);
    const removed = store.remove(tabId, ruleId);
    if (!removed) return ok([{ type: 'text', text: 'No intercept rules on this tab, nothing to remove.' }]);

    let note = '';
    if (!store.has(tabId)) {
      if (wasActive) {
        try { await send(tabId, 'Fetch.disable'); } catch (e) {
          note = ` Fetch.disable failed (${e.message}); paused requests are still continued automatically.`;
        }
      }
      note = ` Interception is off for this tab.${note}`;
    }
    await persist();
    return ok([{ type: 'text', text: `Removed ${removed} rule${removed === 1 ? '' : 's'}.${note}` }]);
  }

  return {
    ready,
    handlePaused,
    intercept_add: toolAdd,
    intercept_list: toolList,
    intercept_remove: toolRemove,
    /** 调试器被动断开：规则保留但标为未生效 */
    handleDetach(tabId) {
      if (!store.has(tabId)) return;
      store.setActive(tabId, false);
      persist();
    },
    handleTabRemoved(tabId) {
      lost.delete(tabId);
      disabledStray.delete(tabId);
      if (!store.has(tabId)) return;
      store.dropTab(tabId);
      persist();
    },
  };
}
