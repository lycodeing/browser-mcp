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
import { invokeTool, isConnected, getExtensionInfo, reloadExtension } from './bridge.js';
import {
  lenientNumber as num, lenientBoolean as bool, lenientNumberTuple, lenientNumberArray,
} from './schema-helpers.js';

// ─── Tool schema helpers ────────────────────────────────────────────────────
// 所有 schema 在模块加载时创建一次，避免每请求重建

const Coordinate = lenientNumberTuple(2).describe('(x, y) pixel coordinates');
const Region = lenientNumberTuple(4).describe('(x0, y0, x1, y1) rectangle');

// tabId 传成 UUID / 短编号是高频错误；describe 会进入客户端看到的工具清单，
// zod 校验失败时只透出第一个 issue 的 message，所以字符串分支也要挂同样的指引
const TABID_GUIDANCE = 'tabId must be the numeric Chrome tab id from tabs (action: "list"), e.g. 1924551535 — not a UUID or made-up short number';

export function lenientTabId() {
  return num(
    z.number({ required_error: TABID_GUIDANCE, invalid_type_error: TABID_GUIDANCE }),
    TABID_GUIDANCE,
  ).describe(TABID_GUIDANCE);
}

// computer 不承载检索/导航/等待类动作；枚举失败消息里直接给出正确替代工具
const COMPUTER_ACTIONS = [
  'left_click', 'right_click', 'double_click', 'triple_click',
  'type', 'key', 'screenshot', 'wait', 'scroll', 'scroll_to',
  'left_click_drag', 'zoom', 'hover',
];
const ACTION_ALIASES = {
  find: 'use the find tool with {query}',
  read_page: 'use the read_page tool',
  get_page_text: 'use the get_page_text tool',
  navigate: 'use the navigate tool with {url}',
  wait_for: 'use the wait_for tool, or action "wait" with duration for a plain sleep',
  form_input: 'use the form_input tool with {ref, value}',
  javascript_tool: 'use the javascript_tool tool with {text}',
};

const computerActionSchema = z.enum(COMPUTER_ACTIONS, {
  errorMap: (issue, ctx) => {
    if (issue.code === 'invalid_enum_value' && issue.received in ACTION_ALIASES) {
      return { message: `computer does not support action "${issue.received}": ${ACTION_ALIASES[issue.received]}` };
    }
    return { message: ctx.defaultError };
  },
}).describe('Action to perform');

