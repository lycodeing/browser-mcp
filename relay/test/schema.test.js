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

test('工具清单恰好 23 个，旧工具已删除，新工具已就位', async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.equal(names.length, 23);
  for (const old of ['tabs_context', 'tabs_create', 'tabs_close', 'read_network_requests']) {
    assert.ok(!names.includes(old), `${old} 应被删除`);
  }
  assert.ok(names.includes('tabs'));
  assert.ok(names.includes('network'));
  assert.ok(names.includes('storage'));
  for (const name of ['intercept_add', 'intercept_list', 'intercept_remove']) {
    assert.ok(names.includes(name), `${name} 应存在`);
  }
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

test('tabs 的 tabIds 公布 anyOf，客户端预校验可放行字符串形式', async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const tabIds = tools.find((t) => t.name === 'tabs').inputSchema.properties.tabIds;
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
  await client.callTool({ name: 'tabs', arguments: { action: 'close', tabIds: [5] } });
  assert.deepEqual(received[0].arguments, { action: 'close', tabIds: [5] });
});

test('tabs 的 tabIds 字符串形式还原为数字数组', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  const res = await client.callTool({
    name: 'tabs', arguments: { action: 'close', tabIds: '[5]' },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.deepEqual(received[0].arguments, { action: 'close', tabIds: [5] });
});

test('network 的字符串数字与布尔还原为原生类型', async () => {
  setExtensionWs(fakeWs);
  received.length = 0;
  const client = await connectClient();
  await client.callTool({
    name: 'network',
    arguments: {
      action: 'list', tabId: '5', failedOnly: 'true', limit: '20', clear: 'false',
    },
  });
  assert.equal(received[0].tool, 'network');
  assert.equal(received[0].arguments.tabId, 5);
  assert.equal(received[0].arguments.failedOnly, true);
  assert.equal(received[0].arguments.limit, 20);
  assert.equal(received[0].arguments.clear, false);

  received.length = 0;
  await client.callTool({
    name: 'network',
    arguments: {
      action: 'detail', tabId: '5', seq: '7', bodyLimit: '3000', rawHeaders: 'true',
    },
  });
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
    name: 'tabs', arguments: { action: 'close', tabIds: ['abc'] },
  });
  assert.equal(res.isError, true);
});

test('emulate 新参数的字符串数字/布尔还原，旧参数仍可用', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  received.length = 0;
  await client.callTool({
    name: 'emulate',
    arguments: {
      tabId: '5', device: 'iphone-15', width: '500', height: '900', deviceScaleFactor: '2.5',
      mobile: 'true', latitude: '35.68', longitude: '139.76', accuracy: '50',
      timezone: 'Asia/Tokyo', locale: 'ja-JP',
    },
  });
  const a = received[0].arguments;
  assert.equal(received[0].tool, 'emulate');
  assert.equal(a.tabId, 5);
  assert.equal(a.width, 500);
  assert.equal(a.height, 900);
  assert.equal(a.deviceScaleFactor, 2.5);
  assert.equal(a.mobile, true);
  assert.equal(a.latitude, 35.68);
  assert.equal(a.longitude, 139.76);
  assert.equal(a.accuracy, 50);
  assert.equal(a.timezone, 'Asia/Tokyo');
  assert.equal(a.locale, 'ja-JP');

  received.length = 0;
  await client.callTool({ name: 'emulate', arguments: { tabId: 5, colorScheme: 'dark', cpuThrottlingRate: '4' } });
  assert.equal(received[0].arguments.colorScheme, 'dark');
  assert.equal(received[0].arguments.cpuThrottlingRate, 4);
});

test('emulate 新参数的范围与枚举约束', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  for (const bad of [
    { device: 'nokia' }, { width: 100 }, { height: 5000 }, { deviceScaleFactor: 9 },
    { latitude: 91, longitude: 0 }, { longitude: -181, latitude: 0 }, { accuracy: -1 },
  ]) {
    const res = await client.callTool({ name: 'emulate', arguments: { tabId: 1, ...bad } });
    assert.equal(res.isError, true, `应拒绝 ${JSON.stringify(bad)}`);
  }
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

test('tabId 传 UUID 时校验错误附 tabs list 指引', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  const res = await client.callTool({
    name: 'computer', arguments: { action: 'screenshot', tabId: 'bc494367-83d3-495f' },
  });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /numeric Chrome tab id/);
  // 文本经 JSON 转义，引号形如 \"list\"，不做精确引号匹配
  assert.match(text, /tabs \(action/);
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

test('所有带必填 tabId 的工具公布 tabId 指引描述', async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  // tabs 的 tabId 是可选参数（仅 activate/reload/duplicate 用），描述另论
  const withTabId = tools.filter((t) => t.name !== 'tabs' && t.inputSchema.properties?.tabId);
  assert.ok(withTabId.length >= 19, `应有 ≥19 个带必填 tabId 的工具，实际 ${withTabId.length}`);
  for (const t of withTabId) {
    // 校验 description 字段本身（JSON.stringify 会把引号转义，不能对整体字符串 includes）
    const desc = t.inputSchema.properties.tabId.description || '';
    assert.ok(
      desc.includes('tabs (action: "list")'),
      `${t.name} 的 tabId 描述应包含 tabs list 指引: ${desc.slice(0, 120)}`,
    );
  }
});
