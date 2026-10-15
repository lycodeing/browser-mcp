// javascript_tool / get_page_text / file_upload 的胶水实现（C 批从 background.js 搬迁并补齐 frame 支持）。
// 依赖（chrome、ok、err、ensureCdp、ensureCs、parseRef、runInRefFrame、collectFrameInfos、resolveFrameOffset、toTopPoint、sleep）
// 通过参数注入；坐标换算复用 A 批的跨 frame 握手（getElemCoords 由 background 传入）。

import { formatJsResult, truncateResult, MAX_CODE_CHARS } from '../lib/js-tool.js';
import { mergeFrameTexts, formatSingleFrameText } from '../lib/page-text.js';
import { parseRef } from '../lib/frames.js';

export function createPageTools({ chrome, ok, err, ensureCdp, ensureCs, runInRefFrame, getElemCoords, sleep }) {
  const send = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

  const frameNotFound = (frameId) =>
    `Frame f${frameId} not found on this tab. The page may have navigated; run read_page or find again to get current frame refs.`;

  // ── javascript_tool ──────────────────────────────────────────────────────────
  // 页面函数与旧实现同构：语句关键字探测 + 表达式包装，省一次失败 eval。
  // 经 executeScript 序列化注入，必须自包含。
  const JS_PAGE_FUNC = (code) => {
    const isStmt = /^(const|let|var|function|class|if|for|while|switch|try|throw|return|do|export|import)\b/.test(code.trim());
    try {
      if (!isStmt) return { ok: true, v: (0, eval)(`(${code})`) };
      (0, eval)(code); return { ok: true, v: undefined };
    } catch (e) { return { ok: false, e: e.message }; }
  };

  async function toolJavascript(args) {
    const { tabId, text } = args;
    if (!tabId) return err('tabId required');
    if (!text) return err('text required');
    if (text.length > MAX_CODE_CHARS) return err(`Code too long (max ${MAX_CODE_CHARS} chars)`);
    const frameId = Number.isInteger(args.frameId) ? args.frameId : 0;
    if (args.frameId !== undefined && !Number.isInteger(args.frameId)) return err('frameId must be an integer');
    await ensureCdp(tabId);

    // 主路径：scripting API 定向到目标 frame
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: JS_PAGE_FUNC,
        args: [text],
      });
      const res = results[0]?.result;
      if (!res) return err(frameNotFound(frameId));
      // 页面 eval 的错误直接透传；兜底只服务"注入本身被拒"的场景
      if (res.ok === false) return err(res.e);
      return ok([{ type: 'text', text: truncateResult(formatJsResult(res.v)) }]);
    } catch (e) {
      if (e instanceof RangeError || /frame/i.test(e.message || '')) return err(frameNotFound(frameId));
      // CDP 兜底：受限页面 executeScript 被拒时走 isolated world。
      // isolated world 与页面世界隔离，读不到页面变量——仅作兜底，已知限制。
      let contextId;
      try {
        const world = await send(tabId, 'Page.createIsolatedWorld', { frameId });
        contextId = world?.executionContextId;
      } catch { /* 旧的通用报错路径 */ }
      if (contextId == null) throw e;
      const cdpRes = await send(tabId, 'Runtime.evaluate',
        { expression: `(${text})`, returnByValue: true, awaitPromise: true, contextId });
      if (cdpRes.exceptionDetails) {
        const msg = cdpRes.exceptionDetails.exception?.description || cdpRes.exceptionDetails.text;
        if (/SyntaxError/.test(msg)) {
          const stmtRes = await send(tabId, 'Runtime.evaluate',
            { expression: `(async function(){${text}})()`, returnByValue: true, awaitPromise: true, contextId });
          if (stmtRes.exceptionDetails) throw new Error(stmtRes.exceptionDetails.exception?.description || 'JS error');
          return ok([{ type: 'text', text: formatJsResult(stmtRes.result?.value) }]);
        }
        throw new Error(msg);
      }
      return ok([{ type: 'text', text: formatJsResult(cdpRes.result?.value) }]);
    }
  }

  // ── get_page_text ────────────────────────────────────────────────────────────
  async function toolGetPageText(args) {
    const tabId = args.tabId;
    if (!tabId) return err('tabId required');
    const maxChars = args.max_chars || 50000;
    if (args.allFrames && args.frameId !== undefined) {
      return err('Pass either frameId (one frame) or allFrames:true (merge every frame), not both');
    }
    await ensureCs(tabId);

    const pageFunc = (max) => {
      const b = globalThis.__pageBridge;
      return b ? b.getPageText(max) : { error: 'Page bridge not available' };
    };

    if (args.allFrames) {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, func: pageFunc, args: [maxChars],
      });
      const frames = results.filter((r) => r.result && !r.result.error).map((r) => ({ frameId: r.frameId, ...r.result }));
      const merged = mergeFrameTexts(frames, maxChars);
      if (!merged.frameCount) return err(results[0]?.result?.error || 'No text content found in any frame');
      const trunc = merged.truncated ? '\n(truncated — increase max_chars or use frameId)' : '';
      return ok([{ type: 'text', text: `${merged.body}\n(${merged.frameCount} frame${merged.frameCount === 1 ? '' : 's'} merged)${trunc}` }]);
    }

    const frameId = Number.isInteger(args.frameId) ? args.frameId : 0;
    if (args.frameId !== undefined && !Number.isInteger(args.frameId)) return err('frameId must be an integer');
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] }, func: pageFunc, args: [maxChars],
    });
    const res = results[0]?.result;
    if (!res || res.error) {
      return err(res?.error === 'Page bridge not available' ? 'Page bridge not available' : frameNotFound(frameId));
    }
    const { text } = formatSingleFrameText({ ...res, frameId });
    return ok([{ type: 'text', text }]);
  }

  // ── file_upload ──────────────────────────────────────────────────────────────
  // ref 路径：DOM.performSearch 是跨 frame 的全局搜索（DevTools 元素面板同款机制），
  // 拿 nodeId 后 DOM.setFileInputFiles；triggerRef 路径：点击坐标复用跨 frame 握手，
  // fileChooserOpened 的 backendNodeId 本就 frame 无关。
  async function toolFileUpload(args) {
    const { tabId, paths, ref, triggerRef } = args;
    if (!tabId) return err('tabId required');
    if (!paths?.length) return err('paths required');
    await ensureCdp(tabId);

    if (ref) {
      const parsed = parseRef(ref);
      if (!parsed) return err(`Invalid ref: ${ref}. Run read_page or find to get a valid ref.`);
      await ensureCs(tabId);
      // 目标 frame 里确认元素还在（runInRefFrame 对不存在的 frame 返回 undefined）
      const present = await runInRefFrame(tabId, parsed,
        (r) => {
          const el = globalThis.__accessibilityTree?.getElementByRef(r);
          return el ? { tag: el.tagName } : null;
        },
        [parsed.ref]);
      if (!present) {
        return err(`Element not found: ${ref}. The frame may have navigated; run read_page or find again.`);
      }
      if ((present.tag || '').toLowerCase() !== 'input') {
        return err(`Element ${ref} is <${present.tag?.toLowerCase() || 'unknown'}>, not an input. Use a ref of input[type=file].`);
      }
      const token = `bmcp-${Date.now()}`;
      await runInRefFrame(tabId, parsed,
        (r, t, attr) => {
          const el = globalThis.__accessibilityTree?.getElementByRef(r);
          if (el) el.setAttribute(attr, t);
        },
        [parsed.ref, token, 'data-bmcp-token']);
      let nodeId;
      let searchId;
      try {
        const found = await send(tabId, 'DOM.performSearch',
          { query: `input[type="file"][data-bmcp-token="${token}"]` });
        searchId = found?.searchId;
        if (found?.resultCount !== 1) return err(`Expected exactly 1 file input for ${ref}, found ${found?.resultCount ?? 0}`);
        const res = await send(tabId, 'DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: 1 });
        nodeId = res?.nodeIds?.[0];
      } finally {
        if (searchId !== undefined) await send(tabId, 'DOM.discardSearchResults', { searchId }).catch?.(() => {});
        await runInRefFrame(tabId, parsed,
          (attr) => { document.querySelector(`[${attr}]`)?.removeAttribute(attr); },
          ['data-bmcp-token']).catch(() => {});
      }
      if (!nodeId) return err(`Could not locate file input for ${ref} in the DOM`);
      await send(tabId, 'DOM.setFileInputFiles', { files: paths, nodeId });
      return ok([{ type: 'text', text: `File(s) set on input ${ref}: ${paths.join(', ')}` }]);
    }

    if (triggerRef) {
      const parsed = parseRef(triggerRef);
      if (!parsed) return err(`Invalid ref: ${triggerRef}. Run read_page or find to get a valid ref.`);
      await send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
      try {
        await ensureCs(tabId);
        const c = await getElemCoords(tabId, triggerRef);
        if (!c) return err(`Trigger element not found: ${triggerRef}`);
        const { x, y } = c;
        await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await sleep(50);
        await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await sleep(50);
        await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });

        const chooser = await new Promise((resolve, reject) => {
          const tid = setTimeout(() => {
            chrome.debugger.onEvent.removeListener(h);
            reject(new Error('File chooser timeout'));
          }, 5000);
          function h(src, method, params) {
            if (src.tabId === tabId && method === 'Page.fileChooserOpened') {
              clearTimeout(tid); chrome.debugger.onEvent.removeListener(h); resolve(params);
            }
          }
          chrome.debugger.onEvent.addListener(h);
        });
        if (!chooser.backendNodeId) return err('File chooser opened without target input');
        await send(tabId, 'DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId });
        return ok([{ type: 'text', text: `File(s) uploaded via ${triggerRef}: ${paths.join(', ')}` }]);
      } finally {
        await send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
      }
    }

    return err('Provide ref (input[type=file]) or triggerRef (upload button)');
  }

  return { toolJavascript, toolGetPageText, toolFileUpload };
}
