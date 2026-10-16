// background.js — browser-mcp Service Worker
// Connects to local relay via WebSocket and executes CDP tool calls

import { createTabQueue, TabBusyError } from './lib/tab-queue.js';
import { withTimeout } from './lib/timeout.js';
import { normalizeUrl } from './lib/url.js';
import { createTabsTool } from './tools/tabs.js';
import { tabNotFoundMessage } from './lib/tabs.js';
import { createNetworkStore } from './lib/network.js';
import { createNetworkTool } from './tools/network.js';
import { createEmulateTool } from './tools/emulate.js';
import { createStorageTool } from './tools/storage.js';
import { createInterceptStore } from './lib/intercept.js';
import { createInterceptTools } from './tools/intercept.js';
import { createPageTools } from './tools/page-tools.js';
import {
  parseRef, mergeFrameTrees, mergeFindResults, formatFindLines, resolveFrameOffset, toTopPoint,
} from './lib/frames.js';

// ── Constants ────────────────────────────────────────────────────────────────
const RELAY_URL = 'ws://127.0.0.1:16789';
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
const TOOL_TIMEOUT = 60000;
const tabQueue = createTabQueue({ waitMs: 30000 });

// ── State ────────────────────────────────────────────────────────────────────
let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let stopped = false;

// tabId -> { console: [], network: [] }
const tabEventBuffers = new Map();
// tabId -> true  (CDP attached + domains enabled)
const cdpReady = new Set();
// tabId -> 'accept' | 'dismiss' | 'manual' (JS dialog policy, set during a tool call)
const dialogModes = new Map();

// ── WebSocket connection ──────────────────────────────────────────────────────
function connect() {
  if (stopped) return;
  try {
    ws = new WebSocket(RELAY_URL);
  } catch (e) {
    scheduleReconnect(); return;
  }
  ws.onopen = () => {
    console.log('[browser-mcp] Connected to relay');
    reconnectAttempt = 0;
    // announce ourselves
    sendMsg({
      method: 'extensionInfo',
      params: {
        extensionVersion: chrome.runtime.getManifest().version,
        browserType: navigator.userAgent.includes('Edg') ? 'edge' : 'chrome',
        capabilities: ['mcp-tools', 'content-scripts'],
      },
    });
  };
  ws.onmessage = (ev) => handleMessage(ev.data);
  ws.onclose = () => {
    ws = null;
    if (!stopped) scheduleReconnect();
  };
  ws.onerror = () => { ws = null; };
}

function scheduleReconnect() {
  if (reconnectTimer !== null || stopped) return;
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function sendMsg(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── CDP helpers ───────────────────────────────────────────────────────────────
// 页面重载（如点击后跳转的登录页）期间 attach 可能被 Chrome 短暂拒绝，
// 报 "Cannot access a chrome-extension:// URL of different extension"，数秒内自行恢复。
const ATTACH_RETRY_DELAYS = [200, 600, 1500];

async function cdpAttachOnce(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch {}
  await chrome.debugger.attach({ tabId }, '1.3');
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
}

async function cdpAttach(tabId) {
  if (cdpReady.has(tabId)) return;
  let lastErr;
  for (let i = 0; i <= ATTACH_RETRY_DELAYS.length; i++) {
    try {
      await cdpAttachOnce(tabId);
      cdpReady.add(tabId);
      return;
    } catch (e) {
      lastErr = e;
      try { await chrome.debugger.detach({ tabId }); } catch {}
      if (i < ATTACH_RETRY_DELAYS.length) await sleep(ATTACH_RETRY_DELAYS[i]);
    }
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  throw new Error(
    `CDP attach failed after ${ATTACH_RETRY_DELAYS.length + 1} attempts `
    + `(tab ${tabId}, ${tab?.url || 'unknown url'}, status ${tab?.status || 'unknown'}): ${lastErr?.message}. `
    + 'Tools that need the debugger (computer, javascript_tool, read_console_messages, network) are unavailable on this tab right now; '
    + 'read_page, find, form_input and get_page_text do not use it and still work. '
    + 'Do not resend the identical call: wait a few seconds, open a fresh tab via tabs (action create), or navigate again.'
  );
}

async function cdpDetach(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch {}
  cdpReady.delete(tabId);
}

// chrome.tabs.get 对不存在 id 抛 "No tab with id: N" 且不带任何上下文，
// 调用方（模型）常拿猜测的短编号重试。这里统一包一层：附上当前标签列表与正确获取方式。
async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    const tabs = await chrome.tabs.query({}).catch(() => []);
    throw new Error(tabNotFoundMessage(tabId, tabs));
  }
}

async function ensureCdp(tabId) {
  if (cdpReady.has(tabId)) return;
  const tab = await getTab(tabId);
  const url = tab.url || '';
  if (/^(chrome|chrome-extension|devtools|about|edge):/.test(url))
    throw new Error(`Cannot attach CDP to restricted URL: ${url}`);
  await cdpAttach(tabId);
}

// 内容脚本自带幂等守卫，每次调用对所有 frame 注入即可；新出现的 iframe 在下一次调用时被覆盖
async function ensureCs(tabId) {
  await getTab(tabId); // 不存在的 tabId 提前失败并附标签列表，而不是注入报无上下文的错
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content-scripts/accessibility-tree.js', 'content-scripts/page-bridge.js',
            'content-scripts/frame-link.js'],
  });
}

const refNotFound = (refStr) => parseRef(refStr)?.frameId
  ? `Element not found: ${refStr}. The frame may have navigated; run read_page or find again.`
  : `Element not found: ${refStr}`;

// 在 ref 所属的 frame 里执行；frame 已不存在时返回 undefined
async function runInRefFrame(tabId, parsed, func, args) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [parsed.frameId] }, func, args,
    });
    return r?.result;
  } catch {
    return undefined;
  }
}

// 所有 frame 先握手再采集：父 frame 的 children 要等子 frame 的 hello 到达后才完整
async function collectFrameInfos(tabId) {
  const target = { tabId, allFrames: true };
  await chrome.scripting.executeScript({
    target, func: async () => { await globalThis.__frameLink?.link(); },
  });
  const results = await chrome.scripting.executeScript({
    target, func: () => globalThis.__frameLink?.collect() ?? null,
  });
  return results.filter((r) => r.result).map((r) => ({ ...r.result, frameId: r.frameId }));
}

async function searchAllFrames(tabId, query, max) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (q, m) => globalThis.__pageBridge?.searchElements(q, m) ?? [],
    args: [query, max],
  });
  return results.map((r) => ({ frameId: r.frameId, items: r.result || [] }));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tabBuf(tabId) {
  if (!tabEventBuffers.has(tabId)) tabEventBuffers.set(tabId, { console: [], network: createNetworkStore({ capacity: 1000 }), dialogs: [] });
  const buf = tabEventBuffers.get(tabId);
  if (!buf.dialogs) buf.dialogs = [];
  return buf;
}

// ── JS dialog policy ─────────────────────────────────────────────────────────
// 工具调用期间设置策略（默认 accept 防止弹窗挂死 CDP 会话），manual 时挂起待
// handle_dialog 显式应答。弹窗事件记录进 tab 缓冲并追加到工具结果。

function setDialogMode(tabId, args) {
  dialogModes.set(tabId, args?.dialog || 'accept');
  return Date.now();
}

