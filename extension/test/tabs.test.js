// lib/tabs.js 与 lib/url.js 的单元测试：颜色稳定、精确匹配、名字规范化、
// normalizeUrl 与受限地址、列表格式化。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAB_GROUP_COLORS, groupColor, findGroupByTitle, normalizeGroupName, isSystemUrl, formatTabList,
} from '../lib/tabs.js';
import { isRestrictedUrl, normalizeUrl } from '../lib/url.js';

// ── 颜色 ───────────────────────────────────────────────────────────────────────

test('TAB_GROUP_COLORS 含 8 种彩色且不含 grey', () => {
  assert.equal(TAB_GROUP_COLORS.length, 8);
  assert.ok(!TAB_GROUP_COLORS.includes('grey'));
  for (const c of ['blue', 'cyan', 'green', 'orange', 'pink', 'purple', 'red', 'yellow']) {
    assert.ok(TAB_GROUP_COLORS.includes(c), `缺少颜色 ${c}`);
  }
});

test('groupColor 稳定：同名永远同色，且只会返回 8 色之一', () => {
  const names = ['agent-a', 'agent-b', 'agent-b*', '结账', 'x'.repeat(40), ''];
  for (const name of names) {
    const first = groupColor(name);
    for (let i = 0; i < 20; i++) {
      assert.equal(groupColor(name), first, `名字 "${name}" 的颜色不稳定`);
    }
    assert.ok(TAB_GROUP_COLORS.includes(first));
    assert.notEqual(first, 'grey');
  }
});

test('groupColor 覆盖到的颜色都来自固定集合', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = groupColor('name-' + i);
    assert.ok(TAB_GROUP_COLORS.includes(c));
    seen.add(c);
  }
  // 哈希分布应能覆盖多种颜色（避免全部塌缩到单一颜色）
  assert.ok(seen.size >= 4, `颜色分布过于集中: ${[...seen].join(',')}`);
});

// ── 组查找与名字 ───────────────────────────────────────────────────────────────

test('findGroupByTitle 只用全等比较，名字含 * 不会模式匹配', () => {
  const groups = [
    { id: 1, title: 'agent-a' },
    { id: 2, title: 'agent-*' },
    { id: 3, title: 'a*ent-b' },
  ];
  assert.equal(findGroupByTitle(groups, 'agent-a').id, 1);
  assert.equal(findGroupByTitle(groups, 'agent-*').id, 2);
  assert.equal(findGroupByTitle(groups, 'agent-xyz'), null, '不应把 agent-* 当模式匹配到 agent-xyz');
  assert.equal(findGroupByTitle(groups, 'aXent-b'), null, 'a*ent-b 不应匹配 aXent-b');
  assert.equal(findGroupByTitle(groups, 'AGENT-A'), null, '大小写敏感（chrome title 是区分大小写存储）');
  assert.equal(findGroupByTitle([], 'agent-a'), null);
});

test('normalizeGroupName 去首尾空格并校验长度 1-40', () => {
  assert.equal(normalizeGroupName('  agent-a  '), 'agent-a');
  assert.equal(normalizeGroupName('a'), 'a');
  assert.equal(normalizeGroupName('x'.repeat(40)), 'x'.repeat(40));
  assert.equal(normalizeGroupName('   '), null);
  assert.equal(normalizeGroupName(''), null);
  assert.equal(normalizeGroupName('x'.repeat(41)), null);
  assert.equal(normalizeGroupName(null), null);
  assert.equal(normalizeGroupName(123), null);
});

// ── 系统地址 ───────────────────────────────────────────────────────────────────

test('isSystemUrl 识别 chrome/chrome-extension/devtools/about 地址', () => {
  assert.equal(isSystemUrl('chrome://settings'), true);
  assert.equal(isSystemUrl('chrome-extension://abc/popup.html'), true);
  assert.equal(isSystemUrl('devtools://devtools/bundled/index.html'), true);
  assert.equal(isSystemUrl('about:blank'), true);
  assert.equal(isSystemUrl('https://example.com'), false);
  assert.equal(isSystemUrl('http://example.com'), false);
  assert.equal(isSystemUrl('file:///tmp/a.html'), false);
  assert.equal(isSystemUrl(undefined), false, '空 url 不当系统地址崩溃');
  assert.equal(isSystemUrl(''), false);
});

// ── normalizeUrl ───────────────────────────────────────────────────────────────

