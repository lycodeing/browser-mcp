// tools/tabs.js 的测试：用手写的 fake chrome 对象覆盖七个 action 的主路径与关键错误路径。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTabsTool } from '../tools/tabs.js';
import { TAB_GROUP_COLORS, groupColor } from '../lib/tabs.js';

const ok = content => ({ content });
const err = msg => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const text = r => r.content[0].text;

// ── fake chrome ────────────────────────────────────────────────────────────────
// nextTabId 自增；tabs 存对象；groups 由 group/ungroup 操作维护

function makeChrome({ tabs = [], tabGroups = [] } = {}) {
  let nextId = Math.max(0, ...tabs.map(t => t.id)) + 1;
  const calls = { created: [], removed: [], grouped: [], ungrouped: [], groupUpdated: [], reloaded: [], activated: [] };

  const chrome = {
    tabs: {
      async query(_filter) { return tabs.map(t => ({ ...t })); },
      async get(id) {
        const t = tabs.find(x => x.id === id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return { ...t };
      },
      async create(props) {
        const tab = { id: nextId++, active: props.active, url: props.url ?? 'about:blank', title: 'Example Domain', windowId: 1, groupId: undefined, status: 'complete' };
        tabs.push(tab);
        calls.created.push({ ...props });
        return { ...tab };
      },
      async remove(ids) {
        for (const id of [].concat(ids)) {
          const idx = tabs.findIndex(t => t.id === id);
          if (idx < 0) throw new Error(`No tab with id: ${id}`);
          tabs.splice(idx, 1);
          calls.removed.push(id);
        }
      },
      async update(id, props) {
        const t = tabs.find(x => x.id === id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        Object.assign(t, props);
        if (props.active) calls.activated.push(id);
        return { ...t };
      },
      async reload(id, props) { calls.reloaded.push({ id, ...props }); },
      async duplicate(id) {
        const t = tabs.find(x => x.id === id);
        if (!t) return undefined;
        const copy = { ...t, id: nextId++ };
        tabs.push(copy);
        return { ...copy };
      },
      async group({ tabIds, groupId, createProperties }) {
        calls.grouped.push({ tabIds: [...tabIds], groupId, createProperties });
        let group;
        if (groupId) group = tabGroups.find(g => g.id === groupId);
        if (!group) {
          group = { id: nextId++, windowId: createProperties?.windowId ?? 1, title: '', color: 'grey' };
          tabGroups.push(group);
        }
        for (const id of tabIds) {
          const t = tabs.find(x => x.id === id);
          if (t) t.groupId = group.id;
        }
        return group.id;
      },
      async ungroup(ids) {
        calls.ungrouped.push([...ids]);
        for (const id of ids) {
          const t = tabs.find(x => x.id === id);
          if (t) t.groupId = undefined;
        }
        // 组变空时 Chrome 自动删除
        for (let i = tabGroups.length - 1; i >= 0; i--) {
          if (!tabs.some(t => t.groupId === tabGroups[i].id)) tabGroups.splice(i, 1);
        }
      },
    },
    tabGroups: {
      async query(filter) {
        return tabGroups
          .filter(g => filter?.windowId === undefined || g.windowId === filter.windowId)
          .map(g => ({ ...g }));
      },
      async update(groupId, props) {
        const g = tabGroups.find(x => x.id === groupId);
        if (!g) throw new Error(`No group with id: ${groupId}`);
        Object.assign(g, props);
        calls.groupUpdated.push({ groupId, ...props });
        return { ...g };
      },
    },
    windows: {
      async update(windowId, props) { calls.activated.push({ windowId, ...props }); },
    },
  };

  return { chrome, calls, state: { tabs, tabGroups } };
}

// 立即完成的 waitForLoad；loaded=false 可用 waitForLoadOverride 控制
function makeDeps(overrides = {}) {
  return {
    ok, err, sleep,
    waitForLoad: overrides.waitForLoad ?? (async () => true),
    ...overrides,
  };
}

// ── list ───────────────────────────────────────────────────────────────────────

test('list：过滤系统地址，带组名、窗口号与 [ACTIVE]', async () => {
  const { chrome } = makeChrome({
    tabs: [
      { id: 101, active: true, groupId: 11, title: '结账页', url: 'https://shop.example.com/checkout', windowId: 1 },
      { id: 130, active: false, title: '设置', url: 'chrome://settings', windowId: 1 },
    ],
    tabGroups: [{ id: 11, windowId: 1, title: 'agent-a', color: 'blue' }],
  });
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'list' });
  assert.ok(!r.isError);
  assert.ok(text(r).includes('Open tabs (1):'));
  assert.ok(text(r).includes('[ACTIVE] [101] (agent-a) "结账页"'));
  assert.ok(!text(r).includes('[130]'));
});

