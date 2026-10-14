# browser-mcp 功能扩展技术设计（v1.1）

> 状态：待确认 → 确认后编码
> 范围：截图增强 / 自动化可靠性 / PDF 导出 / Cookie 与下载管理

## 1. 背景与现状

browser-mcp 由三部分组成：

```
MCP 客户端（pi / ZCode / Claude Code）
    │  streamable-http  http://127.0.0.1:3000/mcp
    ▼
relay（Node，MCP SDK + zod schema）src/mcp-server.js 217 行
    │  WebSocket  ws://127.0.0.1:16789
    ▼
Chrome 扩展（MV3 Service Worker）extension/background.js 775 行
    │  chrome.debugger（CDP 1.3：Page / Runtime / Network 已启用）
    │  content scripts（a11y 树 / 文本提取）
    ▼
目标标签页
```

现有 14 个工具：computer、read_page、find、form_input、navigate、javascript_tool、
get_page_text、file_upload、resize_window、read_console_messages、read_network_requests、
tabs_context、tabs_create、tabs_close。

截图现状（v1.1 起）：CDP `Page.captureScreenshot` 先以 JPEG 92 / PNG 取回按 CSS 像素缩小的
位图，再由扩展内 `OffscreenCanvas` 缩放到长边 ≤ `maxDimension`（默认 1280）并按目标 `format` /
`quality` 重新编码；quality 三档为 low 45 / medium 65 / high 85。`zoom` action 按区域截取，
保留区域原生清晰度。

## 2. 设计原则

1. **向后兼容**：现有 14 个工具的参数与返回结构不变；新能力以新增可选参数 / 新工具为主。
   `computer.quality` 扩展为 `enum | number` 联合类型，旧值仍有效。
2. **CDP 能力优先**：webp、全页截图、PDF 全部是 `chrome.debugger` 已启用域或单条命令
   即可获得的能力，不引入新依赖（relay 不新增任何 npm 包）。
3. **本地闭环**：凡产生文件的产物（截图、PDF、下载）都支持 `saveTo` 绝对路径写盘，
   返回本地路径，与已有 `file_upload`（读本地文件）形成双向闭环。
4. **每请求新建 McpServer**：沿用户既有的 fix（commit fd7152b），工具注册全部走
   `buildMcpServer()` 内的注册代码，不引入全局状态。

## 3. 总体改动面

| 位置 | 改动 |
|------|------|
| `relay/src/mcp-server.js` | computer 参数扩展；新增 wait_for、handle_dialog、save_pdf、cookies、downloads 五个工具的 SCHEMAS / DESCRIPTIONS / TOOL_TIMEOUTS；saveTo 落盘辅助函数 |
| `extension/background.js` | captureScreenshot 参数化；新增 dialog 监听与应答、wait_for 轮询、printToPDF、chrome.cookies / chrome.downloads 处理分支 |
| `extension/manifest.json` | 新增 `cookies`、`downloads` 权限；版本号 1.1.0 |
| `relay/package.json` | 版本号 1.1.0 |
| `README.md` | 工具表新增 5 行，截图参数说明更新 |

不改动：WS 消息协议（`{type, id, payload}` 请求应答模式原样复用）、端口、
CDP attach/detach 管理、content scripts。

## 4. 新增工具一览

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `wait_for` | 等待元素/URL/网络空闲，解决 agent 抢跑 | `condition`、`timeoutMs` |
| `handle_dialog` | 显式应答 alert/confirm/prompt | `accept`、`promptText` |
| `save_pdf` | 页面存 PDF 到本地 | `saveTo`、`paperFormat`、`landscape` |
| `cookies` | 登录态读取/注入/清除 | `action`、`domain`、`cookies` |
| `downloads` | 下载列表/等待完成/返回本地路径 | `action`、`urlFilter`、`timeoutMs` |

参数级细节见后续章节；所有新工具遵循既有约定：`tabId` 为必填定位参数（downloads 的
list 除外）、返回 `ok([{type:'text',...}])` 结构、`TOOL_TIMEOUTS` 逐工具配置。

## 5. 截图增强包

### 5.1 computer 工具参数扩展（relay/src/mcp-server.js）

