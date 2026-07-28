// background.js — browser-mcp Service Worker
// Connects to local relay via WebSocket and executes CDP tool calls

// ── Constants ────────────────────────────────────────────────────────────────
const RELAY_URL = 'ws://127.0.0.1:16789';
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
const TOOL_TIMEOUT = 60000;

// ── State ────────────────────────────────────────────────────────────────────
let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let stopped = false;

// tabId -> { console: [], network: [] }
const tabEventBuffers = new Map();
// tabId -> true  (CDP attached + domains enabled)
const cdpReady = new Set();
// tabId -> true  (content scripts injected)
const csInjected = new Set();

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
async function cdpAttach(tabId) {
  if (cdpReady.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch {}
  await chrome.debugger.attach({ tabId }, '1.3');
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  cdpReady.add(tabId);
}

async function cdpDetach(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch {}
  cdpReady.delete(tabId);
}

async function ensureCdp(tabId) {
  if (cdpReady.has(tabId)) return;
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || '';
  if (/^(chrome|chrome-extension|devtools|about|edge):/.test(url))
    throw new Error(`Cannot attach CDP to restricted URL: ${url}`);
  await cdpAttach(tabId);
}

async function ensureCs(tabId) {
  if (csInjected.has(tabId)) return;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!globalThis.__pageBridge,
    });
    if (res?.result) { csInjected.add(tabId); return; }
  } catch {}
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-scripts/accessibility-tree.js', 'content-scripts/page-bridge.js'],
  });
  csInjected.add(tabId);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tabBuf(tabId) {
  if (!tabEventBuffers.has(tabId)) tabEventBuffers.set(tabId, { console: [], network: [] });
  return tabEventBuffers.get(tabId);
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

const SCREENSHOT_QUALITY = { low:{q:20,max:27000}, medium:{q:40,max:270000}, high:{q:60,max:670000} };

async function captureScreenshot(tabId, quality = 'low') {
  const cfg = SCREENSHOT_QUALITY[quality] || SCREENSHOT_QUALITY.low;

  // 获取当前视口尺寸，用于判断是否需要缩放
  const MAX_DIM = 2000;
  let vpResult;
  try {
    [vpResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ w: window.innerWidth, h: window.innerHeight }),
    });
  } catch { vpResult = null; }
  const vw = vpResult?.result?.w || 1280;
  const vh = vpResult?.result?.h || 720;

  // 计算缩放比：取宽/高超出 2000px 的最小比例
  const scale = Math.min(1, MAX_DIM / Math.max(vw, vh));

  let q = cfg.q;
  let data;
  const screenshotParams = {
    format: 'jpeg',
    quality: q,
    captureBeyondViewport: false,
    fromSurface: true,
    ...(scale < 1 && {
      clip: { x: 0, y: 0, width: vw, height: vh, scale },
    }),
  };

  do {
    screenshotParams.quality = q;
    const res = await chrome.debugger.sendCommand(
      { tabId }, 'Page.captureScreenshot', screenshotParams
    );
    data = res.data;
    q -= 5;
  } while (data.length > cfg.max && q >= 5);

  return data;
}

async function getElemCoords(tabId, ref) {
  const [r] = await chrome.scripting.executeScript({
    target:{tabId},
    func: ref => globalThis.__accessibilityTree?.getElementCoordinates(ref, {scrollIntoView:true}) ?? null,
    args:[ref],
  });
  return r?.result ?? null;
}

