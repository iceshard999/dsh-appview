/** DSH AppView — responsive guide pages with a shared host-persisted order. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { entryKey, reconcileOrder, sameOrder, gridMetrics, pageCount, clampPage } from './layout.js';
import { createOrderStore } from './order-store.js';
import { useDesktopGesture } from './use-desktop-gesture.js';
import { installCloseToDesktop } from './close-to-desktop.js';
const PACKAGE_ID = 'dsh-appview';
const GUIDE_SLOT = 'sidebar.right.tab.guide';
const GUIDE_MATCHED = Object.freeze({ plugin: PACKAGE_ID, surface: 'launcher' });
const ACCENTS = ['#4f8ef7', '#34b37e', '#f2994a', '#a259e6', '#e75f5f', '#2fb6c4'];
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'connection', 'modules'];

function accentFor(kind) {
  let hash = 0;
  for (let index = 0; index < kind.length; index += 1) {
    hash = (hash * 31 + kind.charCodeAt(index)) >>> 0;
  }
  return ACCENTS[hash % ACCENTS.length];
}

/**
 * Decide whether one guide entry matches the search query.
 *
 * The haystack includes everything a user could reasonably remember about the
 * entry: its (localized) title and description, plus the stable kind, provider
 * package and entry id — so `qqbot`, `terminal` or `文件` all find their tile.
 * Several whitespace-separated terms must all match (AND).
 * @param {any} entry guide entry from the tab registry.
 * @param {string} query raw query; callers pass a trimmed, non-empty string.
 * @returns {boolean} whether the entry stays visible.
 */
function matchesQuery(entry, query) {
  const description = typeof entry.description === 'function' ? entry.description() : undefined;
  const haystack = [entry.title(), description, entry.kind, entry.providerId, entry.id]
    .filter((value) => value !== undefined && value !== null)
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== '')
    .every((token) => haystack.includes(token));
}

/**
 * Magnifier glyph for the search field.
 * @returns {import('react').ReactElement} decorative search icon.
 */
function SearchGlyph() {
  return (
    <svg
      className="dsl-searchIcon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m16.2 16.2 4.3 4.3" />
    </svg>
  );
}

/**
 * Clear (×) glyph for the search field.
 * @returns {import('react').ReactElement} decorative close icon.
 */
function ClearGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

/**
 * Render a guide entry's own icon component at the launcher size.
 * @param {{ icon?: import('react').ComponentType<any> }} entry guide entry.
 * @returns {import('react').ReactElement} the icon element.
 */
function EntryGlyph({ icon: Icon }) {
  if (typeof Icon === 'function') return <Icon size={28} />;
  return <CubeGlyph size={28} />;
}

/**
 * Placeholder glyph for entries that contribute no icon, in the spirit of the
 * shipped guide's cube.
 * @param {{ size?: number }} props glyph size in pixels.
 * @returns {import('react').ReactElement} decorative cube.
 */
function CubeGlyph({ size = 28 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-dsl-fallback="cube"
    >
      <path d="M12 2.9 20 7v10l-8 4.1L4 17V7l8-4.1Z" />
      <path d="M4 7l8 4.1L20 7M12 11.1v10" />
    </svg>
  );
}


