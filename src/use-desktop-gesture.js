import { useEffect, useRef, useState } from 'react';
import { MOUSE_DISTANCE, TOUCH_DISTANCE, LONG_PRESS_MS, EDGE_DWELL_MS, SWIPE_DISTANCE,
  moveTo, sameOrder, clampPage, targetIndex } from './layout.js';

/** One captured pointer owns a click, swipe, or drag until release/cancellation. */
export function useDesktopGesture({ viewportRef, gridRef, keys, columns, rows, capacity,
  page, pages, query, canSort, sizeToken, onPage, onCommit }) {
  const current = useRef();
  current.current = { keys, columns, rows, capacity, page, pages, query, canSort, onPage, onCommit };
  const gesture = useRef(null);
  const suppressUntil = useRef(0);
  const [drag, setDrag] = useState(null);
  const [preview, setPreview] = useState(null);
  const [edge, setEdge] = useState(0);

  function clearTimers(g) { clearTimeout(g?.holdTimer); clearTimeout(g?.edgeTimer); }
  function release(g) {
    if (viewportRef.current?.hasPointerCapture?.(g.pointerId))
      viewportRef.current.releasePointerCapture(g.pointerId);
  }
  function finish(commit = false) {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    clearTimers(g);
    if (g.dragging || g.moved) suppressUntil.current = Date.now() + 700;
    if (commit && g.dragging && !sameOrder(g.keys, g.preview)) current.current.onCommit(g.preview, g.key);
    release(g);
    setDrag(null); setPreview(null); setEdge(0);
  }
  function updateTarget(g) {
    const view = current.current;
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const index = targetIndex(rect, view.columns, view.rows, g.page, view.capacity,
      g.keys.length, g.x, g.y);
    g.preview = moveTo(g.keys, g.key, index);
    setPreview(g.preview);
    setDrag({ key: g.key, x: g.x, y: g.y });
  }
  function armEdge(g) {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const zone = Math.min(36, rect.width * .15);
    const direction = g.y >= rect.top && g.y <= rect.bottom
      ? g.x <= rect.left + zone ? -1 : g.x >= rect.right - zone ? 1 : 0 : 0;
    const view = current.current;
    const allowed = clampPage(g.page + direction, view.pages) !== g.page ? direction : 0;
    if (g.edge !== allowed) { clearTimeout(g.edgeTimer); g.edgeTimer = undefined; g.edge = allowed; setEdge(allowed); }
    if (!allowed || g.edgeTimer !== undefined) return;
    g.edgeTimer = setTimeout(() => {
      g.edgeTimer = undefined;
      if (gesture.current !== g) return;
      g.page = clampPage(g.page + allowed, current.current.pages);
      current.current.onPage(g.page);
      // Grid geometry is identical on every page, so the pointer remains captured.
      updateTarget(g);
      armEdge(g);
    }, EDGE_DWELL_MS);
  }
  function startDrag(g) {
    if (gesture.current !== g || !current.current.canSort || !g.key) return;
    g.dragging = true; g.moved = true;
    viewportRef.current?.setPointerCapture?.(g.pointerId);
    clearTimeout(g.holdTimer);
    suppressUntil.current = Date.now() + 700;
    updateTarget(g); armEdge(g);
  }
  function onPointerDown(event) {
    if (event.isPrimary === false) { finish(); return; }
    if (event.button !== 0 || gesture.current) return;
    const view = current.current;
    const tile = event.target.closest?.('[data-dsl-key]');
    const key = tile?.dataset.dslKey;
    const g = { pointerId: event.pointerId, type: event.pointerType,
      x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY,
      key, keys: [...view.keys], preview: [...view.keys], page: view.page,
      dragging: false, moved: false, edge: 0 };
    gesture.current = g;
    if (g.type !== 'mouse' && key && view.canSort) g.holdTimer = setTimeout(() => startDrag(g), LONG_PRESS_MS);
  }
  function onPointerMove(event) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    g.x = event.clientX; g.y = event.clientY;
    const distance = Math.hypot(g.x - g.startX, g.y - g.startY);
    if (!g.dragging && distance > (g.type === 'mouse' ? MOUSE_DISTANCE : TOUCH_DISTANCE)) {
      g.moved = true; clearTimeout(g.holdTimer);
      viewportRef.current?.setPointerCapture?.(g.pointerId);
      if (g.type === 'mouse' && g.key && current.current.canSort) startDrag(g);
    }
    if (g.dragging) { event.preventDefault(); updateTarget(g); armEdge(g); }
  }
  function onPointerUp(event) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    g.x = event.clientX; g.y = event.clientY;
    if (g.dragging) { event.preventDefault(); updateTarget(g); finish(true); return; }
    const dx = g.x - g.startX, dy = g.y - g.startY;
    if (g.type !== 'mouse' && Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.3) {
      g.moved = true;
      current.current.onPage(clampPage(g.page + (dx < 0 ? 1 : -1), current.current.pages));
      event.preventDefault();
    }
    finish();
  }
  // Order, search, entry, or geometry changes cancel the preview without writing.
  const orderToken = JSON.stringify(keys);
  useEffect(() => { finish(); }, [orderToken, query, columns, rows, sizeToken, canSort]);
  useEffect(() => () => {
    const g = gesture.current;
    gesture.current = null;
    clearTimers(g);
    if (g) release(g);
  }, []);
  return {
    drag, preview, edge,
    allowClick(event) {
      // Native keyboard button activation has detail=0 and remains available.
      if (event?.detail === 0) return true;
      return !gesture.current?.dragging && Date.now() >= suppressUntil.current;
    },
    cancel: () => finish(),
    handlers: { onPointerDown, onPointerMove, onPointerUp,
      onPointerLeave: () => { const g = gesture.current; if (g?.type === 'mouse' && !g.moved) finish(); },
      onPointerCancel: () => finish(),
      onLostPointerCapture: event => {
        // Touch starts with implicit capture on the tile. Its bubbling loss when
        // capture transfers to the viewport is not cancellation of our capture.
        if (event.target === viewportRef.current && gesture.current?.pointerId === event.pointerId) finish();
      },
      onContextMenu: event => { if (gesture.current) event.preventDefault(); },
      onDragStart: event => event.preventDefault(),
    },
  };
}
