# browser-mcp 全面优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复所有已知 Bug（含 find→click 链路断裂），消除性能瓶颈，清理无效代码，使项目整体质量从可用提升为可靠。

**Architecture:** Extension (background.js + content-scripts) 与 Relay (Node.js MCP server) 分开维护；本次优化不改变通信协议，仅改动各层内部实现。accessibility-tree.js 暴露新方法 `getOrAssignRef(el)` 供 page-bridge.js 调用，消除两个 IIFE 间的 ref 断链。

**Tech Stack:** Chrome Extension MV3 / CDP / Node.js ESM / @modelcontextprotocol/sdk / express / ws / zod

## Global Constraints

- 不改变任何 MCP 工具的对外名称、参数、返回格式
- 不引入新的 npm 依赖
- 所有文件保持 UTF-8 无 BOM，无 AI 署名 commit

---

## File Structure

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `extension/content-scripts/accessibility-tree.js` | Modify | 修复 isVisible 逻辑；新增 `getOrAssignRef(el)` 方法 |
| `extension/content-scripts/page-bridge.js` | Modify | 修复 searchElements ref 解析；用 getOrAssignRef 获取真实 ref |
| `extension/background.js` | Modify | 修复 CDP 导航后失效；优化 type/waitForLoad；删除死代码 |
| `extension/popup.js` | Modify | 显示重连次数与 relay URL；retry 按钮触发真实重连 |
| `relay/src/mcp-server.js` | Modify | McpServer 实例复用（单例），不再每次请求重建 |

---

## Task 1: 修复 accessibility-tree.js — isVisible 逻辑 + 暴露 getOrAssignRef

**Files:**
- Modify: `extension/content-scripts/accessibility-tree.js`

**Interfaces:**
- Produces: `globalThis.__accessibilityTree.getOrAssignRef(el: Element): string`

- [ ] **Step 1: 定位并修复 isVisible 的 || 错误**

文件第 27 行，将：
```js
return r.width > 0 || r.height > 0;
```
改为：
```js
return r.width > 0 && r.height > 0;
```

- [ ] **Step 2: 在导出对象末尾新增 getOrAssignRef 方法**

在 `globalThis.__accessibilityTree = { ... }` 的最后一个方法 `getElementCoordinates` 之后追加：
```js
    getOrAssignRef(el) {
      return assignRef(el);
    },
```

- [ ] **Step 3: 手动验证**

在 Chrome DevTools Console（已注入内容脚本的标签页）执行：
```js
// 应返回同一个 ref（不重复创建）
const el = document.querySelector('a');
const r1 = globalThis.__accessibilityTree.getOrAssignRef(el);
const r2 = globalThis.__accessibilityTree.getOrAssignRef(el);
console.assert(r1 === r2, 'ref 应稳定不变');
console.assert(r1.startsWith('ref_'), 'ref 格式正确');
```

- [ ] **Step 4: Commit**
```bash
git add extension/content-scripts/accessibility-tree.js
git commit -m "fix(ext): 修复 isVisible 逻辑，暴露 getOrAssignRef 供 page-bridge 使用"
```

## Task 2: 修复 page-bridge.js — searchElements ref 解析（find→click 链路断裂）

**Files:**
- Modify: `extension/content-scripts/page-bridge.js`

**Interfaces:**
- Consumes: `globalThis.__accessibilityTree.getOrAssignRef(el: Element): string`（Task 1 产出）
- Produces: `searchElements` 返回的每个 result.ref 与 accessibility-tree refMap 互通

**背景：** 当前 `searchElements` 中 ref 解析是两个永远返回 `null` 的立即执行箭头函数，结果全是 `search_1`、`search_2`，这些 ref 在 accessibility-tree 的 refMap 里不存在，导致 `find` 结果传给 `computer/form_input` 后报"Element not found"。

- [ ] **Step 1: 替换 searchElements 中的 ref 解析逻辑**

将文件中 `results.push({` 之前的整段死代码（约第 73–87 行）替换为：
```js
        const tree = globalThis.__accessibilityTree;
        const ref = tree ? tree.getOrAssignRef(el) : `search_${results.length + 1}`;
```

