# browser-mcp B 批技术设计（v2.1）

> 状态：待确认 → 确认后先做实验，再编码
> 范围：`storage` 工具、请求拦截与 Mock（`intercept_*`）、`emulate` 扩展（设备预设、地理位置、时区、语言）
> 关联：功能介绍与示意图 `.dev-docs/batch-b-overview.html`；上一批设计 `batch-a-design-v2.0.md`
> 性质：只增不删，旧调用保持可用，版本号升到 2.1.0

## 0. 已确认的决策与本文新增的待确认项

已确认（沿用，不再讨论）：

1. `storage` 读写 `localStorage` / `sessionStorage`，IndexedDB 只读摘要。
2. 请求拦截与 Mock 拆成独立工具：`intercept_add` / `intercept_list` / `intercept_remove`。
3. `emulate` 内置少量设备预设（`iphone-15`、`ipad-air`、`pixel-8`），也支持自定义宽高和像素比。
4. 地理位置、时区、语言全部并入 `emulate`，沿用 `reset:true` 一键还原。
5. 不做权限授予（依据见第 1 节，编码前先用实验 X1 证实）。

本文新增的待确认项（详见第 11 节）：

- A. `storage` 的写操作（`set` / `remove` / `clear`）进同标签页串行队列，和 A 批的写操作一致。
- B. `fulfill` 规则自动应答 CORS 预检，否则跨域 `fetch` 的 Mock 会被预检挡掉。
- C. 版本号取 `2.1.0`（只增不删）。

## 1. 技术栈与版本核对

本项目：Chrome MV3 扩展（Service Worker，`"type": "module"`）、Node 22 relay、MCP SDK ^1.12.1、zod ^3.23.8。

已核实的外部事实：

| 事实 | 来源 |
|------|------|
| `chrome.debugger` 文档列出的可用域：Accessibility、Audits、CacheStorage、Console、CSS、Database、Debugger、DOM、DOMDebugger、DOMSnapshot、Emulation、Fetch、IO、Input、Inspector、Log、Network、Overlay、Page、Performance、Runtime、Storage、Target、Tracing、WebAudio、WebAuthn；**不含** `Browser`、`DOMStorage`、`IndexedDB` | Chrome 官方文档（context7） |
| `Fetch.enable({patterns:[{urlPattern, resourceType?, requestStage?}]})`：请求被暂停，直到 `failRequest` / `fulfillRequest` / `continueRequest` 之一被调用 | 官方 protocol JSON |
| `RequestPattern.urlPattern` 通配符：`*` 零个或多个字符，`?` 恰好一个字符，反斜杠转义；省略等价于 `*` | 官方 protocol JSON |
| `Fetch.fulfillRequest({requestId, responseCode, responseHeaders?:[{name,value}], body?, responsePhrase?})`：`body` 是 **base64 字符串**；请求阶段拦截且不传 body 时返回空体 | 官方 protocol JSON |
| `Fetch.failRequest` 的 `errorReason`：Failed、Aborted、TimedOut、AccessDenied、ConnectionClosed、ConnectionReset、ConnectionRefused、ConnectionAborted、ConnectionFailed、NameNotResolved、InternetDisconnected、AddressUnreachable、BlockedByClient、BlockedByResponse | 官方 protocol JSON |
| `Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor,mobile,...})` / `clearDeviceMetricsOverride` | 官方 protocol JSON |
| `Emulation.setTouchEmulationEnabled({enabled, maxTouchPoints?})` | 官方 protocol JSON |
| `Emulation.setGeolocationOverride({latitude?,longitude?,accuracy?})`：省略经纬度或精度表示"位置不可用"；有 `clearGeolocationOverride` | 官方 protocol JSON |
| `Emulation.setTimezoneOverride({timezoneId})`：传空字符串恢复宿主时区 | 官方 protocol JSON |
| `Emulation.setLocaleOverride({locale?})`（**实验性**）：描述写 ICU 风格如 `en_US`，空或省略恢复默认 | 官方 protocol JSON |
| `Emulation.setUserAgentOverride({userAgent, acceptLanguage?, platform?, userAgentMetadata?})` | 官方 protocol JSON |
| `chrome.storage.session`：内存存储，扩展被禁用、重载、更新或浏览器重启时清空；上限 10 MB；默认只对扩展页面和 Service Worker 开放 | Chrome 官方文档（context7） |
| manifest 已声明 `storage`、`debugger`、`scripting`、`tabs`、`tabGroups`、`windows`、`cookies`、`downloads`、`alarms` | `extension/manifest.json` |
| 现有 `Network.enable` 在 `cdpAttachOnce` 里无参数调用（A 批实验 E2 的结论） | `extension/background.js:83` |

未能核实、必须由实验确认的部分：

