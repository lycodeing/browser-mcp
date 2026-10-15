// tab-queue 单元测试：覆盖设计文档 9.1 表中的全部点。
// 用几十毫秒的 waitMs / sleep，避免真实长等待。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTabQueue, TabBusyError } from '../lib/tab-queue.js';
import { withTimeout } from '../lib/timeout.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('同 tabId 严格 FIFO：先入队的先执行', async () => {
  const q = createTabQueue({ waitMs: 5000 });
  const order = [];
  const mk = (tag, ms) => () => sleep(ms).then(() => { order.push(tag); return tag; });

  const p1 = q.run(101, mk('a', 30));
  const p2 = q.run(101, mk('b', 5));
  const p3 = q.run(101, mk('c', 5));
  assert.deepEqual(await Promise.all([p1, p2, p3]), ['a', 'b', 'c']);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('不同 tabId 并行执行', async () => {
  const q = createTabQueue({ waitMs: 5000 });
  let running = 0;
  let maxRunning = 0;
  const mk = ms => () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    return sleep(ms).then(() => { running--; });
  };

  await Promise.all([q.run(1, mk(30)), q.run(2, mk(30)), q.run(3, mk(30))]);
  assert.equal(maxRunning, 3, '三个不同 tab 应同时执行');
});

test('排队超过 waitMs 抛 TabBusyError，且不占用锁、不影响后续任务', async () => {
  // 锁持有 120ms > waitMs=50：second 排队 50ms 后超时
  const q = createTabQueue({ waitMs: 50 });
  const first = q.run(101, () => sleep(120).then(() => 'first'));
  const second = q.run(101, () => 'second').then(
    v => { throw new Error(`应超时却返回 ${v}`); },
    e => e,
  );

  const e = await second;
  assert.ok(e instanceof TabBusyError);
  assert.equal(e.name, 'TabBusyError');
  assert.equal(e.tabId, 101);
  assert.equal(e.message, 'Tab 101 is busy with another operation (waited 0s). Use a separate tab per agent, or retry.');

  // first 正常完成，锁释放；已超时移出队列的 second 不影响之后的新任务
  assert.equal(await first, 'first');
  assert.equal(await q.run(101, () => 'after'), 'after');
});

test('任务抛错后锁释放，下一个任务照常执行', async () => {
  const q = createTabQueue({ waitMs: 5000 });
  const failing = q.run(101, () => Promise.reject(new Error('boom')));
  const next = q.run(101, () => 'ok');
  await assert.rejects(() => failing, /boom/);
  assert.equal(await next, 'ok');
});

test('任务被 withTimeout 超时后锁释放', async () => {
  const q = createTabQueue({ waitMs: 5000 });
  // 模拟设计 4.2 的接入方式：工具超时放在队列内部
  const slow = q.run(101, () => withTimeout(sleep(200).then(() => 'slow'), 30, 'computer'));
  await assert.rejects(() => slow, /Tool timeout: computer/);
  // 锁在慢任务 finally 时释放；下一个任务应在 waitMs 内轮到
  const next = q.run(101, () => 'after-timeout');
  assert.equal(await next, 'after-timeout');
});

test('clear(tabId) 清理队列：等待中的任务以明确错误拒绝', async () => {
  const q = createTabQueue({ waitMs: 5000 });
  const first = q.run(101, () => sleep(50).then(() => 'first'));
  const waiting = q.run(101, () => 'waiting');

  // 在 first 还持有锁时清掉队列（对应标签页被关闭）
  q.clear(101);
  await assert.rejects(() => waiting, /Tab 101 was closed while waiting in queue/);
  assert.equal(await first, 'first');

  // clear 后同 tabId 的新任务从干净状态开始
  assert.equal(await q.run(101, () => 'fresh'), 'fresh');
});

test('clear 时正在执行的任务不受影响，其他 tab 的队列不受影响', async () => {
  const q = createTabQueue({ waitMs: 5000 });
  const a1 = q.run(1, () => sleep(30).then(() => 'a1'));
  const b1 = q.run(2, () => sleep(30).then(() => 'b1'));
  q.clear(2);
  assert.equal(await a1, 'a1');
  assert.equal(await b1, 'b1');
  // tab 2 的队列条目已删
  assert.equal(await q.run(2, () => 'b2'), 'b2');
});

test('队列空后删除 Map 条目，无内存泄漏', async () => {
  const q = createTabQueue({ waitMs: 5000 });
  await q.run(101, () => 1);
  await q.run(202, () => 2);
  // 无内部句柄可查，用行为验证：重复使用同一 tabId 大量次数均正常
  for (let i = 0; i < 100; i++) await q.run(101, () => i);
  assert.equal(await q.run(101, () => 'done'), 'done');
});

test('排队等待从入队开始计时：锁在 waitMs 内释放则任务正常执行', async () => {
  const q = createTabQueue({ waitMs: 200 });
  const first = q.run(101, () => sleep(30).then(() => 'first'));
  const second = q.run(101, () => 'second');
  // first 30ms 释放，second 等约 30ms < 200ms，应正常执行
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
});

test('排队计时不含任务执行时间：前一个任务执行多久都不影响已轮到的任务', async () => {
  const q = createTabQueue({ waitMs: 200 });
  const first = q.run(101, () => sleep(30).then(() => 'first'));
  const second = q.run(101, () => sleep(1).then(() => 'second'));
  assert.equal(await first, 'first');
  const t0 = Date.now();
  assert.equal(await second, 'second');
  // second 是轮到后才开始执行的，耗时只含自身 1ms 的任务
  assert.ok(Date.now() - t0 < 150, 'second 不应再经历排队等待');
});
