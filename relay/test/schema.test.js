import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp-server.js';
import { lenientNumberArray } from '../src/schema-helpers.js';
import { setExtensionWs, handleExtensionMessage } from '../src/bridge.js';

// 假扩展：记录 relay 下发的 tools/invoke，并立即回一个文本结果
const received = [];
const fakeWs = {
  readyState: 1,
  send(data) {
    const msg = JSON.parse(data);
    received.push(msg.params);
    queueMicrotask(() => handleExtensionMessage(JSON.stringify({
      id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] },
    })));
  },
};

async function connectClient() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(st);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
  return client;
}

test('公布的 schema 对数字/布尔/数组同时放行字符串形式', async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const computer = tools.find((t) => t.name === 'computer').inputSchema.properties;
  for (const key of ['tabId', 'maxDimension', 'coordinate', 'fullPage']) {
    assert.ok(computer[key].anyOf, `${key} 应为 anyOf: ${JSON.stringify(computer[key])}`);
    assert.ok(computer[key].anyOf.some((s) => s.type === 'string'), `${key} 缺少 string 分支`);
  }
});

test('工具清单恰好 37 个，旧工具已删除，新工具已就位', async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.equal(names.length, 37);
  for (const old of ['tabs_context', 'tabs_create', 'tabs_close', 'read_network_requests', 'tabs', 'network', 'emulate']) {
    assert.ok(!names.includes(old), `${old} 应被删除`);
  }
  for (const name of [
    'network_list', 'network_detail',
    'tabs_list', 'tab_create', 'tab_close', 'tab_activate',
    'tab_reload', 'tab_duplicate', 'tab_group',
    'screenshot', 'click', 'sleep',
    'state',
    'form_input_multi',
    'emulate_device', 'emulate_network', 'emulate_geo',
    'storage',
  ]) {
    assert.ok(names.includes(name), `${name} 应存在`);
  }
  for (const name of ['intercept_add', 'intercept_list', 'intercept_remove']) {
    assert.ok(names.includes(name), `${name} 应存在`);
  }
});

test('state 工具无必填参数且 description 指向快照语义', async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const state = tools.find((t) => t.name === 'state');
  assert.ok(state, 'state 工具应存在');
  assert.equal(Object.keys(state.inputSchema.properties || {}).length, 0);
  assert.match(state.description, /snapshot/i);
  assert.match(state.description, /tabs_list/);
});

test('intercept_add 的数字参数放行字符串形式并还原为原生类型', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  await client.callTool({
    name: 'intercept_add',
    arguments: { tabId: '7', urlPattern: '*/api/*', action: 'fulfill', status: '201', body: '{}' },
  });
  assert.equal(received[0].tool, 'intercept_add');
  assert.equal(received[0].arguments.tabId, 7);
  assert.equal(received[0].arguments.status, 201);

  received.length = 0;
  await client.callTool({
    name: 'intercept_add',
    arguments: { tabId: 7, urlPattern: '*', action: 'delay', delayMs: '1500' },
  });
  assert.equal(received[0].arguments.delayMs, 1500);
});

test('intercept_add 拒绝越界的 delayMs 和未知 errorReason', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  const tooLong = await client.callTool({
    name: 'intercept_add', arguments: { tabId: 7, urlPattern: '*', action: 'delay', delayMs: 60001 },
  });
  assert.equal(tooLong.isError, true);
  const badReason = await client.callTool({
    name: 'intercept_add', arguments: { tabId: 7, urlPattern: '*', action: 'fail', errorReason: 'Nope' },
  });
  assert.equal(badReason.isError, true);
});

test('tab_close 的 tabIds 公布 anyOf，客户端预校验可放行字符串形式', async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const tabIds = tools.find((t) => t.name === 'tab_close').inputSchema.properties.tabIds;
  assert.ok(tabIds.anyOf, `tabIds 应为 anyOf: ${JSON.stringify(tabIds)}`);
  assert.ok(tabIds.anyOf.some((s) => s.type === 'string'), 'tabIds 缺少 string 分支');
});

test('lenientNumberArray 接受字符串数组、JSON 字符串与原生数组', () => {
  const schema = lenientNumberArray();
  assert.deepEqual(schema.parse([5, 6]), [5, 6]);
  assert.deepEqual(schema.parse(['5', '6']), [5, 6]);
  assert.deepEqual(schema.parse('[5, 6]'), [5, 6]);
  assert.deepEqual(schema.parse('["5", "6"]'), [5, 6]);
});

