// 网络请求缓冲与格式化的纯逻辑。只存元数据和头，响应体按需向浏览器取。

const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);
const POST_DATA_KEEP = 8 * 1024;

export function parseStatusFilter(input) {
  const s = String(input).trim().toLowerCase();
  let m;
  if ((m = /^([1-5])xx$/.exec(s))) {
    const lo = Number(m[1]) * 100;
    return { lo, hi: lo + 99 };
  }
  if ((m = /^(\d{3})$/.exec(s))) return { lo: Number(m[1]), hi: Number(m[1]) };
  if ((m = /^(\d{3})-(\d{3})$/.exec(s)) && Number(m[1]) <= Number(m[2])) return { lo: Number(m[1]), hi: Number(m[2]) };
  throw new Error(`Invalid status filter "${input}". Use "404", "4xx" or "500-599".`);
}

export function failureReason(failed) {
  if (!failed) return '';
  if (failed.corsError) return `blocked: cors (${failed.corsError})`;
  if (failed.blockedReason) return `blocked: ${failed.blockedReason}`;
  if (failed.errorText) return failed.errorText;
  return failed.canceled ? 'canceled' : 'failed';
}

export function isFailedEntry(e) {
  return !!e.failed || (e.status != null && e.status >= 400);
}

export function createNetworkStore({ capacity = 1000 } = {}) {
  let entries = [];
  const byRequestId = new Map();
  let nextSeq = 1;
  let evictedBefore = 0;
  let lastStart = 0;

  function evict() {
    while (entries.length > capacity) {
      const old = entries.shift();
      evictedBefore = old.seq;
      if (byRequestId.get(old.requestId) === old) byRequestId.delete(old.requestId);
    }
  }

  function settleRedirect(prev, redirectResponse) {
    prev.status = redirectResponse.status ?? prev.status;
    prev.statusText = redirectResponse.statusText ?? prev.statusText;
    prev.mimeType = redirectResponse.mimeType ?? prev.mimeType;
    prev.responseHeaders = redirectResponse.headers ?? prev.responseHeaders;
    prev.finished = true;
  }

  return {
    onRequest(params, now = Date.now()) {
      const prev = byRequestId.get(params.requestId);
      if (prev && params.redirectResponse) settleRedirect(prev, params.redirectResponse);
      const req = params.request || {};
      const entry = {
        seq: nextSeq++,
        requestId: params.requestId,
        method: req.method || 'GET',
        url: req.url || '',
        type: params.type || 'Other',
        startedAt: now,
        monotonicStart: params.timestamp ?? null,
        status: null, statusText: '', mimeType: '',
        requestHeaders: req.headers || {},
        responseHeaders: null,
        postData: typeof req.postData === 'string' ? req.postData.slice(0, POST_DATA_KEEP) : null,
        hasPostData: !!req.hasPostData || typeof req.postData === 'string',
        finished: false, durationMs: null, encodedBytes: null,
        failed: null,
      };
      entries.push(entry);
      byRequestId.set(params.requestId, entry);
      lastStart = now;
      evict();
      return entry;
    },

    onExtraInfo(params) {
      const e = byRequestId.get(params.requestId);
      if (e && params.headers) e.requestHeaders = { ...e.requestHeaders, ...params.headers };
    },

    onResponse(params) {
      const e = byRequestId.get(params.requestId);
      if (!e) return;
      const r = params.response || {};
      e.status = r.status ?? 0;
      e.statusText = r.statusText || '';
      e.mimeType = r.mimeType || '';
      e.responseHeaders = r.headers || {};
      if (r.requestHeaders) e.requestHeaders = { ...e.requestHeaders, ...r.requestHeaders };
    },

    onFinished(params) {
      const e = byRequestId.get(params.requestId);
      if (!e) return;
      e.finished = true;
      e.encodedBytes = params.encodedDataLength ?? null;
      if (e.monotonicStart != null && params.timestamp != null) {
        e.durationMs = Math.max(0, Math.round((params.timestamp - e.monotonicStart) * 1000));
      }
    },

    onFailed(params) {
      const e = byRequestId.get(params.requestId);
      if (!e) return;
      e.finished = true;
      e.failed = {
        errorText: params.errorText || '',
        blockedReason: params.blockedReason || null,
        canceled: !!params.canceled,
        corsError: params.corsErrorStatus?.corsError || null,
      };
      if (e.monotonicStart != null && params.timestamp != null) {
        e.durationMs = Math.max(0, Math.round((params.timestamp - e.monotonicStart) * 1000));
      }
    },

    /** 返回 { items, total }；total 为过滤前的缓冲条数 */
    query({ urlPattern, method, status, failedOnly = false, limit = 100 } = {}) {
      const range = status != null && status !== '' ? parseStatusFilter(status) : null;
      const m = method ? String(method).toUpperCase() : null;
      let items = entries.filter((e) =>
        (!urlPattern || e.url.includes(urlPattern))
        && (!m || e.method.toUpperCase() === m)
        && (!range || (e.status != null && e.status >= range.lo && e.status <= range.hi))
        && (!failedOnly || isFailedEntry(e)));
      items = items.slice(-limit);
      return { items, total: entries.length };
    },

    get(seq) {
      if (seq <= evictedBefore) return 'evicted';
      return entries.find((e) => e.seq === seq);
    },

    clear() {
      evictedBefore = nextSeq - 1;
      entries = [];
      byRequestId.clear();
    },

    lastStartedAt() { return lastStart; },
    size() { return entries.length; },
  };
}

