// tools/intercept.js 的测试：注入假 chrome（debugger、storage.session），记录发出的 CDP 命令。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInterceptTools } from '../tools/intercept.js';
import { createInterceptStore, validateRule } from '../lib/intercept.js';

const ok = content => ({ content });
const err = msg => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const text = r => r.content[0].text;
const tick = () => new Promise(r => setImmediate(r));

const REQ = { url: 'https://a.test/api/x', method: 'GET', headers: {} };

function setup({ snapshot, failOn = {}, ensureCdpError, getGate, getError } = {}) {
  const calls = [];
  const slept = [];
  const attached = [];
  const session = {};
  if (snapshot) session['intercept:v1'] = snapshot;
  const chrome = {
    debugger: {
      async sendCommand(target, method, params) {
        calls.push({ tabId: target.tabId, method, params });
        const f = failOn[method];
        if (f && (f === true || f(target.tabId, params))) throw new Error(`boom ${method}`);
        return {};
      },
    },
    storage: {
      session: {
        async get(key) {
          if (getGate) await getGate;
          if (getError) throw new Error('storage unavailable');
          return key in session ? { [key]: session[key] } : {};
        },
        async set(obj) { Object.assign(session, JSON.parse(JSON.stringify(obj))); },
      },
    },
  };
  const store = createInterceptStore();
  const tools = createInterceptTools({
    chrome, ok, err, store,
    ensureCdp: async () => { if (ensureCdpError) throw new Error(ensureCdpError); },
    markAttached: (id) => attached.push(id),
    sleep: async (ms) => { slept.push(ms); },
  });
  const methods = (tabId) => calls.filter(c => tabId === undefined || c.tabId === tabId).map(c => c.method);
  const count = (method) => calls.filter(c => c.method === method).length;
  return { tools, store, calls, slept, attached, session, failOn, methods, count };
}

// 用真实 store 生成快照，模拟 Service Worker 重启前写下的内容
function snapshotOf(entries) {
  const s = createInterceptStore();
  for (const [tabId, input, { inactive = false } = {}] of entries) {
    s.add(tabId, validateRule(input).spec);
    if (inactive) s.setActive(tabId, false);
  }
  return JSON.parse(JSON.stringify(s.dump()));
}

const FAIL_RULE = { urlPattern: '*/api/*', action: 'fail', errorReason: 'TimedOut' };

// ── intercept_add ─────────────────────────────────────────────────────────────

test('add：第一条规则开启 Fetch，后续不重复开启，并写入快照', async () => {
  const t = setup();
  await t.tools.ready;
  const r1 = await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  assert.ok(!r1.isError);
  assert.match(text(r1), /Added r1/);
  await t.tools.intercept_add({ tabId: 3, urlPattern: '*', action: 'delay', delayMs: 100 });
  assert.deepEqual(t.methods(3), ['Fetch.enable']);
  assert.deepEqual(t.calls[0].params, { patterns: [{ urlPattern: '*' }] });
  const snap = t.session['intercept:v1'];
  assert.equal(snap.v, 1);
  assert.equal(snap.tabs[3].rules.length, 2);
  assert.equal(snap.tabs[3].active, true);
});

test('add：校验失败时不发命令、不入库', async () => {
  const t = setup();
  await t.tools.ready;
  const r = await t.tools.intercept_add({ tabId: 3, urlPattern: '*', action: 'delay' });
  assert.equal(r.isError, true);
  assert.match(text(r), /delayMs/);
  assert.equal(t.calls.length, 0);
  assert.equal(t.store.has(3), false);
  const noTab = await t.tools.intercept_add({ urlPattern: '*', action: 'fail' });
  assert.match(text(noTab), /tabId required/);
});

test('add：附加调试器失败时报错，规则不入库，快照不写', async () => {
  const t = setup({ ensureCdpError: 'Cannot attach CDP to restricted URL: chrome://x' });
  await t.tools.ready;
  const r = await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  assert.equal(r.isError, true);
  assert.match(text(r), /Cannot enable interception on tab 3/);
  assert.match(text(r), /rule was not added/);
  assert.equal(t.store.has(3), false);
  assert.deepEqual(t.session, {});
});

