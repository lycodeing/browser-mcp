// 从 navigateImpl 抽出的 URL 规范化与受限地址判断，navigate 与 tabs.create 共用。
// 受限地址指扩展不应导航过去的内部协议页面。

const RESTRICTED = /^(chrome|chrome-extension|edge|devtools|about|javascript):/i;

export function isRestrictedUrl(url) {
  return RESTRICTED.test(url);
}

// 无协议的输入补 https://，并做两阶段受限检查（规范化前后各一次）
export function normalizeUrl(input) {
  let url = String(input).trim();
  if (RESTRICTED.test(url)) return { error: `Blocked URL: ${url}` };
  if (!/^https?:\/\//i.test(url) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url))
    url = 'https://' + url;
  if (RESTRICTED.test(url)) return { error: `Blocked URL: ${url}` };
  return { url };
}
