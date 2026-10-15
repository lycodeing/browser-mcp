// emulate 工具的胶水实现：视口/触摸/UA/时区/语言/位置，加上原有的 CPU、网络、配色。
// 依赖（chrome、ok、err、ensureCdp、emulatedTabs、networkPresets）通过参数注入。
// emulatedTabs 是 Map<tabId, Set<项名>>，既用于导航时不断开调试器，也用于 reset 时逐项还原。
// 应用顺序固定；中途失败不回滚，已生效的项保留并在报错里列出。

import { planEmulation } from '../lib/emulation.js';

const GEO_NOTE = 'Note: the page can only read this location if the site already has location permission in Chrome; this tool cannot grant it.';

export function createEmulateTool({ chrome, ok, err, ensureCdp, emulatedTabs, networkPresets }) {
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

  async function applyPlan(tabId, plan, send) {
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
    if (plan.scheme != null) {
      await step('color scheme', () => send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: plan.scheme === 'auto' ? '' : plan.scheme }],
      }));
      applied.push(`color scheme ${plan.scheme}`); mark(tabId, 'scheme');
    }

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

  return async function toolEmulate(args) {
    const { tabId, reset = false } = args;
    if (!tabId) return err('tabId required');

    // 没有 reset 时先整理并校验入参，出错不附加调试器、不留下半成品
    let plan = null;
    if (!reset) {
      const planned = planEmulation(args);
      if (planned.error) return err(planned.error);
      plan = planned.plan;
      if (!Object.keys(plan).length) {
        return err('Nothing to apply: pass device, width/height, latitude/longitude, timezone, locale, cpuThrottlingRate, networkConditions, colorScheme, userAgent or reset');
      }
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

      const applied = await applyPlan(tabId, plan, send);
      const notes = [`Emulation applied: ${applied.join(', ')}. Overrides last until the debugger detaches (tab closed or DevTools opened) or reset:true.`];
      if (plan.geo) notes.push(GEO_NOTE);
      if (plan.locale) notes.push('locale also sets Accept-Language on requests the page sends.');
      return ok([{ type: 'text', text: notes.join('\n') }]);
    } catch (e) {
      if (e.applied) {
        const kept = e.applied.length ? ` Already applied and kept: ${e.applied.join(', ')}.` : ' Nothing was applied before the failure.';
        return err(`${e.message}.${kept} Call with reset:true to undo.`);
      }
      return err(e.message);
    }
  };
}