async function toolComputer(args) {
  const {action, tabId} = args;
  if (!tabId) return err('tabId is required');
  await ensureCdp(tabId);

  switch(action) {
    case 'screenshot': {
      await sleep(50);
      const data = await captureScreenshot(tabId, args.quality||'low');
      const [vp] = await chrome.scripting.executeScript({target:{tabId},
        func:()=>({w:window.innerWidth,h:window.innerHeight})});
      const {w,h} = vp?.result||{w:1280,h:720};
      return ok([{type:'text',text:`Screenshot ${w}x${h}`},{type:'image',data,mimeType:'image/jpeg'}]);
    }
    case 'wait': {
      await sleep(Math.min((args.duration||1),10)*1000);
      return ok([{type:'text',text:`Waited ${args.duration||1}s`}]);
    }
    case 'scroll': {
      const dir = args.scroll_direction||'down', n = Math.min(args.scroll_amount||3,10)*100;
      const dx = dir==='left'?-n:dir==='right'?n:0;
      const dy = dir==='up'?-n:dir==='down'?n:0;
      const [cx,cy] = args.coordinate||[640,360];
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
      await ensureCs(tabId);
      const [r] = await chrome.scripting.executeScript({target:{tabId},
        func:ref=>{const el=globalThis.__accessibilityTree?.getElementByRef(ref);
          if(!el)return false; el.scrollIntoView({behavior:'instant',block:'center'}); return true;},
        args:[args.ref]});
      return r?.result ? ok([{type:'text',text:`Scrolled to ${args.ref}`}]) : err(`Element not found: ${args.ref}`);
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
        if (!c) return err(`Element not found: ${args.ref}`);
        x=c.x; y=c.y;
      } else if (args.coordinate) {[x,y]=args.coordinate;} else return err('coordinate or ref required');
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
      return ok([{type:'text',text:`Hovered at (${Math.round(x)},${Math.round(y)})`}]);
    }
    case 'zoom': {
      const [x0,y0,x1,y1] = args.region||[0,0,100,100];
      const res = await chrome.debugger.sendCommand({tabId},'Page.captureScreenshot',{
        format:'jpeg',quality:40,captureBeyondViewport:false,fromSurface:true,
        clip:{x:Math.min(x0,x1),y:Math.min(y0,y1),width:Math.abs(x1-x0),height:Math.abs(y1-y0),scale:1}});
      return ok([{type:'text',text:`Zoomed (${x0},${y0})-(${x1},${y1})`},{type:'image',data:res.data,mimeType:'image/jpeg'}]);
    }
    case 'left_click_drag': {
      const [sx,sy]=args.start_coordinate||[0,0], [ex,ey]=args.coordinate||[0,0];
      const mods=parseMods(args.modifiers);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',x:sx,y:sy,modifiers:mods});
      await sleep(50);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mousePressed',x:sx,y:sy,button:'left',clickCount:1,modifiers:mods});
      await sleep(50);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',x:ex,y:ey,modifiers:mods});
      await sleep(100);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseReleased',x:ex,y:ey,button:'left',clickCount:1,modifiers:mods});
      return ok([{type:'text',text:`Dragged (${sx},${sy})→(${ex},${ey})`}]);
    }
    default: { // left_click, right_click, double_click, triple_click
      let x,y;
      if (args.ref) {
        await ensureCs(tabId);
        const c = await getElemCoords(tabId,args.ref);
        if (!c) return err(`Element not found: ${args.ref}`);
        x=c.x; y=c.y;
      } else if (args.coordinate) {[x,y]=args.coordinate;} else return err('coordinate or ref required');
      const btn = action==='right_click'?'right':'left';
      const cnt = action==='double_click'?2:action==='triple_click'?3:1;
      const mods = parseMods(args.modifiers);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',x,y,modifiers:mods});
      await sleep(50);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:btn,clickCount:cnt,modifiers:mods});
      await sleep(50);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:btn,clickCount:cnt,modifiers:mods});
      if (btn==='right') await sleep(300);
      return ok([{type:'text',text:`${action} at (${Math.round(x)},${Math.round(y)})`}]);
    }
  }
}
async function toolReadPage(args) {
  const tabId = args.tabId; if (!tabId) return err('tabId required');
  await ensureCs(tabId);
  const filter = args.filter||'all', depth = args.depth||15, maxChars = args.max_chars||50000;
  const refId = args.ref_id||null;
  const [r] = await chrome.scripting.executeScript({
    target:{tabId},
    func:(f,d,m,ri)=>{
      const t = globalThis.__accessibilityTree;
      return t ? t.generate(f,d,m,ri) : {error:'Accessibility tree not available'};
    },
    args:[filter,depth,maxChars,refId],
  });
  const res = r?.result;
  if (!res||res.error) return err(res?.error||'Failed to generate page tree');
  const tree = res.tree||'(empty)';
  const trunc = res.truncated ? ', truncated — use ref_id or increase max_chars' : '';
  return ok([{type:'text',text:`Page tree (${res.elementCount||0} elements, filter:${filter}${trunc}):\n\n${tree}`}]);
}

