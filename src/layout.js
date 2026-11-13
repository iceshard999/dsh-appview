/** Shared order and geometry rules. Only stable entry identities are persisted. */
export const CHANNEL = '/api';
export const RPC_PREFIX = 'dsh-appview/';
export const MAX_ENTRIES = 10000;
export const CELL_WIDTH = 84;
export const CELL_HEIGHT = 96;
export const COLUMN_GAP = 10;
export const ROW_GAP = 16;
export const MOUSE_DISTANCE = 6;
export const TOUCH_DISTANCE = 10;
export const LONG_PRESS_MS = 450;
export const EDGE_DWELL_MS = 650;
export const SWIPE_DISTANCE = 48;

export function entryKey(entry) {
  return JSON.stringify([entry.providerId, entry.id]);
}
export function validKeys(keys) {
  return Array.isArray(keys) && keys.length <= MAX_ENTRIES &&
    keys.every(key => typeof key === 'string' && key.length > 0 && key.length <= 2048) &&
    new Set(keys).size === keys.length;
}
export function validSnapshot(value) {
  return value !== null && typeof value === 'object' &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 && validKeys(value.keys);
}
export function sameOrder(a, b) {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}
export function reconcileOrder(saved, available, prune = true) {
  const live = new Set(available);
  const result = saved.filter(key => !prune || live.has(key));
  const known = new Set(result);
  for (const key of available) if (!known.has(key)) { result.push(key); known.add(key); }
  return result;
}
export function moveTo(order, key, index) {
  if (!order.includes(key)) return order;
  const next = order.filter(value => value !== key);
  next.splice(Math.max(0, Math.min(next.length, index)), 0, key);
  return next;
}
export function moveBefore(order, key, before) {
  const next = order.filter(value => value !== key);
  const index = before === null ? next.length : next.indexOf(before);
  return moveTo(order, key, index);
}
export function gridMetrics(width, height) {
  const columns = Math.max(1, Math.floor((width + COLUMN_GAP) / (CELL_WIDTH + COLUMN_GAP)));
  const rows = Math.max(1, Math.floor((height + ROW_GAP) / (CELL_HEIGHT + ROW_GAP)));
  return { columns, rows, capacity: columns * rows, fits: width >= CELL_WIDTH && height >= CELL_HEIGHT };
}
export function pageCount(length, capacity) { return Math.max(1, Math.ceil(length / capacity)); }
export function clampPage(page, pages) { return Math.max(0, Math.min(pages - 1, page)); }
export function targetIndex(rect, columns, rows, page, capacity, length, x, y) {
  const column = Math.max(0, Math.min(columns - 1, Math.floor((x - rect.left) / ((rect.width + COLUMN_GAP) / columns))));
  const row = Math.max(0, Math.min(rows - 1, Math.floor((y - rect.top) / (CELL_HEIGHT + ROW_GAP))));
  return Math.min(length - 1, page * capacity + row * columns + column);
}
