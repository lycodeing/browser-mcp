// content-scripts/page-bridge.js
// Exposes globalThis.__pageBridge

(function () {
  if (globalThis.__pageBridge) return;

  function getPageText(maxChars = 50000) {
    const url = location.href;
    const title = document.title;

    // Try article/main content first
    const candidates = ['article', 'main', '[role="main"]', '.article-body',
      '.post-content', '.entry-content', '#content', '#main'];
    let sourceEl = 'body';
    let content = '';

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length > 200) { content = text; sourceEl = sel; break; }
      }
    }

    if (!content) {
      content = (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    if (content.length > maxChars) content = content.slice(0, maxChars);
    return { url, title, sourceElement: sourceEl, content };
  }

  function searchElements(query, maxResults = 20) {
    if (!query) return [];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    function score(el) {
      const texts = [
        el.innerText, el.textContent, el.getAttribute('aria-label'),
        el.getAttribute('title'), el.getAttribute('placeholder'),
        el.getAttribute('alt'), el.getAttribute('value'),
      ].map(t => (t || '').toLowerCase());
      const combined = texts.join(' ');
      let s = 0;
      for (const term of terms) {
        if (combined.includes(term)) s += 10;
        if (texts[0]?.includes(term)) s += 5; // innerText bonus
      }
      return s;
    }

    function isVisible(el) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    const results = [];
    // 精准选择器直接命中可交互元素，避免全量 DOM 扫描
    const allEls = document.querySelectorAll(
      'a, button, input, select, textarea, label, [role], [tabindex]'
    );

    for (const el of allEls) {
      if (!isVisible(el)) continue;
      const s = score(el);
      if (s > 0) {
        // 使用 accessibility-tree 的 getOrAssignRef 获取稳定 ref，确保 find→click 链路互通
        const tree = globalThis.__accessibilityTree;
        const ref = tree ? tree.getOrAssignRef(el) : `search_${results.length + 1}`;

        results.push({
          ref,
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          text: ((el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g,' ').trim()).slice(0,100),
          score: s,
          element: el,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults).map(({ element: _el, ...rest }) => rest);
  }

  globalThis.__pageBridge = { getPageText, searchElements };
})();
