/** Shared by every guide tab in this client; the host is the authority. */
import { CHANNEL, RPC_PREFIX, entryKey, validSnapshot, sameOrder, reconcileOrder } from './layout.js';

export function createOrderStore(tabs, connection, modules) {
  const listeners = new Set();
  let state = { keys: [], revision: 0, ready: false, busy: false, error: '' };
  let disposed = false;
  let queue = Promise.resolve();
  let refreshPending = false;
  let refreshAgain = false;
  let controller = new AbortController();
  function publish(patch) {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  async function call(endpoint, payload) {
    const generationSignal = controller.signal;
    const request = new AbortController();
    const abort = () => request.abort();
    generationSignal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 10000);
    let result;
    try {
      result = await connection.rpc.call(CHANNEL, RPC_PREFIX + endpoint, payload, request.signal);
      if (generationSignal.aborted || disposed) throw new Error('Connection changed');
    } finally {
      clearTimeout(timeout);
      generationSignal.removeEventListener('abort', abort);
    }
    if (!result?.ok) {
      const error = new Error(result?.error?.message || 'Layout request failed');
      error.code = result?.error?.code;
      error.snapshot = result?.error?.details?.snapshot;
      throw error;
    }
    if (!validSnapshot(result.value)) throw new Error('Invalid host layout');
    return result.value;
  }
  function serial(operation) {
    const result = queue.then(() => disposed ? undefined : operation());
    queue = result.catch(() => {});
    return result;
  }
  function source() {
    const loading = modules?.entries?.state?.getSnapshot?.();
    const release = modules?.entries?.releaseChange?.getSnapshot?.();
    return {
      keys: tabs.guide().map(entryKey),
      settled: !loading?.syncing,
      prune: !loading?.failures?.length && !release,
    };
  }
  function refresh() {
    if (disposed) return queue;
    if (refreshPending) { refreshAgain = true; return queue; }
    refreshPending = true;
    return serial(async () => {
      try {
        let saved = await call('read', {});
        const live = source();
        // Never prune during boot, HMR, failed imports or a pending release change.
        if (live.settled) {
          const keys = reconcileOrder(saved.keys, live.keys, live.prune);
          if (!sameOrder(saved.keys, keys)) {
            try { saved = await call('sync', { revision: saved.revision, keys: live.keys, prune: live.prune }); }
            catch (error) {
              if (error.code !== 'conflict' || !validSnapshot(error.snapshot)) throw error;
              saved = error.snapshot;
            }
          }
        }
        const changed = !sameOrder(state.keys, saved.keys) || state.revision !== saved.revision;
        if (!state.busy && (changed || !state.ready || state.error)) publish({ ...saved, ready: true, error: '' });
      } catch {
        if (!state.busy) publish({ error: state.ready ? '顺序同步失败，点此重试' : '无法读取已保存顺序，点此重试' });
      } finally {
        refreshPending = false;
        if (refreshAgain) { refreshAgain = false; refresh(); }
      }
    });
  }
  function reorder(keys, key) {
    if (!state.ready || state.busy || state.error || sameOrder(keys, state.keys)) return;
    const original = { keys: state.keys, revision: state.revision };
    const index = keys.indexOf(key);
    const before = keys[index + 1] ?? null;
    publish({ keys, busy: true, error: '' });
    return serial(async () => {
      try {
        const saved = await call('move', { revision: original.revision, key, before });
        publish({ ...saved, ready: true, busy: false });
      } catch (error) {
        const conflict = error.code === 'conflict' && validSnapshot(error.snapshot);
        publish({ ...(conflict ? error.snapshot : original), busy: false,
          error: conflict ? '其他客户端已更新顺序，请重新拖动' : '排序未保存，已恢复原顺序；点此重试' });
      }
    });
  }
  const unsubscribers = [tabs.subscribe(refresh)];
  const moduleState = modules?.entries?.state;
  if (moduleState?.subscribe) unsubscribers.push(moduleState.subscribe(refresh));
  const releaseChange = modules?.entries?.releaseChange;
  if (releaseChange?.subscribe) unsubscribers.push(releaseChange.subscribe(refresh));
  if (connection.generation?.subscribe) unsubscribers.push(connection.generation.subscribe(() => {
    controller.abort(); controller = new AbortController(); refresh();
  }));
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('focus', refresh);
    unsubscribers.push(() => window.removeEventListener('focus', refresh));
  }
  const timer = setInterval(refresh, 3000);
  timer.unref?.();
  refresh();
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh, reorder,
    dispose() {
      disposed = true; controller.abort(); clearInterval(timer);
      for (const unsubscribe of unsubscribers) unsubscribe();
      listeners.clear();
    },
  };
}
