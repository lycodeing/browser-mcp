// tabs 工具的胶水实现：七个 action（list/create/close/activate/reload/duplicate/group）。
// 所有依赖（chrome、ok、err、waitForLoad、sleep）通过参数注入，避免与 background.js 循环引用。
// 按 action 的必填参数校验在本文件，缺参数时返回明确文案（relay 的 zod schema 是扁平的）。

import { normalizeUrl } from '../lib/url.js';
import {
  TAB_GROUP_COLORS, groupColor, findGroupByTitle, normalizeGroupName, isSystemUrl, formatTabList,
} from '../lib/tabs.js';

// create / duplicate 的加载等待上限（毫秒）
const LOAD_TIMEOUT_MS = 15000;

export function createTabsTool({ chrome, ok, err, waitForLoad, sleep }) {

  async function actionList(args) {
    const tabs = await chrome.tabs.query({});
    const groups = await chrome.tabGroups.query({});
    const text = formatTabList(tabs, groups, { group: args.group });
    return ok([{ type: 'text', text }]);
  }

  // 在指定窗口里按名字找组，找不到返回 null（不做模式匹配，见 lib/tabs.js 的说明）
  async function findGroupInWindow(windowId, name) {
    const groups = await chrome.tabGroups.query({ windowId });
    return findGroupByTitle(groups, name);
  }

  // 把标签页归入指定窗口的同名组（没有则新建并设颜色），返回组 id
  async function addToGroup(tabIds, windowId, name) {
    const existing = await findGroupInWindow(windowId, name);
    // 复用已有组也要调 tabs.group 归入；新建则先建组再设名字和颜色
    const groupId = await chrome.tabs.group({
      tabIds,
      ...(existing ? { groupId: existing.id } : { createProperties: { windowId } }),
    });
    if (!existing) {
      await chrome.tabGroups.update(groupId, { title: name, color: groupColor(name) });
    }
    return groupId;
  }

  async function actionCreate(args) {
    let groupName = null;
    if (args.group !== undefined) {
      // 组名先于创建校验，避免留下未归组的孤儿标签页
      groupName = normalizeGroupName(args.group);
      if (!groupName) return err(`Invalid group name: "${args.group}" (1-40 chars after trim)`);
    }

    let createProps = { active: args.active !== false };
    if (args.url !== undefined) {
      const normalized = normalizeUrl(args.url);
      if (normalized.error) return err(normalized.error);
      createProps.url = normalized.url;
    }

    const t0 = Date.now();
    const tab = await chrome.tabs.create(createProps);

    let groupNote = '';
    if (groupName) {
      await addToGroup([tab.id], tab.windowId, groupName);
      groupNote = ` in group "${groupName}"`;
      // 归组后重新读一次，保证返回的窗口信息准确
      Object.assign(tab, await chrome.tabs.get(tab.id));
    }

    if (args.url === undefined) {
      return ok([{ type: 'text', text: `Created tab [${tab.id}]${groupNote}` }]);
    }

    const loaded = await waitForLoad(tab.id, LOAD_TIMEOUT_MS);
    const finalTab = await chrome.tabs.get(tab.id);
    const ms = ((Date.now() - t0) / 1000).toFixed(1);
    if (!loaded) {
      return ok([{ type: 'text', text: `Created tab [${tab.id}]${groupNote}, still loading\nURL: ${finalTab.url}` }]);
    }
    return ok([{ type: 'text', text: `Created tab [${tab.id}]${groupNote}, loaded (${ms}s)\nURL: ${finalTab.url}\nTitle: ${finalTab.title}` }]);
  }

  async function actionClose(args) {
    const tabIds = args.tabIds;
    const existing = [];
    const missing = [];
    for (const id of tabIds) {
      try {
        await chrome.tabs.get(id);
        existing.push(id);
      } catch {
        missing.push(id);
      }
    }
    if (existing.length) await chrome.tabs.remove(existing);
    const lines = [`Closed ${existing.length} tab(s): ${existing.map(id => `[${id}]`).join(' ')}`];
    if (missing.length) lines.push(`Not found (skipped): ${missing.map(id => `[${id}]`).join(' ')}`);
    return ok([{ type: 'text', text: lines.join('\n') }]);
  }

  async function actionActivate(args) {
    const tab = await chrome.tabs.update(args.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return ok([{ type: 'text', text: `Activated tab [${args.tabId}]` }]);
  }

  async function actionReload(args) {
    await chrome.tabs.reload(args.tabId, { bypassCache: !!args.bypassCache });
    const loaded = await waitForLoad(args.tabId, LOAD_TIMEOUT_MS);
    const tab = await chrome.tabs.get(args.tabId);
    if (!loaded) return ok([{ type: 'text', text: `Reloaded tab [${args.tabId}], still loading\nURL: ${tab.url}` }]);
    return ok([{ type: 'text', text: `Reloaded tab [${args.tabId}] (complete)\nURL: ${tab.url}` }]);
  }

  async function actionDuplicate(args) {
    const t0 = Date.now();
    // chrome.tabs.duplicate 的返回值细节无文档，按 "Tab 或空" 防御式处理
    const newTab = await chrome.tabs.duplicate(args.tabId);
    if (!newTab || typeof newTab.id !== 'number') {
      return err(`Failed to duplicate tab [${args.tabId}]: no new tab returned`);
    }
    const loaded = await waitForLoad(newTab.id, LOAD_TIMEOUT_MS);
    const tab = await chrome.tabs.get(newTab.id);
    const ms = ((Date.now() - t0) / 1000).toFixed(1);
    if (!loaded) {
      return ok([{ type: 'text', text: `Duplicated tab [${args.tabId}] → [${tab.id}], still loading\nURL: ${tab.url}` }]);
    }
    return ok([{ type: 'text', text: `Duplicated tab [${args.tabId}] → [${tab.id}] (${ms}s)\nURL: ${tab.url}\nTitle: ${tab.title}` }]);
  }

  async function actionGroup(args) {
    const tabIds = args.tabIds;

    // 先读所有目标标签页，统一校验存在性与窗口一致性
    const tabs = [];
    for (const id of tabIds) {
      try {
        tabs.push(await chrome.tabs.get(id));
      } catch {
        return err(`Tab not found: ${id}`);
      }
    }
    const windowIds = new Set(tabs.map(t => t.windowId));
    if (windowIds.size > 1) {
      return err(`Tabs are in different windows (${tabs.map(t => `[${t.id}] w${t.windowId}`).join(', ')}); groups are per-window`);
    }
    const windowId = tabs[0].windowId;

    if (!args.group) {
      await chrome.tabs.ungroup(tabIds);
      return ok([{ type: 'text', text: `Removed ${tabIds.length} tab(s) from their group: ${tabIds.map(id => `[${id}]`).join(' ')}` }]);
    }

    const name = normalizeGroupName(args.group);
    if (!name) return err(`Invalid group name: "${args.group}" (1-40 chars after trim)`);

    const existing = await findGroupInWindow(windowId, name);
    const groupId = await chrome.tabs.group({
      tabIds,
      ...(existing ? { groupId: existing.id } : { createProperties: { windowId } }),
    });
    if (!existing) {
      await chrome.tabGroups.update(groupId, { title: name, color: groupColor(name) });
    }
    return ok([{ type: 'text', text: existing
      ? `Added ${tabIds.length} tab(s) to existing group "${name}" (window ${windowId})`
      : `Created group "${name}" (color ${groupColor(name)}, window ${windowId}) with ${tabIds.length} tab(s)` }]);
  }

  const ACTIONS = {
    list: [actionList, () => true],
    create: [actionCreate, args => args.url === undefined || typeof args.url === 'string'],
    close: [actionClose, args => Array.isArray(args.tabIds) && args.tabIds.length > 0, 'close requires tabIds'],
    activate: [actionActivate, args => Number.isInteger(args.tabId), 'activate requires tabId'],
    reload: [actionReload, args => Number.isInteger(args.tabId), 'reload requires tabId'],
    duplicate: [actionDuplicate, args => Number.isInteger(args.tabId), 'duplicate requires tabId'],
    group: [actionGroup, args => Array.isArray(args.tabIds) && args.tabIds.length > 0, 'group requires tabIds'],
  };

  return async function toolTabs(args) {
    const spec = ACTIONS[args.action];
    if (!spec) return err(`Unknown action: ${args.action}`);
    const [handler, validate, message] = spec;
    if (!validate(args)) return err(message || 'invalid arguments');
    try {
      return await handler(args);
    } catch (e) {
      return err(e.message);
    }
  };
}