function clearDialogMode(tabId) {
  dialogModes.delete(tabId);
}

function appendDialogNotes(tabId, sinceTs, result) {
  if (!result?.content) return result;
  const notes = (tabBuf(tabId).dialogs || [])
    .filter(d => d.ts >= sinceTs)
    .map(d => `dialog[${d.type}] ${d.answered ? 'auto-answered' : 'PENDING (use handle_dialog)'}: "${d.message}"`);
  if (notes.length) result.content.push({ type: 'text', text: notes.join('\n') });
  return result;
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

const KEY_MAP = {
  enter:'Enter',return:'Enter',esc:'Escape',escape:'Escape',tab:'Tab',
  backspace:'Backspace',delete:'Delete',del:'Delete',insert:'Insert',ins:'Insert',
  home:'Home',end:'End',pageup:'PageUp',pagedown:'PageDown',
  up:'ArrowUp',down:'ArrowDown',left:'ArrowLeft',right:'ArrowRight',
  space:' ',spacebar:' ',ctrl:'Control',control:'Control',alt:'Alt',
  shift:'Shift',cmd:'Meta',command:'Meta',meta:'Meta',win:'Meta',
};
const VK = {Enter:13,Escape:27,Tab:9,Backspace:8,Delete:46,Insert:45,
  Home:36,End:35,PageUp:33,PageDown:34,ArrowUp:38,ArrowDown:40,
  ArrowLeft:37,ArrowRight:39,' ':32,Control:17,Alt:18,Shift:16,Meta:91};

function parseMods(s) {
  if (!s) return 0;
  let m = 0;
  for (const p of s.toLowerCase().split('+').map(x=>x.trim())) {
    if (p==='alt') m|=1;
    else if (p==='ctrl'||p==='control') m|=2;
    else if (p==='meta'||p==='cmd'||p==='command') m|=4;
    else if (p==='shift') m|=8;
  }
  return m;
}

// 图片 token 只取决于像素数，与字节数无关：输出统一缩放到 CSS 像素尺寸并限制长边，
// 避免高 DPR 屏返回 2~3 倍像素被模型服务端二次缩小。质量只影响传输体积。
const SCREENSHOT_QUALITY = { low: 45, medium: 65, high: 85 };
const DEFAULT_MAX_DIMENSION = 1280;
const SOURCE_QUALITY = 92;
const MAX_FULLPAGE_CSS_HEIGHT = 20000;

// tabId -> 最近一次视口截图的缩放比（截图像素 / CSS 像素）。
// 模型按截图像素给出坐标，点击类动作据此换算回页面 CSS 像素。
const shotScale = new Map();

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// basis 为期望输出的基准尺寸（CSS 像素），缺省时以位图自身像素为基准；
// 长边超过 maxDim 时等比缩小，不放大。
async function rescaleImage(base64, srcMime, { basis, maxDim, format, quality }) {
  const src = await (await fetch(`data:${srcMime};base64,${base64}`)).blob();
  const bmp = await createImageBitmap(src);
  const bw = basis?.w ?? bmp.width, bh = basis?.h ?? bmp.height;
  const k = Math.min(1, maxDim / Math.max(bw, bh), bmp.width / bw, bmp.height / bh);
  const width = Math.max(1, Math.round(bw * k));
  const height = Math.max(1, Math.round(bh * k));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (format !== 'png') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const out = await canvas.convertToBlob({
    type: `image/${format}`,
    ...(format !== 'png' && { quality: quality / 100 }),
  });
  return { data: await blobToBase64(out), width, height };
}

// opts: { quality: preset|1-100, format: 'jpeg'|'webp'|'png', fullPage, maxDimension,
//         region: 截图坐标系下已换算为 CSS 像素的矩形，输出保留区域原生清晰度 }
// 返回 scale = 输出像素 / CSS 像素（region 时为 null）
async function captureScreenshot(tabId, opts = {}) {
  const format = opts.format || 'jpeg';
  const quality = typeof opts.quality === 'number'
    ? opts.quality : (SCREENSHOT_QUALITY[opts.quality] ?? SCREENSHOT_QUALITY.medium);
  const maxDim = Math.min(opts.maxDimension || DEFAULT_MAX_DIMENSION, 8000);
  const isRegion = !!opts.region;
  const fullPage = !!opts.fullPage && !isRegion;

  let clip, cssW, cssH;
  if (isRegion) {
    const [x0, y0, x1, y1] = opts.region;
    clip = { x: Math.min(x0, x1), y: Math.min(y0, y1),
      width: Math.max(1, Math.abs(x1 - x0)), height: Math.max(1, Math.abs(y1 - y0)), scale: 1 };
  } else {
    if (fullPage) {
      const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics').catch(() => null);
      const cs = metrics?.cssContentSize || metrics?.contentSize;
      cssW = Math.ceil(cs?.width || 1280);
      cssH = Math.min(Math.ceil(cs?.height || 720), MAX_FULLPAGE_CSS_HEIGHT);
    } else {
      let vp;
      try {
        [vp] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({ w: window.innerWidth, h: window.innerHeight }),
        });
      } catch { vp = null; }
      cssW = vp?.result?.w || 1280;
      cssH = vp?.result?.h || 720;
    }
    // 在浏览器侧先按目标比例缩小再截取，避免高 DPR 下生成巨大位图
    clip = { x: 0, y: 0, width: cssW, height: cssH, scale: Math.min(1, maxDim / Math.max(cssW, cssH)) };
  }

  const srcFormat = format === 'png' ? 'png' : 'jpeg';
  const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
    format: srcFormat,
    ...(srcFormat === 'jpeg' && { quality: SOURCE_QUALITY }),
    captureBeyondViewport: fullPage,
    fromSurface: true,
    clip,
  });

  const { data, width, height } = await rescaleImage(res.data, `image/${srcFormat}`, {
    basis: isRegion ? null : { w: cssW, h: cssH },
    maxDim, format, quality,
  });
  return { data, width, height, format, fullPage, scale: isRegion ? null : width / cssW };
}

// 模型基于截图像素给出坐标，换算回页面 CSS 像素；未截图或无缩放时原样返回
function toCss(tabId, pt) {
  const s = shotScale.get(tabId) || 1;
  return s === 1 ? pt : [pt[0] / s, pt[1] / s];
}

// ref 所在 frame 内的坐标加上沿 frame 链的偏移，得到顶层视口坐标；找不到返回 null
async function getElemCoords(tabId, refStr) {
  const parsed = parseRef(refStr);
  if (!parsed) return null;
  const pt = await runInRefFrame(tabId, parsed,
    (ref) => globalThis.__accessibilityTree?.getElementCoordinates(ref, { scrollIntoView: true }) ?? null,
    [parsed.ref]);
  if (!pt) return null;
  if (!parsed.frameId) return pt;
  // 滚动发生在 getElementCoordinates 之后，偏移必须此刻现读
  const off = resolveFrameOffset(parsed.frameId, await collectFrameInfos(tabId));
  if (!off) throw new Error(`Cannot locate frame f${parsed.frameId} in the page (frame handshake incomplete). Run read_page again and retry.`);
  const [x, y] = toTopPoint(off, [pt.x, pt.y]);
  return { x: Math.round(x), y: Math.round(y) };
}

