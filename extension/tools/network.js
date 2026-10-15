// network 工具的胶水实现：list（过滤、失败原因）与 detail（头、请求体、响应体）。
// 依赖（chrome、ok、err、ensureCdp、tabBuf）通过参数注入，避免与 background.js 循环引用。
// 响应体不缓存，detail 时才向浏览器取；超长文本截断，二进制不回传，saveTo 时经 x-file 内容项交给 relay 落盘。

import { formatList, formatDetail, formatSize, truncateText, failureReason } from '../lib/network.js';

// base64 后需低于 ws 单条 100 MB 上限，取 32 MB 原始字节
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const BODY_GONE = /No data found|evicted from inspector cache/i;
const POST_DATA_KEPT = 8 * 1024;

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const base64Bytes = (b64) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

function filterLabel(a) {
  const parts = [];
  if (a.failedOnly) parts.push('failedOnly');
  if (a.method) parts.push(`method:${a.method}`);
  if (a.status) parts.push(`status:${a.status}`);
  if (a.urlPattern) parts.push(`url~${a.urlPattern}`);
  return parts.join(', ');
}

export function createNetworkTool({ chrome, ok, err, ensureCdp, tabBuf }) {
  const cdp = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

  async function actionList(args) {
    const store = tabBuf(args.tabId).network;
    let res;
    try {
      res = store.query({
        urlPattern: args.urlPattern, method: args.method, status: args.status,
        failedOnly: args.failedOnly, limit: args.limit ?? 100,
      });
    } catch (e) {
      return err(e.message);
    }
    const label = filterLabel(args);
    let text = formatList(res.items, { total: res.total, label });
    if (args.clear) {
      store.clear();
      text += '\n\n(buffer cleared)';
    }
    return ok([{ type: 'text', text }]);
  }

  async function requestSection(tabId, entry, bodyLimit) {
    if (!entry.hasPostData) return '';
    let data = entry.postData;
    if (data == null || data.length >= POST_DATA_KEPT) {
      try {
        data = (await cdp(tabId, 'Network.getRequestPostData', { requestId: entry.requestId })).postData ?? data;
      } catch { /* 取不到时沿用已缓存的前 8 KB */ }
    }
    if (data == null) return 'Request body: unavailable';
    const t = truncateText(data, bodyLimit);
    const note = t.truncated ? `\n  ...truncated, ${t.more} more characters` : '';
    return `Request body (${formatSize(data.length)})\n  ${t.text}${note}`;
  }

  // 返回 { section, file }：section 为展示文本，file 为需要落盘的 base64（仅 saveTo 时）
  async function responseSection(tabId, entry, { bodyLimit, saveTo }) {
    if (entry.failed) return { section: `Response body: none (request failed: ${failureReason(entry.failed)})` };
    if (!entry.finished) return { section: 'Response body: not available yet (request still in flight)' };
    if (entry.status >= 300 && entry.status < 400 && !entry.mimeType) {
      return { section: 'Response body: none (redirect)' };
    }
    let res;
    try {
      res = await cdp(tabId, 'Network.getResponseBody', { requestId: entry.requestId });
    } catch (e) {
      const why = BODY_GONE.test(e.message)
        ? 'Response body 已过期：浏览器只在会话内保留响应体，该请求的内容已被回收（或页面未读取过）。'
        : `Response body: failed to read (${e.message})`;
      return { section: why };
    }
    const mime = entry.mimeType || 'unknown type';
    const b64 = res.base64Encoded ? res.body : null;
    const size = res.base64Encoded ? base64Bytes(res.body) : new TextEncoder().encode(res.body).length;

    if (saveTo) {
      if (size > MAX_FILE_BYTES) {
        return { section: `Response body (${formatSize(size)}, ${mime}) exceeds the ${formatSize(MAX_FILE_BYTES)} save limit; fetch it in the page with javascript_tool instead.` };
      }
      return {
        section: `Response body (${formatSize(size)}, ${mime}): full content written to ${saveTo}, not shown here.`,
        file: b64 ?? utf8ToBase64(res.body),
      };
    }
    if (res.base64Encoded) {
      return { section: `Response body (${formatSize(size)}, ${mime}): binary content not shown; pass saveTo to keep it.` };
    }
    const t = truncateText(res.body, bodyLimit);
    const note = t.truncated ? `\n  ...truncated, ${t.more} more characters; pass saveTo to keep the full body` : '';
    return { section: `Response body (${formatSize(size)}, ${mime})\n  ${t.text}${note}` };
  }

  async function actionDetail(args) {
    if (!Number.isInteger(args.seq)) return err('detail requires seq (the #number shown by list)');
    const store = tabBuf(args.tabId).network;
    const entry = store.get(args.seq);
    if (entry === 'evicted') return err(`Request #${args.seq} was evicted from the buffer; only the most recent 1000 requests are kept`);
    if (!entry) return err(`No request #${args.seq} in this tab's buffer`);

    const bodyLimit = args.bodyLimit ?? 20000;
    const reqPart = await requestSection(args.tabId, entry, bodyLimit);
    const { section, file } = await responseSection(args.tabId, entry, { bodyLimit, saveTo: args.saveTo });
    const text = formatDetail(entry, { rawHeaders: !!args.rawHeaders, requestBody: reqPart, responseBody: section });
    const content = [{ type: 'text', text }];
    if (file !== undefined) content.push({ type: 'x-file', data: file });
    return ok(content);
  }

  return async function toolNetwork(args) {
    const { action, tabId } = args;
    if (!Number.isInteger(tabId)) return err('tabId required');
    if (action !== 'list' && action !== 'detail') return err(`Unknown action: ${action}`);
    await ensureCdp(tabId);
    return action === 'list' ? actionList(args) : actionDetail(args);
  };
}