test('lenientNumberArray 拒绝空数组、超 50 个、非整数与非数字', () => {
  const schema = lenientNumberArray();
  for (const bad of [[], '[]', Array.from({ length: 51 }, (_, i) => i), [1.5], '[1.5]', ['abc'], '["abc"]', 'not json', [true]]) {
    assert.equal(schema.safeParse(bad).success, false, `${JSON.stringify(bad)} 应被拒绝`);
  }
  // 恰好 50 个是合法上限
  assert.equal(schema.safeParse(Array.from({ length: 50 }, (_, i) => i)).success, true);
});

test('字符串参数被还原为原生类型后再下发给扩展', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  const res = await client.callTool({
    name: 'computer',
    arguments: {
      action: 'left_click', tabId: '1924548676', coordinate: '[601, 385]',
      maxDimension: '900', fullPage: 'false',
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.deepEqual(received[0].arguments, {
    action: 'left_click', tabId: 1924548676, coordinate: [601, 385],
    maxDimension: 900, fullPage: false,
  });
});

test('原生类型参数保持不变', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  await client.callTool({ name: 'tab_close', arguments: { tabIds: [5] } });
  assert.deepEqual(received[0].arguments, { tabIds: [5] });
});

test('tab_close 的 tabIds 字符串形式还原为数字数组', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  const res = await client.callTool({
    name: 'tab_close', arguments: { tabIds: '[5]' },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.deepEqual(received[0].arguments, { tabIds: [5] });
});

test('network_list/network_detail 的字符串数字与布尔还原为原生类型', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  await client.callTool({
    name: 'network_list',
    arguments: {
      tabId: '5', failedOnly: 'true', limit: '20', clear: 'false',
    },
  });
  assert.equal(received[0].tool, 'network_list');
  assert.equal(received[0].arguments.tabId, 5);
  assert.equal(received[0].arguments.failedOnly, true);
  assert.equal(received[0].arguments.limit, 20);
  assert.equal(received[0].arguments.clear, false);

  received.length = 0;
  await client.callTool({
    name: 'network_detail',
    arguments: {
      tabId: '5', seq: '7', bodyLimit: '3000', rawHeaders: 'true',
    },
  });
  assert.equal(received[0].tool, 'network_detail');
  assert.equal(received[0].arguments.seq, 7);
  assert.equal(received[0].arguments.bodyLimit, 3000);
  assert.equal(received[0].arguments.rawHeaders, true);
});

test('原有范围约束在转换后仍然生效', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  const res = await client.callTool({
    name: 'computer', arguments: { action: 'screenshot', tabId: 1, maxDimension: '100' },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /validation/i);
});

test('非法字符串被拒绝', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  const res = await client.callTool({
    name: 'tab_close', arguments: { tabIds: ['abc'] },
  });
  assert.equal(res.isError, true);
});

test('emulate_device 的字符串数字/布尔还原为原生类型', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  received.length = 0;
  await client.callTool({
    name: 'emulate_device',
    arguments: {
      tabId: '5', device: 'iphone-15', width: '500', height: '900',
      deviceScaleFactor: '2.5', mobile: 'true', reset: 'false',
    },
  });
  const a = received[0].arguments;
  assert.equal(received[0].tool, 'emulate_device');
  assert.equal(a.tabId, 5);
  assert.equal(a.width, 500);
  assert.equal(a.height, 900);
  assert.equal(a.deviceScaleFactor, 2.5);
  assert.equal(a.mobile, true);
  assert.equal(a.reset, false);

  received.length = 0;
  await client.callTool({
    name: 'emulate_device',
    arguments: { tabId: 5, userAgent: 'Custom/1.0' },
  });
  assert.equal(received[0].arguments.userAgent, 'Custom/1.0');
});

test('emulate_network 与 emulate_geo 的字符串数字还原为原生类型', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  received.length = 0;
  await client.callTool({
    name: 'emulate_network',
    arguments: { tabId: '5', cpuThrottlingRate: '4', networkConditions: 'Slow 3G' },
  });
  assert.equal(received[0].tool, 'emulate_network');
  assert.equal(received[0].arguments.tabId, 5);
  assert.equal(received[0].arguments.cpuThrottlingRate, 4);
  assert.equal(received[0].arguments.networkConditions, 'Slow 3G');

  received.length = 0;
  await client.callTool({
    name: 'emulate_geo',
    arguments: { tabId: '5', latitude: '35.68', longitude: '139.76', accuracy: '50' },
  });
  const g = received[0].arguments;
  assert.equal(received[0].tool, 'emulate_geo');
  assert.equal(g.tabId, 5);
  assert.equal(g.latitude, 35.68);
  assert.equal(g.longitude, 139.76);
  assert.equal(g.accuracy, 50);
});

