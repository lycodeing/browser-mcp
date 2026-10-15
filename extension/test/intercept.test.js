// lib/intercept.js 的测试：通配符匹配、规则校验、规则存储、fulfill / 预检响应、输出格式。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_REASONS, MAX_BODY_BYTES, MAX_DELAY_MS, MAX_RULES_PER_TAB,
  compilePattern, wildcardMatch, validateRule, createInterceptStore,
  utf8ToBase64, headerValue, isPreflight, buildFulfillment, buildPreflightResponse,
  planResponse, formatRule,
} from '../lib/intercept.js';

const m = (pattern, url) => wildcardMatch(compilePattern(pattern), url);
const spec = (o) => {
  const r = validateRule(o);
  assert.equal(r.error, undefined, r.error);
  return r.spec;
};

// ── 通配符 ────────────────────────────────────────────────────────────────────

test('通配符：* 匹配任意长度，整串匹配', () => {
  assert.ok(m('*', 'https://a.test/x'));
  assert.ok(m('*', ''));
  assert.ok(m('https://a.test/*', 'https://a.test/api/v1'));
  assert.ok(m('*/api/*', 'https://a.test/api/v1'));
  assert.ok(m('*.png', 'https://a.test/i/logo.png'));
  assert.ok(!m('*.png', 'https://a.test/i/logo.png?x=1'));
  assert.ok(!m('https://a.test', 'https://a.test/x'));
  assert.ok(m('https://a.test/x', 'https://a.test/x'));
});

test('通配符：? 恰好一个字符，按码点计', () => {
  assert.ok(m('a?c', 'abc'));
  assert.ok(!m('a?c', 'ac'));
  assert.ok(!m('a?c', 'abbc'));
  assert.ok(m('a?c', 'a😀c'));
});

test('通配符：反斜杠转义，区分大小写，多个 * 等价于一个', () => {
  assert.ok(m('a\\*b', 'a*b'));
  assert.ok(!m('a\\*b', 'axb'));
  assert.ok(m('a\\?b', 'a?b'));
  assert.ok(!m('a\\?b', 'axb'));
  assert.ok(m('a\\\\b', 'a\\b'));
  assert.ok(m('a\\', 'a\\'));
  assert.ok(!m('ABC', 'abc'));
  assert.ok(m('a**b', 'axyzb'));
});

test('通配符：* 与 ? 组合', () => {
  assert.ok(m('*/v?/*', 'https://a.test/v2/users'));
  assert.ok(!m('*/v?/*', 'https://a.test/v22/users'));
});

