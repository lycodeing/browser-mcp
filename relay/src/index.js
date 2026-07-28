/**
 * index.js — Relay 入口
 */

import { startExtensionWsServer } from './extension-ws.js';
import { startMcpServer } from './mcp-server.js';

const EXT_PORT = Number(process.env.EXT_PORT) || 16789;
const MCP_PORT = Number(process.env.MCP_PORT) || 3000;

startExtensionWsServer(EXT_PORT);
startMcpServer(MCP_PORT);

console.log('[Relay] browser-mcp relay started');
console.log(`  Extension WS : ws://127.0.0.1:${EXT_PORT}`);
console.log(`  MCP endpoint : http://127.0.0.1:${MCP_PORT}/mcp`);
