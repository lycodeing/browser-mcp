// popup 的纯逻辑：时间/体积格式化、流程名校验、消息类型常量。
// 不依赖 DOM 与 chrome，便于 node --test 单测；popup.html 中先于 popup.js 引入。

/** popup ↔ background 的消息类型，与 background.js 的 onMessage 分发保持一致 */
export const MSG = {
  GET_STATUS: 'getStatus',
  RECONNECT: 'reconnect',
  RECORD_START: 'record:start',
  RECORD_STOP: 'record:stop',
  RECORD_CANCEL: 'record:cancel',
  RECORD_STATE: 'record:getState',
  RECORD_LIST: 'record:list',
  RECORD_RUN: 'record:run',
  RECORD_DELETE: 'record:delete',
  RECORD_EXPORT_GIF: 'record:exportGif',
};

/** 毫秒 → MM:SS；非法或负数输入返回 00:00 */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const KB = 1024;

/** 字节数 → 人类可读（1.2 MB / 340 KB / 12 B）；0 或无 GIF 时返回空串 */
export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < KB) return `${n} B`;
  if (n < KB * KB) return `${(n / KB).toFixed(n / KB < 10 ? 1 : 0)} KB`;
  return `${(n / (KB * KB)).toFixed(1)} MB`;
}

/** 流程名校验：1-50 字符，去首尾空白后非空即合法 */
export function validateFlowName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return { ok: false, error: '流程名称不能为空' };
  if (trimmed.length > 50) return { ok: false, error: '流程名称不能超过 50 个字符' };
  return { ok: true, name: trimmed };
}

/**
 * ISO 时间串 → 本地化显示（2026-10-19 01:30）。
 * recordedAt 可能是 ISO 字符串或 epoch 毫秒，两者都兼容。
 */
export function formatRecordedAt(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 流程列表元信息行：6 步 · GIF 1.2 MB · 2026-10-19 01:30 */
export function formatFlowMeta(flow) {
  const parts = [`${flow.steps} 步`];
  const gif = formatSize(flow.gifSize);
  if (gif) parts.push(`GIF ${gif}`);
  const at = formatRecordedAt(flow.recordedAt);
  if (at) parts.push(at);
  return parts.join(' · ');
}