test('normalizeUrl 无协议时补 https://', () => {
  assert.deepEqual(normalizeUrl('example.com'), { url: 'https://example.com' });
  assert.deepEqual(normalizeUrl('  example.com/path  '), { url: 'https://example.com/path' });
  assert.deepEqual(normalizeUrl('http://example.com'), { url: 'http://example.com' });
  assert.deepEqual(normalizeUrl('https://example.com'), { url: 'https://example.com' });
  assert.deepEqual(normalizeUrl('ftp://files.example.com'), { url: 'ftp://files.example.com' });
});

test('normalizeUrl 拦截受限地址（补协议前后各检查一次）', () => {
  // 补协议前的检查
  assert.deepEqual(normalizeUrl('chrome://settings'), { error: 'Blocked URL: chrome://settings' });
  assert.deepEqual(normalizeUrl('javascript:alert(1)'), { error: 'Blocked URL: javascript:alert(1)' });
  assert.deepEqual(normalizeUrl('about:blank'), { error: 'Blocked URL: about:blank' });
  assert.deepEqual(normalizeUrl('edge://settings'), { error: 'Blocked URL: edge://settings' });
  assert.deepEqual(normalizeUrl('devtools://devtools'), { error: 'Blocked URL: devtools://devtools' });
  // 补协议后的二次检查：chrome-settings 无协议，补 https 后不再受限，属正常 URL
  assert.deepEqual(normalizeUrl('chrome-settings.example.com'), { url: 'https://chrome-settings.example.com' });
});

test('isRestrictedUrl 直接判断原始字符串', () => {
  assert.equal(isRestrictedUrl('CHROME://settings'), true, '大小写不敏感');
  assert.equal(isRestrictedUrl('https://chrome.com'), false);
  assert.equal(isRestrictedUrl('javascript:x'), true);
});

// ── 列表格式化 ─────────────────────────────────────────────────────────────────

test('formatTabList 输出含 [ACTIVE]、组名、窗口号，过滤系统地址', () => {
  const tabs = [
    { id: 101, active: true, groupId: 11, title: '结账页', url: 'https://shop.example.com/checkout', windowId: 1 },
    { id: 102, active: false, groupId: 11, title: '订单列表', url: 'https://shop.example.com/orders', windowId: 1 },
    { id: 118, active: false, groupId: 12, title: 'API 文档', url: 'https://docs.example.com/api', windowId: 1 },
    { id: 120, active: false, groupId: undefined, title: '我的笔记', url: 'https://notes.example.com', windowId: 2 },
    { id: 130, active: false, groupId: undefined, title: '设置', url: 'chrome://settings', windowId: 1 },
    { id: 131, active: false, groupId: undefined, title: '', url: 'about:blank', windowId: 1 },
  ];
  const groups = [
    { id: 11, title: 'agent-a' },
    { id: 12, title: 'agent-b' },
  ];

  const text = formatTabList(tabs, groups, {});
  assert.ok(text.startsWith('Open tabs (4):\n\n'), `头部应为 4 个标签页：${text.split('\n')[0]}`);
  assert.ok(text.includes('[ACTIVE] [101] (agent-a) "结账页"'), 'active 标记与组名');
  assert.ok(text.includes('https://shop.example.com/checkout    window 1'), 'URL 行与窗口号');
  assert.ok(!text.includes('chrome://settings'), '系统地址应被过滤');
  assert.ok(!text.includes('[130]'), '系统地址标签页整行不出现');
  assert.ok(!text.includes('[ACTIVE] [102]'), '非 active 不带标记');
  assert.ok(text.includes('"Untitled"') === false, 'about:blank 被过滤，不会出现 Untitled');

  // 未归组的标签页没有组名括号
  const line120 = text.split('\n').find(l => l.includes('[120]'));
  assert.ok(line120 && !line120.includes('('), `[120] 行不应有组名: ${line120}`);
});

test('formatTabList 按 group 名字过滤', () => {
  const tabs = [
    { id: 101, active: true, groupId: 11, title: 'a', url: 'https://a.example.com', windowId: 1 },
    { id: 118, active: false, groupId: 12, title: 'b', url: 'https://b.example.com', windowId: 1 },
  ];
  const groups = [{ id: 11, title: 'agent-a' }, { id: 12, title: 'agent-b' }];

  const text = formatTabList(tabs, groups, { group: 'agent-a' });
  assert.ok(text.includes('[101]'));
  assert.ok(!text.includes('[118]'));
  assert.ok(text.includes('group "agent-a"'));

  const none = formatTabList(tabs, groups, { group: 'no-such-group' });
  assert.ok(none.startsWith('Open tabs (0,'), `应列出 0 个: ${none.split('\n')[0]}`);
});
