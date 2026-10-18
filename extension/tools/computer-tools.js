// computer 拆出的顶层工具：screenshot / click / sleep。
// 与 computer 工具共用同一套实现（takeScreenshot / resolveClickPoint / dispatchClick 也一并搬来，
// background.js 的 computerDispatch 通过参数引用这里的实现），模型直接按工具名调用，省去选 action 的一步。
// 依赖通过参数注入：chrome、ok、err、ensureCdp、ensureCs、getElemCoords、refNotFound、
// toCss、captureScreenshot、shotScale、setDialogMode、clearDialogMode、appendDialogNotes、sleep。

export function createComputerTools({
  chrome, ok, err, ensureCdp, ensureCs, getElemCoords, refNotFound, toCss,
  captureScreenshot, shotScale, setDialogMode, clearDialogMode, appendDialogNotes, sleep,
}) {
  const send = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

  // computer 与 click 工具共用的坐标解析：ref 优先（跨 frame 握手取元素坐标），
  // 其次 coordinate（截图像素换算回 CSS 像素）。两者都没有时返回错误结果。
  async function resolveClickPoint(args, tabId) {
    if (args.ref) {
      await ensureCs(tabId);
      const c = await getElemCoords(tabId, args.ref);
      if (!c) return { error: err(refNotFound(args.ref)) };
      return { x: c.x, y: c.y };
    }
    if (args.coordinate) {
      const [x, y] = toCss(tabId, args.coordinate);
      return { x, y };
    }
    return { error: err('coordinate or ref required') };
  }

  // computer 与 click 工具共用的 CDP 点击序列：mouseMoved → mousePressed → mouseReleased，
  // clickCount 承载单击/双击/三击，button 映射到 Input.dispatchMouseEvent 的同名参数。
  async function dispatchClick(tabId, { x, y, button = 'left', clickCount = 1, modifiers = 0 }) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    await sleep(50);
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, modifiers });
    await sleep(50);
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, modifiers });
    if (button === 'right') await sleep(300);
  }

  // computer 的 screenshot action 与 screenshot 工具共用：截图并更新坐标换算比例
  async function takeScreenshot(tabId, opts) {
    await sleep(50);
    const { data, width, height, format, fullPage, scale } = await captureScreenshot(tabId, {
      quality: opts.quality, format: opts.format,
      fullPage: opts.fullPage, maxDimension: opts.maxDimension,
    });
    // 全页截图的坐标无法对应视口点击，不更新换算比例
    if (!fullPage) shotScale.set(tabId, scale);
    const note = !fullPage && scale < 1
      ? ` (page scaled ${scale.toFixed(2)}x; pass coordinates in this image's pixels)` : '';
    return ok([
      { type: 'text', text: `Screenshot ${width}x${height}${note}` },
      { type: 'image', data, mimeType: `image/${format}` },
    ]);
  }

  // ── 顶层工具 ─────────────────────────────────────────────────────────────────

  async function toolScreenshot(args) {
    const { tabId } = args;
    if (!tabId) return err('tabId is required');
    await ensureCdp(tabId);
    const t0 = setDialogMode(tabId, args);
    let result;
    try {
      result = await takeScreenshot(tabId, args);
    } finally {
      clearDialogMode(tabId);
    }
    return appendDialogNotes(tabId, t0, result);
  }

  async function toolClick(args) {
    const { tabId, ref, coordinate, button = 'left', double = false, triple = false } = args;
    if (!tabId) return err('tabId is required');
    if (!ref && !coordinate) return err('coordinate or ref required');
    await ensureCdp(tabId);
    const t0 = setDialogMode(tabId, args);
    try {
      const pt = await resolveClickPoint(args, tabId);
      if (pt.error) return appendDialogNotes(tabId, t0, pt.error);
      const clickCount = triple ? 3 : double ? 2 : 1;
      await dispatchClick(tabId, { x: pt.x, y: pt.y, button, clickCount });
      const [lx, ly] = coordinate || [pt.x, pt.y];
      const kind = clickCount === 3 ? 'Triple-click' : clickCount === 2 ? 'Double-click' : 'Click';
      return appendDialogNotes(tabId, t0, ok([{ type: 'text', text: `${kind} (${button}) at (${Math.round(lx)},${Math.round(ly)})` }]));
    } finally {
      clearDialogMode(tabId);
    }
  }

  async function toolSleep(args) {
    const { tabId, seconds } = args;
    if (!tabId) return err('tabId is required');
    await sleep(Math.min(seconds, 10) * 1000);
    return ok([{ type: 'text', text: `Waited ${seconds}s` }]);
  }

  return { toolScreenshot, toolClick, toolSleep, resolveClickPoint, dispatchClick, takeScreenshot };
}
