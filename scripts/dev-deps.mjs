import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

function candidates(specifier, ...roots) {
  return [specifier, ...roots.filter(Boolean).map(root => join(root, specifier))];
}

export function devRequire(specifier) {
  return require(devResolve(specifier));
}

export function devResolve(specifier) {
  for (const candidate of candidates(specifier, process.env.DSH_APPVIEW_DEV_NODE_MODULES, process.env.DSH_APPVIEW_DSH_NODE_MODULES)) {
    try { return require.resolve(candidate); } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error(`Cannot resolve ${specifier}; run npm install or set DSH_APPVIEW_DEV_NODE_MODULES`);
}
