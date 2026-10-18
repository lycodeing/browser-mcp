import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_TIMEOUTS } from '../src/mcp-server.js';

test('排队工具的超时 = 基础值 + 30 秒排队等待', () => {
  assert.equal(TOOL_TIMEOUTS.form_input, 45000);
  // form_input_multi 最多 20 个字段，基础值 30000 叠加排队后 60000
  assert.equal(TOOL_TIMEOUTS.form_input_multi, 60000);
  assert.equal(TOOL_TIMEOUTS.computer, 60000);
  assert.equal(TOOL_TIMEOUTS.navigate, 60000);
  assert.equal(TOOL_TIMEOUTS.file_upload, 60000);
  assert.equal(TOOL_TIMEOUTS.javascript_tool, 60000);
  // click 是写操作进队列；基础值 15000 叠加后 45000
  assert.equal(TOOL_TIMEOUTS.click, 45000);
  // tab_reload 会等待页面加载，进队列；基础值 20000 叠加后 50000
  assert.equal(TOOL_TIMEOUTS.tab_reload, 50000);
  // storage 的写操作进队列，基础值 10000 叠加后 40000
  assert.equal(TOOL_TIMEOUTS.storage, 40000);
});

test('非排队工具的超时不受排队等待影响', () => {
  assert.equal(TOOL_TIMEOUTS.screenshot, 15000);
  assert.equal(TOOL_TIMEOUTS.sleep, 12000);
  assert.equal(TOOL_TIMEOUTS.network_list, 10000);
  assert.equal(TOOL_TIMEOUTS.network_detail, 15000);
  assert.equal(TOOL_TIMEOUTS.tabs_list, 5000);
  assert.equal(TOOL_TIMEOUTS.tab_create, 40000);
  assert.equal(TOOL_TIMEOUTS.tab_close, 10000);
  assert.equal(TOOL_TIMEOUTS.tab_activate, 5000);
  assert.equal(TOOL_TIMEOUTS.tab_duplicate, 20000);
  assert.equal(TOOL_TIMEOUTS.tab_group, 10000);
  assert.equal(TOOL_TIMEOUTS.find, 15000);
  assert.equal(TOOL_TIMEOUTS.read_page, 15000);
  assert.equal(TOOL_TIMEOUTS.get_page_text, 15000);
  assert.equal(TOOL_TIMEOUTS.wait_for, 130000);
  assert.equal(TOOL_TIMEOUTS.handle_dialog, 5000);
  assert.equal(TOOL_TIMEOUTS.save_pdf, 60000);
  assert.equal(TOOL_TIMEOUTS.performance, 60000);
  // emulate 拆成三个工具后，各自保持原 10 秒基础超时
  assert.equal(TOOL_TIMEOUTS.emulate_device, 10000);
  assert.equal(TOOL_TIMEOUTS.emulate_network, 10000);
  assert.equal(TOOL_TIMEOUTS.emulate_geo, 10000);
  // state 是轻量只读快照，不排队
  assert.equal(TOOL_TIMEOUTS.state, 5000);
});

test('超时表覆盖全部工具且不含旧工具名', () => {
  const names = Object.keys(TOOL_TIMEOUTS).sort();
  assert.equal(names.length, 37);
  for (const old of ['tabs_context', 'tabs_create', 'tabs_close', 'read_network_requests', 'tabs', 'network', 'emulate']) {
    assert.ok(!names.includes(old), `${old} 应被删除`);
  }
  for (const name of ['screenshot', 'click', 'sleep', 'form_input_multi', 'emulate_device', 'emulate_network', 'emulate_geo']) {
    assert.ok(names.includes(name), `${name} 应存在`);
  }
  for (const name of ['intercept_add', 'intercept_list', 'intercept_remove']) {
    assert.ok(names.includes(name), `${name} 应存在`);
    assert.equal(TOOL_TIMEOUTS[name], 10000);
  }
});