test('通配符：大量 * 加不匹配的长文本不会指数级回溯', () => {
  const start = Date.now();
  const result = m('*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(30000));
  assert.equal(result, false);
  assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
});

// ── 校验 ──────────────────────────────────────────────────────────────────────

test('validateRule：必填与未知 action', () => {
  assert.match(validateRule({ action: 'fail' }).error, /urlPattern required/);
  assert.match(validateRule({ urlPattern: '', action: 'fail' }).error, /urlPattern required/);
  assert.match(validateRule({ urlPattern: '*', action: 'nope' }).error, /Unknown action/);
  assert.match(validateRule({ urlPattern: 'a'.repeat(2001), action: 'fail' }).error, /too long/);
});

test('validateRule：method 规整为大写，非法字符报错，空串视为未给', () => {
  assert.equal(spec({ urlPattern: '*', action: 'fail', method: ' get ' }).method, 'GET');
  assert.match(validateRule({ urlPattern: '*', action: 'fail', method: '1x' }).error, /Invalid method/);
  assert.equal(spec({ urlPattern: '*', action: 'fail', method: '' }).method, undefined);
});

test('validateRule：fail 默认 Failed，非法原因报错并列出可选值', () => {
  assert.equal(spec({ urlPattern: '*', action: 'fail' }).errorReason, 'Failed');
  assert.equal(spec({ urlPattern: '*', action: 'fail', errorReason: 'TimedOut' }).errorReason, 'TimedOut');
  const bad = validateRule({ urlPattern: '*', action: 'fail', errorReason: 'Nope' }).error;
  assert.match(bad, /Unknown errorReason/);
  assert.ok(ERROR_REASONS.every((r) => bad.includes(r)));
});

test('validateRule：fulfill 默认值与状态码范围', () => {
  const s = spec({ urlPattern: '*', action: 'fulfill' });
  assert.equal(s.status, 200);
  assert.equal(s.body, '');
  assert.match(validateRule({ urlPattern: '*', action: 'fulfill', status: 99 }).error, /Invalid status/);
  assert.match(validateRule({ urlPattern: '*', action: 'fulfill', status: 600 }).error, /Invalid status/);
  assert.match(validateRule({ urlPattern: '*', action: 'fulfill', status: 200.5 }).error, /Invalid status/);
  assert.equal(spec({ urlPattern: '*', action: 'fulfill', status: 599 }).status, 599);
});

test('validateRule：fulfill 的 headers 校验', () => {
  const base = { urlPattern: '*', action: 'fulfill' };
  assert.deepEqual(spec({ ...base, headers: { 'X-A': '1' } }).headers, { 'X-A': '1' });
  assert.match(validateRule({ ...base, headers: ['a'] }).error, /headers must be an object/);
  assert.match(validateRule({ ...base, headers: null }).error, /headers must be an object/);
  assert.match(validateRule({ ...base, headers: { 'bad name': '1' } }).error, /Invalid header name/);
  assert.match(validateRule({ ...base, headers: { a: 1 } }).error, /must be a string/);
  assert.match(validateRule({ ...base, headers: { a: 'x\r\ny: z' } }).error, /line breaks/);
});

test('validateRule：body 按 UTF-8 字节数限制为 1 MB', () => {
  const base = { urlPattern: '*', action: 'fulfill' };
  assert.ok(validateRule({ ...base, body: 'a'.repeat(MAX_BODY_BYTES) }).spec);
  assert.match(validateRule({ ...base, body: 'a'.repeat(MAX_BODY_BYTES + 1) }).error, /body too large/);
  // 每个 € 占 3 字节：字符数没超，字节数超了
  assert.match(validateRule({ ...base, body: '€'.repeat(Math.ceil(MAX_BODY_BYTES / 3) + 1) }).error, /body too large/);
  assert.match(validateRule({ ...base, body: 123 }).error, /body must be a string/);
});

test('validateRule：delay 必须有 1..60000 的整数 delayMs', () => {
  const base = { urlPattern: '*', action: 'delay' };
  assert.match(validateRule(base).error, /delayMs/);
  assert.match(validateRule({ ...base, delayMs: 0 }).error, /delayMs/);
  assert.match(validateRule({ ...base, delayMs: MAX_DELAY_MS + 1 }).error, /delayMs/);
  assert.match(validateRule({ ...base, delayMs: 1.5 }).error, /delayMs/);
  assert.equal(spec({ ...base, delayMs: MAX_DELAY_MS }).delayMs, MAX_DELAY_MS);
});

// ── 规则存储 ──────────────────────────────────────────────────────────────────

const failSpec = (urlPattern, extra = {}) => spec({ urlPattern, action: 'fail', ...extra });

test('store：id 在每个标签页内单调递增，互不影响', () => {
  const store = createInterceptStore();
  assert.equal(store.add(1, failSpec('*')).id, 'r1');
  assert.equal(store.add(1, failSpec('*')).id, 'r2');
  assert.equal(store.add(2, failSpec('*')).id, 'r1');
  store.remove(1, 'r1');
  assert.equal(store.add(1, failSpec('*')).id, 'r3');
});

test('store：每个标签页最多 50 条', () => {
  const store = createInterceptStore();
  for (let i = 0; i < MAX_RULES_PER_TAB; i++) store.add(1, failSpec('*'));
  assert.throws(() => store.add(1, failSpec('*')), /At most 50 rules/);
  assert.equal(store.list(1).length, MAX_RULES_PER_TAB);
  store.add(2, failSpec('*'));
});

test('store：remove 按 id、全部、清空后移除标签页条目', () => {
  const store = createInterceptStore();
  store.add(1, failSpec('*'));
  store.add(1, failSpec('*'));
  assert.equal(store.remove(1, 'nope'), 0);
  assert.equal(store.remove(1, 'r1'), 1);
  assert.equal(store.has(1), true);
  assert.equal(store.remove(1), 1);
  assert.equal(store.has(1), false);
  assert.equal(store.remove(1), 0);
  assert.deepEqual(store.tabIds(), []);
});

test('store：按添加顺序第一条命中，method 过滤，match 本身不计数', () => {
  const store = createInterceptStore();
  store.add(1, failSpec('*/api/*', { method: 'POST' }));
  store.add(1, spec({ urlPattern: '*/api/*', action: 'delay', delayMs: 5 }));
  assert.equal(store.match(1, { url: 'https://a.test/api/x', method: 'post' }).id, 'r1');
  assert.equal(store.match(1, { url: 'https://a.test/api/x', method: 'GET' }).id, 'r2');
  assert.equal(store.match(1, { url: 'https://a.test/other', method: 'GET' }), null);
  assert.equal(store.match(9, { url: 'https://a.test/api/x', method: 'GET' }), null);
  assert.equal(store.list(1)[0].hits, 0);
  store.hit(1, 'r1');
  store.hit(1, 'r1');
  store.hit(1, 'nope');
  assert.equal(store.list(1)[0].hits, 2);
});

test('store：explicitMethod 只看写明了 method 的规则', () => {
  const store = createInterceptStore();
  store.add(1, failSpec('*'));
  assert.equal(store.match(1, { url: 'u', method: 'OPTIONS' }, { explicitMethod: true }), null);
  store.add(1, failSpec('*', { method: 'OPTIONS' }));
  assert.equal(store.match(1, { url: 'u', method: 'OPTIONS' }, { explicitMethod: true }).id, 'r2');
});

test('store：list 与 match 返回副本，改动不影响库内规则', () => {
  const store = createInterceptStore();
  store.add(1, spec({ urlPattern: '*', action: 'fulfill', headers: { a: '1' } }));
  const copy = store.list(1)[0];
  copy.hits = 99;
  copy.headers.a = 'changed';
  assert.equal(store.list(1)[0].hits, 0);
  assert.equal(store.list(1)[0].headers.a, '1');
});

test('store：active 标记，加规则即置 true，可手动关闭', () => {
  const store = createInterceptStore();
  assert.equal(store.isActive(1), false);
  store.add(1, failSpec('*'));
  assert.equal(store.isActive(1), true);
  store.setActive(1, false);
  assert.equal(store.isActive(1), false);
  store.setActive(7, true);
  assert.equal(store.has(7), false);
});

test('store：dump / load 往返（经 JSON），保留 id 计数、hits 与 active', () => {
  const a = createInterceptStore();
  a.add(1, failSpec('*/a', { method: 'GET' }));
  a.add(1, spec({ urlPattern: '*/b', action: 'fulfill', status: 404, headers: { x: 'y' }, body: 'nf' }));
  a.hit(1, 'r2');
  a.setActive(1, false);
  a.add(2, spec({ urlPattern: '*', action: 'delay', delayMs: 10 }));
  a.remove(1, 'r1');

  const b = createInterceptStore();
  b.load(JSON.parse(JSON.stringify(a.dump())));
  assert.deepEqual(b.tabIds().sort(), [1, 2]);
  const rule = b.list(1)[0];
  assert.equal(rule.id, 'r2');
  assert.equal(rule.status, 404);
  assert.equal(rule.body, 'nf');
  assert.equal(rule.hits, 1);
  assert.equal(b.isActive(1), false);
  assert.equal(b.isActive(2), true);
  assert.equal(b.add(1, failSpec('*')).id, 'r3');
  assert.equal(b.match(2, { url: 'https://x', method: 'GET' }).delayMs, 10);
});

test('store：load 对坏快照不抛错，跳过不合法的规则', () => {
  const store = createInterceptStore();
  store.add(1, failSpec('*'));
  for (const bad of [undefined, null, 'x', 42, { v: 2, tabs: {} }, { v: 1 }, { v: 1, tabs: null }]) {
    assert.doesNotThrow(() => store.load(bad));
    assert.deepEqual(store.tabIds(), []);
  }
  store.load({
    v: 1,
    tabs: {
      abc: { rules: [{ id: 'r1', urlPattern: '*', action: 'fail' }] },
      3: { nextId: 5, active: true, rules: [
        { id: 'r1', urlPattern: '*', action: 'fail', errorReason: 'Nope' },
        { id: 'r2', urlPattern: '*', action: 'delay' },
        { urlPattern: '*', action: 'fail' },
        null,
        { id: 'r4', urlPattern: '*/ok', action: 'fail', hits: 'many' },
      ] },
      4: { rules: [{ id: 'r1', urlPattern: '*', action: 'nope' }] },
      5: { rules: 'not an array' },
    },
  });
  assert.deepEqual(store.tabIds(), [3]);
  assert.deepEqual(store.list(3).map((r) => r.id), ['r4']);
  assert.equal(store.list(3)[0].hits, 0);
  assert.equal(store.add(3, failSpec('*')).id, 'r5');
});

// ── 响应构造 ──────────────────────────────────────────────────────────────────

test('utf8ToBase64：多字节与大字符串', () => {
  assert.equal(utf8ToBase64('héllo €'), Buffer.from('héllo €').toString('base64'));
  const big = 'x'.repeat(200000);
  assert.equal(utf8ToBase64(big), Buffer.from(big).toString('base64'));
});

test('headerValue：名称不区分大小写', () => {
  assert.equal(headerValue({ Origin: 'o' }, 'origin'), 'o');
  assert.equal(headerValue({ origin: 'o' }, 'ORIGIN'), 'o');
  assert.equal(headerValue({}, 'origin'), undefined);
  assert.equal(headerValue(undefined, 'origin'), undefined);
});

const names = (headers) => headers.map((h) => h.name.toLowerCase());
const hv = (headers, name) => headers.find((h) => h.name.toLowerCase() === name)?.value;

test('buildFulfillment：状态码、头、body 的 base64、默认 content-type', () => {
  const out = buildFulfillment(
    { status: 201, headers: { 'X-A': '1' }, body: 'hi' },
    { headers: {} },
  );
  assert.equal(out.responseCode, 201);
  assert.equal(out.body, 'aGk=');
  assert.equal(hv(out.responseHeaders, 'x-a'), '1');
  assert.equal(hv(out.responseHeaders, 'content-type'), 'text/plain; charset=utf-8');
  assert.ok(!names(out.responseHeaders).includes('access-control-allow-origin'));
});

test('buildFulfillment：自带 content-type 不重复补；空 body 不带 body 字段', () => {
  const out = buildFulfillment({ status: 200, headers: { 'Content-Type': 'application/json' }, body: '' }, { headers: {} });
  assert.equal(names(out.responseHeaders).filter((n) => n === 'content-type').length, 1);
  assert.equal(hv(out.responseHeaders, 'content-type'), 'application/json');
  assert.equal('body' in out, false);
});

test('buildFulfillment：请求带 Origin 且规则没给 allow-origin 时回显，给了则不覆盖', () => {
  const req = { headers: { Origin: 'https://app.test' } };
  const echoed = buildFulfillment({ status: 200, body: 'x' }, req);
  assert.equal(hv(echoed.responseHeaders, 'access-control-allow-origin'), 'https://app.test');
  const own = buildFulfillment({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'x' }, req);
  assert.equal(own.responseHeaders.filter((h) => h.name.toLowerCase() === 'access-control-allow-origin').length, 1);
  assert.equal(hv(own.responseHeaders, 'access-control-allow-origin'), '*');
});

test('isPreflight：OPTIONS 且带 Access-Control-Request-Method', () => {
  assert.ok(isPreflight({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } }));
  assert.ok(isPreflight({ method: 'options', headers: { 'access-control-request-method': 'POST' } }));
  assert.ok(!isPreflight({ method: 'OPTIONS', headers: {} }));
  assert.ok(!isPreflight({ method: 'POST', headers: { 'access-control-request-method': 'POST' } }));
  assert.ok(!isPreflight({ headers: {} }));
});