const SCHEMAS = {
  computer: {
    action: computerActionSchema,
    tabId: lenientTabId(),
    coordinate: Coordinate.optional(),
    start_coordinate: Coordinate.optional().describe('Drag start position'),
    region: Region.optional().describe('Region for zoom action [x0,y0,x1,y1]'),
    ref: z.string().optional().describe('Element ref from read_page or find'),
    text: z.string().optional().describe('Text to type or key to press'),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    scroll_amount: num(z.number().min(1).max(10)).optional(),
    duration: num(z.number().min(0).max(10)).optional().describe('Wait seconds'),
    repeat: num(z.number().min(1).max(100)).optional().describe('Key repeat count'),
    modifiers: z.string().optional().describe('ctrl/shift/alt/cmd combinations'),
    quality: z.union([
      z.enum(['low', 'medium', 'high']),
      num(z.number().int().min(1).max(100)),
    ]).optional().describe('Screenshot quality: preset or 1-100 (screenshot/zoom only)'),
    format: z.enum(['jpeg', 'webp', 'png']).optional().describe('Screenshot format, default jpeg'),
    fullPage: bool().optional().describe('Capture beyond viewport (screenshot only)'),
    maxDimension: num(z.number().int().min(400).max(8000)).optional().describe('Longest edge of the returned image in px, default 1280. Image tokens scale with pixel count, so keep it small; coordinates you pass back are in this image\'s pixels'),
    saveTo: z.string().optional().describe('Absolute local path to save screenshot/PDF; returns path instead of full image on disk'),
    returnImage: bool().optional().describe('With saveTo: false to skip returning image data'),
    dialog: z.enum(['accept', 'dismiss', 'manual']).optional()
      .describe('JS dialog policy during this action: auto-accept (default), auto-dismiss, or manual via handle_dialog'),
  },
  read_page: {
    tabId: lenientTabId(),
    filter: z.enum(['all', 'interactive']).optional().default('all'),
    depth: num(z.number().min(1).max(50)).optional().default(15),
    max_chars: num(z.number().min(1000).max(200000)).optional().default(50000),
    ref_id: z.string().optional().describe('Focus on a specific element subtree'),
  },
  find: {
    tabId: lenientTabId(),
    query: z.string().describe('Keywords matching element text or label'),
    max_results: num(z.number().min(1).max(100)).optional().default(20),
  },
  form_input: {
    tabId: lenientTabId(),
    ref: z.string().describe('Element ref from read_page or find'),
    value: z.union([z.string(), z.boolean(), z.number()]),
  },
  navigate: {
    tabId: lenientTabId(),
    url: z.string().describe('URL, "back", or "forward"'),
    force: bool().optional().describe('Dismiss unsaved-changes dialogs'),
    dialog: z.enum(['accept', 'dismiss', 'manual']).optional()
      .describe('JS dialog policy during navigation: auto-accept (default), auto-dismiss, or manual'),
  },
  javascript_tool: {
    tabId: lenientTabId(),
    frameId: num(z.number().int().min(0)).optional().describe('Frame to run the code in: 0 = main frame (default), f<id> from read_page output for iframes'),
    text: z.string().min(1).describe('JS code to run (no return statement needed)'),
  },
  get_page_text: {
    tabId: lenientTabId(),
    frameId: num(z.number().int().min(0)).optional().describe('Extract text from this frame only: 0 = main frame (default), f<id> for iframes'),
    allFrames: bool().optional().describe('Merge text from every frame, each section headed by its frame'),
    max_chars: num(z.number().min(1000).max(200000)).optional().default(50000),
  },
  file_upload: {
    tabId: lenientTabId(),
    paths: z.array(z.string()).min(1).describe('Absolute file paths to upload'),
    ref: z.string().optional().describe('Ref of input[type=file] element; iframes refs like f3.ref_7 work'),
    triggerRef: z.string().optional().describe('Ref of button that opens file picker; iframes refs work too'),
  },
  resize_window: {
    tabId: lenientTabId(),
    width: num(z.number().min(400).max(7680)),
    height: num(z.number().min(300).max(4320)),
  },
  read_console_messages: {
    tabId: lenientTabId(),
    pattern: z.string().optional().describe('Regex filter for message content'),
    onlyErrors: bool().optional().default(false),
    clear: bool().optional().default(false),
    limit: num(z.number().min(1).max(1000)).optional().default(100),
  },
  network: {
    action: z.enum(['list', 'detail']).describe('What to do with observed network requests'),
    tabId: lenientTabId(),
    urlPattern: z.string().optional().describe('list: filter by URL substring'),
    method: z.string().optional().describe('list: HTTP method filter, case-insensitive'),
    status: z.string().optional().describe('list: "404", "4xx" or "500-599"'),
    failedOnly: bool().optional().default(false)
      .describe('list: network failures and HTTP status >= 400'),
    limit: num(z.number().min(1).max(1000)).optional().default(100).describe('list: max entries to return'),
    clear: bool().optional().default(false).describe('list: clear the buffer after reading (seq is not reset)'),
    seq: num(z.number().int().min(1)).optional().describe('detail: request number (#N) shown by list'),
    bodyLimit: num(z.number().int().min(500).max(200000)).optional().default(20000)
      .describe('detail: max response body characters returned inline'),
    rawHeaders: bool().optional().default(false)
      .describe('detail: show authorization/cookie header values as-is instead of masked'),
    saveTo: z.string().optional().describe('detail: absolute local path to save the full response body'),
  },
  tabs: {
    action: z.enum(['list', 'create', 'close', 'activate', 'reload', 'duplicate', 'group'])
      .describe('Tab operation'),
    tabId: num().optional().describe('activate/reload/duplicate: target tab'),
    tabIds: lenientNumberArray().optional().describe('close/group: target tabs'),
    url: z.string().optional().describe('create: URL to open, omitted opens about:blank'),
    active: bool().optional().describe('create: focus the new tab, default true'),
    group: z.string().min(1).max(40).optional()
      .describe('list: filter by group name. create/group: group name, found or created in the tab\'s window. group without a name removes the tabs from their group'),
    bypassCache: bool().optional().describe('reload: skip the cache'),
  },
  wait_for: {
    tabId: lenientTabId(),
    condition: z.enum(['element', 'element_gone', 'url', 'network_idle', 'time'])
      .describe('What to wait for'),
    text: z.string().optional().describe('element/element_gone: text to match (same semantics as find)'),
    urlPattern: z.string().optional().describe('url: substring the URL must contain'),
    milliseconds: num(z.number().min(100).max(60000)).optional().describe('time: duration in ms'),
    idleMs: num(z.number().min(300).max(10000)).optional().default(750).describe('network_idle: quiet window'),
    timeoutMs: num(z.number().min(1000).max(120000)).optional().default(15000),
  },
  handle_dialog: {
    tabId: lenientTabId(),
    accept: bool().optional().default(true).describe('true=accept/OK, false=dismiss/cancel'),
    promptText: z.string().optional().describe('Text for prompt() dialogs'),
  },
  save_pdf: {
    tabId: lenientTabId(),
    saveTo: z.string().describe('Absolute local path to save the PDF'),
    paperFormat: z.enum(['Letter','Legal','Tabloid','Ledger','A0','A1','A2','A3','A4','A5','A6']).optional().default('A4'),
    landscape: bool().optional().default(false),
    printBackground: bool().optional().default(true),
    scale: num(z.number().min(0.1).max(2)).optional().default(1),
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
      secure: bool().optional(),
      httpOnly: bool().optional(),
      expirationDate: num().optional(),
    })).optional().describe('set: cookies to write'),
  },
  downloads: {
    action: z.enum(['list', 'wait', 'erase']).describe('Download operation'),
    urlFilter: z.string().optional().describe('Filter by URL substring'),
    downloadId: num().optional().describe('wait/erase: specific download ID'),
    timeoutMs: num(z.number().min(1000).max(600000)).optional().default(120000)
      .describe('wait: give up if not complete'),
  },
  performance: {
    tabId: lenientTabId(),
    action: z.enum(['metrics', 'trace_start', 'trace_stop']).describe('metrics: instant snapshot; trace_start/trace_stop: record a trace and get an analysed summary'),
    reload: bool().optional().default(false).describe('trace_start: reload the page (cache bypassed) once tracing begins, to capture load metrics'),
  },
  emulate: {
    tabId: lenientTabId(),
    cpuThrottlingRate: num(z.number().min(1).max(20)).optional().describe('CPU slowdown factor, 1 = off'),
    networkConditions: z.enum(['Offline', 'Slow 3G', 'Fast 3G', 'Fast 4G', 'none']).optional().describe('Network throttling preset, none = off'),
    colorScheme: z.enum(['dark', 'light', 'auto']).optional().describe('prefers-color-scheme override, auto = reset'),
    userAgent: z.string().optional().describe('User agent override, empty string = reset'),
    device: z.enum(['iphone-15', 'ipad-air', 'pixel-8']).optional().describe('Device preset: viewport, pixel ratio, touch and user agent. Explicit width/height/deviceScaleFactor/mobile/userAgent override the matching preset value'),
    width: num(z.number().int().min(200).max(4000)).optional().describe('Viewport width in CSS px; needs height unless device is given'),
    height: num(z.number().int().min(200).max(4000)).optional().describe('Viewport height in CSS px; needs width unless device is given'),
    deviceScaleFactor: num(z.number().min(1).max(5)).optional().describe('Device pixel ratio'),
    mobile: bool().optional().describe('Mobile viewport with touch events'),
    latitude: num(z.number().min(-90).max(90)).optional().describe('Geolocation latitude; must be given together with longitude'),
    longitude: num(z.number().min(-180).max(180)).optional().describe('Geolocation longitude; must be given together with latitude'),
    accuracy: num(z.number().min(0).max(100000)).optional().describe('Geolocation accuracy in meters, default 100'),
    timezone: z.string().optional().describe('IANA timezone name, e.g. Asia/Tokyo; empty string resets'),
    locale: z.string().optional().describe('Locale such as ja-JP; changes Intl formatting, navigator.language and the Accept-Language request header; empty string resets'),
    reset: bool().optional().default(false).describe('Clear all emulation overrides on the tab'),
  },
  storage: {
    action: z.enum(['list', 'get', 'set', 'remove', 'clear', 'idb']).describe('Storage operation'),
    tabId: lenientTabId(),
    area: z.enum(['local', 'session']).optional().describe('list/get/set/remove/clear: which storage, default local'),
    key: z.string().optional().describe('get/set/remove: key'),
    value: z.string().optional().describe('set: value (strings only; JSON.stringify objects first)'),
    maxChars: num(z.number().int().min(100).max(200000)).optional().default(2000)
      .describe('get: max characters of the value returned inline'),
  },
  intercept_add: {
    tabId: lenientTabId(),
    urlPattern: z.string().min(1).describe('Wildcard pattern matched against the whole URL: * is zero or more characters, ? is exactly one, backslash escapes the next character'),
    action: z.enum(['fail', 'fulfill', 'delay']).describe('fail: abort the request; fulfill: answer with a mock response; delay: hold the request, then let it through'),
    method: z.string().optional().describe('Only match this HTTP method, case-insensitive'),
    errorReason: z.enum([
      'Failed', 'Aborted', 'TimedOut', 'AccessDenied', 'ConnectionClosed', 'ConnectionReset', 'ConnectionRefused',
      'ConnectionAborted', 'ConnectionFailed', 'NameNotResolved', 'InternetDisconnected', 'AddressUnreachable',
      'BlockedByClient', 'BlockedByResponse',
    ]).optional().describe('fail: network error to simulate, default Failed'),
    status: num(z.number().int().min(100).max(599)).optional().describe('fulfill: HTTP status, default 200'),
    headers: z.record(z.string()).optional().describe('fulfill: response headers'),
    body: z.string().optional().describe('fulfill: text response body, up to 1 MB'),
    bodyBase64: z.string().optional().describe('fulfill: binary response body as base64 (e.g. a PNG), up to 1 MB decoded; mutually exclusive with body'),
    delayMs: num(z.number().int().min(1).max(60000)).optional().describe('delay: milliseconds to hold each matching request (required for delay)'),
  },
  intercept_list: {
    tabId: lenientTabId(),
  },
  intercept_remove: {
    tabId: lenientTabId(),
    ruleId: z.string().optional().describe('Rule id from intercept_list; omit to remove all rules and turn interception off'),
  },
};

