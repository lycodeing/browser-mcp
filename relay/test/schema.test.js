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

test('工具清单恰好 19 个，旧工具已删除，新工具已就位', async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.equal(names.length, 19);
  for (const old of ['tabs_context', 'tabs_create', 'tabs_close', 'read_network_requests']) {
    assert.ok(!names.includes(old), `${old} 应被删除`);
  }
  assert.ok(names.includes('tabs'));
  assert.ok(names.includes('network'));
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