test('buildPreflightResponse：204，回显来源、方法与请求头；无 Origin 用 *', () => {
  const out = buildPreflightResponse({ headers: {
    Origin: 'https://app.test', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-a, content-type',
  } });
  assert.equal(out.responseCode, 204);
  assert.equal(hv(out.responseHeaders, 'access-control-allow-origin'), 'https://app.test');
  assert.equal(hv(out.responseHeaders, 'access-control-allow-methods'), 'PUT');
  assert.equal(hv(out.responseHeaders, 'access-control-allow-headers'), 'x-a, content-type');

  const bare = buildPreflightResponse({ headers: { 'access-control-request-method': 'GET' } });
  assert.equal(hv(bare.responseHeaders, 'access-control-allow-origin'), '*');
  assert.ok(!names(bare.responseHeaders).includes('access-control-allow-headers'));
});

// ── planResponse ──────────────────────────────────────────────────────────────

const hitsOf = (store, tabId) => store.list(tabId).map((r) => r.hits);

test('planResponse：无规则命中则放行且不计数', () => {
  const store = createInterceptStore();
  store.add(1, failSpec('*/api/*'));
  assert.deepEqual(planResponse(store, 1, { url: 'https://a.test/x', method: 'GET' }), { type: 'continue' });
  assert.deepEqual(planResponse(store, 2, { url: 'https://a.test/api/x', method: 'GET' }), { type: 'continue' });
  assert.deepEqual(hitsOf(store, 1), [0]);
});

