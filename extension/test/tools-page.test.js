// tools/page-tools.js 的测试：假 chrome（scripting、debugger、debugger.onEvent），
// 验证 frameId 路由、allFrames 合并、file_upload 的 performSearch 通路与 frame 不存在报错。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageTools } from '../tools/page-tools.js';

const ok = content => ({ content });
const err = msg => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const text = r => r.content[0].text;

// executeScript 按 target 返回结果：frameIds 命中返回该 frame，allFrames 返回全部
function makeChrome({ frames = {}, fileChooser, searchResult, evalResult, frameTree } = {}) {
  const calls = [];
  const listeners = [];
  const chrome = {
    scripting: {
      async executeScript(opts) {
        calls.push({ kind: 'executeScript', opts });
        if (opts.target.allFrames) {
          return Object.entries(frames).map(([id, result]) => ({ frameId: Number(id), result }));
        }
        const id = opts.target.frameIds[0];
        return frames[id] !== undefined ? [{ frameId: id, result: frames[id] }] : [];
      },
    },
    debugger: {
      async sendCommand(target, method, params) {
        calls.push({ kind: 'cdp', target, method, params });
        if (method === 'DOM.performSearch') return searchResult ?? { searchId: 's1', resultCount: 1 };
        if (method === 'DOM.getSearchResults') return { nodeIds: [77] };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
        if (method === 'Page.getFrameTree') {
          return frameTree ?? { frameTree: { frame: { id: 'MAIN', url: 'http://a.test/', name: '' }, childFrames: [
            { frame: { id: 'CDP-3', url: 'http://b.test/', name: '' } },
          ] } };
        }
        if (method === 'Runtime.evaluate') {
          if (evalResult !== undefined) return typeof evalResult === 'function' ? evalResult(params) : evalResult;
          return { result: { value: 'cdp', objectId: 'obj-1' } };
        }
        if (method === 'Page.fileChooserOpened') return fileChooser;
        return {};
      },
      onEvent: { addListener: (h) => listeners.push(h), removeListener: (h) => { const i = listeners.indexOf(h); if (i >= 0) listeners.splice(i, 1); } },
    },
  };
  return { chrome, calls, listeners };
}

const DEFAULT_FRAMES = {
  0: { url: 'http://a.test/', name: '', title: 'T0', content: 'main body' },
  3: { url: 'http://b.test/', name: '', title: 'T3', content: 'sub body' },
};

function setup(opts = {}) {
  if (!opts.frames) opts = { ...opts, frames: DEFAULT_FRAMES };
  const { chrome, calls, listeners } = makeChrome(opts);
  const runInRefFrame = async (tabId, parsed, func, args) => {
    if (opts.missingFrames?.has(parsed.frameId)) return undefined;
    return (opts.refFrameResult?.(parsed, func, args)) ?? { tag: 'input', isFile: true };
  };
  const getElemCoords = async () => ({ x: 10, y: 20 });
  const frameContexts = new Map();
  if (opts.contexts) frameContexts.set(opts.contexts.tabId, opts.contexts.list);
  const tools = createPageTools({
    chrome, ok, err,
    ensureCdp: async () => {},
    ensureCs: async () => {},
    runInRefFrame, getElemCoords,
    sleep: async () => {},
    frameContexts,
  });
  return { tools, calls, listeners };
}

// ── javascript_tool（C 批修复后走 CDP Runtime.evaluate，绕开页面 CSP）────────

test('主 frame：不带 contextId 调用 Runtime.evaluate，表达式用括号包装', async () => {
  const t = setup({ evalResult: { result: { value: 'main' } } });
  const r = await t.tools.toolJavascript({ tabId: 1, text: "'a'+1" });
  assert.equal(r.isError, undefined);
  assert.equal(text(r), 'main');
  const ev = t.calls.find(c => c.method === 'Runtime.evaluate');
  assert.equal(ev.params.expression, "('a'+1)");
  assert.equal(ev.params.contextId, undefined);
});

test('语句形式包成 async IIFE', async () => {
  const t = setup({ evalResult: { result: { value: 3 } } });
  await t.tools.toolJavascript({ tabId: 1, text: 'const x = 3; return x;' });
  const ev = t.calls.find(c => c.method === 'Runtime.evaluate');
  assert.match(ev.params.expression, /^\(async function\(\)\{const x = 3; return x;\}\)\(\)$/);
});