// ─── Tool descriptions ────────────────────────────────────────────────────────

const DESCRIPTIONS = {
  computer: 'Control the browser with mouse, keyboard, and screenshots. Use tabs (action list) first if you need a valid tabId. Screenshots are costly in tokens: prefer read_page/find with ref for locating and clicking, and use screenshot (or zoom on a region for detail) only when visual confirmation is needed.',
  read_page: 'Get accessibility tree of the page. Use filter="interactive" for inputs/buttons only.',
  find: 'Find page elements by keyword. Use exact visible text (e.g. "Submit", "Add to cart").',
  form_input: 'Set a value on a form field (input, select, textarea, contenteditable) by ref.',
  navigate: 'Navigate to a URL, or go "back" / "forward" in history.',
  javascript_tool: 'Execute JavaScript in the page context. Optional frameId targets an iframe (0 = main frame, default); document/location/window then belong to that frame. Return value of the last expression is returned.',
  get_page_text: 'Extract plain text content from the page, prioritising article content. Default: main frame only. frameId extracts one iframe\'s text; allFrames:true merges every frame, each section headed by its frame and capped by max_chars overall.',
  file_upload: 'Upload local files to a page file input. Use ref for visible input[type=file], triggerRef for a button that opens the picker. Iframe refs (e.g. f3.ref_7) work for both.',
  resize_window: 'Resize the browser window.',
  read_console_messages: 'Read buffered browser console messages from a tab.',
  network: 'Inspect HTTP network requests observed in a tab. Requests are only captured after the first network call on that tab attaches the debugger: requests made before that first call have no data. action "list" shows captured requests with their number (#N), method, status or failure reason, and URL; use urlPattern/method/status/failedOnly filters and clear to reset the buffer. action "detail" returns the request/response headers and bodies of one request chosen by seq (the #N from list); the response body is NOT included inline by default beyond bodyLimit characters and can be written to disk with saveTo (absolute path) instead of entering the context; authorization/cookie header values are masked unless rawHeaders:true. Binary bodies report size and MIME type only.',
  tabs: 'Manage browser tabs and named tab groups. Actions: list (shows tab id, title, URL, window, group, and the active tab; optional group name filter), create (optional url; loads before returning; optional group name; active defaults to true — background tabs (active:false) get throttled by the browser, so keep active:true for pages where you need screenshots or animations), close (tabIds, batch), activate (tabId, also focuses its window), reload (tabId, optional bypassCache), duplicate (tabId), group (tabIds; group name is looked up or created in the window of the tabs; same-named groups in different windows are separate groups; omitting group ungroups the tabs). Group names are trimmed, 1-40 chars. Use tabs (action list) to discover tabIds.',
  wait_for: 'Wait for an element to appear/disappear, URL change, network idle, or a fixed time. Prefer over blind sleeps after navigation.',
  handle_dialog: 'Answer a pending JS dialog (alert/confirm/prompt) left open by dialog:"manual".',
  save_pdf: 'Save the page as PDF to a local file via CDP printToPDF.',
  cookies: 'Read, set, remove, or clear browser cookies for a domain/URL (login-state management).',
  downloads: 'List downloads, wait for a download to complete and get its local path, or erase history entries.',
  performance: 'Inspect page performance. "metrics" returns an instant snapshot (LCP, CLS, INP, FCP, TTFB, JS heap, DOM nodes, listeners, slowest resources). "trace_start" then "trace_stop" records a Chrome trace and returns a summary (long tasks, blocking time, main-thread breakdown, heaviest scripts); use reload:true on trace_start to capture page load. Combine with emulate to test under throttling.',
  emulate: 'Emulate a device and environment on a tab (CDP): device presets (iphone-15, ipad-air, pixel-8) or custom width/height/deviceScaleFactor/mobile, geolocation, timezone, locale, CPU/network throttling, color scheme, user agent. Overrides stay until reset:true or the debugger detaches. Geolocation only reaches the page if the site already has location permission in Chrome; this tool cannot grant it.',
  intercept_add: 'Intercept and mock network requests on a tab (CDP Fetch). Add a rule that matches requests by URL wildcard (and optionally method): fail aborts them with a network error, fulfill answers with a mock status/headers/body (text via body, binary via bodyBase64, up to 1 MB), delay holds them for delayMs. The first matching rule wins. Cross-origin mocks get access-control-allow-origin echoed and access-control-allow-credentials added, and CORS preflights are answered automatically. Rules last until intercept_remove, the tab closes, or the debugger detaches (DevTools opened); they survive extension restarts. Mocked requests still show up in network list as normal responses.',
  intercept_list: 'List the intercept rules on a tab with their hit counts and whether interception is currently active.',
  intercept_remove: 'Remove one intercept rule by id, or all rules on the tab (omit ruleId), which also turns interception off.',
  storage: 'Read and write localStorage / sessionStorage of the tab\'s main frame, or summarize IndexedDB. Actions: list (keys with size and a short preview), get (one value, truncated at maxChars), set / remove / clear (writes), idb (read-only summary of databases, object stores and record counts; record contents are never read). Works on the top-level frame\'s origin only, not on iframes; the first line of every result shows the origin. Values are not masked, treat them like cookies.',
};