完整的 `for` 循环体应变为：
```js
    for (const el of allEls) {
      if (!isInteractive(el) || !isVisible(el)) continue;
      const s = score(el);
      if (s > 0) {
        const tree = globalThis.__accessibilityTree;
        const ref = tree ? tree.getOrAssignRef(el) : `search_${results.length + 1}`;
        results.push({
          ref,
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          text: ((el.innerText || el.textContent || el.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ').trim()).slice(0, 100),
          score: s,
          element: el,
        });
      }
    }
```

- [ ] **Step 2: 手动验证**

在 Chrome DevTools Console 执行：
```js
const results = globalThis.__pageBridge.searchElements('Submit');
// ref 应为 ref_N 格式，且能通过 accessibility-tree 找到元素
results.forEach(r => {
  const el = globalThis.__accessibilityTree.getElementByRef(r.ref);
  console.assert(el !== null, `ref ${r.ref} 必须在 refMap 中存在`);
});
```

- [ ] **Step 3: Commit**
```bash
git add extension/content-scripts/page-bridge.js
git commit -m "fix(ext): 修复 searchElements ref 解析，find→click 链路恢复可用"
```

## Task 3: background.js — 删除死代码 + 修复 CDP 导航后失效

**Files:**
- Modify: `extension/background.js`

**背景：**
1. `beforeunloadPolicies` / `beforeunloadResults` 声明后从未写入也从未读取，`navigate` 的 `force` 参数是哑参数。
2. `chrome.tabs.onUpdated` 只清理了 `csInjected`，没有清理 `cdpReady`，导致页面跳转后 CDP 仍被视为已附加，下次工具调用时使用过期 session 报错。

- [ ] **Step 1: 删除未使用的死代码（State 块第 17-20 行）**

删除以下两行声明：
```js
// tabId -> policy ('accept'|'dismiss'|'none')
const beforeunloadPolicies = new Map();
// tabId -> { handled, accepted }
const beforeunloadResults = new Map();
```

- [ ] **Step 2: chrome.tabs.onUpdated 补充清理 cdpReady**

将：
```js
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') csInjected.delete(tabId);
});
```
改为：
```js
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    csInjected.delete(tabId);
    // 页面开始加载时 CDP 会话失效，需重新附加
    cdpDetach(tabId).catch(() => {});
  }
});
```

- [ ] **Step 3: 验证 chrome.tabs.onRemoved 同样清理完整**

检查现有 `chrome.tabs.onRemoved` 监听器，确认已包含：
```js
chrome.tabs.onRemoved.addListener(tabId => {
  tabEventBuffers.delete(tabId);
  cdpReady.delete(tabId);
  csInjected.delete(tabId);
  beforeunloadPolicies.delete(tabId);  // ← 这两行随 Step 1 一起删除
  beforeunloadResults.delete(tabId);   // ← 删除
});
```
删除后变为：
```js
chrome.tabs.onRemoved.addListener(tabId => {
  tabEventBuffers.delete(tabId);
  cdpReady.delete(tabId);
  csInjected.delete(tabId);
});
```

- [ ] **Step 4: Commit**
```bash
git add extension/background.js
git commit -m "fix(ext): 删除 beforeunload 死代码，修复导航后 CDP session 失效"
```

## Task 4: background.js — type 动作改用 Input.insertText 提速

**Files:**
- Modify: `extension/background.js`

**背景：** 当前 `type` 动作逐字符发送三次 CDP 事件（keyDown / char / keyUp），每字间隔 20ms，输入 100 个字符需 2s+。CDP 提供 `Input.insertText` 可一次批量插入纯文本，仅对换行符保留逐字符方式。

- [ ] **Step 1: 替换 toolComputer 中的 type case**

将现有 `case 'type':` 整块替换为：
```js
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
```

- [ ] **Step 2: 手动验证**

在任意文本输入框执行 `computer { action:"type", tabId, text:"hello\nworld" }`，
预期：输入框出现两行文字，耗时 < 200ms（原来 > 200ms）。

- [ ] **Step 3: Commit**
```bash
git add extension/background.js
git commit -m "perf(ext): type 动作改用 Input.insertText 批量发送，消除逐字符延迟"
```