- `Browser` 域是否真的被 `chrome.debugger` 拒绝（实验 X1）。
- `Fetch` 与 `Network` 同时开启时，被 Mock 的请求是否仍出现在 `network list` 里（实验 X2）。
- `setLocaleOverride` 接受 `ja-JP` 还是只接受 `ja_JP`（实验 X4）。
- 没有位置权限的站点上，`setGeolocationOverride` 之后页面的实际表现（实验 X5）。
- Service Worker 被回收后，已启用的 `Fetch` 拦截会怎样、规则怎么恢复（实验 X3）。

结论：**不新增任何权限，不新增任何 npm 依赖。**

## 2. 改动面

| 位置 | 改动 |
|------|------|
| `extension/background.js` | 注册 `storage`、`intercept_add`、`intercept_list`、`intercept_remove`；`Fetch.requestPaused` 事件分发；拦截标签页加入"加载期间不断开调试器"的例外；`toolEmulate` 抽到 `tools/emulate.js` |
| `extension/lib/intercept.js`（新） | 规则存储、通配符匹配、按序命中、命中计数、序列化与恢复，纯逻辑 |
| `extension/lib/emulation.js`（新） | 设备预设表、参数合并与校验、还原计划，纯逻辑 |
| `extension/lib/storage-view.js`（新） | 键值摘要与截断、IndexedDB 摘要格式化，纯逻辑 |
| `extension/tools/intercept.js`（新） | 三个 intercept 工具的胶水，依赖注入 |
| `extension/tools/emulate.js`（新） | 从 `background.js` 抽出并扩展 |
| `extension/tools/storage.js`（新） | 通过 `chrome.scripting.executeScript` 在主 frame 读写 |
| `extension/test/*.test.js`（新） | 上述 lib 与 tools 的单元测试 |
| `relay/src/mcp-server.js` | 新增 4 个工具的 schema、描述、超时；扩展 `emulate` 的 schema；`storage` 加入 `QUEUED_TOOLS`；版本号 |
| `relay/test/*.test.js` | 工具清单改为 23 个；新增参数还原与范围约束用例 |
| `extension/manifest.json`、`relay/package.json`、`package-lock.json` | 版本号 2.1.0 |
| `README.md`、`batch-b-overview.html` | 同步（工具表、安全说明、迁移说明） |

不改动：WebSocket 消息协议、端口、MCP 端点、A 批的队列与 frame 逻辑、`Network.enable` 的调用方式。

## 3. 工具清单与接口定义

### 3.1 清单

A 批后 19 个，新增 `storage`、`intercept_add`、`intercept_list`、`intercept_remove`，共 23 个。不删除任何旧工具。

### 3.2 `storage`

```js
storage: {
  action: z.enum(['list', 'get', 'set', 'remove', 'clear', 'idb']),
  tabId: num(),
  area: z.enum(['local', 'session']).optional().describe('list/get/set/remove/clear: which storage, default local'),
  key: z.string().optional().describe('get/set/remove: key'),
  value: z.string().optional().describe('set: value (strings only)'),
  maxChars: num(z.number().int().min(100).max(200000)).optional().default(2000)
    .describe('get: max characters of the value returned inline'),
}
```

按 action 的必填校验放在扩展侧（`get` / `set` / `remove` 要 `key`，`set` 要 `value`），沿用 A 批做法。

### 3.3 `intercept_add`

```js
intercept_add: {
  tabId: num(),
  urlPattern: z.string().min(1).describe('Wildcard pattern: * zero or more chars, ? exactly one char'),
  action: z.enum(['fail', 'fulfill', 'delay']),
  method: z.string().optional().describe('Only match this HTTP method, case-insensitive'),
  // fail
  errorReason: z.enum([...14 个 ErrorReason...]).optional().default('Failed'),
  // fulfill
  status: num(z.number().int().min(100).max(599)).optional().default(200),
  headers: z.record(z.string()).optional(),
  body: z.string().optional().describe('fulfill: text response body'),
  // delay
  delayMs: num(z.number().int().min(1).max(60000)).optional(),
}
```

校验：`fulfill` 的 `body` 上限 1 MB；`delay` 必须有 `delayMs`；同一标签页最多 50 条规则。

### 3.4 `intercept_list`、`intercept_remove`

```js
intercept_list:   { tabId: num() }
intercept_remove: { tabId: num(), ruleId: z.string().optional().describe('Omit to remove all rules and turn interception off') }
```

### 3.5 `emulate`（扩展，旧参数全部保留）

