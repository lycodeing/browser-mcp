// lib/emulation.js 的测试：设备预设合并、参数校验、locale/timezone 规范化。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planEmulation, DEVICE_PRESETS, DEVICE_NAMES } from '../lib/emulation.js';

test('三个预设齐全，数值与设计一致', () => {
  assert.deepEqual(DEVICE_NAMES, ['iphone-15', 'ipad-air', 'pixel-8']);
  assert.equal(DEVICE_PRESETS['iphone-15'].width, 393);
  assert.equal(DEVICE_PRESETS['iphone-15'].deviceScaleFactor, 3);
  assert.equal(DEVICE_PRESETS['ipad-air'].height, 1180);
  assert.equal(DEVICE_PRESETS['pixel-8'].deviceScaleFactor, 2.625);
});

test('只有 pixel-8 带 userAgentMetadata', () => {
  assert.ok(DEVICE_PRESETS['pixel-8'].userAgentMetadata.mobile);
  assert.equal(DEVICE_PRESETS['iphone-15'].userAgentMetadata, undefined);
  assert.equal(DEVICE_PRESETS['ipad-air'].userAgentMetadata, undefined);
});

test('device 展开为视口、触摸与 UA', () => {
  const { plan } = planEmulation({ device: 'iphone-15' });
  assert.deepEqual(plan.viewport, { width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
  assert.equal(plan.touch, true);
  assert.match(plan.ua.userAgent, /iPhone/);
  assert.equal(plan.ua.platform, 'iPhone');
});

test('显式参数覆盖预设对应项，其余沿用预设', () => {
  const { plan } = planEmulation({ device: 'iphone-15', width: 500, deviceScaleFactor: 2 });
  assert.deepEqual(plan.viewport, { width: 500, height: 852, deviceScaleFactor: 2, mobile: true });
});

test('显式 userAgent 只替换 UA 字符串，平台与 metadata 仍来自预设', () => {
  const { plan } = planEmulation({ device: 'pixel-8', userAgent: 'Custom/1.0' });
  assert.equal(plan.ua.userAgent, 'Custom/1.0');
  assert.equal(plan.ua.platform, DEVICE_PRESETS['pixel-8'].platform);
  assert.ok(plan.ua.userAgentMetadata);
});

test('没有预设时自定义视口必须同时给宽和高', () => {
  assert.match(planEmulation({ width: 800 }).error, /width and height/);
  assert.match(planEmulation({ height: 600 }).error, /width and height/);
  const { plan } = planEmulation({ width: 800, height: 600 });
  assert.deepEqual(plan.viewport, { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  assert.equal(plan.touch, false);
});

test('只传 mobile 或 deviceScaleFactor 但无尺寸时报错', () => {
  assert.ok(planEmulation({ mobile: true }).error);
  assert.ok(planEmulation({ deviceScaleFactor: 2 }).error);
});

test('未知设备报错并列出可选项', () => {
  const { error } = planEmulation({ device: 'nokia-3310' });
  assert.match(error, /Unknown device/);
  assert.match(error, /iphone-15/);
});

test('latitude 与 longitude 必须成对', () => {
  assert.match(planEmulation({ latitude: 35 }).error, /together/);
  assert.match(planEmulation({ longitude: 139 }).error, /together/);
  assert.match(planEmulation({ accuracy: 10 }).error, /accuracy needs/);
});

test('位置默认精度 100 米，可显式指定', () => {
  assert.deepEqual(planEmulation({ latitude: 35.68, longitude: 139.76 }).plan.geo, { latitude: 35.68, longitude: 139.76, accuracy: 100 });
  assert.equal(planEmulation({ latitude: 0, longitude: 0, accuracy: 5 }).plan.geo.accuracy, 5);
});

test('经纬度为 0 不被当成未传', () => {
  const { plan, error } = planEmulation({ latitude: 0, longitude: 0 });
  assert.equal(error, undefined);
  assert.deepEqual(plan.geo, { latitude: 0, longitude: 0, accuracy: 100 });
});

test('时区：合法名通过，空串用于还原，非法名在设置前报错', () => {
  assert.equal(planEmulation({ timezone: 'Asia/Tokyo' }).plan.timezone, 'Asia/Tokyo');
  assert.equal(planEmulation({ timezone: '' }).plan.timezone, '');
  const { error } = planEmulation({ timezone: 'Mars/Olympus' });
  assert.match(error, /Invalid timezone/);
  assert.match(error, /Asia\/Tokyo/);
});

test('locale：ja_JP 规范化为 ja-JP，空串还原，非法值报错', () => {
  assert.equal(planEmulation({ locale: 'ja_JP' }).plan.locale, 'ja-JP');
  assert.equal(planEmulation({ locale: 'ja-JP' }).plan.locale, 'ja-JP');
  assert.equal(planEmulation({ locale: 'ja' }).plan.locale, 'ja');
  assert.equal(planEmulation({ locale: '' }).plan.locale, '');
  assert.match(planEmulation({ locale: 'not a locale!!' }).error, /Invalid locale/);
});

test('旧参数照常进入计划', () => {
  const { plan } = planEmulation({ cpuThrottlingRate: 4, networkConditions: 'Slow 3G', colorScheme: 'dark', userAgent: 'X' });
  assert.equal(plan.cpu, 4);
  assert.equal(plan.network, 'Slow 3G');
  assert.equal(plan.scheme, 'dark');
  assert.equal(plan.ua.userAgent, 'X');
  assert.equal(plan.viewport, undefined);
});

test('userAgent 空串表示还原，不带预设字段', () => {
  assert.deepEqual(planEmulation({ userAgent: '' }).plan.ua, { userAgent: '' });
});

test('什么都不传得到空计划', () => {
  assert.deepEqual(planEmulation({ tabId: 1 }).plan, {});
});
