// recorder.js 的测试：node --test 环境，手动 mock 最小 DOM（document/Element），
// 验证 buildTargetDescriptor 各字段提取、cssPath 构建（id 停止 / nth-child / 8 层上限）、
// input 300ms debounce 合并、密码框脱敏、start/stop 生命周期与幂等守卫。
// 注入方式与真实页面一致：受控求值 IIFE 后从 globalThis.__recorder 取实例。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RECORDER_SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'content-scripts', 'recorder.js'),
  'utf8',
);

// ── 最小 DOM mock ─────────────────────────────────────────────────────────────
// 覆盖 recorder 用到的 API：tagName/children/parentElement/id/attributes/
// getBoundingClientRect/innerText/appendChild/removeEventListener。

class MockElement {
  constructor(tag, { id = '', attrs = {}, text = '', value = '', type = '' } = {}) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.id = id;
    this._attrs = attrs;
    this._text = text;
    this.value = value;
    if (type) this.type = type;
    this.children = [];
    this.parentElement = null;
    this.style = { cssText: '' };
    this._listeners = {};
  }

  get innerText() { return this._text; }
  get textContent() { return this._text; }

  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }
  setAttribute(name, v) { this._attrs[name] = String(v); }

  getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 40 }; }

  appendChild(child) {
    this.children.push(child);
    child.parentElement = this; // remove() 依赖 parentElement 摘除自身
    return child;
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn);
  }

  // 测试辅助：构造 DOM 树
  add(...kids) {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }
}

function buildDocument({ bodyKids = [] } = {}) {
  const doc = new MockElement('document');
  doc.nodeType = 9;
  doc.body = new MockElement('body');
  doc.documentElement = new MockElement('html');
  doc.head = new MockElement('head');
  doc.body.add(...bodyKids);
  doc._listeners = {};
  doc.addEventListener = (type, fn) => { (doc._listeners[type] ||= []).push(fn); };
  doc.removeEventListener = () => {};
  doc.getElementById = () => null;
  doc.createElement = (tag) => new MockElement(tag);
  return doc;
}

// 受控环境里求值 recorder.js IIFE；mock document 注入后 globalThis 用独立对象承载
// （recorder.js 运行时读的 globalThis.__recorderFrameId 就写在这个 sandbox 上）
function loadRecorder({ doc, frameId } = {}) {
  const sandbox = { setTimeout, clearTimeout, Date, Math, JSON, Error, Promise };
  if (frameId !== undefined) sandbox.__recorderFrameId = frameId;
  // eslint-disable-next-line no-new-func
  const factory = new Function('globalThis', 'document', RECORDER_SRC
    + '\n;return globalThis.__recorder;');
  const recorder = factory(sandbox, doc);
  return { recorder, sandbox, doc };
}

// 直接派发一个事件给 document 捕获监听器（mock 不做冒泡，等价于捕获阶段收到）
function dispatch(doc, type, target, extra = {}) {
  const e = { type, target, ...extra };
  for (const fn of doc._listeners[type] || []) fn(e);
}

// ── 生命周期 ─────────────────────────────────────────────────────────────────

test('start/stop 控制 isRecording，stop 后事件不再上报', () => {
  const doc = buildDocument();
  const { recorder } = loadRecorder({ doc });
  assert.equal(recorder.isRecording, false);

  const events = [];
  recorder.start((r) => events.push(r));
  assert.equal(recorder.isRecording, true);

  const btn = new MockElement('button', { text: '保存' });
  dispatch(doc, 'click', btn);
  assert.equal(events.length, 1);

  recorder.stop();
  assert.equal(recorder.isRecording, false);
  dispatch(doc, 'click', btn);
  assert.equal(events.length, 1); // stop 后不再累计
});

test('幂等守卫：同一环境重复执行脚本时保留首个 __recorder 实例', () => {
  const doc = buildDocument();
  const sandbox = { setTimeout, clearTimeout, Date, Math, JSON, Error, Promise };
  const factory = new Function('globalThis', 'document', RECORDER_SRC + '\n;return globalThis.__recorder;');
  const first = factory(sandbox, doc);
  const second = factory(sandbox, doc); // 守卫生效：第二次求值直接跳过
  assert.equal(second, first);
  assert.notEqual(second, 'recreated');
  assert.equal(typeof second.start, 'function');
});