test('list：group 参数过滤组名', async () => {
  const { chrome } = makeChrome({
    tabs: [
      { id: 101, active: false, groupId: 11, title: 'a', url: 'https://a.example.com', windowId: 1 },
      { id: 102, active: false, groupId: 12, title: 'b', url: 'https://b.example.com', windowId: 1 },
    ],
    tabGroups: [{ id: 11, windowId: 1, title: 'agent-a', color: 'blue' }, { id: 12, windowId: 1, title: 'agent-b', color: 'red' }],
  });
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'list', group: 'agent-a' });
  assert.ok(text(r).includes('[101]'));
  assert.ok(!text(r).includes('[102]'));
});

// ── create ─────────────────────────────────────────────────────────────────────

test('create：默认 active、url 规范化、加载完成后返回标题/最终地址/耗时', async () => {
  const { chrome, calls } = makeChrome();
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'create', url: 'example.com' });
  assert.ok(!r.isError, text(r));
  assert.equal(calls.created[0].url, 'https://example.com');
  assert.equal(calls.created[0].active, true, 'active 默认 true');
  assert.ok(text(r).startsWith('Created tab [1], loaded ('));
  assert.ok(text(r).includes('URL: https://example.com'));
  assert.ok(text(r).includes('Title: Example Domain'));
});

test('create：未传 url 时打开空白页，不做加载等待', async () => {
  const { chrome } = makeChrome();
  let waited = 0;
  const tool = createTabsTool({ chrome, ...makeDeps({ waitForLoad: async () => { waited++; return true; } }) });
  const r = await tool({ action: 'create' });
  assert.ok(!r.isError);
  assert.equal(waited, 0, 'about:blank 不需要 waitForLoad');
  assert.ok(text(r).startsWith('Created tab [1]'));
});

test('create：active:false 透传；未加载完返回 still loading', async () => {
  const { chrome, calls } = makeChrome();
  const tool = createTabsTool({ chrome, ...makeDeps({ waitForLoad: async () => false }) });
  const r = await tool({ action: 'create', url: 'https://slow.example.com', active: false });
  assert.ok(!r.isError);
  assert.equal(calls.created[0].active, false);
  assert.ok(text(r).includes('still loading'));
});

test('create：受限地址被拦截', async () => {
  const { chrome, calls } = makeChrome();
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'create', url: 'chrome://settings' });
  assert.ok(r.isError);
  assert.equal(text(r), 'Error: Blocked URL: chrome://settings');
  assert.equal(calls.created.length, 0);
});

test('create：带 group 时归组并稳定着色', async () => {
  const { chrome, calls } = makeChrome();
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'create', group: 'agent-a' });
  assert.ok(!r.isError, text(r));
  assert.ok(text(r).includes('in group "agent-a"'));
  // 先 tabs.group 建组，再 tabGroups.update 设名字和颜色
  assert.equal(calls.grouped.length, 1);
  assert.ok(calls.grouped[0].createProperties || calls.grouped[0].groupId, '应带 createProperties 或 groupId');
  assert.equal(calls.groupUpdated.length, 1);
  assert.equal(calls.groupUpdated[0].title, 'agent-a');
  assert.ok(TAB_GROUP_COLORS.includes(calls.groupUpdated[0].color));
  assert.equal(calls.groupUpdated[0].color, groupColor('agent-a'), '颜色与 lib 的稳定哈希一致');
});