test('frameId 经 CDP id 映射后取该 frame 的主世界上下文（isDefault）', async () => {
  const t = setup({
    evalResult: { result: { value: 'in-f3' } },
    contexts: { tabId: 1, list: [
      { id: 11, frameId: 'MAIN', isDefault: true, name: '' },
      { id: 33, frameId: 'CDP-3', isDefault: true, name: '' },
      { id: 34, frameId: 'CDP-3', isDefault: false, name: 'ext' },
    ] },
  });
  const r = await t.tools.toolJavascript({ tabId: 1, frameId: 3, text: 'location.href' });
  assert.equal(text(r), 'in-f3');
  const ev = t.calls.find(c => c.method === 'Runtime.evaluate');
  assert.equal(ev.params.contextId, 33);
});

test('数字 frameId 映射不到 CDP id 时报 Frame not found', async () => {
  const t = setup({ evalResult: { result: { value: 'x' } } });
  const r = await t.tools.toolJavascript({ tabId: 1, frameId: 9, text: '1' });
  assert.equal(r.isError, true);
  assert.match(text(r), /Frame f9 not found/);
});

test('无已知上下文时退回 createIsolatedWorld 并在该上下文求值', async () => {
  const t = setup({ evalResult: { result: { value: 'iso' } } });
  const r = await t.tools.toolJavascript({ tabId: 1, frameId: 3, text: '1' });
  assert.equal(text(r), 'iso');
  const iso = t.calls.find(c => c.method === 'Page.createIsolatedWorld');
  assert.deepEqual(iso.params.frameId, 'CDP-3');
  const ev = t.calls.find(c => c.method === 'Runtime.evaluate');
  assert.equal(ev.params.contextId, 9);
});

test('表达式语法错时用 async IIFE 重试（多语句片段）', async () => {
  let n = 0;
  const t = setup({ evalResult: (params) => {
    n++;
    if (params.expression.startsWith('(async function()')) return { result: { value: 'retried' } };
    return { exceptionDetails: { text: "SyntaxError: Unexpected token ';'" } };
  } });
  const r = await t.tools.toolJavascript({ tabId: 1, text: 'a(); b();' });
  assert.equal(text(r), 'retried');
  assert.equal(n, 2);
});

test('页面抛错时把错误作为工具错误返回（不再被吞）', async () => {
  const t = setup({ evalResult: { exceptionDetails: { exception: { description: 'ReferenceError: x is not defined' } } } });
  const r = await t.tools.toolJavascript({ tabId: 1, text: 'x' });
  assert.equal(r.isError, true);
  assert.match(text(r), /ReferenceError/);
});

// ── get_page_text ────────────────────────────────────────────────────────────

test('默认只取主 frame，格式与旧版一致', async () => {
  const t = setup({ frames: { 0: { url: 'http://m/', title: 'M', content: 'main body' }, 3: { url: 'http://s/', title: 'S', content: 'sub body' } } });
  const r = await t.tools.toolGetPageText({ tabId: 1 });
  assert.match(text(r), /^Title: M\nURL: http:\/\/m\/\n\nmain body/);
  assert.doesNotMatch(text(r), /sub body/);
});

test('allFrames 合并所有 frame，各段带标头', async () => {
  const t = setup({ frames: { 0: { url: 'http://m/', title: 'M', content: 'main body' }, 3: { url: 'http://s/', title: 'S', content: 'sub body' } } });
  const r = await t.tools.toolGetPageText({ tabId: 1, allFrames: true });
  assert.match(text(r), /main body/);
  assert.match(text(r), /Frame f3 \(http:\/\/s\/\):/);
  assert.match(text(r), /sub body/);
  assert.match(text(r), /2 frames merged/);
});

test('frameId 与 allFrames 互斥', async () => {
  const t = setup();
  const r = await t.tools.toolGetPageText({ tabId: 1, allFrames: true, frameId: 3 });
  assert.equal(r.isError, true);
  assert.match(text(r), /not both/);
});

test('frameId 定向提取，尾部带来源标识', async () => {
  const t = setup({ frames: { 3: { url: 'http://s/', title: 'S', content: 'only sub' } } });
  const r = await t.tools.toolGetPageText({ tabId: 1, frameId: 3 });
  assert.match(text(r), /only sub/);
  assert.match(text(r), /\(frame f3\)$/);
});

