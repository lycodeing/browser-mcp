# browser-mcp A 批技术设计（v2.0）

> 状态：待确认 → 确认后编码
> 范围：iframe / Shadow DOM 自动合并、网络观测增强、标签页与标签组、同标签页串行化、扩展侧自动化测试
> 关联：功能介绍与示意图 `.dev-docs/batch-a-overview.html`；上一版设计 `feature-expansion-v1.1.md`
> 性质：破坏性改动，删除 4 个旧工具，不留别名，版本号升到 2.0.0

## 0. 已确认的决策与本文新增的待确认项

已确认（沿用，不再讨论）：

1. iframe 不暴露 `frameId` 参数，`read_page` / `find` 自动合并所有 frame，ref 带 `f<frameId>.` 前缀。
2. 网络观测做"失败原因 + 详情按需取"，响应体默认不进上下文。
3. 标签页管理合并为单个 `tabs` 工具，不兼容旧接口，标签组用 agent 自报名字。
4. 写操作按 tabId 串行，读操作不排队，`handle_dialog` 绕过队列，排队超时 30 秒。
5. 默认选择：`tabs.create` 的 `active` 默认 `true`；响应体截断上限 20 KB；不支持 closed shadow root；不含 `tabs` 之外的窗口管理。

本文在落地时发现的偏差，需要你确认（详见第 12 节）：

- A. 排队等待 30 秒会和 relay 现有的逐工具超时冲突（`form_input` 只有 15 秒）。解决办法是把排队工具的 relay 超时统一加 30 秒，而不是缩短排队时间。
- B. 示意图里 `network detail` 的 `authorization: Bearer ****` 表示敏感请求头默认打码。这属于新增的脱敏逻辑，我按示意图实现并提供 `rawHeaders:true` 关闭，请确认是否保留。
- C. 版本号：删除工具属于破坏性改动，我按语义化版本取 `2.0.0`，不用 `1.2.0`。

## 1. 技术栈与版本核对

本项目：Chrome MV3 扩展（Service Worker，`"type": "module"`）、Node 22 relay、MCP SDK ^1.12.1、zod ^3.23.8、ws 8.21.0。

已核实的外部事实（来源在括号里）：

| 事实 | 来源 |
|------|------|
| `chrome.scripting.executeScript` 在 `allFrames:true` 时每个成功注入的 frame 返回一项 `{frameId, result}`；主 frame 保证排第一，其余顺序不确定；失败的 frame 不出现在结果里 | Chrome 官方文档（context7） |
| `target` 支持 `frameIds`（指定 frame），与 `allFrames` 互斥 | Chrome 官方文档（context7，`InjectionTarget` 说明） |
| 主 frame 的 `frameId` 恒为 0；子 frame 为正数；同一个 frame 跨多次导航保持不变，但 `documentId` 会变 | Chrome 官方文档（webNavigation 的 Frame IDs 一节） |
| `chrome.tabs.group({tabIds, groupId?, createProperties?:{windowId}})` 返回 groupId；不传 `groupId` 就新建组 | Chrome 官方文档 |
| `chrome.tabGroups.update(groupId, {title, color, collapsed})`；`query` 的 `title` 参数是**模式匹配**而不是精确匹配 | Chrome 官方文档 |
| `chrome.tabs.ungroup(tabIds)`：组变空时自动删除 | Chrome 官方文档 |
| `chrome.tabs.reload(tabId, {bypassCache})` 在 Chrome 88+ 返回 Promise，重载完成时 resolve | Chrome 官方文档 |
| CDP `Network.loadingFailed`：`errorText`、`canceled?`、`blockedReason?`、`corsErrorStatus?`、`type` | 官方 protocol JSON |
| CDP `Network.getResponseBody(requestId)` 返回 `{body, base64Encoded}`；`Network.getRequestPostData` 同形；`requestWillBeSent` 带 `redirectResponse?` | 官方 protocol JSON |
| `Network.enable` 的 `maxTotalBufferSize`、`maxResourceBufferSize` 是实验性参数 | 官方 protocol JSON |
| ws 服务端单条消息上限默认 100 MB（`maxPayload`），relay 没有覆盖 | `node_modules/ws` 源码 |
| manifest 已声明 `tabGroups`、`windows`、`tabs`、`scripting`、`debugger`；**没有** `webNavigation` | `extension/manifest.json` |

未能核实、实现时以实测为准的部分：

- `chrome.runtime.getFrameId` 的查询没有返回结果，**本方案不使用它**。
- `chrome.tabs.duplicate` 的返回值细节没查到文档，按"返回 Tab 或 undefined"防御式处理。
- `executeScript` 中 `frameIds` 起始支持的 Chrome 版本没查到，以当前开发环境实测为准，README 里写"Chrome 最新稳定版"。
- `scrollIntoView` 是否跨 frame 边界（含跨域）滚动父页面：见实验 E1。

结论：**不新增任何权限，不新增任何 npm 依赖。** 这也是不用 `webNavigation`（需要新权限）的原因，frame 父子关系改由第 5.4 节的握手获得。

## 2. 改动面