async function toolComputer(args) {
  const {action, tabId} = args;
  if (!tabId) return err('tabId is required');
  await ensureCdp(tabId);
  const t0 = setDialogMode(tabId, args);
  let result;
  try {
    result = await computerDispatch(args, tabId, action);
  } finally {
    clearDialogMode(tabId);
  }
  return appendDialogNotes(tabId, t0, result);
}

async function computerDispatch(args, tabId, action) {
  switch(action) {
    case 'screenshot': {
      await sleep(50);
      const { data, width, height, format, fullPage, scale } = await captureScreenshot(tabId, {
        quality: args.quality, format: args.format,
        fullPage: args.fullPage, maxDimension: args.maxDimension,
      });
      // 全页截图的坐标无法对应视口点击，不更新换算比例
      if (!fullPage) shotScale.set(tabId, scale);
      const note = !fullPage && scale < 1
        ? ` (page scaled ${scale.toFixed(2)}x; pass coordinates in this image's pixels)` : '';
      return ok([{type:'text',text:`Screenshot ${width}x${height}${note}`},{type:'image',data,mimeType:`image/${format}`}]);
    }
    case 'wait': {
      await sleep(Math.min((args.duration||1),10)*1000);
      return ok([{type:'text',text:`Waited ${args.duration||1}s`}]);
    }
    case 'scroll': {
      const dir = args.scroll_direction||'down', n = Math.min(args.scroll_amount||3,10)*100;
      const dx = dir==='left'?-n:dir==='right'?n:0;
      const dy = dir==='up'?-n:dir==='down'?n:0;
      const [cx,cy] = args.coordinate ? toCss(tabId, args.coordinate) : [640,360];
      try {
        await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',
          {type:'mouseWheel',x:cx,y:cy,deltaX:dx,deltaY:dy});
      } catch {
        await chrome.scripting.executeScript({target:{tabId},
          func:(x,y,ddx,ddy)=>{
            let el=document.elementFromPoint(x,y);
            for(;el;el=el.parentElement){const s=getComputedStyle(el);if(/(auto|scroll)/.test(s.overflow+s.overflowY))break;}
            (el||window).scrollBy({left:ddx,top:ddy,behavior:'instant'});
          },args:[cx,cy,dx,dy]});
      }
      return ok([{type:'text',text:`Scrolled ${dir} ${n/100} ticks`}]);
    }
    case 'scroll_to': {
      if (!args.ref) return err('ref required for scroll_to');
      const parsed = parseRef(args.ref);
      if (!parsed) return err(refNotFound(args.ref));
      await ensureCs(tabId);
      const found = await runInRefFrame(tabId, parsed,
        (ref) => { const el = globalThis.__accessibilityTree?.getElementByRef(ref);
          if (!el) return false; el.scrollIntoView({ behavior: 'instant', block: 'center' }); return true; },
        [parsed.ref]);
      return found ? ok([{type:'text',text:`Scrolled to ${args.ref}`}]) : err(refNotFound(args.ref));
    }
    case 'type': {
      const text = args.text || '';
      if (!text.length) return ok([{ type: 'text', text: 'Typed 0 chars' }]);

      // 按换行符拆分：普通文本段用 insertText 批量发送，换行用 keyDown/keyUp
      const segments = text.split(/(\n|\r)/);
      for (const seg of segments) {
        if (seg === '\n' || seg === '\r') {
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent',
            { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent',
            { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        } else if (seg.length > 0) {
          await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: seg });
        }
      }
      return ok([{ type: 'text', text: `Typed ${text.length} chars` }]);
    }
    case 'key': {
      const repeat = Math.min(args.repeat||1,100);
      const parts = (args.text||'').split('+').map(s=>s.trim());
      const rawKey = parts[parts.length-1];
      const key = KEY_MAP[rawKey.toLowerCase()]||rawKey;
      const mods = parseMods(parts.slice(0,-1).join('+'));
      const vk = VK[key]||null;
      const kd = {type:'keyDown',key,modifiers:mods,...vk&&{windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk}};
      const ku = {...kd,type:'keyUp'};
      for (let i=0;i<repeat;i++) {
        await chrome.debugger.sendCommand({tabId},'Input.dispatchKeyEvent',kd);
        await chrome.debugger.sendCommand({tabId},'Input.dispatchKeyEvent',ku);
      }
      return ok([{type:'text',text:`Key: ${args.text}${repeat>1?` x${repeat}`:''}`}]);
    }
    case 'hover': {
      let x,y;
      if (args.ref) {
        await ensureCs(tabId);
        const c = await getElemCoords(tabId,args.ref);
        if (!c) return err(refNotFound(args.ref));
        x=c.x; y=c.y;
      } else if (args.coordinate) {[x,y]=toCss(tabId,args.coordinate);} else return err('coordinate or ref required');
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
      const [lx,ly] = args.coordinate || [x,y];
      return ok([{type:'text',text:`Hovered at (${Math.round(lx)},${Math.round(ly)})`}]);
    }
    case 'zoom': {
      const region = args.region || [0,0,100,100];
      const [cx0,cy0] = toCss(tabId, [region[0],region[1]]);
      const [cx1,cy1] = toCss(tabId, [region[2],region[3]]);
      const { data, width, height, format } = await captureScreenshot(tabId, {
        region: [cx0,cy0,cx1,cy1],
        quality: args.quality ?? 'medium',
        format: args.format,
        maxDimension: args.maxDimension,
      });
      const [x0,y0,x1,y1] = region;
      return ok([{type:'text',text:`Zoomed (${x0},${y0})-(${x1},${y1}) → ${width}x${height}`},{type:'image',data,mimeType:`image/${format}`}]);
    }
    case 'left_click_drag': {
      const [osx,osy]=args.start_coordinate||[0,0], [oex,oey]=args.coordinate||[0,0];
      const [sx,sy]=toCss(tabId,[osx,osy]), [ex,ey]=toCss(tabId,[oex,oey]);
      const mods=parseMods(args.modifiers);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',x:sx,y:sy,modifiers:mods});
      await sleep(50);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mousePressed',x:sx,y:sy,button:'left',clickCount:1,modifiers:mods});
      await sleep(50);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',x:ex,y:ey,modifiers:mods});
      await sleep(100);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseReleased',x:ex,y:ey,button:'left',clickCount:1,modifiers:mods});
      return ok([{type:'text',text:`Dragged (${osx},${osy})→(${oex},${oey})`}]);
    }
    default: { // left_click, right_click, double_click, triple_click
      let x,y;
      if (args.ref) {
        await ensureCs(tabId);
        const c = await getElemCoords(tabId,args.ref);
        if (!c) return err(refNotFound(args.ref));
        x=c.x; y=c.y;
      } else if (args.coordinate) {[x,y]=toCss(tabId,args.coordinate);} else return err('coordinate or ref required');
      const btn = action==='right_click'?'right':'left';
      const cnt = action==='double_click'?2:action==='triple_click'?3:1;
      const mods = parseMods(args.modifiers);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',x,y,modifiers:mods});
      await sleep(50);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:btn,clickCount:cnt,modifiers:mods});
      await sleep(50);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:btn,clickCount:cnt,modifiers:mods});
      if (btn==='right') await sleep(300);
      const [lx,ly] = args.coordinate || [x,y];
      return ok([{type:'text',text:`${action} at (${Math.round(lx)},${Math.round(ly)})`}]);
    }
  }
}
async function toolReadPage(args) {
  const tabId = args.tabId; if (!tabId) return err('tabId required');
  await ensureCs(tabId);
  const filter = args.filter||'all', depth = args.depth||15, maxChars = args.max_chars||50000;
  const refId = args.ref_id||null;
  const parsedRef = refId ? parseRef(refId) : null;
  if (refId && !parsedRef) return err(refNotFound(refId));

  const func = (f, d, m, ri) => {
    const t = globalThis.__accessibilityTree;
    if (!t) return { error: 'Accessibility tree not available' };
    const info = globalThis.__frameLink?.info();
    return { ...t.generate(f, d, m, ri), url: location.href, name: window.name || '', depth: info?.depth ?? 0 };
  };
  const target = parsedRef ? { tabId, frameIds: [parsedRef.frameId] } : { tabId, allFrames: true };
  let injected;
  try {
    injected = await chrome.scripting.executeScript({ target, func, args: [filter, depth, maxChars, parsedRef ? parsedRef.ref : null] });
  } catch (e) {
    return err(parsedRef ? refNotFound(refId) : `Failed to generate page tree: ${e.message}`);
  }
  const results = injected.filter(r => r.result && !r.result.error).map(r => ({ frameId: r.frameId, ...r.result }));
  const main = results.find(r => r.frameId === 0) || results[0];
  if (!main) return err(injected[0]?.result?.error || 'Failed to generate page tree');
  if (parsedRef && String(main.tree).startsWith('[Error]')) return err(refNotFound(refId));

  const merged = mergeFrameTrees(results, maxChars);
  const trunc = merged.truncated ? ', truncated — use ref_id or increase max_chars' : '';
  const frames = merged.frameCount > 1 ? `, ${merged.frameCount} frames` : '';
  return ok([{type:'text',text:`Page tree (${merged.elementCount} elements${frames}, filter:${filter}${trunc}):\n\n${merged.body || '(empty)'}`}]);
}

