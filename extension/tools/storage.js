// storage 工具的胶水实现：在主 frame 里用 chrome.scripting 读写 localStorage / sessionStorage，idb 只读摘要。
// 不走 CDP，调试器 attach 失败时仍可用。依赖（chrome、ok、err）通过参数注入。
// 写操作（set / remove / clear）是否排队由 background.js 的 isQueuedCall 决定。

import { validateStorageArgs, pageStorageOp, formatStorageResult, DEFAULT_MAX_CHARS } from '../lib/storage.js';

export function createStorageTool({ chrome, ok, err }) {
  return async function toolStorage(args) {
    const { tabId } = args;
    if (!tabId) return err('tabId required');
    const bad = validateStorageArgs(args);
    if (bad) return err(bad);

    const spec = {
      action: args.action,
      area: args.area ?? 'local',
      key: args.key,
      value: args.value,
      maxChars: args.maxChars ?? DEFAULT_MAX_CHARS,
    };
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageStorageOp, args: [spec] });
      if (!r?.result) return err('The page returned no result (it may have navigated during the call)');
      const { text, error } = formatStorageResult(spec, r.result);
      return error ? err(text) : ok([{ type: 'text', text }]);
    } catch (e) {
      return err(e.message);
    }
  };
}
