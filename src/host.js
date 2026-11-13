/** Host half: one durable domain per DSH instance, over the configured backend. */
import { custom } from 'zod/mini';
import { CHANNEL, RPC_PREFIX, validKeys, validSnapshot, sameOrder, reconcileOrder, moveBefore } from './layout.js';

export const inject = ['connection', 'storageDomain'];
export const layoutSpec = {
  name: 'dsh_appview_layout', version: 1, tables: {},
  global: { schema: custom(validSnapshot), initial: { revision: 0, keys: [] } },
};
const failure = (code, message, details = {}) => ({ ok: false, error: { code, message, details } });
const copy = snapshot => ({ revision: snapshot.revision, keys: [...snapshot.keys] });

/** Serialize reads, revision checks and durable writes together, not only file IO. */
export function createLayoutHandler(domain) {
  let chain = Promise.resolve();
  let closed = false;
  async function dispatch(endpoint, payload, signal, peer) {
    if (peer?.principal?.kind !== 'owner') return failure('forbidden', 'Owner access required');
    if (closed || signal?.aborted) return failure('unavailable', 'Layout service is unavailable');
    const current = domain.global.get();
    if (endpoint === 'read') return { ok: true, value: copy(current) };
    if (endpoint !== 'sync' && endpoint !== 'move') return failure('not-found', 'Unknown layout operation');
    if (!payload || !Number.isSafeInteger(payload.revision) || payload.revision < 0)
      return failure('invalid', 'A valid layout revision is required');
    if (payload.revision !== current.revision)
      return failure('conflict', 'Layout changed in another client', { snapshot: copy(current) });
    let keys;
    if (endpoint === 'sync') {
      if (!validKeys(payload.keys) || typeof payload.prune !== 'boolean') return failure('invalid', 'Invalid entry list');
      keys = reconcileOrder(current.keys, payload.keys, payload.prune);
      if (!validKeys(keys)) return failure('invalid', 'Entry list exceeds limits');
    } else {
      if (!current.keys.includes(payload.key) || payload.before === payload.key ||
          (payload.before !== null && !current.keys.includes(payload.before)))
        return failure('invalid', 'Invalid move target');
      keys = moveBefore(current.keys, payload.key, payload.before);
    }
    if (sameOrder(current.keys, keys)) return { ok: true, value: copy(current) };
    if (current.revision === Number.MAX_SAFE_INTEGER) return failure('unavailable', 'Layout revision limit reached');
    const next = { revision: current.revision + 1, keys };
    try {
      await domain.global.set(next);
      return { ok: true, value: copy(next) };
    } catch {
      return failure('storage', 'Unable to save layout on the host');
    }
  }
  return {
    handle(endpoint, payload, signal, peer) {
      const pending = chain.then(() => dispatch(endpoint, payload, signal, peer));
      chain = pending.catch(() => {});
      return pending;
    },
    async close() { closed = true; await chain; await domain.close(); },
  };
}

export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(layoutSpec);
  const service = createLayoutHandler(domain);
  const removeRoutes = [];
  try {
    for (const endpoint of ['read', 'sync', 'move']) {
      const method = RPC_PREFIX + endpoint;
      removeRoutes.push(ctx.connection.fetch.register({
        path: `${CHANNEL}/${method}`, methods: ['POST'], requestBody: 'buffered',
        async fetch(request) {
          // Exact routes run after DSH authentication and enforce owner access.
          if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
            return new Response('Expected JSON', { status: 415 });
          let body;
          try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
          if (body?.type !== 'client-request' || typeof body.rpcId !== 'string' ||
              !body.rpcId.length || body.rpcId.length > 256 || body.method !== method)
            return new Response('Invalid RPC envelope', { status: 400 });
          const result = await service.handle(endpoint, body.payload, request.signal, { principal: { kind: 'owner' } });
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result });
        },
      }));
    }
  } catch (error) {
    for (const remove of removeRoutes.reverse()) await remove();
    await service.close(); throw error;
  }
  let disposal;
  const dispose = () => disposal ??= (async () => {
    try { for (const remove of removeRoutes.reverse()) await remove(); } finally { await service.close(); }
  })();
  try { ctx.effect?.(() => dispose, 'dsh-appview: host layout service'); }
  catch (error) { await dispose(); throw error; }
  return dispose;
}