// ── buildTargetDescriptor 字段提取 ────────────────────────────────────────────

test('buildTargetDescriptor：各字段提取（text/aria/placeholder/role/tag/frameId）', () => {
  const input = new MockElement('input', {
    attrs: { placeholder: '用户名', 'aria-label': '账号输入框', role: 'textbox', type: 'text' },
  });
  input.value = 'alice';
  const doc = buildDocument({ bodyKids: [input] });
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  dispatch(doc, 'click', input);

  const { step } = events[0];
  assert.equal(step.tool, 'click');
  const t = step.args.target;
  assert.equal(t.tag, 'input');
  assert.equal(t.ariaLabel, '账号输入框');
  assert.equal(t.placeholder, '用户名');
  assert.equal(t.role, 'textbox'); // 显式 role 优先
  assert.equal(t.cssPath, 'body > input');
  assert.equal(step.note, '点击「账号输入框」');
});

test('buildTargetDescriptor：无显式 role 时从 tag 推断（button→button, a→link, checkbox→checkbox）', () => {
  const btn = new MockElement('button', { text: '提交订单' });
  const a = new MockElement('a', { text: '首页' });
  const cb = new MockElement('input', { attrs: { type: 'checkbox' } });
  cb.type = 'checkbox';
  const doc = buildDocument({ bodyKids: [btn, a, cb] });
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  dispatch(doc, 'click', btn);
  dispatch(doc, 'click', a);
  dispatch(doc, 'click', cb);

  assert.equal(events[0].step.args.target.role, 'button');
  assert.equal(events[1].step.args.target.role, 'link');
  assert.equal(events[2].step.args.target.role, 'checkbox');
  assert.equal(events[0].step.args.target.text, '提交订单');
});

test('buildTargetDescriptor：text 归一空白并截断到 120 字符', () => {
  const long = 'x'.repeat(200);
  const btn = new MockElement('button', { text: `  多个   空白\n换行\t制表 ${long}` });
  const doc = buildDocument({ bodyKids: [btn] });
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  dispatch(doc, 'click', btn);
  const t = events[0].step.args.target;
  assert.ok(t.text.startsWith('多个 空白 换行 制表'));
  assert.equal(t.text.length, 120);
});

test('buildTargetDescriptor：子 frame 场景挂上 __recorderFrameId', () => {
  const doc = buildDocument();
  // frameId 由 background 激活时写进 frame 环境的 __recorderFrameId（沙箱即该 frame 的 globalThis）
  const { recorder } = loadRecorder({ doc, frameId: 3 });
  const events = [];
  recorder.start((r) => events.push(r));
  dispatch(doc, 'click', new MockElement('button', { text: 'ok' }));
  assert.equal(events[0].step.args.target.frameId, 3);
});

// ── cssPath 构建 ─────────────────────────────────────────────────────────────

test('cssPath：同级多个相同 tag 时加 :nth-child(n)', () => {
  const link1 = new MockElement('a', { text: '第一页' });
  const link2 = new MockElement('a', { text: '第二页' });
  const nav = new MockElement('nav');
  nav.add(link1, link2);
  const doc = buildDocument({ bodyKids: [nav] });
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  dispatch(doc, 'click', link2);
  assert.equal(events[0].step.args.target.cssPath, 'body > nav > a:nth-child(2)');
});

test('cssPath：遇 id 用 #id 并停止向上', () => {
  // 可交互的 a 放在带 id 的容器里：cssPath 到 #id 就停，不再向上找 section
  const link = new MockElement('a', { text: 'go' });
  const p = new MockElement('p');
  const wrap = new MockElement('div', { id: 'main-wrap' });
  const outer = new MockElement('section');
  outer.add(wrap);
  wrap.add(p);
  p.add(link);
  const doc = buildDocument({ bodyKids: [outer] });
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  dispatch(doc, 'click', link);
  assert.equal(events[0].step.args.target.cssPath, '#main-wrap > p > a');
});

