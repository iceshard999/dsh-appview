/**
 * Offline verification for dsh-appview.
 *
 * What this script proves without a browser or a live profile:
 *   1. `package.json` is a well-formed DSH client plugin manifest
 *      (`dsh.client.platform: 'web'`, `./client` export, `dsh.bundle.patch`,
 *      no runtime dependencies) and `cordis.patch.yml` inserts its loader row.
 *   2. The built bundle is a single `window.__ModuleLoader__.load({ id, factory })`
 *      row whose id is `dsh-appview`, and whose factory requests
 *      only DSH platform modules (react / react/jsx-runtime).
 *   3. `apply(ctx)` injects `slots` + `sidebarRightTabs`, calls
 *      `slots.inject('sidebar.right.tab.guide')`, and registers exactly one
 *      chain entry there whose `select(owner)` returns a non-null match — the
 *      chain contract that replaces the shipped guide body.
 *   4. Rendered with react-test-renderer: one tile per guide entry, registry
 *      titles as labels, entry icons plus the cube fallback, description in the
 *      tile's accessible name, new registrations appearing through
 *      `tabs.subscribe()`, and a tile click calling
 *      `tab.actions.openTab(kind, { replaceTab: true })`.
 *   5. The top search field filters the grid live: localized title,
 *      case-insensitive matching, description and provider/kind matching,
 *      multi-term AND, the no-match notice, the clear button and Escape.
 *   6. When a local copy of `@deepseek-ai/dsh-client-ui-slots` is found, the REAL
 *      SlotCore accepts the chain registration and its disposer withdraws it.
 *      (This host has only the older 0.2.0-rc.2 copy; the running app bundles
 *      0.2.1-rc.5. The older core is reported, never installed.)
 *
 * It does NOT prove: pixels in the running GUI, installation through
 * `dsh plugin --profile web add` into the real profile, or the laziness of the
 * live slot system. Those require the user's live DSH profile and were out of
 * this task's write scope.
 *
 * Run from the workspace root: node verify/slots-check.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { devRequire } from '../scripts/dev-deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = join(here, '..');
const pluginDir = workspace;
const bundlePath = join(pluginDir, 'lib', 'client.js');
const packageId = 'dsh-appview';
const guideSlot = 'sidebar.right.tab.guide';

/** Verified check names, in order. */
const verified = [];
/** Things this script deliberately cannot verify. */
const unverified = [];

/**
 * Record and print one passed check.
 * @param {string} name what was proven.
 * @param {string} [detail] supporting evidence.
 * @returns {void}
 */