// ─── Per-tool timeout (ms) ────────────────────────────────────────────────────
// 轻量操作快速失败，避免卡住整个会话。
// relay 的超时从发出请求起算，包含扩展侧串行队列的排队时间：
// 排队上限 QUEUE_WAIT_MS（写操作按 tabId 先进先出，超过即返回"标签页忙"）。
// 若不把排队窗口加进超时，排队还没轮到 relay 就先报笼统的 timed out。

/** 排队等待上限；排队工具的 relay 超时 = 基础值 + QUEUE_WAIT_MS */
const QUEUE_WAIT_MS = 30000;

/** 基础超时（不含排队等待），工具自身的执行时间预算 */
const BASE_TIMEOUTS = {
  computer: 30000, form_input: 15000, navigate: 30000,
  file_upload: 30000, javascript_tool: 30000,
  tabs: 40000, // 含 create 的页面加载等待
  network: 15000,
  find: 15000, read_page: 15000, get_page_text: 15000,
  resize_window: 10000, read_console_messages: 10000,
  wait_for: 130000, handle_dialog: 5000, save_pdf: 60000,
  cookies: 10000, downloads: 610000,
  performance: 60000, emulate: 10000, storage: 10000,
  intercept_add: 10000, intercept_list: 10000, intercept_remove: 10000,
};