test('emulate 族的范围与枚举约束', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  for (const bad of [
    ['emulate_device', { device: 'nokia' }],
    ['emulate_device', { width: 100 }],
    ['emulate_device', { height: 5000 }],
    ['emulate_device', { deviceScaleFactor: 9 }],
    ['emulate_geo', { latitude: 91, longitude: 0 }],
    ['emulate_geo', { longitude: -181, latitude: 0 }],
    ['emulate_geo', { accuracy: -1 }],
  ]) {
    const res = await client.callTool({ name: bad[0], arguments: { tabId: 1, ...bad[1] } });
    assert.equal(res.isError, true, `应拒绝 ${bad[0]} ${JSON.stringify(bad[1])}`);
  }
});

test('form_input_multi 透传字段数组并限制数量', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  received.length = 0;
  await client.callTool({
    name: 'form_input_multi',
    arguments: {
      tabId: '5',
      fields: [
        { ref: 'ref_1', value: 'alice' },
        { ref: 'ref_2', value: 'true' },
        { ref: 'f3.ref_4', value: '42' },
      ],
    },
  });
  assert.equal(received[0].tool, 'form_input_multi');
  assert.equal(received[0].arguments.tabId, 5);
  assert.deepEqual(received[0].arguments.fields, [
    { ref: 'ref_1', value: 'alice' },
    { ref: 'ref_2', value: 'true' },
    { ref: 'f3.ref_4', value: '42' },
  ]);

  // 超过 20 个字段被拒绝
  const tooMany = await client.callTool({
    name: 'form_input_multi',
    arguments: { tabId: 5, fields: Array.from({ length: 21 }, (_, i) => ({ ref: `ref_${i}`, value: 'x' })) },
  });
  assert.equal(tooMany.isError, true);
  // 空数组被拒绝
  const empty = await client.callTool({
    name: 'form_input_multi',
    arguments: { tabId: 5, fields: [] },
  });
  assert.equal(empty.isError, true);
});

test('storage 的数字参数接受字符串形式并转换后下发', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  await client.callTool({
    name: 'storage',
    arguments: { action: 'get', tabId: '7', key: 'token', maxChars: '500' },
  });
  assert.equal(received[0].tool, 'storage');
  assert.equal(received[0].arguments.tabId, 7);
  assert.equal(received[0].arguments.maxChars, 500);
});

test('storage 的 maxChars 超出范围被拒绝', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  const res = await client.callTool({
    name: 'storage', arguments: { action: 'get', tabId: 1, key: 'k', maxChars: '50' },
  });
  assert.equal(res.isError, true);
});

// ── C 批：frameId / allFrames / bodyBase64 ────────────────────────────────────

test('get_page_text 的 frameId 与 allFrames 字段存在且字符串数字可还原', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  await client.callTool({
    name: 'get_page_text',
    arguments: { tabId: '5', frameId: '3' },
  });
  assert.equal(received[0].tool, 'get_page_text');
  assert.equal(received[0].arguments.frameId, 3);

  received.length = 0;
  await client.callTool({
    name: 'get_page_text',
    arguments: { tabId: 5, allFrames: 'true' },
  });
  assert.equal(received[0].arguments.allFrames, true);
});

test('javascript_tool 的 frameId 字段存在且字符串数字可还原', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  await client.callTool({
    name: 'javascript_tool',
    arguments: { tabId: '5', frameId: '9', text: 'location.href' },
  });
  assert.equal(received[0].tool, 'javascript_tool');
  assert.equal(received[0].arguments.frameId, 9);
  assert.equal(received[0].arguments.text, 'location.href');
});

test('get_page_text 拒绝非数字 frameId（isError 回复）', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  const res = await client.callTool({
    name: 'get_page_text', arguments: { tabId: 5, frameId: 'abc' },
  });
  assert.equal(res.isError, true);
});

test('intercept_add 的 bodyBase64 透传给扩展', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ';
  await client.callTool({
    name: 'intercept_add',
    arguments: { tabId: 7, urlPattern: '*/i.png', action: 'fulfill', headers: { 'content-type': 'image/png' }, bodyBase64: b64 },
  });
  assert.equal(received[0].tool, 'intercept_add');
  assert.equal(received[0].arguments.bodyBase64, b64);
});

// ── 错误消息自纠错：三类高频调用错误必须带可执行的指引 ────────────────────────

test('tabId 传 UUID 时校验错误附 tabs_list 指引', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  const res = await client.callTool({
    name: 'computer', arguments: { action: 'screenshot', tabId: 'bc494367-83d3-495f' },
  });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /numeric Chrome tab id/);
  assert.match(text, /tabs_list/);
  assert.match(text, /tabId/);
});

