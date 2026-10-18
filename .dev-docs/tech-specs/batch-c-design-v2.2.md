# browser-mcp C 批技术设计（v2.2）

日期：2026-10-15。分支：`feat/batch-c-v2.2`（基于 `feat/batch-b-v2.1` b73a6c6）。上游文档：
`context-summary-batch-c.md`（上下文摘要）、`batch-c-overview.html`（示意图，已按用户"全部按建议来、不考虑兼容"确认）。

用户已拍板（本轮）：
- 全部按我建议的默认选择执行；
- **不考虑兼容包袱**：老实现可以大胆改，行为按最优形态定。

## 1. 目标

| 项 | 内容 |
|----|------|
| `get_page_text` | 支持子 frame：`frameId` 定向提取 + `allFrames:true` 合并所有 frame |
| `javascript_tool` | 支持子 frame：`frameId` 在指定 frame 上下文执行（含 CDP 兜底） |
| `file_upload` | 支持子 frame：`ref`/`triggerRef` 带 `f<frameId>.` 前缀直接可用；实现换 `backendNodeId` 通路，删掉 token 属性 hack |
| `intercept_add` | `bodyBase64` 二进制响应体；带凭据跨域 Mock 自动补 `access-control-allow-credentials: true` |
| 分层 | 三个老工具从 background.js 搬进 `lib/` + `tools/`，与 B 批结构一致 |
| 版本 | 2.2.0（manifest、relay package.json、mcp-server.js 两处字面量） |

不做：新工具、新权限、新依赖；`storage` 的 iframe 支持（每源独立、语义复杂，留后续）；`file_upload` 的链路增强（上传后事件触发等，无明确需求）。

## 2. 接口定义（relay schema）

### 2.1 `get_page_text`

```
tabId      num 必填
frameId    num 可选——只在指定 frame 提取正文（0=主 frame）
allFrames  bool 可选，默认 false——合并所有 frame 的正文
max_chars  num 可选，默认 50000，1k–200k（对全部 frame 合计）
```

- `allFrames:true` 与 `frameId` 互斥（同时传报错）。
- 合并输出：主 frame 在前，子 frame 按 frameId 升序；每段头 `Frame f<N> (<url>):`；空文本 frame 跳过；超 `max_chars` 整行截断（沿用 `mergeFrameTrees` 的整行边界策略，新写 `mergeFrameTexts`）；被挤掉的 frame 以 `omitted: f<N>` 提示。
- 单 frame 模式输出与现状同构（Title/URL/正文），尾部带 `frame` 行标识来源。

### 2.2 `javascript_tool`

```
tabId   num 必填
frameId num 可选，默认 0——在该 frame 的上下文执行
text    str 必填，≤100000 字符
```

- `document`、`location`、`window` 都是目标 frame 的。返回值格式化逻辑不变。
- frame 不存在 → 明确报错（提示重新 read_page），不静默落到主 frame。

### 2.3 `file_upload`

schema 不变（`ref`/`triggerRef` 的值本来就可以带前缀）。删除"子 frame 拒绝"分支。

### 2.4 `intercept_add`

```
bodyBase64 str 可选——base64 编码的二进制响应体（与 body 互斥）
```

其余不变。校验规则：

- `body` 与 `bodyBase64` 同时传 → `Provide either body (text) or bodyBase64 (binary), not both`；
- base64 合法性（字符集 + 长度 %4）在 `validateRule` 里查，解码后 ≤ 1MB；
- 规则存储里二进制规则记 `bodyB64: <原样字符串>` 与 `bodyBytes: <解码字节数>`，`formatRule` 显示字节数不显示内容；快照 dump/load 照常（load 时重新校验）。

### 2.5 凭据跨域（`buildFulfillment` / `buildPreflightResponse`）

- 请求带 `Origin` 且是跨域（Origin ≠ 页面源——**取不到页面源时保守起见只要带 Origin 就补**，多补一个头对同源请求无害）→ 自动补：
  - `access-control-allow-origin: <回显 Origin>`（现状已有）
  - `access-control-allow-credentials: true`（新增；规则自己写了同名头则不覆盖）
