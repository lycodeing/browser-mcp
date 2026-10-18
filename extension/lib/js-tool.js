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

/**
 * 从 CDP 上下文列表里选目标 frame 的主世界（main world）上下文 id。
 * contexts: [{ id, frameId, isDefault, name }]
 * 优先 isDefault（页面主世界）；没有则退到该 frame 的任一上下文；都没有返回 null。
 */
export function pickContextId(contexts, frameId) {
  const forFrame = contexts.filter((c) => c.frameId === frameId);
  const def = forFrame.find((c) => c.isDefault);
  if (def) return def.id;
  return forFrame.length ? forFrame[0].id : null;
}

/** 语句关键字开头时用 async IIFE 包装，否则当表达式求值 */
export function isStatement(code) {
  return /^(const|let|var|function|class|if|for|while|switch|try|throw|return|do|export|import)\b/.test(code.trim());
}

/** 包成可直接交给 Runtime.evaluate 的表达式；语句用 async IIFE 以便 await 与 return */
export function wrapExpression(code) {
  return isStatement(code) ? `(async function(){${code}})()` : `(${code})`;
}