test('add：Fetch.enable 失败时规则不入库', async () => {
  const t = setup({ failOn: { 'Fetch.enable': true } });
  await t.tools.ready;
  const r = await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  assert.equal(r.isError, true);
  assert.equal(t.store.has(3), false);
});

test('add：Fetch.enable 失败时不动该标签页原有的（未生效）规则', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  t.tools.handleDetach(3);
  t.failOn['Fetch.enable'] = true;
  const r = await t.tools.intercept_add({ tabId: 3, urlPattern: '*', action: 'fail' });
  assert.equal(r.isError, true);
  assert.equal(t.store.list(3).length, 1);
  assert.equal(t.store.isActive(3), false);
});

test('add：达到 50 条上限后报错，且不重复开启 Fetch', async () => {
  const t = setup();
  await t.tools.ready;
  for (let i = 0; i < 50; i++) await t.tools.intercept_add({ tabId: 3, urlPattern: `*/${i}`, action: 'fail' });
  const r = await t.tools.intercept_add({ tabId: 3, urlPattern: '*/extra', action: 'fail' });
  assert.equal(r.isError, true);
  assert.match(text(r), /At most 50 rules/);
  assert.equal(t.count('Fetch.enable'), 1);
  assert.equal(t.store.list(3).length, 50);
});

test('add：fulfill 规则的返回里说明 CORS 处理', async () => {
  const t = setup();
  await t.tools.ready;
  const r = await t.tools.intercept_add({ tabId: 3, urlPattern: '*', action: 'fulfill', body: 'x' });
  assert.match(text(r), /CORS/);
});

// ── intercept_list ────────────────────────────────────────────────────────────

test('list：没有规则时给出说明', async () => {
  const t = setup();
  await t.tools.ready;
  assert.match(text(await t.tools.intercept_list({ tabId: 3 })), /No intercept rules/);
  assert.match(text(await t.tools.intercept_list({})), /tabId required/);
});

test('list：显示规则、命中次数与开关状态', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  await t.tools.handlePaused(3, { requestId: 'q1', request: REQ });
  const out = text(await t.tools.intercept_list({ tabId: 3 }));
  assert.match(out, /interception ON/);
  assert.match(out, /r1 {2}\*\/api\/\* {2}-> {2}fail TimedOut {2}hits=1/);
});

test('调试器被动断开：规则保留但标为未生效，快照同步，重新 add 后恢复', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  t.tools.handleDetach(3);
  await tick();
  assert.equal(t.session['intercept:v1'].tabs[3].active, false);
  const off = text(await t.tools.intercept_list({ tabId: 3 }));
  assert.match(off, /interception OFF/);
  assert.match(off, /not active/);

  await t.tools.intercept_add({ tabId: 3, urlPattern: '*', action: 'fail' });
  assert.equal(t.count('Fetch.enable'), 2);
  const on = text(await t.tools.intercept_list({ tabId: 3 }));
  assert.match(on, /interception ON/);
  assert.equal(t.store.list(3).length, 2);
});

test('handleDetach：没有规则的标签页不写快照', async () => {
  const t = setup();
  await t.tools.ready;
  t.tools.handleDetach(42);
  await tick();
  assert.deepEqual(t.session, {});
});

test('标签页关闭：规则丢弃并更新快照', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  await t.tools.intercept_add({ tabId: 4, ...FAIL_RULE });
  t.tools.handleTabRemoved(3);
  await tick();
  assert.equal(t.store.has(3), false);
  assert.deepEqual(Object.keys(t.session['intercept:v1'].tabs), ['4']);
});

// ── intercept_remove ──────────────────────────────────────────────────────────

test('remove：未知 ruleId 报错且不发命令', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  const before = t.calls.length;
  const r = await t.tools.intercept_remove({ tabId: 3, ruleId: 'r9' });
  assert.equal(r.isError, true);
  assert.match(text(r), /No rule r9/);
  assert.equal(t.calls.length, before);
});

test('remove：删一条后规则仍在，不关 Fetch', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  await t.tools.intercept_add({ tabId: 3, urlPattern: '*', action: 'fail' });
  const r = await t.tools.intercept_remove({ tabId: 3, ruleId: 'r1' });
  assert.match(text(r), /Removed 1 rule\./);
  assert.equal(t.count('Fetch.disable'), 0);
  assert.deepEqual(t.store.list(3).map(x => x.id), ['r2']);
});

