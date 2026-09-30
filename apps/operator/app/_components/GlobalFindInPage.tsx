'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * App-wide find-in-page (Ctrl/⌘+F) — a browser-style find bar.
 *
 * Tauri webviews give no consistent native find (WebView2 yes, WKWebView /
 * WebKitGTK no) and there is no Tauri/wry/plugin API for it, so we own it.
 * `react-css-highlight` does the matching (TreeWalker + `Range` + the CSS
 * Custom Highlight API) within `<main>`; this component owns the bar UI,
 * active-match navigation, and scroll-to-match (see `lib/find-in-page/engine`).
 *
 * Mounted once at the app root (`apps/operator-vite/src/routes/__root.tsx`,
 * inside <NuqsAdapter>) alongside <GlobalCommandPalette/>, so Ctrl+F works on
 * EVERY route. Open-state lives in the URL (`?find=1`) via nuqs — deep-linkable
 * + agent-driveable, mirroring the palette's `?palette=1`. The live query is a
 * mid-edit draft (would lose on reload), so per CLAUDE.md it stays in useState.
 *
 * The `find.open` shortcut (`mod+f`, see lib/shortcut-registry.ts) reuses the
 * formerly-dead `feature.search-global` binding; shortcut-bus also id-claims it
 * so the webview's native find never shows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { useHighlight } from 'react-css-highlight';
import { useShortcutAction } from '../../lib/hotkeys';
import {
  HIGHLIGHT_NAME,
  collectOrderedRanges,
  setActiveHighlight,
  clearActiveHighlight,
  clearHighlight,
  scrollRangeIntoView,
  nextIndex,
  prevIndex,
  formatMatchLabel,
} from '@papercusp/operator-core/lib/find-in-page/engine';

const MAIN_SELECTOR = 'main[data-route-transition-page]';