- 预检自动应答同样补 `allow-credentials: true` 与回显 Origin（现状是 `Origin ?? '*'`，改为带 Origin 时回显并加 credentials，无 Origin 才用 `*`）。
- 依据：CORS 规范禁止 `*` 与 credentials 同用；带 cookie 的跨域 fetch 没有这两个头会被浏览器拒收。

## 3. 扩展侧模块拆分

```
extension/lib/frames.js        +mergeFrameTexts(results, maxChars)
extension/lib/js-tool.js       新建：formatJsResult（从 background.js 搬入，纯函数）
extension/lib/page-text.js     新建：mergePageText 输出格式化（纯函数）
extension/tools/page-tools.js  新建：createJavascriptTool / createGetPageTextTool / createFileUploadTool
extension/background.js        三个老工具实现删除，改为工厂注入；TOOL_MAP/超时/队列接线不变
```

注入依赖（`createPageTools({ chrome, ok, err, ensureCdp, ensureCs, parseRef, runInRefFrame, collectFrameInfos, resolveFrameOffset, toTopPoint, sleep })`）。

### 3.1 `get_page_text` 实现

- `allFrames`：`executeScript({target:{tabId, allFrames:true}})` 每帧跑现有 `getPageText(max)`（max 按帧放宽到 `max_chars`，总量在 merge 时控制）→ `mergeFrameTexts`。
- `frameId` 定向：`target:{tabId, frameIds:[frameId]}`；返回空（frame 不存在或无内容脚本）→ 报错 `Frame f<N> not found ... run read_page again`。
- 现状行为（不传新参数）保持：只主 frame——**这是接口语义不是兼容包袱**：正文提取默认主 frame 是合理默认。

### 3.2 `javascript_tool` 实现

- 主路径 `executeScript({target:{tabId, frameIds:[frameId]}})`，页面函数不变（语句/表达式探测 + eval 包装）。
- frame 不存在：executeScript 对未知 frameIds 抛错或返回空数组 → 转成明确报错。
- CDP 兜底（attach 后 executeScript 失败时）：`Page.getFrameTree` 找目标 frame 的 `executionContextId`？——不可靠（上下文可能在导航后失效）。**兜底改为：`Runtime.evaluate` 前先 `Page.createIsolatedWorld({frameId})` 取 `executionContextId` 再 evaluate**。实验 C1 验证。
- 100000 字符上限不变（每 frame 相同）。

### 3.3 `file_upload` 实现（重写核心通路）

ref 路径（主/子 frame 通用）：

1. `runInRefFrame` 在目标 frame 里拿 input 元素并返回 `backendNodeId`？——页面脚本拿不到 backendNodeId。**正确机制：`DOM.getDocument` + `DOM.querySelector` 限定在目标 frame 的文档**。页面级 `DOM.querySelector` 只搜主 frame；要搜子 frame 需要：
   - `DOM.getFrameOwner`？不适用（那是从 frame 找 owner）。
   - 标准做法：`DOM.getDocument` 时带 `depth:-1`，然后沿 `frameId` 匹配 `DOM.Document` 事件 / 或 `DOM.getFlattenedDocument`。**chrome.debugger 的 `DOM.querySelector` 接受 nodeId，任何 frame 的文档根 nodeId 都行**——问题只是怎么拿到子 frame 文档的根 nodeId。
   - 拿法：`Page.getFrameTree` → 每个子 frame 在 `DOM.getDocument` 后会派发 `DOM.setChildNodes`/frame 的 contentDocument 节点。**更简单的稳定通路：`DOM.performSearch`（全局搜索）→ `DOM.getSearchResults` → nodeId**。performSearch 是跨 frame 的（DevTools 元素面板全局搜索就是这么实现的）。实验 C2 验证。
   - 拿到 nodeId 后 `DOM.setFileInputFiles({files, nodeId})`。nodeId 在 `DOM.getDocument` 的同一会话内有效（attach 期间稳定）。
