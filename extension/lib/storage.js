// storage 工具的纯逻辑：入参校验、注入页面执行的函数、结果格式化。

const ACTIONS = ['list', 'get', 'set', 'remove', 'clear', 'idb'];
const AREAS = ['local', 'session'];
export const DEFAULT_MAX_CHARS = 2000;

/** 返回错误文案或 null。按 action 的必填检查放在这里（relay 的 schema 是扁平的） */
export function validateStorageArgs(args) {
  const { action, area, key, value } = args;
  if (!ACTIONS.includes(action)) return `Unknown action: ${action}. Use one of ${ACTIONS.join(', ')}`;
  if (area !== undefined && !AREAS.includes(area)) return `Unknown area: ${area}. Use local or session`;
  if ((action === 'get' || action === 'set' || action === 'remove') && (typeof key !== 'string' || key === '')) {
    return `${action} needs key`;
  }
  if (action === 'set' && typeof value !== 'string') return 'set needs value (a string; JSON.stringify objects first)';
  return null;
}

/**
 * 在页面主 frame 里执行，由 chrome.scripting.executeScript 序列化注入，
 * 所以必须自包含：不能引用本模块的任何外部绑定。
 * 返回可结构化克隆的普通对象；存储被禁用时返回 { origin, denied }，不抛错。
 */
export async function pageStorageOp(spec) {
  const MAX_KEYS = 200;
  const PREVIEW = 200;
  const MAX_DBS = 20;
  const MAX_STORES = 50;
  const OPEN_TIMEOUT_MS = 3000;
  const origin = location.origin;
  const reason = (e) => `${e?.name || 'Error'}: ${e?.message || e}`;
  const byteLength = (s) => new TextEncoder().encode(s).length;

  if (spec.action === 'idb') {
    let idb;
    try { idb = window.indexedDB; } catch (e) { return { origin, denied: reason(e) }; }
    if (!idb || typeof idb.databases !== 'function') {
      return { origin, denied: 'indexedDB.databases() is not available in this browser or page' };
    }
    let infos;
    try { infos = await idb.databases(); } catch (e) { return { origin, denied: reason(e) }; }

    // 用当前版本打开，不会触发升级；万一库刚被删而要新建，立即中止，避免留下空库
    const openDb = (name, version) => new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (v) => {
        if (settled) { if (v.db) v.db.close(); return; }
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      timer = setTimeout(() => finish({ unavailable: 'open timed out (another connection may be upgrading it)' }), OPEN_TIMEOUT_MS);
      let req;
      try { req = idb.open(name, version); } catch (e) { finish({ unavailable: reason(e) }); return; }
      req.onupgradeneeded = () => { try { req.transaction.abort(); } catch { /* 已中止 */ } };
      req.onerror = () => finish({ unavailable: req.error ? reason(req.error) : 'open failed' });
      req.onsuccess = () => finish({ db: req.result });
    });

    const countStore = (db, name) => new Promise((resolve) => {
      try {
        const r = db.transaction(name, 'readonly').objectStore(name).count();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
      } catch { resolve(null); }
    });

    const databases = [];
    for (const info of infos.slice(0, MAX_DBS)) {
      const entry = { name: info.name, version: info.version, stores: [] };
      const opened = await openDb(info.name, info.version);
      if (opened.unavailable) {
        entry.unavailable = opened.unavailable;
      } else {
        const db = opened.db;
        try {
          const names = Array.from(db.objectStoreNames);
          entry.storeTotal = names.length;
          for (const n of names.slice(0, MAX_STORES)) {
            const store = db.transaction(n, 'readonly').objectStore(n);
            entry.stores.push({ name: n, keyPath: store.keyPath, autoIncrement: store.autoIncrement, count: await countStore(db, n) });
          }
        } catch (e) {
          entry.unavailable = reason(e);
        } finally {
          db.close();
        }
      }
      databases.push(entry);
    }
    return { origin, databases, databaseTotal: infos.length };
  }

  const areaName = spec.area === 'session' ? 'sessionStorage' : 'localStorage';
  let store;
  try {
    store = window[areaName];
    void store.length;
  } catch (e) {
    return { origin, area: areaName, denied: reason(e) };
  }

  try {
    if (spec.action === 'list') {
      const total = store.length;
      const entries = [];
      for (let i = 0; i < Math.min(total, MAX_KEYS); i++) {
        const k = store.key(i);
        const v = store.getItem(k) ?? '';
        entries.push({ key: k, bytes: byteLength(v), preview: v.length > PREVIEW ? v.slice(0, PREVIEW) : v, cut: v.length > PREVIEW });
      }
      return { origin, area: areaName, total, entries };
    }
    if (spec.action === 'get') {
      const v = store.getItem(spec.key);
      if (v === null) return { origin, area: areaName, missing: true };
      return { origin, area: areaName, length: v.length, value: v.slice(0, spec.maxChars) };
    }
    const before = store.length;
    if (spec.action === 'set') {
      const prev = store.getItem(spec.key);
      store.setItem(spec.key, spec.value);
      return { origin, area: areaName, before, after: store.length, previousLength: prev === null ? null : prev.length };
    }
    if (spec.action === 'remove') {
      const existed = store.getItem(spec.key) !== null;
      store.removeItem(spec.key);
      return { origin, area: areaName, before, after: store.length, existed };
    }
    store.clear();
    return { origin, area: areaName, before, after: store.length };
  } catch (e) {
    return { origin, area: areaName, failed: reason(e) };
  }
}