test('cssPath：最多 8 层，超深嵌套截断', () => {
  let cur = new MockElement('div');
  const chain = [cur];
  for (let i = 0; i < 15; i++) {
    const next = new MockElement('div');
    cur.add(next);
    chain.push(next);
    cur = next;
  }
  const leaf = new MockElement('button', { text: 'deep' });
  cur.add(leaf);

  const doc = buildDocument({ bodyKids: [chain[0]] });
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));
  dispatch(doc, 'click', leaf);

  const parts = events[0].step.args.target.cssPath.split(' > ');
  assert.ok(parts.length <= 8, `cssPath 层数应 ≤ 8，实际 ${parts.length}`);
  assert.equal(parts[parts.length - 1], 'button');
});

test('cssPath：同级唯一 tag 不带 nth-child', () => {
  const only = new MockElement('button', { text: '唯一' });
  const bar = new MockElement('nav');
  bar.add(only);
  const doc = buildDocument({ bodyKids: [bar] });
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));
  dispatch(doc, 'click', only);
  assert.equal(events[0].step.args.target.cssPath, 'body > nav > button');
});

// ── debounce 合并 ────────────────────────────────────────────────────────────

test('input debounce：300ms 内连续输入只发一次，值为最后一次', async () => {
  const doc = buildDocument();
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  const input = new MockElement('input', { attrs: { placeholder: '搜索' } });
  input.value = 'a';
  dispatch(doc, 'input', input);
  input.value = 'ab';
  dispatch(doc, 'input', input);
  input.value = 'abc';
  dispatch(doc, 'input', input);

  assert.equal(events.length, 0); // 静默期未到，先不发
  await new Promise(r => setTimeout(r, 360));
  assert.equal(events.length, 1);
  assert.equal(events[0].step.tool, 'form_input');
  assert.equal(events[0].step.args.value, 'abc');
  assert.equal(events[0].step.note, '填写「搜索」');
  assert.equal(events[0].type, 'input');
});

test('input debounce：切换输入框时上一笔立即发出', async () => {
  const doc = buildDocument();
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  const input1 = new MockElement('input', { attrs: { placeholder: '账号' } });
  input1.value = 'alice';
  dispatch(doc, 'input', input1);

  const input2 = new MockElement('input', { attrs: { placeholder: '密码' } });
  input2.value = 'secret';
  dispatch(doc, 'input', input2);

  assert.equal(events.length, 1); // 第一笔在换框瞬间被冲出
  assert.equal(events[0].step.args.target.placeholder, '账号');
  await new Promise(r => setTimeout(r, 360));
  assert.equal(events.length, 2);
  assert.equal(events[1].step.args.target.placeholder, '密码');
});

test('click 事件触发时 pending input 立即发出（顺序在前）', async () => {
  const doc = buildDocument();
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  const input = new MockElement('input', { attrs: { placeholder: '搜索' } });
  input.value = 'query';
  dispatch(doc, 'input', input);
  dispatch(doc, 'click', new MockElement('button', { text: '搜索' }));

  assert.equal(events.length, 2);
  assert.equal(events[0].step.tool, 'form_input'); // 输入先落地
  assert.equal(events[1].step.tool, 'click');
  await new Promise(r => setTimeout(r, 360));
  assert.equal(events.length, 2); // debounce 已清空，不重复发
});

test('stop 时 pending input 补发，不丢最后一步', async () => {
  const doc = buildDocument();
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  const input = new MockElement('input', { attrs: { placeholder: '备注' } });
  input.value = 'final';
  dispatch(doc, 'input', input);
  assert.equal(events.length, 0);
  recorder.stop();
  assert.equal(events.length, 1);
  assert.equal(events[0].step.args.value, 'final');
});

// ── 密码脱敏 ─────────────────────────────────────────────────────────────────

test('密码框的 value 替换为 <REDACTED>', async () => {
  const doc = buildDocument();
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  const pwd = new MockElement('input', { attrs: { type: 'password', placeholder: '密码' } });
  pwd.type = 'password';
  pwd.value = 'p@ssw0rd!';
  dispatch(doc, 'input', pwd);
  await new Promise(r => setTimeout(r, 360));

  assert.equal(events.length, 1);
  assert.equal(events[0].step.args.value, '<REDACTED>');
  assert.notEqual(events[0].step.args.value, 'p@ssw0rd!');
});