2. 实验备选（若 performSearch 不可用）：token 属性方案保留但 `runInRefFrame` 化——在目标 frame 打 token，主 frame `DOM.querySelector` 搜不到子 frame 文档，改用 `DOM.querySelectorAll` on 子 frame root（先 `DOM.getDocument{depth:-1}` 遍历 contentDocument 找 frameId）。

triggerRef 路径：点击坐标复用 `getElemCoords`（A 批跨域握手，主/子 frame 已通用）；`Page.setInterceptFileChooserDialog` + `Page.fileChooserOpened.backendNodeId` + `DOM.setFileInputFiles` 本来就是 frame 无关的（backendNodeId 直接指向触发元素），**现状已天然支持子 frame**，只需删掉入口的拒绝分支。实验 C3 验证。

### 3.4 intercept 二进制

- `lib/intercept.js`：`validateRule` 加 `bodyBase64` 分支（校验 base64、算字节数、存 `bodyB64`/`bodyBytes`）；`buildFulfillment` 用 `rule.bodyB64 ?? utf8ToBase64(rule.body)`；`formatRule` 二进制显示 `body <N> B (base64)`；`dump/load` 兼容（load 走同一 validateRule）。
- base64 校验：`/^[A-Za-z0-9+/]*={0,2}$/` 且长度 %4==0 且非空；解码字节数 = len*3/4 - padding。纯函数 `decodeBase64Length(s)`。

### 3.5 WS 大消息

`bodyBase64` 上限 1MB → base64 字符串 ~1.37MB → JSON 包装后 WS 单帧 ~1.4MB。`ws` 库默认 `maxPayload` 100MB（服务端）/浏览器 WebSocket 无硬限。relay→扩展的请求经 `sendMsg(JSON.stringify)`，实测路径无风险，**不加改动**；实验 C4 用 800KB 二进制过一遍全链路确认。

## 4. relay 侧改动

- `SCHEMAS.get_page_text` +`frameId`/`allFrames`；`SCHEMAS.javascript_tool` +`frameId`；`SCHEMAS.intercept_add` +`bodyBase64`。
- DESCRIPTIONS 三处更新（javascript/get_page_text/frameId 说明、file_upload 删"主 frame"限制语、intercept_add 删"credentialed cross-origin requests are not handled"改为说明自动补头）。
- TOOL_TIMEOUTS 不变（三个工具耗时特征没变）。
- 版本字面量 ×2、package.json、manifest → 2.2.0。

## 5. 实验清单（编码前跑，真实扩展环境）

| # | 实验 | 验证点 | 结果 |
|---|------|--------|------|
| C1 | `Page.createIsolatedWorld({frameId})` + `Runtime.evaluate{executionContextId}` 在跨域子 frame 执行 JS | 兜底通路可用；返回值正确 | **工具层无法直调 CDP 单命令，改为编码后用真实实现自测**（风险已登记，见 7 章） |
| C2 | `DOM.performSearch('input[type=file]')` 跨 frame 搜索 → nodeId → `DOM.setFileInputFiles` | ref 路径在子 frame 可用 | 同上，编码后自测；备选通路已写入 3.3 |
| C3 | 子 frame 里点触发按钮 → `Page.fileChooserOpened.backendNodeId` → 设文件 | triggerRef 路径天然支持子 frame | 同上 |
| C4 | `intercept_add` bodyBase64 800KB PNG → 页面 `<img>` 显示 Mock 图 | 大 base64 全链路（relay→WS→扩展→CDP）无截断 | **现状证据已取得**：宽松 schema 静默忽略未知 `bodyBase64`，规则落成空 body（`body 0 B`）——正是要修的点；测试资产 `/tmp/bmcp-c/big.png`（792793 B，1200×660）与 `big.b64`（1057060 字符）已备好 |
| C5 | 带凭据跨域 fetch（credentials:'include'）被 fulfill Mock | 页面拿到响应不报 CORS 错 | **现状证据已取得**：Mock 命中后浏览器报 `blocked: cors (InvalidAllowCredentials)`（network detail #2 证实 `allow-origin` 已回显、缺 `allow-credentials`）；无 Mock 的真实请求因服务端无 CORS 头报 `MissingAllowOriginHeader`。改动方向被证实 |

