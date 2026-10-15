// lib/storage.js 的测试：入参校验、页面函数（用假 window/location 驱动）、结果格式化。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateStorageArgs, pageStorageOp, formatStorageResult } from '../lib/storage.js';

function makeStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

const saved = {};
beforeEach(() => {
  saved.window = globalThis.window;
  saved.location = globalThis.location;
  globalThis.location = { origin: 'https://example.com' };
});
afterEach(() => {
  if (saved.window === undefined) delete globalThis.window; else globalThis.window = saved.window;
  if (saved.location === undefined) delete globalThis.location; else globalThis.location = saved.location;
});

const setWindow = (w) => { globalThis.window = w; };

// ── validateStorageArgs ───────────────────────────────────────────────────────

test('validate：未知 action 与未知 area 报错', () => {
  assert.match(validateStorageArgs({ action: 'nope' }), /Unknown action/);
  assert.match(validateStorageArgs({ action: 'list', area: 'cookie' }), /Unknown area/);
});

test('validate：get / set / remove 需要 key，set 还需要字符串 value', () => {
  assert.equal(validateStorageArgs({ action: 'get' }), 'get needs key');
  assert.equal(validateStorageArgs({ action: 'remove', key: '' }), 'remove needs key');
  assert.equal(validateStorageArgs({ action: 'set', key: 'k' }), 'set needs value (a string; JSON.stringify objects first)');
  assert.equal(validateStorageArgs({ action: 'set', key: 'k', value: 1 }).startsWith('set needs value'), true);
  assert.equal(validateStorageArgs({ action: 'set', key: 'k', value: '' }), null);
});

test('validate：list / clear / idb 不要求 key', () => {
  for (const action of ['list', 'clear', 'idb']) assert.equal(validateStorageArgs({ action }), null);
});

// ── pageStorageOp：localStorage / sessionStorage ──────────────────────────────

test('list：返回键、字节数与截断预览', async () => {
  setWindow({ localStorage: makeStore({ a: '1', long: 'x'.repeat(300), cn: '你好' }) });
  const r = await pageStorageOp({ action: 'list', area: 'local' });
  assert.equal(r.origin, 'https://example.com');
  assert.equal(r.total, 3);
  const byKey = Object.fromEntries(r.entries.map((e) => [e.key, e]));
  assert.equal(byKey.a.cut, false);
  assert.equal(byKey.long.cut, true);
  assert.equal(byKey.long.preview.length, 200);
  assert.equal(byKey.long.bytes, 300);
  assert.equal(byKey.cn.bytes, 6, '字节数按 UTF-8 计算');
});

test('list：超过 200 个键时只列前 200 个并给出总数', async () => {
  const init = {};
  for (let i = 0; i < 250; i++) init[`k${i}`] = 'v';
  setWindow({ localStorage: makeStore(init) });
  const r = await pageStorageOp({ action: 'list', area: 'local' });
  assert.equal(r.total, 250);
  assert.equal(r.entries.length, 200);
  assert.match(formatStorageResult({ action: 'list' }, r).text, /showing first 200 of 250/);
});

test('get：按 maxChars 截断；不存在的键标记 missing', async () => {
  setWindow({ localStorage: makeStore({ token: 'abcdefghij' }) });
  const r = await pageStorageOp({ action: 'get', area: 'local', key: 'token', maxChars: 4 });
  assert.equal(r.value, 'abcd');
  assert.equal(r.length, 10);
  const f = formatStorageResult({ action: 'get', key: 'token' }, r);
  assert.match(f.text, /truncated: showing first 4 of 10 chars/);

  const miss = await pageStorageOp({ action: 'get', area: 'local', key: 'nope', maxChars: 100 });
  assert.equal(miss.missing, true);
  assert.match(formatStorageResult({ action: 'get', key: 'nope' }, miss).text, /Key not found/);
});

test('set：新键与覆盖旧值给出不同描述，并带键数变化', async () => {
  const store = makeStore({ a: '1' });
  setWindow({ localStorage: store });
  const spec = { action: 'set', area: 'local', key: 'b', value: 'hello' };
  const r1 = await pageStorageOp(spec);
  assert.equal(store.getItem('b'), 'hello');
  assert.equal(r1.previousLength, null);
  assert.match(formatStorageResult(spec, r1).text, /new key.*Keys: 1 -> 2/s);

  const spec2 = { ...spec, value: 'bye' };
  const r2 = await pageStorageOp(spec2);
  assert.equal(r2.previousLength, 5);
  assert.match(formatStorageResult(spec2, r2).text, /replaced a 5-char value/);
});

test('remove：区分键存在与不存在', async () => {
  const store = makeStore({ a: '1', b: '2' });
  setWindow({ localStorage: store });
  const hit = await pageStorageOp({ action: 'remove', area: 'local', key: 'a' });
  assert.equal(hit.existed, true);
  assert.equal(store.length, 1);
  const miss = await pageStorageOp({ action: 'remove', area: 'local', key: 'zzz' });
  assert.equal(miss.existed, false);
  assert.match(formatStorageResult({ action: 'remove', key: 'zzz' }, miss).text, /nothing removed/);
});

