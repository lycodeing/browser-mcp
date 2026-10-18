/**
 * gif-composer.js
 * 把录制期间抓到的帧（PNG/JPEG dataUrl）合成 GIF。
 *
 * 编码用 gif-encoder-2（纯 JS，无原生编译），解码用 jimp。
 * 输出超过 MAX_GIF_BYTES 时缩到 720px 宽重编码一次，再超就接受结果。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Jimp } from 'jimp';
import GIFEncoder from 'gif-encoder-2';

/** 帧间隔下限/上限（ms）：过快看不清，过慢显得卡顿 */
export const MIN_DELAY_MS = 200;
export const MAX_DELAY_MS = 1500;
/** 最后一帧的固定停留时间（ms）：给观看者留出收尾画面 */
export const LAST_FRAME_DELAY_MS = 1000;
/** 单帧落盘上限：base64 会先解码成 Buffer 再写，避免异常大帧拖垮编码 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** 输出体积上限，超过则降到 720px 宽重试 */
export const MAX_GIF_BYTES = 3 * 1024 * 1024;
/** 重试时的目标宽度（px） */
const RETRY_WIDTH = 720;

/**
 * 计算一帧的播放时长：nextFrame.capturedAt - frame.capturedAt，
 * 限制在 [MIN_DELAY_MS, MAX_DELAY_MS]；最后一帧固定 LAST_FRAME_DELAY_MS。
 * capturedAt 缺失或乱序时退回 MAX_DELAY_MS。
 */
export function frameDelay(frame, nextFrame) {
  if (!nextFrame) return LAST_FRAME_DELAY_MS;
  const a = Number(frame?.capturedAt);
  const b = Number(nextFrame.capturedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return MAX_DELAY_MS;
  return Math.min(Math.max(Math.round(b - a), MIN_DELAY_MS), MAX_DELAY_MS);
}

/**
 * 解析 dataUrl 为 { data: RGBA 像素数组, width, height }。
 * 只接受 image/* 前缀，其他格式直接报错。
 */
async function decodeFrame(dataUrl, targetWidth) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!match) throw new Error('frame dataUrl must be a base64 image data URL');
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > MAX_FRAME_BYTES) throw new Error(`frame too large: ${buf.length} bytes`);
  const img = await Jimp.read(buf);
  // 等比缩到 targetWidth（帧宽不一时以解码后的实际尺寸统一到首帧宽度）
  if (targetWidth && img.bitmap.width > targetWidth) {
    const height = Math.max(1, Math.round((img.bitmap.height * targetWidth) / img.bitmap.width));
    img.resize({ w: targetWidth, h: height });
  }
  return { data: img.bitmap.data, width: img.bitmap.width, height: img.bitmap.height };
}

/** 编码一批已解码的帧；返回 Buffer。帧尺寸以第一帧为准，后续帧不齐时以左上角裁掉多余部分。 */
function encodeFrames(decoded, delays) {
  const { width, height } = decoded[0];
  const encoder = new GIFEncoder(width, height);
  encoder.start();
  // 逐帧设置间隔：gif-encoder-2 支持 addFrame 前改 delay
  for (let i = 0; i < decoded.length; i++) {
    encoder.setDelay(delays[i]);
    encoder.setQuality(10);
    encoder.addFrame(decoded[i].data);
  }
  encoder.finish();
  return encoder.out.getData();
}

/**
 * 合成 GIF：frames = [{ dataUrl, capturedAt?, delayMs? }]，delayMs 显式给出时优先。
 * 写入 outputPath，返回最终文件大小（字节）。
 * 空帧列表是调用方（扩展）的协议错误，直接抛出。
 */
export async function composeGif(frames, outputPath) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('composeGif requires at least one frame');
  }
  if (typeof outputPath !== 'string' || !outputPath) {
    throw new Error('composeGif requires an output path');
  }

  // 显式 delayMs 优先，否则用 capturedAt 差值
  const delays = frames.map((f, i) => {
    if (Number.isFinite(Number(f?.delayMs)) && Number(f.delayMs) > 0) {
      return Math.min(Math.round(Number(f.delayMs)), MAX_DELAY_MS);
    }
    return frameDelay(f, frames[i + 1]);
  });

  // 第一遍：原尺寸编码（帧宽 > 1280 时直接先缩到 1280，控制编码耗时）
  const firstWidth = Math.min(
    (await decodeFrame(frames[0].dataUrl)).width,
    1280,
  );
  let decoded = [];
  for (const f of frames) decoded.push(await decodeFrame(f.dataUrl, firstWidth));
  let out = encodeFrames(decoded, delays);

  // 超过 3MB 降到 720px 宽重试
  if (out.length > MAX_GIF_BYTES) {
    decoded = [];
    for (const f of frames) decoded.push(await decodeFrame(f.dataUrl, RETRY_WIDTH));
    out = encodeFrames(decoded, delays);
  }

  const dir = path.dirname(outputPath);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(outputPath, out);
  return out.length;
}