export default function GlobalFindInPage() {
  const [open, setOpen] = useQueryState('find', parseAsBoolean.withDefault(false));
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [matchCount, setMatchCount] = useState(0);

  // <main> lives in state, not a ref: react-css-highlight's create-effect reads
  // `targetRef.current` only when its deps ([targetRef, isSupported]) change, so a
  // ref populated AFTER mount is never picked up. Holding the element in state and
  // handing the lib a fresh ref object per target makes that effect re-run once
  // <main> resolves. The detached fallback prevents the library's development
  // warning while the app shell is still resolving its routed <main>.
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
  const fallbackTarget = useMemo<HTMLElement | null>(
    () => (typeof document === 'undefined' ? null : document.createElement('div')),
    [],
  );
  const targetRef = useMemo(
    () => ({ current: mainEl ?? fallbackTarget }),
    [fallbackTarget, mainEl],
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rangesRef = useRef<Range[]>([]);
  // Only scroll the page when the user acted (typed / next / prev) — never on a
  // background repaint (e.g. streaming chat), which would yank the viewport.
  const pendingScrollRef = useRef(false);
  // The element focused before the bar opened, so Esc can restore it.
  const lastFocusRef = useRef<HTMLElement | null>(null);
  // Latest query for the MutationObserver (which closes over a stale value).
  const queryRef = useRef('');
  queryRef.current = query;

  // Apply the active-match highlight (+ optional scroll) for one index.
  const applyActive = useCallback((idx: number, scroll: boolean) => {
    const ranges = rangesRef.current;
    if (idx >= 0 && ranges[idx]) {
      setActiveHighlight(ranges[idx]);
      if (scroll) scrollRangeIntoView(ranges[idx]);
    } else {
      clearActiveHighlight();
    }
  }, []);

  // react-css-highlight repainted: re-read ranges from the registry, jump the
  // active match to the first, and scroll only if the user just acted.
  const onPaint = useCallback(() => {
    const ranges = collectOrderedRanges();
    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    const idx = ranges.length ? 0 : -1;
    setActiveIndex(idx);
    applyActive(idx, pendingScrollRef.current);
    pendingScrollRef.current = false;
  }, [applyActive]);

  const { isSupported, refresh } = useHighlight({
    search: open ? query : '',
    targetRef,
    highlightName: HIGHLIGHT_NAME,
    caseSensitive: false,
    maxHighlights: 2000,
    debounce: 120,
    onPaint,
  });

  // Keep refresh() reachable from the observer without re-subscribing.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Bind Ctrl/⌘+F. When already open, re-focus + select the input (browser
  // behaviour); otherwise remember focus and open. enableOnFormTags so it
  // fires while typing in the chat composer / vditor / any input.
  useShortcutAction(
    'find.open',
    () => {
      if (open) {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        lastFocusRef.current = (document.activeElement as HTMLElement) ?? null;
        void setOpen(true);
      }
    },
    { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  );

  // On open: resolve the <main> target and focus the input.
  useEffect(() => {
    if (!open) {
      setMainEl(null);
      return;
    }
    // The operator's routed <main> first; a host that mounts this bar without
    // the route-transition wrapper — the cloud portal, whose centre pane is a
    // plain `<main class="surface">` — falls back to its <main>, so the search
    // covers the page rather than the detached placeholder
    // (portal-global-shortcuts-2026-09-06 P-001).
    setMainEl(
      document.querySelector<HTMLElement>(MAIN_SELECTOR) ??
        document.querySelector<HTMLElement>('main'),
    );
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Re-run the search when the routed content changes (navigation, lazy loads)
  // so matches stay correct across route changes. Debounced; only while finding.
  useEffect(() => {
    if (!open || !mainEl || typeof MutationObserver === 'undefined') return;
    const main = mainEl;
    let t: ReturnType<typeof setTimeout> | undefined;
    const obs = new MutationObserver(() => {
      if (!queryRef.current) return;
      clearTimeout(t);
      t = setTimeout(() => refreshRef.current?.(), 150);
    });
    obs.observe(main, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      clearTimeout(t);
    };
  }, [open, mainEl]);

  const close = useCallback(() => {
    void setOpen(false);
    setQuery('');
    rangesRef.current = [];
    setMatchCount(0);
    setActiveIndex(-1);
    clearActiveHighlight();
    clearHighlight(HIGHLIGHT_NAME);
    const prev = lastFocusRef.current;
    if (prev && typeof prev.focus === 'function') prev.focus();
  }, [setOpen]);

  const goNext = useCallback(() => {
    setActiveIndex((i) => {
      const n = nextIndex(i, rangesRef.current.length);
      applyActive(n, true);
      return n;
    });
  }, [applyActive]);

  const goPrev = useCallback(() => {
    setActiveIndex((i) => {
      const p = prevIndex(i, rangesRef.current.length);
      applyActive(p, true);
      return p;
    });
  }, [applyActive]);

  // Clear highlights if the component ever unmounts while open.
  useEffect(() => () => {
    clearActiveHighlight();
    clearHighlight(HIGHLIGHT_NAME);
  }, []);

  if (!open) return null;

  return (
    <div className="pc-find" role="search" aria-label="Find in page">
      <svg
        className="pc-find__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        ref={inputRef}
        className="pc-find__input"
        type="text"
        value={query}
        spellCheck={false}
        placeholder="Find in page"
        aria-label="Find in page"
        onChange={(e) => {
          pendingScrollRef.current = true;
          setQuery(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) goPrev();
            else goNext();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      />
      {isSupported ? (
        <span
          className={`pc-find__count${matchCount === 0 && query ? ' pc-find__count--none' : ''}`}
          aria-live="polite"
        >
          {formatMatchLabel(activeIndex, matchCount)}
        </span>
      ) : (
        <span className="pc-find__note">Find isn’t supported in this webview</span>
      )}
      <span className="pc-find__sep" aria-hidden="true" />
      <Tooltip label="Previous match (Shift+Enter)"><button
        type="button"
        className="pc-find__btn"
        onClick={goPrev}
        disabled={matchCount === 0}
        aria-label="Previous match (Shift+Enter)"

      >
        ↑
      </button></Tooltip>
      <Tooltip label="Next match (Enter)"><button
        type="button"
        className="pc-find__btn"
        onClick={goNext}
        disabled={matchCount === 0}
        aria-label="Next match (Enter)"

      >
        ↓
      </button></Tooltip>
      <Tooltip label="Close find (Esc)"><button
        type="button"
        className="pc-find__btn"
        onClick={close}
        aria-label="Close find (Esc)"

      >
        ×
      </button></Tooltip>
    </div>
  );
}