async function toolFind(args) {
  const tabId = args.tabId; if (!tabId) return err('tabId required');
  await ensureCs(tabId);
  const merged = mergeFindResults(await searchAllFrames(tabId, args.query||'', args.max_results||20), args.max_results||20);
  if (!merged.length) return ok([{type:'text',text:`No elements found matching: "${args.query}"`}]);
  return ok([{type:'text',text:`Found ${merged.length} elements:\n\n${formatFindLines(merged).join('\n')}`}]);
}

async function toolFormInput(args) {
  const {tabId,ref,value} = args;
  if (!tabId) return err('tabId required');
  if (!ref) return err('ref required');
  const parsed = parseRef(ref);
  if (!parsed) return err(refNotFound(ref));
  await ensureCs(tabId);
  const res = await runInRefFrame(tabId, parsed, (ref, value) => {
      const tree = globalThis.__accessibilityTree;
      if (!tree) return {success:false,error:'Accessibility tree not available'};
      const el = tree.getElementByRef(ref);
      if (!el) return {success:false,error:'not-found'};
      const tag = el.tagName.toLowerCase();
      if (!['input','select','textarea'].includes(tag) && !el.isContentEditable)
        return {success:false,error:`${el.tagName} is not a form control`};
      // native setter for React compatibility
      function setNative(el,val){
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto,'value');
        if (desc?.set) desc.set.call(el,val); else el.value=val;
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:val}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
      }
      if (tag==='select'){
        let found=false;
        for(const o of el.options) if(o.value===String(value)||o.text===String(value)){el.value=o.value;found=true;break;}
        if(!found) return {success:false,error:'Option not found'};
        el.dispatchEvent(new Event('change',{bubbles:true}));
      } else if (tag==='input'){
        const t=el.type.toLowerCase();
        if(t==='checkbox'||t==='radio'){el.checked=!!value;el.dispatchEvent(new Event('change',{bubbles:true}));}
        else if(t==='file') return {success:false,error:'Use file_upload tool'};
        else setNative(el,String(value));
      } else if (tag==='textarea') setNative(el,String(value));
      else { el.focus(); document.execCommand('selectAll',false,null); document.execCommand('insertText',false,String(value)); }
      return {success:true,fieldName:el.name||el.id||ref};
    }, [parsed.ref, value]);
  if (!res) return err(refNotFound(ref));
  if (!res.success) return err(res.error === 'not-found' ? refNotFound(ref) : (res.error||'Failed to set value'));
  return ok([{type:'text',text:`Set value for ${res.fieldName}`}]);
}
async function toolNavigate(args) {
  const {tabId, url} = args;
  if (!tabId) return err('tabId required');
  if (!url) return err('url required');
  const t0 = setDialogMode(tabId, args);
  let result;
  try {
    result = await navigateImpl(args);
  } finally {
    clearDialogMode(tabId);
  }
  return appendDialogNotes(tabId, t0, result);
}

async function navigateImpl({tabId, url, force=false}) {

  if (url === 'back' || url === 'forward') {
    const before = (await getTab(tabId)).url;
    try {
      url === 'back' ? await chrome.tabs.goBack(tabId) : await chrome.tabs.goForward(tabId);
    } catch {
      await chrome.scripting.executeScript({target:{tabId},
        func:d=>d==='back'?history.back():history.forward(), args:[url]});
    }
    await waitForLoad(tabId, 5000);
    const after = (await getTab(tabId));
    if (after.url === before) return ok([{type:'text',text:`Cannot go ${url}: no page in history`}]);
    return ok([{type:'text',text:`Navigated ${url} to: ${after.url}\nTitle: ${after.title}`}]);
  }

  const norm = normalizeUrl(url);
  if (norm.error) return err(norm.error);
  const finalUrl = norm.url;

  const t0 = Date.now();
  await chrome.tabs.update(tabId, {url: finalUrl});
  await waitForLoad(tabId, 10000);
  const tab = await getTab(tabId);
  const ms = ((Date.now()-t0)/1000).toFixed(1);
  const redir = tab.url !== finalUrl ? ` (redirected from ${finalUrl})` : '';
  return ok([{type:'text',text:`Navigated to: ${tab.url}${redir}\nTitle: ${tab.title}\nDuration: ${ms}s`}]);
}

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    // 先检查是否已经 complete（避免错过已完成的导航）
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') { resolve(true); return; }

      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }, timeoutMs);

      function listener(updatedTabId, info) {
        if (updatedTabId !== tabId || info.status !== 'complete') return;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
      chrome.tabs.onUpdated.addListener(listener);
    }).catch(() => resolve(false));
  });
}

async function toolResizeWindow(args) {
  const {tabId, width=1280, height=720} = args;
  const w = Math.max(400,Math.min(7680,width)), h = Math.max(300,Math.min(4320,height));
  let winId;
  if (tabId) { try { winId=(await chrome.tabs.get(tabId)).windowId; } catch {} }
  if (!winId) { const [win]=await chrome.windows.getAll({populate:false}); winId=win?.id; }
  if (!winId) return err('No window found');
  await chrome.windows.update(winId,{width:w,height:h});
  if (tabId) shotScale.delete(tabId);
  return ok([{type:'text',text:`Window resized to ${w}x${h}`}]);
}

