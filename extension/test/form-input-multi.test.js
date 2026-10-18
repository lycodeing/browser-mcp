// form_input_multi 的测试：以最小依赖直接驱动 background.js 里的批量逻辑。
// background.js 顶层会连 chrome 事件与 WebSocket，直接导入不可行；
// 这里提取 toolFormInputMulti 函数体（setFieldValue 闭包）做行为验证：
// 与 toolFormInput 相同的页面侧函数在 runInRefFrame 注入点被复用。
// 由于 background.js 无法在 node 下导入，测试通过解析源码 + 受控求值的方式
// 取出 setFieldValue/toolFormInput/toolFormInputMulti 三个函数。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ok = content => ({ content });
const err = msg => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const text = r => r.content[0].text;

// 从 background.js 源码截取三个函数定义，在受控闭包里求值。
// 注入的 parseRef/ensureCs/runInRefFrame/refNotFound/err/ok 由测试替身实现。
function loadFormTools({ frameResults } = {}) {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'background.js'), 'utf8',
  );
  const grab = (startMarker, endMarker) => {
    const start = src.indexOf(startMarker);
    assert.ok(start !== -1, `background.js 应包含 ${startMarker}`);
    const end = src.indexOf(endMarker, start);
    assert.ok(end !== -1, `background.js 应包含 ${endMarker}`);
    return src.slice(start, end);
  };
  const body = [
    grab('async function setFieldValue(', 'async function toolNavigate('),
  ].join('\n');

  const parseRef = (ref) => {
    const m = /^(?:f(\d+)\.)?(ref_\w+)$/.exec(ref || '');
    return m ? { frameId: Number(m[1] || 0), ref: m[2] } : null;
  };
  const refNotFound = (refStr) => `Element not found: ${refStr}`;
  const calls = [];
  const runInRefFrame = async (tabId, parsed, func, args) => {
    calls.push({ tabId, frameId: parsed.frameId, ref: parsed.ref, value: args[1] });
    return frameResults[parsed.ref];
  };
  const ensureCs = async () => {};

  const factory = new Function(
    'parseRef', 'refNotFound', 'ensureCs', 'runInRefFrame', 'ok', 'err',
    `${body}\nreturn { setFieldValue, toolFormInput, toolFormInputMulti };`,
  );
  return { tools: factory(parseRef, refNotFound, ensureCs, runInRefFrame, ok, err), calls };
}

test('全部成功：逐个按序设置并返回 Set N fields', async () => {
  const { tools, calls } = loadFormTools({
    frameResults: { ref_1: { success: true, fieldName: 'user' }, ref_2: { success: true, fieldName: 'pass' } },
  });
  const r = await tools.toolFormInputMulti({
    tabId: 7,
    fields: [{ ref: 'ref_1', value: 'alice' }, { ref: 'f3.ref_2', value: 'secret' }],
  });
  assert.ok(!r.isError, text(r));
  assert.equal(text(r), 'Set 2 fields');
  assert.deepEqual(calls.map(c => c.ref), ['ref_1', 'ref_2']);
  assert.deepEqual(calls.map(c => c.frameId), [0, 3]);
  assert.deepEqual(calls.map(c => c.value), ['alice', 'secret']);
});

test('第一个失败即停：指明第几个 field、ref 与错误原因', async () => {
  const { tools, calls } = loadFormTools({
    frameResults: {
      ref_1: { success: true, fieldName: 'user' },
      ref_2: { success: false, error: 'Option not found' },
      ref_3: { success: true, fieldName: 'never' },
    },
  });
  const r = await tools.toolFormInputMulti({
    tabId: 7,
    fields: [{ ref: 'ref_1', value: 'a' }, { ref: 'ref_2', value: 'b' }, { ref: 'ref_3', value: 'c' }],
  });
  assert.ok(r.isError);
  const msg = text(r);
  assert.match(msg, /field 2 of 3/);
  assert.match(msg, /ref_2/);
  assert.match(msg, /Option not found/);
  assert.match(msg, /after 1 field set/);
  // 第三个字段不再尝试
  assert.deepEqual(calls.map(c => c.ref), ['ref_1', 'ref_2']);
});

test('第一个字段就失败时说明没有任何字段生效', async () => {
  const { tools } = loadFormTools({ frameResults: { ref_1: { success: false, error: 'not-found' } } });
  const r = await tools.toolFormInputMulti({ tabId: 7, fields: [{ ref: 'ref_1', value: 'x' }] });
  assert.ok(r.isError);
  const msg = text(r);
  assert.match(msg, /field 1 of 1/);
  assert.match(msg, /Element not found: ref_1/);
  assert.doesNotMatch(msg, /after/);
});

test('runInRefFrame 无返回（frame 已消失）按 Element not found 报错', async () => {
  const { tools } = loadFormTools({ frameResults: {} });
  const r = await tools.toolFormInputMulti({ tabId: 7, fields: [{ ref: 'f9.ref_1', value: 'x' }] });
  assert.ok(r.isError);
  assert.match(text(r), /Element not found: f9.ref_1/);
});

test('非法 ref 在批量场景下同样报错并指明序号', async () => {
  const { tools } = loadFormTools({});
  const r = await tools.toolFormInputMulti({ tabId: 7, fields: [{ ref: 'bad-ref', value: 'x' }] });
  assert.ok(r.isError);
  assert.match(text(r), /field 1 of 1/);
  assert.match(text(r), /Element not found: bad-ref/);
});

test('缺 tabId 或空 fields 报错', async () => {
  const { tools } = loadFormTools({});
  for (const bad of [
    { fields: [{ ref: 'ref_1', value: 'x' }] },
    { tabId: 7 },
    { tabId: 7, fields: [] },
  ]) {
    const r = await tools.toolFormInputMulti(bad);
    assert.ok(r.isError, JSON.stringify(bad));
  }
  const noRef = await tools.toolFormInputMulti({ tabId: 7, fields: [{ value: 'x' }] });
  assert.ok(noRef.isError);
  assert.match(text(noRef), /field 1 of 1: ref required/);
});
