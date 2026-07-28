// content-scripts/accessibility-tree.js
// Exposes globalThis.__accessibilityTree

(function () {
  if (globalThis.__accessibilityTree) return; // already injected

  const refMap = new Map();   // ref -> element
  const elemMap = new WeakMap(); // element -> ref
  let refCounter = 0;

  function assignRef(el) {
    if (elemMap.has(el)) return elemMap.get(el);
    const ref = `ref_${++refCounter}`;
    refMap.set(ref, el);
    elemMap.set(el, ref);
    return ref;
  }

  const INTERACTIVE = new Set(['a','button','input','select','textarea','details','summary']);
  const SKIP_TAGS = new Set(['script','style','noscript','head','meta','link','br','hr']);

  function isVisible(el) {
    if (el.nodeType !== 1) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function getRole(el) {
    const ar = el.getAttribute('aria-role') || el.getAttribute('role');
    if (ar) return ar;
    const tag = el.tagName.toLowerCase();
    const map = { a:'link', button:'button', input:'textbox', select:'combobox',
      textarea:'textbox', img:'img', h1:'heading', h2:'heading', h3:'heading',
      h4:'heading', h5:'heading', h6:'heading', ul:'list', ol:'list', li:'listitem',
      table:'table', nav:'navigation', main:'main', header:'banner', footer:'contentinfo',
      form:'form', dialog:'dialog' };
    if (tag === 'input') {
      const t = el.type?.toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
    }
    return map[tag] || tag;
  }

  function getText(el) {
    const label = el.getAttribute('aria-label') || el.getAttribute('title') ||
      el.getAttribute('placeholder') || el.getAttribute('alt');
    if (label) return label.trim().slice(0, 120);
    const inner = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return inner.slice(0, 120);
  }

  function buildTree(el, depth, maxDepth, filter, lines, indent) {
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (depth > maxDepth) return;

    const isInteractive = INTERACTIVE.has(tag) || el.getAttribute('tabindex') != null ||
      el.getAttribute('role') != null || el.onclick != null;
    const visible = isVisible(el);

    if (filter === 'interactive' && !isInteractive) {
      for (const child of el.children) buildTree(child, depth + 1, maxDepth, filter, lines, indent);
      return;
    }

    if (!visible && filter === 'interactive') {
      for (const child of el.children) buildTree(child, depth + 1, maxDepth, filter, lines, indent);
      return;
    }

    const ref = assignRef(el);
    const role = getRole(el);
    const text = getText(el);
    const checked = (el.type === 'checkbox' || el.type === 'radio') ? ` checked=${el.checked}` : '';
    const value = (tag === 'input' || tag === 'textarea') && el.value ? ` value="${el.value.slice(0,60)}"` : '';
    const disabled = el.disabled ? ' disabled' : '';
    const vis = visible ? '' : ' hidden';
    lines.push(`${indent}[${ref}] ${role}${vis}${disabled}${checked}${value} "${text}"`);

    for (const child of el.children) buildTree(child, depth + 1, maxDepth, filter, lines, indent + '  ');
  }

  globalThis.__accessibilityTree = {
    generate(filter = 'all', maxDepth = 15, maxChars = 50000, refId = null) {
      const root = refId ? refMap.get(refId) : document.body;
      if (refId && !root) return { tree: `[Error] Element not found: ${refId}`, elementCount: 0 };
      const lines = [];
      buildTree(root || document.body, 0, maxDepth, filter, lines, '');
      let tree = lines.join('\n');
      const truncated = tree.length > maxChars;
      if (truncated) tree = tree.slice(0, maxChars);
      return { tree, elementCount: lines.length, truncated };
    },

    getElementByRef(ref) {
      return refMap.get(ref) || null;
    },

    getElementCoordinates(ref, { scrollIntoView = false } = {}) {
      const el = refMap.get(ref);
      if (!el) return null;
      if (scrollIntoView) el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },
  };
})();