实验环境：E1 fixture（`extension/test/fixtures/e1-server.js`，9401→9402→9403）+ 重载后的真实扩展 + curl 直连 `/mcp`。实验用 `javascript_tool`/临时脚本在页面上构造断言，不动用户业务标签页。

## 6. 测试计划

新增：
- `extension/test/page-text.test.js`：`mergeFrameTexts` 纯函数（排序、截断、omitted、空 frame 跳过）。
- `extension/test/js-tool.test.js`：`formatJsResult`（从 background 搬出后行为不变）。
- `extension/test/tools-page.test.js`：三个工具的 mock-chrome 断言——javascript frameId 路由到 frameIds、get_page_text 三种模式、file_upload ref 前缀解析（performSearch 调用与参数、fileChooserOpened backendNodeId 通路）、frame 不存在报错。
- `extension/test/intercept.test.js` 增补：bodyBase64 校验（互斥、坏 base64、字节数）、formatRule 二进制显示、load 快照含 bodyB64。
- `extension/test/tools-intercept.test.js` 增补：fulfill 二进制规则命中后 `Fetch.fulfillRequest` 的 body 是原样 base64。
- `relay/test/schema.test.js` 增补：新字段存在与类型；互斥校验在扩展侧（schema 层不表达互斥，靠 describe 说明 + 扩展侧 err）。

回归：relay 24 项 + extension 193 项全部通过。

手测清单（真实浏览器，全部通过才算完）：
1. E1 页 `read_page` 拿 `f3.ref_*`（leaf frame 里的按钮）。
2. `file_upload` ref=f3 的 file input 设文件（fixture leaf 页加一个 input[type=file] + change 记录）。
3. `javascript_tool` frameId=leaf 的 frameId：读 `location.href` 是 9403、改 DOM 生效。
4. `get_page_text` allFrames:true：三段正文都出现；frameId 定向：只出现指定段。
5. `intercept_add` bodyBase64（用 icons 下真实 PNG）Mock 9401 页的图片请求，页面 img.src 换成 Mock URL 后读 naturalWidth 确认解码成功。
6. 带凭据跨域 fetch Mock（C5 同场景）。
7. 既有工具抽查：read_page/find/computer 点击/storage/navigate 行为不变。

## 7. 风险与已知限制

| 项 | 说明 | 缓解 |
|----|------|------|
| `DOM.performSearch` 在 chrome.debugger 的可用性 | 文档级结论，未实测 | 实验 C2；备选 contentDocument 遍历通路 |
| isolated world 与页面世界隔离 | 兜底路径里页面变量读不到 | 兜底仅用于 executeScript 失败的受限页面场景，主路径不受影响；写进已知限制 |
| `get_page_text` allFrames 在深嵌套页的耗时 | 每 frame 一次正文提取 | maxChars 总量控制 + 30 frame 上限（沿用 MAX_MERGED_FRAMES） |
| 二进制 body 的 `intercept_list` 不显示内容 | 无法肉眼核对规则内容 | 显示字节数 + `bodyBase64` 入参原样 |
| allow-credentials 保守补头 | 同源请求也带这个头 | 同源响应带该头无害（浏览器忽略） |
| 老工具搬迁回归风险 | background.js 删 ~130 行 | mock-chrome 单测全覆盖 + 手测清单第 7 项 |

## 7.5 手测阶段发现：扩展重载无法自动化

2026-10-15 手测时发现：把磁盘代码更新到 2.2.0 后，**没有任何自动化途径能触发未打包扩展重新加载**：
- System Events 的 AX click / AXPress、Swift CGEventPost、cliclick 真实 HID 点击、深链详情页按钮、列表页卡片按钮、页面顶部"更新"按钮——全部"执行成功"但无效果（worker 不重启，relay 报的扩展版本一直是 2.1.0）。
- keepalive alarm（30 秒周期）让 MV3 worker 常驻不回收，"kill relay 制造空闲"也无效（且 relay 由 ZCode 的 watcher 自动拉起）。
- B 批当时的"点击成功"很可能是用户恰好在场手点，被误归因给脚本。

