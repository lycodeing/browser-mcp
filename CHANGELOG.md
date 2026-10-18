# 变更记录

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。工具数量与接口以 README 为准。

## [2.4.0] — 2026-10-19

新增「操作录制 + GIF 动图导出」功能，面向京东运营等非技术用户的重复性任务自动化。

### 新增（7 个工具）
- `record_start` / `record_stop`：开始/结束录制，捕获 click、input、导航键、URL 变化等事件。`record_stop` 给 `name` 自动保存到 `~/.browser-mcp/flows/<name>.json`，同时合成 GIF 动图（`captureGif:false` 可关闭）
- `record_list` / `record_delete`：列出/删除已保存的流程
- `record_run`：按名回放，支持 `strict`（默认 true，单步失败即停）与 `stepDelayMs`（默认 300ms 节流）
- `record_export_gif` / `record_export_json`：单独导出 GIF 或 JSON 到自定义路径

### 新增（扩展 popup）
- popup 升级为三 tab 面板：状态 / 录制 / 流程。运营不打开 AI 客户端也能点插件图标开始录制、看录制进度、管理已保存流程
- 录制 tab：红点脉冲提示 + 已捕获步数 + 流程名输入框 + GIF 导出开关
- 流程 tab：每个流程一行卡片，显示步骤数、GIF 大小、录制时间，一键回放/查看 GIF/删除

### 实现要点
- **target 多路兜底定位**：录制时同时捕获 text / ariaLabel / placeholder / role / tag / cssPath，回放按 text → aria/placeholder → role+tag → cssPath 顺序匹配，页面改版也能活
- **事件驱动截图**：每个事件步骤触发一帧截图（960px JPEG 质量 70），点击前注入 2 秒消失的红圈高亮，帧与步骤天然对齐，体积比定时截屏小 90%
- **GIF 编码**：`gif-encoder-2` + `jimp` 纯 JS 方案跑在 Relay，无原生编译依赖；帧间隔钳制 200-1500ms，输出超 3MB 自动降到 720px 宽重试
- **自动插入 wait_for**：URL 变化后自动补 `navigate + wait_for network_idle`，点击后 DOM 变化自动补 `wait_for element`，回放稳定
- **密码脱敏**：录制时 `input[type=password]` 的 value 自动替换为 `<REDACTED>`，回放前由 AI 问用户
- **input 防抖**：连续输入 300ms 内合并为一步，只记最终值

### 修复
- relay 现在能应答扩展主动发起的 `flow/list` / `flow/load` 请求（popup 与 MCP 工具拉流程数据的通道）
- 录制激活失败：`chrome.runtime.sendMessage` 从 Service Worker 发不到自身，改用 `chrome.tabs.sendMessage(tabId, msg, {frameId})` 激活 content script 的 recorder
- 回放报 `Flow has no steps`：relay 的 `flow/load` 应答从 `{flow: ...}` 改为直接返回 flow 本体，与扩展侧 `flow.steps` 的访问路径对齐

## [2.3.0] — 2026-10-18

### 变更（破坏性）
- `network` 拆分为 `network_list` / `network_detail`：list 只保留过滤参数，detail 必须传 `seq`。
- `tabs` 拆分为 `tabs_list` / `tab_create` / `tab_close` / `tab_activate` / `tab_reload` / `tab_duplicate` / `tab_group`：每个工具只保留自己用到的参数。
- `emulate` 拆分为 `emulate_device` / `emulate_network` / `emulate_geo`：colorScheme 不再暴露，UA 覆盖归入 `emulate_device`，`reset:true` 由 `emulate_device` 承载。
- `computer` 的高频动作拆出为顶层工具：`screenshot` / `click` / `sleep`。`computer` 保留拖拽、悬停、区域缩放、右键、三击等高级用法。
- 截图工具 `saveTo` 存在且未显式传 `returnImage:true` 时，不再把 base64 图塞进上下文，只返回落盘路径。

### 新增
- `state`：一屏获取当前浏览器状态（活动标签 id/URL/标题、frame 数、待处理弹窗、网络缓冲、控制台错误数、拦截规则数）。
- `form_input_multi`：一次填写多个字段（最多 20 个），第一个失败即停止并报告。
- `click`：按 `ref`（优先）或坐标点击，支持双击/三击/右键。
- `screenshot`：独立截图工具，支持 `fullPage`、`region` 裁剪、`saveTo` 落盘。
- `sleep`：固定等待秒数。

