import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, TOOL_TIMEOUTS, BASE_TIMEOUTS_EXPORT, QUEUED_TOOLS_EXPORT } from '../src/mcp-server.js';
import { setExtensionWs, handleExtensionMessage } from '../src/bridge.js';
import * as flowsStore from '../src/flows-store.js';
import { composeGif, frameDelay } from '../src/gif-composer.js';
import { Jimp } from 'jimp';

// ─── 公共夹具 ────────────────────────────────────────────────────────────────

// 假扩展：记录 relay 下发的消息，并按配置回响应。
// 响应协议与真实扩展一致：{ id, result: { content, ... } }。
const sentMessages = [];
let fakeResponder = (msg) => ({ content: [{ type: 'text', text: 'ok' }] });

const fakeWs = {
  readyState: 1,
  send(data) {
    const msg = JSON.parse(data);
    sentMessages.push(msg);
    if (typeof msg.id !== 'number') return;
    queueMicrotask(() => {
      const payload = fakeResponder(msg) ?? {};
      handleExtensionMessage(JSON.stringify({ id: msg.id, result: payload }));
    });
  },
};

async function connectClient() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(st);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
  return client;
}

// 每个用例独立的 flows 目录，避免污染真实的 ~/.browser-mcp/flows
let tmpDir;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bmcp-flows-'));
  flowsStore.setFlowsDir(tmpDir);
  fakeResponder = () => ({ content: [{ type: 'text', text: 'ok' }] });
  sentMessages.length = 0;
});

// ─── 1. 工具注册与 schema ────────────────────────────────────────────────────

const RECORD_TOOLS = [
  'record_start', 'record_stop', 'record_list', 'record_run',
  'record_delete', 'record_export_gif', 'record_export_json',
];