test('非密码 input 的 value 原样记录', async () => {
  const doc = buildDocument();
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  const txt = new MockElement('input', { attrs: { type: 'text' } });
  txt.value = 'hello world';
  dispatch(doc, 'input', txt);
  await new Promise(r => setTimeout(r, 360));
  assert.equal(events[0].step.args.value, 'hello world');
});

// ── 事件过滤 ─────────────────────────────────────────────────────────────────

test('keydown 只录导航键，普通字符键被忽略', () => {
  const input = new MockElement('input', { attrs: { placeholder: '搜索' } });
  const doc = buildDocument({ bodyKids: [input] });
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  dispatch(doc, 'keydown', input, { key: 'a' });
  dispatch(doc, 'keydown', input, { key: 'Enter' }); // 输入框内 Enter 交给 submit 兜底
  dispatch(doc, 'keydown', input, { key: 'Escape' });
  dispatch(doc, 'keydown', input, { key: 'ArrowDown' });

  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.step.args.key), ['Escape', 'ArrowDown']);
  assert.equal(events[0].step.note, '按 Escape');
});

test('form 上的 Enter 记为提交表单，submit 事件同样映射为 key Enter', () => {
  const doc = buildDocument();
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  const form = new MockElement('form');
  dispatch(doc, 'keydown', form, { key: 'Enter' });
  dispatch(doc, 'submit', form);

  assert.equal(events.length, 2);
  assert.equal(events[0].step.tool, 'key');
  assert.equal(events[0].step.note, '提交表单');
  assert.equal(events[1].step.args.key, 'Enter');
  assert.equal(events[1].step.note, '提交表单');
});

test('click 落在纯文本上时上溯可交互祖先', () => {
  const doc = buildDocument();
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  const label = new MockElement('span', { text: '点我' });
  const btn = new MockElement('button');
  btn.add(label);
  dispatch(doc, 'click', label);

  assert.equal(events.length, 1);
  assert.equal(events[0].step.args.target.tag, 'button');
});

test('非交互元素与非 input 元素的事件被忽略', () => {
  const doc = buildDocument();
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  dispatch(doc, 'click', new MockElement('div', { text: '纯文本' }));
  dispatch(doc, 'input', new MockElement('div'));
  assert.equal(events.length, 0);
});

test('change 只兜底 select，input 上的 change 不重复记录', async () => {
  const doc = buildDocument();
  const { recorder } = loadRecorder({ doc });
  const events = [];
  recorder.start((r) => events.push(r));

  const select = new MockElement('select', { attrs: { 'aria-label': '城市' } });
  select.value = '上海';
  dispatch(doc, 'change', select);

  const input = new MockElement('input', { attrs: { placeholder: 'x' } });
  dispatch(doc, 'change', input); // input 元素的 change 被忽略
  await new Promise(r => setTimeout(r, 360));

  assert.equal(events.length, 1);
  assert.equal(events[0].step.args.target.tag, 'select');
  assert.equal(events[0].step.args.value, '上海');
});

// ── 高亮注入 ─────────────────────────────────────────────────────────────────

test('injectHighlight：click 红 / input 绿，2 秒后自动移除', async () => {
  const doc = buildDocument();
  const { recorder } = loadRecorder({ doc });

  const btn = new MockElement('button', { text: 'ok' });
  const r1 = recorder.injectHighlight(btn, 'click');
  assert.equal(r1.width, 100); // rect 来自 getBoundingClientRect 的 mock 值
  assert.equal(doc.body.children.length, 1);
  assert.ok(doc.body.children[0].style.cssText.includes('#ef4444')); // click 红框

  const r2 = recorder.injectHighlight({ left: 0, top: 0, width: 10, height: 10 }, 'input');
  assert.equal(r2.width, 10);
  assert.ok(doc.body.children[1].style.cssText.includes('#22c55e')); // input 绿框
  assert.match(doc.body.children[1].style.cssText, /position:fixed/);

  await new Promise(r => setTimeout(r, 2100));
  assert.equal(doc.body.children.length, 0); // 高亮框到期移除
});