`SCHEMAS.computer` 变更：

```js
// quality: enum → union（向后兼容，旧值照常）
quality: z.union([
  z.enum(['low', 'medium', 'high']),
  z.number().int().min(1).max(100),
]).optional().describe('Screenshot quality preset or 1-100'),

// 新增
format: z.enum(['jpeg', 'webp', 'png']).optional().default('jpeg'),
fullPage: z.boolean().optional().describe('Capture beyond viewport'),
saveTo: z.string().optional().describe('Absolute local path to save; .webp/.jpg/.png extension recommended'),
maxDimension: z.number().int().min(400).max(8000).optional().describe('Auto-scale limit, default 2000'),
```

### 5.2 扩展侧 captureScreenshot 改造（extension/background.js）

现有 `captureScreenshot(tabId, quality)` 签名升级为 `captureScreenshot(tabId, opts)`：

```js
// SCREENSHOT_QUALITY 三档保留为 {q: 数值, MAX_DIM: 数值} 的预设；
// opts.quality 为 number 时直接覆盖 q；opts.maxDimension 覆盖 MAX_DIM。
const params = {
  format: opts.format ?? 'jpeg',          // CDP 原生支持 jpeg/png/webp
  quality: q,                              // png 忽略此项
  captureBeyondViewport: opts.fullPage ?? false,
  ...(scale < 1 && { clip: { x: 0, y: 0, width: vw, height: vh, scale } }),
};
```

要点（v1.1 token 优化后的实际实现，取代上方示例中的"直接由 CDP 输出最终格式"）：
- 实测问题：CDP 在高 DPR 屏返回设备像素（DPR 1.5 的 1920×940 视口得到 2880×1410），而结果文本
  却报告 CSS 尺寸，模型实际收到的像素数是声明值的 2 倍以上。图片 token 只取决于像素数。
- 做法：`clip.scale` 让浏览器侧直接截出接近目标尺寸的位图，再用 `OffscreenCanvas`
  按 CSS 像素基准缩放到长边 ≤ `maxDimension`（默认 1280）并重编码。扩展 service worker 无 DOM，
  所以用 `createImageBitmap` + `OffscreenCanvas`，无需新增依赖。
- 全页截图 `captureBeyondViewport: true` 时以 `Page.getLayoutMetrics` 的 CSS 内容尺寸为基准，
  高度上限 20000 CSS px。
- 坐标换算：视口截图后记录 `shotScale[tabId]`（截图像素 / CSS 像素）。click / hover / scroll /
  drag / zoom 收到的坐标按该比例除回 CSS 像素；全页截图不更新比例；`resize_window`、
  标签页关闭会清除记录。
- `zoom` 的区域按截图坐标给出，换算后以 `scale: 1` 原生清晰度裁剪，再受 `maxDimension` 限制。
- relay 侧 `spillLargeImages`：单图 base64 解码后超过 1,000,000 字节则落盘到
  `os.tmpdir()/browser-mcp/`，返回路径文本，避免大图进入上下文。

### 5.2.1 read_page 精简（extension/content-scripts/accessibility-tree.js）

- 剪枝 `display:none` 与 `opacity:0` 整棵子树，`visibility:hidden` 和零尺寸元素不输出。
- 对 `a / button / h1-h6 / label / summary / option / legend` 的后代只保留可交互元素，
  文本不再逐层重复；普通节点只输出自身文本节点，不再带整棵子树的 `innerText`。
- 深度上限按"已输出层级"计算，纯容器不占层级；超过 `max_chars` 时在整行边界截断。
- 实测同一页面：旧实现 300 个元素 / 17747 字符，新实现 197 个元素 / 7141 字符，
  `filter:"interactive"` 仅 15 个元素 / 372 字符。

### 5.3 relay 侧落盘（mcp-server.js）

新增辅助函数：

```js
async function saveImage(base64, saveTo, mime) {
  if (!path.isAbsolute(saveTo)) throw new Error('saveTo must be an absolute path');
  await fs.mkdir(path.dirname(saveTo), { recursive: true });
  await fs.writeFile(saveTo, Buffer.from(base64, 'base64'));
  const { size } = await fs.stat(saveTo);
  return size;
}
```