| 位置 | 改动 |
|------|------|
| `extension/background.js` | 删除 `tabs_*`、`read_network_requests` 处理器和 `csInjected`；接入串行队列；`read_page` / `find` / `form_input` / `computer` / `scroll_to` / `wait_for` 改为 frame 感知；网络事件写入 network store（`Network.enable` 不带参数） |
| `extension/lib/tab-queue.js`（新） | 按 tabId 的 FIFO 队列，纯逻辑 |
| `extension/lib/frames.js`（新） | ref 解析与加前缀、frame 树合并、find 结果合并、frame 偏移计算，纯逻辑 |
| `extension/lib/network.js`（新） | 请求缓冲 store、过滤、列表与详情格式化、请求头脱敏、响应体截断，纯逻辑 |
| `extension/lib/tabs.js`（新） | 标签组颜色分配、按名字精确匹配组、标签页列表格式化，纯逻辑 |
| `extension/lib/url.js`（新） | 从 `navigateImpl` 抽出的 URL 规范化与受限地址判断，`navigate` 和 `tabs.create` 共用 |
| `extension/tools/tabs.js`、`tools/network.js`（新） | 调用 chrome.* 的胶水代码，依赖通过参数注入（`ok`、`err`、`waitForLoad`、`ensureCdp`、`tabBuf` 等），避免和 `background.js` 循环引用 |
| `extension/content-scripts/frame-link.js`（新） | frame 之间的握手与偏移采集 |
| `extension/content-scripts/accessibility-tree.js` | 递归进入 open shadow root，`slot` 按分配后的结构遍历 |
| `extension/content-scripts/page-bridge.js` | `searchElements` 递归进入 open shadow root |
| `extension/package.json`（新） | 仅 `{"type":"module","scripts":{"test":...}}`，无依赖，供 `node --test` 使用 |
| `extension/test/*.test.js`（新） | 上述 lib 的单元测试 |
| `extension/test/fixtures/`（新） | 手测用的多 frame、多 origin 页面和一个双端口静态服务脚本 |
| `relay/src/mcp-server.js` | 新增 `tabs`、`network` 的 schema 与描述；删除 4 个旧工具；排队工具的超时加 30 秒；`x-file` 落盘；版本号 |
| `relay/src/schema-helpers.js` | 新增 `lenientNumberArray()` |
| `relay/test/schema.test.js` | 把引用 `tabs_close` 的用例改为新工具；新增工具清单、数组入参、`x-file` 落盘用例 |
| `extension/manifest.json`、`relay/package.json`、`package-lock.json` | 版本号 2.0.0 |
| `README.md`、`feature-expansion-v1.1.md`、`batch-a-overview.html` | 同步（见第 10 节第 6 步） |

不改动：WebSocket 消息协议（`tools/invoke` 请求应答）、端口、MCP 端点、CDP attach 重试逻辑、`computer` 的截图和坐标换算、`dialog` 策略。

## 3. 工具清单与接口定义

### 3.1 清单

21 个工具中删除 `tabs_context`、`tabs_create`、`tabs_close`、`read_network_requests`，新增 `tabs`、`network`，共 19 个。

### 3.2 `tabs`

```js
tabs: {
  action: z.enum(['list', 'create', 'close', 'activate', 'reload', 'duplicate', 'group']),
  tabId: num().optional().describe('activate/reload/duplicate: target tab'),
  tabIds: lenientNumberArray().optional().describe('close/group: target tabs'),
  url: z.string().optional().describe('create: URL to open, omitted opens about:blank'),
  active: bool().optional().describe('create: focus the new tab, default true'),
  group: z.string().min(1).max(40).optional()
    .describe('list: filter by group name. create/group: group name, found or created in the tab\'s window. group without a name removes the tabs from their group'),
  bypassCache: bool().optional().describe('reload: skip the cache'),
}
```

zod 的 schema 是扁平的，按 action 的必填校验放在扩展侧，缺参数时返回 `close requires tabIds` 这样的明确文案。

### 3.3 `network`

```js
network: {
  action: z.enum(['list', 'detail']),
  tabId: num(),
  // list
  urlPattern: z.string().optional().describe('URL substring'),
  method: z.string().optional().describe('GET / POST ..., case-insensitive'),
  status: z.string().optional().describe('"404", "4xx" or "500-599"'),
  failedOnly: bool().optional().default(false).describe('Network failures and HTTP status >= 400'),
  limit: num(z.number().min(1).max(1000)).optional().default(100),
  clear: bool().optional().default(false),
  // detail
  seq: num(z.number().int().min(1)).optional().describe('detail: request number shown by list'),
  bodyLimit: num(z.number().int().min(500).max(200000)).optional().default(20000)
    .describe('detail: max response body characters returned inline'),
  rawHeaders: bool().optional().default(false).describe('detail: do not mask authorization/cookie headers'),
  saveTo: z.string().optional().describe('detail: absolute path to save the full response body'),
}
```

### 3.4 `lenientNumberArray`

接受 `[1, 2]`、`["1","2"]` 或 JSON 字符串 `"[1, 2]"`，转换后用 `z.array(z.number().int()).min(1).max(50)` 重新校验，沿用 `lenientNumberTuple` 的"公布 anyOf、服务端还原再校验"做法。

### 3.5 受影响的描述文本

`computer` 的描述里"Use tabs_context first"改为"Use tabs (action list) first"；`background.js` 里 CDP attach 失败提示中的 `read_network_requests`、`tabs_create` 同步改名。

## 4. 同标签页串行化

### 4.1 队列（`lib/tab-queue.js`）

```js
createTabQueue({ waitMs = 30000 }) → { run(tabId, task) }
// task: () => Promise<T>；返回 task 的结果，或在排队超时时抛 TabBusyError
```

- 每个 tabId 一条 FIFO 链，不同标签页互不影响。
- 排队超过 `waitMs` 抛 `TabBusyError`，文案：`Tab 101 is busy with another operation (waited 30s). Use a separate tab per agent, or retry.`
- 任务抛错或超时都会释放锁，下一个任务照常开始。
- 标签页被关闭时清理对应队列。

