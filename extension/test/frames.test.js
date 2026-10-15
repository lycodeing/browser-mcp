import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRef, formatRef, prefixTreeRefs, mergeFrameTrees, mergeFindResults,
  formatFindLines, resolveFrameOffset, toTopPoint,
} from '../lib/frames.js';

test('parseRef 解析主 frame、子 frame 与非法输入', () => {
  assert.deepEqual(parseRef('ref_12'), { frameId: 0, ref: 'ref_12' });
  assert.deepEqual(parseRef('f3.ref_7'), { frameId: 3, ref: 'ref_7' });
  for (const bad of ['x', 'f3.x', 'ref_', 'f.ref_1', '', null, 5]) assert.equal(parseRef(bad), null, String(bad));
});

test('formatRef 主 frame 不加前缀', () => {
  assert.equal(formatRef(0, 'ref_1'), 'ref_1');
  assert.equal(formatRef(3, 'ref_1'), 'f3.ref_1');
});

test('prefixTreeRefs 只改行首 ref，不误改文本', () => {
  const tree = '[ref_1] button "see [ref_2]"\n  [ref_2] textbox';
  assert.equal(prefixTreeRefs(tree, 3), '[f3.ref_1] button "see [ref_2]"\n  [f3.ref_2] textbox');
  assert.equal(prefixTreeRefs(tree, 0), tree);
});

const main = { frameId: 0, tree: '[ref_1] heading "结账"', elementCount: 1, url: 'https://a.test' };
const f3 = { frameId: 3, tree: '[ref_1] textbox "卡号"\n[ref_2] button "支付"', elementCount: 2, url: 'https://pay.test', name: 'pay', depth: 1 };
const f7 = { frameId: 7, tree: '[ref_1] textbox "验证码"', elementCount: 1, url: 'https://3ds.test', depth: 2 };

test('mergeFrameTrees 主 frame 在前，其余按 frameId 升序', () => {
  const r = mergeFrameTrees([f7, f3, main]);
  const lines = r.body.split('\n');
  assert.equal(lines[0], '[ref_1] heading "结账"');
  assert.ok(lines.indexOf('[f3.ref_1] textbox "卡号"') < lines.indexOf('[f7.ref_1] textbox "验证码"'));
  assert.equal(r.frameCount, 3);
  assert.equal(r.elementCount, 4);
  assert.equal(r.truncated, false);
  assert.match(r.body, /── frame f3 · depth 1 · name="pay" · https:\/\/pay\.test ──/);
});

test('mergeFrameTrees 省略没有元素的子 frame', () => {
  const r = mergeFrameTrees([main, { frameId: 5, tree: '', elementCount: 0, url: 'https://ad.test' }]);
  assert.equal(r.frameCount, 1);
  assert.doesNotMatch(r.body, /f5/);
});

test('mergeFrameTrees 预算按全部 frame 合计，在整行边界截断并提示被挤掉的 frame', () => {
  const r = mergeFrameTrees([main, f3, f7], 60);
  for (const line of r.body.split('\n')) assert.match(line, /^(\[|──|omitted:|\s*$)/);
  assert.equal(r.truncated, true);
  assert.match(r.body, /omitted: f7 \(1 elements\)/);
  assert.ok(r.body.length <= 60 + 80);
});

test('mergeFrameTrees 最多合并 30 个子 frame，其余只给个数', () => {
  const many = Array.from({ length: 35 }, (_, i) => ({ frameId: i + 1, tree: '[ref_1] button "b"', elementCount: 1, url: 'u' }));
  const r = mergeFrameTrees([main, ...many], 1e6);
  assert.equal(r.frameCount, 31);
  assert.match(r.body, /omitted: 5 more frames/);
});

test('mergeFindResults 按分数降序，同分按 frameId，加前缀并截断', () => {
  const merged = mergeFindResults([
    { frameId: 3, items: [{ ref: 'ref_1', role: 'button', text: 'a', score: 10 }] },
    { frameId: 0, items: [{ ref: 'ref_9', role: 'button', text: 'b', score: 10 }, { ref: 'ref_2', role: 'link', text: 'c', score: 15 }] },
  ], 2);
  assert.deepEqual(merged.map((m) => m.ref), ['ref_2', 'ref_9']);
  const all = mergeFindResults([{ frameId: 3, items: [{ ref: 'ref_1', role: 'x', text: 't', score: 1 }] }]);
  assert.equal(all[0].ref, 'f3.ref_1');
  assert.match(formatFindLines(all)[0], /in frame f3$/);
});

const info = (frameId, token, parentToken, children = []) => ({ frameId, token, parentToken, children });
const child = (token, left, top, width, offsetWidth, clientLeft = 0, clientTop = 0) =>
  ({ token, rect: { left, top, width }, offsetWidth, clientLeft, clientTop });

test('resolveFrameOffset 一层偏移与主 frame', () => {
  const infos = [info(0, 'T0', null, [child('T3', 100, 50, 400, 400)]), info(3, 'T3', 'T0')];
  assert.deepEqual(resolveFrameOffset(3, infos), { x: 100, y: 50, scale: 1 });
  assert.deepEqual(resolveFrameOffset(0, infos), { x: 0, y: 0, scale: 1 });
});

test('resolveFrameOffset 三层累加', () => {
  const infos = [
    info(0, 'T0', null, [child('T1', 10, 20, 500, 500)]),
    info(1, 'T1', 'T0', [child('T2', 30, 40, 300, 300)]),
    info(2, 'T2', 'T1', [child('T3', 5, 6, 100, 100)]),
    info(3, 'T3', 'T2'),
  ];
  assert.deepEqual(resolveFrameOffset(3, infos), { x: 45, y: 66, scale: 1 });
});

test('resolveFrameOffset 带边框', () => {
  const infos = [info(0, 'T0', null, [child('T1', 100, 100, 304, 304, 2, 2)]), info(1, 'T1', 'T0')];
  assert.deepEqual(resolveFrameOffset(1, infos), { x: 102, y: 102, scale: 1 });
});

test('resolveFrameOffset 带缩放 scale(.5)', () => {
  const infos = [info(0, 'T0', null, [child('T1', 100, 100, 200, 400, 2, 2)]), info(1, 'T1', 'T0')];
  const off = resolveFrameOffset(1, infos);
  assert.deepEqual(off, { x: 101, y: 101, scale: 0.5 });
  assert.deepEqual(toTopPoint(off, [100, 200]), [151, 201]);
});

test('resolveFrameOffset 缩放逐层复合', () => {
  const infos = [
    info(0, 'T0', null, [child('T1', 0, 0, 200, 400)]),
    info(1, 'T1', 'T0', [child('T2', 40, 40, 100, 200)]),
    info(2, 'T2', 'T1'),
  ];
  const off = resolveFrameOffset(2, infos);
  assert.deepEqual(off, { x: 20, y: 20, scale: 0.25 });
});

test('resolveFrameOffset 握手链路不完整返回 null', () => {
  const infos = [info(0, 'T0', null, []), info(3, 'T3', 'T0')];
  assert.equal(resolveFrameOffset(3, infos), null);
  assert.equal(resolveFrameOffset(9, infos), null);
});