### 改进
- Relay 启动时自动清理 `os.tmpdir()/browser-mcp/` 下超过 1 小时的临时截图，防止磁盘膨胀。
- 工具描述按拆分后的职责重写，总长度从 ~10 KB 降至 ~4 KB，减少每次会话的固定 token 开销。
- `computer` 描述新增引导：优先 `read_page → find → form_input → click via ref`，截图仅在需要视觉确认时使用。

## [2.2.3] — 2026-10-18

手测阶段发现并修复的问题，以及开发体验改进。

### 修复
- **`javascript_tool` 在声明 CSP 的页面完全失效**：页面自己的 `script-src` 会拦下内容脚本里的 `eval`。改为以 CDP `Runtime.evaluate` 执行（调试协议的求值不受页面 CSP 约束），子 frame 通过其主世界执行上下文执行。
- **子 frame 的 JS/DOM 操作报 Frame not found**：ref 前缀的 `f<N>` 是 `chrome.scripting` 的数字 id，而 CDP 用字符串 frameId，两者原先未打通。新增按 URL 与 `window.name` 配对的映射。
- **`file_upload` 无法操作子 frame 的上传控件**：改为在目标 frame 的上下文里取元素 `objectId` 再设置文件，天然支持 iframe。
- **约 1 MB 的 `bodyBase64` 返回 HTTP 413**：Relay 的 JSON 请求体上限从默认 100 KB 提到 8 MB。
- **多语句 JS 片段报 SyntaxError**：语法错误时改用 `async` IIFE 重试。

### 新增
- `POST http://127.0.0.1:3000/reload`：让扩展重新加载自身，改完扩展代码无需手动去 `chrome://extensions`。

## [2.2.2] — 2026-10-17

### 改进
- 三类高频调用错误改为可自纠错提示：`tabId` 校验失败与 id 不存在时附上当前标签页列表与获取方式；把其它工具的动作传给 `computer` 时，报错直接给出对应工具名。

## [2.2.0] — 2026-10-15

### 新增
- `get_page_text` 支持 `frameId` 定向提取与 `allFrames:true` 合并所有 frame。
- `javascript_tool` 支持 `frameId`，在指定 iframe 的上下文执行。
- `file_upload` 的 `ref` / `triggerRef` 支持子 frame（如 `f3.ref_7`）。
- `intercept_add` 新增 `bodyBase64`，可 Mock 图片等二进制响应体。
- 跨域 Mock 自动补 `access-control-allow-credentials`，带凭据的跨域请求也可 Mock。

### 变更
- `get_page_text`、`javascript_tool`、`file_upload` 的实现从 `background.js` 拆到 `lib/` 与 `tools/` 分层。

## [2.1.0] — 2026-10-15

### 新增
- `storage`：读写主 frame 的 `localStorage` / `sessionStorage`，IndexedDB 只读摘要。
- `intercept_add` / `intercept_list` / `intercept_remove`：按 URL 通配符拦截请求并 Mock、延迟或令其失败，支持 CORS 预检自动应答，规则存 session storage 并在 Service Worker 重启后恢复。
- `emulate` 扩展：设备预设（`iphone-15` / `ipad-air` / `pixel-8`）、自定义视口与像素比、地理位置、时区、语言，`reset:true` 一键还原。

## [2.0.0] — 2026-10-15

### 变更（不向后兼容）
- `tabs_context` / `tabs_create` / `tabs_close` 合并为 `tabs`（`list` / `create` / `close` / `activate` / `reload` / `duplicate` / `group`）。
- `read_network_requests` 由 `network` 取代（`list` / `detail`）。
- `read_page` / `find` / `form_input` / `computer` 自动覆盖所有 frame 并进入 open shadow root，子 frame 的 ref 带 `f<frameId>.` 前缀。

### 新增
- 同一标签页的写操作按 `tabId` 先进先出串行执行，排队上限 30 秒。
- 观测到的请求头 `authorization` / `cookie` 默认打码，`rawHeaders:true` 可关闭。

## [1.1.0] — 2026-10-10

### 新增
- 工具：`wait_for`、`handle_dialog`、`save_pdf`、`cookies`、`downloads`、`performance`（`metrics` / `trace_start` / `trace_stop`）、`emulate`（CPU 与网络限速、配色、UA）。
- 截图与页面树的 token 优化：按 CSS 像素缩放、坐标自动换算、无障碍树精简、超大图落盘。

## [1.0.0] — 初始版本

Chrome 扩展 + 本地 MCP Relay：`computer`、`read_page`、`find`、`form_input`、`navigate`、`javascript_tool`、`get_page_text`、`file_upload`、`resize_window`、`read_console_messages` 等基础工具。
