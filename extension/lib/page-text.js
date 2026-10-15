// get_page_text 多 frame 的纯逻辑：各 frame 正文合并与输出格式化。
// 布局沿用 frames.js 的 mergeFrameTrees 策略：主 frame 在前、其余按 frameId 升序、
// maxChars 对全部 frame 合计、整行边界截断、被挤掉的 frame 以 omitted 行提示。

import { MAX_MERGED_FRAMES } from './frames.js';

function byFrameId(a, b) {
  if (a.frameId === 0) return -1;
  if (b.frameId === 0) return 1;
  return a.frameId - b.frameId;
}

/**
 * results: [{ frameId, title, url, content }]，content 为该 frame 的正文文本。
 * 空正文（或缺失）的 frame 跳过；返回 { body, frameCount, truncated, omitted }。
 */
export function mergeFrameTexts(results, maxChars = 50000) {
  const out = [];
  const omitted = [];
  let used = 0;
  let frameCount = 0;
  let truncated = false;
  let considered = 0;
  let full = false;

  for (const r of [...results].sort(byFrameId)) {
    const isMain = r.frameId === 0;
    if (!r.content) continue;
    if (!isMain && considered >= MAX_MERGED_FRAMES) { omitted.push(`f${r.frameId}`); truncated = true; continue; }
    if (!isMain) considered++;

    const header = isMain ? [] : ['', `Frame f${r.frameId} (${r.url || 'unknown'}):`];
    const lines = [...(isMain ? [`Title: ${r.title || 'N/A'}`, `URL: ${r.url || 'N/A'}`, ''] : []), ...r.content.split('\n')];
    const headerCost = header.reduce((n, l) => n + l.length + 1, 0);
    const taken = [];
    let cost = headerCost;
    for (const line of lines) {
      if (used + cost + line.length + 1 > maxChars) { full = true; break; }
      taken.push(line);
      cost += line.length + 1;
    }
    if (!taken.length) {
      omitted.push(`f${r.frameId}`);
      truncated = true;
      continue;
    }
    if (taken.length < lines.length) truncated = true;
    out.push(...header, ...taken);
    used += cost;
    frameCount++;
  }

  for (const o of omitted) out.push(`omitted: ${o}`);
  return { body: out.join('\n'), frameCount, truncated: truncated || omitted.length > 0 };
}

/** 单 frame 输出（现状格式），尾部带来源标识 */
export function formatSingleFrameText(res) {
  const head = `Title: ${res.title || 'N/A'}\nURL: ${res.url || 'N/A'}\n\n`;
  const tail = res.frameId ? `\n(frame f${res.frameId})` : '';
  return { text: `${head}${res.content || '(no text content)'}${tail}`, empty: !res.content };
}
