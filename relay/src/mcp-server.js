/**
 * mcp-server.js
 * MCP HTTP server (:3000) — 暴露工具给 ZCode / Claude Code
 */

import express from 'express';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { invokeTool, isConnected, getExtensionInfo } from './bridge.js';

// ─── Tool schema helpers ────────────────────────────────────────────────────
// 所有 schema 在模块加载时创建一次，避免每请求重建

const Coordinate = z.array(z.number()).length(2).describe('(x, y) pixel coordinates');
const Region = z.array(z.number()).length(4).describe('(x0, y0, x1, y1) rectangle');

const SCHEMAS = {
  computer: {
    action: z.enum([
      'left_click', 'right_click', 'double_click', 'triple_click',
      'type', 'key', 'screenshot', 'wait', 'scroll', 'scroll_to',
      'left_click_drag', 'zoom', 'hover',
    ]).describe('Action to perform'),
    tabId: z.number().describe('Target tab ID'),
    coordinate: Coordinate.optional(),
    start_coordinate: Coordinate.optional().describe('Drag start position'),
    region: Region.optional().describe('Region for zoom action [x0,y0,x1,y1]'),
    ref: z.string().optional().describe('Element ref from read_page or find'),
    text: z.string().optional().describe('Text to type or key to press'),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    scroll_amount: z.number().min(1).max(10).optional(),
    duration: z.number().min(0).max(10).optional().describe('Wait seconds'),
    repeat: z.number().min(1).max(100).optional().describe('Key repeat count'),
    modifiers: z.string().optional().describe('ctrl/shift/alt/cmd combinations'),
    quality: z.union([
      z.enum(['low', 'medium', 'high']),
      z.number().int().min(1).max(100),
    ]).optional().describe('Screenshot quality: preset or 1-100 (screenshot/zoom only)'),
    format: z.enum(['jpeg', 'webp', 'png']).optional().describe('Screenshot format, default jpeg'),
    fullPage: z.boolean().optional().describe('Capture beyond viewport (screenshot only)'),
    maxDimension: z.number().int().min(400).max(8000).optional().describe('Longest edge of the returned image in px, default 1280. Image tokens scale with pixel count, so keep it small; coordinates you pass back are in this image\'s pixels'),
    saveTo: z.string().optional().describe('Absolute local path to save screenshot/PDF; returns path instead of full image on disk'),
    returnImage: z.boolean().optional().describe('With saveTo: false to skip returning image data'),
    dialog: z.enum(['accept', 'dismiss', 'manual']).optional()
      .describe('JS dialog policy during this action: auto-accept (default), auto-dismiss, or manual via handle_dialog'),
  },
  read_page: {
    tabId: z.number().describe('Target tab ID'),
    filter: z.enum(['all', 'interactive']).optional().default('all'),
    depth: z.number().min(1).max(50).optional().default(15),
    max_chars: z.number().min(1000).max(200000).optional().default(50000),
    ref_id: z.string().optional().describe('Focus on a specific element subtree'),
  },
  find: {
    tabId: z.number(),
    query: z.string().describe('Keywords matching element text or label'),
    max_results: z.number().min(1).max(100).optional().default(20),
  },
  form_input: {
    tabId: z.number(),
    ref: z.string().describe('Element ref from read_page or find'),
    value: z.union([z.string(), z.boolean(), z.number()]),
  },
  navigate: {
    tabId: z.number(),
    url: z.string().describe('URL, "back", or "forward"'),
    force: z.boolean().optional().describe('Dismiss unsaved-changes dialogs'),
    dialog: z.enum(['accept', 'dismiss', 'manual']).optional()
      .describe('JS dialog policy during navigation: auto-accept (default), auto-dismiss, or manual'),
  },
  javascript_tool: {
    tabId: z.number(),
    text: z.string().min(1).describe('JS code to run (no return statement needed)'),
  },
  get_page_text: {
    tabId: z.number(),
    max_chars: z.number().min(1000).max(200000).optional().default(50000),
  },
  file_upload: {
    tabId: z.number(),
    paths: z.array(z.string()).min(1).describe('Absolute file paths to upload'),
    ref: z.string().optional().describe('Ref of input[type=file] element'),
    triggerRef: z.string().optional().describe('Ref of button that opens file picker'),
  },
  resize_window: {
    tabId: z.number(),
    width: z.number().min(400).max(7680),
    height: z.number().min(300).max(4320),
  },
  read_console_messages: {
    tabId: z.number(),
    pattern: z.string().optional().describe('Regex filter for message content'),
    onlyErrors: z.boolean().optional().default(false),
    clear: z.boolean().optional().default(false),
    limit: z.number().min(1).max(1000).optional().default(100),
  },
  read_network_requests: {
    tabId: z.number(),
    urlPattern: z.string().optional().describe('Filter by URL substring'),
    clear: z.boolean().optional().default(false),
    limit: z.number().min(1).max(1000).optional().default(100),
  },
  tabs_context: {},
  tabs_create: {},
  tabs_close: {
    tabId: z.number().describe('Tab ID to close'),
  },
  wait_for: {
    tabId: z.number().describe('Target tab ID'),
    condition: z.enum(['element', 'element_gone', 'url', 'network_idle', 'time'])
      .describe('What to wait for'),
    text: z.string().optional().describe('element/element_gone: text to match (same semantics as find)'),
    urlPattern: z.string().optional().describe('url: substring the URL must contain'),
    milliseconds: z.number().min(100).max(60000).optional().describe('time: duration in ms'),
    idleMs: z.number().min(300).max(10000).optional().default(750).describe('network_idle: quiet window'),
    timeoutMs: z.number().min(1000).max(120000).optional().default(15000),
  },
  handle_dialog: {
    tabId: z.number().describe('Target tab ID'),
    accept: z.boolean().optional().default(true).describe('true=accept/OK, false=dismiss/cancel'),
    promptText: z.string().optional().describe('Text for prompt() dialogs'),
  },
  save_pdf: {
    tabId: z.number().describe('Target tab ID'),
    saveTo: z.string().describe('Absolute local path to save the PDF'),
    paperFormat: z.enum(['Letter','Legal','Tabloid','Ledger','A0','A1','A2','A3','A4','A5','A6']).optional().default('A4'),
    landscape: z.boolean().optional().default(false),
    printBackground: z.boolean().optional().default(true),
    scale: z.number().min(0.1).max(2).optional().default(1),
  },
  cookies: {
    action: z.enum(['get', 'set', 'remove', 'clear']).describe('Cookie operation'),
    url: z.string().optional().describe('get/set/remove: URL scope, e.g. https://example.com'),
    domain: z.string().optional().describe('get/clear: filter by domain'),
    name: z.string().optional().describe('get/remove: single cookie name'),
    cookies: z.array(z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string().optional(),
      path: z.string().optional(),
      secure: z.boolean().optional(),
      httpOnly: z.boolean().optional(),
      expirationDate: z.number().optional(),
    })).optional().describe('set: cookies to write'),
  },
  downloads: {
    action: z.enum(['list', 'wait', 'erase']).describe('Download operation'),
    urlFilter: z.string().optional().describe('Filter by URL substring'),
    downloadId: z.number().optional().describe('wait/erase: specific download ID'),
    timeoutMs: z.number().min(1000).max(600000).optional().default(120000)
      .describe('wait: give up if not complete'),
  },
  performance: {
    tabId: z.number().describe('Target tab ID'),
    action: z.enum(['metrics', 'trace_start', 'trace_stop']).describe('metrics: instant snapshot; trace_start/trace_stop: record a trace and get an analysed summary'),
    reload: z.boolean().optional().default(false).describe('trace_start: reload the page (cache bypassed) once tracing begins, to capture load metrics'),
  },
  emulate: {
    tabId: z.number().describe('Target tab ID'),
    cpuThrottlingRate: z.number().min(1).max(20).optional().describe('CPU slowdown factor, 1 = off'),
    networkConditions: z.enum(['Offline', 'Slow 3G', 'Fast 3G', 'Fast 4G', 'none']).optional().describe('Network throttling preset, none = off'),
    colorScheme: z.enum(['dark', 'light', 'auto']).optional().describe('prefers-color-scheme override, auto = reset'),
    userAgent: z.string().optional().describe('User agent override, empty string = reset'),
    reset: z.boolean().optional().default(false).describe('Clear all of the overrides above'),
  },
};