```js
// 新增参数
device: z.enum(['iphone-15', 'ipad-air', 'pixel-8']).optional(),
width: num(z.number().int().min(200).max(4000)).optional(),
height: num(z.number().int().min(200).max(4000)).optional(),
deviceScaleFactor: num(z.number().min(1).max(5)).optional(),
mobile: bool().optional(),
latitude: num(z.number().min(-90).max(90)).optional(),
longitude: num(z.number().min(-180).max(180)).optional(),
accuracy: num(z.number().min(0).max(100000)).optional(),
timezone: z.string().optional().describe('IANA name, e.g. Asia/Tokyo; empty string resets'),
locale: z.string().optional().describe('e.g. ja-JP; empty string resets'),
```

校验：`latitude` 与 `longitude` 必须成对；`timezone` 用 `Intl.DateTimeFormat(undefined,{timeZone})` 预校验，非法时在设置前报错，列出示例。

### 3.6 relay 超时

`storage: 10000`，三个 `intercept_*` 各 `10000`；`storage` 因写操作进队列，按 A 批规则叠加 `QUEUE_WAIT_MS`。`emulate` 保持 `10000`。

## 4. storage

### 4.1 实现路径

`chrome.scripting.executeScript({target:{tabId}, func, args})` 在**主 frame** 里直接操作 `window.localStorage` / `window.sessionStorage`。不走 CDP，所以调试器 attach 失败时仍可用，和 `read_page` 一致。

- `list`：遍历 `Object.keys`，每个值截断到 200 字符并标注原始字节数；最多列 200 个键，超出提示总数。
- `get`：返回完整值，超过 `maxChars` 截断并提示。
- `set` / `remove` / `clear`：执行后返回键数量变化。
- 页面禁用存储（隐私设置、沙箱 iframe、`file://` 的部分情况）时 `window.localStorage` 会抛 `SecurityError`，捕获后返回明确文案，不当成工具故障。

### 4.2 IndexedDB 只读摘要（`idb`）

在页面里执行：`indexedDB.databases()` 取库名和版本；对每个库用**当前版本**打开（`indexedDB.open(name, version)`，不触发升级），遍历 `objectStoreNames`，对每个仓库在只读事务里 `count()` 并读 `keyPath`、`autoIncrement`，随后 `db.close()`。

- 不读记录内容，不写入。
- 打开被阻塞（别的连接正在升级）时 3 秒超时，该库标为 `unavailable`，不拖垮整个调用。
- 库数量上限 20，仓库上限 50，超出提示。

### 4.3 范围与限制

- 只作用于主 frame 所在源。传子 frame 的需求本批不支持，工具描述里写明。
- 返回的 `origin` 放在首行，让 agent 确认自己操作的是哪个源。
- 不对值打码。`storage` 与 `cookies` 同级敏感，README 安全说明补一条。
- 写操作进串行队列（待确认项 A）：避免与同标签页的 `form_input`、点击交叠。

## 5. 请求拦截与 Mock

### 5.1 规则存储（`lib/intercept.js`）

```js
createInterceptStore() → {
  add(tabId, rule) → rule,            // 分配 id: r1, r2...（每标签页单调递增）
  remove(tabId, ruleId?) → removedCount,
  list(tabId) → rules,
  match(tabId, request) → rule | null, // 按添加顺序，第一条命中，命中次数 +1
  has(tabId) → boolean,
  dump() / load(snapshot),             // 给 chrome.storage.session 用
  dropTab(tabId),
}
rule = { id, urlPattern, method?, action, errorReason?, status?, headers?, body?, delayMs?, hits }
```

- **通配符匹配**：把 `urlPattern` 转成正则，`*` → `.*`，`?` → `.`，其余字符转义，反斜杠转义下一个字符；整串匹配。和 CDP 的 `RequestPattern` 语义一致，所以浏览器侧只需放行全部，规则在扩展侧匹配。
- **method**：不区分大小写，缺省匹配所有方法。

### 5.2 启用与关闭 `Fetch`

- 第一条规则加入时：`Fetch.enable({patterns:[{urlPattern:'*'}]})`，并给该标签页写入拦截标记。
- 最后一条规则删除时：`Fetch.disable`，移除标记。
- `Fetch.enable` 失败（调试器未 attach）时先 `ensureCdp`，仍失败则返回错误，**不留下半启用状态**：规则不入库。

### 5.3 `Fetch.requestPaused` 处理

在现有 `chrome.debugger.onEvent` 里分发。**铁律：每个被暂停的请求都必须被放行、失败或应答，没有第四种结局。**

```
收到 requestPaused
  try {
    rule = store.match(tabId, {url, method})
    无规则或无命中 → continueRequest
    fail     → failRequest(errorReason)
    fulfill  → fulfillRequest(status, headers, base64(body))
    delay    → sleep(delayMs) 后 continueRequest
  } catch {
    continueRequest（放行兜底，再失败就忽略）
  }
```