test('frame 不存在时明确报错', async () => {
  const t = setup({ frames: {} });
  const r = await t.tools.toolGetPageText({ tabId: 1, frameId: 9 });
  assert.equal(r.isError, true);
  assert.match(text(r), /Frame f9 not found/);
});

// ── file_upload（C 批修复后走 CDP objectId，天然支持子 frame）──────────────────

test('ref 带子 frame 前缀：映射 CDP frame → 上下文求值取 objectId → setFileInputFiles', async () => {
  const t = setup();
  const r = await t.tools.toolFileUpload({ tabId: 1, paths: ['/tmp/a.png'], ref: 'f3.ref_7' });
  assert.equal(r.isError, undefined);
  assert.match(text(r), /File\(s\) set on input f3\.ref_7/);
  const methods = t.calls.filter(c => c.kind === 'cdp').map(c => c.method);
  assert.ok(methods.includes('Page.getFrameTree'), '需要 CDP frame tree 做 id 映射');
  const set = t.calls.find(c => c.method === 'DOM.setFileInputFiles');
  assert.deepEqual(set.params, { files: ['/tmp/a.png'], objectId: 'obj-1' });
});

test('主 frame ref 也能设文件', async () => {
  const t = setup();
  const r = await t.tools.toolFileUpload({ tabId: 1, paths: ['/tmp/b.png'], ref: 'ref_2' });
  assert.equal(r.isError, undefined);
  assert.match(text(r), /File\(s\) set on input ref_2/);
});

test('ref 指向非文件输入时报错', async () => {
  const t = setup({ refFrameResult: () => ({ tag: 'button', isFile: false }) });
  const r = await t.tools.toolFileUpload({ tabId: 1, paths: ['/tmp/a'], ref: 'ref_2' });
  assert.equal(r.isError, true);
  assert.match(text(r), /is <button>, not an input\[type=file\]/);
});

test('目标 frame 映射不到 CDP id 时报 Element not found', async () => {
  const t = setup({ frameTree: { frameTree: { frame: { id: 'MAIN', url: 'http://a.test/', name: '' } } } });
  const r = await t.tools.toolFileUpload({ tabId: 1, paths: ['/tmp/a'], ref: 'f99.ref_1' });
  assert.equal(r.isError, true);
  assert.match(text(r), /Element not found: f99\.ref_1/);
});

test('ref 在已消失的 frame 里时报错', async () => {
  const t = setup({ missingFrames: new Set([3]) });
  const r = await t.tools.toolFileUpload({ tabId: 1, paths: ['/tmp/a'], ref: 'f3.ref_7' });
  assert.equal(r.isError, true);
  assert.match(text(r), /Element not found: f3\.ref_7/);
});

test('triggerRef 子 frame：点击坐标 → fileChooserOpened.backendNodeId → 设文件', async () => {
  const t = setup({ fileChooser: { backendNodeId: 555 } });
  const p = t.tools.toolFileUpload({ tabId: 1, paths: ['/tmp/b.png'], triggerRef: 'f3.ref_2' });
  setTimeout(() => {
    t.listeners.forEach(h => h({ tabId: 1 }, 'Page.fileChooserOpened', { backendNodeId: 555 }));
  }, 10);
  const r = await p;
  assert.equal(r.isError, undefined);
  assert.match(text(r), /uploaded via f3\.ref_2/);
  const set = t.calls.find(c => c.method === 'DOM.setFileInputFiles');
  assert.deepEqual(set.params, { files: ['/tmp/b.png'], backendNodeId: 555 });
  const methods = t.calls.filter(c => c.kind === 'cdp').map(c => c.method);
  assert.ok(methods.includes('Page.setInterceptFileChooserDialog'));
  assert.ok(methods.includes('Input.dispatchMouseEvent'));
});

test('必填校验：缺 paths / 缺 ref 与 triggerRef', async () => {
  const t = setup();
  assert.equal((await t.tools.toolFileUpload({ tabId: 1 })).isError, true);
  assert.match(text(await t.tools.toolFileUpload({ tabId: 1, paths: ['/a'] })), /Provide ref/);
});
