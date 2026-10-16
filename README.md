<div align="center">

<img src="extension/icons/icon128.png" width="96" alt="browser-mcp logo" />

# browser-mcp

**让 AI 助手直接操控你正在用的 Chrome。**

一个 Chrome 扩展 + 本地 MCP Relay，把浏览器能力以 23 个工具的形式提供给 ZCode、Claude Code、pi 等任何支持 MCP 的客户端。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-8A2BE2)
![Tools](https://img.shields.io/badge/tools-23-orange)

[GitHub](https://github.com/lycodeing/browser-mcp) · [Gitee 镜像](https://gitee.com/lycodeing/browser-mcp)

</div>

---

## 为什么用它

- **用的是你自己的浏览器**：直接操作已登录的 Chrome，保留登录态、扩展和书签，不用另起一个无头浏览器，也不用重新登录。
- **一个端点，所有客户端**：标准 MCP Streamable HTTP，装一次，ZCode / Claude Code / pi 共用同一个 `http://127.0.0.1:3000/mcp`。
- **省 token**：截图按 CSS 像素输出并限制长边，页面树只保留可见元素，超大图片自动落盘只回传路径。
- **不容易卡死**：JS 弹窗自动应答，扩展断线后按递增间隔自动重连，CDP 暂时拒绝时自动重试。
- **宽松入参**：模型把数字、布尔、坐标写成字符串（`"123"`、`"[601, 385]"`）也能正常调用。
- **多 agent 并发**：多个 agent 同时操作不同标签页互不干扰；同一标签页上的写操作（点击、输入、导航等）自动排队，读操作不排队。`tabs` 的 `group` 参数让每个 agent 的标签页归入自己的彩色标签组，一眼看出谁在用哪个页面。
- **iframe 与 Shadow DOM**：`read_page`、`find`、`form_input`、`computer`、`get_page_text`、`file_upload` 自动覆盖所有 frame 并进入 open shadow root，子 frame 的 ref 带前缀（如 `f3.ref_7`），调用方式不变；`javascript_tool`、`get_page_text` 也可用 `frameId` 定向到某个 iframe。

## 工作原理

```
┌──────────────┐  MCP over HTTP   ┌───────────────┐   WebSocket    ┌────────────────────┐
│ ZCode        │ ───────────────▶ │               │ ─────────────▶ │  Chrome 扩展 (MV3)  │
│ Claude Code  │  127.0.0.1:3000  │  Node.js      │ 127.0.0.1:16789│  ├ chrome.debugger  │
│ pi / 其他    │ ◀─────────────── │  Relay        │ ◀───────────── │  ├ chrome.scripting │
└──────────────┘                  └───────────────┘                │  └ 内容脚本          │
                                                                   └────────────────────┘
```

Relay 对 AI 一侧暴露 MCP 端点，对浏览器一侧运行 WebSocket 服务。扩展主动连上 Relay，通过 Chrome DevTools Protocol 和 `chrome.scripting` 完成截图、点击、输入、读取页面等操作。

## 功能一览

23 个工具，按用途分四组。

### 页面交互与读取

| 工具 | 功能 |
|------|------|
| `computer` | 截图、点击（左/右/双击/三击）、拖拽、输入文字、按键、滚动、悬停、区域缩放。支持 `ref` 或坐标定位 |
| `read_page` | 精简无障碍树，只含可见元素；`filter:"interactive"` 仅列可交互元素 |
| `find` | 按关键词搜索页面元素，返回可直接点击的 `ref` |
| `form_input` | 填写 input / select / textarea / contenteditable |
| `navigate` | 跳转 URL、前进后退、处理 `beforeunload` |
| `get_page_text` | 提取页面正文纯文本；默认主 frame，`frameId` 定向提取某个 iframe，`allFrames:true` 合并所有 frame（各段带 frame 标头，总量受 `max_chars` 约束） |
| `file_upload` | 把本地文件上传到页面的文件选择器；`ref` 与 `triggerRef` 都支持 iframe 的 ref（如 `f3.ref_7`） |
| `wait_for` | 等待元素出现或消失、URL 变化、网络空闲或固定时长，替代盲等 |
| `handle_dialog` | 应答 alert / confirm / prompt，配合 `dialog:"manual"` 使用 |

### 标签页与窗口

| 工具 | 功能 |
|------|------|
| `tabs` | 标签页与标签组管理，按 `action` 区分：`list` 列出（显示所属组、窗口、是否激活）、`create` 新建（可带 `url`、`active`、`group`）、`close` 批量关闭、`activate` 切到前台、`reload` 重载、`duplicate` 复制、`group` 归组或取消分组 |
| `resize_window` | 调整浏览器窗口大小 |

### 调试与观测

| 工具 | 功能 |
|------|------|
| `javascript_tool` | 在页面上下文中执行 JavaScript；`frameId` 可指定在某个 iframe 里执行（`document`、`location` 都是那个 frame 的） |
| `read_console_messages` | 读取控制台日志缓冲，可按正则和级别过滤 |
| `network` | `list` 读取网络请求缓冲，每条带序号，失败请求显示原因（连接重置、CORS、被拦截等），可按 URL、方法、状态码（`404`、`4xx`、`500-599`）和 `failedOnly` 过滤；`detail` 按序号取请求头、响应头、POST 体和响应体，响应体超过 `bodyLimit` 时截断，可用 `saveTo` 落盘 |
| `performance` | `metrics` 即时读取 LCP / CLS / INP / FCP / TTFB、JS 堆、DOM 节点数、监听器数、最慢资源；`trace_start` / `trace_stop` 录制 Chrome trace，返回长任务、阻塞时间、主线程耗时分布和最重脚本 |
| `emulate` | 设备预设（`iphone-15` / `ipad-air` / `pixel-8`）或自定义宽高、像素比、移动端；地理位置、时区、语言；CPU 降速、网络限速（Slow 3G / Fast 3G / Fast 4G / Offline）、深浅色模式、User-Agent 覆盖，`reset:true` 一键还原。地理位置只有在站点已获得定位权限时页面才读得到，本工具无法授予权限 |
| `intercept_add` | 对标签页的请求加规则（按 URL 通配符，可限定方法）：`fail` 模拟网络错误、`fulfill` 返回 Mock 响应、`delay` 延迟放行。跨域 Mock 自动补 `access-control-allow-origin` 与 `access-control-allow-credentials` 并应答 CORS 预检，`body` 为文本响应体、`bodyBase64` 为二进制（如图片，解码后上限 1 MB），每个标签页最多 50 条，先匹配到的规则生效 |
| `intercept_list` | 列出标签页的规则、命中次数，以及拦截当前是否生效 |
| `intercept_remove` | 按 id 删除一条规则，不传 `ruleId` 则清空并关闭拦截 |

### 数据与产物

| 工具 | 功能 |
|------|------|
| `save_pdf` | 页面导出 PDF 到本地，纸张、方向、背景可配 |
| `cookies` | 读取、注入、删除、清除指定域的 Cookie |
| `storage` | 读写主 frame 的 `localStorage` / `sessionStorage`（`list` / `get` / `set` / `remove` / `clear`），`idb` 只读列出 IndexedDB 的库、对象仓库和记录数，不读记录内容。不支持 iframe，每次结果首行显示操作的源 |
| `downloads` | 列出下载，等待完成并返回本地文件路径，清除历史 |

### 截图与 token 优化

图片 token 只取决于像素数，与文件字节数无关，所以优化集中在"少给像素"：

- 截图按 CSS 像素输出，长边默认限制为 1280（`maxDimension` 可调），高 DPR 屏不再返回 2 到 3 倍像素。
- 缩放后点击、拖拽、滚动、`zoom` 的坐标，直接用截图里看到的像素，扩展内部会换算回页面坐标。全页截图不参与换算。
- `zoom` 从原图裁剪指定区域，保留原生清晰度，看细节不必放大整页。
- 单张图片超过约 1 MB（常见于 png 或 `fullPage`）时，Relay 自动存到系统临时目录的 `browser-mcp/` 下，只返回路径。也可以用 `saveTo` 指定落盘位置。
- 优先用 `find` / `read_page` 拿到 `ref` 再点击，截图只在需要视觉确认时调用。

## 快速开始

**环境要求**：Node.js 18+（开发环境为 22）、Chrome 或其他 Chromium 内核浏览器。

### 1. 启动 Relay

```bash
git clone https://github.com/lycodeing/browser-mcp.git
cd browser-mcp/relay
npm install
npm start
```

看到下面的输出就说明启动成功：

```
[Relay] browser-mcp relay started
  Extension WS : ws://127.0.0.1:16789
  MCP endpoint : http://127.0.0.1:3000/mcp
```

### 2. 安装 Chrome 扩展

1. 打开 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本项目的 `extension/` 目录
4. 点击工具栏里的扩展图标，状态显示 **Connected** 即成功

扩展会自动连接本地 Relay，断线后按 1s、2s、5s、10s、30s 的间隔重试，所以先装扩展还是先启动 Relay 都可以。扩展的 Service Worker 被 Chrome 回收后，每 30 秒的定时闹钟会把它唤醒并重新连接。

### 3. 配置 MCP 客户端

<details open>
<summary><b>ZCode</b></summary>

编辑 `~/.zcode/config.json`，或在 ZCode 设置界面的 MCP 配置区域添加：

```json
{
  "mcpServers": {
    "browser": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

</details>

<details>
<summary><b>Claude Code</b></summary>

用命令添加：

```bash
claude mcp add --transport http browser http://127.0.0.1:3000/mcp
```

或者在配置文件里写：

```json
{
  "mcpServers": {
    "browser": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

</details>

<details>
<summary><b>pi</b></summary>

编辑 `~/.pi/agent/mcp.json`（配合 pi-mcp-extension）：

```json
{
  "mcpServers": {
    "browser": {
      "transport": "streamable-http",
      "url": "http://127.0.0.1:3000/mcp",
      "lifecycle": "eager"
    }
  }
}
```

</details>

配置完成后重启客户端，工具列表里会出现 `browser__computer`、`browser__navigate` 等工具。

## 使用示例

对 AI 说"打开 example.com，截个图，然后点击 Submit 按钮"，它会按下面的顺序调用工具：

```
tabs      { action: "list" }                      → 拿到 tabId
navigate  { tabId, url: "https://example.com" }   → 打开页面
computer  { action: "screenshot", tabId }         → 看一眼当前状态
find      { tabId, query: "Submit" }              → 拿到 ref_42
computer  { action: "left_click", tabId, ref: "ref_42" }
```

更多场景：

- **排查前端问题**：`read_console_messages` 看报错，`network` 看失败的请求及原因，再用 `detail` 取响应体，`javascript_tool` 现场执行代码。
- **性能与弱网测试**：先用 `emulate` 限速并降 CPU，再用 `performance` 抓指标或录 trace。
- **移动端与地区测试**：`emulate` 选设备预设，再设时区和语言，看页面在手机视口、不同地区下的表现。
- **接口异常与 Mock**：`intercept_add` 让某个接口失败、变慢或返回假数据，不用改后端就能验证前端的错误处理；用完 `intercept_remove` 清掉。
- **登录态与本地存储**：`storage` 查看或改写 `localStorage` 里的 token、开关，`idb` 先看有哪些库再决定怎么查。
- **表单与文件**：`form_input` 填字段，`file_upload` 传文件，`save_pdf` 把结果导出。

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `EXT_PORT` | `16789` | 扩展 WebSocket 端口 |
| `MCP_PORT` | `3000` | MCP HTTP 端口 |

```bash
EXT_PORT=16789 MCP_PORT=3000 npm start
```

> 修改 `EXT_PORT` 时，扩展里写死的地址 `ws://127.0.0.1:16789`（`extension/background.js` 顶部的 `RELAY_URL`）也要同步修改。

## 安全说明

- Relay 的两个服务都只监听 `127.0.0.1`，局域网内其他机器连不上。
- **没有鉴权**：本机上的任何进程都能调用 MCP 端点，进而操作你的浏览器，包括读取 Cookie 和执行页面脚本。请只在你信任的环境里运行，不要把端口转发或暴露出去。
- `network` 的 `detail` 能读取页面请求的头、POST 体和响应体，与 `cookies` 工具同级敏感。`authorization`、`cookie` 等请求头默认显示为 `****`，传 `rawHeaders:true` 才原样输出。
- `storage` 能直接读写页面的 `localStorage` / `sessionStorage`，包括 token 等登录态，值不打码，与 `cookies` 同级敏感。
- `intercept_add` 的规则会改变页面收到的响应，只作用于你指定的标签页。规则存放在扩展的会话存储里，浏览器退出后消失。
- 扩展申请了 `debugger`、`cookies`、`<all_urls>` 等较大的权限，这是实现截图、网络监听和 Cookie 管理所必需的。

## 开发

```bash
cd relay
npm test    # node --test，覆盖入参宽松校验、工具清单、超时联动、saveTo 落盘
npm run dev # 文件变化后自动重启

cd ../extension
npm test    # node --test，覆盖串行队列、标签页与标签组、网络缓冲等纯逻辑模块
```

图标源图由 `extension/icons/generate_icon_source.py` 生成，再用 `resize_icons.py` 缩放出 16 / 48 / 128 三个尺寸。

### 项目结构

```
browser-mcp/
├── relay/                      # Node.js MCP Relay
│   ├── package.json
│   ├── test/                   # node --test
│   └── src/
│       ├── index.js            # 入口
│       ├── bridge.js           # 扩展与 MCP 之间的状态桥接
│       ├── extension-ws.js     # WebSocket 服务（扩展侧）
│       ├── schema-helpers.js   # 宽松入参 schema（接受字符串形式的数字/布尔/数组）
│       └── mcp-server.js       # MCP HTTP 服务（AI 侧）
└── extension/                  # Chrome 扩展 (Manifest V3)
    ├── manifest.json
    ├── background.js           # Service Worker，工具实现与消息路由
    ├── lib/                    # 纯逻辑模块（队列、URL、标签组、超时、emulate、storage、intercept），可用 node --test 测试
    ├── tools/                  # 依赖 chrome.* 的工具实现，依赖通过参数注入
    ├── test/
    ├── popup.html / popup.js   # 状态弹窗
    ├── icons/
    └── content-scripts/
        ├── accessibility-tree.js   # 页面元素树
        └── page-bridge.js          # 文本提取与元素搜索
```

## 常见问题

**扩展显示 Disconnected**
确认 Relay 正在运行，并检查端口是否被占用：`lsof -i :16789`。

**工具调用返回 "No extension connected"**
在 `chrome://extensions` 里点击扩展的刷新按钮，或重新加载扩展。

**tabId 相关报错**
`tabId` 是 Chrome 的数字标签页 id（形如 `1924551535`），只能通过 `tabs`（`action:"list"`）获取，不能是 UUID、标签标题或猜测的短编号。传错时校验错误会直接提示正确取法；id 不存在时错误会附上当前打开的标签页列表，方便直接改用正确的 id。

**把其它工具的动作传给了 `computer`**
`computer` 只做鼠标/键盘/截图类动作；`find`、`navigate`、`wait_for`、`get_page_text`、`read_page`、`form_input`、`javascript_tool` 都是独立的工具，传给 `computer` 的 `action` 会在报错信息里得到对应的替代工具指引。

**客户端看不到工具**
确认 `http://127.0.0.1:3000/mcp` 可访问，然后重启客户端。

**`computer`、`javascript_tool` 等调用报 CDP attach 失败**
页面刚跳转或重载时，Chrome 会短暂拒绝调试器附加，扩展会自动重试，共尝试 4 次。仍失败时等几秒再试，或用 `tabs`（`action:"create"`）新开标签页。`read_page`、`find`、`form_input`、`get_page_text` 不依赖调试器，这时仍可使用。

**同一个标签页被多个 agent 同时操作**
同一标签页上的写操作（点击、输入、按键、滚动、导航、`form_input`、`javascript_tool` 等）按先后顺序排队执行，排队超过 30 秒返回"标签页忙"；读操作（`read_page`、`find`、截图、日志等）不排队。排队只保证单次调用的原子性，不保证两个 agent 的操作逻辑不冲突，所以仍建议每个 agent 使用各自的标签页，并用 `tabs` 的 `group` 参数归入各自的标签组。

## 参与贡献

欢迎提 Issue 和 Pull Request。提交前请先运行 `npm test`。

## 许可证

[MIT](LICENSE) © lycodeing