test('7 个 record_* 工具注册成功且 schema 正确', async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();

  for (const name of RECORD_TOOLS) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} 应注册`);
    assert.ok(tool.description, `${name} 应有 description`);
  }

  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.ok(byName.record_start.inputSchema.properties.captureGif, 'record_start 应有 captureGif');
  assert.ok(byName.record_start.inputSchema.properties.tabId, 'record_start 应有 tabId');
  assert.ok(byName.record_stop.inputSchema.properties.name, 'record_stop 应有 name');
  assert.equal(Object.keys(byName.record_list.inputSchema.properties || {}).length, 0, 'record_list 无参数');
  assert.ok(byName.record_run.inputSchema.properties.name, 'record_run 应有 name');
  assert.ok(byName.record_run.inputSchema.properties.strict, 'record_run 应有 strict');
  assert.ok(byName.record_run.inputSchema.properties.stepDelayMs, 'record_run 应有 stepDelayMs');
  assert.ok(byName.record_delete.inputSchema.properties.name, 'record_delete 应有 name');
  assert.ok(byName.record_export_gif.inputSchema.properties.saveTo, 'record_export_gif 应有 saveTo');
  assert.ok(byName.record_export_json.inputSchema.properties.saveTo, 'record_export_json 应有 saveTo');
});

test('record_start 的 captureGif 缺省为 true，字符串形式也放行', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  const res = await client.callTool({ name: 'record_start', arguments: { tabId: 7 } });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.equal(sentMessages[0].params.captureGif, true);

  // 宽松布尔：字符串 "false" 还原为 false
  await client.callTool({ name: 'record_start', arguments: { tabId: 7, captureGif: 'false' } });
  assert.equal(sentMessages[1].params.captureGif, false);
});

test('record_run 的默认参数 strict:true / stepDelayMs:300 到达扩展', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();
  const res = await client.callTool({ name: 'record_run', arguments: { tabId: 7, name: '登录流程' } });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  const args = sentMessages[0].params;
  assert.equal(args.strict, true);
  assert.equal(args.stepDelayMs, 300);
});

// ─── 2. 超时表 ──────────────────────────────────────────────────────────────

test('BASE_TIMEOUTS 覆盖全部 record_* 工具且数值正确', () => {
  const expected = {
    record_start: 10000, record_stop: 30000, record_list: 5000,
    record_run: 300000, record_delete: 5000,
    record_export_gif: 10000, record_export_json: 5000,
  };
  for (const [name, ms] of Object.entries(expected)) {
    assert.equal(BASE_TIMEOUTS_EXPORT[name], ms, `${name} 基础超时应为 ${ms}`);
  }
  // 最终生效超时 = 基础值（非排队）或 基础值 + 30000（排队）
  assert.equal(TOOL_TIMEOUTS.record_start, 40000);
  assert.equal(TOOL_TIMEOUTS.record_stop, 60000);
  assert.equal(TOOL_TIMEOUTS.record_run, 330000);
  assert.equal(TOOL_TIMEOUTS.record_list, 5000);
  assert.equal(TOOL_TIMEOUTS.record_delete, 5000);
  assert.equal(TOOL_TIMEOUTS.record_export_gif, 10000);
  assert.equal(TOOL_TIMEOUTS.record_export_json, 5000);
});

test('record_start/record_stop/record_run 进扩展串行队列', () => {
  assert.ok(QUEUED_TOOLS_EXPORT.has('record_start'));
  assert.ok(QUEUED_TOOLS_EXPORT.has('record_stop'));
  assert.ok(QUEUED_TOOLS_EXPORT.has('record_run'));
  assert.ok(!QUEUED_TOOLS_EXPORT.has('record_list'));
  assert.ok(!QUEUED_TOOLS_EXPORT.has('record_delete'));
});

// ─── 3. flows-store CRUD ─────────────────────────────────────────────────────

const mkFlowJson = (steps) => ({
  version: 1,
  recordedAt: Date.parse('2026-10-19T10:00:00Z'),
  steps,
});

test('flows-store: saveFlow 落盘 JSON 与 GIF，listFlows 汇总，loadFlow 读回，deleteFlow 删除', async () => {
  const gif = Buffer.from('GIF89a-fake');
  const { name } = await flowsStore.saveFlow('登录流程', mkFlowJson([
    { type: 'navigate', url: 'https://example.com' },
    { type: 'click', ref: 'ref_1' },
    { type: 'input', ref: 'ref_2', value: 'hi' },
  ]), gif);

  assert.equal(name, '登录流程');

  // 文件确实存在
  const jsonFile = path.join(tmpDir, '登录流程.json');
  const gifFile = path.join(tmpDir, '登录流程.gif');
  await fsp.access(jsonFile);
  await fsp.access(gifFile);

  // listFlows
  const flows = await flowsStore.listFlows();
  assert.equal(flows.length, 1);
  assert.equal(flows[0].name, '登录流程');
  assert.equal(flows[0].steps, 3);
  assert.equal(flows[0].gifSize, gif.length);
  assert.equal(flows[0].recordedAt, mkFlowJson([]).recordedAt);

  // loadFlow
  const loaded = await flowsStore.loadFlow('登录流程');
  assert.equal(loaded.steps.length, 3);
  assert.equal(loaded.steps[0].type, 'navigate');

  // deleteFlow
  await flowsStore.deleteFlow('登录流程');
  assert.deepEqual(await flowsStore.listFlows(), []);
  await assert.rejects(() => flowsStore.loadFlow('登录流程'));
});

test('flows-store: 无 GIF 时只写 JSON，listFlows 的 gifSize 为 0', async () => {
  await flowsStore.saveFlow('纯文本流程', mkFlowJson([{ type: 'navigate' }]), null);
  const flows = await flowsStore.listFlows();
  assert.equal(flows[0].gifSize, 0);
  await fsp.access(path.join(tmpDir, '纯文本流程.json'));
});

test('flows-store: name 中的非法字符替换为 _，防路径逃逸', async () => {
  const { name } = await flowsStore.saveFlow('../evil/name 1', mkFlowJson([]), null);
  assert.equal(name, 'evil_name_1');
  // 落盘在 tmpDir 内，没有逃逸到上级目录
  const files = await fsp.readdir(tmpDir);
  assert.ok(files.every((f) => !f.includes('/')), `不应有路径分隔符: ${files}`);
  assert.ok(files.includes('evil_name_1.json'));
});

test('flows-store: exportFlow 复制 JSON 与 GIF 到目标目录', async () => {
  const gif = Buffer.from('GIF89a');
  await flowsStore.saveFlow('导出流程', mkFlowJson([{ type: 'click' }]), gif);

  const dest = path.join(tmpDir, 'exported');
  const res = await flowsStore.exportFlow('导出流程', dest);
  assert.equal(res.name, '导出流程');
  assert.equal(res.exported.length, 2);
  const copied = await fsp.readFile(path.join(dest, '导出流程.gif'));
  assert.deepEqual(copied, gif);

  // format 'json' 只导 JSON
  const dest2 = path.join(tmpDir, 'exported-json-only');
  const res2 = await flowsStore.exportFlow('导出流程', dest2, 'json');
  assert.equal(res2.exported.length, 1);
  assert.ok(res2.exported[0].endsWith('.json'));

  // 相对路径拒绝
  await assert.rejects(() => flowsStore.exportFlow('导出流程', 'relative/dir'));
});

// ─── 4. gif-composer ─────────────────────────────────────────────────────────

async function mkFrameDataUrl(r, g, b, width = 30, height = 20) {
  const img = new Jimp({ width, height, color: { r, g, b, alpha: 255 } });
  const buf = await img.getBuffer('image/png');
  return 'data:image/png;base64,' + buf.toString('base64');
}

test('gif-composer: composeGif 能编码最小 2 帧 GIF 并写入磁盘', async () => {
  const t0 = Date.now();
  const frames = [
    { dataUrl: await mkFrameDataUrl(255, 0, 0), capturedAt: t0 },
    { dataUrl: await mkFrameDataUrl(0, 0, 255), capturedAt: t0 + 500 },
  ];
  const outPath = path.join(tmpDir, 'compose-test.gif');
  const size = await composeGif(frames, outPath);

  assert.ok(size > 0, '返回的文件大小应为正数');
  const written = await fsp.readFile(outPath);
  assert.equal(written.length, size);
  // GIF 魔数
  assert.equal(written.subarray(0, 3).toString('ascii'), 'GIF');
  assert.ok(written.length >= 6);
});

test('gif-composer: frameDelay 边界行为', () => {
  const t = 1_000_000;
  // 正常间隔 700ms 原样保留
  assert.equal(frameDelay({ capturedAt: t }, { capturedAt: t + 700 }), 700);
  // 过短间隔钳到 200
  assert.equal(frameDelay({ capturedAt: t }, { capturedAt: t + 50 }), 200);
  // 过长间隔钳到 1500
  assert.equal(frameDelay({ capturedAt: t }, { capturedAt: t + 99999 }), 1500);
  // 最后一帧固定 1000
  assert.equal(frameDelay({ capturedAt: t }, undefined), 1000);
  // capturedAt 缺失/乱序退回 1500
  assert.equal(frameDelay({}, { capturedAt: t }), 1500);
  assert.equal(frameDelay({ capturedAt: t }, { capturedAt: t - 5 }), 1500);
});

test('gif-composer: 空帧与非法 dataUrl 报错', async () => {
  await assert.rejects(() => composeGif([], path.join(tmpDir, 'x.gif')));
  await assert.rejects(() => composeGif([{ dataUrl: 'not-a-dataurl' }], path.join(tmpDir, 'x.gif')));
});

// ─── 5. relay() 对扩展返回的 saveFlow / flows 请求处理 ──────────────────────

test('record_stop 收到 result.saveFlow 时合成 GIF 并保存流程', async () => {
  setExtensionWs(fakeWs);
  const t0 = Date.now();
  const png1 = await mkFrameDataUrl(255, 0, 0);
  const png2 = await mkFrameDataUrl(0, 255, 0);
  fakeResponder = () => ({
    content: [{ type: 'text', text: 'Recording stopped. 2 steps captured.' }],
    saveFlow: {
      name: '演示流程',
      flow: mkFlowJson([
        { type: 'navigate', url: 'https://example.com' },
        { type: 'click', ref: 'ref_1' },
      ]),
      frames: [
        { dataUrl: png1, capturedAt: t0 },
        { dataUrl: png2, capturedAt: t0 + 400 },
      ],
    },
  });

  const client = await connectClient();
  const res = await client.callTool({ name: 'record_stop', arguments: { tabId: 7, name: '演示流程' } });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  const text = res.content.map((c) => c.text || '').join('\n');
  assert.match(text, /Saved flow "演示流程"/);

  // 文件落盘且 GIF 可读
  const json = JSON.parse(await fsp.readFile(path.join(tmpDir, '演示流程.json'), 'utf8'));
  assert.equal(json.steps.length, 2);
  const gif = await fsp.readFile(path.join(tmpDir, '演示流程.gif'));
  assert.equal(gif.subarray(0, 3).toString('ascii'), 'GIF');

  // record_list 现在能看到它
  const listed = await flowsStore.listFlows();
  assert.equal(listed[0].name, '演示流程');
  assert.ok(listed[0].gifSize > 0);
});

test('record_list / record_export_* 走 relay 本地分支，不发给扩展', async () => {
  setExtensionWs(fakeWs);
  await flowsStore.saveFlow('本地流程', mkFlowJson([{ type: 'click' }]), Buffer.from('GIF89a'));

  const client = await connectClient();
  sentMessages.length = 0;

  const listRes = await client.callTool({ name: 'record_list', arguments: {} });
  const listText = listRes.content.map((c) => c.text || '').join('\n');
  assert.match(listText, /本地流程/);
  assert.match(listText, /1 step/);

  const dest = path.join(tmpDir, 'out');
  const gifRes = await client.callTool({ name: 'record_export_gif', arguments: { name: '本地流程', saveTo: dest } });
  assert.match(gifRes.content.map((c) => c.text || '').join('\n'), /GIF exported to/);
  await fsp.access(path.join(dest, '本地流程.gif'));

  const jsonRes = await client.callTool({ name: 'record_export_json', arguments: { name: '本地流程', saveTo: dest } });
  assert.match(jsonRes.content.map((c) => c.text || '').join('\n'), /JSON exported to/);
  await fsp.access(path.join(dest, '本地流程.json'));

  // 本地分支不应产生任何扩展请求
  assert.equal(sentMessages.length, 0, `不应发消息给扩展: ${JSON.stringify(sentMessages)}`);
});

test('record_start/record_run/record_delete 走专用方法名发给扩展', async () => {
  setExtensionWs(fakeWs);
  const client = await connectClient();

  await client.callTool({ name: 'record_start', arguments: { tabId: 7 } });
  assert.equal(sentMessages[0].method, 'record/start');

  await client.callTool({ name: 'record_run', arguments: { tabId: 7, name: 'f1' } });
  assert.equal(sentMessages[1].method, 'record/run');

  await client.callTool({ name: 'record_delete', arguments: { name: 'f1' } });
  assert.equal(sentMessages[2].method, 'record/delete');
  assert.equal(sentMessages[2].params.name, 'f1');
});
