/**
 * schema-helpers.js
 * 宽松的入参 schema 构造器。
 *
 * 模型经常把数字、布尔、数组参数序列化成字符串（"123"、"true"、"[601, 385]"）。
 * 客户端会先用我们公布的 JSON Schema 预校验，类型不符就直接拒绝，请求到不了 relay。
 * 这里公布 anyOf 放行字符串形式，服务端再转换回原生类型并重新套用原约束，
 * 因此下游 handler 拿到的始终是严格类型。
 */

import { z } from 'zod';

const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;
const JSON_ARRAY = /^\s*\[[\s\S]*\]\s*$/;

/** 把 JSON 字符串还原成数组，解析失败记入校验错误 */
function parseJsonArray() {
  return z.string().regex(JSON_ARRAY).transform((s, ctx) => {
    try {
      return JSON.parse(s);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a valid JSON array' });
      return z.NEVER;
    }
  });
}

/** 数字数组的字符串/JSON 字符串公共还原分支 */
function numberItems() {
  return z.array(z.union([z.number(), z.string().regex(NUMERIC)])).transform((items) => items.map(Number));
}

/** base 为带约束的 z.number()，约束同时用于公布的 schema 与转换后的校验 */
export function lenientNumber(base = z.number()) {
  return z.union([base, z.string().regex(NUMERIC)]).transform(Number).pipe(base);
}

export function lenientBoolean() {
  return z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true');
}

/** 定长数字数组，接受 [x, y] 或其 JSON 字符串 "[x, y]" */
export function lenientNumberTuple(length) {
  const base = z.array(z.number()).length(length);
  return z.union([base, parseJsonArray()]).pipe(base);
}

/** 不定长整数数组，接受 [1,2]、["1","2"] 或其 JSON 字符串 "[1, 2]"，最终收紧为非空、≤50 的整数数组 */
export function lenientNumberArray() {
  const base = z.array(z.number().int()).min(1).max(50);
  const fromItems = numberItems();
  return z.union([fromItems, parseJsonArray().pipe(fromItems)]).pipe(base);
}
