// intercept 的纯逻辑：规则校验、通配符匹配、规则存储、fulfill 响应构造。不依赖 chrome，便于单测。

export const ERROR_REASONS = [
  'Failed', 'Aborted', 'TimedOut', 'AccessDenied', 'ConnectionClosed', 'ConnectionReset', 'ConnectionRefused',
  'ConnectionAborted', 'ConnectionFailed', 'NameNotResolved', 'InternetDisconnected', 'AddressUnreachable',
  'BlockedByClient', 'BlockedByResponse',
];
export const MAX_RULES_PER_TAB = 50;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_DELAY_MS = 60000;
const MAX_PATTERN_LENGTH = 2000;
const ACTIONS = ['fail', 'fulfill', 'delay'];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// ── 通配符匹配 ────────────────────────────────────────────────────────────────
// 不转正则：多个 * 的正则在回溯时会指数级放大，Service Worker 会被卡死。这里用线性回退的双指针算法。
const STAR = Symbol('star');
const ANY = Symbol('any');

/** * 任意长度、? 恰好一个字符、反斜杠转义下一个字符，其余按字面。按码点切分，区分大小写 */
export function compilePattern(pattern) {
  const chars = Array.from(pattern);
  const tokens = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\\' && i + 1 < chars.length) tokens.push(chars[++i]);
    else if (ch === '*') { if (tokens[tokens.length - 1] !== STAR) tokens.push(STAR); }
    else if (ch === '?') tokens.push(ANY);
    else tokens.push(ch);
  }
  return tokens;
}

export function wildcardMatch(tokens, text) {
  const s = Array.from(text);
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < s.length) {
    if (p < tokens.length && tokens[p] !== STAR && (tokens[p] === ANY || tokens[p] === s[t])) { p++; t++; }
    else if (p < tokens.length && tokens[p] === STAR) { star = p++; mark = t; }
    else if (star !== -1) { p = star + 1; t = ++mark; }
    else return false;
  }
  while (p < tokens.length && tokens[p] === STAR) p++;
  return p === tokens.length;
}

// ── 校验 ──────────────────────────────────────────────────────────────────────
const utf8Length = (s) => new TextEncoder().encode(s).length;

// 合法 base64（标准字母表、无空白、长度补齐）时返回解码字节数，否则 -1
export function base64ByteLength(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return -1;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return -1;
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return s.length / 4 * 3 - padding;
}

/** 返回 { error } 或 { spec }。spec 是补好默认值、可直接入库的规则（不含 id 与 hits） */
export function validateRule(args) {
  const { urlPattern, action, method, errorReason, status, headers, body, bodyBase64, delayMs } = args;
  if (typeof urlPattern !== 'string' || urlPattern === '') return { error: 'urlPattern required' };
  if (urlPattern.length > MAX_PATTERN_LENGTH) return { error: `urlPattern too long (max ${MAX_PATTERN_LENGTH} chars)` };
  if (!ACTIONS.includes(action)) return { error: `Unknown action: ${action}. Use fail, fulfill or delay` };

  const spec = { urlPattern, action };
  if (method !== undefined && method !== '') {
    if (typeof method !== 'string' || !/^[A-Za-z]+$/.test(method.trim())) return { error: `Invalid method: ${method}` };
    spec.method = method.trim().toUpperCase();
  }

  if (action === 'fail') {
    const reason = errorReason ?? 'Failed';
    if (!ERROR_REASONS.includes(reason)) return { error: `Unknown errorReason: ${reason}. Use one of ${ERROR_REASONS.join(', ')}` };
    spec.errorReason = reason;
  } else if (action === 'fulfill') {
    const code = status ?? 200;
    if (!Number.isInteger(code) || code < 100 || code > 599) return { error: `Invalid status: ${status}. Use an integer from 100 to 599` };
    spec.status = code;
    if (headers !== undefined) {
      if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        return { error: 'headers must be an object of header name to string value' };
      }
      const clean = {};
      for (const [k, v] of Object.entries(headers)) {
        if (!HEADER_NAME.test(k)) return { error: `Invalid header name: "${k}"` };
        if (typeof v !== 'string') return { error: `Header "${k}" must be a string` };
        if (/[\r\n]/.test(v)) return { error: `Header "${k}" must not contain line breaks` };
        clean[k] = v;
      }
      spec.headers = clean;
    }
    if (body !== undefined && bodyBase64 !== undefined) {
      return { error: 'Provide either body (text) or bodyBase64 (binary), not both' };
    }
    if (bodyBase64 !== undefined) {
      const bytes = base64ByteLength(bodyBase64);
      if (bytes < 0) return { error: 'Invalid base64 in bodyBase64 (standard alphabet, no line breaks, length must be a multiple of 4)' };
      if (bytes > MAX_BODY_BYTES) return { error: `bodyBase64 too large (decoded ${bytes} B, max ${MAX_BODY_BYTES / 1024 / 1024} MB)` };
      spec.bodyB64 = bodyBase64;
      spec.bodyBytes = bytes;
    } else {
      const text = body ?? '';
      if (typeof text !== 'string') return { error: 'body must be a string' };
      if (utf8Length(text) > MAX_BODY_BYTES) return { error: `body too large (max ${MAX_BODY_BYTES / 1024 / 1024} MB)` };
      spec.body = text;
    }
  } else {
    if (!Number.isInteger(delayMs) || delayMs < 1 || delayMs > MAX_DELAY_MS) {
      return { error: `delay needs delayMs, an integer from 1 to ${MAX_DELAY_MS}` };
    }
    spec.delayMs = delayMs;
  }
  return { spec };
}