- 命中次数在应答前加一，保证 `intercept_list` 立即可见。
- `delay` 不阻塞其他请求：每个暂停请求独立处理，不串行。
- 响应阶段暂停（`responseStatusCode` 有值）不会出现，因为 pattern 只设请求阶段；若出现一律 `continueRequest`。

### 5.4 `fulfill` 的细节

- 文本 body 先转 UTF-8 再转 base64（沿用 A 批 `utf8ToBase64` 的分块写法，避免大字符串栈溢出）。
- 没给 `content-type` 时默认 `text/plain; charset=utf-8`。
- **CORS（待确认项 B）**：跨域 `fetch` 的 Mock 响应缺 `access-control-allow-origin` 会被页面拒绝，Mock 就像没生效。做法：
  - 响应头没有 `access-control-allow-origin` 时，若请求带 `Origin` 头则补上该值，否则不补。
  - 对命中 `fulfill` 规则的 **OPTIONS 预检**请求自动应答 204，并回显 `access-control-allow-origin`、`access-control-allow-methods`、`access-control-allow-headers`。规则的 `method` 显式写了 `OPTIONS` 时不自动应答，按用户规则走。
  - 带凭据的跨域请求（`access-control-allow-credentials`）本批不处理，写入已知限制。

### 5.5 Service Worker 回收与规则恢复

这是本批最大的风险（实验 X3）。

- **每次规则变化**：把整个 store 的快照写进 `chrome.storage.session`（键 `intercept:v1`）。
- **Service Worker 启动**：顶层同步注册 `onEvent` 监听（MV3 要求），首个 `requestPaused` 到来时若内存 store 为空，先 `await load()` 再匹配。
- **启动恢复扫描（X3 新增）**：Service Worker 每次启动时读快照，对快照里每个标签页先 `Fetch.disable`（实测可放开所有在途暂停请求，包括定时器已丢失的 `delay` 请求），再按快照规则 `Fetch.enable`。`sendCommand` 报调试器未挂载则丢弃该标签页规则并记提示。首个 `requestPaused` 处理前先等待扫描完成（共用一个 promise）。
  - 已知限制：唤醒 Service Worker 的那个请求可能被扫描一并放开，规则对它不生效一次；停止瞬间处于 `delay` 的请求会提前放行。
- **兜底**：恢复失败或快照里没有该标签页的规则时，立即 `continueRequest` 并对该标签页 `Fetch.disable`，同时记一条日志，下次 `intercept_list` 提示"拦截已因扩展重启而关闭"。宁可规则失效，也不让请求卡死。
- **重连入口（待确认项 D，已确认：加）**：现在没有任何机制在 Service Worker 停止后唤醒它并重连 relay。用已有的 `alarms` 权限加一个周期唤醒（不新增权限）：`chrome.alarms.create('keepalive', { periodInMinutes: 0.5 })`，`onAlarm` 里若 WebSocket 未连接则触发 `connect()`；`runtime.onStartup` / `onInstalled` 里同样确保连接。监听器必须在顶层同步注册。
- **标签页关闭**：`onRemoved` 里 `dropTab` 并更新快照。

### 5.6 与调试器生命周期的衔接

- 现有 `tabs.onUpdated` 在页面开始加载时会 `cdpDetach`，只对 trace、emulate 例外。**拦截标签页加入例外**，否则一次跳转规则就失效。
- `chrome.debugger.onDetach`（用户打开 DevTools、标签页崩溃等）：清掉该标签页的拦截标记，规则保留但标为"未生效"，`intercept_list` 提示用户重新 `intercept_add` 或先 `intercept_remove`。避免规则看似存在而实际没拦截。
- `Fetch` 与 `Network` 同时开启：被 Mock 的请求是否仍进入 `network list`，由实验 X2 确认；结果写进文档，`network` 的描述里据实说明。

## 6. emulate 扩展

### 6.1 设备预设（`lib/emulation.js`）

```js
DEVICE_PRESETS = {
  'iphone-15': { width: 393,  height: 852,  deviceScaleFactor: 3,     mobile: true, touch: true, platform: 'iPhone', userAgent: '<移动版 Safari UA>' },
  'ipad-air':  { width: 820,  height: 1180, deviceScaleFactor: 2,     mobile: true, touch: true, platform: 'iPad',   userAgent: '<iPadOS Safari UA>' },
  'pixel-8':   { width: 412,  height: 915,  deviceScaleFactor: 2.625, mobile: true, touch: true, platform: 'Android', userAgent: '<Android Chrome UA>' },
}
```

- UA 字符串里的浏览器和系统版本放在文件顶部一个常量块，编码时按当时的稳定版填写，并在文件里注明取值日期，后续只改这一处。
- `pixel-8` 额外传最小化的 `userAgentMetadata`（`mobile:true`、`platform:'Android'`），让 `navigator.userAgentData.mobile` 与 UA 一致。iOS 设备的 Safari 没有 `userAgentData`，不传。
- 合并规则：预设为底，显式的 `width` / `height` / `deviceScaleFactor` / `mobile` / `userAgent` 覆盖对应项。只传 `width` 不传 `height` 时用预设的高度；没有预设也没有 `height` 时报错。