test('computer 传入其它工具的 action 时错误附正确替代工具', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  for (const [action, hint] of [
    ['find', /find tool with \{query\}/],
    ['navigate', /navigate tool with \{url\}/],
    ['wait_for', /wait_for tool/],
    ['get_page_text', /get_page_text tool/],
    ['read_page', /read_page tool/],
  ]) {
    const res = await client.callTool({
      name: 'computer', arguments: { action, tabId: 1 },
    });
    assert.equal(res.isError, true, `${action} 应被拒绝`);
    const text = res.content[0].text;
    assert.match(text, new RegExp(`computer does not support action.{0,3}${action}`));
    assert.match(text, hint);
  }
});

test('computer 支持的动作不受 errorMap 影响', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  const res = await client.callTool({
    name: 'computer', arguments: { action: 'wait', tabId: '5', duration: '1' },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.equal(received[0].arguments.action, 'wait');
  assert.equal(received[0].arguments.tabId, 5);
});

// ── D 批：computer 拆出的 screenshot / click / sleep 顶层工具 ────────────────

test('screenshot 的字符串参数还原为原生类型后下发', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  const res = await client.callTool({
    name: 'screenshot',
    arguments: { tabId: '7', maxDimension: '900', fullPage: 'false', quality: '80' },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.equal(received[0].tool, 'screenshot');
  assert.equal(received[0].arguments.tabId, 7);
  assert.equal(received[0].arguments.maxDimension, 900);
  assert.equal(received[0].arguments.fullPage, false);
  assert.equal(received[0].arguments.quality, 80);
});

test('screenshot 越界 maxDimension 被拒绝', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  const res = await client.callTool({
    name: 'screenshot', arguments: { tabId: 1, maxDimension: 100 },
  });
  assert.equal(res.isError, true);
});

test('click 的 ref 优先路径与默认值下发', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  const res = await client.callTool({
    name: 'click', arguments: { tabId: '7', ref: 'ref_12' },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.equal(received[0].tool, 'click');
  // 未传的 button/double/triple 由 schema default 填充
  assert.deepEqual(received[0].arguments, { tabId: 7, ref: 'ref_12', button: 'left', double: false, triple: false });
});

test('click 的字符串 coordinate 与 double=true 还原为原生类型', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  const res = await client.callTool({
    name: 'click',
    arguments: { tabId: 7, coordinate: '[601, 385]', double: 'true', button: 'right' },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.deepEqual(received[0].arguments, { tabId: 7, coordinate: [601, 385], double: true, triple: false, button: 'right' });
});

test('click 缺 ref 与 coordinate 时被拒绝', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  const res = await client.callTool({ name: 'click', arguments: { tabId: 1 } });
  assert.equal(res.isError, true);
});

test('sleep 的字符串秒数还原为原生类型，越界被拒绝', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  const res = await client.callTool({ name: 'sleep', arguments: { tabId: '7', seconds: '2' } });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.equal(received[0].tool, 'sleep');
  assert.deepEqual(received[0].arguments, { tabId: 7, seconds: 2 });

  const bad = await client.callTool({ name: 'sleep', arguments: { tabId: 7, seconds: 11 } });
  assert.equal(bad.isError, true);
});

test('computer 的新拆分工具名传入 action 时给出正确指引', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  for (const [action, hint] of [
    ['click', /click tool/],
    ['sleep', /sleep tool/],
  ]) {
    const res = await client.callTool({
      name: 'computer', arguments: { action, tabId: 1 },
    });
    assert.equal(res.isError, true, `${action} 应被拒绝`);
    const text = res.content[0].text;
    assert.match(text, new RegExp(`computer does not support action.{0,3}${action}`));
    assert.match(text, hint);
  }
});

test('所有带必填 tabId 的工具公布 tabId 指引描述', async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const withTabId = tools.filter((t) => t.inputSchema.properties?.tabId);
  // network_list/network_detail 与 7 个 tab 工具里 3 个带 tabId 的都算上
  assert.ok(withTabId.length >= 19, `应有 ≥19 个带必填 tabId 的工具，实际 ${withTabId.length}`);
  for (const t of withTabId) {
    // 校验 description 字段本身（JSON.stringify 会把引号转义，不能对整体字符串 includes）
    const desc = t.inputSchema.properties.tabId.description || '';
    assert.ok(
      desc.includes('tabs_list'),
      `${t.name} 的 tabId 描述应包含 tabs_list 指引: ${desc.slice(0, 120)}`,
    );
  }
});