// ─── Tool descriptions ────────────────────────────────────────────────────────

const DESCRIPTIONS = {
  computer: 'Control the browser with mouse, keyboard, and screenshots. Use tabs_context first if you need a valid tabId. Screenshots are costly in tokens: prefer read_page/find with ref for locating and clicking, and use screenshot (or zoom on a region for detail) only when visual confirmation is needed.',
  read_page: 'Get accessibility tree of the page. Use filter="interactive" for inputs/buttons only.',
  find: 'Find page elements by keyword. Use exact visible text (e.g. "Submit", "Add to cart").',
  form_input: 'Set a value on a form field (input, select, textarea, contenteditable) by ref.',
  navigate: 'Navigate to a URL, or go "back" / "forward" in history.',
  javascript_tool: 'Execute JavaScript in the page context. Return value of the last expression is returned.',
  get_page_text: 'Extract plain text content from the page, prioritising article content.',
  file_upload: 'Upload local files to a page file input. Use ref for visible input[type=file], triggerRef for a button that opens the picker.',
  resize_window: 'Resize the browser window.',
  read_console_messages: 'Read buffered browser console messages from a tab.',
  read_network_requests: 'Read buffered HTTP network requests from a tab.',
  tabs_context: 'List all open non-system tabs with their IDs, titles, and URLs.',
  tabs_create: 'Create a new blank tab and return its ID.',
  tabs_close: 'Close a tab by its ID.',
  wait_for: 'Wait for an element to appear/disappear, URL change, network idle, or a fixed time. Prefer over blind sleeps after navigation.',
  handle_dialog: 'Answer a pending JS dialog (alert/confirm/prompt) left open by dialog:"manual".',
  save_pdf: 'Save the page as PDF to a local file via CDP printToPDF.',
  cookies: 'Read, set, remove, or clear browser cookies for a domain/URL (login-state management).',
  downloads: 'List downloads, wait for a download to complete and get its local path, or erase history entries.',
  performance: 'Inspect page performance. "metrics" returns an instant snapshot (LCP, CLS, INP, FCP, TTFB, JS heap, DOM nodes, listeners, slowest resources). "trace_start" then "trace_stop" records a Chrome trace and returns a summary (long tasks, blocking time, main-thread breakdown, heaviest scripts); use reload:true on trace_start to capture page load. Combine with emulate to test under throttling.',
  emulate: 'Throttle CPU or network, override color scheme or user agent for a tab (CDP emulation). Overrides stay until reset:true or the debugger detaches.',
};