返回结构（`saveTo` 存在时）：

```
[text] Screenshot 1440x900 saved to /path/a.webp (84.3 KB)
[image] base64（调用方可传 returnImage:false 时省略，见 5.4）
```

### 5.4 returnImage 可选参数

`saveTo` 场景下图片已持久化，允许 `returnImage: z.boolean().optional().default(true)`
跳过 base64 回传（全页大图可省数百 KB 上下文）。未传 `saveTo` 时强制返回 image。

### 5.5 各参数与 CDP 能力的对应

| 参数 | CDP 落点 | 备注 |
|------|----------|------|
| format | `Page.captureScreenshot.format` | jpeg/png/webp |
| fullPage | `captureBeyondViewport` | Chrome 90+ |
| quality | `quality` | png 忽略 |
| maxDimension | `clip.scale` | 现有 2000px 逻辑参数化 |
| saveTo / returnImage | relay 侧文件系统 | 纯 Node 逻辑 |

## 6. 自动化可靠性包

### 6.1 新工具 wait_for

解决的问题：navigate / 点击后 agent 无法感知页面就绪时机，只能盲等（computer wait）或
反复调 find 抢跑。

**SCHEMAS.wait_for（relay）**：

```js
wait_for: {
  tabId: z.number(),
  condition: z.enum(['element', 'element_gone', 'url', 'network_idle', 'time']),
  text: z.string().optional().describe('element/element_gone: text to match (same semantics as find)'),
  urlPattern: z.string().optional().describe('url: substring the URL must contain'),
  milliseconds: z.number().min(100).max(60000).optional().describe('time: duration'),
  idleMs: z.number().min(300).max(10000).optional().default(750).describe('network_idle: quiet window'),
  timeoutMs: z.number().min(1000).max(120000).optional().default(15000),
}
```

TOOL_TIMEOUTS.wait_for = 65000（略大于参数上限，让扩展侧的超时先生效并返回可读结果）。

**扩展侧实现（background.js）**：

- `element` / `element_gone`：复用 content script 的 find（文本匹配）每 300ms 轮询。
- `url`：每 200ms 比较 `tab.url`（需要 `tabs` 权限，已有）。
- `network_idle`：扩展已有 Network domain 的请求计数缓冲（read_network_requests 的数据源）。
  以「最近 idleMs 内无新增请求记录」为空闲判据，每 200ms 检查。注意 SPA 长连接（WS/SSE）
  会造成永不空闲——判据只统计**已结束**的短请求，轮询超时后如实返回
  `network not idle, N requests still active`，不视为错误。
- `time`：直接 setTimeout，等价于 computer.wait 但与其它 condition 共享超时/返回结构。

**返回**：

- 成功：`Waited for element "登录" (4123ms)` / `Network idle after 2100ms`
- 超时：`isError:true` + 已等待时长 + 最后一次观察状态（如 `element not found after 15000ms`）

### 6.2 对话框处理

现状：navigate 的 `force` 参数只覆盖 beforeunload；普通 alert/confirm/prompt 弹出时
CDP 会话会挂起等待应答，agent 无感知。

**扩展侧监听**（background.js，attach 时随 Page.enable 生效）：

```js
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method === 'Page.javascriptDialogOpening') {
    // 记入该 tab 的 dialog 缓冲 {message, type, defaultPrompt, ts}
    // 若该 tab 的 dialogMode === 'auto'：立即 Page.handleJavaScriptDialog {accept:true}
  }
});
```

**策略**：computer / navigate 新增可选参数

```js
dialog: z.enum(['accept', 'dismiss', 'manual']).optional().default('accept')
```

- `accept`（默认）：扩展收到事件立即自动应答 accept，工具结果文本追加
  `dialog(accept): "<message>"`，agent 可感知发生了什么。
- `dismiss`：同上但 accept:false。
- `manual`：不应答，弹窗挂起，由 agent 调 handle_dialog 决定。

**新工具 handle_dialog**：

```js
handle_dialog: {
  tabId: z.number(),
  accept: z.boolean().optional().default(true),
  promptText: z.string().optional().describe('For prompt() dialogs'),
}
```

