import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp-server.js';
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
  await client.callTool({ name: 'tabs_close', arguments: { tabId: 5 } });
  assert.deepEqual(received[0].arguments, { tabId: 5 });
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
  const res = await client.callTool({ name: 'tabs_close', arguments: { tabId: 'abc' } });
  assert.equal(res.isError, true);
});