async function toolReadConsole(args) {
  const {tabId, pattern, onlyErrors=false, clear=false, limit=100} = args;
  if (!tabId) return err('tabId required');
  await ensureCdp(tabId);
  const buf = tabBuf(tabId);
  let msgs = [...buf.console];
  if (onlyErrors) msgs = msgs.filter(m=>m.type==='error'||m.type==='exception');
  if (pattern) {
    let re; try { re=new RegExp(pattern,'i'); } catch(e){return err(`Invalid pattern: ${e.message}`);}
    msgs = msgs.filter(m=>re.test(m.args));
  }
  msgs = msgs.slice(-limit);
  if (clear) buf.console=[];
  if (!msgs.length) return ok([{type:'text',text:'No console messages'}]);
  const lines = msgs.map(m=>{
    const t=new Date(m.timestamp).toISOString().slice(11,19);
    return `[${t}] [${m.type.toUpperCase().padEnd(5)}] ${m.args}`;
  });
  return ok([{type:'text',text:`Console (${msgs.length}${clear?', cleared':''}):\n\n${lines.join('\n')}`}]);
}

const toolTabs = createTabsTool({ chrome, ok, err, waitForLoad, sleep });
const toolNetwork = createNetworkTool({ chrome, ok, err, ensureCdp, tabBuf });
const toolStorage = createStorageTool({ chrome, ok, err });
const interceptStore = createInterceptStore();
const intercept = createInterceptTools({
  chrome, ok, err, ensureCdp, store: interceptStore, sleep,
  markAttached: (tabId) => cdpReady.add(tabId),
});

async function toolWaitFor(args) {
  const { tabId, condition, text, urlPattern, milliseconds, idleMs=750, timeoutMs=15000 } = args;
  if (!tabId) return err('tabId required');
  if (!condition) return err('condition required');
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let lastObserved = '';

  while (Date.now() < deadline) {
    try {
      if (condition === 'time') {
        await sleep(Math.min(milliseconds || 1000, Math.max(deadline - Date.now(), 0)));
        return ok([{type:'text',text:`Waited ${milliseconds || 1000}ms`}]);
      }
      if (condition === 'url') {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const url = tab?.url || '';
        lastObserved = url;
        if (urlPattern && url.includes(urlPattern))
          return ok([{type:'text',text:`URL matched after ${Date.now()-t0}ms: ${url}`}]);
      } else if (condition === 'network_idle') {
        await ensureCdp(tabId);
        const store = tabBuf(tabId).network;
        const quiet = Date.now() - (store.lastStartedAt() || t0);
        lastObserved = `${store.size()} requests buffered, last ${quiet}ms ago`;
        if (quiet >= idleMs)
          return ok([{type:'text',text:`Network idle after ${Date.now()-t0}ms (no new requests for ${quiet}ms)`}]);
      } else {
        await ensureCs(tabId);
        const found = (await searchAllFrames(tabId, text||'', 1)).some(f => f.items.length > 0);
        lastObserved = found ? `element "${text}" present` : `element "${text}" absent`;
        if (condition === 'element' && found)
          return ok([{type:'text',text:`Element "${text}" appeared after ${Date.now()-t0}ms`}]);
        if (condition === 'element_gone' && !found)
          return ok([{type:'text',text:`Element "${text}" gone after ${Date.now()-t0}ms`}]);
      }
    } catch (e) {
      // 页面导航中/CDP 重连中等瞬态错误：记入观察状态继续轮询
      lastObserved = `probe failed: ${e.message}`;
    }
    await sleep(300);
  }
  return err(`Timeout after ${timeoutMs}ms waiting for ${condition}. Last state: ${lastObserved}`);
}

async function toolHandleDialog(args) {
  const { tabId, accept=true, promptText } = args;
  if (!tabId) return err('tabId required');
  await ensureCdp(tabId);
  const pending = (tabBuf(tabId).dialogs || []).filter(d => !d.answered).pop();
  if (!pending) return err('No pending dialog on this tab');
  await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog',
    { accept, ...(promptText != null && { promptText }) });
  pending.answered = true;
  return ok([{type:'text',text:`Dialog [${pending.type}] ${accept ? 'accepted' : 'dismissed'}: "${pending.message}"`}]);
}

async function toolSavePdf(args) {
  const { tabId, saveTo, paperFormat='A4', landscape=false, printBackground=true, scale=1 } = args;
  if (!tabId) return err('tabId required');
  if (!saveTo) return err('saveTo required');
  await ensureCdp(tabId);
  const res = await chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
    format: paperFormat, landscape, printBackground, scale,
    transferMode: 'ReturnAsBase64',
  });
  return ok([
    {type:'text',text:`PDF generated (${paperFormat}${landscape ? ', landscape' : ''})`},
    {type:'image',data:res.data,mimeType:'application/pdf'},
  ]);
}

async function toolCookies(args) {
  const { action, url, domain, name, cookies } = args;
  try {
    if (action === 'get') {
      if (!url && !domain) return err('url or domain required');
      const query = { ...(url && { url }), ...(domain && { domain }), ...(name && { name }) };
      const list = await chrome.cookies.getAll(query);
      const out = list.slice(0, 200).map(c => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly,
        expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'session',
      }));
      return ok([{type:'text',text:`Cookies (${out.length}${list.length > 200 ? ', truncated' : ''}):\n\n${JSON.stringify(out, null, 2)}`}]);
    }
    if (action === 'set') {
      if (!url || !cookies?.length) return err('url and cookies required');
      const results = [];
      for (const c of cookies) {
        try {
          await chrome.cookies.set({ url, ...(domain && { domain }), ...c });
          results.push(`ok ${c.name}`);
        } catch (e) { results.push(`FAIL ${c.name}: ${e.message}`); }
      }
      return ok([{type:'text',text:`Set cookies for ${url}:\n${results.join('\n')}`}]);
    }
    if (action === 'remove') {
      if (!url || !name) return err('url and name required');
      await chrome.cookies.remove({ url, name });
      return ok([{type:'text',text:`Removed cookie ${name} on ${url}`}]);
    }
    // clear：强制带 domain 范围，避免误清全浏览器
    if (!domain) return err('clear requires a domain (safety: no whole-browser wipe)');
    const list = await chrome.cookies.getAll({ domain });
    let removed = 0;
    for (const c of list) {
      const scheme = c.secure ? 'https' : 'http';
      await chrome.cookies.remove({ url: `${scheme}://${c.domain.replace(/^\./, '')}${c.path}`, name: c.name }).catch(() => {});
      removed++;
    }
    return ok([{type:'text',text:`Cleared ${removed} cookies for domain ${domain}`}]);
  } catch (e) { return err(e.message); }
}