### 6.2 应用与还原

应用顺序固定：视口 → 触摸 → UA → 时区 → 语言 → 位置。任一步失败时**已应用的步骤保留并在结果里列出**，不做半回滚（回滚本身可能失败，状态更难推断），报错信息写明哪一步失败、哪些已生效。

`reset:true` 按 `emulatedTabs` 里记录的"已设置项"逐项还原，某一项还原失败不阻止其他项：

| 项 | 还原调用 |
|----|----------|
| 视口 | `Emulation.clearDeviceMetricsOverride` |
| 触摸 | `Emulation.setTouchEmulationEnabled({enabled:false})` |
| UA | `Emulation.setUserAgentOverride({userAgent:''})` |
| 时区 | `Emulation.setTimezoneOverride({timezoneId:''})` |
| 语言 | `Emulation.setLocaleOverride({locale:''})` |
| 位置 | `Emulation.clearGeolocationOverride` |
| CPU、网络、配色 | 沿用现有实现 |

`emulatedTabs` 从 `Set` 改为 `Map<tabId, Set<项名>>`，既用于"加载期间不断开调试器"的判断（有任一项即例外），也用于精确还原和结果文案。

### 6.3 地理位置的限制

只能改"位置值"，不能代替用户授权。结果里在设置位置时固定追加提示：该站点在 Chrome 里没有位置权限时，页面读不到这个位置，授权弹窗也点不了。`latitude` / `longitude` 必须成对，缺一个直接报错。

### 6.4 语言

按实验 X4，`setLocaleOverride` 只改 `Intl`，不改 `navigator.language`。所以 `locale` 做两件事：

1. `Emulation.setLocaleOverride({locale})`，影响日期、数字格式。格式不需要转换，`ja-JP` 直接传。
2. `Emulation.setUserAgentOverride({userAgent, acceptLanguage: locale})`，让 `navigator.language`、`navigator.languages` 和请求头 `Accept-Language` 一致。

第 2 步要求必须带 `userAgent`。取值顺序：本次显式传的 `userAgent`，其次设备预设的 UA，最后在页面里读当前 `navigator.userAgent`。同一次调用里 `device` / `userAgent` / `locale` 合并成一次 `setUserAgentOverride`，避免互相覆盖。

副作用：设置 `locale` 后，页面发出的请求会带上新的 `Accept-Language`，这是预期行为，写进工具描述。`reset` 时 UA 覆盖的还原（`userAgent:''`）会同时清掉 `acceptLanguage`，不需要单独还原这一项。

## 7. 与 A 批机制的衔接

| 机制 | 处理 |
|------|------|
| 串行队列 | `storage` 的 `set` / `remove` / `clear` 进队列；`intercept_*`、`emulate`、`storage` 的读操作不进队列。`isQueuedCall` 与 relay 的 `QUEUED_TOOLS` 同步增加 `storage` |
| 请求头打码、`network` | 无改动。拦截命中的请求是否出现，见实验 X2 |
| 标签页关闭 | `onRemoved` 增加：拦截 store `dropTab`、`emulatedTabs.delete` |
| 标签组 | 无关 |

## 8. 测试方案

### 8.1 自动测试（`npm test`，无新依赖）

| 文件 | 覆盖点 |
|------|--------|
| `extension/test/intercept.test.js` | 通配符 `*` / `?` / 转义；整串匹配（不是子串）；method 大小写；按添加顺序第一条命中；命中计数；id 单调且删除后不复用；50 条上限；`remove` 单条与全部；`dump/load` 往返；`dropTab` |
| `extension/test/emulation.test.js` | 三个预设的字段完整；预设与显式参数的合并（只传 width、传 mobile:false 覆盖）；缺 height 报错；经纬度必须成对；非法时区在设置前被拒；还原计划只包含已设置项；`Map` 记录与部分失败的结果文案 |
| `extension/test/storage-view.test.js` | 200 字符截断与原始字节数；键数量上限；`get` 的 `maxChars` 截断；IndexedDB 摘要格式；不可用的库标注 |
| `extension/test/tools-intercept.test.js` | 注入假 `chrome.debugger`：首条规则触发 `Fetch.enable`、最后一条删除触发 `Fetch.disable`；`Fetch.enable` 失败时规则不入库；`requestPaused` 的 fail / fulfill / delay / 未命中 / 处理抛错时的放行兜底；OPTIONS 预检自动应答；CORS 头补全；快照恢复后首个暂停请求被正确处理；快照缺失时放行并关闭拦截 |
| `extension/test/tools-storage.test.js` | 注入假 `chrome.scripting`：各 action 的必填校验；`SecurityError` 文案；写操作返回键数量变化 |
| `extension/test/tools-emulate.test.js` | 新旧参数组合；应用顺序；中途失败时已生效项被列出；`reset` 逐项还原、单项失败不影响其余；旧调用（只传 `colorScheme`）行为不变 |
| `relay/test/schema.test.js` | 工具清单恰好 23 个；新工具参数的字符串数字还原；`errorReason` 枚举；范围约束；`emulate` 旧参数仍可用 |
| `relay/test/timeouts.test.js` | `storage` 叠加队列等待，`intercept_*` 不叠加 |