### 4.2 接入点

在 `handleMessage` 里，判定是写操作时才进队列。**工具自身的超时放在队列内部**，这样排队时间不会占用执行时间：

```js
const run = () => withTimeout(handler(args), EXT_TOOL_TIMEOUTS[tool] ?? TOOL_TIMEOUT, tool);
const result = isQueuedCall(tool, args) ? await tabQueue.run(args.tabId, run) : await run();
```

执行超时后，锁会释放，但被超时的 `handler` 仍在后台跑到结束（Promise 无法取消）。这是已知限制，写入第 11 节。

### 4.3 哪些调用进队列

```js
const QUEUED_ACTIONS = new Set(['left_click','right_click','double_click','triple_click',
  'type','key','scroll','scroll_to','left_click_drag','hover']);

function isQueuedCall(tool, args) {
  if (!Number.isInteger(args?.tabId)) return false;
  if (tool === 'computer') return QUEUED_ACTIONS.has(args.action);
  if (tool === 'tabs') return args.action === 'reload';
  return ['form_input', 'navigate', 'file_upload', 'javascript_tool'].includes(tool);
}
```

不进队列：`computer` 的 `screenshot` / `zoom` / `wait`、`read_page`、`find`、`get_page_text`、`wait_for`、日志、`network`、`handle_dialog`、`resize_window`、`emulate`、`performance`、`save_pdf`、`cookies`、`downloads`。

`handle_dialog` 绕过队列的原因：`dialog:"manual"` 时弹窗会卡住持有锁的那次点击，它自己再排队就是死锁。

### 4.4 relay 超时联动

relay 的 `TOOL_TIMEOUTS` 是从发出请求开始计时的，包含排队时间。若不调整，`form_input`（15 秒）会在排队 30 秒的规则生效前就被 relay 判超时，用户看到的是笼统的 `timed out`，而不是"标签页忙"。

处理：relay 对排队工具（`computer`、`form_input`、`navigate`、`file_upload`、`javascript_tool`、`tabs`）的超时统一加 `QUEUE_WAIT_MS = 30000`。截图这类不排队的调用超时也随之变长（30 秒到 60 秒），影响只是失败判定变慢，可以接受。

## 5. iframe 与 Shadow DOM

### 5.1 注入：去掉缓存，每次对所有 frame 注入

```js
async function ensureCs(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content-scripts/accessibility-tree.js', 'content-scripts/page-bridge.js',
            'content-scripts/frame-link.js'],
  });
}
```

三个脚本开头都有 `if (globalThis.__x) return` 守卫，重复注入是空操作。删除 `csInjected` 集合以及 `onUpdated` / `onRemoved` 里对它的清理，同时消除"两个请求同时到达未注入标签页会重复注入"的竞态。新增的 iframe 在下一次工具调用时自然被覆盖。

代价是每次调用多一次往返，预期几毫秒，多 frame 页面在手测里测量，目标是 20 个 frame 以内增加不到 300 ms。

### 5.2 ref 命名与解析

- 主 frame：`ref_12`，保持不变。
- 子 frame：`f3.ref_7`，`3` 是 Chrome 的 `frameId`。
- 每个 frame 的 `refCounter` 各自从 1 开始，所以前缀是必须的。

```js
parseRef('ref_12')    → { frameId: 0, ref: 'ref_12' }
parseRef('f3.ref_7')  → { frameId: 3, ref: 'ref_7' }
parseRef('x')         → null
```

按 ref 操作时，用 `target: { tabId, frameIds: [frameId] }` 精确投递。ref 失效（frame 内文档已导航或元素被回收）时返回：`Element not found: f3.ref_7. The frame may have navigated; run read_page or find again.`

### 5.3 读取：`read_page` / `find` / `wait_for`

**read_page**

1. `ensureCs`。
2. 带 `ref_id` 时只在对应 frame 里 `generate`；否则 `allFrames:true` 全部执行。
3. 每个 frame 返回 `{tree, elementCount, truncated, url, name, depth}`，其中 `depth` 是 frame 自己沿 `window.parent` 往上数到顶的层数（跨域也可读，只做身份比较）。
4. `lib/frames.js` 的 `mergeFrameTrees(results, maxChars)` 合并：
   - 主 frame 在前，其余按 `frameId` 升序（`executeScript` 对非主 frame 的顺序不做保证）。
   - 子 frame 无元素则整段省略。
   - 子 frame 的行首 `[ref_N]` 改写成 `[f<id>.ref_N]`。
   - `max_chars` 对全部 frame 合计，到达上限时在整行边界截断；被挤掉的 frame 以一行 `omitted: f3 (12 elements)` 提示存在，避免 agent 以为页面没有这个 iframe。
   - 最多合并 30 个 frame，其余只给个数。
   - 段落标题：`── frame f3 · depth 1 · name="pay" · https://pay.example.com/card ──`。
5. 首行：`Page tree (9 elements, 3 frames, filter:interactive):`。

**find**：`allFrames` 执行 `searchElements`，各 frame 的结果加前缀后统一按分数降序、同分按 `frameId` 升序，取前 `max_results`，行末附 `in frame f3`。

**wait_for 的 `element` / `element_gone`**：改用同一个跨 frame 查找，任一 frame 命中即视为存在。

### 5.4 点击：跨 frame 的坐标

只有"用 `ref` 定位到子 frame 内元素再点击"受影响。传坐标的点击、滚动、悬停用的是顶层视口里的截图像素，行为不变。