async function toolDownloads(args) {
  const { action, urlFilter, downloadId, timeoutMs = 120000 } = args;
  try {
    if (action === 'list') {
      const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 500 });
      const filtered = urlFilter ? items.filter(d => d.url.includes(urlFilter)) : items;
      const lines = filtered.slice(0, 20).map(d =>
        `[${d.id}] ${d.state} ${(d.bytesReceived/1024).toFixed(0)}KB/${((d.totalBytes||0)/1024).toFixed(0)}KB\n    ${d.filename}\n    ${d.url}`);
      return ok([{type:'text',text:`Downloads (${filtered.length}):\n\n${lines.join('\n') || '(none)'}`}]);
    }
    if (action === 'wait') {
      let target = downloadId ?? null;
      if (!target) {
        if (!urlFilter) return err('urlFilter or downloadId required');
        const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 500 });
        const hit = items.find(d => d.url.includes(urlFilter) && d.state === 'in_progress')
          || items.find(d => d.url.includes(urlFilter));
        if (!hit) return err(`No download matching "${urlFilter}"`);
        target = hit.id;
        if (hit.state === 'complete')
          return ok([{type:'text',text:`Download ${target} already complete: ${hit.filename}`}]);
      }
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          chrome.downloads.onChanged.removeListener(h);
          resolve({ timeout: true });
        }, timeoutMs);
        function h(delta) {
          if (delta.id !== target || !delta.state) return;
          if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
            clearTimeout(timer);
            chrome.downloads.onChanged.removeListener(h);
            resolve({ state: delta.state.current });
          }
        }
        chrome.downloads.onChanged.addListener(h);
      });
      const [item] = await chrome.downloads.search({ id: target });
      if (!item) return err(`Download ${target} not found`);
      if (outcome.timeout)
        return err(`Timeout after ${timeoutMs}ms: state=${item.state}, ${item.bytesReceived}/${item.totalBytes} bytes — ${item.filename}`);
      if (item.state === 'complete')
        return ok([{type:'text',text:`Download complete: ${item.filename}\nURL: ${item.url}`}]);
      return err(`Download ${item.state}: ${item.filename}${item.error ? ` (${item.error})` : ''}`);
    }
    // erase：仅清历史记录，不删文件
    if (!downloadId && !urlFilter) return err('downloadId or urlFilter required');
    const ids = downloadId ? [downloadId]
      : (await chrome.downloads.search({ limit: 500 })).filter(d => d.url.includes(urlFilter)).map(d => d.id);
    for (const id of ids) await chrome.downloads.erase({ id }).catch(() => {});
    return ok([{type:'text',text:`Erased ${ids.length} download history entries (files kept)`}]);
  } catch (e) { return err(e.message); }
}

// ── performance / emulate ─────────────────────────────────────────────────────
// tabId -> { events, truncated, resolve }  (Tracing.* 事件由 chrome.debugger.onEvent 填充)
const traceSessions = new Map();
// 设置过 emulate 覆盖的标签页 -> 已生效的项名集合：导航时不能 detach，否则覆盖随调试会话一起丢失；reset 时按项还原
const emulatedTabs = new Map();
const MAX_TRACE_EVENTS = 600000;
const TRACE_CATEGORIES = [
  'devtools.timeline', 'disabled-by-default-devtools.timeline', 'loading',
  'v8.execute', 'blink.user_timing',
];

