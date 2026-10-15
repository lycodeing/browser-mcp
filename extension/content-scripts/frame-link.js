// content-scripts/frame-link.js
// Exposes globalThis.__frameLink
// 跨域 iframe 里的元素坐标是相对自己视口的，父页面读不到子 frame 的内容，反过来子 frame 也读不到
// 父页面里 iframe 元素的位置。这里用 postMessage 握手让子 frame 与父 frame 互认，
// 再由各 frame 现读自己 iframe 子元素的矩形，扩展侧沿链累加偏移。

(function () {
  if (globalThis.__frameLink) return;

  const KEY = '__bmcp';
  const LINK_WAIT_MS = 300;
  const MAX_SHADOW_DEPTH = 20;

  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let parentToken = null;
  const children = new Map(); // childToken -> iframe/frame 元素

  function frameDepth() {
    let w = window;
    let d = 0;
    while (w.parent !== w && d < 50) { w = w.parent; d++; }
    return d;
  }

  function* frameElements(root, depth = 0) {
    for (const el of root.querySelectorAll('*')) {
      const tag = el.tagName;
      if (tag === 'IFRAME' || tag === 'FRAME') yield el;
      if (el.shadowRoot && depth < MAX_SHADOW_DEPTH) yield* frameElements(el.shadowRoot, depth + 1);
    }
  }

  function findFrameElement(win) {
    for (const el of frameElements(document)) {
      if (el.contentWindow === win) return el;
    }
    return null;
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d[KEY] === undefined || typeof d.token !== 'string') return;

    if (d[KEY] === 'hello' && ev.source && ev.source !== window) {
      const el = findFrameElement(ev.source);
      if (!el) return;
      children.set(d.token, el);
      ev.source.postMessage({ [KEY]: 'ack', token: d.token, parentToken: token }, '*');
    } else if (d[KEY] === 'ack' && ev.source === window.parent && d.token === token
      && typeof d.parentToken === 'string') {
      parentToken = d.parentToken;
    }
  });

  function sayHello() {
    if (window.parent === window) return;
    window.parent.postMessage({ [KEY]: 'hello', token }, '*');
  }

  // 等待父 frame 回 ack；父 frame 的脚本可能还没就绪，所以每 50ms 重发一次
  async function link() {
    if (window.parent === window || parentToken) return { token, parentToken };
    const deadline = Date.now() + LINK_WAIT_MS;
    while (!parentToken && Date.now() < deadline) {
      sayHello();
      await new Promise((r) => setTimeout(r, 50));
    }
    return { token, parentToken };
  }

  // 矩形在调用时现读，布局变化不会让缓存过期
  function collect() {
    const kids = [];
    for (const [childToken, el] of children) {
      if (!el.isConnected) { children.delete(childToken); continue; }
      const r = el.getBoundingClientRect();
      kids.push({
        token: childToken,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        offsetWidth: el.offsetWidth,
        clientLeft: el.clientLeft,
        clientTop: el.clientTop,
      });
    }
    return { token, parentToken, children: kids };
  }

  function info() {
    return { token, parentToken, url: location.href, name: window.name || '', depth: frameDepth() };
  }

  globalThis.__frameLink = { link, collect, info };
})();
