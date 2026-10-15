// javascript_tool 的纯逻辑：返回值格式化。不依赖 chrome，便于单测。

export const MAX_CODE_CHARS = 100000;
export const MAX_RESULT_CHARS = 50000;

/** Runtime/executeScript 返回值的可读化：undefined/null/标量直出，其余 JSON 序列化 */
export function formatJsResult(v) {
  if (v === undefined || v === null) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export function truncateResult(text) {
  return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + '\n...[truncated]' : text;
}
