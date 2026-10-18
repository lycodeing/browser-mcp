import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp-server.js';
import { setExtensionWs, handleExtensionMessage } from '../src/bridge.js';

// 假扩展：回放调用时预置的 content，用于模拟 x-file / image 内容项
let replyContent = null;
const fakeWs = {
  readyState: 1,
  send(data) {
    const msg = JSON.parse(data);
    queueMicrotask(() => handleExtensionMessage(JSON.stringify({
      id: msg.id,
      result: { content: replyContent ?? [{ type: 'text', text: 'ok' }] },
    })));
  },
};

async function callNetwork(args) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(st);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
  setExtensionWs(fakeWs);
  return client.callTool({ name: 'network_detail', arguments: args });
}

// screenshot 的 image 通道：验证 saveTo + returnImage 的默认丢图行为
async function callScreenshot(args) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(st);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
  setExtensionWs(fakeWs);
  return client.callTool({ name: 'screenshot', arguments: args });
}

// 1x1 png，够小不会触发 spillLargeImages 的内联上限
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGMAAgAABQABDQottAAAAABJRU5ErkJggg==';

// 每个 case 用独立的临时目录，测完清理
const bodyText = 'hello response body';
const bodyBase64 = Buffer.from(bodyText).toString('base64');

test('带 saveTo 的 x-file 落盘并替换为路径文本', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bmcp-xfile-'));
  try {
    replyContent = [
      { type: 'text', text: '#7 GET https://example.com/x → 200' },
      { type: 'x-file', data: bodyBase64 },
    ];
    const res = await callNetwork({ tabId: 1, seq: 7, saveTo: path.join(dir, 'body.txt') });
    assert.notEqual(res.isError, true, JSON.stringify(res));
    assert.equal(res.content.some((c) => c.type === 'x-file'), false);
    const saved = res.content.find((c) => c.type === 'text' && c.text.includes('Saved to'));
    assert.ok(saved, `应有 Saved to 文本: ${JSON.stringify(res.content)}`);
    assert.match(saved.text, /Saved to .+body\.txt \(\d+ B\)/);
    // 写盘内容与原文一致（扩展侧已做 UTF-8 → base64）
    assert.equal(await fsp.readFile(path.join(dir, 'body.txt'), 'utf8'), bodyText);
  } finally {
    replyContent = null;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('不带 saveTo 时残留的 x-file 被剔除，不泄漏给客户端', async () => {
  replyContent = [
    { type: 'text', text: '#7 GET https://example.com/x → 200' },
    { type: 'x-file', data: bodyBase64 },
  ];
  const res = await callNetwork({ tabId: 1, seq: 7 });
  replyContent = null;
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.deepEqual(
    res.content.map((c) => c.type),
    ['text'],
  );
  assert.equal(JSON.stringify(res).includes(bodyBase64), false, 'base64 不应出现在回复里');
});

test('saveTo 为相对路径时返回错误且不泄漏 x-file', async () => {
  replyContent = [
    { type: 'text', text: 'detail' },
    { type: 'x-file', data: bodyBase64 },
  ];
  const res = await callNetwork({ tabId: 1, seq: 7, saveTo: 'relative/body.txt' });
  replyContent = null;
  assert.equal(res.isError, true);
  assert.equal(res.content.some((c) => c.type === 'x-file'), false);
  assert.equal(JSON.stringify(res).includes(bodyBase64), false, 'base64 不应出现在回复里');
  const errText = res.content.map((c) => c.text).join('\n');
  assert.match(errText, /failed to save to relative\/body\.txt/);
  assert.match(errText, /absolute path/i);
});

test('写盘失败（saveTo 指向目录内的不可写路径）返回 isError 并剔除 x-file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bmcp-xfile-'));
  try {
    // 把目录设为只读，saveTo 指向其内部必然写失败
    await fsp.chmod(dir, 0o500);
    replyContent = [
      { type: 'x-file', data: bodyBase64 },
    ];
    const res = await callNetwork({ tabId: 1, seq: 7, saveTo: path.join(dir, 'out.txt') });
    replyContent = null;
    assert.equal(res.isError, true);
    assert.equal(res.content.some((c) => c.type === 'x-file'), false);
    assert.equal(JSON.stringify(res).includes(bodyBase64), false, 'base64 不应出现在回复里');
    assert.match(res.content.map((c) => c.text).join('\n'), /failed to save/);
  } finally {
    replyContent = null;
    await fsp.chmod(dir, 0o700);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── saveTo + returnImage：image 内容项的默认丢图行为 ──────────────────────────

test('saveTo 存在且未显式 returnImage 时默认丢弃 image', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bmcp-saveimg-'));
  try {
    replyContent = [
      { type: 'text', text: 'Screenshot 1x1' },
      { type: 'image', data: tinyPng, mimeType: 'image/png' },
    ];
    const res = await callScreenshot({ tabId: 1, saveTo: path.join(dir, 'shot.png') });
    replyContent = null;
    assert.notEqual(res.isError, true, JSON.stringify(res));
    assert.equal(res.content.some((c) => c.type === 'image'), false, '默认应丢弃 image');
    assert.match(res.content.map((c) => c.text).join('\n'), /Saved to .+shot\.png/);
    // 落盘内容与原 base64 解码一致
    assert.equal((await fsp.readFile(path.join(dir, 'shot.png'))).toString('base64'), tinyPng);
  } finally {
    replyContent = null;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('saveTo + returnImage:true 显式保留 image', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bmcp-saveimg-'));
  try {
    replyContent = [
      { type: 'text', text: 'Screenshot 1x1' },
      { type: 'image', data: tinyPng, mimeType: 'image/png' },
    ];
    const res = await callScreenshot({ tabId: 1, saveTo: path.join(dir, 'shot.png'), returnImage: true });
    replyContent = null;
    assert.notEqual(res.isError, true, JSON.stringify(res));
    const img = res.content.find((c) => c.type === 'image');
    assert.ok(img, '显式 returnImage:true 应保留 image');
    assert.equal(img.data, tinyPng);
    assert.match(res.content.map((c) => c.text).join('\n'), /Saved to .+shot\.png/);
  } finally {
    replyContent = null;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('不带 saveTo 时 image 照常返回（不受默认丢图影响）', async () => {
  replyContent = [
    { type: 'text', text: 'Screenshot 1x1' },
    { type: 'image', data: tinyPng, mimeType: 'image/png' },
  ];
  const res = await callScreenshot({ tabId: 1 });
  replyContent = null;
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.equal(res.content.some((c) => c.type === 'image'), true, '无 saveTo 不应丢图');
});
