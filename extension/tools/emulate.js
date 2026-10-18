// emulate 工具族：由原先的单一 emulate 拆成三个语义清晰的工具。
// - emulate_device：视口/DPR/触摸/UA/设备预设
// - emulate_network：CPU 降速与网络限速
// - emulate_geo：地理位置、时区、语言
// 依赖（chrome、ok、err、ensureCdp、emulatedTabs、networkPresets）通过参数注入。
// emulatedTabs 是 Map<tabId, Set<项名>>，既用于导航时不断开调试器，也用于 reset 时逐项还原。
// 应用顺序固定；中途失败不回滚，已生效的项保留并在报错里列出。
// reset 由 emulate_device 承载（与旧 emulate 的 reset 一致，逐项还原全部覆盖）。

import { planEmulation } from '../lib/emulation.js';

const GEO_NOTE = 'Note: the page can only read this location if the site already has location permission in Chrome; this tool cannot grant it.';

export function createEmulateTools({ chrome, ok, err, ensureCdp, emulatedTabs, networkPresets }) {
  // tabId -> 最近一次 setUserAgentOverride 的参数，仅在 emulatedTabs 记录了 ua 时才可信
  const lastUa = new Map();

  const mark = (tabId, item) => {
    if (!emulatedTabs.has(tabId)) emulatedTabs.set(tabId, new Set());
    emulatedTabs.get(tabId).add(item);
  };
  const unmark = (tabId, item) => {
    const items = emulatedTabs.get(tabId);
    if (!items) return;
    items.delete(item);
    if (!items.size) emulatedTabs.delete(tabId);
  };

  async function pageUserAgent(send) {
    const r = await send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true });
    return r?.result?.value ?? '';
  }

  // 执行计划中的设备类项（viewport、touch、ua）；任何一项失败抛错并带上已生效项
  async function applyDevicePlan(tabId, plan, send) {
    const applied = [];
    const step = async (label, fn) => {
      try { return await fn(); } catch (e) {
        const err2 = new Error(`${label} failed: ${e.message}`);
        err2.applied = applied;
        throw err2;
      }
    };

    if (plan.viewport) {
      const v = plan.viewport;
      await step('viewport', () => send('Emulation.setDeviceMetricsOverride', { ...v, scale: 1 }));
      applied.push(`viewport ${v.width}x${v.height} @${v.deviceScaleFactor}x${v.mobile ? ' mobile' : ''}`);
      mark(tabId, 'viewport');
      await step('touch', () => send('Emulation.setTouchEmulationEnabled', { enabled: plan.touch, maxTouchPoints: plan.touch ? 5 : 1 }));
      applied.push(`touch ${plan.touch ? 'on' : 'off'}`);
      mark(tabId, 'touch');
    }

    const localeSet = plan.locale !== undefined && plan.locale !== '';
    if (plan.ua || plan.locale !== undefined) {
      let params;
      if (plan.ua?.userAgent === '') {
        await step('user agent', () => send('Emulation.setUserAgentOverride', { userAgent: '' }));
        lastUa.delete(tabId);
        unmark(tabId, 'ua');
        applied.push('user agent reset');
        if (localeSet) params = { userAgent: await step('read user agent', () => pageUserAgent(send)) };
      } else if (plan.ua) {
        params = { ...plan.ua };
      } else if (localeSet || emulatedTabs.get(tabId)?.has('ua')) {
        // 只改语言：沿用已有的 UA 覆盖，没有就读页面当前 UA
        params = lastUa.get(tabId) && emulatedTabs.get(tabId)?.has('ua')
          ? { ...lastUa.get(tabId) }
          : { userAgent: await step('read user agent', () => pageUserAgent(send)) };
      }
      if (params) {
        if (localeSet) params.acceptLanguage = plan.locale;
        else if (plan.locale === '') delete params.acceptLanguage;
        else if (plan.ua && emulatedTabs.get(tabId)?.has('locale') && lastUa.get(tabId)?.acceptLanguage) {
          // 只换 UA、没动语言：保留之前由 locale 带出的 Accept-Language
          params.acceptLanguage = lastUa.get(tabId).acceptLanguage;
        } else if (!plan.ua) delete params.acceptLanguage;
        for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
        await step('user agent', () => send('Emulation.setUserAgentOverride', params));
        lastUa.set(tabId, params);
        if (plan.ua) { mark(tabId, 'ua'); applied.push('user agent override'); }
      } else if (plan.locale === '') {
        // 没有 UA 覆盖可保留，直接清掉由 locale 带出的 acceptLanguage
        await step('locale', () => send('Emulation.setUserAgentOverride', { userAgent: '' }));
        lastUa.delete(tabId);
      }
    }
    return applied;
  }

  // 执行计划中的网络类项（cpu、network）
  async function applyNetworkPlan(tabId, plan, send) {
    const applied = [];
    const step = async (label, fn) => {
      try { return await fn(); } catch (e) {
        const err2 = new Error(`${label} failed: ${e.message}`);
        err2.applied = applied;
        throw err2;
      }
    };

    if (plan.cpu != null) {
      await step('CPU throttling', () => send('Emulation.setCPUThrottlingRate', { rate: plan.cpu }));
      applied.push(`CPU throttling ${plan.cpu}x`); mark(tabId, 'cpu');
    }
    if (plan.network != null) {
      const preset = networkPresets[plan.network];
      if (!preset) throw Object.assign(new Error(`Unknown networkConditions: ${plan.network}`), { applied });
      await step('network', () => send('Network.emulateNetworkConditions', preset));
      applied.push(`network ${plan.network}`); mark(tabId, 'network');
    }
    return applied;
  }

  // 执行计划中的地理类项（timezone、locale、geo）；locale 的 acceptLanguage 部分由设备类共享
  async function applyGeoPlan(tabId, plan, send) {
    const applied = [];
    const step = async (label, fn) => {
      try { return await fn(); } catch (e) {
        const err2 = new Error(`${label} failed: ${e.message}`);
        err2.applied = applied;
        throw err2;
      }
    };

    if (plan.timezone !== undefined) {
      await step('timezone', () => send('Emulation.setTimezoneOverride', { timezoneId: plan.timezone }));
      if (plan.timezone === '') { unmark(tabId, 'timezone'); applied.push('timezone reset'); }
      else { mark(tabId, 'timezone'); applied.push(`timezone ${plan.timezone}`); }
    }

    if (plan.locale !== undefined) {
      await step('locale', () => send('Emulation.setLocaleOverride', { locale: plan.locale }));
      if (plan.locale === '') { unmark(tabId, 'locale'); applied.push('locale reset'); }
      else { mark(tabId, 'locale'); applied.push(`locale ${plan.locale}`); }
    }

    if (plan.geo) {
      await step('geolocation', () => send('Emulation.setGeolocationOverride', plan.geo));
      mark(tabId, 'geo');
      applied.push(`location ${plan.geo.latitude},${plan.geo.longitude} (±${plan.geo.accuracy}m)`);
    }
    return applied;
  }

  // reset：CPU、网络、配色沿用旧行为（无条件还原），其余只还原记录过的项；单项失败不阻止其余
  async function resetAll(tabId, send) {
    const items = new Set(emulatedTabs.get(tabId) ?? []);
    const done = [];
    const failed = [];
    const run = async (label, fn) => {
      try { await fn(); done.push(label); } catch (e) { failed.push(`${label}: ${e.message}`); }
    };

    await run('CPU throttling', () => send('Emulation.setCPUThrottlingRate', { rate: 1 }));
    await run('network', () => send('Network.emulateNetworkConditions', networkPresets.none));
    await run('color scheme', () => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }] }));
    await run('user agent', () => send('Emulation.setUserAgentOverride', { userAgent: '' }));
    lastUa.delete(tabId);
    if (items.has('viewport')) await run('viewport', () => send('Emulation.clearDeviceMetricsOverride'));
    if (items.has('touch')) await run('touch', () => send('Emulation.setTouchEmulationEnabled', { enabled: false }));
    if (items.has('timezone')) await run('timezone', () => send('Emulation.setTimezoneOverride', { timezoneId: '' }));
    if (items.has('locale')) await run('locale', () => send('Emulation.setLocaleOverride', { locale: '' }));
    if (items.has('geo')) await run('geolocation', () => send('Emulation.clearGeolocationOverride'));
    emulatedTabs.delete(tabId);
    return { done, failed };
  }

  // 把公共流程封成工厂：校验入参 → 附加调试器 → 执行计划 → 汇报。
  // pickDescription 决定"Nothing to apply"错误里列出该工具支持的参数。
  const makeRunner = ({ planKeys, hint, run, extraNotes }) => async function toolEmulateX(args) {
    const { tabId, reset = false } = args;
    if (!tabId) return err('tabId required');

    // 没有 reset 时先整理并校验入参，出错不附加调试器、不留下半成品
    let plan = null;
    if (!reset) {
      const planned = planEmulation(args);
      if (planned.error) return err(planned.error);
      plan = planned.plan;
      const hasWork = planKeys.some((k) => plan[k] !== undefined);
      if (!hasWork) return err(`Nothing to apply: pass ${hint}`);
    }

    try {
      await ensureCdp(tabId);
      const send = (m, p) => chrome.debugger.sendCommand({ tabId }, m, p);

      if (reset) {
        const { done, failed } = await resetAll(tabId, send);
        if (failed.length) {
          return err(`Reset finished with errors. Restored: ${done.join(', ') || 'none'}. Failed: ${failed.join('; ')}`);
        }
        return ok([{ type: 'text', text: `Emulation reset: ${done.join(', ')}.` }]);
      }

      const applied = await run(tabId, plan, send);
      const notes = [`Emulation applied: ${applied.join(', ')}. Overrides last until the debugger detaches (tab closed or DevTools opened) or reset on emulate_device.`];
      for (const note of extraNotes(plan)) if (note) notes.push(note);
      return ok([{ type: 'text', text: notes.join('\n') }]);
    } catch (e) {
      if (e.applied) {
        const kept = e.applied.length ? ` Already applied and kept: ${e.applied.join(', ')}.` : ' Nothing was applied before the failure.';
        return err(`${e.message}.${kept} Call emulate_device with reset:true to undo.`);
      }
      return err(e.message);
    }
  };

  const toolEmulateDevice = makeRunner({
    planKeys: ['viewport', 'ua'],
    hint: 'device, width/height, deviceScaleFactor, mobile, userAgent or reset',
    run: applyDevicePlan,
    extraNotes: () => [],
  });

  const toolEmulateNetwork = makeRunner({
    planKeys: ['cpu', 'network'],
    hint: 'cpuThrottlingRate or networkConditions',
    run: applyNetworkPlan,
    extraNotes: () => [],
  });

  const toolEmulateGeo = makeRunner({
    planKeys: ['timezone', 'locale', 'geo'],
    hint: 'latitude/longitude, timezone or locale',
    run: (tabId, plan, send) => applyGeoPlan(tabId, plan, send).then(async (applied) => {
      // locale 需要同时下发 acceptLanguage（挂在 setUserAgentOverride 上），与设备类共享实现
      if (plan.locale === undefined) return applied;
      const deviceApplied = await applyDevicePlan(tabId, { locale: plan.locale }, send);
      return [...applied, ...deviceApplied.filter((a) => !applied.includes(a))];
    }),
    extraNotes: (plan) => [
      plan.geo ? GEO_NOTE : null,
      plan.locale ? 'locale also sets Accept-Language on requests the page sends.' : null,
    ],
  });

  return { toolEmulateDevice, toolEmulateNetwork, toolEmulateGeo };
}
