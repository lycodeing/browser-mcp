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
    // 用 WeakRef 包裹，避免强引用阻止 DOM 元素被 GC（SPA 频繁更新 DOM 场景）
    refMap.set(ref, new WeakRef(el));
    elemMap.set(el, ref);
    return ref;
  }

  const INTERACTIVE = new Set(['a','button','input','select','textarea','details','summary']);
  const INTERACTIVE_ROLES = new Set(['button','link','checkbox','radio','tab','menuitem',
    'menuitemcheckbox','menuitemradio','switch','textbox','searchbox','combobox','option',
    'slider','spinbutton','treeitem']);
  const SKIP_TAGS = new Set(['script','style','noscript','head','meta','link','br','hr','template']);
  // 自身文本已由 innerText 完整表达，子孙中只保留可交互元素，避免文本逐层重复
  const ABSORB_TAGS = new Set(['a','button','h1','h2','h3','h4','h5','h6','label','summary','option','legend']);
  // 无文本也值得输出的结构节点，保留页面骨架
  const STRUCTURAL = new Set(['nav','main','header','footer','form','dialog','table','ul','ol']);
  const MAX_DOM_DEPTH = 300;

  const ROLE_BY_TAG = { a:'link', button:'button', input:'textbox', select:'combobox',
    textarea:'textbox', img:'img', h1:'heading', h2:'heading', h3:'heading',
    h4:'heading', h5:'heading', h6:'heading', ul:'list', ol:'list', li:'listitem',
    table:'table', nav:'navigation', main:'main', header:'banner', footer:'contentinfo',
    form:'form', dialog:'dialog' };

  function getRole(el, tag) {
    const ar = el.getAttribute('aria-role') || el.getAttribute('role');
    if (ar) return ar;
    if (tag === 'input') {
      const t = el.type?.toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
    }
    return ROLE_BY_TAG[tag] || tag;
  }

  function isInteractive(el, tag) {
    if (INTERACTIVE.has(tag) || el.getAttribute('tabindex') != null || el.onclick != null) return true;
    if (el.isContentEditable && el.getAttribute('contenteditable') != null) return true;
    const role = el.getAttribute('role');
    return role != null && INTERACTIVE_ROLES.has(role);
  }

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function getLabel(el) {
    const label = el.getAttribute('aria-label') || el.getAttribute('title') ||
      el.getAttribute('placeholder') || el.getAttribute('alt');
    return label ? label.trim().slice(0, 120) : '';
  }

  function getOwnText(el) {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue + ' ';
    return norm(s).slice(0, 120);
  }

  function walk(el, level, domDepth, ctx, absorbed) {
    if (ctx.full || !el || el.nodeType !== 1 || domDepth > MAX_DOM_DEPTH) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;

    // display:none / 完全透明的整棵子树不可见，直接剪枝
    const style = getComputedStyle(el);
    if (style.display === 'none' || Number(style.opacity) === 0) return;

    const interactive = isInteractive(el, tag);
    let line = null;

    if (style.visibility !== 'hidden') {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const explicitRole = el.getAttribute('role') || el.getAttribute('aria-role');
        const label = getLabel(el);
        const own = absorbed ? '' : getOwnText(el);
        const wanted = ctx.filter === 'interactive'
          ? interactive
          : interactive || (!absorbed && (explicitRole || STRUCTURAL.has(tag) || label || own));
        if (wanted) {
          const text = label || (ABSORB_TAGS.has(tag) ? norm(el.innerText).slice(0, 120) : own);
          const checked = (el.type === 'checkbox' || el.type === 'radio') ? ` checked=${el.checked}` : '';
          const value = (tag === 'input' || tag === 'textarea') && el.value ? ` value="${el.value.slice(0, 60)}"` : '';
          const disabled = el.disabled ? ' disabled' : '';
          line = `[${assignRef(el)}] ${getRole(el, tag)}${disabled}${checked}${value}${text ? ` "${text}"` : ''}`;
        }
      }
    }

    let childLevel = level;
    if (line !== null) {
      if (level > ctx.maxLevel) return;
      ctx.lines.push('  '.repeat(level) + line);
      ctx.chars += line.length + level * 2 + 1;
      if (ctx.chars > ctx.maxChars) { ctx.full = true; return; }
      childLevel = level + 1;
    }

    const childAbsorbed = absorbed || ABSORB_TAGS.has(tag);
    for (const child of el.children) walk(child, childLevel, domDepth + 1, ctx, childAbsorbed);
  }

  globalThis.__accessibilityTree = {
    generate(filter = 'all', maxDepth = 15, maxChars = 50000, refId = null) {
      const root = refId ? this.getElementByRef(refId) : document.body;
      if (refId && !root) return { tree: `[Error] Element not found: ${refId}`, elementCount: 0 };
      const ctx = { filter, maxLevel: maxDepth, maxChars, lines: [], chars: 0, full: false };
      walk(root || document.body, 0, 0, ctx, false);
      let tree = ctx.lines.join('\n');
      if (tree.length > maxChars) tree = tree.slice(0, tree.lastIndexOf('\n', maxChars));
      return { tree, elementCount: ctx.lines.length, truncated: ctx.full };
    },

    getElementByRef(ref) {
      const wr = refMap.get(ref);
      if (!wr) return null;
      const el = wr.deref();
      // 元素已被 GC 回收，清理死引用
      if (!el) { refMap.delete(ref); return null; }
      return el;
    },

    getElementCoordinates(ref, { scrollIntoView = false } = {}) {
      const el = this.getElementByRef(ref);
      if (!el) return null;
      if (scrollIntoView) el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },

    // 为指定元素分配或返回已有的 ref 字符串，供 page-bridge 等外部模块使用
    getOrAssignRef(el) {
      return assignRef(el);
    },
  };
})();
