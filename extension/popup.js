// popup 面板逻辑：三 tab（状态/录制/流程）。只做 DOM 绑定与 chrome 通信，
// 纯函数（格式化/校验/消息常量）在 popup-utils.js，便于 node --test 单测。

import {
  MSG, formatElapsed, formatSize, validateFlowName, formatFlowMeta,
} from './popup-utils.js';

// ── chrome 通信 ─────────────────────────────────────────────────────────────────

// 统一消息出口：background 无对应监听或扩展上下文失效时回调 null，且不产生未检查告警
function send(msg, cb) {
  try {
    const p = chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError; // 读取即抑制 "Unchecked runtime.lastError"
      if (cb) cb(res ?? null);
    });
    // 较新版本 Chrome 中带回调的 sendMessage 会额外返回 Promise，吞掉其潜在拒绝
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    if (cb) cb(null);
  }
}

function getActiveTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    void chrome.runtime.lastError;
    callback(tabs && tabs[0] ? tabs[0].id : null);
  });
}

// ── 浮动提示条 ─────────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(msg, kind) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast ${kind} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}

function showError(msg) { showToast(msg, 'error'); }
function showSuccess(msg) { showToast(msg, 'success'); }

// ── Tab 切换 ───────────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.popup-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-body').forEach((el) => {
    el.classList.toggle('active', el.id === `tab-${tab}`);
  });
  // 切到某 tab 时刷新该 tab 的数据，避免显示陈旧内容
  if (tab === 'status') send({ type: MSG.GET_STATUS }, updateStatus);
  if (tab === 'record') send({ type: MSG.RECORD_STATE }, updateRecordingState);
  if (tab === 'flows') refreshFlowList();
}

document.querySelectorAll('.popup-tab').forEach((tab) => {
  tab.onclick = () => switchTab(tab.dataset.tab);
});

// ── 状态 Tab ───────────────────────────────────────────────────────────────────

function updateStatus(status) {
  if (!status) return;
  const dot = document.getElementById('status-dot');
  const value = document.getElementById('status-value');
  if (status.connected) {
    dot.className = 'status-dot green';
    value.textContent = '已连接';
    value.className = 'status-value ok';
  } else {
    dot.className = 'status-dot red';
    value.textContent = '未连接';
    value.className = 'status-value err';
  }
  if (status.relayUrl) document.getElementById('relay-url').textContent = status.relayUrl;
}

document.getElementById('retry-btn').onclick = () => {
  send({ type: MSG.RECONNECT }, () => {
    // 重连握手需要一点时间，300ms 后再拉取状态
    setTimeout(() => send({ type: MSG.GET_STATUS }, updateStatus), 300);
  });
};

// ── 录制 Tab ───────────────────────────────────────────────────────────────────

function updateRecordingState(state) {
  const s = state || {};
  const recording = !!s.isRecording;
  document.getElementById('rec-off').style.display = recording ? 'none' : 'flex';
  document.getElementById('start-btn').style.display = recording ? 'none' : 'flex';
  document.getElementById('start-hint').style.display = recording ? 'none' : 'block';
  document.getElementById('rec-on').style.display = recording ? 'flex' : 'none';
  document.getElementById('rec-form').style.display = recording ? 'block' : 'none';
  if (!recording) return;
  const parts = [`${formatElapsed(s.elapsedMs)} · 已捕获 ${s.stepsCount || 0} 步`];
  if (s.framesCount > 0) parts.push(`${s.framesCount} 帧截图`);
  document.getElementById('rec-sub').textContent = parts.join(' · ');
}

// 停止/取消后恢复表单默认值，下次录制从干净状态开始
function resetRecordForm() {
  document.getElementById('flow-name').value = '';
  document.getElementById('save-gif').checked = true;
}

document.getElementById('start-btn').onclick = () => {
  getActiveTab((tabId) => {
    if (tabId == null) return showError('未找到活动标签页');
    send({ type: MSG.RECORD_START, tabId, captureGif: true }, (res) => {
      if (!res) return showError('后台无响应，无法开始录制');
      if (res.error) return showError(res.error);
      updateRecordingState({ isRecording: true, stepsCount: 0, framesCount: 0, elapsedMs: 0 });
    });
  });
};