// ── 规则存储 ──────────────────────────────────────────────────────────────────
// active：该标签页的 Fetch 域当前确实开着。调试器断开后规则保留但 active 为 false。

export function createInterceptStore() {
  // tabId -> { nextId, active, entries: [{ rule, tokens }] }
  const tabs = new Map();

  const copy = (rule) => ({ ...rule, headers: rule.headers ? { ...rule.headers } : undefined });

  function ensure(tabId) {
    let tab = tabs.get(tabId);
    if (!tab) { tab = { nextId: 1, active: false, entries: [] }; tabs.set(tabId, tab); }
    return tab;
  }

  return {
    /** spec 须是 validateRule 的产物。加入规则即视为该标签页要求拦截，active 置 true */
    add(tabId, spec) {
      const tab = ensure(tabId);
      if (tab.entries.length >= MAX_RULES_PER_TAB) {
        throw new Error(`At most ${MAX_RULES_PER_TAB} rules per tab; remove some with intercept_remove first`);
      }
      const rule = { id: `r${tab.nextId++}`, ...spec, hits: 0 };
      tab.entries.push({ rule, tokens: compilePattern(rule.urlPattern) });
      tab.active = true;
      return copy(rule);
    },

    /** 不给 ruleId 则清空该标签页；返回删除条数。规则清空后整个标签页条目一并移除 */
    remove(tabId, ruleId) {
      const tab = tabs.get(tabId);
      if (!tab) return 0;
      let removed;
      if (ruleId === undefined) { removed = tab.entries.length; tab.entries = []; }
      else {
        const before = tab.entries.length;
        tab.entries = tab.entries.filter((e) => e.rule.id !== ruleId);
        removed = before - tab.entries.length;
      }
      if (!tab.entries.length) tabs.delete(tabId);
      return removed;
    },

    list(tabId) { return (tabs.get(tabId)?.entries ?? []).map((e) => copy(e.rule)); },

    /** 按添加顺序取第一条命中的规则（不计数，应答前由调用方 hit）。explicitMethod 为真时只看写明了 method 的规则 */
    match(tabId, { url, method }, { explicitMethod = false } = {}) {
      const tab = tabs.get(tabId);
      if (!tab) return null;
      const m = typeof method === 'string' ? method.toUpperCase() : '';
      for (const { rule, tokens } of tab.entries) {
        if (explicitMethod && !rule.method) continue;
        if (rule.method && rule.method !== m) continue;
        if (wildcardMatch(tokens, url)) return copy(rule);
      }
      return null;
    },

    hit(tabId, ruleId) {
      const entry = tabs.get(tabId)?.entries.find((e) => e.rule.id === ruleId);
      if (entry) entry.rule.hits++;
    },

    has(tabId) { return tabs.has(tabId); },
    isActive(tabId) { return tabs.get(tabId)?.active === true; },
    setActive(tabId, active) { const tab = tabs.get(tabId); if (tab) tab.active = active; },
    tabIds() { return [...tabs.keys()]; },
    dropTab(tabId) { tabs.delete(tabId); },

    dump() {
      const out = {};
      for (const [tabId, tab] of tabs) {
        out[tabId] = { nextId: tab.nextId, active: tab.active, rules: tab.entries.map((e) => copy(e.rule)) };
      }
      return { v: 1, tabs: out };
    },

    /** 用快照替换全部内容。结构不对或规则不合法的部分直接跳过，不抛错 */
    load(snapshot) {
      tabs.clear();
      if (!snapshot || snapshot.v !== 1 || typeof snapshot.tabs !== 'object' || snapshot.tabs === null) return;
      for (const [key, t] of Object.entries(snapshot.tabs)) {
        const tabId = Number(key);
        if (!Number.isInteger(tabId) || !t || !Array.isArray(t.rules)) continue;
        const entries = [];
        for (const r of t.rules) {
          // 入库后的字段名是 bodyB64（validateRule 的入参名是 bodyBase64），load 时改名；
          // 坏 base64 让 validateRule 失败，该条目整体跳过（与旧语义一致）
          const { bodyB64, ...rest } = r ?? {};
          const { spec } = validateRule(bodyB64 !== undefined ? { ...rest, bodyBase64: bodyB64 } : rest);
          if (!spec || typeof r.id !== 'string') continue;
          const rule = { id: r.id, ...spec, hits: Number.isInteger(r.hits) ? r.hits : 0 };
          entries.push({ rule, tokens: compilePattern(rule.urlPattern) });
        }
        if (!entries.length) continue;
        tabs.set(tabId, {
          nextId: Number.isInteger(t.nextId) ? t.nextId : entries.length + 1,
          active: t.active === true,
          entries,
        });
      }
    },
  };
}