子 frame 内 `getBoundingClientRect` 是相对**自己视口**的，要加上沿 frame 链各层 iframe 元素的位置才是顶层视口坐标。跨域时子 frame 读不到父页面，所以用 `postMessage` 握手（`content-scripts/frame-link.js`），不依赖 CDP，也不要新权限：

1. 每个 frame 注入时生成随机 `token`，监听 `message`。
2. 子 frame 向 `window.parent` 发 `{__bmcp:'hello', token}`。
3. 父 frame 收到后，在自己的 `iframe`/`frame` 元素（含 open shadow root 内的）里找 `contentWindow === event.source` 的那个，记下 `token → 元素`，并回 `{__bmcp:'ack', token, parentToken}`。
4. 子 frame 收到 ack 后保存 `parentToken`。
5. 需要偏移时，扩展对所有 frame 执行 `link()`（等待 ack，最长 300 ms）再执行 `collect()`，得到每个 frame 的 `{token, parentToken, children:[{token, rect, offsetWidth, offsetHeight, clientLeft, clientTop}]}`。矩形在 `collect()` 时现读，布局变化不会让缓存过期。
6. `lib/frames.js` 的 `resolveFrameOffset(frameId, infos)` 沿 `parentToken` 向上累加：

```
对每一层：sx = rect.width / offsetWidth
          x = rect.left + clientLeft * sx + x_inner * sx
          y = rect.top  + clientTop  * sx + y_inner * sx
```

   `sx` 用来近似处理 iframe 上的 CSS 缩放，不处理旋转和倾斜。

流程：先在目标 frame 里 `getElementCoordinates(ref, {scrollIntoView:true})` 得到 frame 内坐标，再算偏移，相加后交给现有的 `Input.dispatchMouseEvent`。事件仍然是 trusted 的。

**这一节是本批最大的技术风险**，编码前必须先通过实验 E1（第 9.2 节）。E1 失败的退路按顺序：

1. CDP 方案：`Page.getFrameTree` + `DOM.getFrameOwner` + `DOM.getBoxModel`，需要先解决 Chrome frameId 与 CDP frameId 的对应。
2. 在 frame 内用脚本派发事件，事件 `isTrusted=false`，部分站点不响应，必须在结果里标注 `synthetic event`。

### 5.5 Shadow DOM

- `accessibility-tree.js`：`walk` 遇到有 `shadowRoot` 的元素时，用 `shadowRoot.children` 作为子节点；遇到 `<slot>` 时用 `slot.assignedElements({flatten:true})`，没有分配内容就用 slot 自己的 fallback 子节点。这样输出的是渲染后的结构。
- `page-bridge.js`：`searchElements` 的 `querySelectorAll` 改为递归函数，对每个根下带 `shadowRoot` 的元素继续进入，深度上限 20。
- ref 机制不变，`WeakRef` 同样适用于 shadow 内元素。
- closed shadow root 无法读取，写入已知限制。

### 5.6 本批不覆盖

- `file_upload` 的 `ref` / `triggerRef` 只支持主 frame；传子 frame 的 ref 时返回明确错误。
- `get_page_text`、`javascript_tool` 仍只作用于主 frame。
- 这三项留到后续批次，不会因为本批的 ref 前缀而静默出错。

## 6. 网络观测

### 6.1 采集

- `Network.enable` 保持不带任何缓冲参数。实验 E2（Chrome 155）显示显式设置 `maxTotalBufferSize` / `maxResourceBufferSize` 会让较早的响应被驱逐，比默认更差。
- 监听 `requestWillBeSent`、`requestWillBeSentExtraInfo`、`responseReceived`、`loadingFinished`、`loadingFailed`。
- 缓冲从 500 条提到 1000 条。每条只存元数据和头，**响应体不缓存**，按需向浏览器取。

### 6.2 数据结构（`lib/network.js`）

```js
createNetworkStore({ capacity = 1000 }) → {
  onRequest(params, now), onResponse(params), onFinished(params), onFailed(params),
  query(filter) → entries,   // filter: urlPattern, method, status, failedOnly, limit
  get(seq) → entry | undefined | 'evicted',
  clear(), lastStartedAt(),
}

entry = {
  seq,                       // 每个标签页单调递增，clear 和淘汰都不重置
  requestId, method, url, type,
  startedAt,                 // Date.now()，给 wait_for 的 network_idle 用
  monotonicStart,            // CDP MonotonicTime，用来算耗时
  status, statusText, mimeType,
  requestHeaders, responseHeaders,
  postData,                  // 只存前 8 KB；hasPostData 但超出的在 detail 时再取
  hasPostData,
  finished, durationMs, encodedBytes,
  failed: null | { errorText, blockedReason, canceled, corsError },
}
```

**重定向**：`requestWillBeSent` 带 `redirectResponse` 说明同一个 `requestId` 的上一跳结束了。要用重定向响应把上一条记录补全（状态码 3xx、响应头），再为新 URL 建一条新记录，`requestId → entry` 的映射指向最新一条。旧实现按 `requestId` 且 `status===null` 查找，重定向时会把状态写错条目。

**淘汰**：超出容量时丢弃最旧的一条，保留 `evictedBefore` 序号。`get(seq)` 对被淘汰的序号返回 `'evicted'`，调用方给出明确提示而不是"不存在"。

### 6.3 `network list`

```
Network (3 of 142, failedOnly):

#87  GET   FAIL [Fetch    ] https://api.example.com/orders     net::ERR_CONNECTION_RESET
#103 POST  FAIL [XHR      ] https://api.example.com/pay        blocked: cors
#119 GET   504  [XHR      ] https://api.example.com/status     HTTP 5xx
```