test('clear：清空并报告删除数量', async () => {
  const store = makeStore({ a: '1', b: '2', c: '3' });
  setWindow({ localStorage: store });
  const spec = { action: 'clear', area: 'local' };
  const r = await pageStorageOp(spec);
  assert.equal(store.length, 0);
  assert.match(formatStorageResult(spec, r).text, /removed 3 keys\. Keys: 3 -> 0/);
});

test('area=session 读写 sessionStorage，互不串到 localStorage', async () => {
  const local = makeStore({ a: 'L' });
  const session = makeStore({ a: 'S' });
  setWindow({ localStorage: local, sessionStorage: session });
  const r = await pageStorageOp({ action: 'get', area: 'session', key: 'a', maxChars: 10 });
  assert.equal(r.area, 'sessionStorage');
  assert.equal(r.value, 'S');
  await pageStorageOp({ action: 'set', area: 'session', key: 'a', value: 'S2' });
  assert.equal(local.getItem('a'), 'L');
  assert.equal(session.getItem('a'), 'S2');
});

test('存储被禁用（访问抛 SecurityError）：返回 denied，格式化后不算工具故障', async () => {
  const w = {};
  Object.defineProperty(w, 'localStorage', {
    get() { throw Object.assign(new Error('Access is denied for this document.'), { name: 'SecurityError' }); },
  });
  setWindow(w);
  const spec = { action: 'list', area: 'local' };
  const r = await pageStorageOp(spec);
  assert.match(r.denied, /SecurityError/);
  const f = formatStorageResult(spec, r);
  assert.equal(f.error, false);
  assert.match(f.text, /^Origin: https:\/\/example\.com\nCannot access localStorage/);
});

test('写入失败（如配额超限）：返回 failed，格式化为工具错误', async () => {
  const store = makeStore();
  store.setItem = () => { throw Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' }); };
  setWindow({ localStorage: store });
  const spec = { action: 'set', area: 'local', key: 'k', value: 'v' };
  const r = await pageStorageOp(spec);
  assert.match(r.failed, /QuotaExceededError/);
  const f = formatStorageResult(spec, r);
  assert.equal(f.error, true);
  assert.match(f.text, /set failed on localStorage/);
});

// ── pageStorageOp：idb ────────────────────────────────────────────────────────

// 最小可用的假 indexedDB：databases() 列库，open() 同步触发 onsuccess
function makeIdb(dbs) {
  return {
    databases: async () => dbs.map((d) => ({ name: d.name, version: d.version })),
    open(name) {
      const d = dbs.find((x) => x.name === name);
      const req = {};
      queueMicrotask(() => {
        if (d.openError) { req.error = new Error(d.openError); req.onerror?.(); return; }
        req.result = {
          objectStoreNames: Object.keys(d.stores),
          transaction: (storeName) => ({
            objectStore: () => ({
              keyPath: d.stores[storeName].keyPath,
              autoIncrement: d.stores[storeName].autoIncrement,
              count: () => {
                const r = {};
                queueMicrotask(() => { r.result = d.stores[storeName].count; r.onsuccess?.(); });
                return r;
              },
            }),
          }),
          close() { d.closed = true; },
        };
        req.onsuccess?.();
      });
      return req;
    },
  };
}

test('idb：汇总库、仓库、记录数，用完关闭连接，且不读记录内容', async () => {
  const db = { name: 'app', version: 3, stores: { users: { keyPath: 'id', autoIncrement: false, count: 42 }, logs: { keyPath: null, autoIncrement: true, count: 7 } } };
  setWindow({ indexedDB: makeIdb([db]) });
  const spec = { action: 'idb' };
  const r = await pageStorageOp(spec);
  assert.equal(db.closed, true);
  assert.equal(r.databases[0].stores.length, 2);
  const text = formatStorageResult(spec, r).text;
  assert.match(text, /app \(version 3\)/);
  assert.match(text, /users {2}keyPath="id" {2}42 records/);
  assert.match(text, /logs {2}no keyPath autoIncrement {2}7 records/);
  assert.match(text, /record contents are not read/);
});

test('idb：单个库打开失败只标 unavailable，不拖垮整体', async () => {
  const good = { name: 'good', version: 1, stores: { s: { keyPath: 'k', autoIncrement: false, count: 1 } } };
  const bad = { name: 'bad', version: 2, stores: {}, openError: 'blocked' };
  setWindow({ indexedDB: makeIdb([bad, good]) });
  const spec = { action: 'idb' };
  const r = await pageStorageOp(spec);
  assert.match(r.databases[0].unavailable, /blocked/);
  assert.equal(r.databases[1].stores[0].count, 1);
  assert.match(formatStorageResult(spec, r).text, /bad \(version 2\) {2}unavailable: .*blocked/);
});

test('idb：浏览器没有 databases() 时给出明确说明', async () => {
  setWindow({ indexedDB: {} });
  const spec = { action: 'idb' };
  const r = await pageStorageOp(spec);
  assert.match(r.denied, /databases\(\) is not available/);
  const f = formatStorageResult(spec, r);
  assert.equal(f.error, false);
  assert.match(f.text, /Cannot access IndexedDB/);
});