test('create：已有同名组时复用，不新建', async () => {
  const { chrome, calls, state } = makeChrome();
  state.tabGroups.push({ id: 50, windowId: 1, title: 'agent-a', color: 'blue' });
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'create', group: 'agent-a' });
  assert.ok(!r.isError, text(r));
  assert.equal(calls.grouped[0].groupId, 50, '应复用已有组');
  assert.equal(calls.groupUpdated.length, 0, '复用时不更新组');
});

test('create：非法组名报错且不创建标签页', async () => {
  const { chrome, calls } = makeChrome();
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'create', group: '   ' });
  assert.ok(r.isError);
  assert.ok(text(r).includes('Invalid group name'));
  assert.equal(calls.created.length, 0);
});

// ── close ──────────────────────────────────────────────────────────────────────

test('close：存在的关闭，不存在的列出但不报错', async () => {
  const { chrome } = makeChrome({ tabs: [{ id: 101, active: true, title: 'a', url: 'https://a.example.com', windowId: 1 }] });
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'close', tabIds: [101, 999] });
  assert.ok(!r.isError, text(r));
  assert.ok(text(r).includes('Closed 1 tab(s): [101]'));
  assert.ok(text(r).includes('Not found (skipped): [999]'));
});

test('close：缺 tabIds 报明确错误', async () => {
  const { chrome } = makeChrome();
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'close' });
  assert.ok(r.isError);
  assert.equal(text(r), 'Error: close requires tabIds');
});

// ── activate / reload / duplicate ──────────────────────────────────────────────

test('activate：更新 tab 与窗口焦点', async () => {
  const { chrome, calls } = makeChrome({ tabs: [{ id: 7, active: false, title: 'a', url: 'https://a.example.com', windowId: 3 }] });
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'activate', tabId: 7 });
  assert.ok(!r.isError);
  assert.deepEqual(calls.activated, [7, { windowId: 3, focused: true }]);
  assert.ok(text(r).includes('Activated tab [7]'));
});

test('activate：缺 tabId 报明确错误', async () => {
  const tool = createTabsTool({ ...makeChrome(), ...makeDeps() });
  const r = await tool({ action: 'activate' });
  assert.equal(text(r), 'Error: activate requires tabId');
});

test('reload：透传 bypassCache 并等待加载', async () => {
  const { chrome, calls } = makeChrome({ tabs: [{ id: 5, active: true, title: 'a', url: 'https://a.example.com', windowId: 1 }] });
  const reloaded = [];
  const tool = createTabsTool({ chrome, ...makeDeps({ waitForLoad: async id => { reloaded.push(id); return true; } }) });
  const r = await tool({ action: 'reload', tabId: 5, bypassCache: true });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(calls.reloaded, [{ id: 5, bypassCache: true }]);
  assert.deepEqual(reloaded, [5], 'reload 后应 waitForLoad');
  assert.ok(text(r).includes('Reloaded tab [5]'));
});

test('duplicate：返回新标签页 id 与加载等待', async () => {
  const { chrome } = makeChrome({ tabs: [{ id: 5, active: true, title: 'a', url: 'https://a.example.com', windowId: 1 }] });
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'duplicate', tabId: 5 });
  assert.ok(!r.isError, text(r));
  assert.ok(/Duplicated tab \[5\] → \[6\]/.test(text(r)));
});

test('duplicate：返回值为空时给明确错误', async () => {
  const { chrome } = makeChrome();
  chrome.tabs.duplicate = async () => undefined;
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'duplicate', tabId: 5 });
  assert.ok(r.isError);
  assert.ok(text(r).includes('Failed to duplicate tab [5]'));
});

// ── group ──────────────────────────────────────────────────────────────────────

test('group：同窗口新建组，颜色按名字稳定哈希', async () => {
  const { chrome, calls } = makeChrome({
    tabs: [
      { id: 101, active: false, title: 'a', url: 'https://a.example.com', windowId: 1 },
      { id: 102, active: false, title: 'b', url: 'https://b.example.com', windowId: 1 },
    ],
  });
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'group', tabIds: [101, 102], group: 'agent-a' });
  assert.ok(!r.isError, text(r));
  assert.ok(calls.grouped[0].createProperties, '新建组应带 createProperties.windowId');
  assert.equal(calls.groupUpdated[0].title, 'agent-a');
  assert.equal(calls.groupUpdated[0].color, groupColor('agent-a'));
  assert.ok(text(r).includes('Created group "agent-a"'));
});