async function toolFind(args) {
  const tabId = args.tabId; if (!tabId) return err('tabId required');
  await ensureCs(tabId);
  const [r] = await chrome.scripting.executeScript({
    target:{tabId},
    func:(q,max)=>{
      const b = globalThis.__pageBridge;
      return b ? b.searchElements(q,max) : [];
    },
    args:[args.query||'', args.max_results||20],
  });
  const items = r?.result||[];
  if (!items.length) return ok([{type:'text',text:`No elements found matching: "${args.query}"`}]);
  const lines = items.map((el,i)=>`${i+1}. [${el.ref}] ${el.role} - "${el.text}" (score:${el.score})`);
  return ok([{type:'text',text:`Found ${items.length} elements:\n\n${lines.join('\n')}`}]);
}

async function toolFormInput(args) {
  const {tabId,ref,value} = args;
  if (!tabId) return err('tabId required');
  if (!ref) return err('ref required');
  await ensureCs(tabId);
  const [r] = await chrome.scripting.executeScript({
    target:{tabId},
    func:(ref,value)=>{
      const tree = globalThis.__accessibilityTree;
      if (!tree) return {success:false,error:'Accessibility tree not available'};
      const el = tree.getElementByRef(ref);
      if (!el) return {success:false,error:`Element not found: ${ref}`};
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
    },
    args:[ref,value],
  });
  const res = r?.result;
  if (!res?.success) return err(res?.error||'Failed to set value');
  return ok([{type:'text',text:`Set value for ${res.fieldName}`}]);
}
async function toolNavigate(args) {
  const {tabId, url, force=false} = args;
  if (!tabId) return err('tabId required');
  if (!url) return err('url required');

  const RESTRICTED = /^(chrome|chrome-extension|edge|devtools|about|javascript):/i;

  if (url === 'back' || url === 'forward') {
    const before = (await chrome.tabs.get(tabId)).url;
    try {
      url === 'back' ? await chrome.tabs.goBack(tabId) : await chrome.tabs.goForward(tabId);
    } catch {
      await chrome.scripting.executeScript({target:{tabId},
        func:d=>d==='back'?history.back():history.forward(), args:[url]});
    }
    await waitForLoad(tabId, 5000);
    const after = (await chrome.tabs.get(tabId));
    if (after.url === before) return ok([{type:'text',text:`Cannot go ${url}: no page in history`}]);
    return ok([{type:'text',text:`Navigated ${url} to: ${after.url}\nTitle: ${after.title}`}]);
  }

  let finalUrl = url.trim();
  if (RESTRICTED.test(finalUrl)) return err(`Blocked URL: ${finalUrl}`);
  if (!/^https?:\/\//i.test(finalUrl) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(finalUrl))
    finalUrl = 'https://' + finalUrl;
  if (RESTRICTED.test(finalUrl)) return err(`Blocked URL: ${finalUrl}`);

  const t0 = Date.now();
  await chrome.tabs.update(tabId, {url: finalUrl});
  await waitForLoad(tabId, 10000);
  const tab = await chrome.tabs.get(tabId);
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

async function toolJavascript(args) {
  const {tabId, text} = args;
  if (!tabId) return err('tabId required');
  if (!text) return err('text required');
  if (text.length > 100000) return err('Code too long (max 100000 chars)');
  await ensureCdp(tabId);

  // Try scripting API first, fall back to CDP
  try {
    const [r] = await chrome.scripting.executeScript({
      target:{tabId},
      func:code=>{try{return{ok:true,v:(0,eval)(`(${code})`)}}catch{try{(0,eval)(code);return{ok:true,v:undefined}}catch(e){return{ok:false,e:e.message}}}},
      args:[text],
    });
    const res = r?.result;
    if (res?.ok === false) throw new Error(res.e);
    const out = formatJsResult(res?.v);
    return ok([{type:'text',text:out.length>50000?out.slice(0,50000)+'\n...[truncated]':out}]);
  } catch {
    // CDP fallback
    const cdpRes = await chrome.debugger.sendCommand({tabId},'Runtime.evaluate',
      {expression:`(${text})`,returnByValue:true,awaitPromise:true});
    if (cdpRes.exceptionDetails) {
      const msg = cdpRes.exceptionDetails.exception?.description || cdpRes.exceptionDetails.text;
      // If expression syntax error, wrap as statement
      if (/SyntaxError/.test(msg)) {
        const stmtRes = await chrome.debugger.sendCommand({tabId},'Runtime.evaluate',
          {expression:`(async function(){${text}})()`,returnByValue:true,awaitPromise:true});
        if (stmtRes.exceptionDetails) throw new Error(stmtRes.exceptionDetails.exception?.description||'JS error');
        return ok([{type:'text',text:formatJsResult(stmtRes.result?.value)}]);
      }
      throw new Error(msg);
    }
    return ok([{type:'text',text:formatJsResult(cdpRes.result?.value)}]);
  }
}

function formatJsResult(v) {
  if (v === undefined || v === null) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

async function toolGetPageText(args) {
  const tabId = args.tabId; if (!tabId) return err('tabId required');
  await ensureCs(tabId);
  const maxChars = args.max_chars||50000;
  const [r] = await chrome.scripting.executeScript({
    target:{tabId},
    func:max=>{const b=globalThis.__pageBridge; return b?b.getPageText(max):{error:'Page bridge not available'};},
    args:[maxChars],
  });
  const res = r?.result;
  if (!res||res.error) return err(res?.error||'Failed to get page text');
  if (!res.content) return ok([{type:'text',text:'(no text content)'}]);
  return ok([{type:'text',text:`Title: ${res.title||'N/A'}\nURL: ${res.url||'N/A'}\n\n${res.content}`}]);
}
async function toolFileUpload(args) {
  const {tabId, paths, ref, triggerRef} = args;
  if (!tabId) return err('tabId required');
  if (!paths?.length) return err('paths required');
  await ensureCdp(tabId);

  if (ref) {
    // Direct file input via ref
    await ensureCs(tabId);
    const root = (await chrome.debugger.sendCommand({tabId},'DOM.getDocument')).root.nodeId;
    // Mark element with token to find it via CDP
    const token = `bmcp-${Date.now()}`;
    await chrome.scripting.executeScript({
      target:{tabId},
      func:(r,t,attr)=>{const el=globalThis.__accessibilityTree?.getElementByRef(r); if(el)el.setAttribute(attr,t);},
      args:[ref, token, 'data-bmcp-token'],
    });
    const {nodeId} = await chrome.debugger.sendCommand({tabId},'DOM.querySelector',
      {nodeId:root, selector:`input[type="file"][data-bmcp-token="${token}"]`});
    if (!nodeId) return err('Could not locate file input in DOM');
    await chrome.debugger.sendCommand({tabId},'DOM.setFileInputFiles',{files:paths,nodeId});
    // cleanup token
    await chrome.scripting.executeScript({target:{tabId},
      func:attr=>document.querySelector(`[${attr}]`)?.removeAttribute(attr),args:['data-bmcp-token']}).catch(()=>{});
    return ok([{type:'text',text:`File(s) set on input ${ref}: ${paths.join(', ')}`}]);
  }

  if (triggerRef) {
    // Intercept file chooser
    await chrome.debugger.sendCommand({tabId},'Page.setInterceptFileChooserDialog',{enabled:true});
    try {
      // Click trigger
      await ensureCs(tabId);
      const [cr] = await chrome.scripting.executeScript({
        target:{tabId},
        func:r=>{const el=globalThis.__accessibilityTree?.getElementCoordinates(r,{scrollIntoView:true}); return el||null;},
        args:[triggerRef],
      });
      if (!cr?.result) return err(`Trigger element not found: ${triggerRef}`);
      const {x,y} = cr.result;
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
      await sleep(50);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
      await sleep(50);
      await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});

      // Wait for chooser event
      const chooser = await new Promise((resolve,reject)=>{
        const tid = setTimeout(()=>{chrome.debugger.onEvent.removeListener(h);reject(new Error('File chooser timeout'));},5000);
        function h(src,method,params){
          if(src.tabId===tabId && method==='Page.fileChooserOpened'){
            clearTimeout(tid); chrome.debugger.onEvent.removeListener(h); resolve(params);
          }
        }
        chrome.debugger.onEvent.addListener(h);
      });
      if (!chooser.backendNodeId) return err('File chooser opened without target input');
      await chrome.debugger.sendCommand({tabId},'DOM.setFileInputFiles',{files:paths,backendNodeId:chooser.backendNodeId});
      return ok([{type:'text',text:`File(s) uploaded via ${triggerRef}: ${paths.join(', ')}`}]);
    } finally {
      await chrome.debugger.sendCommand({tabId},'Page.setInterceptFileChooserDialog',{enabled:false}).catch(()=>{});
    }
  }

  return err('Provide ref (input[type=file]) or triggerRef (upload button)');
}

async function toolResizeWindow(args) {
  const {tabId, width=1280, height=720} = args;
  const w = Math.max(400,Math.min(7680,width)), h = Math.max(300,Math.min(4320,height));
  let winId;
  if (tabId) { try { winId=(await chrome.tabs.get(tabId)).windowId; } catch {} }
  if (!winId) { const [win]=await chrome.windows.getAll({populate:false}); winId=win?.id; }
  if (!winId) return err('No window found');
  await chrome.windows.update(winId,{width:w,height:h});
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

async function toolReadNetwork(args) {
  const {tabId, urlPattern, clear=false, limit=100} = args;
  if (!tabId) return err('tabId required');
  await ensureCdp(tabId);
  const buf = tabBuf(tabId);
  let reqs = [...buf.network];
  if (urlPattern) reqs=reqs.filter(r=>r.url.includes(urlPattern));
  reqs=reqs.slice(-limit);
  if (clear) buf.network=[];
  if (!reqs.length) return ok([{type:'text',text:'No network requests'}]);
  const lines=reqs.map(r=>`${r.method.padEnd(4)} ${String(r.status||'---').padStart(3)} [${(r.type||'other').slice(0,10).padEnd(10)}] ${r.url}`);
  return ok([{type:'text',text:`Network (${reqs.length}${clear?', cleared':''}):\n\n${lines.join('\n')}`}]);
}

async function toolTabsContext(_args) {
  const tabs = await chrome.tabs.query({});
  const filtered = tabs.filter(t=>!/^(chrome|chrome-extension|devtools|about):/.test(t.url||''));
  const lines = filtered.map((t,i)=>`${i+1}. [${t.id}]${t.active?' [ACTIVE]':''} "${t.title||'Untitled'}"\n   ${t.url}`);
  return ok([{type:'text',text:`Open tabs (${filtered.length}):\n\n${lines.join('\n')}`}]);
}

async function toolTabsCreate(_args) {
  const tab = await chrome.tabs.create({url:'about:blank',active:true});
  await sleep(300);
  return ok([{type:'text',text:`Created tab [${tab.id}]`}]);
}

async function toolTabsClose(args) {
  if (!args.tabId) return err('tabId required');
  await chrome.tabs.remove(args.tabId);
  return ok([{type:'text',text:`Closed tab [${args.tabId}]`}]);
}

const TOOL_MAP = {
  computer: toolComputer, read_page: toolReadPage, find: toolFind,
  form_input: toolFormInput, navigate: toolNavigate,
  javascript_tool: toolJavascript, get_page_text: toolGetPageText,
  file_upload: toolFileUpload, resize_window: toolResizeWindow,
  read_console_messages: toolReadConsole, read_network_requests: toolReadNetwork,
  tabs_context: toolTabsContext, tabs_create: toolTabsCreate, tabs_close: toolTabsClose,
};

// ── Response helpers ──────────────────────────────────────────────────────────
function ok(content) { return { content }; }
function err(msg) { return { content:[{type:'text',text:`Error: ${msg}`}], isError:true }; }

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
      const result = await Promise.race([
        handler(args),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error(`Tool timeout: ${tool}`)),TOOL_TIMEOUT)),
      ]);
      sendMsg({id:msg.id, result});
    } catch(e) {
      sendMsg({id:msg.id, error:{code:'INTERNAL_ERROR',message:e.message||String(e)}});
    }
  }
}

