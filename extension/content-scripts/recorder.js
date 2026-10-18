// content-scripts/recorder.js
// Exposes globalThis.__recorder
// 操作录制器：document 捕获阶段拦截 click/input/keydown/change/submit，
// 事件归一为 { type, step } 上报给 handler（background 注入的转发闭包，经
// chrome.runtime.sendMessage 送回后台）。每个 frame 独立运行一份，
// 子 frame 的 frameId 由 background 在注入时通过 start 参数传入。

(function () {
  if (globalThis.__recorder) return;

  // keydown 只录导航键：普通字符输入已由 input 事件覆盖
  const NAV_KEYS = new Set(['Enter', 'Tab', 'Escape',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  const INPUT_DEBOUNCE_MS = 300;
  const HIGHLIGHT_MS = 2000;

  let isRecording = false;
  let onEvent = null;
  // pendingInput:{ step, timer } | null —— 同一元素的连续 input 300ms 静默后只发一次
  let pendingInput = null;
  let lastInputEl = null;

  // ── 元素识别 ────────────────────────────────────────────────────────────────

  function isInteractive(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select'
      || tag === 'textarea' || tag === 'form' || tag === 'label'
      || el.getAttribute('tabindex') != null || el.isContentEditable === true
      || el.getAttribute('role') != null;
  }

  function normText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  // 从 tag 推断语义 role，与 accessibility-tree 的映射保持一致方向
  function inferRole(tag, el) {
    if (tag === 'input') {
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      return 'textbox';
    }
    const map = {
      a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
      img: 'img', form: 'form', nav: 'navigation', main: 'main',
      h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
      h5: 'heading', h6: 'heading', ul: 'list', ol: 'list', li: 'listitem',
      table: 'table', header: 'banner', footer: 'contentinfo', dialog: 'dialog',
    };
    return map[tag] || tag;
  }

  // ── cssPath 构建 ────────────────────────────────────────────────────────────
  // 从元素向上逐层取 tag，同级存在多个相同 tag 时加 :nth-child(n)（按自己在
  // 父元素中的实际位置），遇 id 用 #id 并停止，最多 8 层。
  function buildCssPath(el) {
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 8; depth++) {
      if (cur === document.body || cur === document.documentElement) {
        parts.unshift(cur.tagName.toLowerCase());
        break;
      }
      if (cur.id) {
        parts.unshift(`#${cur.id}`);
        break;
      }
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        let sameIndex = -1;
        let sameCount = 0;
        for (const child of parent.children) {
          if (child.tagName === cur.tagName) {
            sameCount++;
            if (child === cur) sameIndex = sameCount;
          }
        }
        if (sameCount > 1) part += `:nth-child(${sameIndex})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  // ── target 描述 ─────────────────────────────────────────────────────────────

  function buildTargetDescriptor(el) {
    const tag = el.tagName.toLowerCase();
    const desc = { tag };

    const text = normText(el.innerText || el.textContent);
    if (text) desc.text = text.slice(0, 120);

    const aria = normText(el.getAttribute('aria-label') || el.getAttribute('title'));
    if (aria) desc.ariaLabel = aria.slice(0, 120);

    const ph = normText(el.getAttribute('placeholder'));
    if (ph) desc.placeholder = ph.slice(0, 120);

    const explicitRole = el.getAttribute('role');
    if (explicitRole) desc.role = normText(explicitRole);
    else desc.role = inferRole(tag, el);

    desc.cssPath = buildCssPath(el);

    if (typeof globalThis.__recorderFrameId === 'number') {
      desc.frameId = globalThis.__recorderFrameId;
    }
    return desc;
  }

  // ── 步骤归一 ────────────────────────────────────────────────────────────────
  // input/change → form_input（密码值脱敏）；click → click；
  // Enter → key（提交表单语义优先）；其余导航键 → key；submit → key Enter 兜底。
  function buildStep(e, el, target) {
    const ts = Date.now();
    const tag = el.tagName.toLowerCase();

    if (e.type === 'input' || e.type === 'change') {
      const value = el.type === 'password' ? '<REDACTED>'
        : String(el.value != null ? el.value : '');
      const label = target.placeholder || target.ariaLabel || target.text || tag;
      return {
        type: 'input',
        step: { tool: 'form_input', args: { target, value }, note: `填写「${label}」`, ts },
      };
    }

    if (e.type === 'click') {
      const label = target.text || target.ariaLabel || target.tag;
      return {
        type: 'click',
        step: { tool: 'click', args: { target }, note: `点击「${label}」`, ts },
      };
    }

    if (e.type === 'submit') {
      return { type: 'click', step: { tool: 'key', args: { key: 'Enter' }, note: '提交表单', ts } };
    }

    // keydown
    if (tag === 'form' && e.key === 'Enter') {
      return { type: 'keydown', step: { tool: 'key', args: { key: 'Enter' }, note: '提交表单', ts } };
    }
    const noteNames = { Enter: '按 Enter', Tab: '按 Tab', Escape: '按 Escape',
      ArrowUp: '按 ArrowUp', ArrowDown: '按 ArrowDown',
      ArrowLeft: '按 ArrowLeft', ArrowRight: '按 ArrowRight' };
    return {
      type: 'keydown',
      step: { tool: 'key', args: { key: e.key }, note: noteNames[e.key] || `按 ${e.key}`, ts },
    };
  }

  function emit(record) {
    try {
      if (onEvent) onEvent(record);
    } catch { /* handler 异常不能打断录制 */ }
  }

  function flushPendingInput() {
    if (!pendingInput) return;
    clearTimeout(pendingInput.timer);
    const step = pendingInput.step;
    pendingInput = null;
    lastInputEl = null;
    emit(step);
  }

  function debounceInput(step) {
    if (pendingInput) clearTimeout(pendingInput.timer);
    pendingInput = {
      step,
      timer: setTimeout(() => {
        const s = pendingInput?.step;
        pendingInput = null;
        lastInputEl = null;
        if (s) emit(s);
      }, INPUT_DEBOUNCE_MS),
    };
  }

  function handleEvent(e) {
    if (!isRecording || !onEvent) return;
    if (e.target == null || e.target.nodeType !== 1) return;

    if (e.type === 'keydown') {
      if (!NAV_KEYS.has(e.key)) return;
      const el = e.target;
      const tag = el.tagName.toLowerCase();
      if (!isInteractive(el)) return;
      // 输入框里的 Enter 表达的是"提交/确认"，由所在 form 的 submit 事件兜底，
      // 这里只录纯导航键（Tab/Escape/方向键）与非输入元素上的 Enter。
      if (e.key === 'Enter' && (tag === 'input' || tag === 'textarea')) return;
      flushPendingInput();
      const target = buildTargetDescriptor(el);
      emit(buildStep(e, el, target));
      return;
    }

    if (e.type === 'submit') {
      if (e.target.tagName.toLowerCase() !== 'form') return;
      flushPendingInput();
      const target = buildTargetDescriptor(e.target);
      emit(buildStep(e, e.target, target));
      return;
    }

    if (e.type === 'input' || e.type === 'change') {
      const el = e.target;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
      if (e.type === 'change' && tag !== 'select') return; // input 事件已覆盖，change 只兜底 select
      // 换了输入框：上一笔立即发出，避免 debounce 吞掉非连续输入
      if (pendingInput && lastInputEl && lastInputEl !== el) flushPendingInput();
      lastInputEl = el;
      const target = buildTargetDescriptor(el);
      debounceInput(buildStep(e, el, target));
      return;
    }

    if (e.type === 'click') {
      const el = e.target;
      if (!isInteractive(el)) {
        // 点击落在纯文本上时找最近的可交互祖先（label 包 input、span 套 button 的常见结构）
        let anc = el.parentElement;
        for (let i = 0; anc && i < 5 && !isInteractive(anc); i++) anc = anc.parentElement;
        if (!anc || !isInteractive(anc)) return;
        return handleEvent({ ...e, target: anc });
      }
      flushPendingInput();
      const target = buildTargetDescriptor(el);
      emit(buildStep(e, el, target));
    }
  }

  // ── 高亮注入 ────────────────────────────────────────────────────────────────
  // 截 GIF 帧前调用：红框标记点击位置、绿框标记输入位置，2 秒后自行消失。

  function ensureHighlightStyle() {
    if (document.getElementById('__bmcp-recorder-style')) return;
    const style = document.createElement('style');
    style.id = '__bmcp-recorder-style';
    style.textContent = '@keyframes __bmcp-highlight-fade{0%{opacity:1}60%{opacity:.85}100%{opacity:0}}';
    (document.head || document.documentElement).appendChild(style);
  }

  function injectHighlight(elOrRect, type) {
    let rect;
    if (elOrRect && typeof elOrRect.getBoundingClientRect === 'function') {
      const r = elOrRect.getBoundingClientRect();
      rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    } else if (elOrRect && typeof elOrRect === 'object') {
      rect = elOrRect;
    } else {
      return null;
    }
    ensureHighlightStyle();
    const div = document.createElement('div');
    const pad = 4;
    div.style.cssText = [
      'position:fixed',
      `left:${(rect.left || 0) - pad}px`,
      `top:${(rect.top || 0) - pad}px`,
      `width:${(rect.width || 0) + pad * 2}px`,
      `height:${(rect.height || 0) + pad * 2}px`,
      `border:3px solid ${type === 'input' ? '#22c55e' : '#ef4444'}`,
      'border-radius:4px',
      'pointer-events:none',
      'z-index:2147483647',
      `animation:__bmcp-highlight-fade ${HIGHLIGHT_MS}ms ease-out forwards`,
    ].join(';');
    (document.body || document.documentElement).appendChild(div);
    setTimeout(() => div.remove(), HIGHLIGHT_MS);
    return rect;
  }

  // ── 对外接口 ────────────────────────────────────────────────────────────────

  function start(handler) {
    if (typeof handler !== 'function') throw new Error('recorder.start requires an event handler function');
    flushPendingInput();
    onEvent = handler;
    isRecording = true;
    return true;
  }

  function stop() {
    // 停止前把 debounce 中的最后一笔输入发出，避免丢步骤
    flushPendingInput();
    isRecording = false;
    onEvent = null;
    return true;
  }

  const listeners = [['click', handleEvent], ['input', handleEvent],
    ['keydown', handleEvent], ['change', handleEvent], ['submit', handleEvent]];
  for (const [type, fn] of listeners) {
    document.addEventListener(type, fn, true);
  }

  globalThis.__recorder = {
    start,
    stop,
    get isRecording() { return isRecording; },
    injectHighlight,
  };
})();
