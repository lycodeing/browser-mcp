// E1：用 CDP 向每个 frame 注入 frame-link.js，验证握手 + resolveFrameOffset 的点击坐标。
// 品牌版 Chrome 无法 --load-extension，这里用 Runtime.evaluate 近似 content script 注入（隔离性不同，握手逻辑相同）。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const WebSocket = createRequire(path.join(root, 'relay/package.json'))('ws');
const { resolveFrameOffset, toTopPoint } = await import(pathToFileURL(path.join(root, 'extension/lib/frames.js')).href);
const linkSrc = readFileSync(path.join(root, 'extension/content-scripts/frame-link.js'), 'utf8');

const PORT = 9333;
const profile = mkdtempSync(path.join(tmpdir(), 'bmcp-e1-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new',
  '--no-first-run', '--window-size=900,700', 'about:blank',
], { stdio: 'ignore' });
const server = spawn('node', [path.join(here, 'e1-server.js')], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = async () => {
  chrome.kill(); server.kill();
  await new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once('exit', r)));
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
};

try {
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0; const pending = new Map(); const ctxByFrame = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.executionContextCreated') {
      const c = m.params.context;
      if (c.auxData?.isDefault && c.auxData.frameId) ctxByFrame.set(c.auxData.frameId, c.id);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:9401/' });
  await sleep(2500);

  const flat = [];
  (function walk(n, depth) { flat.push({ id: n.frame.id, url: n.frame.url, depth }); (n.childFrames || []).forEach((c) => walk(c, depth + 1)); })((await send('Page.getFrameTree')).frameTree, 0);
  console.log('frames:', flat.map((f) => `${f.depth}:${f.url}`).join(' | '));

  const evalIn = async (frameId, expression) => {
    const r = await send('Runtime.evaluate', { contextId: ctxByFrame.get(frameId), expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (const f of flat) await evalIn(f.id, linkSrc);
  // 与扩展一致：所有 frame 并行 link() 再 collect()
  await Promise.all(flat.map((f) => evalIn(f.id, 'globalThis.__frameLink.link()')));
  const infos = [];
  for (const f of flat) {
    const c = await evalIn(f.id, 'globalThis.__frameLink.collect()');
    infos.push({ ...c, frameId: f.depth === 0 ? 0 : f.depth, cdpId: f.id });
  }
  console.log('links:', infos.map((i) => `d${i.frameId} parent=${i.parentToken ? 'ok' : 'NONE'} kids=${i.children.length}`).join(' | '));

  const leaf = infos.find((i) => i.frameId === 2);
  const results = [];
  for (const spec of ['near', 'far', 'near@mid60', 'far@mid60']) {
    const [btn, scrollSpec] = spec.split('@');
    // 中间层页面滚动后偏移必须现读，验证 collect() 没有读到缓存
    if (scrollSpec) await evalIn(flat[1].id, 'scrollTo(0, 60)');
    // 与扩展一致：先在目标 frame 里 scrollIntoView 再读 rect
    const pt = await evalIn(leaf.cdpId, `(() => { const b = document.getElementById('${btn}'); b.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'}); const r = b.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`);
    const scrolls = [];
    for (const f of flat.slice(0, 2)) scrolls.push(await evalIn(f.id, 'scrollY'));
    // 滚动之后重新采集（偏移受父 frame 滚动影响）
    const fresh = [];
    for (const f of flat) fresh.push({ ...(await evalIn(f.id, 'globalThis.__frameLink.collect()')), frameId: f.depth, cdpId: f.id });
    const off = resolveFrameOffset(2, fresh);
    const [tx, ty] = toTopPoint(off, [pt.x, pt.y]);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tx, y: ty });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1 });
    await sleep(100);
    const clicks = await evalIn(leaf.cdpId, 'window.__clicks');
    const last = clicks[clicks.length - 1];
    results.push({ btn, expected: pt, got: last, topPoint: [tx, ty], parentScrollY: scrolls, dx: last ? last.x - pt.x : null, dy: last ? last.y - pt.y : null });
  }
  console.log(JSON.stringify(results, null, 2));
  const ok = results.every((r) => r.got && r.got.id === r.btn && r.got.trusted && Math.abs(r.dx) <= 2 && Math.abs(r.dy) <= 2);
  console.log(ok ? 'E1 PASS' : 'E1 FAIL');
  ws.close();
} catch (e) { console.log('E1 ERROR', e.message); } finally { await cleanup(); }