扩展侧从 dialog 缓冲取最近一条未应答弹窗调用 `Page.handleJavaScriptDialog`；
无挂起弹窗时返回错误 `no pending dialog`。

TOOL_TIMEOUTS：handle_dialog 5000；wait_for 见上。

### 6.3 缓冲与内存

dialog 缓冲每 tab 保留最近 20 条（与 console 缓冲同风格），`session_shutdown` /
detach 时随 tab 状态一并清理，不引入全局泄漏点。

## 7. PDF 导出（新工具 save_pdf）

CDP `Page.printToPDF` 原生能力，扩展已有 debugger 会话直接复用。

**SCHEMAS.save_pdf（relay）**：

```js
save_pdf: {
  tabId: z.number(),
  saveTo: z.string().describe('Absolute local path, .pdf recommended'),
  paperFormat: z.enum(['Letter','Legal','Tabloid','Ledger','A0','A1','A2','A3','A4','A5','A6']).optional().default('A4'),
  landscape: z.boolean().optional().default(false),
  printBackground: z.boolean().optional().default(true),
  scale: z.number().min(0.1).max(2).optional().default(1),
}
```

**扩展侧**：

```js
const res = await cdp(tabId, 'Page.printToPDF', {
  format: paperFormat, landscape, printBackground, scale,
  transferMode: 'ReturnAsBase64',
});
// res.data 为 base64 PDF，WS 回传 relay
```

**relay 侧**：复用 saveImage 同款落盘逻辑（重命名 `saveBase64(path, base64)` 通用化），
返回 `PDF saved to /path/a.pdf (1.2 MB)`，不回传文件内容。

限制说明（写入工具 description）：仅支持 Chromium 可打印内容，纯交互式 canvas 页面
效果有限；printToPDF 要求页面非 file://受限 URL（与现有 attach 的限制一致）。

TOOL_TIMEOUTS.save_pdf = 60000。

## 8. Cookie 管理（新工具 cookies）

选型：用 `chrome.cookies` API 而非 CDP Network.getCookies——语义清晰、不占用
debugger 会话、支持按 store 查询。manifest 新增 `"cookies"` 权限。

**SCHEMAS.cookies（relay）**：

```js
cookies: {
  action: z.enum(['get', 'set', 'remove', 'clear']),
  url: z.string().optional().describe('get/set/remove: URL scope, e.g. https://example.com'),
  domain: z.string().optional().describe('get/clear: filter by domain'),
  name: z.string().optional().describe('get/remove: single cookie name'),
  cookies: z.array(z.object({
    name: z.string(), value: z.string(),
    domain: z.string().optional(), path: z.string().optional(),
    secure: z.boolean().optional(), httpOnly: z.boolean().optional(),
    expirationDate: z.number().optional(),
  })).optional().describe('set: one or more cookies'),
}
```

**行为**：

- get：`chrome.cookies.getAll({url | domain, name})` → 返回 JSON 数组
  （name/value/domain/path/expires/httpOnly/secure），截断上限 200 条。
- set：逐条 `chrome.cookies.set({url, cookie})`，返回每条成败。
- remove：`chrome.cookies.remove({url, name})`。
- clear：`domain` 提供时枚举该 domain 全部 cookie 逐个 remove（chrome.cookies
  无批量清 domain API），否则报错要求提供范围——避免误清全浏览器。

**不经过 debugger**，对未 attach 的 tab 也可用（工具不含 tabId，定位靠 url/domain）。

TOOL_TIMEOUTS.cookies = 10000。

## 9. 下载管理（新工具 downloads）

manifest 新增 `"downloads"` 权限。

**SCHEMAS.downloads（relay）**：

```js
downloads: {
  action: z.enum(['list', 'wait', 'erase']),
  urlFilter: z.string().optional().describe('Filter by URL substring'),
  downloadId: z.number().optional().describe('wait/erase: specific download'),
  timeoutMs: z.number().min(1000).max(600000).optional().default(120000)
    .describe('wait: give up if not complete'),
}
```

**行为**：

- list：`chrome.downloads.search({url: urlFilter && urlFilter, orderBy: ['-startTime'], limit: 20})`
  → 每条返回 `{id, filename(本地绝对路径), url, state, mime, bytesReceived, totalBytes, startTime}`。
