// 多 frame 页面的纯逻辑：ref 解析与加前缀、树合并、find 结果合并、坐标偏移。
// 主 frame 的 ref 保持 ref_N，子 frame 为 f<frameId>.ref_N（每个 frame 的计数器各自从 1 开始）。

const REF_AT_LINE_START = /^(\s*)\[(ref_\d+)\]/gm;

export function parseRef(input) {
  if (typeof input !== 'string') return null;
  const m = /^(?:f(\d+)\.)?(ref_\d+)$/.exec(input.trim());
  return m ? { frameId: m[1] ? Number(m[1]) : 0, ref: m[2] } : null;
}

export function formatRef(frameId, ref) {
  return frameId ? `f${frameId}.${ref}` : ref;
}

/** 只改行首的 [ref_N]，不碰文本内容里碰巧出现的 "[ref_1]" */
export function prefixTreeRefs(tree, frameId) {
  if (!frameId) return tree;
  return tree.replace(REF_AT_LINE_START, (_, indent, ref) => `${indent}[${formatRef(frameId, ref)}]`);
}

function byFrameId(a, b) {
  if (a.frameId === 0) return -1;
  if (b.frameId === 0) return 1;
  return a.frameId - b.frameId;
}

function frameHeader(r) {
  const parts = [`frame f${r.frameId}`];
  if (Number.isInteger(r.depth)) parts.push(`depth ${r.depth}`);
  if (r.name) parts.push(`name="${r.name}"`);
  if (r.url) parts.push(r.url);
  return `── ${parts.join(' · ')} ──`;
}

/**
 * results: [{ frameId, tree, elementCount, truncated, url, name, depth }]
 * 主 frame 在前，其余按 frameId 升序；无元素的子 frame 省略；maxChars 对全部 frame 合计，
 * 在整行边界截断，被挤掉的 frame 以 omitted 行提示。
 */
export function mergeFrameTrees(results, maxChars = 50000) {
  const out = [];
  const omitted = [];
  let used = 0;
  let elementCount = 0;
  let frameCount = 0;
  let truncated = false;
  let considered = 0;
  let overflowFrames = 0;
  let full = false;

  for (const r of [...results].sort(byFrameId)) {
    const isMain = r.frameId === 0;
    if (!r.tree || (!isMain && !r.elementCount)) {
      if (r.truncated) truncated = true;
      continue;
    }
    if (r.truncated) truncated = true;
    if (!isMain && considered >= MAX_MERGED_FRAMES) { overflowFrames++; continue; }
    if (!isMain) considered++;

    if (full) { omitted.push(`f${r.frameId} (${r.elementCount} elements)`); continue; }

    const header = isMain ? [] : ['', frameHeader(r)];
    const lines = prefixTreeRefs(r.tree, r.frameId).split('\n');
    const headerCost = header.reduce((n, l) => n + l.length + 1, 0);
    const taken = [];
    let cost = headerCost;
    for (const line of lines) {
      if (used + cost + line.length + 1 > maxChars) { full = true; break; }
      taken.push(line);
      cost += line.length + 1;
    }
    if (!taken.length) {
      omitted.push(`f${r.frameId} (${r.elementCount} elements)`);
      truncated = true;
      continue;
    }
    if (taken.length < lines.length) truncated = true;
    out.push(...header, ...taken);
    used += cost;
    elementCount += taken.length;
    frameCount++;
  }

  for (const o of omitted) out.push(`omitted: ${o}`);
  if (overflowFrames) out.push(`omitted: ${overflowFrames} more frames (limit ${MAX_MERGED_FRAMES})`);
  return { body: out.join('\n'), elementCount, frameCount, truncated: truncated || omitted.length > 0 || overflowFrames > 0 };
}

/**
 * perFrame: [{ frameId, items: [{ ref, role, text, score }] }]
 * 统一按分数降序，同分按 frameId 升序，再按 frame 内原顺序。
 */
