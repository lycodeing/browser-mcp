// lib/js-tool.js 的测试：formatJsResult 从 background.js 搬出后行为不变；截断上限。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJsResult, truncateResult, MAX_CODE_CHARS, MAX_RESULT_CHARS } from '../lib/js-tool.js';

test('undefined/null/标量直出', () => {
  assert.equal(formatJsResult(undefined), 'undefined');
  assert.equal(formatJsResult(null), 'null');
  assert.equal(formatJsResult('str'), 'str');
  assert.equal(formatJsResult(42), '42');
  assert.equal(formatJsResult(false), 'false');
});

test('对象 JSON 序列化，循环引用回退 String()', () => {
  assert.equal(formatJsResult({ a: 1 }), '{\n  "a": 1\n}');
  const cyc = {}; cyc.self = cyc;
  assert.equal(typeof formatJsResult(cyc), 'string');
});

test('长结果截断到 MAX_RESULT_CHARS 并带标记', () => {
  const long = 'a'.repeat(MAX_RESULT_CHARS + 10);
  const out = truncateResult(long);
  assert.ok(out.length <= MAX_RESULT_CHARS + '\n...[truncated]'.length);
  assert.match(out, /\[truncated\]$/);
  assert.equal(truncateResult('short'), 'short');
});

test('代码长度上限常量与旧实现一致', () => {
  assert.equal(MAX_CODE_CHARS, 100000);
});