const NETWORK_PRESETS = {
  'Offline': { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'Slow 3G': { offline: false, latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000 },
  'Fast 3G': { offline: false, latency: 562, downloadThroughput: 180000, uploadThroughput: 84375 },
  'Fast 4G': { offline: false, latency: 165, downloadThroughput: 1012500, uploadThroughput: 168750 },
  'none': { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

const PAGE_VITALS_EXPR = `(async () => {
  const out = {};
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) out.nav = { ttfb: Math.round(nav.responseStart), dcl: Math.round(nav.domContentLoadedEventEnd),
    load: Math.round(nav.loadEventEnd), transferKB: Math.round(nav.transferSize / 1024) };
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  if (fcp) out.fcp = Math.round(fcp.startTime);
  let lcp = null, cur = 0, curStart = 0, curLast = 0, cls = 0, inp = 0;
  const observers = [];
  const watch = (type, cb, extra) => {
    try {
      const o = new PerformanceObserver(l => l.getEntries().forEach(cb));
      o.observe({ type, buffered: true, ...extra });
      observers.push(o);
    } catch {}
  };
  watch('largest-contentful-paint', e => { lcp = e; });
  watch('layout-shift', e => {
    if (e.hadRecentInput) return;
    if (cur && e.startTime - curLast < 1000 && e.startTime - curStart < 5000) cur += e.value;
    else { cur = e.value; curStart = e.startTime; }
    curLast = e.startTime;
    cls = Math.max(cls, cur);
  });
  watch('event', e => { if (e.interactionId) inp = Math.max(inp, e.duration); }, { durationThreshold: 16 });
  await new Promise(r => setTimeout(r, 100));
  observers.forEach(o => o.disconnect());
  if (lcp) out.lcp = { time: Math.round(lcp.startTime), size: lcp.size,
    el: lcp.element ? lcp.element.tagName.toLowerCase() : null, url: lcp.url || null };
  out.cls = Math.round(cls * 1000) / 1000;
  out.inp = inp ? Math.round(inp) : null;
  const res = performance.getEntriesByType('resource');
  out.resources = { count: res.length, transferKB: Math.round(res.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024),
    slowest: res.slice().sort((a, b) => b.duration - a.duration).slice(0, 5)
      .map(r => ({ url: r.name.slice(0, 120), ms: Math.round(r.duration) })) };
  out.domNodes = document.getElementsByTagName('*').length;
  return JSON.stringify(out);
})()`;

async function perfMetrics(tabId) {
  await ensureCdp(tabId);
  const ev = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate',
    { expression: PAGE_VITALS_EXPR, awaitPromise: true, returnByValue: true });
  if (ev.exceptionDetails) return err(ev.exceptionDetails.exception?.description || 'vitals script failed');
  const v = JSON.parse(ev.result.value);

  await chrome.debugger.sendCommand({ tabId }, 'Performance.enable');
  let cdp = {};
  try {
    const { metrics } = await chrome.debugger.sendCommand({ tabId }, 'Performance.getMetrics');
    for (const m of metrics) cdp[m.name] = m.value;
  } finally {
    await chrome.debugger.sendCommand({ tabId }, 'Performance.disable').catch(() => {});
  }
  const mb = (n) => n == null ? 'n/a' : `${(n / 1048576).toFixed(1)} MB`;
  const ms = (s) => s == null ? 'n/a' : `${Math.round(s * 1000)} ms`;

  const lines = [
    'Core Web Vitals (current page lifetime; INP is the worst observed interaction, approximate)',
    `  LCP: ${v.lcp ? `${v.lcp.time} ms (${v.lcp.el || 'unknown'}, size ${v.lcp.size}${v.lcp.url ? `, ${v.lcp.url.slice(0, 80)}` : ''})` : 'not observed'}`,
    `  CLS: ${v.cls}`,
    `  INP: ${v.inp != null ? `${v.inp} ms` : 'no interactions yet'}`,
    `  FCP: ${v.fcp != null ? `${v.fcp} ms` : 'n/a'}`,
  ];
  if (v.nav) lines.push('Navigation', `  TTFB ${v.nav.ttfb} ms · DOMContentLoaded ${v.nav.dcl} ms · load ${v.nav.load} ms · document ${v.nav.transferKB} KB`);
  lines.push(
    'Runtime (CDP Performance.getMetrics)',
    `  JS heap ${mb(cdp.JSHeapUsedSize)} used / ${mb(cdp.JSHeapTotalSize)} total · DOM nodes ${v.domNodes} · listeners ${cdp.JSEventListeners ?? 'n/a'} · documents ${cdp.Documents ?? 'n/a'} · frames ${cdp.Frames ?? 'n/a'}`,
    `Resources: ${v.resources.count} requests, ${v.resources.transferKB} KB transferred (cross-origin/cached entries report 0, so this is a lower bound)`,
    'Slowest resources:',
    ...v.resources.slowest.map(r => `  ${r.ms} ms  ${r.url}`),
  );
  return ok([{ type: 'text', text: lines.join('\n') }]);
}

const SCRIPT_EVENTS = new Set(['EvaluateScript', 'v8.compile', 'v8.compileModule', 'FunctionCall',
  'v8.callFunction', 'v8.run', 'TimerFire', 'EventDispatch', 'FireAnimationFrame', 'RunMicrotasks', 'XHRReadyStateChange']);
const LAYOUT_EVENTS = new Set(['UpdateLayoutTree', 'Layout']);
const PAINT_EVENTS = new Set(['Paint', 'PrePaint', 'Layerize', 'Commit', 'UpdateLayer', 'CompositeLayers', 'HitTest']);

function analyzeTrace(events, truncated) {
  const started = events.find(e => e.name === 'TracingStartedInBrowser');
  const frames = started?.args?.data?.frames || [];
  const mainFrame = frames.find(f => f.isInPrimaryMainFrame) || frames.find(f => !f.parent) || frames[0];
  const mainThreads = events.filter(e => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  const main = mainThreads.find(e => e.pid === mainFrame?.processId) || mainThreads[0];
  if (!main) return null;

  const mine = events.filter(e => e.pid === main.pid);
  const navStart = mine.filter(e => e.name === 'navigationStart' && e.args?.data?.isLoadingMainFrame).pop();
  const t0 = (navStart ?? started)?.ts ?? mine.reduce((m, e) => e.ts && e.ts < m ? e.ts : m, Infinity);
  const rel = (ts) => Math.round((ts - t0) / 1000);

  const fcp = mine.find(e => e.name === 'firstContentfulPaint' && e.ts >= t0);
  const lcp = mine.filter(e => e.name === 'largestContentfulPaint::Candidate' && e.ts >= t0).pop();
  const cls = mine.filter(e => e.name === 'LayoutShift' && e.args?.data?.is_main_frame && !e.args?.data?.had_recent_input)
    .reduce((s, e) => s + (e.args.data.score || 0), 0);

  const sorted = mine.filter(e => e.tid === main.tid && e.ph === 'X' && e.dur != null)
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const stack = [], nodes = [];
  for (const e of sorted) {
    while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
    const node = { e, end: e.ts + e.dur, child: 0 };
    if (stack.length) stack[stack.length - 1].child += e.dur;
    stack.push(node); nodes.push(node);
  }
  const buckets = { scripting: 0, layout: 0, paint: 0, parsing: 0, other: 0 };
  for (const { e, child } of nodes) {
    const self = e.dur - child;
    if (SCRIPT_EVENTS.has(e.name)) buckets.scripting += self;
    else if (LAYOUT_EVENTS.has(e.name)) buckets.layout += self;
    else if (PAINT_EVENTS.has(e.name)) buckets.paint += self;
    else if (e.name === 'ParseHTML') buckets.parsing += self;
    else buckets.other += self;
  }
  const tasks = nodes.filter(n => n.e.name === 'RunTask' && n.e.dur >= 50000);
  const afterFcp = fcp ? tasks.filter(n => n.e.ts >= fcp.ts) : tasks;
  const blocking = afterFcp.reduce((s, n) => s + (n.e.dur - 50000), 0);
  const topScripts = nodes.filter(n => n.e.name === 'EvaluateScript' || n.e.name === 'FunctionCall')
    .sort((a, b) => b.e.dur - a.e.dur).slice(0, 5);

  const f = (us) => `${Math.round(us / 1000)} ms`;
  const lines = [
    `Trace summary (main frame renderer pid ${main.pid}${truncated ? ', TRUNCATED at event cap' : ''})`,
    navStart ? 'Window: from main-frame navigation start' : 'Window: from trace start (no navigation recorded; use reload:true for load metrics)',
    `  FCP: ${fcp ? `${rel(fcp.ts)} ms` : 'not observed'}`,
    `  LCP: ${lcp ? `${rel(lcp.ts)} ms (${lcp.args?.data?.type || 'unknown'}, size ${lcp.args?.data?.size ?? 'n/a'})` : 'not observed'}`,
    `  CLS: ${Math.round(cls * 1000) / 1000}`,
    `  Blocking time (long-task excess over 50 ms${fcp ? ', after FCP' : ''}): ${f(blocking)}`,
    `Main thread self time: scripting ${f(buckets.scripting)} · layout/style ${f(buckets.layout)} · paint ${f(buckets.paint)} · parsing ${f(buckets.parsing)} · other ${f(buckets.other)}`,
    `Long tasks (>=50 ms): ${tasks.length}`,
    ...tasks.sort((a, b) => b.e.dur - a.e.dur).slice(0, 8).map(n => `  ${f(n.e.dur)} at +${rel(n.e.ts)} ms`),
    'Heaviest script calls:',
    ...topScripts.map(({ e }) => {
      const d = e.args?.data || {};
      const where = d.url ? `${d.url.slice(0, 90)}${d.lineNumber != null ? `:${d.lineNumber}` : ''}` : (d.functionName || '(anonymous)');
      return `  ${f(e.dur)}  ${e.name}  ${where}`;
    }),
  ];
  return lines.join('\n');
}

async function toolPerformance(args) {
  const { tabId, action, reload = false } = args;
  if (!tabId) return err('tabId required');
  try {
    if (action === 'metrics') return await perfMetrics(tabId);

    if (action === 'trace_start') {
      if (traceSessions.has(tabId)) return err('A trace is already running on this tab; call trace_stop first');
      await ensureCdp(tabId);
      const session = { events: [], truncated: false, resolve: null };
      traceSessions.set(tabId, session);
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Tracing.start', {
          traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: TRACE_CATEGORIES },
        });
        if (reload) await chrome.debugger.sendCommand({ tabId }, 'Page.reload', { ignoreCache: true });
      } catch (e) { traceSessions.delete(tabId); throw e; }
      return ok([{ type: 'text', text: `Trace started${reload ? ' (page reloading)' : ''}. Interact with the page, then call performance with action "trace_stop".` }]);
    }

    if (action === 'trace_stop') {
      const session = traceSessions.get(tabId);
      if (!session) return err('No trace running on this tab; call trace_start first');
      const done = new Promise(r => { session.resolve = r; });
      try { await chrome.debugger.sendCommand({ tabId }, 'Tracing.end'); }
      catch (e) { traceSessions.delete(tabId); throw e; }
      const finished = await Promise.race([done.then(() => true), sleep(40000).then(() => false)]);
      traceSessions.delete(tabId);
      const summary = analyzeTrace(session.events, session.truncated);
      if (!summary) return err('Trace contained no renderer main-thread events for this tab');
      return ok([{ type: 'text', text: summary + (finished ? '' : '\n(trace flush timed out; results may be partial)') }]);
    }
    return err(`Unknown action: ${action}`);
  } catch (e) { return err(e.message); }
}

const toolEmulate = createEmulateTool({ chrome, ok, err, ensureCdp, emulatedTabs, networkPresets: NETWORK_PRESETS });