// ── Chrome event listeners ────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener((src, method, params) => {
  const tabId = src.tabId; if (!tabId) return;
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

  if (method === 'Network.requestWillBeSent') {
    buf.network.push({
      requestId: params.requestId,
      method: params.request?.method||'GET',
      url: params.request?.url||'',
      type: params.type||'Other',
      timestamp: Date.now(),
      status: null, mimeType: null,
    });
    if (buf.network.length > 500) buf.network.shift();
  }

  if (method === 'Network.responseReceived') {
    const req = buf.network.find(r=>r.requestId===params.requestId&&r.status===null);
    if (req) { req.status=params.response?.status||0; req.mimeType=params.response?.mimeType||''; }
  }

  if (method === 'Page.javascriptDialogOpening' && params.type==='alert') {
    chrome.debugger.sendCommand({tabId},'Page.handleJavaScriptDialog',{accept:true}).catch(()=>{});
  }
});

chrome.debugger.onDetach.addListener(src => {
  if (src.tabId) cdpReady.delete(src.tabId);
});

chrome.tabs.onRemoved.addListener(tabId => {
  tabEventBuffers.delete(tabId);
  cdpReady.delete(tabId);
  csInjected.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    csInjected.delete(tabId);
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

// ── Boot ──────────────────────────────────────────────────────────────────────
connect();
