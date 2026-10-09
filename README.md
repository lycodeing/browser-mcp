# browser-mcp

Chrome 浏览器自动化 MCP 工具，让 ZCode / Claude Code 可以直接操控浏览器。

## 架构

```
Chrome 扩展  ──WebSocket──▶  Node.js Relay  ──MCP HTTP──▶  ZCode / Claude Code
             ws://127.0.0.1:16789           http://127.0.0.1:3000/mcp
```

## 快速开始

### 1. 启动 Relay

```bash
cd relay
npm install
npm start
```

启动后输出：
```
[Relay] Extension WS server listening on ws://127.0.0.1:16789
[Relay] MCP HTTP server listening on http://127.0.0.1:3000/mcp
```

### 2. 安装 Chrome 扩展

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目的 `extension/` 目录
5. 扩展图标出现后点击，状态显示 **Connected** 即成功

> 扩展会自动连接本地 Relay，无需额外配置。Relay 必须先于扩展安装前启动。

### 3. 配置 ZCode / Claude Code

#### ZCode

编辑 `~/.zcode/config.json`（或在 ZCode 设置界面的 MCP 配置区域添加）：

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

#### Claude Code

编辑 `~/.claude/claude_desktop_config.json`（或通过 `/mcp` 命令添加）：

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

#### pi

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

pi 无需手动启动 Relay：全局扩展 `~/.pi/agent/extensions/browser-relay-autostart.ts` 会在每次会话启动时检测 `127.0.0.1:3000`，未运行则自动拉起（日志写入 `/tmp/browser-mcp-relay.log`）。

配置后重启 ZCode / Claude Code，工具列表里会出现 `browser__computer`、`browser__navigate` 等工具。

---

## 可用工具

| 工具 | 功能 |
|------|------|
| `computer` | 截图、点击、拖拽、输入文字、键盘快捷键、滚动、悬停、缩放。截图支持 `format`（jpeg/webp/png）、`fullPage` 全页、`quality` 1-100、`saveTo` 存盘、`maxDimension` 长边上限（默认 1280） |
| `read_page` | 获取精简无障碍树（仅可见元素，祖先文本不重复；`filter:"interactive"` 只列可交互元素） |
| `find` | 按关键词搜索页面元素 |
| `form_input` | 填写表单字段（input / select / textarea） |
| `navigate` | 跳转 URL，前进/后退，处理 beforeunload |
| `javascript_tool` | 在页面上下文中执行 JavaScript |
| `get_page_text` | 提取页面纯文本 |
| `file_upload` | 上传本地文件到文件选择器 |
| `resize_window` | 调整浏览器窗口大小 |
| `read_console_messages` | 读取控制台日志缓冲 |
| `read_network_requests` | 读取网络请求缓冲 |
| `tabs_context` | 列出所有已打开的标签页 |
| `tabs_create` | 创建新标签页 |
| `tabs_close` | 关闭指定标签页 |
| `wait_for` | 等待元素出现/消失、URL 变化、网络空闲或固定时长，替代盲等 |
| `handle_dialog` | 应答 alert/confirm/prompt（配合 `dialog:"manual"` 使用） |
| `save_pdf` | 页面导出 PDF 到本地文件（纸张/方向/背景可配） |
| `cookies` | 读取/注入/删除/清除指定域的 Cookie（登录态管理） |
| `downloads` | 列出下载、等待完成并返回本地文件路径、清除历史记录 |

> v1.1：`computer` 与 `navigate` 支持 `dialog` 参数（`accept` 默认自动应答 / `dismiss` / `manual`），
> JS 弹窗不再挂死会话；截图/PDF 产物通过 `saveTo` 落盘，配合 `file_upload` 形成本地文件闭环。

### 图片与 token 优化

图片 token 只取决于像素数，与文件字节数无关，因此优化集中在"少给像素"：

- 截图按 CSS 像素输出并限制长边（默认 1280），高 DPR 屏不再返回 2~3 倍像素。
- 缩放后点击/拖拽/滚动/zoom 的坐标，直接使用截图里看到的像素，扩展内部自动换算回页面坐标；全页截图不参与换算。
- `zoom` 按区域从原图裁剪，保留原生清晰度，适合看细节而不必放大整页截图。
- 单张图片超过约 1 MB（常见于 png / fullPage）时，relay 自动存到系统临时目录 `browser-mcp/`，只返回路径。
- 优先用 `find` / `read_page` 定位元素，用 `ref` 点击；截图只在需要视觉确认时调用。

## 典型工作流

```
# 1. 先获取可用标签页
tabs_context → 拿到 tabId

# 2. 导航到目标页面
navigate { tabId, url: "https://example.com" }

# 3. 截图看一下当前状态
computer { action: "screenshot", tabId }

# 4. 找到要操作的元素
find { tabId, query: "Submit" }  →  拿到 ref

# 5. 点击
computer { action: "left_click", tabId, ref: "ref_42" }
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EXT_PORT` | `16789` | 扩展 WebSocket 端口 |
| `MCP_PORT` | `3000` | MCP HTTP 端口 |

```bash
EXT_PORT=16789 MCP_PORT=3000 npm start
```

## 常见问题

**扩展显示 Disconnected**
- 确认 Relay 已经在运行（`npm start`）
- 检查 16789 端口是否被占用：`lsof -i :16789`

**工具调用返回"No extension connected"**
- 刷新扩展：`chrome://extensions` → 点击扩展的刷新按钮
- 或重新加载扩展

**ZCode/Claude Code 看不到工具**
- 确认 `http://127.0.0.1:3000/mcp` 可访问（浏览器打开应返回 JSON）
- 重启 ZCode / Claude Code

## 项目结构

```
browser-mcp/
├── relay/                    # Node.js MCP Relay
│   ├── package.json
│   └── src/
│       ├── index.js          # 入口
│       ├── bridge.js         # 扩展↔MCP 状态桥接
│       ├── extension-ws.js   # WebSocket server (扩展侧)
│       └── mcp-server.js     # MCP HTTP server (AI 侧)
└── extension/                # Chrome 扩展 (Manifest V3)
    ├── manifest.json
    ├── background.js         # Service Worker，工具实现
    ├── popup.html / popup.js # 状态弹窗
    └── content-scripts/
        ├── accessibility-tree.js  # 页面元素树
        └── page-bridge.js         # 文本提取 & 元素搜索
```