结论：**改扩展代码后需要用户手动到 chrome://extensions 点一次"重新加载"**。后续批次如需频繁迭代扩展，考虑加一个 `chrome.runtime.reload()` 的管理动作（它自身也要先手动重载一次才生效，属一次性成本）。

## 7.6 手测发现的缺陷与修复（v2.2.3）

拿到 2.2.2 扩展后跑手测清单，暴露 4 个真实缺陷并全部修复：

| # | 缺陷 | 根因 | 修复 |
|---|------|------|------|
| 1 | `javascript_tool` 在所有声明 CSP 的页面上完全失效 | C 批搬迁时把页面 eval 的错误从 `throw`（会触发 CDP 回退）改成 `return err`，切断了绕过 CSP 的唯一通路 | 改以 CDP `Runtime.evaluate` 为主路径（调试协议求值不受页面 CSP 约束），主 frame 用默认上下文，子 frame 用跟踪到的主世界上下文 |
| 2 | 子 frame 的 `javascript_tool` 报 Frame not found | `frameContexts` 的 key 是 CDP 字符串 frameId，而 ref 前缀的 `f<N>` 是 chrome.scripting 的数字 id，**两套体系缺映射** | 新增 `flattenFrameTree` + `buildFrameIdMap`（按 URL+window.name 配对），`toCdpFrameId` 换算 |
| 3 | `file_upload` 子 frame 报 "DOM agent is not enabled" / 定位不到 | 新写的 `DOM.performSearch` 路径既缺 `DOM.enable`，也受主 frame DOM 域限制 | 改为在目标 frame 的上下文里用 `Runtime.evaluate` 取元素 `objectId`，再 `DOM.setFileInputFiles({objectId})`——天然支持子 frame |
| 4 | ~1 MB 的 `bodyBase64` 报 HTTP 413 | `express.json()` 默认 100 KB 上限 | 提到 `8mb` |
| 5 | 多语句片段（如 `a(); b();`）报 SyntaxError | 搬迁时删掉了旧实现的"表达式失败→async IIFE 重试" | 补回语法错重试 |

同时新增**自助重载通道**：`POST http://127.0.0.1:3000/reload` → relay 发 `extension/reload` → 扩展 `chrome.runtime.reload()`。
这根治了 7.5 记录的重载阻塞。附注：若仍需手动重载，`chrome://extensions` 的按钮**只能用键盘激活**（Tab 聚焦到"重新加载"后按空格）——鼠标点击（System Events / HID / cliclick）在本机 Chrome 155 上全部无效，键盘激活则一次成功。

手测结论（v2.2.3，全部通过）：`javascript_tool` 主/子 frame 与语句/表达式/多语句均正常；`file_upload` 子 frame 设文件后目标 frame 的 change 事件真实触发（`CHANGED:big.png/792793`）；`get_page_text` 三模式正确；792793 B 的 PNG 经 `bodyBase64` Mock 出图 `IMG=1200x660`；带凭据跨域 Mock 拿到 `CORS=ok:200:{"mock":true}`（改前为 `InvalidAllowCredentials`）；`find`/`storage`/`computer`/`network` 抽查无回归。

## 8. 提交与文档

- 分文件提交：① 扩展实现（lib/tools/background）② 扩展测试 ③ relay schema+版本 ④ 文档（README + 示意图更新 + 本文档 + B 批文档修正）。
- README：工具表三行更新（get_page_text/javascript_tool/frameId、file_upload 删限制、intercept_add 补 bodyBase64/credentials）、"iframe 与 Shadow DOM"特性段补三个工具。
- `batch-c-overview.html`：按最终格式更新输出示例。
- B 批文档修正：10 章"Accept-Language 不随 locale 变"改为已实现说明；"fulfill 只支持文本"与"带凭据"两行标注已由 C 批解决。
