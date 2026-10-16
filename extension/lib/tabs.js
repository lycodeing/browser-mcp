// 标签页与标签组的纯逻辑：颜色分配、按名字精确匹配组、名字规范化、列表格式化。
// 不依赖 chrome.*，方便用 node:test 覆盖。

// 可分配的组颜色，不含 grey（grey 用于 Chrome 默认样式，无辨识度）
export const TAB_GROUP_COLORS = ['blue', 'cyan', 'green', 'orange', 'pink', 'purple', 'red', 'yellow'];

// 对组名做稳定哈希取色：同名在不同窗口、不同会话得到同一种颜色，用户可凭颜色认人
export function groupColor(name) {
  let h = 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return TAB_GROUP_COLORS[h % TAB_GROUP_COLORS.length];
}

// tabGroups.query 的 title 是模式匹配，名字带 * 会误匹配，所以只用全等比较
export function findGroupByTitle(groups, name) {
  return groups.find(g => g.title === name) ?? null;
}

// 组名去首尾空格，长度 1-40；非法返回 null
export function normalizeGroupName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 40) return null;
  return trimmed;
}

// tabs.list 过滤掉浏览器内部地址（不含 edge/javascript：列表场景下少见且保持与旧 toolTabsContext 一致的核心集合）
const SYSTEM_URL_RE = /^(chrome|chrome-extension|devtools|about):/i;
export function isSystemUrl(url) {
  return SYSTEM_URL_RE.test(url || '');
}

// 标签页列表格式化。tabs: chrome.tabs.query 的结果；groups: [{id, title}]；
// group 非空时只保留属于该组名的标签页（按 groupId→title 映射）。
export function formatTabList(tabs, groups, { group } = {}) {
  const titleById = new Map(groups.map(g => [g.id, g.title]));

  let filtered = tabs.filter(t => !isSystemUrl(t.url));
  if (group) filtered = filtered.filter(t => titleById.get(t.groupId) === group);

  const lines = filtered.map(t => {
    const active = t.active ? '[ACTIVE] ' : '         ';
    const groupName = titleById.get(t.groupId);
    const groupPart = groupName ? `(${groupName}) ` : '';
    return `${active}[${t.id}] ${groupPart}"${t.title || 'Untitled'}"\n         ${t.url}    window ${t.windowId}`;
  });

  const suffix = group ? `, group "${group}"` : '';
  return `Open tabs (${filtered.length}${suffix}):\n\n${lines.join('\n')}`;
}

// tabId 不存在时的错误文案：附上真实存在的标签页（最多 max 行），让调用方可自纠，
// 而不是只有 chrome 原生的 "No tab with id: N"。
export function tabNotFoundMessage(tabId, tabs, { max = 10 } = {}) {
  const lines = (tabs || []).slice(0, max).map(t =>
    `[${t.id}] "${String(t.title || 'Untitled').slice(0, 60)}" ${t.url}`);
  return `Tab ${tabId} not found. tabId is the numeric Chrome tab id; list real ones with the tabs tool (action: "list"). `
    + `Open tabs:\n${lines.join('\n') || '(none)'}`;
}