- wait：记录当前该 urlFilter 的最新 download id，监听 `chrome.downloads.onChanged`
  直到 `state === 'complete'`；完成时返回 `filename` + 大小，agent 接着可用 file_upload /
  本地读文件消费。timeout 后返回当前进度（partial 也如实返回 interrupted/paused 状态）。
  触发下载本身由页面交互完成（computer click / javascript_tool），downloads 只负责观测。
- erase：按 id 清除历史记录（`chrome.downloads.erase`），不删文件。

TOOL_TIMEOUTS.downloads = list/erase 10000，wait 由参数上限决定（610000 上限内取
timeoutMs + 10s）。relay 的 TOOL_TIMEOUTS 对该工具设 610000。

## 9.1 性能与模拟（新工具 performance / emulate）

参考 chrome-devtools-mcp 的 performance_* 与 emulate 工具，合并为两个工具，沿用现有 CDP 会话，不新增权限与依赖。

**performance**（`tabId`、`action: metrics | trace_start | trace_stop`、`reload`）：

- metrics：页面内用 PerformanceObserver（buffered）读 LCP / CLS（session window）/ INP（近似，取最差交互）/ FCP / 导航计时 / 资源统计，再叠加 CDP `Performance.getMetrics`（JS 堆、监听器数、文档/frame 数）。脚本、布局、任务等耗时指标在 `Performance.enable` 之后才开始累计，即用即关地读取恒为 0，所以 metrics 不输出它们，CPU 耗时分析交给 trace。
- trace_start：`Tracing.start`（categories：devtools.timeline、loading、v8.execute、blink.user_timing），按 tabId 缓冲 `Tracing.dataCollected`，上限 600000 条事件；`reload:true` 时在开始后 `Page.reload`（忽略缓存）。
- trace_stop：`Tracing.end`，等待 `Tracing.tracingComplete`（40s 兜底），解析出 FCP / LCP / CLS、50ms 以上长任务、阻塞时间、主线程 self time 分类（scripting/layout/paint/parsing/other）和最重的脚本调用。返回摘要文本，不返回原始 trace。
- 清理：调试器断开或标签页关闭时丢弃该 tab 的 trace 缓冲；trace 进行中不因页面加载而 detach CDP。

**emulate**（`cpuThrottlingRate`、`networkConditions`、`colorScheme`、`userAgent`、`reset`）：分别对应 `Emulation.setCPUThrottlingRate`、`Network.emulateNetworkConditions`、`Emulation.setEmulatedMedia`、`Emulation.setUserAgentOverride`。覆盖保持到 `reset:true` 或调试器断开；有覆盖的标签页加载时不主动 detach。

超时：relay 侧 performance 60000、emulate 10000；扩展侧 performance 70000。

## 9.2 调用可靠性：宽松入参与 CDP attach 重试

来源：一次真实会话里大量调用失败，归为两类互不相关的问题。

**入参类型被拒绝（`Tool input failed inputSchema validation`）**

该文案不出自 relay 或 MCP SDK（SDK 的文案是 `Input validation error: ...`），而是客户端拿 `tools/list` 公布的 JSON Schema 预校验时拦下的，请求到不了 relay。模型常把数字、布尔、数组序列化成字符串（`tabId:"123"`、`coordinate:"[601, 385]"`），被严格的 `z.number()` / `z.array()` 拒绝。

处理（`relay/src/schema-helpers.js`）：

- `lenientNumber(base)`：公布 `anyOf[number, 数字字符串]`，转换为 Number 后用原 `base` 再校验一次，范围约束（min/max/int）保持有效。
- `lenientBoolean()`：接受 `true/false` 与 `"true"/"false"`。
- `lenientNumberTuple(n)`：接受 `[x, y]` 或其 JSON 字符串，定长约束保持有效。
- `mcp-server.js` 中所有数值、布尔、坐标参数改用上述构造器；转换发生在 relay，扩展端收到的始终是原生类型，WS 协议不变。
- `buildMcpServer` 改为导出，供测试用 SDK 内存传输做端到端验证。

测试：`cd relay && npm test`，覆盖公布的 schema 放行字符串、下发给扩展的参数已还原、原生类型不变、范围约束仍生效、非法字符串被拒绝。

