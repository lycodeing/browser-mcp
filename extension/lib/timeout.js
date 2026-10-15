// 给一个 Promise 加超时：超时 reject `Tool timeout: <label>`。
// 注意被超时的任务本身无法取消，会继续在后台执行，这是已知限制。

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tool timeout: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