### 8.2 编码前的实验

在你的真实 Chrome 里通过 relay 做（扩展已装好；本机无法用临时 profile 加载扩展，这一点 A 批 E3 已踩过）。需要你配合的步骤会写明。

| 编号 | 问题 | 做法 | 通过标准 |
|------|------|------|----------|
| X1 | `Browser` 域是否被拒 | 在一个临时调试脚本里对测试标签页发 `Browser.setPermission` / `Browser.grantPermissions`（可通过一个临时工具入口或 `javascript_tool` 不可行，需临时在扩展里加一行；实验后撤掉） | 得到明确的拒绝错误，则"砍掉权限授予"成立；若意外成功，回来和你商量是否纳入 |
| X2 | `Fetch` + `Network` 同时开启 | 开 `Fetch.enable` 后让页面 `fetch` 一个被 `fulfill` 的 URL，再看 `network list` / `detail`；同时测一个被 `fail` 的 URL | 记录两者是否出现、状态码和失败原因是否正确；确认 `Fetch.enable` 不影响 A 批的 `Network` 记录 |
| X3 | Service Worker 回收后的拦截状态 | 加一条 `delay` 规则；在 `chrome://serviceworker-internals`（或扩展的 Service Worker 检查窗口）里手动停止该 Service Worker；再让页面发请求 | 记录：请求是卡死、被放行，还是被唤醒的 Service Worker 正常处理；据此定稿 5.5 的恢复与兜底 |
| X4 | `setLocaleOverride` 的格式 | 分别传 `ja-JP`、`ja_JP`、`ja`，读 `navigator.language` 与 `new Date().toLocaleDateString()` | 选出能生效的格式，确定是否需要内部转换 |
| X5 | 无权限站点上的地理位置 | 对从未授权的站点设置位置，页面调用 `navigator.geolocation.getCurrentPosition` | 记录是弹框、直接拒绝还是返回设置的位置，据此定稿 6.3 的提示文案 |
| X6 | `storage` 在受限场景 | 在 `file://` 页、沙箱 iframe 的页面、含 `indexedDB.databases()` 不可用的情况下调用 | 确认 `SecurityError` 被捕获成明确文案；`idb` 在无库时输出"0 databases" |

X3 需要你在浏览器里点一下停止 Service Worker，其余我自己做。X1 如需临时改扩展，会在实验后撤掉并说明。

### 实验结果

X2、X4、X5、X6 不依赖扩展，在本机 Chrome 155 的无头临时 profile 里用原始 CDP 做（不经过 `chrome.debugger`，所以不能说明扩展是否被允许调用这些方法，那是 X1 的问题）。X1、X3 必须经过真实扩展，见本节末尾。

**X2：`Fetch` 与 `Network` 同时开启**

- 被 `fulfill` 的请求照常出现在 `Network` 事件里（`requestWillBeSent` 加 `responseReceived 200`），所以 `network list` 里会显示成普通的 200，看不出是 Mock。`network` 的工具描述要据实写明。
- 被 `fail` 的请求会触发 `loadingFailed`，三种原因的实测字段：

| `errorReason` | `errorText` | 其它字段 |
|---|---|---|
| `BlockedByClient` | `net::ERR_BLOCKED_BY_CLIENT.Inspector` | `blockedReason=inspector` |
| `Aborted` | `net::ERR_ABORTED` | `canceled=true` |
| `TimedOut` | `net::ERR_TIMED_OUT` | 无 |

  现有 `failureReason()` 会把第一种显示成 `blocked: inspector`，可以接受，不需要改。
- 跨域 `fetch` 被 `fulfill` 时，响应缺 `access-control-allow-origin` 会失败（`net::ERR_FAILED`，`MissingAllowOriginHeader`），补上后页面拿到 Mock 数据。带 JSON 的跨域 POST 会先暂停一个 `OPTIONS` 预检请求，应答后 POST 才放行。预检也会进 `Network` 事件，所以 `network list` 里会多出 `OPTIONS` 条目。5.4 节的 CORS 补头与预检自动应答成立。
- `Fetch.disable` 之后页面请求立即恢复正常。