- 失败原因优先级：`corsErrorStatus` → `blocked: <blockedReason>` → `errorText`；`canceled` 且没有其它原因时显示 `canceled`。
- `status` 过滤接受 `"404"`、`"4xx"`、`"500-599"`，解析失败时报错并列出可用格式。
- `failedOnly` 的定义：`failed != null` 或 `status >= 400`。
- 表头 `3 of 142` 里 142 是过滤前的总数。
- `clear:true` 清空缓冲但不重置 `seq`。

### 6.4 `network detail`

输出结构（头部分见 6.5）：

```
#119 GET https://api.example.com/status  → 504 Gateway Timeout  (3.2s)
Request headers
  ...
Request body (POST only, 214 B)
  {...}
Response headers
  ...
Response body (1.8 KB, application/json)
  {...}
```

响应体规则：

1. 请求未完成或已失败：不取响应体，说明原因。
2. 调 `Network.getResponseBody`。浏览器已回收时返回 `Response body 已过期：...`，不当成错误。错误文案 `No data found for resource with given identifier` 与 `Request content was evicted from inspector cache` 都按"已过期"处理。
3. `base64Encoded:true`（二进制）：不回传内容，只给大小和 MIME；有 `saveTo` 时落盘。
4. 文本超过 `bodyLimit`（默认 20000 字符）：截断并提示 `truncated, N more characters; pass saveTo to keep the full body`。
5. 有 `saveTo`：完整响应体落盘，不回传内容。

POST 体：`entry.postData` 不完整时，用 `Network.getRequestPostData` 补取，同样受 `bodyLimit` 限制。

### 6.5 请求头脱敏（待确认项 B）

`authorization`、`proxy-authorization`、`cookie`、`set-cookie` 的值默认显示为 `****`，`rawHeaders:true` 时原样输出。按示意图的约定实现，请确认是否保留。

### 6.6 落盘通道

relay 已有的 `applySaveTo` 只处理 `image` 类型内容。响应体不是图片，所以扩展在**请求带 `saveTo` 时**额外返回一个仅在扩展与 relay 之间使用的内容项：

```js
{ type: 'x-file', data: '<base64>' }
```

- relay 的 `applySaveTo` 识别 `x-file`：校验 `saveTo` 为绝对路径，写盘，把该项替换成 `Saved to <path> (<size>)` 文本。
- 无论是否带 `saveTo`，relay 回复客户端前都会剔除残留的 `x-file` 项，保证非标准类型不会泄漏给 MCP 客户端。
- 扩展侧上限 32 MB（base64 后约 43 MB，低于 ws 的 100 MB 单条上限）。超过时返回错误，并建议改用 `javascript_tool` 里的 `fetch`。
- 文本响应体先转 UTF-8 再转 base64，写盘内容与原文一致。

### 6.7 与现有功能的衔接

- `wait_for` 的 `network_idle` 原来读 `buf.network` 数组末尾元素的时间戳，改为读 `store.lastStartedAt()`，判据不变。
- `tabBuf` 里的 `network` 由数组变为 store 对象，`clear` 走 `store.clear()`。
- 工具只在 CDP 已 attach 后才有数据：首次调用 `network` 会自动 attach，**此前发生的请求拿不到**，工具描述里说明这一点。

## 7. 标签页与标签组

### 7.1 action 行为

| action | 行为 |
|--------|------|
| `list` | `chrome.tabs.query({})`，过滤 `chrome:` / `chrome-extension:` / `devtools:` / `about:` 地址；用 `chrome.tabGroups.query({})` 建 `groupId → title` 映射；每行带组名、窗口号、`[ACTIVE]`；`group` 参数按名字过滤 |
| `create` | `url` 经 `lib/url.js` 规范化与受限地址检查（和 `navigate` 同一套）；`chrome.tabs.create({url, active})`；有 `group` 时归组；带 URL 时 `waitForLoad`（15 秒）后返回标题、最终地址和耗时，未加载完则返回 `still loading` |
| `close` | 先逐个确认 id 存在，不存在的列出来但不报错；`chrome.tabs.remove(tabIds)`；状态清理由现有 `onRemoved` 监听负责 |
| `activate` | `tabs.update(tabId,{active:true})`，再 `windows.update(windowId,{focused:true})` |
| `reload` | `chrome.tabs.reload(tabId,{bypassCache})`，随后 `waitForLoad`；进串行队列 |
| `duplicate` | `chrome.tabs.duplicate(tabId)`，返回新标签页 id，带加载等待；返回值为空时给出明确错误 |
| `group` | 有 `group`：在 `tabIds[0]` 所在窗口里按名字找组，找不到就新建；`tabIds` 不在同一窗口时报错。没有 `group`：`chrome.tabs.ungroup(tabIds)` |

### 7.2 标签组的查找与创建（`lib/tabs.js`）

- **精确匹配**：`tabGroups.query` 的 `title` 是模式匹配，agent 名字里带 `*` 之类的字符会误匹配。做法是只按 `windowId` 查询，再在 JS 里用 `g.title === name` 过滤。
- **颜色**：对名字做稳定哈希，在 8 种彩色（不含 `grey`）里取一个。同一个名字在不同窗口、不同会话得到同一种颜色，用户可以靠颜色认人。
- **创建**：`chrome.tabs.group({tabIds, createProperties:{windowId}})` 得到 `groupId`，再 `chrome.tabGroups.update(groupId, {title, color})`。
- **窗口隔离**：标签组属于窗口。同名的组在两个窗口里是两个组，这是 Chrome 的行为，写入工具描述。
- 名字去首尾空格，长度 1 到 40。

