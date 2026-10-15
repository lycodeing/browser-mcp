// tools/storage.js 的测试：假 chrome.scripting，验证入参校验、默认值、结果转换与异常处理。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorageTool } from '../tools/storage.js';
import { pageStorageOp } from '../lib/storage.js';

const ok = content => ({ content });
const err = msg => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const text = r => r.content[0].text;

function setup(execute) {
  const calls = [];
  const chrome = {
    scripting: {
      async executeScript(opts) {
        calls.push(opts);
        return execute(opts);
      },
    },
  };
  return { tool: createStorageTool({ chrome, ok, err }), calls };
}

test('缺 tabId 或必填参数时报错，且不执行脚本', async () => {
  const t = setup(() => { throw new Error('should not run'); });
  assert.equal((await t.tool({ action: 'list' })).isError, true);
  assert.match(text(await t.tool({ tabId: 1, action: 'get' })), /get needs key/);
  assert.match(text(await t.tool({ tabId: 1, action: 'set', key: 'k' })), /set needs value/);
  assert.equal(t.calls.length, 0);
});

test('默认 area=local、maxChars=2000，并注入 pageStorageOp 到主 frame', async () => {
  const t = setup(() => [{ result: { origin: 'https://a.test', area: 'localStorage', total: 0, entries: [] } }]);
  const r = await t.tool({ tabId: 5, action: 'list' });
  assert.equal(r.isError, undefined);
  assert.match(text(r), /^Origin: https:\/\/a\.test\nlocalStorage: 0 keys/);
  const call = t.calls[0];
  assert.deepEqual(call.target, { tabId: 5 });
  assert.equal(call.func, pageStorageOp);
  assert.deepEqual(call.args[0], { action: 'list', area: 'local', key: undefined, value: undefined, maxChars: 2000 });
});

test('显式 area 与 maxChars 原样传给页面函数', async () => {
  const t = setup(() => [{ result: { origin: 'o', area: 'sessionStorage', missing: true } }]);
  await t.tool({ tabId: 1, action: 'get', area: 'session', key: 'k', maxChars: 300 });
  assert.equal(t.calls[0].args[0].area, 'session');
  assert.equal(t.calls[0].args[0].maxChars, 300);
});

test('页面返回 failed 时是工具错误；denied 时不是', async () => {
  const failed = setup(() => [{ result: { origin: 'o', area: 'localStorage', failed: 'QuotaExceededError: x' } }]);
  const a = await failed.tool({ tabId: 1, action: 'set', key: 'k', value: 'v' });
  assert.equal(a.isError, true);

  const denied = setup(() => [{ result: { origin: 'o', area: 'localStorage', denied: 'SecurityError: x' } }]);
  const b = await denied.tool({ tabId: 1, action: 'list' });
  assert.equal(b.isError, undefined);
  assert.match(text(b), /Cannot access localStorage/);
});

test('页面没有返回结果（导航中）时给出明确错误', async () => {
  const t = setup(() => [{}]);
  const r = await t.tool({ tabId: 1, action: 'list' });
  assert.equal(r.isError, true);
  assert.match(text(r), /navigated during the call/);
});

test('executeScript 抛错（如受限页面）时返回 err 而不是让异常逃逸', async () => {
  const t = setup(() => { throw new Error('Cannot access a chrome:// URL'); });
  const r = await t.tool({ tabId: 1, action: 'list' });
  assert.equal(r.isError, true);
  assert.match(text(r), /chrome:\/\/ URL/);
});