test('remove：删光后关闭 Fetch 并更新快照', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  await t.tools.intercept_add({ tabId: 3, urlPattern: '*', action: 'fail' });
  const r = await t.tools.intercept_remove({ tabId: 3 });
  assert.match(text(r), /Removed 2 rules/);
  assert.match(text(r), /Interception is off/);
  assert.equal(t.count('Fetch.disable'), 1);
  assert.deepEqual(t.session['intercept:v1'].tabs, {});
});

test('remove：按 id 删掉最后一条同样关闭 Fetch', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  await t.tools.intercept_remove({ tabId: 3, ruleId: 'r1' });
  assert.equal(t.count('Fetch.disable'), 1);
  assert.equal(t.store.has(3), false);
});

test('remove：没有规则时提示无需删除，不发命令', async () => {
  const t = setup();
  await t.tools.ready;
  const r = await t.tools.intercept_remove({ tabId: 3 });
  assert.ok(!r.isError);
  assert.match(text(r), /nothing to remove/);
  assert.equal(t.calls.length, 0);
});

test('remove：Fetch.disable 失败不算工具错误，规则照样清掉', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  t.failOn['Fetch.disable'] = true;
  const r = await t.tools.intercept_remove({ tabId: 3 });
  assert.ok(!r.isError);
  assert.match(text(r), /Fetch\.disable failed/);
  assert.equal(t.store.has(3), false);
});

test('remove：调试器已断开的标签页不再发 Fetch.disable', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  t.tools.handleDetach(3);
  await t.tools.intercept_remove({ tabId: 3 });
  assert.equal(t.count('Fetch.disable'), 0);
  assert.equal(t.store.has(3), false);
});

// ── Fetch.requestPaused ───────────────────────────────────────────────────────

const afterEnable = (t) => t.calls.filter(c => c.method !== 'Fetch.enable');

test('paused：fail 规则调用 failRequest 并带上原因', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  await t.tools.handlePaused(3, { requestId: 'q1', request: REQ });
  assert.deepEqual(afterEnable(t), [{
    tabId: 3, method: 'Fetch.failRequest', params: { requestId: 'q1', errorReason: 'TimedOut' },
  }]);
});

test('paused：fulfill 规则调用 fulfillRequest，body 为 base64', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, urlPattern: '*/api/*', action: 'fulfill', status: 201, headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  await t.tools.handlePaused(3, { requestId: 'q1', request: REQ });
  const [c] = afterEnable(t);
  assert.equal(c.method, 'Fetch.fulfillRequest');
  assert.equal(c.params.requestId, 'q1');
  assert.equal(c.params.responseCode, 201);
  assert.equal(c.params.body, Buffer.from('{"a":1}').toString('base64'));
});

test('paused：delay 规则先等待指定毫秒再放行', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, urlPattern: '*/api/*', action: 'delay', delayMs: 250 });
  await t.tools.handlePaused(3, { requestId: 'q1', request: REQ });
  assert.deepEqual(t.slept, [250]);
  assert.deepEqual(afterEnable(t).map(c => c.method), ['Fetch.continueRequest']);
});

test('paused：没有规则命中的请求直接放行，规则与 Fetch 保持不变', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  await t.tools.handlePaused(3, { requestId: 'q1', request: { ...REQ, url: 'https://a.test/other' } });
  assert.deepEqual(afterEnable(t).map(c => c.method), ['Fetch.continueRequest']);
  assert.equal(t.store.list(3)[0].hits, 0);
});

test('paused：标签页没有任何规则时放行，并只关一次 Fetch', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.handlePaused(9, { requestId: 'q1', request: REQ });
  await t.tools.handlePaused(9, { requestId: 'q2', request: REQ });
  assert.deepEqual(t.methods(9), ['Fetch.continueRequest', 'Fetch.disable', 'Fetch.continueRequest']);
});

test('paused：应答命令失败时回退为放行，请求不会卡住', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  t.failOn['Fetch.failRequest'] = true;
  await t.tools.handlePaused(3, { requestId: 'q1', request: REQ });
  const last = t.calls[t.calls.length - 1];
  assert.equal(last.method, 'Fetch.continueRequest');
  assert.equal(last.params.requestId, 'q1');
});