export function maskHeaders(headers, raw = false) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = !raw && SENSITIVE_HEADERS.has(k.toLowerCase()) ? '****' : v;
  }
  return out;
}

function formatHeaders(headers, raw) {
  const h = maskHeaders(headers, raw);
  const keys = Object.keys(h);
  return keys.length ? keys.map((k) => `  ${k}: ${h[k]}`).join('\n') : '  (none)';
}

export function formatSize(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

export function formatList(items, { total, label = '' } = {}) {
  if (!items.length) return 'No network requests';
  const lines = items.map((e) => {
    const failed = !!e.failed;
    const st = failed ? 'FAIL' : String(e.status ?? '---').padStart(4);
    let note = '';
    if (failed) note = failureReason(e.failed);
    else if (e.status >= 500) note = 'HTTP 5xx';
    else if (e.status >= 400) note = 'HTTP 4xx';
    return `#${String(e.seq).padEnd(4)} ${e.method.padEnd(5)} ${st} [${(e.type || 'Other').slice(0, 9).padEnd(9)}] ${e.url}${note ? `  ${note}` : ''}`;
  });
  const head = `Network (${items.length} of ${total}${label ? `, ${label}` : ''}):`;
  return `${head}\n\n${lines.join('\n')}`;
}

export function truncateText(text, limit) {
  if (text.length <= limit) return { text, truncated: false, more: 0 };
  return { text: text.slice(0, limit), truncated: true, more: text.length - limit };
}

/** body: 响应体展示段；postBody: 请求体展示段（均已由调用方处理好，可为空） */
export function formatDetail(e, { rawHeaders = false, requestBody = '', responseBody = '' } = {}) {
  const dur = e.durationMs != null ? `  (${(e.durationMs / 1000).toFixed(1)}s)` : '';
  const status = e.failed ? `FAILED ${failureReason(e.failed)}` : `${e.status ?? '---'} ${e.statusText || ''}`.trim();
  const parts = [
    `#${e.seq} ${e.method} ${e.url}  → ${status}${dur}`,
    'Request headers', formatHeaders(e.requestHeaders, rawHeaders),
  ];
  if (requestBody) parts.push(requestBody);
  parts.push('Response headers', formatHeaders(e.responseHeaders, rawHeaders));
  if (responseBody) parts.push(responseBody);
  return parts.join('\n');
}
