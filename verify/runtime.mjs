/** Isolated tests use the installed DSH 0.2.1-rc.5 implementations read-only. */
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as hostPlugin from '../lib/index.js';
export const packages = process.env.DSH_PACKAGES ?? (() => { throw new Error('Set DSH_PACKAGES to the @deepseek-ai directory of a DSH 0.2.1-rc.5 install'); })();
export const loadDsh = name => import(pathToFileURL(join(packages, name, 'lib/index.js')).href);
export async function createRuntime(directory) {
  await mkdir(directory, { recursive: true });
  const [{ Context }, { JsonStorageBackend }, { DomainFacility }, { HostConnectionService }] = await Promise.all([
    loadDsh('cordis'), loadDsh('dsh-storage-json'), loadDsh('dsh-storage-domain'), loadDsh('dsh-client-connection')]);
  const ctx = new Context();
  const routes = [];
  ctx.provide('webServer', { host: '127.0.0.1', protocol: 'http:', register(route) {
    routes.push(route);
    return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1); };
  } });
  const connection = new HostConnectionService(ctx, [], {
    // Fixture authentication only. Production always uses DSH's signed browser cookie.
    isAuthenticated: request => request.headers.cookie?.includes('appview-test=1'),
    authenticateApi: () => undefined,
  });
  const backend = new JsonStorageBackend(directory);
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } },
    emit() {}, logger: { warn() {}, error() {} } }, { backend: 'json' });
  ctx.provide('storageDomain', facility);
  const pluginFiber = ctx.plugin(hostPlugin);
  await pluginFiber.await();
  const disposePlugin = () => pluginFiber.dispose();
  return {
    ctx, connection, facility,
    get snapshot() { return facility.get('dsh_appview_layout').global.get(); },
    async route(req, res) {
      if (!req.url.startsWith('/api/')) return false;
      const admission = connection.admit(req);
      if (admission.rejection) { res.writeHead(admission.rejection); res.end(); return true; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method,
        headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const response = await connection.createSharedFetchHandler('/api').fetch(request, admission.peer);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return true;
    },
    async close() { await disposePlugin(); await facility.closeAll(); await backend.close(); await ctx.fiber.dispose(); },
  };
}