## Task 5: background.js — waitForLoad 改为事件驱动

**Files:**
- Modify: `extension/background.js`

**背景：** 当前 `waitForLoad` 每 100ms 轮询 `chrome.tabs.get`，最多执行 100 次 API 调用。改用 `chrome.tabs.onUpdated` 事件监听，0 等待开销，更快响应。

- [ ] **Step 1: 替换 waitForLoad 实现**

将现有函数：
```js
async function waitForLoad(tabId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now()-t0 < timeoutMs) {
    try { if ((await chrome.tabs.get(tabId)).status === 'complete') return true; } catch { return false; }
    await sleep(100);
  }
  return false;
}
```
替换为：
```js
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
```

- [ ] **Step 2: 手动验证**

调用 `navigate { tabId, url: "https://example.com" }`，预期：
- 响应包含 `Navigated to: https://example.com`
- 导航耗时比之前更准确（不再以 100ms 为粒度）

- [ ] **Step 3: Commit**
```bash
git add extension/background.js
git commit -m "perf(ext): waitForLoad 改为事件驱动，消除 100ms 轮询开销"
```

## Task 6: popup.js — 显示重连信息，retry 触发真实重连

**Files:**
- Modify: `extension/popup.js`
- Modify: `extension/popup.html`（仅增加 relay URL 显示区域）
- Modify: `extension/background.js`（getStatus 响应补充 reconnectAttempt）

**背景：** 当前 retry 按钮只是重新查询状态，不触发重连；disconnected 时用户不知道已重试多少次、连接目标是哪里。

- [ ] **Step 1: background.js — getStatus 响应已包含 reconnectAttempt（已有，确认即可）**

检查 `chrome.runtime.onMessage` 里 `getStatus` 分支，确认返回：
```js
reply({
  connected: ws?.readyState === WebSocket.OPEN,
  relayUrl: RELAY_URL,
  reconnectAttempt,
});
```
如已是此格式，无需改动。

- [ ] **Step 2: background.js — 新增 reconnect 消息处理**

在 `onMessage` 的 `if (msg.type === 'getStatus')` 块之后追加：
```js
  if (msg.type === 'reconnect') {
    stopped = false;
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    connect();
    reply({ ok: true });
  }
```

- [ ] **Step 3: popup.html — 新增 relay-url 和 retry-count 展示元素**

在现有状态徽章下方（`<div id="status-badge">` 之后）追加：
```html
<div id="relay-url" style="font-size:11px;color:#888;margin-top:4px;word-break:break-all"></div>
<div id="retry-count" style="font-size:11px;color:#aaa"></div>
```

- [ ] **Step 4: popup.js — 更新 updateUI 展示重连信息，retry 触发真实重连**

将整个 `popup.js` 替换为：
```js
// popup.js
function updateUI(status) {
  const dot = document.getElementById('dot');
  const badge = document.getElementById('status-badge');
  const relayUrl = document.getElementById('relay-url');
  const retryCount = document.getElementById('retry-count');

  if (status.connected) {
    dot.className = 'green';
    badge.className = 'badge badge-green';
    badge.textContent = 'Connected';
  } else {
    dot.className = 'red';
    badge.className = 'badge badge-red';
    badge.textContent = 'Disconnected';
  }

  if (relayUrl) relayUrl.textContent = status.relayUrl || '';
  if (retryCount && !status.connected) {
    retryCount.textContent = status.reconnectAttempt > 0
      ? `已重试 ${status.reconnectAttempt} 次` : '';
  } else if (retryCount) {
    retryCount.textContent = '';
  }
}

chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
  if (res) updateUI(res);
});

document.getElementById('retry-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
    // 300ms 后刷新状态
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
        if (res) updateUI(res);
      });
    }, 300);
  });
});
```

- [ ] **Step 5: 手动验证**

断开 relay（Ctrl+C），点击扩展图标，预期：
- 状态显示 Disconnected
- relay URL 显示 `ws://127.0.0.1:16789`
- 重试次数随时间递增
- 点击 retry 按钮后立即触发重连（不需等待下一个 backoff 周期）