**X4：`setLocaleOverride`（修正 6.4）**

- `ja-JP`、`ja_JP`、`ja` 三种写法都被接受，`Intl` 解析出的区域分别是 `ja-JP`、`ja-JP`、`ja`，**不需要内部转换格式**。
- 它只改 `Intl` 的默认区域（完整日期变成 `2026年10月15日木曜日`），**不改 `navigator.language`**，仍是原来的 `zh-CN`。这与示意图里"影响 `navigator.language`"的说法不符。
- `navigator.language` 和 `navigator.languages` 只有通过 `Emulation.setUserAgentOverride` 的 `acceptLanguage` 才会变（实测变成 `ja-JP` 和 `["ja-JP"]`），用 `userAgent:''` 重置后恢复 `zh-CN`。
- 结论：`locale` 要同时做两件事，见更新后的 6.4。
- 时区：`Asia/Tokyo` 生效，传空串恢复；非法时区被 CDP 以 `Invalid timezone id` 拒绝。

**X5：未授权站点的地理位置**

- 无头环境下，未授权站点调用 `getCurrentPosition` 直接得到 `code 1 User denied Geolocation`，权限状态为 `denied`，设置位置值不会改变这一点。
- 对照：通过原始 CDP 在浏览器级别授权后，页面读到了设置的位置 `35.68,139.76`。这不是经过扩展做的，只说明"授权 + 位置值"两者缺一不可。
- 没验证的部分：有界面的 Chrome 对未授权站点是弹框还是直接拒绝，无头环境看不出来。6.3 的提示文案按"弹框或拒绝都可能"措辞。

**X6：`storage` 的受限场景**

- CSP `sandbox` 页面和 `data:` 页面访问 `localStorage` / `sessionStorage` 会抛 `SecurityError`（消息分别含 `lacks the 'allow-same-origin' flag` 和 `Storage is disabled inside 'data:' URLs`），必须捕获并转成明确文案。
- 普通页面和 `file://` 页面可正常读写；全新页面的 `indexedDB.databases()` 返回 `[]`，输出 `0 databases`。
- 没验证的部分：扩展对 `file://` 页面注入脚本需要用户在扩展详情里开启"允许访问文件网址"，这一点要在手测里确认；`databases()` 不可用的浏览器没有测。

**X1：`Browser` 域（经真实扩展的 `chrome.debugger`）**

`Browser.getVersion`、`Browser.grantPermissions`、`Browser.setPermission` 全部返回 `-32601 'Browser.xxx' wasn't found`；同一标签页上对照的 `Emulation.setTimezoneOverride` 成功。"砍掉权限授予"成立，与文档推断一致。

**X3：Service Worker 被停止后的拦截状态**

做法：临时探针在测试标签页开 `Fetch`，对每个暂停请求"扣 15 秒再放行"，页面每 3 秒发一个请求；在 `chrome://serviceworker-internals` 里停止本扩展的 Service Worker。探针日志写在 `chrome.storage.session`。

- 调试器会话在 Service Worker 停止后**仍然挂在标签页上**。新的 `Fetch.requestPaused` 事件会自动拉起新的 Service Worker 实例（至少两个实例是在我们要求用户点图标之前被事件拉起的）。所以 MV3 下首个事件到来时内存 store 为空是必然场景，快照恢复不是可选项。
- `chrome.storage.session` 跨实例保留（日志里汇集了 5 个不同实例的条目）。
- **停止瞬间在途的请求没人应答**：5 个请求（n=30–34）从此一直 pending，观察到至少 162 秒仍未超时放开。原因是 `delay` 靠 Service Worker 里的 `setTimeout`，实例被杀后定时器随之消失；日志无法区分"事件到达时没有实例"和"定时器消失"，后果相同。同一轮里另有 20 个 pending 是探针的 `log` 模式故意不放行的，不算证据。
- **`Fetch.disable` 可以放开全部卡住的请求**：对该标签页发一次后 3 秒内 25 个 pending 全部变为 200。
- 第一轮测试里扩展停止后 4 分多钟没有回来，但那次测试标签页已被导航走，无法判断事件能否唤醒；以第二轮为准。另外 `manifest.json` 声明了 `alarms` 权限，`background.js` 没有使用，没有任何定时唤醒或重连入口。

结论：请求卡死是真实风险，但有可靠的清除手段。5.5 已据此改写。

### 8.3 手测清单（你重载扩展后执行，我给出命令并回报结果）

