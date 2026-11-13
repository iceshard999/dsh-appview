import assert from 'node:assert/strict';
import { installCloseToDesktop } from '../src/close-to-desktop.js';
let count = 0;
const ok = label => { count++; console.log(`✔ ${label}`); };
function layout(ids = ['tool'], mode = 'push') {
  return { expanded: true, mode, width: 493, height: 900,
    nodes: { main: { kind: 'pane', host: 'dock', tabs: [...ids] } },
    tabs: Object.fromEntries(ids.map(id => [id, { id, kind: id === 'guide' ? 'guide' : 'files' }])) };
}
function fixture(sessions = { current: layout() }) {
  const calls = [];
  const sidebar = {
    adopted: new Map(Object.entries(sessions).map(([id, value]) => [id, { store: { getSnapshot: () => ({ bySession: { [id]: { layout: value } } }) } }])),
    closeIn(sessionId, tabId) { calls.push(['close', this === sidebar, sessionId, tabId]); },
    openTabIn(sessionId, kind, options) { calls.push(['replace', this === sidebar, sessionId, kind, options]); },
    close(tabId) { return this.closeIn('current', tabId); },
  };
  return { sidebar, calls, dispose: installCloseToDesktop(sidebar) };
}
for (const mode of ['push', 'fullscreen']) {
  const value = layout(['tool'], mode), before = structuredClone(value);
  const f = fixture({ current: value });
  f.sidebar.close('tool');
  assert.deepEqual(f.calls, [['replace', true, 'current', 'guide', { replaceTab: 'tool' }]]);
  assert.deepEqual(value, before); // adapter never edits layout, size or mode itself
  f.dispose();
}
ok('the final docked tool closes through native replacement in ordinary and fullscreen modes; no layout mutation');
const multiple = fixture({ current: layout(['first', 'last']) });
multiple.sidebar.close('first');
assert.deepEqual(multiple.calls, [['close', true, 'current', 'first']]);
const value = multiple.sidebar.adopted.get('current').store.getSnapshot().bySession.current.layout;
value.nodes.main.tabs = ['last']; delete value.tabs.first;
multiple.sidebar.close('last');
assert.deepEqual(multiple.calls[1], ['replace', true, 'current', 'guide', { replaceTab: 'last' }]); multiple.dispose();
ok('remaining tabs use the original close; closing the final one chooses the desktop');
const split = layout(['first']);
split.nodes.second = { kind: 'pane', host: 'dock', tabs: ['second'] }; split.tabs.second = { id: 'second', kind: 'terminal' };
const fs = fixture({ current: split }); fs.sidebar.close('first');
assert.equal(fs.calls[0][0], 'close'); fs.dispose();
ok('closing a non-final split pane preserves the native merge/selection policy');
const floated = layout();
floated.nodes.float = { kind: 'pane', host: 'float', tabs: ['floating'] }; floated.tabs.floating = { id: 'floating', kind: 'terminal' };
const ff = fixture({ current: floated }); ff.sidebar.close('floating'); ff.sidebar.close('tool');
assert.equal(ff.calls[0][0], 'close'); assert.equal(ff.calls[1][0], 'replace'); ff.dispose();
ok('floating closes stay native and floating tabs do not hide the final docked-tool transition');
for (const [value, tabId] of [[{ ...layout(), expanded: false }, 'tool'], [layout(['guide']), 'guide'], [layout(), 'missing']]) {
  const f = fixture({ current: value }); f.sidebar.close(tabId); assert.equal(f.calls[0][0], 'close'); f.dispose();
}
const missing = fixture(); missing.sidebar.closeIn('unknown', 'tool'); assert.equal(missing.calls[0][0], 'close'); missing.dispose();
ok('collapsed surfaces, the desktop itself, missing tabs and unadopted sessions retain native behavior');
const other = layout(['background'], 'fullscreen'), current = layout(['current']);
const background = fixture({ current, other }); background.sidebar.closeIn('other', 'background');
assert.deepEqual(background.calls, [['replace', true, 'other', 'guide', { replaceTab: 'background' }]]);
assert.deepEqual(current, layout(['current'])); background.dispose();
ok('background closures target their own session and leave the foreground session alone');
const failure = fixture(), error = new Error('owner cleanup failed');
failure.sidebar.openTabIn = () => { throw error; };
assert.throws(() => failure.sidebar.close('tool'), value => value === error);
assert.deepEqual(failure.calls, []); failure.dispose();
ok('replacement/cleanup errors propagate without falling through to destructive native close');
const unload = fixture(), wrapped = unload.sidebar.closeIn;
const later = function(...args) { return wrapped.apply(this, args); };
unload.sidebar.closeIn = later; unload.dispose(); unload.dispose(); unload.sidebar.close('tool');
assert.equal(unload.sidebar.closeIn, later); assert.equal(unload.calls[0][0], 'close');
class Inherited { constructor() { this.adopted = new Map(); } closeIn() {} openTabIn() {} }
const inherited = new Inherited(), disposeInherited = installCloseToDesktop(inherited);
assert.equal(Object.hasOwn(inherited, 'closeIn'), true); disposeInherited();
assert.equal(Object.hasOwn(inherited, 'closeIn'), false);
ok('unload is idempotent, preserves later wrappers and restores inherited method ownership');
assert.throws(() => installCloseToDesktop({ closeIn() {} }), /unsupported DSH sidebar close contract/);
ok('an incompatible DSH contract fails explicitly instead of half-installing the adapter');
console.log(`Close-to-desktop check passed: ${count} checks verified.`);