- [ ] **Step 6: Commit**
```bash
git add extension/background.js extension/popup.js extension/popup.html
git commit -m "feat(ext): popup 显示 relay URL 和重试次数，retry 按钮触发真实重连"
```

## Task 7: relay/mcp-server.js — McpServer 单例复用

**Files:**
- Modify: `relay/src/mcp-server.js`

**背景：** 当前每次 HTTP 请求都调用 `buildMcpServer()`，重复注册全部 14 个工具，创建新的 `McpServer` 和 `StreamableHTTPServerTransport` 实例。MCP SDK 的 `StreamableHTTPServerTransport` 本身设计为无状态（每请求一个 transport），但 `McpServer` 可以复用——只需在 `startMcpServer` 时创建一次，每次请求只 new transport。

- [ ] **Step 1: 将 buildMcpServer 调用移到 startMcpServer 外层（模块级单例）**

将 `startMcpServer` 函数修改为：
```js
export function startMcpServer(port = 3000) {
  const app = express();
  app.use(express.json());

  // 单例：模块启动时构建一次，所有请求复用
  const mcpServer = buildMcpServer();

  // Status endpoint
  app.get('/', (_req, res) => {
    const info = getExtensionInfo();
    res.json({
      service: 'browser-mcp-relay',
      version: '1.0.0',
      extension: info,
    });
  });

  // MCP endpoint — stateless transport，每请求一个，但 server 复用
  app.all('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    res.on('close', () => {
      transport.close();
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[MCP] Request error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  app.listen(port, '127.0.0.1', () => {
    console.log(`[Relay] MCP HTTP server listening on http://127.0.0.1:${port}/mcp`);
  });

  return app;
}
```

注意：移除 `res.on('close')` 中的 `server.close()`，因为 server 是单例不应在每次请求后关闭。

- [ ] **Step 2: 验证 relay 正常启动**

```bash
cd relay && npm start
```
预期输出：
```
[Relay] browser-mcp relay started
  Extension WS : ws://127.0.0.1:16789
  MCP endpoint : http://127.0.0.1:3000/mcp
[Relay] Extension WS server listening on ws://127.0.0.1:16789
[Relay] MCP HTTP server listening on http://127.0.0.1:3000/mcp
```

- [ ] **Step 3: 验证 MCP 工具列表可访问**

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
  python3 -m json.tool | grep '"name"'
```
预期：列出 14 个工具（computer、read_page、find 等）

- [ ] **Step 4: Commit**
```bash
git add relay/src/mcp-server.js
git commit -m "perf(relay): McpServer 改为单例，消除每次请求重建工具注册的开销"
```

---

## Task 8: background.js — 截图尺寸超 2000px 时自动缩放

**Files:**
- Modify: `extension/background.js`

**背景：** Bedrock 等多图请求场景下，单张图片任意维度超过 2000px 会触发 `IMAGE_DIMENSION_EXCEEDED` 错误。CDP `Page.captureScreenshot` 支持 `clip` + `scale` 参数，可在截图时直接缩放，无需引入 canvas 或额外依赖。

- [ ] **Step 1: 修改 captureScreenshot，获取视口尺寸并在超限时缩放**

将现有 `captureScreenshot` 函数替换为：
```js
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
```

- [ ] **Step 2: zoom action 同步缩放处理**

`zoom` case 中的截图使用固定 `clip` 区域，本身不受整页尺寸影响，无需改动。确认 `zoom` 的 clip 宽高不会超过 2000px 即可（clip 由调用方传入 region 参数决定）。

- [ ] **Step 3: 手动验证**

在分辨率 > 2000px 的高分屏上执行截图：
```
computer { action: "screenshot", tabId, quality: "low" }
```
预期：
- 返回图片的宽高均 ≤ 2000px
- 不再出现 `IMAGE_DIMENSION_EXCEEDED` 错误

在 ≤ 2000px 的普通屏幕上执行截图，预期 scale=1，行为与之前完全一致。

- [ ] **Step 4: Commit**
```bash
git add extension/background.js
git commit -m "fix(ext): 截图超过 2000px 时自动缩放，兼容 Bedrock 多图请求限制"
```