/** 会进扩展侧串行队列的工具；其超时叠加排队等待，避免排队期间被 relay 判超时 */
const QUEUED_TOOLS = new Set(['computer', 'form_input', 'navigate', 'file_upload', 'javascript_tool', 'tabs', 'storage']);

/** 最终生效的超时表 = 基础表 + 排队工具的 QUEUE_WAIT_MS */
export const TOOL_TIMEOUTS = Object.fromEntries(
  Object.entries(BASE_TIMEOUTS).map(([name, ms]) => [name, QUEUED_TOOLS.has(name) ? ms + QUEUE_WAIT_MS : ms]),
);

// ─── Build a fresh McpServer with all tools registered ──────────────────────────

export function buildMcpServer() {
  const server = new McpServer({
    name: 'browser-mcp',
    version: '2.2.3',
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

// x-file：扩展与 relay 之间的私有内容项（如 network detail 的完整响应体），
// 仅用于落盘通道，绝不能以原样到达 MCP 客户端。
const X_FILE_TYPE = 'x-file';

/**
 * x-file 落盘：请求带 saveTo 时写入磁盘并替换为路径文本。
 * 不带 saveTo 的 x-file 不算错误（调用方本就没要文件），由 stripXFile 统一剔除。
 * 返回 { result, error }；error 非空时调用方应整包转成 isError 回复。
 */
async function applyXFile(args, result) {
  const saveTo = args?.saveTo;
  let error = null;

  for (let i = 0; i < result.content.length; i++) {
    if (result.content[i].type !== X_FILE_TYPE) continue;
    const base64 = result.content[i].data;
    // 不带 saveTo 的请求本就没要文件，静默剔除即可，不算失败
    if (!saveTo) {
      result.content.splice(i, 1);
      i--;
      continue;
    }
    try {
      const size = await saveBase64(saveTo, base64);
      result.content[i] = { type: 'text', text: `Saved to ${saveTo} (${formatSize(size)})` };
    } catch (e) {
      error = error ?? `Error: failed to save to ${saveTo}: ${e.message}`;
      // 写盘失败也要移除该项，避免 base64 泄漏进上下文
      result.content.splice(i, 1);
      i--;
    }
  }

  return { result, error };
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

// ─── 出站内容清洗 ─────────────────────────────────────────────────────────────

/** 丢弃所有残留的 x-file 项：不带 saveTo 或写盘失败的兜底，保证非标准类型不泄漏给客户端 */
function stripXFile(result) {
  if (!result?.content) return result;
  result.content = result.content.filter((c) => c.type !== X_FILE_TYPE);
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
    if (result && result.content) {
      let out = await spillLargeImages(await applySaveTo(args, result));
      const xfile = await applyXFile(args, out);
      if (xfile.error) {
        return {
          content: [...stripXFile(xfile.result).content, { type: 'text', text: xfile.error }],
          isError: true,
        };
      }
      return stripXFile(out);
    }
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
  // intercept_add 的 bodyBase64 上限 1 MB（解码后），base64 后约 1.4 MB，再经 JSON 包装需留余量；
  // 默认 100 KB 会让大二进制 Mock 直接 413。network detail 的响应体也走同一通道。
  app.use(express.json({ limit: '8mb' }));

  // Status endpoint
  app.get('/', (_req, res) => {
    const info = getExtensionInfo();
    res.json({
      service: 'browser-mcp-relay',
      version: '2.2.3',
      extension: info,
    });
  });

  // 开发期自助重载扩展：改完 extension/ 下的代码后 POST 这里即可，无需手动点按钮。
  // 返回后扩展会短暂断开再自动重连，稍等片刻即可在新版本上继续调用。
  app.post('/reload', async (_req, res) => {
    try {
      const result = await reloadExtension();
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
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