const { toolJavascript, toolGetPageText, toolFileUpload } = createPageTools({
  chrome, ok, err, ensureCdp, ensureCs, runInRefFrame, getElemCoords, sleep,
});

const TOOL_MAP = {
  performance: toolPerformance, emulate: toolEmulate,
  computer: toolComputer, read_page: toolReadPage, find: toolFind,
  form_input: toolFormInput, navigate: toolNavigate,
  javascript_tool: toolJavascript, get_page_text: toolGetPageText,
  file_upload: toolFileUpload, resize_window: toolResizeWindow,
  read_console_messages: toolReadConsole, network: toolNetwork,
  tabs: toolTabs, storage: toolStorage,
  intercept_add: intercept.intercept_add, intercept_list: intercept.intercept_list, intercept_remove: intercept.intercept_remove,
  wait_for: toolWaitFor, handle_dialog: toolHandleDialog, save_pdf: toolSavePdf,
  cookies: toolCookies, downloads: toolDownloads,
};

// wait_for/downloads 的长超时工具放宽 WS 层兜底（relay 侧另有逐工具超时）
const EXT_TOOL_TIMEOUTS = { wait_for: 135000, downloads: 620000, save_pdf: 70000, performance: 70000 };

// ── Response helpers ──────────────────────────────────────────────────────────
function ok(content) { return { content }; }
function err(msg) { return { content:[{type:'text',text:`Error: ${msg}`}], isError:true }; }

// 同一标签页的写操作串行执行；读操作与 handle_dialog 不排队（manual 弹窗会卡住持锁的点击）
const QUEUED_ACTIONS = new Set(['left_click','right_click','double_click','triple_click',
  'type','key','scroll','scroll_to','left_click_drag','hover']);
const QUEUED_TOOLS = new Set(['form_input','navigate','file_upload','javascript_tool']);
const STORAGE_WRITE_ACTIONS = new Set(['set','remove','clear']);

function isQueuedCall(tool, args) {
  if (!Number.isInteger(args?.tabId)) return false;
  if (tool === 'computer') return QUEUED_ACTIONS.has(args.action);
  if (tool === 'tabs') return args.action === 'reload';
  if (tool === 'storage') return STORAGE_WRITE_ACTIONS.has(args.action);
  return QUEUED_TOOLS.has(tool);
}

// ── Message router ────────────────────────────────────────────────────────────
async function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.method === 'ping') { sendMsg({method:'pong'}); return; }
  if (msg.method === 'tools/discover') {
    sendMsg({id:msg.id, result:{tools:Object.keys(TOOL_MAP).map(name=>({name}))}}); return;
  }
  if (msg.method === 'tools/invoke' && typeof msg.id === 'number') {
    const tool = msg.params?.tool;
    const args = msg.params?.arguments ?? {};
    const handler = TOOL_MAP[tool];
    if (!handler) {
      sendMsg({id:msg.id, error:{code:'BAD_REQUEST',message:`Unknown tool: ${tool}`}}); return;
    }
    try {
      const run = () => withTimeout(handler(args), EXT_TOOL_TIMEOUTS[tool] ?? TOOL_TIMEOUT, tool);
      const result = isQueuedCall(tool, args) ? await tabQueue.run(args.tabId, run) : await run();
      sendMsg({id:msg.id, result});
    } catch(e) {
      sendMsg({id:msg.id, error:{code:'INTERNAL_ERROR',message:e.message||String(e)}});
    }
  }
}

// ── Chrome event listeners ────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener((src, method, params) => {
  const tabId = src.tabId; if (!tabId) return;
  if (method === 'Fetch.requestPaused') { intercept.handlePaused(tabId, params); return; }
  if (method.startsWith('Tracing.')) {
    const trace = traceSessions.get(tabId);
    if (!trace) return;
    if (method === 'Tracing.dataCollected') {
      for (const ev of params.value || []) {
        if (trace.events.length >= MAX_TRACE_EVENTS) { trace.truncated = true; break; }
        trace.events.push(ev);
      }
    } else if (method === 'Tracing.tracingComplete') trace.resolve?.();
    return;
  }
  const buf = tabBuf(tabId);

  if (method === 'Runtime.consoleAPICalled') {
    const args = (params.args||[]).map(a=>
      a.type==='string'||a.type==='number'||a.type==='boolean' ? String(a.value)
      : a.type==='undefined' ? 'undefined'
      : a.type==='object' ? JSON.stringify(a.value??a.preview??null)
      : String(a.value??a.description??'')
    ).join(' ');
    buf.console.push({type:params.type||'log', args, timestamp:params.timestamp?params.timestamp*1000:Date.now()});
    if (buf.console.length > 1000) buf.console.shift();
  }

  if (method === 'Network.requestWillBeSent') buf.network.onRequest(params, Date.now());
  else if (method === 'Network.requestWillBeSentExtraInfo') buf.network.onExtraInfo(params);
  else if (method === 'Network.responseReceived') buf.network.onResponse(params);
  else if (method === 'Network.loadingFinished') buf.network.onFinished(params);
  else if (method === 'Network.loadingFailed') buf.network.onFailed(params);

  if (method === 'Page.javascriptDialogOpening') {
    const dbuf = tabBuf(tabId).dialogs;
    dbuf.push({ type: params.type, message: params.message || '', ts: Date.now(), answered: false });
    if (dbuf.length > 20) dbuf.shift();
    const mode = dialogModes.get(tabId) || 'accept';
    if (mode !== 'manual') {
      chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: mode === 'accept' }).catch(() => {});
      const last = dbuf[dbuf.length - 1];
      if (last && !last.answered) last.answered = true;
    }
  }
});

chrome.debugger.onDetach.addListener(src => {
  if (src.tabId) {
    cdpReady.delete(src.tabId); traceSessions.delete(src.tabId); emulatedTabs.delete(src.tabId);
    intercept.handleDetach(src.tabId);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  tabQueue.clear(tabId);
  traceSessions.delete(tabId);
  emulatedTabs.delete(tabId);
  intercept.handleTabRemoved(tabId);
  tabEventBuffers.delete(tabId);
  shotScale.delete(tabId);
  cdpReady.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    // trace 与 emulate 覆盖依赖同一个调试会话，加载期间不能断开，否则 reload 压测会丢数据
    if (traceSessions.has(tabId) || emulatedTabs.has(tabId) || interceptStore.isActive(tabId)) return;
    // 页面开始加载时 CDP 会话失效，需重新附加
    cdpDetach(tabId).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'getStatus') {
    reply({
      connected: ws?.readyState === WebSocket.OPEN,
      relayUrl: RELAY_URL,
      reconnectAttempt,
    });
  }
  // 立即触发重连：清除待执行的定时器，重置 stopped 标志，发起新连接
  if (msg.type === 'reconnect') {
    stopped = false;
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    connect();
    reply({ ok: true });
  }
  return false;
});

// ── Keepalive ─────────────────────────────────────────────────────────────────
// Service Worker 被回收后没有页面事件就不会重连 relay；周期闹钟把它唤醒，监听器必须在顶层同步注册
function ensureConnected() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer !== null) return;
  connect();
}
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'keepalive') ensureConnected(); });
chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);

// ── Boot ──────────────────────────────────────────────────────────────────────
connect();