function ok(name, detail) {
  verified.push(name);
  console.log(`✔ ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

/**
 * Record and print one skipped check.
 * @param {string} name what was not run.
 * @param {string} why why it was skipped.
 * @returns {void}
 */
function skip(name, why) {
  unverified.push(`${name} (${why})`);
  console.log(`○ SKIP ${name} — ${why}`);
}

// ── 1. Installable package shape ────────────────────────────────────────────
console.log('\n== 1. Installable package shape ==');
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
assert.equal(manifest.name, packageId);
assert.equal(manifest.version, '0.3.1');
assert.equal(manifest.type, 'module');
assert.equal(manifest.main, 'lib/index.js');
ok('package identity', `${manifest.name}@${manifest.version}, type module, main lib/index.js`);

assert.equal(manifest.exports['.'].default, './lib/index.js');
assert.equal(manifest.exports['./client'].default, './lib/client.js');
assert.equal(manifest.exports['./package.json'], './package.json');
ok('exports', '".", "./client", "./package.json"');

assert.equal(manifest.dsh.bundle.patch, 'cordis.patch.yml');
assert.equal(manifest.dsh.client.platform, 'web');
assert.deepEqual(manifest.dsh.client.external, []);
assert.ok(Array.isArray(manifest.dsh.client.inject) && manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'));
ok('DSH manifest', `dsh.client.platform web, inject ${JSON.stringify(manifest.dsh.client.inject)}, external [], dsh.bundle.patch cordis.patch.yml`);

for (const entry of ['lib', 'cordis.patch.yml', 'README.md']) assert.ok(manifest.files.includes(entry), `files misses ${entry}`);
assert.equal(manifest.dependencies, undefined);
assert.equal(manifest.peerDependencies, undefined);
ok('packed files + dependency-free', `files ${JSON.stringify(manifest.files)}, no dependencies/peerDependencies (compatibility check falls through)`);

const patchText = readFileSync(join(pluginDir, 'cordis.patch.yml'), 'utf8');
assert.match(patchText, new RegExp(`- insert:\\s*\\n\\s*- id: ${packageId}`));
assert.match(patchText, new RegExp(`name: '${packageId}'`));
ok('cordis.patch.yml', `inserts loader row id/name ${packageId}`);

const hostStub = readFileSync(join(pluginDir, 'lib', 'index.js'), 'utf8');
const host = await import(pathToFileURL(join(pluginDir, 'lib', 'index.js')).href);
assert.deepEqual(host.inject, ['connection', 'storageDomain']);
assert.equal(typeof host.apply, 'function');
ok('host layout service', 'requires connection + storageDomain; bundled without runtime npm dependencies');

// ── 2. Browser bundle loads like the page loads it ─────────────────────────
console.log('\n== 2. ModuleLoader bundle ==');
const react = devRequire('react');
const jsxRuntime = devRequire('react/jsx-runtime');
const reactDom = devRequire('react-dom');
const TestRenderer = devRequire('react-test-renderer');

const source = readFileSync(bundlePath, 'utf8');
assert.equal(source.match(/window\.__ModuleLoader__\.load\(/g).length, 1);

/** Style/head bookkeeping so style injection can be observed. */
const head = {
  children: [],
  appendChild(node) {
    this.children.push(node);
  },
};
const fakeDocument = {
  head,
  body: {},
  createElement(tag) {
    const node = {
      tagName: tag,
      dataset: {},
      textContent: '',
      removed: false,
      remove() {
        this.removed = true;
        const index = head.children.indexOf(this);
        if (index >= 0) head.children.splice(index, 1);
      },
    };
    return node;
  },
  querySelector(selector) {
    const matched = /style\[data-plugin="([^"]+)"\]/.exec(selector);
    if (matched === null) return null;
    return head.children.find((node) => node.tagName === 'style' && node.dataset.plugin === matched[1]) ?? null;
  },
};
const rows = [];
const fakeWindow = {
  __ModuleLoader__: {
    load(row) {
      rows.push(row);
    },
  },
  document: fakeDocument,
  location: { href: 'http://localhost/' },
  navigator: { language: 'zh-CN' },
};
new Function('window', 'document', source)(fakeWindow, fakeDocument);
assert.equal(rows.length, 1);
assert.equal(rows[0].id, packageId);
assert.equal(typeof rows[0].factory, 'function');
ok('bundle registers one ModuleLoader row', `id ${rows[0].id}`);

const requested = [];
const plugin = rows[0].factory((specifier) => {
  requested.push(specifier);
  if (specifier === 'react') return react;
  if (specifier === 'react/jsx-runtime') return jsxRuntime;
  if (specifier === 'react-dom') return reactDom;
  throw new Error(`unexpected module request: ${specifier}`);
});
const platformModules = ['react', 'react-dom', 'react/jsx-runtime'];
assert.ok(requested.every((specifier) => platformModules.includes(specifier)));
assert.equal(typeof plugin.apply, 'function');
ok('factory requests platform modules only', requested.join(', '));

assert.deepEqual([...plugin.inject].sort(), ['connection', 'modules', 'sidebarRight', 'sidebarRightTabs', 'slots']);
ok('Cordis inject list', JSON.stringify(plugin.inject));

// ── 3. apply(): chain registration into the guide slot ─────────────────────
console.log('\n== 3. apply() registers the chain entry ==');
const FilesIcon = ({ size = 26 }) => react.createElement('svg', { width: size, height: size, 'data-test-icon': 'files' });
const TerminalIcon = ({ size = 26 }) => react.createElement('svg', { width: size, height: size, 'data-test-icon': 'terminal' });
/** Fixture mirroring guide entries contributed by real tab types. */
function makeGuideEntries() {
  return [
    {
      id: 'workspace',
      providerId: '@deepseek-ai/dsh-client-ui-sidebar-files',
      kind: 'files',
      order: 10,
      title: () => '文件',
      description: () => '浏览工作区文件',
      icon: FilesIcon,
    },
    {
      id: 'new',
      providerId: '@deepseek-ai/dsh-client-ui-sidebar-terminal',
      kind: 'terminal',
      order: 20,
      title: () => '终端',
      description: () => '打开一个新的终端',
      icon: TerminalIcon,
    },
    {
      id: 'chat',
      providerId: 'dsh-qq-bot',
      kind: 'qq-bot',
      order: 30,
      title: () => 'QQ 机器人',
    },
  ];
}
let guideEntries = makeGuideEntries();
const listeners = new Set();
const tabsService = {
  guide: () => guideEntries,
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

let storedLayout = { revision: 0, keys: [] };
const hostService = host.createLayoutHandler({
  global: { get: () => storedLayout, set: async value => { storedLayout = structuredClone(value); } },
  close: async () => {},
});
const testConnection = { rpc: { call: async (channel, endpoint, payload) => {
  assert.equal(channel, '/api');
  return hostService.handle(endpoint.replace('dsh-appview/', ''), payload, undefined, { principal: { kind: 'owner' } });
} } };
const testModules = { entries: { state: { getSnapshot: () => ({ syncing: false, failures: [] }) } } };
const injectedSlots = [];
const registrations = [];
const fakeSlots = {
  inject: (name, callback) => {
    injectedSlots.push(name);
    return callback();
  },
  register: (definition, component) => {
    const record = { definition, component, disposed: false };
    registrations.push(record);
    return () => {
      record.disposed = true;
    };
  },
};
const ctx = {
  slots: fakeSlots,
  sidebarRightTabs: tabsService,
  sidebarRight: { adopted: new Map(), closeIn() {}, openTabIn() {} },
  connection: testConnection,
  modules: testModules,
  effect: (factory) => factory(),
};
const pluginDispose = plugin.apply(ctx);
assert.equal(typeof pluginDispose, 'function');
assert.deepEqual(injectedSlots, [guideSlot]);
ok('slots.inject called for the chain seat', injectedSlots[0]);

assert.equal(registrations.length, 1);
const registration = registrations[0];
assert.equal(registration.definition.name, guideSlot);
assert.equal(typeof registration.component, 'function');
ok('one registration', `${registration.definition.name} (component ${registration.component.name || 'anonymous'})`);

assert.equal(typeof registration.definition.select, 'function');
const ownerFixture = {};
const matched = registration.definition.select(ownerFixture);
assert.notEqual(matched, null);
assert.notEqual(matched, undefined);
assert.equal(typeof matched, 'object');
ok('chain select returns non-null', `select({}) -> ${JSON.stringify(matched)} (whatever the owner passes, this entry applies)`);

assert.equal(head.children.length, 1);
assert.equal(head.children[0].tagName, 'style');
assert.equal(head.children[0].dataset.plugin, packageId);
assert.match(head.children[0].textContent, /\.dsl-grid\{/);
ok('stylesheet injected once', `<style data-plugin="${packageId}"> with the launcher CSS`);

// ── 4. Render the launcher body with react-test-renderer ───────────────────
console.log('\n== 4. Render + interaction (react-test-renderer) ==');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = TestRenderer;

const openTabCalls = [];
const useTabInfo = () => ({
  sidebar: { expanded: true, fullscreen: false },
  panel: { id: 'main' },
  tab: {
    id: 'guide-tab',
    kind: 'guide',
    actions: {
      openTab: (kind, options) => openTabCalls.push({ kind, options }),
    },
  },
});
const LauncherBody = registration.component;
let tree;
await act(async () => {
  tree = TestRenderer.create(react.createElement(LauncherBody, { useTabInfo, matched, sessionId: 'session-poc' }));
});
const rootSection = tree.root.findByProps({ 'data-plugin': packageId });
assert.equal(rootSection.props['data-dsh-launcher'], 'grid');
assert.equal(rootSection.props['aria-label'], '应用桌面');
ok('launcher body renders', 'section[data-plugin][data-dsh-launcher=grid], aria-label 应用桌面');

/** @returns {import('react-test-renderer').ReactTestInstance[]} tile buttons in DOM order. */
function tiles() {
  return tree.root.findAll((node) => node.type === 'button' && node.props['data-dsl-tile'] !== undefined);
}
/** @returns {string[]} rendered tile labels in DOM order. */
function labels() {
  return tree.root
    .findAll((node) => node.props.className === 'dsl-label')
    .map((node) => node.children.join(''));
}
assert.equal(tiles().length, 3);
assert.deepEqual(labels(), ['文件', '终端', 'QQ 机器人']);
assert.deepEqual(tiles().map((node) => node.props['data-dsl-tile']), ['files', 'terminal', 'qq-bot']);
ok('one tile per guide entry, titles as labels', labels().join(' / '));

assert.equal(tree.root.findAll((node) => node.props['data-test-icon'] === 'files').length, 1);
assert.equal(tree.root.findAll((node) => node.props['data-test-icon'] === 'terminal').length, 1);
assert.equal(tree.root.findAll((node) => node.props['data-dsl-fallback'] === 'cube').length, 1);
ok('entry icons + cube fallback', '2 entry icons rendered at size 28, 1 icon-less entry got the cube glyph');

const first = tiles()[0];
assert.equal(first.props['aria-label'], '文件，浏览工作区文件');
assert.equal(first.props.title, '文件，浏览工作区文件');
const iconless = tiles()[2];
assert.equal(iconless.props['aria-label'], 'QQ 机器人');
ok('accessible name / tooltip', 'description appended to the title; icon-less entry falls back to its label');

await act(async () => {
  tiles()[0].props.onClick();
});
await act(async () => {
  tiles()[2].props.onClick();
});
assert.deepEqual(openTabCalls, [
  { kind: 'files', options: { replaceTab: true } },
  { kind: 'qq-bot', options: { replaceTab: true } },
]);
ok('tile click opens the type in place', "openTab('files', { replaceTab: true }), openTab('qq-bot', { replaceTab: true })");

// ── 5. Top search bar filters the grid ─────────────────────────────────────
console.log('\n== 5. Top search bar ==');
/** @returns {import('react-test-renderer').ReactTestInstance} the controlled search input. */
function searchInput() {
  return tree.root.findByProps({ 'data-dsl-search': '' });
}
/**
 * Type one query into the search field and let React commit.
 * @param {string} value next input value.
 * @returns {Promise<void>} resolves after the commit.
 */
async function typeQuery(value) {
  await act(async () => {
    searchInput().props.onChange({ target: { value } });
  });
}

assert.equal(rootSection.children[0].props.className, 'dsl-search');
assert.equal(searchInput().props.placeholder, '搜索插件或工具');
assert.equal(searchInput().props['aria-label'], '搜索插件或工具');
ok('search bar sits above the grid', 'section > role=search > input, placeholder/aria-label「搜索插件或工具」');

await typeQuery('终');
assert.equal(tiles().length, 1);
assert.deepEqual(labels(), ['终端']);
assert.equal(tree.root.findByProps({ 'data-dsl-count': 1 }).props['data-dsl-count'], 1);
ok('filters by localized title', '「终」→ 终端');

await typeQuery('QQ');
assert.deepEqual(labels(), ['QQ 机器人']);
ok('title matching is case-insensitive', '「QQ」→ QQ 机器人');

await typeQuery('浏览');
assert.deepEqual(labels(), ['文件']);
ok('filters by description', '「浏览」→ 文件');

await typeQuery('dsh-qq-bot');
assert.deepEqual(labels(), ['QQ 机器人']);
ok('filters by provider id / kind', '「dsh-qq-bot」→ QQ 机器人（providerId 命中）');

await typeQuery('文件 浏览');
assert.deepEqual(labels(), ['文件']);
await typeQuery('文件 终端');
assert.equal(tiles().length, 0);
assert.match(tree.root.findByProps({ role: 'status' }).children.join(''), /没有匹配/);
ok('multi-term AND + empty notice', '「文件 浏览」→ 文件；「文件 终端」→ 空结果提示');

await typeQuery('终');
await act(async () => {
  tree.root.findByProps({ 'data-dsl-search-clear': '' }).props.onClick();
});
assert.equal(searchInput().props.value, '');
assert.equal(tiles().length, 3);
ok('clear button restores every tile', '× → query empty, 3 tiles');

await typeQuery('终');
await act(async () => {
  searchInput().props.onKeyDown({ key: 'Escape', preventDefault() {} });
});
assert.equal(searchInput().props.value, '');
ok('Escape clears the query', 'Escape → query empty');

// A tab type registering later must appear without remounting the guide.
assert.equal(listeners.size, 2);
await act(async () => {
  guideEntries = [
    ...guideEntries,
    {
      id: 'browser',
      providerId: '@deepseek-ai/dsh-client-ui-sidebar-browser',
      kind: 'browser',
      order: 40,
      title: () => '浏览器',
    },
  ];
  for (const listener of [...listeners]) listener();
});
assert.equal(tiles().length, 4);
assert.ok(labels().includes('浏览器'));
ok('registry subscription keeps the grid live', 'a guide entry registered after mount rendered as a 4th tile');

await act(async () => {
  tree.unmount();
});
assert.equal(listeners.size, 1);
ok('unmount unsubscribes', 'view subscription removed; shared order remains active until plugin disposal');

pluginDispose();
assert.equal(listeners.size, 0);
assert.equal(registration.disposed, true);
assert.equal(head.children.length, 0);
ok('plugin disposer withdraws registration and styles', 'chain entry disposed, <style> removed');

// ── 6. Real SlotCore (older local copy), registration contract only ────────
console.log('\n== 6. Real SlotCore registration check (optional) ==');
/**
 * Locate a local `@deepseek-ai/dsh-client-ui-slots` ESM module. The running app
 * bundles the current core into the web frontend, so this host only carries an
 * older standalone copy; it is used read-only for the registration contract.
 * @returns {{ file: string, version: string, source: string } | undefined} located core.
 */
function findSlotCore() {
  const candidates = [];
  if (process.env.DSH_PACKAGES) candidates.push(process.env.DSH_PACKAGES);
  const npx = join(homedir(), '.npm', '_npx');
  try {
    for (const entry of readdirSync(npx)) candidates.push(join(npx, entry, 'node_modules', '@deepseek-ai'));
  } catch {
    /* no npx cache */
  }
  candidates.push(join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@deepseek-ai'));
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai');
  candidates.push('/usr/lib/node_modules/@deepseek-ai');
  for (const root of candidates) {
    for (const name of ['dsh-client-ui-slots', '.dsh-client-ui-slots-LGnfB7O2']) {
      const file = join(root, name, 'lib', 'index.js');
      if (!existsSync(file)) continue;
      const version = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8')).version;
      return { file, version, source: name === 'dsh-client-ui-slots' ? 'current package' : 'bundled archive copy' };
    }
  }
  return undefined;
}

const coreInfo = findSlotCore();
if (coreInfo === undefined) {
  skip('real SlotCore registration', 'no local @deepseek-ai/dsh-client-ui-slots found');
} else {
  const { SlotCore } = await import(pathToFileURL(coreInfo.file).href);
  const core = new SlotCore();
  const parentDispose = core.register(
    { name: 'root', children: { [guideSlot]: { kind: 'chain', scope: 'session' } } },
    () => null,
  );
  const realPlugin = rows[0].factory((specifier) => {
    if (specifier === 'react') return react;
    if (specifier === 'react/jsx-runtime') return jsxRuntime;
    if (specifier === 'react-dom') return reactDom;
    throw new Error(`unexpected module request: ${specifier}`);
  });
  const realRegistrations = [];
  const realCtx = {
    slots: {
      inject: (name, callback) => callback(),
      register: (definition, component) => {
        realRegistrations.push(definition);
        return core.register(definition, component);
      },
    },
    sidebarRightTabs: tabsService,
    sidebarRight: { adopted: new Map(), closeIn() {}, openTabIn() {} },
    connection: testConnection,
    modules: testModules,
    effect: (factory) => factory(),
  };
  const disposePlugin = realPlugin.apply(realCtx);
  const entries = core.entries(guideSlot);
  assert.equal(realRegistrations.length, 1);
  assert.equal(entries.length, 1);
  assert.equal(typeof entries[0].select, 'function');
  const realMatched = entries[0].select({});
  assert.notEqual(realMatched, null);
  assert.notEqual(realMatched, undefined);
  assert.equal(typeof entries[0].component, 'function');
  // Chain election as the renderer performs it: first non-null selector wins.
  const elected = entries.find((entry) => entry.select({}) !== null);
  assert.equal(elected, entries[0]);
  disposePlugin();
  assert.equal(core.entries(guideSlot).length, 0);
  parentDispose();
  ok(
    'real SlotCore (older copy) accepted the chain entry and withdrawal',
    `@deepseek-ai/dsh-client-ui-slots@${coreInfo.version} (${coreInfo.source}); select() elected the entry, disposer removed it`,
  );
  console.log(
    `  note: the running DSH build bundles SlotCore 0.2.1-rc.5 into the web frontend; this host's ` +
      `standalone copy is ${coreInfo.version}. The registration contract (select required, chain seat, disposer) is the part exercised.`,
  );
}

// ── Summary ────────────────────────────────────────────────────────────────
unverified.push('actual rendering inside the running DSH Web GUI (needs plugins page install + hard refresh; this task must not touch the live profile)');
unverified.push('`dsh plugin --profile web add` against the real ~/.dsh web profile (out of write scope)');
console.log('\n══════════════════════════════════════════');
console.log(`Slots check passed: ${verified.length} checks verified.`);
for (const item of unverified) console.log(`○ not verified here: ${item}`);
console.log('══════════════════════════════════════════');
