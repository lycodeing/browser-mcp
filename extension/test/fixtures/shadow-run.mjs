// Shadow DOM 验证：用 CDP 注入内容脚本，检查 open shadow root、slot 分配与 find 递归。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const WebSocket = createRequire(path.join(root, 'relay/package.json'))('ws');
const src = (f) => readFileSync(path.join(root, 'extension/content-scripts', f), 'utf8');

const PORT = 9334;
const profile = mkdtempSync(path.join(tmpdir(), 'bmcp-shadow-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = async () => {
  chrome.kill();
  await new Promise((r) => { chrome.once('exit', r); setTimeout(r, 3000); });
  for (let i = 0; i < 5; i++) { try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); } }
};

const html = `<body><h1>Shell</h1>
<x-card id="c"><button id="slotted">Slotted Btn</button></x-card>
<script>
customElements.define('x-card', class extends HTMLElement {
  constructor(){ super(); const r = this.attachShadow({mode:'open'});
    r.innerHTML = '<button id="inner">Shadow Btn</button><div><slot></slot></div><x-leaf></x-leaf>'; }
});
customElements.define('x-leaf', class extends HTMLElement {
  constructor(){ super(); this.attachShadow({mode:'open'}).innerHTML = '<input placeholder="Nested Input">'; }
});
customElements.define('x-closed', class extends HTMLElement {
  constructor(){ super(); this.attachShadow({mode:'closed'}).innerHTML = '<button>Closed Btn</button>'; }
});
document.body.append(document.createElement('x-closed'));
</script></body>`;

try {
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch {}
    await sleep(250);
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0; const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
  await sleep(1200);
  await ev(src('accessibility-tree.js')); await ev(src('page-bridge.js'));

  const tree = await ev(`globalThis.__accessibilityTree.generate('all', 15, 50000, null).tree`);
  const inter = await ev(`globalThis.__accessibilityTree.generate('interactive', 15, 50000, null).tree`);
  const found = await ev(`globalThis.__pageBridge.searchElements('btn', 20).map(r => r.text)`);
  const nested = await ev(`globalThis.__pageBridge.searchElements('Nested', 5).map(r => r.ref)`);
  console.log('--- tree ---\n' + tree + '\n--- interactive ---\n' + inter);
  console.log('find "btn":', JSON.stringify(found), '| find Nested:', JSON.stringify(nested));

  const checks = {
    'open shadow 内按钮可见': /Shadow Btn/.test(tree),
    'slot 分配的元素出现': /Slotted Btn/.test(tree),
    '嵌套 shadow 内输入框可见': /Nested Input/.test(tree),
    'slot 内容不重复出现': (tree.match(/Slotted Btn/g) || []).length === 1,
    'find 进入 shadow root': found.includes('Shadow Btn') && found.includes('Slotted Btn'),
    'find 进入嵌套 shadow': nested.length === 1,
    'find 结果无重复': new Set(found).size === found.length,
    'closed shadow 不可见（已知限制）': !/Closed Btn/.test(tree),
  };
  for (const [k, v] of Object.entries(checks)) console.log(v ? 'PASS' : 'FAIL', k);
  console.log(Object.values(checks).every(Boolean) ? 'SHADOW PASS' : 'SHADOW FAIL');
  ws.close();
} catch (e) { console.log('SHADOW ERROR', e.message); } finally { await cleanup(); }
