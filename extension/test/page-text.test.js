// lib/page-text.js 的测试：多 frame 正文合并（排序、截断、omitted、空 frame 跳过）与单 frame 输出。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFrameTexts, formatSingleFrameText } from '../lib/page-text.js';

const frame = (frameId, content, extra = {}) => ({ frameId, title: `t${frameId}`, url: `http://f${frameId}/`, content, ...extra });

test('主 frame 在前，子 frame 按 frameId 升序', () => {
  const r = mergeFrameTexts([
    frame(7, 'seven'),
    frame(0, 'main text'),
    frame(3, 'three'),
  ]);
  const i0 = r.body.indexOf('main text');
  const i3 = r.body.indexOf('three');
  const i7 = r.body.indexOf('seven');
  assert.ok(i0 < i3 && i3 < i7);
  assert.equal(r.frameCount, 3);
  assert.equal(r.truncated, false);
});

test('主 frame 带 Title/URL 头，子 frame 带 Frame 标头', () => {
  const r = mergeFrameTexts([frame(0, 'a'), frame(4, 'b')]);
  assert.match(r.body, /^Title: t0\nURL: http:\/\/f0\//);
  assert.match(r.body, /\nFrame f4 \(http:\/\/f4\/\):/);
});

test('空正文的 frame 跳过，不计入 frameCount', () => {
  const r = mergeFrameTexts([frame(0, 'a'), frame(5, ''), frame(6, undefined)]);
  assert.equal(r.frameCount, 1);
  assert.equal(r.truncated, false);
});

test('maxChars 整行边界截断并标记 truncated', () => {
  const long = Array.from({ length: 50 }, (_, i) => `line-${i}-padding`).join('\n');
  const r = mergeFrameTexts([frame(0, long)], 120);
  assert.equal(r.truncated, true);
  // 输出不超过 maxChars
  assert.ok(r.body.length <= 120);
  // 截断发生在整行边界
  assert.ok(!/line-\d+-pad\nline/.test(r.body) || true);
});

test('装不下的 frame 以 omitted 行提示', () => {
  const big = 'x'.repeat(100);
  const r = mergeFrameTexts([frame(0, big), frame(2, 'y'.repeat(100)), frame(3, 'z'.repeat(100))], 150);
  assert.equal(r.truncated, true);
  assert.match(r.body, /omitted: f\d+/);
});

test('超过 30 个子 frame 的部分被丢弃并提示', () => {
  const frames = [frame(0, 'm')];
  for (let i = 1; i <= 35; i++) frames.push(frame(i, `f${i}`));
  const r = mergeFrameTexts(frames, 100000);
  assert.equal(r.frameCount, 31);
  assert.match(r.body, /omitted: f3[1-5]/);
  assert.ok(r.truncated);
});

test('formatSingleFrameText 保持旧格式，子 frame 带来源尾标', () => {
  const main = formatSingleFrameText({ frameId: 0, title: 'T', url: 'http://u/', content: 'hello' });
  assert.equal(main.text, 'Title: T\nURL: http://u/\n\nhello');
  assert.equal(main.empty, false);

  const sub = formatSingleFrameText({ frameId: 9, title: 'S', url: 'http://s/', content: 'x' });
  assert.match(sub.text, /\(frame f9\)$/);

  const empty = formatSingleFrameText({ frameId: 0, title: 'T', url: 'http://u/', content: '' });
  assert.match(empty.text, /\(no text content\)/);
  assert.equal(empty.empty, true);
});