export function mergeFindResults(perFrame, maxResults = 20) {
  const flat = [];
  for (const f of perFrame) {
    (f.items || []).forEach((it, idx) => flat.push({ ...it, ref: formatRef(f.frameId, it.ref), frameId: f.frameId, idx }));
  }
  flat.sort((a, b) => b.score - a.score || a.frameId - b.frameId || a.idx - b.idx);
  return flat.slice(0, maxResults).map(({ idx: _idx, ...rest }) => rest);
}

export function formatFindLines(items) {
  return items.map((el, i) =>
    `${i + 1}. [${el.ref}] ${el.role} - "${el.text}" (score:${el.score})${el.frameId ? ` in frame f${el.frameId}` : ''}`);
}

/**
 * infos: [{ frameId, token, parentToken, children: [{ token, rect:{left,top,width}, offsetWidth, clientLeft, clientTop }] }]
 * 返回 { x, y, scale }：顶层视口坐标 = (x, y) + scale * 目标 frame 内坐标。
 * 沿 parentToken 逐层累加平移与等比缩放（iframe 元素上的 CSS transform: scale），不处理旋转和倾斜。
 * 链路不完整（握手未完成）返回 null。
 */
export function resolveFrameOffset(frameId, infos) {
  const byFrame = new Map(infos.map((i) => [i.frameId, i]));
  const byToken = new Map(infos.map((i) => [i.token, i]));
  let cur = byFrame.get(frameId);
  if (!cur) return null;
  const t = { x: 0, y: 0, scale: 1 };
  for (let guard = 0; cur.frameId !== 0 && guard < 50; guard++) {
    const parent = byToken.get(cur.parentToken);
    const child = parent?.children?.find((c) => c.token === cur.token);
    if (!parent || !child) return null;
    const sx = child.offsetWidth > 0 ? child.rect.width / child.offsetWidth : 1;
    t.x = child.rect.left + child.clientLeft * sx + t.x * sx;
    t.y = child.rect.top + child.clientTop * sx + t.y * sx;
    t.scale *= sx;
    cur = parent;
  }
  return cur.frameId === 0 ? t : null;
}

export function toTopPoint(offset, point) {
  return [offset.x + offset.scale * point[0], offset.y + offset.scale * point[1]];
}

export const MAX_MERGED_FRAMES = 30;

// ── 两套 frame 标识的映射 ────────────────────────────────────────────────────
// chrome.scripting 用数字 frameId（ref 前缀 f<N> 就是它），CDP 用不透明字符串 frameId
// （Runtime 执行上下文、DOM 命令都认这个）。子 frame 的 JS 求值必须换算出 CDP id。

/** Page.getFrameTree 的树拍平成 [{ id, url, name, parentId }]（前序，根在前） */
export function flattenFrameTree(node, parentId, out = []) {
  if (!node) return out;
  const f = node.frame ?? node;
  if (!f.id) return out;
  out.push({ id: f.id, url: f.url ?? '', name: f.name ?? '', parentId });
  for (const child of node.childFrames ?? []) flattenFrameTree(child, f.id, out);
  return out;
}

/**
 * 建立 数字 frameId → CDP frameId 的映射。
 * extFrames: [{ frameId, url, name }]（来自 executeScript allFrames 读 location.href）
 * cdpFrames: flattenFrameTree 的产物
 * 先按 URL+window.name 精确配对，再按 URL，最后同 URL 多帧时按出现顺序补齐。
 */
export function buildFrameIdMap(extFrames, cdpFrames) {
  const map = new Map();
  const pool = [...cdpFrames];
  const take = (pred) => {
    const i = pool.findIndex(pred);
    return i >= 0 ? pool.splice(i, 1)[0] : null;
  };
  for (const ef of extFrames) {
    const hit = take((c) => c.url === ef.url && c.name === (ef.name ?? ''));
    if (hit) map.set(ef.frameId, hit.id);
  }
  for (const ef of extFrames) {
    if (map.has(ef.frameId)) continue;
    const hit = take((c) => c.url === ef.url);
    if (hit) map.set(ef.frameId, hit.id);
  }
  for (const ef of extFrames) {
    if (map.has(ef.frameId)) continue;
    const hit = pool.shift();
    if (hit) map.set(ef.frameId, hit.id);
  }
  return map;
}