### 7.3 `active:false` 的提醒

后台标签页会被浏览器节流，截图和定时器可能异常。工具描述里写明：需要截图或依赖动画的页面保持 `active:true`。

## 8. relay 侧改动汇总

1. `SCHEMAS` / `DESCRIPTIONS` 增删：`tabs`、`network` 新增；4 个旧工具删除。
2. `TOOL_TIMEOUTS`：`tabs: 40000`（含 create 的页面加载）、`network: 15000`；排队工具统一 `+30000`（第 4.4 节）。
3. `applySaveTo` 支持 `x-file`；回复前剔除残留的 `x-file`。
4. `buildMcpServer` 与 `/` 状态接口里的版本号改为 `2.0.0`。
5. `lenientNumberArray` 加入 `schema-helpers.js`。

## 9. 测试方案

### 9.1 自动测试（`npm test`，无新依赖）

relay：`cd relay && npm test`；扩展：`cd extension && npm test`，都用 `node --test`。

| 文件 | 覆盖点 |
|------|--------|
| `extension/test/tab-queue.test.js` | 同 tab FIFO；不同 tab 并行；排队超时抛 `TabBusyError`；任务抛错后锁释放；任务超时后锁释放；关闭 tab 清理队列 |
| `extension/test/frames.test.js` | `parseRef` 的合法与非法输入；加前缀只改行首 ref，不误改文本里的 `[ref_1]`；合并顺序（主在前，其余按 frameId）；空 frame 省略；预算截断落在整行边界；被挤掉的 frame 有 omitted 提示；30 个 frame 上限；find 结果合并排序；`resolveFrameOffset` 的 1 层、3 层、带边框、带缩放 |
| `extension/test/network.test.js` | seq 单调且 clear 不重置；重定向两跳各自成条；`loadingFailed` 的 CORS、blocked、canceled 三种原因；`status` 过滤的 `404` / `4xx` / `500-599` / 非法值；`failedOnly`；淘汰后 `get` 返回 `evicted`；列表与详情格式化；头脱敏与 `rawHeaders`；响应体截断；二进制不回传 |
| `extension/test/tabs.test.js` | 颜色哈希稳定且不为 grey；按名字精确匹配（名字含 `*`）；`normalizeUrl` 与受限地址；列表格式化 |
| `relay/test/schema.test.js` | 工具清单恰好 19 个且不含旧名；`tabs` / `network` 的字符串数字与数组还原；`lenientNumberArray` 约束；`x-file` 落盘与剔除；原有用例中的 `tabs_close` 改为 `tabs` |

content script（`accessibility-tree.js`、`page-bridge.js`、`frame-link.js`）依赖浏览器 DOM，不引入 jsdom 之类的依赖，改走 9.2 和 9.3 的真实浏览器验证。

### 9.2 编码前的三个实验

| 编号 | 问题 | 做法 | 通过标准 |
|------|------|------|----------|
| E1 | 握手方案能否在跨域、多层 iframe 里算准点击坐标 | 用 `extension/test/fixtures/` 的页面：`127.0.0.1` → `localhost` → `127.0.0.1` 三层，依次加边框、内部滚动、`transform:scale(.5)`；对每层各取若干点，用算出的坐标做 CDP 点击，页面记录点击在目标 frame 内的坐标 | 误差在 ±2 px 内；同时记录 `scrollIntoView` 是否会带动父页面滚动 |
| E2 | `Network.enable` 的缓冲参数是否足以让 `getResponseBody` 取到较早的响应 | 连续请求 50 个 1 MB 响应，在最后读第 1 个的响应体，分别试默认值与 50 MB / 10 MB | 选出能取到的最小参数；记录 attach 后浏览器内存增长 |
| E3 | `executeScript` 对 `allFrames` 的耗时与失败行为 | 测 1、10、30 个 frame 的页面，含 `about:blank`、`srcdoc`、`display:none` 的 frame | 30 个 frame 内增加耗时小于 300 ms；失败 frame 不影响主 frame |

### 实验结果（E2、E3）

环境：macOS darwin 25.6.0 arm64，Google Chrome 155.0.8059.41（品牌版稳定通道），Node v22.23.2，ws 8.21.0（取自 `relay/node_modules`）。独立临时 profile + `--remote-debugging-port=9333` 的实例上测量，未触碰用户正在使用的 Chrome。

**E2：`Network.enable` 缓冲参数（Chrome 155 实测）**

页面并发 `fetch` 50 个各 1 MB 的 `application/json` 文本响应（`Cache-Control: no-store`），全部 `loadingFinished` 后对第 1、25、50 个 requestId 调 `Network.getResponseBody`。括号内为错误信息要点。

| 配置 | 页面行为 | #1 | #25 | #50 |
|------|----------|----|----|-----|
| 不带参数（默认） | 只发请求不读 body | 取不到（No data found for resource） | 取不到（同左） | 取不到（同左） |
| 不带参数（默认） | 读取 body | **取到（1048605 字符，内容与请求一一对应）** | **取到** | **取到** |
| 50MB / 10MB | 只发请求不读 body | 取不到（Request content was evicted from inspector cache） | 取不到（No data found） | 取不到（No data found） |
| 50MB / 10MB | 读取 body | 取不到（evicted from inspector cache） | **取到** | **取到** |
| 20MB / 5MB | 只发请求不读 body | 取不到（evicted） | 取不到（evicted） | 取不到（No data found） |
| 20MB / 5MB | 读取 body | 取不到（evicted） | 取不到（evicted） | **取到** |