test('group：已有同名组时加进去而不新建', async () => {
  const { chrome, calls, state } = makeChrome({
    tabs: [{ id: 101, active: false, title: 'a', url: 'https://a.example.com', windowId: 1 }],
  });
  state.tabGroups.push({ id: 50, windowId: 1, title: 'agent-a', color: 'blue' });
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'group', tabIds: [101], group: 'agent-a' });
  assert.ok(!r.isError, text(r));
  assert.equal(calls.grouped[0].groupId, 50);
  assert.equal(calls.groupUpdated.length, 0);
  assert.ok(text(r).includes('existing group "agent-a"'));
});

test('group：不传 group 则 ungroup', async () => {
  const { chrome, calls } = makeChrome({
    tabs: [{ id: 101, active: false, groupId: 50, title: 'a', url: 'https://a.example.com', windowId: 1 }],
    tabGroups: [{ id: 50, windowId: 1, title: 'agent-a', color: 'blue' }],
  });
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'group', tabIds: [101] });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(calls.ungrouped, [[101]]);
});

test('group：tabIds 不在同一窗口时报错', async () => {
  const { chrome, calls } = makeChrome({
    tabs: [
      { id: 101, active: false, title: 'a', url: 'https://a.example.com', windowId: 1 },
      { id: 102, active: false, title: 'b', url: 'https://b.example.com', windowId: 2 },
    ],
  });
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'group', tabIds: [101, 102], group: 'agent-a' });
  assert.ok(r.isError);
  assert.ok(text(r).includes('different windows'));
  assert.equal(calls.grouped.length, 0);
});

test('group：组名含 * 只精确匹配，不做模式匹配', async () => {
  const { chrome, calls } = makeChrome({
    tabs: [{ id: 101, active: false, title: 'a', url: 'https://a.example.com', windowId: 1 }],
    tabGroups: [{ id: 50, windowId: 1, title: 'agent-*', color: 'blue' }],
  });
  const tool = createTabsTool({ chrome, ...makeDeps() });
  // agent-xyz 不应被 agent-* 模式匹配到，应新建组
  const r = await tool({ action: 'group', tabIds: [101], group: 'agent-xyz' });
  assert.ok(!r.isError, text(r));
  assert.ok(calls.grouped[0].createProperties, '未命中 agent-*，应新建组');
  assert.ok(text(r).includes('Created group "agent-xyz"'));

  // 精确传 agent-* 时复用已有组
  const r2 = await tool({ action: 'group', tabIds: [101], group: 'agent-*' });
  assert.ok(!r2.isError, text(r2));
  const last = calls.grouped[calls.grouped.length - 1];
  assert.equal(last.groupId, 50, '精确匹配到 agent-* 组');
});

test('group：tabId 不存在时报错', async () => {
  const { chrome } = makeChrome();
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'group', tabIds: [999], group: 'x' });
  assert.ok(r.isError);
  assert.ok(text(r).includes('Tab not found: 999'));
});

test('group：缺 tabIds 报明确错误', async () => {
  const tool = createTabsTool({ ...makeChrome(), ...makeDeps() });
  const r = await tool({ action: 'group' });
  assert.equal(text(r), 'Error: group requires tabIds');
});

// ── 参数与未知 action ──────────────────────────────────────────────────────────

test('未知 action 报错', async () => {
  const tool = createTabsTool({ ...makeChrome(), ...makeDeps() });
  const r = await tool({ action: 'pin' });
  assert.ok(r.isError);
  assert.equal(text(r), 'Error: Unknown action: pin');
});

test('chrome 调用抛错时返回 err 而不是让异常逃逸', async () => {
  const { chrome } = makeChrome();
  chrome.tabs.query = async () => { throw new Error('query failed'); };
  const tool = createTabsTool({ chrome, ...makeDeps() });
  const r = await tool({ action: 'list' });
  assert.ok(r.isError);
  assert.equal(text(r), 'Error: query failed');
});
