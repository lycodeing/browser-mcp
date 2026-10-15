// emulate 的纯逻辑：设备预设、参数合并与校验。不依赖 chrome，便于单测。

// ── UA 版本常量（取值日期 2026-10，本机 Chrome 155）。过期时只改这一块 ──────────
const CHROME_MAJOR = 155;
const ANDROID_VERSION = '16';
const IOS_UA_VERSION = '18_6';
const SAFARI_VERSION = '26.0';

const IOS_SAFARI_TAIL = `AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${SAFARI_VERSION} Mobile/15E148 Safari/604.1`;

export const DEVICE_PRESETS = {
  'iphone-15': {
    width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true,
    platform: 'iPhone',
    userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS ${IOS_UA_VERSION} like Mac OS X) ${IOS_SAFARI_TAIL}`,
  },
  'ipad-air': {
    width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true,
    platform: 'iPad',
    userAgent: `Mozilla/5.0 (iPad; CPU OS ${IOS_UA_VERSION} like Mac OS X) ${IOS_SAFARI_TAIL}`,
  },
  'pixel-8': {
    width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true,
    platform: 'Linux armv81',
    userAgent: `Mozilla/5.0 (Linux; Android ${ANDROID_VERSION}; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Mobile Safari/537.36`,
    // 让 navigator.userAgentData.mobile 与 UA 一致；iOS Safari 没有 userAgentData，不传
    userAgentMetadata: { platform: 'Android', platformVersion: ANDROID_VERSION, architecture: '', model: 'Pixel 8', mobile: true },
  },
};

export const DEVICE_NAMES = Object.keys(DEVICE_PRESETS);

/** 校验 IANA 时区名；空串表示还原，直接放行。返回错误文案或 null */
function timezoneError(tz) {
  if (tz === '') return null;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return null;
  } catch {
    return `Invalid timezone: "${tz}". Use an IANA name such as Asia/Tokyo, America/New_York or UTC; empty string resets.`;
  }
}

/** ja_JP 视为 ja-JP；返回规范化后的区域，非法时返回 null。空串原样返回（还原） */
function normalizeLocale(locale) {
  if (locale === '') return '';
  try {
    return Intl.getCanonicalLocales(locale.replace(/_/g, '-'))[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * 把 emulate 入参整理成执行计划，不碰浏览器。出错时返回 { error }，调用方应在附加调试器之前报错。
 * 计划字段（未传的不出现）：cpu、network、scheme、viewport、touch、ua、timezone、locale、geo。
 * ua 的 platform / userAgentMetadata 只来自设备预设；显式 userAgent 只替换 UA 字符串本身。
 */
export function planEmulation(args) {
  const {
    device, width, height, deviceScaleFactor, mobile, latitude, longitude, accuracy,
    timezone, locale, userAgent, cpuThrottlingRate, networkConditions, colorScheme,
  } = args;
  const plan = {};

  if (device !== undefined && !DEVICE_PRESETS[device]) {
    return { error: `Unknown device: "${device}". Available: ${DEVICE_NAMES.join(', ')}` };
  }
  const preset = device !== undefined ? DEVICE_PRESETS[device] : undefined;

  if (cpuThrottlingRate != null) plan.cpu = cpuThrottlingRate;
  if (networkConditions != null) plan.network = networkConditions;
  if (colorScheme != null) plan.scheme = colorScheme;

  if (preset || width != null || height != null || deviceScaleFactor != null || mobile != null) {
    const w = width ?? preset?.width;
    const h = height ?? preset?.height;
    if (w == null || h == null) {
      return { error: 'Custom viewport needs both width and height (or pass device to take them from a preset)' };
    }
    plan.viewport = {
      width: w,
      height: h,
      deviceScaleFactor: deviceScaleFactor ?? preset?.deviceScaleFactor ?? 1,
      mobile: mobile ?? preset?.mobile ?? false,
    };
    plan.touch = mobile ?? preset?.touch ?? false;
  }

  if (userAgent !== undefined) {
    plan.ua = userAgent === ''
      ? { userAgent: '' }
      : { userAgent, platform: preset?.platform, userAgentMetadata: preset?.userAgentMetadata };
  } else if (preset) {
    plan.ua = { userAgent: preset.userAgent, platform: preset.platform, userAgentMetadata: preset.userAgentMetadata };
  }

  if (timezone !== undefined) {
    const bad = timezoneError(timezone);
    if (bad) return { error: bad };
    plan.timezone = timezone;
  }

  if (locale !== undefined) {
    const normalized = normalizeLocale(locale);
    if (normalized === null) return { error: `Invalid locale: "${locale}". Use a BCP 47 tag such as ja-JP or en-US; empty string resets.` };
    plan.locale = normalized;
  }

  if ((latitude == null) !== (longitude == null)) {
    return { error: 'latitude and longitude must be given together' };
  }
  if (latitude != null) {
    plan.geo = { latitude, longitude, accuracy: accuracy ?? 100 };
  } else if (accuracy != null) {
    return { error: 'accuracy needs latitude and longitude' };
  }

  return { plan };
}