1. `storage`：`list` / `get` / `set` / `remove` / `clear` 各一次，`local` 与 `session` 各测；`idb` 在有库和无库的页面各一次；`SecurityError` 页面。
2. `intercept_add` 三种行为各一条；`intercept_list` 命中次数递增；`intercept_remove` 单条与全部；全部删除后确认页面不再被拦截。
3. 拦截下页面跳转：规则仍然生效；同一页面刷新后仍生效。
4. 跨域 `fetch` 被 `fulfill`：页面能拿到 Mock 数据（验证 CORS 补头与预检）。
5. 规则存在时打开 DevTools：规则被标为未生效，请求不卡死。
6. Service Worker 回收：按 X3 的结论回归一遍。
7. `emulate`：每个预设一次，检查 `window.innerWidth`、`devicePixelRatio`、`navigator.userAgent`、`ontouchstart`；自定义宽高；时区与语言读回；位置读回；`reset` 后全部恢复；旧参数（`cpuThrottlingRate` 等）回归。
8. 回归：A 批的 `tabs`、`network`、`read_page`、串行化抽查一遍。

## 9. 实施顺序

每一步结束都要能编译、测试通过、可独立验证。

| 步骤 | 内容 | 验收 |
|------|------|------|
| 0 | 做 X1–X6，结果写回本文第 8.2 节 | 六项实验有结论；X1 或 X3 结论出乎预期则回到你这里确认 |
| 1 | `lib/emulation.js`、`tools/emulate.js` 及测试；relay 的 `emulate` schema；`background.js` 改用新实现 | 两边 `npm test` 通过；手测第 7 项 |
| 2 | `lib/storage-view.js`、`tools/storage.js` 及测试；relay 的 `storage` schema 与队列联动 | 测试通过；手测第 1 项 |
| 3 | `lib/intercept.js`、`tools/intercept.js` 及测试；事件分发；`storage.session` 快照；调试器生命周期例外；relay 的三个 intercept schema | 测试通过；手测第 2–6 项 |
| 4 | 版本号 2.1.0；同步 README、`batch-b-overview.html`；全量回归（手测第 8 项） | 文档与代码一致 |

文档同步清单：

- README：工具数 19 → 23、工具表补四个新工具、`emulate` 新参数、"安全说明"补 `storage` 能读写页面存储的登录态、`intercept_*` 会改变页面看到的网络响应。
- `batch-b-overview.html`：设备预设数值、`storage` 输出、`intercept_list` 的"未生效"提示按最终格式更新。

## 10. 风险与已知限制

| 项 | 说明 | 缓解 |
|----|------|------|
| 请求卡死 | Service Worker 回收或异常时被暂停的请求无人放行 | 5.3 的"必须应答"铁律、5.5 的快照与兜底；实验 X3 |
| 规则静默失效 | 调试器被 DevTools 抢占或断开后规则看似存在 | `onDetach` 标记"未生效"，`intercept_list` 明示 |
| `Browser` 域被拒仅是文档结论 | 可能文档过时 | 实验 X1 先证实 |
| `setLocaleOverride` 是实验性方法 | 格式或行为可能变化 | 实验 X4；失败时报错而不是静默忽略 |
| 地理位置无法代替授权 | 无权限站点读不到位置 | 结果里固定提示，工具描述写明 |
| ~~`Accept-Language` 请求头不随 `locale` 改变~~（已过时） | 实现实际通过 `setUserAgentOverride` 的 `acceptLanguage` 同步改了请求头（见 tools/emulate.js），README 描述正确；C 批核对时修正本文 | 已实现，非限制 |
| ~~`fulfill` 只支持文本~~（C 批已解决） | `bodyBase64` 支持二进制响应体 | C 批 v2.2 |
| ~~带凭据的跨域 Mock~~（C 批已解决） | 自动补 `access-control-allow-credentials: true` | C 批 v2.2 |
| `storage` 只作用于主 frame 的源 | iframe 内的存储读不到 | 工具描述写明 |
| 登录态可被改写 | `storage set` 可直接改 token | 与 `cookies` 同级，README 安全说明写明；本机无鉴权的前提沿用 |
| 工具数 23 个 | 每个工具描述占用上下文 | 描述保持简短；已知代价 |

## 11. 需要你确认的点

1. **`storage` 写操作进串行队列（偏差 A）**：可以吗？不进队列的话，`storage set` 可能和同标签页的点击、`form_input` 交叠。
2. **`fulfill` 自动处理 CORS（偏差 B）**：补 `access-control-allow-origin` 并自动应答 OPTIONS 预检。不做的话，跨域 `fetch` 的 Mock 基本不可用，我建议保留。
3. **版本号（偏差 C）**：`2.1.0`，只增不删。
4. **周期唤醒与重连（偏差 D）**：已确认加。
5. 其余按本文执行。尤其是第 0 步的六个实验：X1 或 X3 的结果出乎预期时，我会带着结果回来和你商量，再继续。X3 需要你在浏览器里手动停一次 Service Worker。