test('paused：放行命令本身失败也不抛出', async () => {
  const t = setup({ failOn: { 'Fetch.continueRequest': true } });
  await t.tools.ready;
  await assert.doesNotReject(t.tools.handlePaused(9, { requestId: 'q1', request: REQ }));
});

test('paused：响应阶段的暂停一律放行，不计命中', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, ...FAIL_RULE });
  await t.tools.handlePaused(3, { requestId: 'q1', request: REQ, responseStatusCode: 200 });
  assert.deepEqual(afterEnable(t).map(c => c.method), ['Fetch.continueRequest']);
  assert.equal(t.store.list(3)[0].hits, 0);
});

test('paused：CORS 预检自动应答 204', async () => {
  const t = setup();
  await t.tools.ready;
  await t.tools.intercept_add({ tabId: 3, urlPattern: '*/api/*', action: 'fulfill', method: 'POST', body: 'x' });
  await t.tools.handlePaused(3, {
    requestId: 'q1',
    request: { url: REQ.url, method: 'OPTIONS', headers: { Origin: 'https://app.test', 'Access-Control-Request-Method': 'POST' } },
  });
  const [c] = afterEnable(t);
  assert.equal(c.method, 'Fetch.fulfillRequest');
  assert.equal(c.params.responseCode, 204);
});

// ── Service Worker 重启后的恢复 ───────────────────────────────────────────────

test('recover：对生效中的标签页先 Fetch.disable 再 Fetch.enable，并标记调试器已附加', async () => {
  const t = setup({ snapshot: snapshotOf([[7, FAIL_RULE]]) });
  await t.tools.ready;
  assert.deepEqual(t.methods(7), ['Fetch.disable', 'Fetch.enable']);
  assert.deepEqual(t.calls[1].params, { patterns: [{ urlPattern: '*' }] });
  assert.deepEqual(t.attached, [7]);
  assert.match(text(await t.tools.intercept_list({ tabId: 7 })), /interception ON/);
});

test('recover：快照里本就未生效的标签页不发命令', async () => {
  const t = setup({ snapshot: snapshotOf([[7, FAIL_RULE, { inactive: true }]]) });
  await t.tools.ready;
  assert.equal(t.calls.length, 0);
  assert.match(text(await t.tools.intercept_list({ tabId: 7 })), /interception OFF/);
});

test('recover：调试器已不在的标签页丢弃规则，提示只出现一次，快照同步', async () => {
  const t = setup({
    snapshot: snapshotOf([[7, FAIL_RULE], [8, FAIL_RULE]]),
    failOn: { 'Fetch.disable': (tabId) => tabId === 8 },
  });
  await t.tools.ready;
  assert.equal(t.store.has(7), true);
  assert.equal(t.store.has(8), false);
  const first = text(await t.tools.intercept_list({ tabId: 8 }));
  assert.match(first, /No intercept rules/);
  assert.match(first, /restarted/);
  assert.doesNotMatch(text(await t.tools.intercept_list({ tabId: 8 })), /restarted/);
  assert.deepEqual(Object.keys(t.session['intercept:v1'].tabs), ['7']);
});

test('recover：坏快照或读取失败都当作没有规则，不抛错', async () => {
  const bad = setup({ snapshot: { v: 9, tabs: {} } });
  await bad.tools.ready;
  assert.deepEqual(bad.store.tabIds(), []);
  const broken = setup({ getError: true });
  await broken.tools.ready;
  assert.deepEqual(broken.store.tabIds(), []);
  assert.equal(broken.calls.length, 0);
});

test('paused：恢复完成之前不处理请求，完成后按快照里的规则应答', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const t = setup({ getGate: gate, snapshot: snapshotOf([[5, { urlPattern: '*', action: 'fulfill', body: 'x' }]]) });
  const pending = t.tools.handlePaused(5, { requestId: 'q1', request: REQ });
  await tick();
  assert.equal(t.calls.length, 0);
  release();
  await pending;
  assert.deepEqual(t.methods(5), ['Fetch.disable', 'Fetch.enable', 'Fetch.fulfillRequest']);
});
