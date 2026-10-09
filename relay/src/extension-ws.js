/**
 * extension-ws.js
 * WebSocket server 监听扩展连接 (:16789)
 */

import { WebSocketServer } from 'ws';
import {
  setExtensionWs,
  clearExtensionWs,
  handleExtensionMessage,
  isConnected
} from './bridge.js';

const PING_INTERVAL = 20000;

export function startExtensionWsServer(port = 16789) {
  const wss = new WebSocketServer({ port });

  wss.on('listening', () => {
    console.log(`[Relay] Extension WS server listening on ws://127.0.0.1:${port}`);
  });

  wss.on('connection', (ws, req) => {
    console.log('[Relay] Extension connected:', req.socket.remoteAddress);

    // 同一时间只保留最新一个扩展连接
    if (isConnected()) {
      console.log('[Relay] Replacing previous extension connection');
    }
    setExtensionWs(ws);

    // 发送工具列表给扩展（扩展可据此做自检）
    ws.send(JSON.stringify({ method: 'ping' }));

    let pongPending = false;
    const pingTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      // 上一轮 ping 仍未收到 pong → 扩展可能卡死，主动终止连接
      if (pongPending) {
        console.log('[Relay] Extension pong timeout, terminating connection');
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify({ method: 'ping' }));
      pongPending = true;
    }, PING_INTERVAL);

    ws.on('message', (data) => {
      const str = data.toString();
      // pong 在此拦截，重置待定状态；其余消息交给 bridge 处理
      try {
        const msg = JSON.parse(str);
        if (msg.method === 'pong') { pongPending = false; return; }
      } catch {}
      handleExtensionMessage(str);
    });

    ws.on('close', (code, reason) => {
      console.log(`[Relay] Extension disconnected: ${code} ${reason}`);
      clearInterval(pingTimer);
      clearExtensionWs(ws);
    });

    ws.on('error', (err) => {
      console.error('[Relay] Extension WS error:', err.message);
    });
  });

  wss.on('error', (err) => {
    console.error('[Relay] Extension WS server error:', err.message);
  });

  return wss;
}