const q = (s) => JSON.stringify(s);

function formatList(res) {
  const lines = [`Origin: ${res.origin}`, `${res.area}: ${res.total} key${res.total === 1 ? '' : 's'}`];
  for (const e of res.entries) {
    lines.push(`  ${e.key}  (${e.bytes} B)  ${q(e.preview)}${e.cut ? '…' : ''}`);
  }
  if (res.total > res.entries.length) lines.push(`(showing first ${res.entries.length} of ${res.total})`);
  return lines.join('\n');
}

function formatIdb(res) {
  const lines = [`Origin: ${res.origin}`, `IndexedDB: ${res.databaseTotal} database${res.databaseTotal === 1 ? '' : 's'}`];
  for (const d of res.databases) {
    if (d.unavailable) { lines.push(`  ${d.name} (version ${d.version})  unavailable: ${d.unavailable}`); continue; }
    lines.push(`  ${d.name} (version ${d.version})`);
    for (const s of d.stores) {
      const key = s.keyPath == null ? 'no keyPath' : `keyPath=${q(s.keyPath)}`;
      lines.push(`    ${s.name}  ${key}${s.autoIncrement ? ' autoIncrement' : ''}  ${s.count ?? '?'} records`);
    }
    if (d.storeTotal > d.stores.length) lines.push(`    (showing first ${d.stores.length} of ${d.storeTotal} object stores)`);
  }
  if (res.databaseTotal > res.databases.length) lines.push(`(showing first ${res.databases.length} of ${res.databaseTotal} databases)`);
  lines.push('Read-only summary: record contents are not read.');
  return lines.join('\n');
}

/** 把页面返回的结果转成 { text, error }。存储被禁用不算工具故障，error 为 false */
export function formatStorageResult(spec, res) {
  if (res.denied) {
    const what = spec.action === 'idb' ? 'IndexedDB' : res.area;
    return { text: `Origin: ${res.origin}\nCannot access ${what} on this page (${res.denied}). It may be a sandboxed frame, a data: page, or blocked by browser privacy settings.`, error: false };
  }
  if (res.failed) return { text: `${spec.action} failed on ${res.area}: ${res.failed}`, error: true };

  const head = `Origin: ${res.origin}`;
  switch (spec.action) {
    case 'list': return { text: formatList(res), error: false };
    case 'idb': return { text: formatIdb(res), error: false };
    case 'get': {
      if (res.missing) return { text: `${head}\nKey not found: ${q(spec.key)} in ${res.area}`, error: false };
      const cut = res.length > res.value.length;
      const note = cut ? `\n(truncated: showing first ${res.value.length} of ${res.length} chars; raise maxChars, up to 200000)` : '';
      return { text: `${head}\n${res.area}[${q(spec.key)}] (${res.length} chars):\n${res.value}${note}`, error: false };
    }
    case 'set': {
      const prev = res.previousLength === null ? 'new key' : `replaced a ${res.previousLength}-char value`;
      return { text: `${head}\nSet ${res.area}[${q(spec.key)}] to ${spec.value.length} chars (${prev}). Keys: ${res.before} -> ${res.after}`, error: false };
    }
    case 'remove':
      return {
        text: `${head}\n${res.existed ? `Removed ${res.area}[${q(spec.key)}]` : `Key not present in ${res.area}, nothing removed: ${q(spec.key)}`}. Keys: ${res.before} -> ${res.after}`,
        error: false,
      };
    default:
      return { text: `${head}\nCleared ${res.area}: removed ${res.before - res.after} key${res.before - res.after === 1 ? '' : 's'}. Keys: ${res.before} -> ${res.after}`, error: false };
  }
}
