/**
 * bridge.js
 * 管理扩展 WebSocket 连接与 MCP 工具调用之间的状态桥接
 */

let extensionWs = null;
let nextMessageId = 1;
const pendingRequests = new Map(); // messageId -> { resolve, reject, timer }
const extensionInfo = { version: null, browserType: null, capabilities: [] };

export function setExtensionWs(ws) {
  extensionWs = ws;
}

export function clearExtensionWs(ws) {
  if (extensionWs !== ws) return;
  extensionWs = null;
  extensionInfo.version = null;
  extensionInfo.browserType = null;
  for (const { reject, timer, tool } of pendingRequests.values()) {
    clearTimeout(timer);
    reject(new Error(`Extension disconnected (pending: ${tool})`));
  }
  pendingRequests.clear();
}

export function updateExtensionInfo(info) {
  if (info.extensionVersion) extensionInfo.version = info.extensionVersion;
  if (info.browserType) extensionInfo.browserType = info.browserType;
  if (Array.isArray(info.capabilities)) extensionInfo.capabilities = info.capabilities;
}

export function isConnected() {
  return extensionWs !== null && extensionWs.readyState === 1 /* OPEN */;
}

export function getExtensionInfo() {
  return { ...extensionInfo, connected: isConnected() };
}

export function handleExtensionMessage(rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData);
  } catch {
    return;
  }

  // 心跳 pong，忽略
  if (msg.method === 'pong') return;

  // 扩展注册信息
  if (msg.method === 'extensionInfo') {
    updateExtensionInfo(msg.params || {});
    return;
  }

  // 工具调用响应 (有 id，无 method)
  if (typeof msg.id === 'number' && !msg.method) {
    const pending = pendingRequests.get(msg.id);
    if (!pending) return;
    pendingRequests.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      const err = new Error(msg.error.message || 'Tool error');
      err.code = msg.error.code;
      pending.reject(err);
    } else {
      pending.resolve(msg.result);
    }
  }
}

/**
 * 向扩展发起工具调用，返回 Promise<result>
 */
export function invokeTool(tool, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!isConnected()) {
      reject(new Error('No extension connected. Make sure the Chrome extension is running and connected.'));
      return;
    }

    const id = nextMessageId++;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Tool "${tool}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer, tool });

    try {
      extensionWs.send(JSON.stringify({
        id,
        method: 'tools/invoke',
        params: { tool, arguments: args ?? {} }
      }));
    } catch (err) {
      pendingRequests.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

/**
 * 让扩展重新加载自身（chrome.runtime.reload）。开发期改完扩展代码后用它生效，
 * 免去手动点 chrome://extensions 的重载按钮（那条路的自动化点击实测不可靠）。
 * 回执在重启前发出，所以这里通常能拿到结果；连接随后会短暂断开再重连。
 */
export function reloadExtension(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!isConnected()) {
      reject(new Error('No extension connected. Make sure the Chrome extension is running and connected.'));
      return;
    }
    const id = nextMessageId++;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Extension reload timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timer, tool: 'extension/reload' });
    try {
      extensionWs.send(JSON.stringify({ id, method: 'extension/reload' }));
    } catch (err) {
      pendingRequests.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}