// ─── Per-tool timeout (ms) ────────────────────────────────────────────────────
// 轻量操作快速失败，避免卡住整个会话

const TOOL_TIMEOUTS = {
  tabs_context: 5000, tabs_create: 5000, tabs_close: 5000,
  find: 15000, read_page: 15000, form_input: 15000, get_page_text: 15000,
  resize_window: 10000, read_console_messages: 10000, read_network_requests: 10000,
  navigate: 30000, computer: 30000, javascript_tool: 30000, file_upload: 30000,
  wait_for: 130000, handle_dialog: 5000, save_pdf: 60000,
  cookies: 10000, downloads: 610000,
  performance: 60000, emulate: 10000,
};

// ─── Build a fresh McpServer with all tools registered ──────────────────────────

function buildMcpServer() {
  const server = new McpServer({
    name: 'browser-mcp',
    version: '1.1.0',
  });

  for (const [name, schema] of Object.entries(SCHEMAS)) {
    server.tool(name, DESCRIPTIONS[name], schema, async (args) => relay(name, args));
  }

  return server;
}

// ─── saveTo 落盘：把扩展返回的 image content（截图/PDF）写入本地文件 ─────────

async function saveBase64(saveTo, base64) {
  if (!path.isAbsolute(saveTo)) throw new Error('saveTo must be an absolute path');
  await fsp.mkdir(path.dirname(saveTo), { recursive: true });
  await fsp.writeFile(saveTo, Buffer.from(base64, 'base64'));
  const { size } = await fsp.stat(saveTo);
  return size;
}

