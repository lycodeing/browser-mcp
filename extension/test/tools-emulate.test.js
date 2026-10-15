// tools/emulate.js 的测试：注入假 chrome.debugger，记录发出的 CDP 命令。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmulateTool } from '../tools/emulate.js';

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
  const tool = createEmulateTool({
    chrome, ok, err, emulatedTabs, networkPresets: NETWORK_PRESETS,
    ensureCdp: async () => { attached++; },
  });
  const methods = () => calls.map(c => c.method);
  const find = m => calls.filter(c => c.method === m);
  return { tool, calls, methods, find, emulatedTabs, attachCount: () => attached };
}

test('校验失败时不附加调试器、不发命令', async () => {
  const t = setup();
  const r = await t.tool({ tabId: 1, timezone: 'Mars/Olympus' });
  assert.ok(r.isError);
  assert.match(text(r), /Invalid timezone/);
  assert.equal(t.attachCount(), 0);
  assert.equal(t.calls.length, 0);
});

test('什么参数都不传报错', async () => {
  const t = setup();
  const r = await t.tool({ tabId: 1 });
  assert.ok(r.isError);
  assert.match(text(r), /Nothing to apply/);
});

test('旧调用只传 colorScheme，行为不变', async () => {
  const t = setup();
  const r = await t.tool({ tabId: 1, colorScheme: 'dark' });
  assert.ok(!r.isError);
  assert.deepEqual(t.methods(), ['Emulation.setEmulatedMedia']);
  assert.equal(t.calls[0].params.features[0].value, 'dark');
  assert.match(text(r), /color scheme dark/);
  assert.ok(t.emulatedTabs.has(1));
});

test('旧调用 colorScheme:auto 以空串还原媒体特性', async () => {
  const t = setup();
  await t.tool({ tabId: 1, colorScheme: 'auto' });
  assert.equal(t.calls[0].params.features[0].value, '');
});

