/**
 * DSH 0.2.1-rc.5 compatibility adapter for the last docked tool's close.
 * There is no public close-policy hook in this release. Keep the one internal
 * read (the adopted session store) here, and navigate through the controller's
 * replacement path so resource cleanup, tab lifetimes and history stay native.
 */
export function installCloseToDesktop(sidebar) {
  if (typeof sidebar?.closeIn !== 'function' || typeof sidebar.openTabIn !== 'function'
      || !(sidebar.adopted instanceof Map)) {
    throw new Error('dsh-appview: unsupported DSH sidebar close contract (verified with 0.2.1-rc.5)');
  }
  const original = sidebar.closeIn;
  const descriptor = Object.getOwnPropertyDescriptor(sidebar, 'closeIn');
  let enabled = true;
  function closeIn(sessionId, tabId) {
    if (enabled) {
      const layout = sidebar.adopted.get(sessionId)?.store.getSnapshot().bySession?.[sessionId]?.layout;
      const tab = layout?.tabs?.[tabId];
      const panes = Object.values(layout?.nodes ?? {}).filter(node => node.kind === 'pane' && node.host === 'dock');
      if (layout?.expanded && tab && tab.kind !== 'guide' && panes.length === 1
          && panes[0].tabs.length === 1 && panes[0].tabs[0] === tabId) {
        // Replacement runs the tool owner's cleanup before one atomic commit.
        // It never enters the native last-close branch that resets mode/collapses.
        return sidebar.openTabIn(sessionId, 'guide', { replaceTab: tabId });
      }
    }
    return original.call(this, sessionId, tabId);
  }
  sidebar.closeIn = closeIn;
  return () => {
    enabled = false;
    // A later wrapper may retain this function: disable ours without removing it.
    if (sidebar.closeIn !== closeIn) return;
    if (descriptor) Object.defineProperty(sidebar, 'closeIn', descriptor);
    else delete sidebar.closeIn;
  };
}
