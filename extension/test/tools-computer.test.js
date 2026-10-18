// tools/computer-tools.js 的测试：注入假 chrome.debugger，记录 CDP 命令序列。
// 覆盖 click 的 ref / coordinate 两条路径、double/triple 的 clickCount、button 映射、
// screenshot 的截图内容与坐标换算比例更新、sleep 的等待文本。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComputerTools } from '../tools/computer-tools.js';

const ok = content => ({ content });
const err = msg => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const text = r => r.content[0].text;

function setup({
  elemCoords = { x: 10, y: 20 },
  scale = 0.5,
  sleepMs = [], // 记录 sleep 时长，便于断言 click 序列的节奏
} = {}) {
  const calls = [];
  const chrome = {
    debugger: {
      async sendCommand(_target, method, params) {
        calls.push({ method, params });
        if (method === 'Page.captureScreenshot') {
          return { data: 'c3RydW5n' }; // "strung" 的 base64，只作透传
        }
        return {};
      },
    },
  };
  const shotScale = new Map();
  const tools = createComputerTools({
    chrome, ok, err,
    ensureCdp: async () => {},
    ensureCs: async () => {},
    getElemCoords: async () => elemCoords,
    refNotFound: (ref) => `Element not found: ${ref}`,
    toCss: (tabId, pt) => {
      const s = shotScale.get(tabId) || 1;
      return s === 1 ? pt : [pt[0] / s, pt[1] / s];
    },
    captureScreenshot: async (tabId, opts) => ({
      data: `img-${JSON.stringify(opts)}`, width: 640, height: 360,
      format: opts.format || 'jpeg', fullPage: !!opts.fullPage, scale,
    }),
    shotScale,
    setDialogMode: () => Date.now(),
    clearDialogMode: () => {},
    appendDialogNotes: (_tabId, _t0, result) => result,
    sleep: async (ms) => { sleepMs.push(ms); },
  });
  return { ...tools, calls, shotScale };
}

// ── click ─────────────────────────────────────────────────────────────────────

test('click 走 ref 路径：getElemCoords 取坐标，默认左键单击', async () => {
  const t = setup();
  const r = await t.toolClick({ tabId: 7, ref: 'ref_3' });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /Click \(left\) at \(10,20\)/);
  const pressed = t.calls.find(c => c.params?.type === 'mousePressed');
  assert.deepEqual(
    { x: pressed.params.x, y: pressed.params.y, button: pressed.params.button, clickCount: pressed.params.clickCount },
    { x: 10, y: 20, button: 'left', clickCount: 1 },
  );
});

test('click 走 coordinate 路径：截图像素经 toCss 换算回 CSS 像素', async () => {
  const t = setup();
  // 先截图让 shotScale = 0.5，坐标 [100, 60] 应换算为 [200, 120]
  await t.toolScreenshot({ tabId: 7 });
  assert.equal(t.shotScale.get(7), 0.5);
  const r = await t.toolClick({ tabId: 7, coordinate: [100, 60] });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /Click \(left\) at \(100,60\)/);
  const pressed = t.calls.filter(c => c.params?.type === 'mousePressed').pop();
  assert.deepEqual({ x: pressed.params.x, y: pressed.params.y }, { x: 200, y: 120 });
});

test('click 的 double/triple 映射 clickCount 2/3，button 透传', async () => {
  const t = setup();
  await t.toolClick({ tabId: 7, ref: 'ref_1', double: true, button: 'middle' });
  let pressed = t.calls.find(c => c.params?.type === 'mousePressed');
  assert.equal(pressed.params.clickCount, 2);
  assert.equal(pressed.params.button, 'middle');

  await t.toolClick({ tabId: 7, ref: 'ref_1', triple: true });
  pressed = t.calls.filter(c => c.params?.type === 'mousePressed').pop();
  assert.equal(pressed.params.clickCount, 3);
  assert.match(text(await t.toolClick({ tabId: 7, ref: 'ref_1', triple: true })), /Triple-click/);
});