document.getElementById('stop-btn').onclick = () => {
  const check = validateFlowName(document.getElementById('flow-name').value);
  if (!check.ok) return showError(check.error);
  const saveGif = document.getElementById('save-gif').checked;
  getActiveTab((tabId) => {
    if (tabId == null) return showError('未找到活动标签页');
    send({ type: MSG.RECORD_STOP, tabId, name: check.name, saveGif }, (res) => {
      if (!res) return showError('后台无响应，保存状态未知');
      if (res.error) return showError(res.error);
      showSuccess(`已保存 ${res.stepsCount || 0} 步`);
      resetRecordForm();
      updateRecordingState({ isRecording: false });
      refreshFlowList();
    });
  });
};

document.getElementById('cancel-btn').onclick = () => {
  getActiveTab((tabId) => {
    if (tabId == null) return showError('未找到活动标签页');
    send({ type: MSG.RECORD_CANCEL, tabId }, (res) => {
      if (res && res.error) return showError(res.error);
      showSuccess('已取消录制');
      resetRecordForm();
      updateRecordingState({ isRecording: false });
    });
  });
};

// 录制状态轮询：popup 存活期间每 500ms 拉一次，驱动计时与步数展示
setInterval(() => {
  send({ type: MSG.RECORD_STATE }, updateRecordingState);
}, 500);

// ── 流程 Tab ───────────────────────────────────────────────────────────────────

function refreshFlowList() {
  send({ type: MSG.RECORD_LIST }, updateFlowList);
}

function updateFlowList(res) {
  const flows = res && Array.isArray(res.flows) ? res.flows : [];
  document.getElementById('flows-empty').style.display = flows.length ? 'none' : 'block';
  const list = document.getElementById('flows-list');
  list.innerHTML = '';
  for (const flow of flows) list.appendChild(renderFlowItem(flow));
}

function flowButton(text, className, name) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn ${className}`;
  btn.textContent = text;
  btn.dataset.name = name;
  return btn;
}

function renderFlowItem(flow) {
  const item = document.createElement('div');
  item.className = 'flow-item';

  const name = document.createElement('div');
  name.className = 'flow-name';
  name.textContent = `📁 ${flow.name}`;

  const meta = document.createElement('div');
  meta.className = 'flow-meta';
  meta.textContent = formatFlowMeta(flow);

  const actions = document.createElement('div');
  actions.className = 'flow-actions';
  actions.appendChild(flowButton('▶ 回放', 'btn-primary flow-run', flow.name));
  actions.appendChild(flowButton('👁 GIF', 'btn-secondary flow-gif', flow.name));
  actions.appendChild(flowButton('🗑', 'btn-secondary flow-del', flow.name));

  item.append(name, meta, actions);
  return item;
}

function runFlow(name) {
  getActiveTab((tabId) => {
    if (tabId == null) return showError('未找到活动标签页');
    send({ type: MSG.RECORD_RUN, tabId, name }, (res) => {
      if (!res) return showError('后台无响应');
      if (res.error) return showError(res.error);
      showSuccess('回放完成');
    });
  });
}

function exportFlowGif(name) {
  send({ type: MSG.RECORD_EXPORT_GIF, name }, (res) => {
    if (!res) return showError('后台无响应');
    if (res.error) return showError(res.error);
    showSuccess('GIF 已开始下载');
  });
}

// 删除是破坏性操作，两段式确认：第一次点击变红色"确认删除"，再点才真正删除
function deleteFlow(btn) {
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = '确认删除';
    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-danger');
    return;
  }
  const name = btn.dataset.name;
  send({ type: MSG.RECORD_DELETE, name }, (res) => {
    if (!res) return showError('后台无响应');
    if (res.error) return showError(res.error);
    showSuccess(`已删除「${name}」`);
    refreshFlowList();
  });
}

// 列表用事件委托：三个操作按钮按 class 分发，重渲染后无需重挂监听
document.getElementById('flows-list').addEventListener('click', (e) => {
  const runBtn = e.target.closest('.flow-run');
  if (runBtn) return runFlow(runBtn.dataset.name);
  const gifBtn = e.target.closest('.flow-gif');
  if (gifBtn) return exportFlowGif(gifBtn.dataset.name);
  const delBtn = e.target.closest('.flow-del');
  if (delBtn) return deleteFlow(delBtn);
});

// ── 启动 ───────────────────────────────────────────────────────────────────────

send({ type: MSG.GET_STATUS }, updateStatus);
send({ type: MSG.RECORD_STATE }, updateRecordingState);
refreshFlowList();