test('planResponse：fail / delay / fulfill 各自的结果并计数', () => {
  const store = createInterceptStore();
  store.add(1, failSpec('*/f', { errorReason: 'TimedOut' }));
  store.add(1, spec({ urlPattern: '*/d', action: 'delay', delayMs: 250 }));
  store.add(1, spec({ urlPattern: '*/m', action: 'fulfill', status: 202, body: 'hi' }));

  const f = planResponse(store, 1, { url: 'https://a.test/f', method: 'GET' });
  assert.equal(f.type, 'fail');
  assert.equal(f.rule.errorReason, 'TimedOut');

  const d = planResponse(store, 1, { url: 'https://a.test/d', method: 'GET' });
  assert.equal(d.type, 'delay');
  assert.equal(d.rule.delayMs, 250);

  const o = planResponse(store, 1, { url: 'https://a.test/m', method: 'GET', headers: {} });
  assert.equal(o.type, 'fulfill');
  assert.equal(o.params.responseCode, 202);
  assert.equal(o.params.body, 'aGk=');

  assert.deepEqual(hitsOf(store, 1), [1, 1, 1]);
});

const preflight = (url, extra = {}) => ({
  url,
  method: 'OPTIONS',
  headers: { Origin: 'https://app.test', 'Access-Control-Request-Method': 'POST', ...extra },
});

