// javascript_tool / get_page_text / file_upload 的胶水实现（C 批从 background.js 搬迁并补齐 frame 支持）。
// 依赖（chrome、ok、err、ensureCdp、ensureCs、parseRef、runInRefFrame、collectFrameInfos、resolveFrameOffset、toTopPoint、sleep）
// 通过参数注入；坐标换算复用 A 批的跨 frame 握手（getElemCoords 由 background 传入）。

import { formatJsResult, truncateResult, MAX_CODE_CHARS, wrapExpression, pickContextId } from '../lib/js-tool.js';
import { mergeFrameTexts, formatSingleFrameText } from '../lib/page-text.js';
import { parseRef, flattenFrameTree, buildFrameIdMap } from '../lib/frames.js';

export function createPageTools({ chrome, ok, err, ensureCdp, ensureCs, runInRefFrame, getElemCoords, sleep, frameContexts }) {
  const send = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

  const frameNotFound = (frameId) =>
    `Frame f${frameId} not found on this tab. The page may have navigated; run read_page or find again to get current frame refs.`;

  /**
   * 数字 frameId（ref 前缀用的 chrome.scripting 体系）→ CDP frameId（字符串体系）。
   * 两套 id 互不相通：Runtime 执行上下文与 Page/DOM 命令只认 CDP 的。
   * 用「各 frame 的 location.href + window.name」与 Page.getFrameTree 配对。
   * 主 frame 固定为主树根，返回 null 表示找不到该 frame。
   */
  async function toCdpFrameId(tabId, frameId) {
    const { frameTree } = await send(tabId, 'Page.getFrameTree');
    if (frameId === 0) return frameTree?.frame?.id ?? null;
    const cdpFrames = flattenFrameTree(frameTree);
    const injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({ url: location.href, name: window.name || '' }),
    }).catch(() => []);
    const extFrames = injected.filter((r) => r.result).map((r) => ({ frameId: r.frameId, ...r.result }));
    return buildFrameIdMap(extFrames, cdpFrames).get(frameId) ?? null;
  }

  /**
   * 取某个 CDP frame 的主世界执行上下文 id（用于在该 frame 里跑 JS / 解析 DOM）。
   * 优先用 Runtime.executionContext* 跟踪到的主世界上下文；没有则为该 frame 开一个隔离世界。
   * 隔离世界与页面世界隔离，读不到页面变量，但 DOM 是共享的（元素、属性可见）。
   */
  async function contextForFrame(tabId, cdpFrameId) {
    const known = pickContextId(frameContexts.get(tabId) ?? [], cdpFrameId);
    if (known != null) return known;
    try {
      const world = await send(tabId, 'Page.createIsolatedWorld', { frameId: cdpFrameId, grantUniveralAccess: false });
      return world?.executionContextId ?? null;
    } catch {
      return null;
    }
  }

  // ── javascript_tool ──────────────────────────────────────────────────────────
  // 走 CDP Runtime.evaluate 而非 content script 注入：页面自己声明 CSP 时
  // executeScript 内的 eval 会被 script-src 拦下（'unsafe-eval' 不在白名单），
  // 而调试协议的求值不受页面 CSP 约束——DevTools 控制台同款通道。
  // 主 frame 省略 contextId 用默认上下文；子 frame 用跟踪到的该 frame 主世界上下文。
  async function toolJavascript(args) {
    const { tabId, text } = args;
    if (!tabId) return err('tabId required');
    if (!text) return err('text required');
    if (text.length > MAX_CODE_CHARS) return err(`Code too long (max ${MAX_CODE_CHARS} chars)`);
    if (args.frameId !== undefined && !Number.isInteger(args.frameId)) return err('frameId must be an integer');
    const frameId = Number.isInteger(args.frameId) ? args.frameId : 0;
    await ensureCdp(tabId);

    let contextId;
    if (frameId !== 0) {
      const cdpFrameId = await toCdpFrameId(tabId, frameId);
      if (cdpFrameId == null) return err(frameNotFound(frameId));
      contextId = await contextForFrame(tabId, cdpFrameId);
      if (contextId == null) return err(frameNotFound(frameId));
    }

    const evalParams = { expression: wrapExpression(text), returnByValue: true, awaitPromise: true };
    if (contextId !== undefined) evalParams.contextId = contextId;
    let res = await send(tabId, 'Runtime.evaluate', evalParams);
    // 多语句片段常不以语句关键字开头（如 "a(); b();"），按表达式解析会 SyntaxError。
    // 与旧实现一致：语法错时改用 async IIFE 重试一次。
    if (res?.exceptionDetails && /SyntaxError/.test(res.exceptionDetails.text || res.exceptionDetails.exception?.description || '')) {
      res = await send(tabId, 'Runtime.evaluate', {
        expression: `(async function(){${text}})()`, returnByValue: true, awaitPromise: true,
        ...(contextId !== undefined ? { contextId } : {}),
      });
    }
    if (res?.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'JS error';
      return err(msg);
    }
    return ok([{ type: 'text', text: truncateResult(formatJsResult(res?.result?.value)) }]);
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
      const cdpFrameId = await toCdpFrameId(tabId, parsed.frameId);
      if (cdpFrameId == null) return err(`Element not found: ${ref}. The frame may have navigated; run read_page or find again.`);

      // 在目标 frame 的主世界上下文里把元素转成 CDP objectId；
      // DOM.setFileInputFiles 认 objectId，天然支持子 frame（不受 DOM 域与主 frame 限制）。
      let contextId = await contextForFrame(tabId, cdpFrameId);
      // 元素引用只存在于内容脚本世界，取对象要在其所在上下文求值：
      // __accessibilityTree 是内容脚本注入的，用 executeScript 在目标 frame 拿到 element，
      // 再由 CDP 在该 frame 的上下文里按选择器重新解析。
      const info = await runInRefFrame(tabId, parsed,
        (r) => {
          const el = globalThis.__accessibilityTree?.getElementByRef(r);
          if (!el) return null;
          const tag = el.tagName.toLowerCase();
          if (tag !== 'input' || (el.getAttribute('type') || '').toLowerCase() !== 'file') {
            return { tag, isFile: false };
          }
          el.setAttribute('data-bmcp-upload', '1');
          return { tag, isFile: true };
        },
        [parsed.ref]);
      if (!info) return err(`Element not found: ${ref}. The frame may have navigated; run read_page or find again.`);
      if (!info.isFile) return err(`Element ${ref} is <${info.tag}>, not an input[type=file].`);

      try {
        const evalParams = {
          expression: 'document.querySelector("input[type=file][data-bmcp-upload]")',
          returnByValue: false,
        };
        if (contextId != null) evalParams.contextId = contextId;
        const found = await send(tabId, 'Runtime.evaluate', evalParams);
        if (found?.exceptionDetails) {
          return err(found.exceptionDetails.exception?.description || 'Failed to resolve the file input');
        }
        const objectId = found?.result?.objectId;
        if (!objectId) return err(`Could not resolve file input ${ref} in its frame`);
        await send(tabId, 'DOM.setFileInputFiles', { files: paths, objectId });
      } finally {
        await runInRefFrame(tabId, parsed,
          () => { document.querySelector('[data-bmcp-upload]')?.removeAttribute('data-bmcp-upload'); },
          []).catch(() => {});
      }
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