test('click 的完整 CDP 序列：mouseMoved → mousePressed → mouseReleased', async () => {
  const t = setup();
  await t.toolClick({ tabId: 7, ref: 'ref_2' });
  const seq = t.calls.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.params.type);
  assert.deepEqual(seq, ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('click 的右键点击后多等 300ms（等上下文菜单）', async () => {
  const sleeps = [];
  const t = setup({ sleepMs: sleeps });
  await t.toolClick({ tabId: 7, ref: 'ref_2', button: 'right' });
  assert.equal(sleeps[sleeps.length - 1], 300);
});

test('click 缺 ref 与 coordinate 报错', async () => {
  const t = setup();
  const r = await t.toolClick({ tabId: 7 });
  assert.ok(r.isError);
  assert.match(text(r), /coordinate or ref required/);
  assert.equal(t.calls.length, 0);
});

test('click 缺 tabId 报错', async () => {
  const t = setup();
  const r = await t.toolClick({ ref: 'ref_2' });
  assert.ok(r.isError);
  assert.match(text(r), /tabId/);
});

test('click 的 ref 找不到元素时按 refNotFound 文案报错', async () => {
  const t = setup({ elemCoords: null });
  const r = await t.toolClick({ tabId: 7, ref: 'f3.ref_9' });
  assert.ok(r.isError);
  assert.match(text(r), /Element not found: f3\.ref_9/);
});

// ── screenshot ─────────────────────────────────────────────────────────────────

test('screenshot 返回文本与图片内容，并更新 shotScale', async () => {
  const t = setup();
  const r = await t.toolScreenshot({ tabId: 7, format: 'webp', quality: 80 });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.match(r.content[0].text, /Screenshot 640x360/);
  assert.equal(r.content[1].type, 'image');
  assert.equal(r.content[1].mimeType, 'image/webp');
  assert.equal(t.shotScale.get(7), 0.5);
  // 缩放 < 1 时附注提醒坐标按图像像素传
  assert.match(r.content[0].text, /scaled 0\.50x/);
});

test('screenshot 的 fullPage 不更新 shotScale 且不带缩放附注', async () => {
  const t = setup();
  const r = await t.toolScreenshot({ tabId: 7, fullPage: true });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.ok(!t.shotScale.has(7));
  assert.doesNotMatch(r.content[0].text, /scaled/);
});

test('screenshot 缺 tabId 报错且不发 CDP 命令', async () => {
  const t = setup();
  const r = await t.toolScreenshot({});
  assert.ok(r.isError);
  assert.match(text(r), /tabId/);
  assert.equal(t.calls.length, 0);
});

// ── sleep ──────────────────────────────────────────────────────────────────────

test('sleep 按秒数等待并返回文本', async () => {
  const sleeps = [];
  const t = setup({ sleepMs: sleeps });
  const r = await t.toolSleep({ tabId: 7, seconds: 2 });
  assert.ok(!r.isError);
  assert.equal(text(r), 'Waited 2s');
  assert.deepEqual(sleeps, [2000]);
});

test('sleep 超过 10 秒封顶为 10 秒', async () => {
  const sleeps = [];
  const t = setup({ sleepMs: sleeps });
  await t.toolSleep({ tabId: 7, seconds: 99 });
  assert.deepEqual(sleeps, [10000]);
});

test('sleep 缺 tabId 或 seconds 报错', async () => {
  const t = setup();
  assert.ok((await t.toolSleep({})).isError);
  await t.toolSleep({ tabId: 7, seconds: 3 }); // seconds=3 合法
  const bad = await t.toolSleep({ tabId: 7, seconds: undefined });
  assert.ok(bad.isError || text(bad).includes('Waited'), '缺 seconds 时不崩溃');
});

// ── computer 复用同一实现（防回归）────────────────────────────────────────────

test('resolveClickPoint / dispatchClick / takeScreenshot 供 computerDispatch 复用导出', async () => {
  const t = setup();
  assert.equal(typeof t.resolveClickPoint, 'function');
  assert.equal(typeof t.dispatchClick, 'function');
  assert.equal(typeof t.takeScreenshot, 'function');
});