内存（`ps -o rss=`，browser 进程，attach 前后）：默认配置首轮约 +25 MB，后续轮次 ±0.3 MB 内；显式设置缓冲参数的轮次 browser 进程无显著增长，但页面 renderer 在 50MB 配置 + 不读 body 时一度涨到约 348 MB（数据滞留在缓冲里），默认配置约 230–250 MB。50 个 1 MB 请求全页 fetch 完成用时约 200 ms。

结论：

1. **与 6.1 节的假设相反：显式设置 `maxTotalBufferSize` / `maxResourceBufferSize` 会让较早的响应被"inspector cache 驱逐"，比不带参数更差。** 默认（不带参数）时 Chrome 按自身策略缓冲，页面读过 body 的 50 个 1 MB 响应全部可取回。
2. 页面不读 body（流式消费/放弃）时任何配置都取不到响应体，参数救不了。
3. **推荐参数：`Network.enable` 不带缓冲参数（保持默认）。** 6.1 节的 `{maxTotalBufferSize: 50MB, maxResourceBufferSize: 10MB}` 应删除。
4. 6.4 节第 2 条"浏览器已回收时返回过期提示"需要覆盖两种错误文案：`No data found for resource with given identifier` 和 `Request content was evicted from inspector cache`，两者都按"已过期"处理而不是报错。

**E3：`executeScript` allFrames 耗时与失败行为（降级近似，本环境无法直接测量）**

本机 Chrome 155 为品牌版稳定通道，`--load-extension` 已被移除（Chrome 137 起品牌版 no-op，官方公告确认）。实测：带该 flag 启动的实例 `chrome://extensions` 无任何条目、无扩展进程、无 service worker 目标，flag 被静默忽略。按约束不绕过（不装 Chromium/Chrome for Testing）。

降级近似：用 CDP 对页面每个 frame 的默认执行上下文逐个 `Runtime.evaluate` 注入与真实 content script 同量级的脚本（6.2 KB + 3.1 KB ≈ 9.4 KB，对齐 `accessibility-tree.js` 6435 B + `page-bridge.js` 3004 B），串行 await。**这只是近似，不等价于 `executeScript`**：CDP 走 DevTools 会话逐帧往返，扩展的 `executeScript` 走浏览器内部管线批量分发，后者通常更快；近似值可视为耗时上界。

页面构成：主 frame + N 个 iframe（`about:blank`、`srcdoc`、`display:none` 同源页、`data:` 跨源各约 1/4）。各 5 次取中位数：

| frame 数（含主） | 全新注入中位数 | 幂等守卫命中中位数 |
|------------------|----------------|---------------------|
| 1 | 0.9 ms | 0.6 ms |
| 11 | 5.8 ms | 4.4 ms |
| 31 | 11.8 ms | 10.4 ms |

每帧平均约 0.4 ms，31 帧串行近似总耗时约 12 ms，比 300 ms 的通过标准低一个数量级以上；`executeScript` 实际值只会更低。**按近似数据判断 E3 达标**，但编码落地后应用真实扩展复核一次（第 9.3 节手测时顺带记录）。

失败 frame 行为（近似验证）：

- 对已销毁的执行上下文注入：CDP 返回 `Cannot find context with specified id`，错误只落在该次调用，同批其余 frame 照常注入成功，主 frame 结果保留。
- 慢导航中的 frame：导航发起后旧上下文存活到 commit 为止，期间注入仍成功；commit 后旧上下文销毁，同样表现为单帧错误。
- 与文档 1 节的预期一致：失败的 frame 不出现在结果里、不影响主 frame。

对 5.1 节的影响：耗时数据支持"去掉 `csInjected`、每次 `allFrames` 全量注入"的方案；20 个 frame 内约 8 ms（近似上界），远低于 300 ms 目标。

实验产物（脚本与原始 JSON）在 `/tmp/bmcp-exp/`，实验结束后已清理大文件与自启 Chrome 进程。

**E1：跨域多层 iframe 点击坐标（通过）**

环境同 E2。品牌版 Chrome 不能 `--load-extension`，所以用 CDP 对每个 frame 的默认执行上下文 `Runtime.evaluate` 注入 `frame-link.js`，握手逻辑与真实 content script 相同，只是没有 isolated world 隔离。脚本在 `extension/test/fixtures/e1-run.mjs`，静态服务在 `e1-server.js`。

页面：`127.0.0.1:9401` → `:9402` → `:9403` 三个端口即三个不同源，嵌套三层。第一层 iframe 带 7px 边框，第二层带 5px 边框并 `transform:scale(.5)`，叶子页里按钮在 `overflow:auto` 的内部滚动容器中。

结果：

- 三个 frame 的握手全部成功（`d1 parent=ok`、`d2 parent=ok`）。
- 4 个用例（近点、远点各一次，外加中间层页面滚动 60px 之后各一次）点击落点与目标的偏差均为 0 px，事件均为 `isTrusted: true`。
- 偏移在滚动之后现读，没有使用缓存，所以父页面滚动不影响结果。

结论：5.4 节方案可行，不需要退路。局限：只验证了平移与等比缩放，旋转和倾斜按设计不支持；真实扩展环境下的 isolated world 行为要在 9.3 手测第 3 项里复核。

**实现与设计的偏差**