test('planResponse：预检命中 fulfill 规则时自动应答 204 并计数', () => {
  const store = createInterceptStore();
  store.add(1, spec({ urlPattern: '*/api/*', action: 'fulfill', method: 'POST', body: '{}' }));
  const plan = planResponse(store, 1, preflight('https://api.test/api/x'));
  assert.equal(plan.type, 'fulfill');
  assert.equal(plan.preflight, true);
  assert.equal(plan.params.responseCode, 204);
  assert.equal(hv(plan.params.responseHeaders, 'access-control-allow-methods'), 'POST');
  assert.deepEqual(hitsOf(store, 1), [1]);
});

test('planResponse：没写 method 的 fulfill 规则同样自动应答预检', () => {
  const store = createInterceptStore();
  store.add(1, spec({ urlPattern: '*/api/*', action: 'fulfill' }));
  assert.equal(planResponse(store, 1, preflight('https://api.test/api/x')).params.responseCode, 204);
});

test('planResponse：规则显式写了 OPTIONS 时按用户规则走，不自动应答', () => {
  const store = createInterceptStore();
  store.add(1, spec({ urlPattern: '*/api/*', action: 'fulfill', method: 'OPTIONS', status: 200, body: 'mine' }));
  store.add(1, spec({ urlPattern: '*/api/*', action: 'fulfill', method: 'POST' }));
  const plan = planResponse(store, 1, preflight('https://api.test/api/x'));
  assert.equal(plan.type, 'fulfill');
  assert.equal(plan.preflight, undefined);
  assert.equal(plan.params.responseCode, 200);
  assert.equal(plan.params.body, utf8ToBase64('mine'));
  assert.deepEqual(hitsOf(store, 1), [1, 0]);
});

