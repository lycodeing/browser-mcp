/**
 * flows-store.js
 * 录制流程的本地文件存储：~/.browser-mcp/flows/<name>.json + <name>.gif
 *
 * JSON 结构由扩展侧生成，relay 只负责落盘与检索；GIF 为录制时抓帧的合成产物。
 * name 仅允许中文/字母/数字/下划线/连字符，其余字符替换为 _，防止路径逃逸。
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认存储目录；测试可通过 setFlowsDir 注入临时目录 */
let flowsDir = path.join(os.homedir(), '.browser-mcp', 'flows');

export function getFlowsDir() {
  return flowsDir;
}

/** 测试注入用：切换存储目录 */
export function setFlowsDir(dir) {
  flowsDir = dir;
}

/** 文件名安全化：中文/字母/数字/下划线/连字符之外全部替换为 _ */
export function sanitizeName(name) {
  return String(name)
    .trim()
    .replace(/[^\p{Script=Han}A-Za-z0-9_-]/gu, '_')
    .replace(/^_+|_+$/g, '') || 'flow';
}

function jsonPath(name) {
  return path.join(flowsDir, `${sanitizeName(name)}.json`);
}

function gifPath(name) {
  return path.join(flowsDir, `${sanitizeName(name)}.gif`);
}

/**
 * 保存流程：写 JSON（含录制元信息）与可选的 GIF。
 * gifBuffer 为空（未开启 GIF 抓帧）时跳过 GIF 文件。
 */
export async function saveFlow(name, json, gifBuffer) {
  const safe = sanitizeName(name);
  await fsp.mkdir(flowsDir, { recursive: true });
  await fsp.writeFile(jsonPath(safe), JSON.stringify(json, null, 2), 'utf8');
  if (gifBuffer && gifBuffer.length > 0) {
    await fsp.writeFile(gifPath(safe), gifBuffer);
  }
  return {
    name: safe,
    jsonPath: jsonPath(safe),
    gifPath: gifBuffer && gifBuffer.length > 0 ? gifPath(safe) : null,
  };
}

/**
 * 列出已保存的流程：[{ name, steps, gifSize, recordedAt }]，按名称排序。
 * steps 取自 JSON 里的 steps 数组长度；损坏的 JSON 文件跳过而非报错。
 */
export async function listFlows() {
  let entries;
  try {
    entries = await fsp.readdir(flowsDir);
  } catch {
    return []; // 目录不存在视为空
  }

  const flows = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.slice(0, -5);
    try {
      const raw = await fsp.readFile(path.join(flowsDir, entry), 'utf8');
      const json = JSON.parse(raw);
      let gifSize = 0;
      try {
        gifSize = (await fsp.stat(gifPath(name))).size;
      } catch { /* 无 GIF 属正常（captureGif:false 或旧版本录制） */ }
      flows.push({
        name,
        steps: Array.isArray(json.steps) ? json.steps.length : 0,
        gifSize,
        recordedAt: json.recordedAt ?? null,
      });
    } catch { /* 损坏的 JSON 跳过 */ }
  }
  flows.sort((a, b) => a.name.localeCompare(b.name));
  return flows;
}

/** 读取单个流程的完整 JSON；不存在时抛错 */
export async function loadFlow(name) {
  const raw = await fsp.readFile(jsonPath(name), 'utf8');
  return JSON.parse(raw);
}

/** 删除流程的 .json 与 .gif；GIF 不存在不算失败 */
export async function deleteFlow(name) {
  const safe = sanitizeName(name);
  await fsp.unlink(jsonPath(safe));
  try {
    await fsp.unlink(gifPath(safe));
  } catch { /* 无 GIF 时静默 */ }
  return { name: safe, deleted: true };
}

/**
 * 导出流程到指定目录：复制 .json（以及存在的 .gif）为 <name>.json / <name>.gif。
 * format 'json' 只导 JSON，'gif' 只导 GIF，缺省两者都导。
 */
export async function exportFlow(name, destDir, format) {
  if (!destDir) throw new Error('exportFlow requires a destination directory');
  if (typeof destDir !== 'string' || !path.isAbsolute(destDir)) {
    throw new Error('destDir must be an absolute path');
  }
  const safe = sanitizeName(name);
  await fsp.mkdir(destDir, { recursive: true });

  const exported = [];
  const wantJson = !format || format === 'json';
  const wantGif = !format || format === 'gif';

  if (wantJson) {
    const dest = path.join(destDir, `${safe}.json`);
    await fsp.copyFile(jsonPath(safe), dest);
    exported.push(dest);
  }
  if (wantGif) {
    try {
      const dest = path.join(destDir, `${safe}.gif`);
      await fsp.copyFile(gifPath(safe), dest);
      exported.push(dest);
    } catch { /* 无 GIF 时静默跳过 */ }
  }
  return { name: safe, exported };
}