- `Network.enable` 不带缓冲参数（见 E2 结论）。
- `mergeFrameTrees` 的 30 个 frame 上限只计子 frame，主 frame 不占名额。
- `x-file` 在没有 `saveTo` 时静默剔除，不当作错误。
- `file_upload` 收到子 frame 的 ref 返回明确错误，`get_page_text` 与 `javascript_tool` 仍只作用于主 frame。
- 子代理多次因上游响应截断中断，`lib/frames.js`、`lib/network.js`、`tools/network.js`、`frame-link.js` 由主代理直接实现。

### 9.3 手测清单（你重载扩展后执行，我给出命令并回报结果）

1. `tabs` 全部 7 个 action，各一次；`close` 传不存在的 id；`group` 同名跨两个窗口。
2. 两个 agent 名字创建标签页，确认颜色稳定、同名复用同一个组、取消分组后空组被删除。
3. 结账页类 fixture：`read_page` 看到 `f3.ref_*`；`form_input` 往 iframe 输入；`computer` 点击 iframe 内按钮并确认页面收到。
4. Web Component fixture：`find` 与 `read_page` 能进入 open shadow root，slot 内容出现在正确位置。
5. `network list` 的 `failedOnly` / `status` / `method`；制造 CORS 失败、连接重置、404、重定向。
6. `network detail`：JSON 响应、超 20 KB 的响应（截断与 `saveTo`）、图片（二进制）、被挤出缓冲的旧序号。
7. 串行化：同一标签页并发发起两个耗时写操作，确认后者排队且顺序正确；排队超 30 秒返回"标签页忙"；`dialog:"manual"` 的点击期间 `handle_dialog` 能立即应答，不死锁。
8. 回归：`navigate`、`computer` 截图与坐标点击、`wait_for`、`cookies`、`performance`、`emulate` 抽查。

## 10. 实施顺序

每一步结束都要能编译、测试通过、可独立验证。

| 步骤 | 内容 | 验收 |
|------|------|------|
| 0 | 做 E1 / E2 / E3，结果写回本文第 9.2 节 | 三项实验有结论；E1 失败则回到你这里确认退路 |
| 1 | `extension/package.json`、`lib/tab-queue.js` 及测试；接入 `handleMessage`；relay 超时联动 | 两边 `npm test` 通过；手测第 7 项 |
| 2 | `lib/network.js` 及测试；`tools/network.js`；事件监听改写；relay 的 `network` schema 与 `x-file`；删除 `read_network_requests`；改 `wait_for` 的 network_idle | 测试通过；手测第 5、6 项 |
| 3 | `lib/url.js`、`lib/tabs.js` 及测试；`tools/tabs.js`；`lenientNumberArray`；relay 的 `tabs` schema；删除三个旧工具 | 测试通过；手测第 1、2 项 |
| 4 | `frame-link.js`、shadow DOM 改造、`lib/frames.js` 及测试；`read_page` / `find` / `form_input` / `computer` / `scroll_to` / `wait_for` 改为 frame 感知；删除 `csInjected` | 测试通过；手测第 3、4 项 |
| 5 | 版本号 2.0.0；同步 README、`feature-expansion-v1.1.md`、`batch-a-overview.html`；全量回归（手测第 8 项） | 文档与代码一致 |

文档同步清单：

- README：工具数 21 → 19、工具表、示例里的 `tabs_context`、FAQ 里的 `tabs_create`、新增迁移说明和"安全说明"里补充 `network detail` 可读取响应体与请求头。
- `feature-expansion-v1.1.md`：顶部加一段指向本文，说明已被本批取代的内容；不重写历史章节。
- `batch-a-overview.html`：frame 段落标题加 `depth`；`detail` 示例按最终格式更新；超时与偏差按本文调整。

## 11. 风险与已知限制

| 项 | 说明 | 缓解 |
|----|------|------|
| 跨域 iframe 点击坐标 | 本批最大风险 | 实验 E1 先行；退路已列 |
| 超时后的后台残留 | 队列锁释放后，超时的 handler 还在后台继续跑，可能和下一个任务交叠 | 文档说明；超时本身是异常路径 |
| 响应体可能过期 | 浏览器只在会话内保留，且受缓冲上限限制 | 返回"已过期"而不是静默失败 |
| 串行化只保证单次调用原子 | 不能防止两个 agent 的操作逻辑冲突 | 标签组 + 文档建议每个 agent 独占标签页 |
| closed shadow root | 无法读取 | 写入限制 |
| 非主 frame 的 `file_upload` / `get_page_text` / `javascript_tool` | 本批不支持 | 子 frame ref 给明确报错 |
| iframe 的旋转倾斜变换 | 偏移计算只处理平移与等比缩放 | 写入限制 |
| 破坏性改动 | 各客户端提示词里引用旧工具名会失效 | 版本号 2.0.0、README 迁移表 |
| 本机无鉴权 | `network detail` 让任何本机进程都能读取页面的请求头与响应体，和已有的 `cookies` 工具同级 | 沿用现有"只监听 127.0.0.1"，README 的安全说明里写明 |
| 打码的取舍 | 请求头默认打码会让排查鉴权问题多一步 | `rawHeaders:true` |

## 12. 需要你确认的点

1. **超时联动（偏差 A）**：排队工具的 relay 超时统一加 30 秒，排队等待保持 30 秒。可以吗，还是你更想把排队缩短到 10 秒左右、不动 relay 超时？
2. **请求头打码（偏差 B）**：保留默认打码加 `rawHeaders` 开关，还是去掉打码、一律原样输出？
3. **版本号（偏差 C）**：`2.0.0`，还是沿用 `1.2.0`？
4. 其余按本文执行。尤其是第 0 步的三个实验：E1 如果证明握手方案不可行，我会带着结果回来跟你商量退路，再继续。