// ── 请求与响应 ─────────────────────────────────────────────────────────────────

/** 大字符串分块转 base64，避免 String.fromCharCode.apply 栈溢出 */
export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function headerValue(headers, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers ?? {})) if (k.toLowerCase() === lower) return headers[k];
  return undefined;
}

/** CORS 预检：OPTIONS 且带 Access-Control-Request-Method */
export function isPreflight(request) {
  return typeof request.method === 'string' && request.method.toUpperCase() === 'OPTIONS'
    && headerValue(request.headers, 'access-control-request-method') !== undefined;
}

/** fulfill 规则的响应参数。没有 content-type 时补 text/plain（二进制 body 不补）；
 * 跨域请求回显 Origin 并补 allow-credentials: true（规范禁止 * 与 credentials 同用）。规则自己写的不覆盖。 */
export function buildFulfillment(rule, request) {
  const responseHeaders = Object.entries(rule.headers ?? {}).map(([name, value]) => ({ name, value }));
  const has = (n) => responseHeaders.some((h) => h.name.toLowerCase() === n);
  const binary = rule.bodyB64 !== undefined;
  if (!binary && !has('content-type')) responseHeaders.push({ name: 'content-type', value: 'text/plain; charset=utf-8' });
  const origin = headerValue(request.headers, 'origin');
  if (origin !== undefined) {
    if (!has('access-control-allow-origin')) responseHeaders.push({ name: 'access-control-allow-origin', value: origin });
    if (!has('access-control-allow-credentials')) responseHeaders.push({ name: 'access-control-allow-credentials', value: 'true' });
  }
  const out = { responseCode: rule.status, responseHeaders };
  const bodyB64 = binary ? rule.bodyB64 : rule.body ? utf8ToBase64(rule.body) : undefined;
  if (bodyB64) out.body = bodyB64;
  return out;
}

/** 预检请求的自动应答：204，回显来源、方法与请求头，带 Origin 时补 allow-credentials */
export function buildPreflightResponse(request) {
  const origin = headerValue(request.headers, 'origin');
  const headers = [
    { name: 'access-control-allow-origin', value: origin ?? '*' },
    { name: 'access-control-allow-methods', value: headerValue(request.headers, 'access-control-request-method') },
  ];
  if (origin !== undefined) headers.push({ name: 'access-control-allow-credentials', value: 'true' });
  const asked = headerValue(request.headers, 'access-control-request-headers');
  if (asked) headers.push({ name: 'access-control-allow-headers', value: asked });
  return { responseCode: 204, responseHeaders: headers };
}

/**
 * 决定一个被暂停请求的去向，并给命中的规则计数。返回：
 *   { type: 'continue' } | { type: 'fail', rule } | { type: 'delay', rule } | { type: 'fulfill', rule, params }
 * 预检请求：规则里显式写了 OPTIONS 的按用户规则走；否则看它所预检的那个方法命中什么规则，
 * fulfill 自动应答 204，fail 让预检同样失败，delay 放行预检（延迟留给真正的请求）。
 */
export function planResponse(store, tabId, request) {
  const req = { url: request.url ?? '', method: request.method ?? 'GET', headers: request.headers ?? {} };
  const apply = (rule) => {
    store.hit(tabId, rule.id);
    if (rule.action === 'fail') return { type: 'fail', rule };
    if (rule.action === 'delay') return { type: 'delay', rule };
    return { type: 'fulfill', rule, params: buildFulfillment(rule, req) };
  };

  if (isPreflight(req)) {
    const explicit = store.match(tabId, { url: req.url, method: 'OPTIONS' }, { explicitMethod: true });
    if (explicit) return apply(explicit);
    const target = store.match(tabId, { url: req.url, method: headerValue(req.headers, 'access-control-request-method') });
    if (target?.action === 'fulfill') {
      store.hit(tabId, target.id);
      return { type: 'fulfill', rule: target, params: buildPreflightResponse(req), preflight: true };
    }
    if (target?.action === 'fail') return apply(target);
    return { type: 'continue' };
  }

  const rule = store.match(tabId, req);
  return rule ? apply(rule) : { type: 'continue' };
}

// ── 输出 ──────────────────────────────────────────────────────────────────────

export function formatRule(rule) {
  const target = `${rule.method ? `${rule.method} ` : ''}${rule.urlPattern}`;
  let what;
  if (rule.action === 'fail') what = `fail ${rule.errorReason}`;
  else if (rule.action === 'delay') what = `delay ${rule.delayMs}ms`;
  else if (rule.bodyB64 !== undefined) {
    const n = Object.keys(rule.headers ?? {}).length;
    what = `fulfill ${rule.status}, ${n} header${n === 1 ? '' : 's'}, body ${rule.bodyBytes} B (binary)`;
  } else {
    const n = Object.keys(rule.headers ?? {}).length;
    what = `fulfill ${rule.status}, ${n} header${n === 1 ? '' : 's'}, body ${utf8Length(rule.body ?? '')} B`;
  }
  return `${rule.id}  ${target}  ->  ${what}  hits=${rule.hits}`;
}