function formatSize(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

async function applySaveTo(args, result) {
  const saveTo = args?.saveTo;
  if (!saveTo || !result?.content) return result;
  const idx = result.content.findIndex((c) => c.type === 'image');
  if (idx === -1) return result;

  try {
    const size = await saveBase64(saveTo, result.content[idx].data);
    // save_pdf 内容体积大且 agent 无法消费，强制移除；截图按 returnImage 决定
    const dropImage = !result.content[idx].mimeType?.startsWith('image/')
      || args.returnImage === false;
    if (dropImage) result.content.splice(idx, 1);
    const textItem = result.content.find((c) => c.type === 'text');
    const saved = `Saved to ${saveTo} (${formatSize(size)})`;
    if (textItem) textItem.text = `${textItem.text}\n${saved}`;
    else result.content.unshift({ type: 'text', text: saved });
    return result;
  } catch (e) {
    return {
      content: [
        ...result.content,
        { type: 'text', text: `Error: failed to save to ${saveTo}: ${e.message}` },
      ],
      isError: true,
    };
  }
}

// ─── 超大图自动落盘 ───────────────────────────────────────────────────────────
// base64 图片会整块进入模型上下文。超过阈值（常见于 png / fullPage）时改存临时文件，
// 只回传路径，由 agent 按需读取。

const INLINE_IMAGE_MAX_BYTES = 1_000_000;
const SPILL_DIR = path.join(os.tmpdir(), 'browser-mcp');
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

async function spillLargeImages(result) {
  if (!result?.content) return result;
  for (let i = 0; i < result.content.length; i++) {
    const c = result.content[i];
    if (c.type !== 'image' || !c.mimeType?.startsWith('image/')) continue;
    const bytes = Math.floor(c.data.length * 3 / 4);
    if (bytes <= INLINE_IMAGE_MAX_BYTES) continue;
    const file = path.join(SPILL_DIR, `shot-${Date.now()}-${i}.${MIME_EXT[c.mimeType] || 'img'}`);
    await saveBase64(file, c.data);
    result.content[i] = {
      type: 'text',
      text: `Image too large to inline (${formatSize(bytes)}); saved to ${file}. `
        + 'Read that file only if needed, or retake with a smaller maxDimension / jpeg / lower quality.',
    };
  }
  return result;
}

// ─── Relay helper: call bridge and format MCP response ──────────────────────

async function relay(tool, args) {
  if (!isConnected()) {
    return {
      content: [{
        type: 'text',
        text: 'Error: No browser extension connected. Install and enable the browser-mcp extension in Chrome.',
      }],
      isError: true,
    };
  }

  try {
    const result = await invokeTool(tool, args, TOOL_TIMEOUTS[tool] || 60000);
    // Extension already returns MCP-formatted content
    if (result && result.content) return await spillLargeImages(await applySaveTo(args, result));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `Error [${err.code || 'TOOL_ERROR'}]: ${err.message}`,
      }],
      isError: true,
    };
  }
}

// ─── Express app ─────────────────────────────────────────────────────────────

export function startMcpServer(port = 3000) {
  const app = express();
  app.use(express.json());

  // Status endpoint
  app.get('/', (_req, res) => {
    const info = getExtensionInfo();
    res.json({
      service: 'browser-mcp-relay',
      version: '1.1.0',
      extension: info,
    });
  });

  // MCP endpoint — stateless: 每次请求创建独立的 server + transport
  // MCP SDK 的 McpServer 不支持复用（connect 后不可再次 connect），必须每请求新建
  app.all('/mcp', async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless 模式
    });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
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
