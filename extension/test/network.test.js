import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNetworkStore, parseStatusFilter, failureReason, maskHeaders, formatList, formatDetail, truncateText,
} from '../lib/network.js';

const req = (id, url, extra = {}) => ({ requestId: id, timestamp: 1, request: { url, method: 'GET', headers: {} }, type: 'XHR', ...extra });

test('seq 单调递增，clear 不重置', () => {
  const s = createNetworkStore();
  assert.equal(s.onRequest(req('a', 'u1')).seq, 1);
  assert.equal(s.onRequest(req('b', 'u2')).seq, 2);
  s.clear();
  assert.equal(s.onRequest(req('c', 'u3')).seq, 3);
  assert.equal(s.get(1), 'evicted');
});

test('重定向：上一跳补全 3xx，新 URL 另成一条', () => {
  const s = createNetworkStore();
  s.onRequest(req('a', 'http://x/old'));
  s.onRequest(req('a', 'http://x/new', { redirectResponse: { status: 302, statusText: 'Found', headers: { location: '/new' } } }));
  s.onResponse({ requestId: 'a', response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} } });
  const { items } = s.query();
  assert.equal(items.length, 2);
  assert.equal(items[0].status, 302);
  assert.equal(items[1].status, 200);
});

test('loadingFailed 的 CORS、blocked、canceled 原因', () => {
  assert.match(failureReason({ corsError: 'MissingAllowOriginHeader' }), /cors/);
  assert.equal(failureReason({ blockedReason: 'csp' }), 'blocked: csp');
  assert.equal(failureReason({ errorText: 'net::ERR_CONNECTION_RESET', canceled: false }), 'net::ERR_CONNECTION_RESET');
  assert.equal(failureReason({ errorText: '', canceled: true }), 'canceled');
  const s = createNetworkStore();
  s.onRequest(req('a', 'u'));
  s.onFailed({ requestId: 'a', errorText: 'net::ERR_FAILED', corsErrorStatus: { corsError: 'X' } });
  assert.equal(s.get(1).failed.corsError, 'X');
});

test('status 过滤：404 / 4xx / 500-599 / 非法', () => {
  assert.deepEqual(parseStatusFilter('404'), { lo: 404, hi: 404 });
  assert.deepEqual(parseStatusFilter('4xx'), { lo: 400, hi: 499 });
  assert.deepEqual(parseStatusFilter('500-599'), { lo: 500, hi: 599 });
  assert.throws(() => parseStatusFilter('abc'), /Invalid status filter/);
  assert.throws(() => parseStatusFilter('600-500'), /Invalid status filter/);
});

test('query：method / urlPattern / failedOnly / limit', () => {
  const s = createNetworkStore();
  for (const [id, m, st] of [['a', 'GET', 200], ['b', 'POST', 500], ['c', 'GET', 404]]) {
    s.onRequest(req(id, `http://x/${id}`, { request: { url: `http://x/${id}`, method: m, headers: {} } }));
    s.onResponse({ requestId: id, response: { status: st, headers: {} } });
  }
  s.onRequest(req('d', 'http://x/d'));
  s.onFailed({ requestId: 'd', errorText: 'e' });
  assert.equal(s.query({ method: 'post' }).items.length, 1);
  assert.equal(s.query({ urlPattern: '/c' }).items.length, 1);
  assert.deepEqual(s.query({ failedOnly: true }).items.map((e) => e.requestId), ['b', 'c', 'd']);
  assert.equal(s.query({ status: '4xx' }).items.length, 1);
  assert.equal(s.query({ limit: 2 }).items.length, 2);
  assert.equal(s.query({ limit: 2 }).total, 4);
});

test('淘汰后 get 返回 evicted', () => {
  const s = createNetworkStore({ capacity: 2 });
  for (const id of ['a', 'b', 'c']) s.onRequest(req(id, id));
  assert.equal(s.get(1), 'evicted');
  assert.equal(s.get(3).requestId, 'c');
  assert.equal(s.get(99), undefined);
});

test('耗时与 lastStartedAt', () => {
  const s = createNetworkStore();
  s.onRequest(req('a', 'u', { timestamp: 10 }), 5000);
  s.onFinished({ requestId: 'a', timestamp: 13.2, encodedDataLength: 100 });
  assert.equal(s.get(1).durationMs, 3200);
  assert.equal(s.lastStartedAt(), 5000);
});

test('头脱敏与 rawHeaders', () => {
  const h = { Authorization: 'Bearer x', Accept: 'a', cookie: 'c=1' };
  assert.deepEqual(maskHeaders(h), { Authorization: '****', Accept: 'a', cookie: '****' });
  assert.equal(maskHeaders(h, true).Authorization, 'Bearer x');
});

test('列表与详情格式化', () => {
  const s = createNetworkStore();
  s.onRequest(req('a', 'http://x/a'));
  s.onFailed({ requestId: 'a', errorText: 'net::ERR_CONNECTION_RESET' });
  const { items, total } = s.query();
  const list = formatList(items, { total, label: 'failedOnly' });
  assert.match(list, /Network \(1 of 1, failedOnly\)/);
  assert.match(list, /#1\s+GET\s+FAIL/);
  assert.match(list, /ERR_CONNECTION_RESET/);
  assert.equal(formatList([], { total: 0 }), 'No network requests');
  const d = formatDetail(items[0], { responseBody: 'Response body\n  x' });
  assert.match(d, /#1 GET http:\/\/x\/a/);
  assert.match(d, /Response body/);
});

test('truncateText', () => {
  assert.deepEqual(truncateText('abc', 5), { text: 'abc', truncated: false, more: 0 });
  assert.deepEqual(truncateText('abcdef', 4), { text: 'abcd', truncated: true, more: 2 });
});
