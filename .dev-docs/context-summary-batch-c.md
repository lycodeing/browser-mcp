# C 批上下文摘要（frame 全覆盖 + intercept 增强）

日期：2026-10-15。分支：`feat/batch-c-v2.2`（从 `feat/batch-b-v2.1` b73a6c6 切出）。

## 任务来源

- B→E 批次顺序此前口头商定，未落档；B 批收尾时用户指示"开始 C"。范围从 A/B 批文档明确写"留到后续批次"的遗留项梳理而来（已向用户提问确认，未获回复，按推荐范围执行）：
  1. **frame 全覆盖**（A 批 5.6）：`get_page_text`、`javascript_tool`、`file_upload` 三个工具支持子 frame。
  2. **intercept 增强**（B 批已知限制）：`fulfill` 二进制响应体；带凭据跨域 Mock。
- 仓库卫生一项查实为已过时（fafc166 已清理 `.DS_Store`/`.zcode/`），不在本批范围。
- B 批设计文档 10 章"Accept-Language 不随 locale 变"已过时（实现走 `setUserAgentOverride` 的 `acceptLanguage`，README 描述正确），本批顺手修正该文档。

## 现状与可复用基础设施

### frame 路由（A 批已建，全部可复用）

- `extension/lib/frames.js`：`parseRef`（`f3.ref_7` → `{frameId:3, ref:'ref_7'}`）、`formatRef`、`prefixTreeRefs`、`mergeFrameTrees`、`mergeFindResults`、`sortFrames`。
- `extension/background.js`：
  - `ensureCs`（130 行）：`allFrames:true` 注入三个 content scripts，幂等。
  - `runInRefFrame(tabId, parsed, func, args)`（142 行）：`frameIds:[frameId]` 定向执行，frame 不存在返回 undefined。
  - `collectFrameInfos`（152 行）：握手后采集各 frame 的 `{frameId, url, name, depth}`。
  - `toolReadPage`（501 行）与 `toolFind` 是 frame 路由的样板：`parsedRef ? frameIds 单帧 : allFrames 全帧`，再 merge。
- ref 语义：主 frame `ref_N`，子 frame `f<frameId>.ref_N`；每 frame 计数器独立。

### 三个待改工具的现状（都在 extension/background.js）

- `toolJavascript`（644 行）：`executeScript target:{tabId}` 无 frameIds——只主 frame；有 CDP `Runtime.evaluate` 兜底（同样只主 frame，因为 `sendCommand({tabId})` 无 sessionId）。
- `toolGetPageText`（699 行）：`target:{tabId}` 只主 frame；`getPageText(max)` 在 page-bridge.js，返回 `{url,title,sourceElement,content}`。
- `toolFileUpload`（713 行）：显式拒绝子 frame ref（719 行报错）；流程 = 打 token 属性 → `DOM.querySelector` 找 nodeId → `DOM.setFileInputFiles` → 清 token。`DOM.getDocument`/`DOM.querySelector`/`DOM.setFileInputFiles` 都是页面级 CDP 命令，`querySelector` 可以用带 frameId 的 `DOM.performSearch`？否——正确路径见设计文档。

### intercept（B 批）

- `extension/lib/intercept.js`：`validateRule`（body 只收字符串，`utf8Length ≤ 1MB`）、`buildFulfillment`（`utf8ToBase64(rule.body)`，补 content-type 与 allow-origin）、`createInterceptStore`（dump/load 快照）。
- `Fetch.fulfillRequest` 的 `body` 本来就是 base64——二进制支持只需把"文本→base64"换成"原文就是 base64"的通路，CDP 侧零改动。
- CORS：`buildPreflightResponse` 应答 OPTIONS；`access-control-allow-credentials` 完全没处理。
- 带凭据跨域请求：`Fetch.requestPaused` 的 request 事件目前只匹配请求阶段 pattern。

### relay 侧

- `relay/src/mcp-server.js`：`SCHEMAS`（24 行起）、`TOOL_TIMEOUTS`（288 行）。`javascript_tool`/`get_page_text`/`file_upload` 的 schema 无 frame 相关字段——**无需新增参数**，frame 指定完全走 ref 前缀；`intercept_add` 的 body schema 需要加 `bodyBase64`。

### 测试

- `relay/test/schema.test.js`、`timeouts.test.js`：schema/超时覆盖测试，加字段要同步。
- `extension/test/`：193 个测试。frame 相关样板在 `tools-*.test.js`（mock chrome 断言调用参数）；intercept 纯逻辑测试在 `extension/test/intercept.test.js`。
- 手测 E1 fixture：`extension/test/fixtures/e1-server.js`（9401→9402→9403 三层跨域嵌套 iframe），可直接复用做 frame 手测。

## 项目模式（沿用）

- 工具实现拆 `extension/lib/*.js`（纯逻辑，无 chrome 依赖，可单测）+ `extension/tools/*.js`（胶水，注入依赖）+ `background.js`（注册）。但 1.0 时期的老工具（javascript/get_page_text/file_upload）仍直接写在 background.js 里——本批是否搬迁见设计文档决策点。
- relay schema → 扩展 TOOL_MAP → README 工具表，三处同步；版本号三处（manifest、relay package.json、mcp-server.js 两处字面量）。
- 实测流程：改扩展代码 → chrome://extensions 重载（System Events 点按钮，进程 60404）→ curl 直连 `http://127.0.0.1:3000/mcp`（SSE 格式，剥 `data: ` 前缀）；改 relay 只需 kill 旧进程自动拉起。
- 提交规范：按文件分组多 commit，message 只写变更不含 AI 署名。

## 充分性自检

- 相似实现 ≥3：`toolReadPage`/`toolFind`（frameIds 路由 + merge）、`toolFormInput`（runInRefFrame 用法）、B 批 `storage.js` 胶水模式。
- 模式清单：err/ok 包装、`ensureCs` 前置、`parseRef` 路由、lib/tools 分层、快照 dump/load。
- 不重复造轮子：frame 前缀、握手、合并全部复用 A 批。
- 测试策略：lib 纯函数单测 + tools mock-chrome 断言 + relay schema 覆盖 + E1 fixture 手测。

## 待用户确认的点

1. `javascript_tool` 在子 frame 执行的入口方式（加 `frameId` 参数 vs 复用 ref 前缀语义）——设计文档给了推荐。
2. `get_page_text` 全 frame 合并输出格式。
3. `intercept_add` 二进制 body 的入参形态（`bodyBase64` 新字段 vs 复用 `body`）。
4. 带凭据 Mock 的默认行为。
