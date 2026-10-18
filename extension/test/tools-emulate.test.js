// tools/emulate.js 的测试：注入假 chrome.debugger，记录发出的 CDP 命令。
// 覆盖拆分后的三个工具：emulate_device / emulate_network / emulate_geo。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmulateTools } from '../tools/emulate.js';

const ok = content => ({ content });
const err = msg => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const text = r => r.content[0].text;

const NETWORK_PRESETS = {
  'Slow 3G': { offline: false, latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000 },
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

function setup({ failOn, pageUa = 'PageUA/1.0' } = {}) {
  const calls = [];
  let attached = 0;
  const chrome = {
    debugger: {
      async sendCommand(_target, method, params) {
        calls.push({ method, params });
        if (failOn && failOn === method) throw new Error(`boom ${method}`);
        if (method === 'Runtime.evaluate') return { result: { value: pageUa } };
        return {};
      },
    },
  };
  const emulatedTabs = new Map();
  const tools = createEmulateTools({
    chrome, ok, err, emulatedTabs, networkPresets: NETWORK_PRESETS,
    ensureCdp: async () => { attached++; },
  });
  const methods = () => calls.map(c => c.method);
  const find = m => calls.filter(c => c.method === m);
  return { ...tools, calls, methods, find, emulatedTabs, attachCount: () => attached };
}

// ── emulate_device ───────────────────────────────────────────────────────────

test('device 校验失败时不附加调试器、不发命令', async () => {
  const t = setup();
  const r = await t.toolEmulateDevice({ tabId: 1, device: 'nokia-3310' });
  assert.ok(r.isError);
  assert.match(text(r), /Unknown device/);
  assert.equal(t.attachCount(), 0);
  assert.equal(t.calls.length, 0);
});

test('emulate_device 什么参数都不传报错', async () => {
  const t = setup();
  const r = await t.toolEmulateDevice({ tabId: 1 });
  assert.ok(r.isError);
  assert.match(text(r), /Nothing to apply/);
  assert.match(text(r), /device/);
});

test('device 预设：视口、触摸、UA 依次下发', async () => {
  const t = setup();
  const r = await t.toolEmulateDevice({ tabId: 1, device: 'iphone-15' });
  assert.ok(!r.isError);
  assert.deepEqual(t.methods(), [
    'Emulation.setDeviceMetricsOverride',
    'Emulation.setTouchEmulationEnabled',
    'Emulation.setUserAgentOverride',
  ]);
  const metrics = t.find('Emulation.setDeviceMetricsOverride')[0].params;
  assert.equal(metrics.width, 393);
  assert.equal(metrics.deviceScaleFactor, 3);
  assert.equal(metrics.mobile, true);
  assert.equal(t.find('Emulation.setTouchEmulationEnabled')[0].params.enabled, true);
  assert.match(t.find('Emulation.setUserAgentOverride')[0].params.userAgent, /iPhone/);
});

test('自定义视口与显式 userAgent 只作用于设备类', async () => {
  const t = setup();
  const r = await t.toolEmulateDevice({ tabId: 1, width: 800, height: 600, deviceScaleFactor: 2, mobile: true, userAgent: 'Custom/1.0' });
  assert.ok(!r.isError);
  assert.deepEqual(t.find('Emulation.setDeviceMetricsOverride')[0].params,
    { width: 800, height: 600, deviceScaleFactor: 2, mobile: true, scale: 1 });
  assert.equal(t.find('Emulation.setUserAgentOverride')[0].params.userAgent, 'Custom/1.0');
  // 不应出现网络类或地理类的 CDP 命令
  assert.equal(t.find('Emulation.setCPUThrottlingRate').length, 0);
  assert.equal(t.find('Emulation.setGeolocationOverride').length, 0);
  assert.equal(t.find('Emulation.setTimezoneOverride').length, 0);
});

test('视口缺宽或高时在附加调试器之前报错', async () => {
  const t = setup();
  const r = await t.toolEmulateDevice({ tabId: 1, width: 800 });
  assert.ok(r.isError);
  assert.match(text(r), /width and height/);
  assert.equal(t.attachCount(), 0);
});

test('device 失败：不回滚，报错里列出已生效项并指向 reset', async () => {
  const t = setup({ failOn: 'Emulation.setTouchEmulationEnabled' });
  const r = await t.toolEmulateDevice({ tabId: 1, device: 'iphone-15' });
  assert.ok(r.isError);
  assert.match(text(r), /touch failed/);
  assert.match(text(r), /Already applied and kept/);
  assert.match(text(r), /viewport 393x852/);
  assert.match(text(r), /emulate_device with reset:true/);
  assert.ok(t.emulatedTabs.get(1).has('viewport'));
});

// ── emulate_network ──────────────────────────────────────────────────────────

test('emulate_network 的 CPU 与网络限速', async () => {
  const t = setup();
  const r = await t.toolEmulateNetwork({ tabId: 1, cpuThrottlingRate: 4, networkConditions: 'Slow 3G' });
  assert.ok(!r.isError);
  assert.deepEqual(t.methods(), ['Emulation.setCPUThrottlingRate', 'Network.emulateNetworkConditions']);
  assert.equal(t.find('Emulation.setCPUThrottlingRate')[0].params.rate, 4);
  assert.deepEqual(t.find('Network.emulateNetworkConditions')[0].params, NETWORK_PRESETS['Slow 3G']);
  assert.ok(t.emulatedTabs.get(1).has('cpu'));
  assert.ok(t.emulatedTabs.get(1).has('network'));
  assert.match(text(r), /CPU throttling 4x/);
  assert.match(text(r), /network Slow 3G/);
});

test('emulate_network 什么都不传报错并列出参数', async () => {
  const t = setup();
  const r = await t.toolEmulateNetwork({ tabId: 1 });
  assert.ok(r.isError);
  assert.match(text(r), /Nothing to apply/);
  assert.match(text(r), /cpuThrottlingRate or networkConditions/);
  assert.equal(t.calls.length, 0);
});

test('emulate_network 第一步失败时说明没有任何项生效', async () => {
  const t = setup({ failOn: 'Emulation.setCPUThrottlingRate' });
  const r = await t.toolEmulateNetwork({ tabId: 1, cpuThrottlingRate: 4 });
  assert.ok(r.isError);
  assert.match(text(r), /Nothing was applied/);
});

test('emulate_network 不碰视口与地理类命令', async () => {
  const t = setup();
  await t.toolEmulateNetwork({ tabId: 1, networkConditions: 'Slow 3G' });
  for (const m of ['Emulation.setDeviceMetricsOverride', 'Emulation.setGeolocationOverride', 'Emulation.setTimezoneOverride']) {
    assert.equal(t.find(m).length, 0, `${m} 不应被调用`);
  }
});

// ── emulate_geo ──────────────────────────────────────────────────────────────

test('emulate_geo：位置、时区、语言各自下发并附带权限提示', async () => {
  const t = setup();
  const r = await t.toolEmulateGeo({ tabId: 1, latitude: 35.68, longitude: 139.76, accuracy: 20, timezone: 'Asia/Tokyo', locale: 'ja-JP' });
  assert.ok(!r.isError);
  assert.deepEqual(t.find('Emulation.setGeolocationOverride')[0].params, { latitude: 35.68, longitude: 139.76, accuracy: 20 });
  assert.equal(t.find('Emulation.setTimezoneOverride')[0].params.timezoneId, 'Asia/Tokyo');
  assert.equal(t.find('Emulation.setLocaleOverride')[0].params.locale, 'ja-JP');
  // locale 需要同时把 acceptLanguage 挂到 setUserAgentOverride（UA 取自页面）
  assert.equal(t.find('Emulation.setUserAgentOverride')[0].params.acceptLanguage, 'ja-JP');
  assert.equal(t.find('Emulation.setUserAgentOverride')[0].params.userAgent, 'PageUA/1.0');
  assert.match(text(r), /location permission/);
  assert.match(text(r), /Accept-Language/);
});

test('emulate_geo 校验失败（时区/经纬度）时不附加调试器', async () => {
  const t = setup();
  const badTz = await t.toolEmulateGeo({ tabId: 1, timezone: 'Mars/Olympus' });
  assert.ok(badTz.isError);
  assert.match(text(badTz), /Invalid timezone/);
  const badGeo = await t.toolEmulateGeo({ tabId: 1, latitude: 35 });
  assert.ok(badGeo.isError);
  assert.match(text(badGeo), /together/);
  assert.equal(t.attachCount(), 0);
  assert.equal(t.calls.length, 0);
});

test('emulate_geo 什么都不传报错并列出参数', async () => {
  const t = setup();
  const r = await t.toolEmulateGeo({ tabId: 1 });
  assert.ok(r.isError);
  assert.match(text(r), /Nothing to apply/);
  assert.match(text(r), /latitude\/longitude, timezone or locale/);
});

test('时区设置后空串可还原', async () => {
  const t = setup();
  await t.toolEmulateGeo({ tabId: 1, timezone: 'Asia/Tokyo' });
  assert.ok(t.emulatedTabs.get(1).has('timezone'));
  await t.toolEmulateGeo({ tabId: 1, timezone: '' });
  assert.equal(t.find('Emulation.setTimezoneOverride')[1].params.timezoneId, '');
  assert.ok(!t.emulatedTabs.get(1)?.has('timezone'));
});

test('locale 同时设置 Intl 区域与 acceptLanguage，UA 取自页面', async () => {
  const t = setup({ pageUa: 'Real/9' });
  const r = await t.toolEmulateGeo({ tabId: 1, locale: 'ja_JP' });
  assert.ok(!r.isError);
  const ua = t.find('Emulation.setUserAgentOverride')[0].params;
  assert.equal(ua.userAgent, 'Real/9');
  assert.equal(ua.acceptLanguage, 'ja-JP');
  assert.equal(t.find('Emulation.setLocaleOverride')[0].params.locale, 'ja-JP');
});

// ── reset（由 emulate_device 承载）────────────────────────────────────────────

test('reset：逐项还原已记录的覆盖，并清除标记', async () => {
  const t = setup();
  await t.toolEmulateDevice({ tabId: 1, device: 'iphone-15' });
  t.calls.length = 0;
  await t.toolEmulateGeo({ tabId: 1, timezone: 'Asia/Tokyo', locale: 'ja-JP', latitude: 35, longitude: 139 });
  t.calls.length = 0;
  const r = await t.toolEmulateDevice({ tabId: 1, reset: true });
  assert.ok(!r.isError);
  const m = t.methods();
  for (const expected of [
    'Emulation.setCPUThrottlingRate', 'Network.emulateNetworkConditions', 'Emulation.setEmulatedMedia',
    'Emulation.setUserAgentOverride', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled',
    'Emulation.setTimezoneOverride', 'Emulation.setLocaleOverride', 'Emulation.clearGeolocationOverride',
  ]) assert.ok(m.includes(expected), `缺少 ${expected}`);
  assert.equal(t.find('Emulation.setUserAgentOverride')[0].params.userAgent, '');
  assert.equal(t.find('Emulation.setTouchEmulationEnabled')[0].params.enabled, false);
  assert.equal(t.emulatedTabs.has(1), false);
});

test('reset 只还原记录过的项，旧项仍无条件还原', async () => {
  const t = setup();
  await t.toolEmulateNetwork({ tabId: 1, cpuThrottlingRate: 4 });
  t.calls.length = 0;
  await t.toolEmulateDevice({ tabId: 1, reset: true });
  const m = t.methods();
  assert.ok(m.includes('Emulation.setCPUThrottlingRate'));
  assert.ok(!m.includes('Emulation.clearDeviceMetricsOverride'));
  assert.ok(!m.includes('Emulation.clearGeolocationOverride'));
  assert.ok(!m.includes('Emulation.setTimezoneOverride'));
});

test('reset 单项失败不影响其余，并在报错里列出', async () => {
  const t = setup({ failOn: 'Emulation.setTimezoneOverride' });
  await t.toolEmulateGeo({ tabId: 1, timezone: 'Asia/Tokyo' }).catch(() => {});
  // 上面的设置本身会失败；改用直接标记，模拟已生效的时区
  t.emulatedTabs.set(1, new Set(['timezone', 'geo']));
  t.calls.length = 0;
  const r = await t.toolEmulateDevice({ tabId: 1, reset: true });
  assert.ok(r.isError);
  assert.match(text(r), /Reset finished with errors/);
  assert.match(text(r), /timezone/);
  assert.ok(t.methods().includes('Emulation.clearGeolocationOverride'));
});

// ── 公共行为 ─────────────────────────────────────────────────────────────────

test('三个工具缺 tabId 都报错', async () => {
  const t = setup();
  for (const tool of [t.toolEmulateDevice, t.toolEmulateNetwork, t.toolEmulateGeo]) {
    const r = await tool({});
    assert.ok(r.isError);
    assert.match(text(r), /tabId required/);
  }
});
