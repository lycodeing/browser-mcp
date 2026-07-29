/**
 * mcp-server.js
 * MCP HTTP server (:3000) — 暴露工具给 ZCode / Claude Code
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { invokeTool, isConnected, getExtensionInfo } from './bridge.js';

// ─── Tool schema helpers ────────────────────────────────────────────────────

const Coordinate = z.array(z.number()).length(2).describe('(x, y) pixel coordinates');
const Region = z.array(z.number()).length(4).describe('(x0, y0, x1, y1) rectangle');

// ─── Build a fresh McpServer with all tools registered ──────────────────────

function buildMcpServer() {
  const server = new McpServer({
    name: 'browser-mcp',
    version: '1.0.0',
  });

  // ── computer ──────────────────────────────────────────────────────────────
  server.tool(
    'computer',
    'Control the browser with mouse, keyboard, and screenshots. Use tabs_context first if you need a valid tabId.',
    {
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
      quality: z.enum(['low', 'medium', 'high']).optional().describe('Screenshot quality'),
    },
    async (args) => relay('computer', args)
  );

  // ── read_page ─────────────────────────────────────────────────────────────
  server.tool(
    'read_page',
    'Get accessibility tree of the page. Use filter="interactive" for inputs/buttons only.',
    {
      tabId: z.number().describe('Target tab ID'),
      filter: z.enum(['all', 'interactive']).optional().default('all'),
      depth: z.number().min(1).max(50).optional().default(15),
      max_chars: z.number().min(1000).max(200000).optional().default(50000),
      ref_id: z.string().optional().describe('Focus on a specific element subtree'),
    },
    async (args) => relay('read_page', args)
  );

  // ── find ──────────────────────────────────────────────────────────────────
  server.tool(
    'find',
    'Find page elements by keyword. Use exact visible text (e.g. "Submit", "Add to cart").',
    {
      tabId: z.number(),
      query: z.string().describe('Keywords matching element text or label'),
      max_results: z.number().min(1).max(100).optional().default(20),
    },
    async (args) => relay('find', args)
  );

  // ── form_input ────────────────────────────────────────────────────────────
  server.tool(
    'form_input',
    'Set a value on a form field (input, select, textarea, contenteditable) by ref.',
    {
      tabId: z.number(),
      ref: z.string().describe('Element ref from read_page or find'),
      value: z.union([z.string(), z.boolean(), z.number()]),
    },
    async (args) => relay('form_input', args)
  );

  // ── navigate ──────────────────────────────────────────────────────────────
  server.tool(
    'navigate',
    'Navigate to a URL, or go "back" / "forward" in history.',
    {
      tabId: z.number(),
      url: z.string().describe('URL, "back", or "forward"'),
      force: z.boolean().optional().describe('Dismiss unsaved-changes dialogs'),
    },
    async (args) => relay('navigate', args)
  );

  // ── javascript_tool ───────────────────────────────────────────────────────
  server.tool(
    'javascript_tool',
    'Execute JavaScript in the page context. Return value of the last expression is returned.',
    {
      tabId: z.number(),
      text: z.string().min(1).describe('JS code to run (no return statement needed)'),
    },
    async (args) => relay('javascript_tool', args)
  );

  // ── get_page_text ─────────────────────────────────────────────────────────
  server.tool(
    'get_page_text',
    'Extract plain text content from the page, prioritising article content.',
    {
      tabId: z.number(),
      max_chars: z.number().min(1000).max(200000).optional().default(50000),
    },
    async (args) => relay('get_page_text', args)
  );

  // ── file_upload ───────────────────────────────────────────────────────────
  server.tool(
    'file_upload',
    'Upload local files to a page file input. Use ref for visible input[type=file], triggerRef for a button that opens the picker.',
    {
      tabId: z.number(),
      paths: z.array(z.string()).min(1).describe('Absolute file paths to upload'),
      ref: z.string().optional().describe('Ref of input[type=file] element'),
      triggerRef: z.string().optional().describe('Ref of button that opens file picker'),
    },
    async (args) => relay('file_upload', args)
  );

  // ── resize_window ─────────────────────────────────────────────────────────
  server.tool(
    'resize_window',
    'Resize the browser window.',
    {
      tabId: z.number(),
      width: z.number().min(400).max(7680),
      height: z.number().min(300).max(4320),
    },
    async (args) => relay('resize_window', args)
  );

  // ── read_console_messages ─────────────────────────────────────────────────
  server.tool(
    'read_console_messages',
    'Read buffered browser console messages from a tab.',
    {
      tabId: z.number(),
      pattern: z.string().optional().describe('Regex filter for message content'),
      onlyErrors: z.boolean().optional().default(false),
      clear: z.boolean().optional().default(false),
      limit: z.number().min(1).max(1000).optional().default(100),
    },
    async (args) => relay('read_console_messages', args)
  );

  // ── read_network_requests ─────────────────────────────────────────────────
  server.tool(
    'read_network_requests',
    'Read buffered HTTP network requests from a tab.',
    {
      tabId: z.number(),
      urlPattern: z.string().optional().describe('Filter by URL substring'),
      clear: z.boolean().optional().default(false),
      limit: z.number().min(1).max(1000).optional().default(100),
    },
    async (args) => relay('read_network_requests', args)
  );

  // ── tabs_context ──────────────────────────────────────────────────────────
  server.tool(
    'tabs_context',
    'List all open non-system tabs with their IDs, titles, and URLs.',
    {},
    async (args) => relay('tabs_context', args)
  );

  // ── tabs_create ───────────────────────────────────────────────────────────
  server.tool(
    'tabs_create',
    'Create a new blank tab and return its ID.',
    {},
    async (args) => relay('tabs_create', args)
  );

  // ── tabs_close ────────────────────────────────────────────────────────────
  server.tool(
    'tabs_close',
    'Close a tab by its ID.',
    {
      tabId: z.number().describe('Tab ID to close'),
    },
    async (args) => relay('tabs_close', args)
  );

  return server;
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
    const result = await invokeTool(tool, args);
    // Extension already returns MCP-formatted content
    if (result && result.content) return result;
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
      version: '1.0.0',
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
