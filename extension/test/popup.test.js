// popup-utils.js 的测试：popup 拆出纯函数后，格式化/校验/消息协议可在 node --test 下直测。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MSG, formatElapsed, formatSize, validateFlowName, formatRecordedAt, formatFlowMeta,
} from '../popup-utils.js';

// ── formatElapsed：毫秒 → MM:SS ────────────────────────────────────────────────

test('formatElapsed 基础用例', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(59000), '00:59');
  assert.equal(formatElapsed(65000), '01:05');
  assert.equal(formatElapsed(3661000), '61:01'); // 超 1 小时继续累计分钟，不折算天数
});

test('formatElapsed 非法输入兜底为 00:00', () => {
  assert.equal(formatElapsed(undefined), '00:00');
  assert.equal(formatElapsed(null), '00:00');
  assert.equal(formatElapsed(NaN), '00:00');
  assert.equal(formatElapsed(-5000), '00:00'); // 负数（时钟回拨）钳到 0
  assert.equal(formatElapsed('abc'), '00:00');
});

// ── formatSize：字节 → 人类可读 ────────────────────────────────────────────────

test('formatSize 基础用例', () => {
  assert.equal(formatSize(1258291), '1.2 MB');
  assert.equal(formatSize(348160), '340 KB');
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1024), '1.0 KB');
  assert.equal(formatSize(1048576), '1.0 MB');
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB');
});

test('formatSize 0/缺失/非法返回空串（无 GIF 时元信息不显示体积段）', () => {
  assert.equal(formatSize(0), '');
  assert.equal(formatSize(undefined), '');
  assert.equal(formatSize(null), '');
  assert.equal(formatSize(-1), '');
  assert.equal(formatSize('abc'), '');
});

// ── validateFlowName ───────────────────────────────────────────────────────────

test('validateFlowName 合法名称去空白后通过', () => {
  const r = validateFlowName('  下载商品主图  ');
  assert.equal(r.ok, true);
  assert.equal(r.name, '下载商品主图');
});

test('validateFlowName 空名称被拒绝', () => {
  assert.equal(validateFlowName('').ok, false);
  assert.equal(validateFlowName('   ').ok, false);
  assert.equal(validateFlowName(undefined).ok, false);
});

test('validateFlowName 超 50 字符被拒绝', () => {
  assert.equal(validateFlowName('x'.repeat(51)).ok, false);
  assert.equal(validateFlowName('x'.repeat(50)).ok, true);
});

// ── formatRecordedAt / formatFlowMeta ─────────────────────────────────────────

test('formatRecordedAt 兼容 ISO 字符串与 epoch 毫秒，输出本地化 YYYY-MM-DD HH:mm', () => {
  const iso = '2026-10-19T01:30:00'; // 无时区的本地时间表示
  assert.equal(formatRecordedAt(iso), '2026-10-19 01:30');
  assert.equal(formatRecordedAt(new Date(2026, 9, 19, 1, 30).getTime()), '2026-10-19 01:30');
  assert.equal(formatRecordedAt(new Date(2026, 9, 19, 1, 30)), '2026-10-19 01:30');
});

test('formatRecordedAt 空值与非法值返回空串', () => {
  assert.equal(formatRecordedAt(''), '');
  assert.equal(formatRecordedAt(undefined), '');
  assert.equal(formatRecordedAt('not-a-date'), '');
});

test('formatFlowMeta 元信息行各段按 · 拼接', () => {
  assert.equal(
    formatFlowMeta({ name: '下载商品主图', steps: 6, gifSize: 1258291, recordedAt: '2026-10-19T01:30:00' }),
    '6 步 · GIF 1.2 MB · 2026-10-19 01:30',
  );
  // 无 GIF：体积段省略
  assert.equal(
    formatFlowMeta({ name: '检查库存', steps: 12, gifSize: 0, recordedAt: '2026-10-18T22:15:00' }),
    '12 步 · 2026-10-18 22:15',
  );
});

// ── 消息协议常量 ───────────────────────────────────────────────────────────────

test('消息类型常量与 background.js 的 onMessage 分发约定一致', () => {
  assert.equal(MSG.GET_STATUS, 'getStatus');
  assert.equal(MSG.RECONNECT, 'reconnect');
  assert.equal(MSG.RECORD_START, 'record:start');
  assert.equal(MSG.RECORD_STOP, 'record:stop');
  assert.equal(MSG.RECORD_CANCEL, 'record:cancel');
  assert.equal(MSG.RECORD_STATE, 'record:getState');
  assert.equal(MSG.RECORD_LIST, 'record:list');
  assert.equal(MSG.RECORD_RUN, 'record:run');
  assert.equal(MSG.RECORD_DELETE, 'record:delete');
  assert.equal(MSG.RECORD_EXPORT_GIF, 'record:exportGif');
});

test('消息常量无重复值（一个 type 泄漏到多个语义会导致 background 分发错乱）', () => {
  const values = Object.values(MSG);
  assert.equal(new Set(values).size, values.length);
});