test('device 预设：视口、触摸、UA 依次下发', async () => {
  const t = setup();
  const r = await t.tool({ tabId: 1, device: 'iphone-15' });
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

test('应用顺序：CPU、网络、配色先于视口，位置最后', async () => {
  const t = setup();
  await t.tool({
    tabId: 1, device: 'pixel-8', cpuThrottlingRate: 4, networkConditions: 'Slow 3G',
    colorScheme: 'dark', timezone: 'Asia/Tokyo', latitude: 35, longitude: 139,
  });
  const m = t.methods();
  assert.ok(m.indexOf('Emulation.setCPUThrottlingRate') < m.indexOf('Network.emulateNetworkConditions'));
  assert.ok(m.indexOf('Network.emulateNetworkConditions') < m.indexOf('Emulation.setEmulatedMedia'));
  assert.ok(m.indexOf('Emulation.setEmulatedMedia') < m.indexOf('Emulation.setDeviceMetricsOverride'));
  assert.ok(m.indexOf('Emulation.setUserAgentOverride') < m.indexOf('Emulation.setTimezoneOverride'));
  assert.equal(m[m.length - 1], 'Emulation.setGeolocationOverride');
});

test('locale 同时设置 Intl 区域与 acceptLanguage，且 UA 取自页面', async () => {
  const t = setup({ pageUa: 'Real/9' });
  const r = await t.tool({ tabId: 1, locale: 'ja_JP' });
  assert.ok(!r.isError);
  const ua = t.find('Emulation.setUserAgentOverride')[0].params;
  assert.equal(ua.userAgent, 'Real/9');
  assert.equal(ua.acceptLanguage, 'ja-JP');
  assert.equal(t.find('Emulation.setLocaleOverride')[0].params.locale, 'ja-JP');
  assert.match(text(r), /Accept-Language/);
});

test('device 与 locale 合并成一次 setUserAgentOverride', async () => {
  const t = setup();
  await t.tool({ tabId: 1, device: 'pixel-8', locale: 'ja-JP' });
  const uaCalls = t.find('Emulation.setUserAgentOverride');
  assert.equal(uaCalls.length, 1);
  assert.match(uaCalls[0].params.userAgent, /Pixel 8/);
  assert.equal(uaCalls[0].params.acceptLanguage, 'ja-JP');
  assert.ok(uaCalls[0].params.userAgentMetadata);
  assert.equal(t.find('Runtime.evaluate').length, 0);
});

test('位置：下发覆盖并附带权限提示', async () => {
  const t = setup();
  const r = await t.tool({ tabId: 1, latitude: 35.68, longitude: 139.76, accuracy: 20 });
  assert.deepEqual(t.find('Emulation.setGeolocationOverride')[0].params, { latitude: 35.68, longitude: 139.76, accuracy: 20 });
  assert.match(text(r), /location permission/);
});

test('时区：设置后空串可还原', async () => {
  const t = setup();
  await t.tool({ tabId: 1, timezone: 'Asia/Tokyo' });
  assert.ok(t.emulatedTabs.get(1).has('timezone'));
  await t.tool({ tabId: 1, timezone: '' });
  assert.equal(t.find('Emulation.setTimezoneOverride')[1].params.timezoneId, '');
  assert.ok(!t.emulatedTabs.get(1)?.has('timezone'));
});

test('中途失败：不回滚，报错里列出已生效项', async () => {
  const t = setup({ failOn: 'Emulation.setTimezoneOverride' });
  const r = await t.tool({ tabId: 1, device: 'iphone-15', timezone: 'Asia/Tokyo' });
  assert.ok(r.isError);
  assert.match(text(r), /timezone failed/);
  assert.match(text(r), /Already applied and kept/);
  assert.match(text(r), /viewport 393x852/);
  assert.match(text(r), /reset:true/);
  assert.ok(t.emulatedTabs.get(1).has('viewport'));
});

test('第一步就失败时说明没有任何项生效', async () => {
  const t = setup({ failOn: 'Emulation.setCPUThrottlingRate' });
  const r = await t.tool({ tabId: 1, cpuThrottlingRate: 4 });
  assert.ok(r.isError);
  assert.match(text(r), /Nothing was applied/);
});

test('reset：逐项还原已记录的覆盖，并清除标记', async () => {
  const t = setup();
  await t.tool({ tabId: 1, device: 'iphone-15', timezone: 'Asia/Tokyo', locale: 'ja-JP', latitude: 35, longitude: 139 });
  t.calls.length = 0;
  const r = await t.tool({ tabId: 1, reset: true });
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
  await t.tool({ tabId: 1, colorScheme: 'dark' });
  t.calls.length = 0;
  await t.tool({ tabId: 1, reset: true });
  const m = t.methods();
  assert.ok(m.includes('Emulation.setCPUThrottlingRate'));
  assert.ok(!m.includes('Emulation.clearDeviceMetricsOverride'));
  assert.ok(!m.includes('Emulation.clearGeolocationOverride'));
  assert.ok(!m.includes('Emulation.setTimezoneOverride'));
});

test('reset 单项失败不影响其余，并在报错里列出', async () => {
  const t = setup({ failOn: 'Emulation.setTimezoneOverride' });
  await t.tool({ tabId: 1, timezone: 'Asia/Tokyo' }).catch(() => {});
  // 上面的设置本身会失败；改用直接标记，模拟已生效的时区
  t.emulatedTabs.set(1, new Set(['timezone', 'geo']));
  t.calls.length = 0;
  const r = await t.tool({ tabId: 1, reset: true });
  assert.ok(r.isError);
  assert.match(text(r), /Reset finished with errors/);
  assert.match(text(r), /timezone/);
  assert.ok(t.methods().includes('Emulation.clearGeolocationOverride'));
});

test('缺 tabId 报错', async () => {
  const t = setup();
  const r = await t.tool({});
  assert.ok(r.isError);
  assert.match(text(r), /tabId required/);
});
