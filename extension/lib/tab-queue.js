// 按 tabId 串行化的 FIFO 队列：同一标签页的写操作依次执行，不同标签页互不影响。
// 排队等待（入队到开始执行）超过 waitMs 抛 TabBusyError；任务 settle（成功或抛错）后必定释放锁。

export class TabBusyError extends Error {
  constructor(tabId, waitMs) {
    const secs = Math.round(waitMs / 1000);
    super(`Tab ${tabId} is busy with another operation (waited ${secs}s). Use a separate tab per agent, or retry.`);
    this.name = 'TabBusyError';
    this.tabId = tabId;
  }
}

export function createTabQueue({ waitMs = 30000 } = {}) {
  // tabId → { queue: 等待者数组, running: 是否有任务持有锁 }
  // 条目随队列清空删除，避免 Map 无限增长
  const entries = new Map();

  async function run(tabId, task) {
    let entry = entries.get(tabId);
    if (!entry) {
      entry = { queue: [], running: false };
      entries.set(tabId, entry);
    }

    if (entry.running) {
      // 已有任务持有锁：入队等待。超时未轮到则抛 TabBusyError，
      // 从队列移除自身，不占用锁、不影响后续任务。
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = entry.queue.indexOf(item);
          if (idx >= 0) entry.queue.splice(idx, 1);
          reject(new TabBusyError(tabId, waitMs));
        }, waitMs);
        const item = {
          // 轮到了：取消超时定时器，继续执行
          start: () => { clearTimeout(timer); resolve(); },
          // 标签页被关闭：立即以明确错误结束等待
          abort: (reason) => { clearTimeout(timer); reject(reason); },
        };
        entry.queue.push(item);
      });
    } else {
      entry.running = true;
    }

    try {
      return await task();
    } finally {
      // 无论成功还是抛错都释放锁；交接给下一个等待者（此时锁保持持有状态）
      const next = entry.queue.shift();
      if (next) {
        next.start();
      } else {
        entry.running = false;
        // clear 之后可能有同 tabId 的新条目，只删除属于自己的那条
        if (entries.get(tabId) === entry) entries.delete(tabId);
      }
    }
  }

  function clear(tabId) {
    const entry = entries.get(tabId);
    if (!entry) return;
    entries.delete(tabId);
    for (const item of entry.queue.splice(0)) {
      item.abort(new Error(`Tab ${tabId} was closed while waiting in queue`));
    }
  }

  return { run, clear };
}