function useGuideEntries(tabs) {
  const subscribe = useCallback(onChange => tabs.subscribe(onChange), [tabs]);
  const getSnapshot = useCallback(() => tabs.guide(), [tabs]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
function Tile({ entry, onOpen, dragging }) {
  const label = entry.title();
  const description = typeof entry.description === 'function' ? entry.description() : undefined;
  const accessibleName = description === undefined ? label : `${label}，${description}`;
  return (
    <button type="button" className="dsl-tile" data-dsl-tile={entry.kind} data-dsl-id={entry.id}
      data-dsl-key={entryKey(entry)} data-dsl-dragging={dragging || undefined} draggable={false}
      aria-label={accessibleName} title={accessibleName} style={{ '--dsl-accent': accentFor(entry.kind) }}
      onClick={event => onOpen(entry, event)}>
      <span className="dsl-plate" aria-hidden="true"><EntryGlyph icon={entry.icon} /></span>
      <span className="dsl-label">{label}</span>
    </button>
  );
}
function useViewportSize(ref) {
  const [size, setSize] = useState({ width: 360, height: 360 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      setSize(old => old.width === width && old.height === height ? old : { width, height });
    };
    measure();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref]);
  return size;
}
function Pager({ page, pages, onPage }) {
  const start = Math.max(0, Math.min(pages - 7, page - 3));
  const indicators = Array.from({ length: Math.min(7, pages) }, (_, i) => start + i);
  return (
    <nav className="dsl-pager" aria-label="应用分页">
      <button type="button" className="dsl-pageArrow" aria-label="上一页" disabled={page === 0} onClick={() => onPage(page - 1)}>‹</button>
      <div className="dsl-pageInfo">
        <div className="dsl-dots">{indicators.map(index => (
          <button type="button" className="dsl-dot" key={index} aria-label={`第 ${index + 1} 页`}
            aria-current={index === page ? 'page' : undefined} onClick={() => onPage(index)} />
        ))}</div>
        <span className="dsl-pageText" data-dsl-pages="" aria-live="polite">第 {page + 1} / {pages} 页</span>
      </div>
      <button type="button" className="dsl-pageArrow" aria-label="下一页" disabled={page + 1 === pages} onClick={() => onPage(page + 1)}>›</button>
    </nav>
  );
}
function makeLauncherBody(tabs, store) {
  function LauncherBody({ useTabInfo }) {
    const entries = useGuideEntries(tabs);
    const saved = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const [query, setQuery] = useState('');
    const [page, setPage] = useState(0);
    const viewportRef = useRef(null), gridRef = useRef(null);
    const size = useViewportSize(viewportRef);
    const metrics = gridMetrics(size.width, size.height);
    const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined;
    const trimmedQuery = query.trim();
    const byKey = new Map(entries.map(entry => [entryKey(entry), entry]));
    const keys = reconcileOrder(saved.keys, [...byKey.keys()]);
    const ordered = keys.map(key => byKey.get(key));
    const filtered = trimmedQuery === '' ? ordered : ordered.filter(entry => matchesQuery(entry, trimmedQuery));
    const pages = pageCount(filtered.length, metrics.capacity);
    const currentPage = clampPage(page, pages);
    const changePage = next => setPage(clampPage(next, pages));
    const canSort = metrics.fits && trimmedQuery === '' && saved.ready && !saved.busy && !saved.error && sameOrder(keys, saved.keys);
    const gesture = useDesktopGesture({ viewportRef, gridRef, keys, ...metrics,
      page: currentPage, pages, query: trimmedQuery, canSort, sizeToken: `${size.width}:${size.height}`,
      onPage: changePage, onCommit: store.reorder });
    const preview = gesture.preview ? gesture.preview.map(key => byKey.get(key)).filter(Boolean) : filtered;
    const visibleEntries = preview.slice(currentPage * metrics.capacity, (currentPage + 1) * metrics.capacity);
    useEffect(() => { if (page !== currentPage) setPage(currentPage); }, [page, currentPage]);
    function changeQuery(value) { setQuery(value); setPage(0); }
    function openEntry(entry, event) {
      if (!gesture.allowClick(event)) { event?.preventDefault(); return; }
      info?.tab?.actions?.openTab?.(entry.kind, { replaceTab: true });
    }
    const floating = gesture.drag ? byKey.get(gesture.drag.key) : undefined;
    return (
      <section className="dsl-root" data-plugin={PACKAGE_ID} data-dsh-launcher="grid"
        role="region" aria-label="应用桌面" data-dsl-capacity={metrics.capacity}
        data-dsl-columns={metrics.columns} data-dsl-rows={metrics.rows} data-dsl-page={currentPage}
        onKeyDown={event => { if (event.key === 'Escape' && gesture.drag) { event.preventDefault(); gesture.cancel(); } }}>
        <div className="dsl-search" role="search">
          <SearchGlyph />
          <input className="dsl-searchInput" data-dsl-search="" type="search" inputMode="search"
            autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="搜索插件或工具"
            aria-label="搜索插件或工具" value={query} onChange={event => changeQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape' && query !== '') { event.preventDefault(); changeQuery(''); } }} />
          {query === '' ? null : <button type="button" className="dsl-searchClear" data-dsl-search-clear=""
            aria-label="清除搜索" title="清除搜索（Esc）" onClick={() => changeQuery('')}><ClearGlyph /></button>}
        </div>
        <div ref={viewportRef} className="dsl-viewport" data-dsl-drag-active={!!gesture.drag} {...gesture.handlers}>
          {!metrics.fits ? <p className="dsl-empty" role="status">请增大面板以显示应用</p>
            : entries.length === 0 ? <p className="dsl-empty" role="status">还没有可打开的工具</p>
            : filtered.length === 0 ? <p className="dsl-empty" role="status">没有匹配「{trimmedQuery}」的工具</p>
            : <div ref={gridRef} className="dsl-grid" data-dsl-count={filtered.length}
                style={{ gridTemplateColumns: `repeat(${metrics.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${metrics.rows}, 96px)` }}>
                {visibleEntries.map(entry => <Tile key={entryKey(entry)} entry={entry} onOpen={openEntry}
                  dragging={gesture.drag?.key === entryKey(entry)} />)}
              </div>}
          {gesture.edge !== 0 && <span className={`dsl-edge ${gesture.edge > 0 ? 'dsl-edgeNext' : 'dsl-edgePrevious'}`} aria-hidden="true">{gesture.edge > 0 ? '›' : '‹'}</span>}
          {floating && <div className="dsl-floating" aria-hidden="true" style={{ left: gesture.drag.x - (viewportRef.current?.getBoundingClientRect().left ?? 0) - 42,
              top: gesture.drag.y - (viewportRef.current?.getBoundingClientRect().top ?? 0) - 33,
              '--dsl-accent': accentFor(floating.kind) }}>
            <span className="dsl-plate"><EntryGlyph icon={floating.icon} /></span><span className="dsl-label">{floating.title()}</span>
          </div>}
        </div>
        <footer className="dsl-footer">
          <Pager page={currentPage} pages={pages} onPage={changePage} />
          <div className="dsl-notice" aria-live="polite">
            {saved.error ? <button type="button" className="dsl-retry" onClick={store.refresh} title={saved.error}>{saved.error}</button>
              : saved.busy ? '正在保存排序…' : !saved.ready ? '正在读取排序…'
              : gesture.drag ? '松手放置 · 边缘停留翻页' : trimmedQuery !== '' ? '搜索结果' : ''}
          </div>
        </footer>
      </section>
    );
  }
  return LauncherBody;
}

const CSS = `.dsl-root{box-sizing:border-box;flex:1;height:100%;min-height:0;min-width:0;width:100%;display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px;color:var(--dsw-alias-label-primary,#1f2329);overflow:hidden;}
.dsl-search{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;max-width:720px;flex:none;height:40px;padding:0 10px 0 13px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-tertiary,#8a9099);}
.dsl-search:focus-within{border-color:var(--dsw-alias-brand-primary,#4f8ef7);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8ef7) 18%,transparent);}
.dsl-searchIcon{flex:none;width:16px;height:16px;}
.dsl-searchInput{flex:1;min-width:0;height:100%;padding:0;border:0;outline:0;background:transparent;font:inherit;font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary,#1f2329);}
.dsl-searchInput::placeholder{color:var(--dsw-alias-label-tertiary,#8a9099);}
.dsl-searchInput::-webkit-search-cancel-button{display:none;-webkit-appearance:none;}
.dsl-searchClear{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:999px;background:transparent;color:inherit;cursor:pointer;}
.dsl-searchClear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));}
.dsl-searchClear:focus-visible,.dsl-pageArrow:focus-visible,.dsl-dot:focus-visible,.dsl-retry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8ef7);outline-offset:1px;}
.dsl-viewport{position:relative;flex:1;min-height:0;width:100%;max-width:720px;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;}
.dsl-grid{position:absolute;top:50%;transform:translateY(-50%);width:100%;display:grid;gap:16px 10px;align-content:center;align-items:start;justify-items:stretch;}
.dsl-tile{appearance:none;-webkit-appearance:none;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:7px;width:100%;height:96px;min-width:0;margin:0;padding:2px;border:0;border-radius:18px;background:transparent;font:inherit;color:inherit;text-align:center;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:none;}
.dsl-tile:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8ef7);outline-offset:-2px;}
.dsl-plate{box-sizing:border-box;flex:none;width:66px;height:66px;display:flex;align-items:center;justify-content:center;border-radius:21px;color:var(--dsw-alias-label-secondary,#5b6472);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));background:color-mix(in srgb,var(--dsl-accent,#4f8ef7) 14%,var(--dsw-alias-bg-layer-1,rgba(127,127,127,.1)));border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));box-shadow:0 1px 2px rgba(0,0,0,.06);transition:transform 140ms ease,box-shadow 140ms ease;}
@media(hover:hover){.dsl-tile:hover .dsl-plate{transform:translateY(-1px);box-shadow:0 3px 8px rgba(0,0,0,.1);}}
.dsl-tile:active .dsl-plate{transform:scale(.94);}
.dsl-label{box-sizing:border-box;max-width:100%;padding:0 2px;font-size:12px;line-height:1.35;color:var(--dsw-alias-label-primary,#1f2329);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dsl-tile[data-dsl-dragging]{opacity:.28;outline:2px dashed var(--dsw-alias-brand-primary,#4f8ef7);outline-offset:-3px;}
.dsl-floating{position:absolute;z-index:3;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:7px;width:84px;filter:drop-shadow(0 5px 9px rgba(0,0,0,.22));}
.dsl-floating .dsl-plate{transform:scale(1.06);}
.dsl-edge{position:absolute;top:0;bottom:0;width:28px;display:flex;align-items:center;justify-content:center;z-index:2;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8ef7) 16%,transparent);border-radius:12px;color:var(--dsw-alias-brand-primary,#4f8ef7);font-size:28px;pointer-events:none;}
.dsl-edgeNext{right:0;}.dsl-edgePrevious{left:0;}
.dsl-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;margin:0;text-align:center;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a9099);}
.dsl-footer{width:100%;max-width:420px;flex:none;height:60px;display:flex;flex-direction:column;align-items:center;}
.dsl-pager{display:flex;align-items:center;justify-content:center;gap:16px;width:100%;height:40px;}
.dsl-pageArrow{appearance:none;flex:none;width:40px;height:38px;padding:0;border:0;border-radius:12px;background:transparent;color:inherit;font:inherit;font-size:24px;cursor:pointer;}
.dsl-pageArrow:disabled{opacity:.3;cursor:default;}.dsl-pageArrow:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}
.dsl-pageInfo{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:80px;}
.dsl-dots{display:flex;justify-content:center;gap:3px;height:14px;}
.dsl-dot{appearance:none;position:relative;width:14px;height:14px;padding:0;border:0;background:transparent;cursor:pointer;}
.dsl-dot:after{content:'';position:absolute;inset:4px;border-radius:999px;background:currentColor;opacity:.25;}
.dsl-dot[aria-current=page]:after{opacity:1;background:var(--dsw-alias-brand-primary,#4f8ef7);}
.dsl-pageText,.dsl-notice{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a9099);}
.dsl-notice{width:100%;height:20px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dsl-retry{appearance:none;border:0;padding:0;max-width:100%;background:transparent;font:inherit;color:var(--dsw-alias-label-secondary,#5b6472);cursor:pointer;text-decoration:underline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
@media(prefers-reduced-motion:reduce){.dsl-plate{transition:none;}.dsl-tile:hover .dsl-plate{transform:none;}}`;

function installStyles() {
  if (typeof document === 'undefined') return () => {};
  const selector = `style[data-plugin="${PACKAGE_ID}"]`;
  if (typeof document.querySelector === 'function' && document.querySelector(selector) !== null) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = PACKAGE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => {
    style.remove();
  };
}


export function apply(ctx) {
  const disposeClose = typeof ctx.effect === 'function'
    ? ctx.effect(() => installCloseToDesktop(ctx.sidebarRight), 'dsh-appview: close to desktop')
    : installCloseToDesktop(ctx.sidebarRight);
  const store = createOrderStore(ctx.sidebarRightTabs, ctx.connection, ctx.modules);
  const disposeStyles = typeof ctx.effect === 'function'
    ? ctx.effect(() => installStyles(), 'dsh-appview: desktop styles') : installStyles();
  ctx.effect?.(() => () => store.dispose(), 'dsh-appview: shared order');
  const disposeGuide = ctx.slots.inject(GUIDE_SLOT, () => ctx.slots.register(
    { name: GUIDE_SLOT, select: () => GUIDE_MATCHED }, makeLauncherBody(ctx.sidebarRightTabs, store)));
  return () => {
    store.dispose();
    try { disposeGuide?.(); } finally {
      try { disposeClose?.(); } finally { disposeStyles?.(); }
    }
  };
}