test('planResponse：预检所针对的方法没有规则命中则放行', () => {
  const store = createInterceptStore();
  store.add(1, spec({ urlPattern: '*/api/*', action: 'fulfill', method: 'GET' }));
  assert.deepEqual(planResponse(store, 1, preflight('https://api.test/api/x')), { type: 'continue' });
  assert.deepEqual(hitsOf(store, 1), [0]);
});

test('planResponse：预检遇到 fail 规则同样失败，遇到 delay 规则放行且不计数', () => {
  const failStore = createInterceptStore();
  failStore.add(1, failSpec('*/api/*', { method: 'POST', errorReason: 'ConnectionRefused' }));
  const failed = planResponse(failStore, 1, preflight('https://api.test/api/x'));
  assert.equal(failed.type, 'fail');
  assert.equal(failed.rule.errorReason, 'ConnectionRefused');

  const delayStore = createInterceptStore();
  delayStore.add(1, spec({ urlPattern: '*/api/*', action: 'delay', delayMs: 100 }));
  assert.deepEqual(planResponse(delayStore, 1, preflight('https://api.test/api/x')), { type: 'continue' });
  assert.deepEqual(hitsOf(delayStore, 1), [0]);
});

test('planResponse：请求信息缺字段时不抛错', () => {
  const store = createInterceptStore();
  store.add(1, failSpec('*'));
  assert.doesNotThrow(() => planResponse(store, 1, {}));
  assert.equal(planResponse(store, 1, {}).type, 'fail');
});

// ── 输出 ──────────────────────────────────────────────────────────────────────

test('formatRule：三种 action 的单行描述', () => {
  assert.equal(
    formatRule({ id: 'r1', urlPattern: '*/a', method: 'POST', action: 'fail', errorReason: 'TimedOut', hits: 2 }),
    'r1  POST */a  ->  fail TimedOut  hits=2',
  );
  assert.equal(
    formatRule({ id: 'r2', urlPattern: '*', action: 'delay', delayMs: 500, hits: 0 }),
    'r2  *  ->  delay 500ms  hits=0',
  );
  assert.equal(
    formatRule({ id: 'r3', urlPattern: '*', action: 'fulfill', status: 404, headers: { a: '1' }, body: 'héllo', hits: 0 }),
    'r3  *  ->  fulfill 404, 1 header, body 6 B  hits=0',
  );
  assert.match(formatRule({ id: 'r4', urlPattern: '*', action: 'fulfill', status: 200, hits: 0 }), /0 headers, body 0 B/);
  assert.match(formatRule({ id: 'r5', urlPattern: '*', action: 'fulfill', status: 200, headers: { a: '1', b: '2' }, hits: 0 }), /2 headers/);
});
