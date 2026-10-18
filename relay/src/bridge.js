/**
 * bridge.js
 * 管理扩展 WebSocket 连接与 MCP 工具调用之间的状态桥接
 */

let extensionWs = null;
let nextMessageId = 1;
const pendingRequests = new Map(); // messageId -> { resolve, reject, timer, tool }
const pendingExtensionRequests = new Map(); // method -> async (params) => result
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
    return;
  }

  // 扩展主动发起的请求（有 id 且带 method）：交给注册的 handler 处理，
  // 处理结果（或错误）以相同 id 回给扩展。未注册 method 时回错而非挂起扩展。
  if (typeof msg.id === 'number' && msg.method) {
    if (!pendingExtensionRequests.has(msg.method)) {
      sendResponseToExtension(msg.id, { error: { code: 'METHOD_NOT_FOUND', message: `Unknown extension request method: ${msg.method}` } });
      return;
    }
    Promise.resolve()
      .then(() => pendingExtensionRequests.get(msg.method)(msg.params || {}))
      .then((result) => sendResponseToExtension(msg.id, { result: result ?? {} }))
      .catch((err) => sendResponseToExtension(msg.id, { error: { code: err.code || 'HANDLER_ERROR', message: err.message } }));
  }
}

/** 以扩展约定的消息形态回写响应：响应不携带 method，只带 id */
function sendResponseToExtension(id, payload) {
  if (!isConnected()) return;
  try {
    extensionWs.send(JSON.stringify({ id, ...payload }));
  } catch { /* 连接已断时丢弃即可，扩展会按超时处理 */ }
}

/**
 * 注册扩展主动请求的处理器（如 flows/composeGif、flows/save）。
 * 同名 method 重复注册时后者覆盖前者；返回注销函数。
 */
export function onExtensionRequest(method, handler) {
  pendingExtensionRequests.set(method, handler);
  return () => pendingExtensionRequests.delete(method);
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
 * 向扩展发起任意 method 调用并等待响应（invokeTool 的通用版）。
 * record_* 工具里需要扩展侧数据的操作（record_list/run/delete 等）走这里。
 */
export function sendToExtension(method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!isConnected()) {
      reject(new Error('No extension connected. Make sure the Chrome extension is running and connected.'));
      return;
    }

    const id = nextMessageId++;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Extension call "${method}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer, tool: method });

    try {
      extensionWs.send(JSON.stringify({ id, method, params: params ?? {} }));
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
