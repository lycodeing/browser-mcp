import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_TIMEOUTS } from '../src/mcp-server.js';

test('排队工具的超时 = 基础值 + 30 秒排队等待', () => {
  assert.equal(TOOL_TIMEOUTS.form_input, 45000);
  assert.equal(TOOL_TIMEOUTS.computer, 60000);
  assert.equal(TOOL_TIMEOUTS.navigate, 60000);
  assert.equal(TOOL_TIMEOUTS.file_upload, 60000);
  assert.equal(TOOL_TIMEOUTS.javascript_tool, 60000);
  // tabs 基础值 40000（含 create 的页面加载），叠加后 70000
  assert.equal(TOOL_TIMEOUTS.tabs, 70000);
  // storage 的写操作进队列，基础值 10000 叠加后 40000
  assert.equal(TOOL_TIMEOUTS.storage, 40000);
});

test('非排队工具的超时不受排队等待影响', () => {
  assert.equal(TOOL_TIMEOUTS.network, 15000);
  assert.equal(TOOL_TIMEOUTS.find, 15000);
  assert.equal(TOOL_TIMEOUTS.read_page, 15000);
  assert.equal(TOOL_TIMEOUTS.get_page_text, 15000);
  assert.equal(TOOL_TIMEOUTS.wait_for, 130000);
  assert.equal(TOOL_TIMEOUTS.handle_dialog, 5000);
  assert.equal(TOOL_TIMEOUTS.save_pdf, 60000);
  assert.equal(TOOL_TIMEOUTS.performance, 60000);
  assert.equal(TOOL_TIMEOUTS.emulate, 10000);
});

test('超时表覆盖全部工具且不含旧工具名', () => {
  const names = Object.keys(TOOL_TIMEOUTS).sort();
  assert.equal(names.length, 23);
  for (const old of ['tabs_context', 'tabs_create', 'tabs_close', 'read_network_requests']) {
    assert.ok(!names.includes(old), `${old} 应被删除`);
  }
  for (const name of ['intercept_add', 'intercept_list', 'intercept_remove']) {
    assert.ok(names.includes(name), `${name} 应存在`);
    assert.equal(TOOL_TIMEOUTS[name], 10000);
  }
});