**CDP attach 被 Chrome 暂时拒绝（`Cannot access a chrome-extension:// URL of different extension`）**

现象：页面点击后重载，随后依赖 `chrome.debugger` 的工具（`computer` 全部动作、`javascript_tool`、`read_console_messages`、`read_network_requests`、`wait_for` 的 `network_idle`）连续失败约 2 分钟；只走 `chrome.scripting` 的 `read_page` / `find` / `form_input` / `get_page_text` 与 `tabs_context` 始终正常。错误文案是 Chrome 的，具体触发条件尚未查清。

处理（`extension/background.js` 的 `cdpAttach`）：

- 失败后依次等待 200 / 600 / 1500 ms 重试，共 4 次，每次重试前先 detach 清理残留会话。
- 仍失败时错误信息带上 tabId、URL、tab 状态，说明哪些工具受影响、哪些仍可用，并提示不要原样重发，改为等待、`tabs_create` 新开标签页或重新 navigate。

未改动：`chrome.tabs.onUpdated` 在页面开始加载时 detach 的逻辑（提交 ff62bf8 为修复“导航后 CDP session 失效”而加）。是否可去掉需要先做对照实验，当前不改。

## 10. 权限与版本

### manifest.json 变更

```diff
 "permissions": [
   "debugger",
   "tabs",
   "scripting",
   "storage",
  + "cookies",
  + "downloads"
 ],
-"version": "1.0.x"
+"version": "1.1.0"
```

relay/package.json 同步 1.1.0。权限新增会让 Chrome 在重载扩展时提示用户确认。

### 向后兼容清单

- computer 的 `quality` 收窄风险：union 后 `low/medium/high` 原样有效；
  number 是新增分支，老调用方不受影响。
- `format` 默认 jpeg：现有返回 mimeType 不变。
- 全部 14 个既有工具的参数、返回、超时行为不变。
- WS 协议、端口、MCP 端点不变——客户端（pi-mcp-extension / ZCode / Claude Code）
  零改动，新工具自动出现在工具列表（pi-mcp-extension 支持 tools/list 变更热刷新）。

## 11. 测试计划

按用户验证规范全部本地执行：

1. **静态**：relay 侧 `node --check src/*.js`；manifest JSON 语法校验。
2. **协议层（无浏览器）**：curl 按 MCP 流程 initialize → tools/list 确认 19 个工具
   全部注册、schema 正确；错误参数返回 MCP 标准错误。
3. **扩展链路（需 Chrome 扩展 Connected）**，逐项验证：
   - screenshot：`{format:'webp', quality:80}` 返回 image/webp；`{fullPage:true}` 高度 > 视口；
     `{saveTo:'/tmp/a.webp', returnImage:false}` 落盘且无 image 内容。
   - wait_for：对含「登录」按钮页面 element 等待命中；对慢接口 network_idle；
     对 SPA 长连接 15s 超时并报告活跃请求数。
   - dialog：页面 `confirm()` 时默认自动 accept 且结果追加 dialog 文本；
     `dialog:'manual'` 时 handle_dialog 显式应答。
   - save_pdf：本页导出 A4 PDF 落盘，文件头 `%PDF`。
   - cookies：对 example.com set → get 往返一致；clear 无 domain 时报错。
   - downloads：点击触发下载 → wait 等待完成 → 返回本地路径 → file_upload 上传回该文件。
4. **回归**：现有 14 工具抽查（navigate / find / form_input / read_page）行为不变。
5. 测试页：本地 `data:` URL 与 example.com 为主，避免依赖外部站点稳定性。

## 12. 实施顺序

1. relay：saveBase64 辅助 + computer 参数扩展（5.1–5.4）
2. 扩展：captureScreenshot 参数化（5.2）——先发截图包，独立可验证
3. 扩展+relay：wait_for（6.1）
4. 扩展+relay：dialog 监听 + handle_dialog（6.2–6.3）
5. 扩展+relay：save_pdf（7）
6. 扩展+relay：cookies（8）、downloads（9）
7. README 工具表更新、版本号、manifest 权限
8. 按 11 章节测试计划逐项验证
