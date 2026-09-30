'use client';

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import Anser from 'anser';

/**
 * Structured log-event shape this view renders. A neutral, self-contained
 * contract — hosts map their own log stream onto it. `source` is a free
 * string the host defines (e.g. a primary source plus `plugin:<slug>`,
 * `browser`, … entries); designate one as primary via `primarySource`.
 */
export interface LogEvent {
  ts: string;
  source: string; // host-defined, e.g. 'app' | 'plugin:<slug>' | 'browser' | …
  level: 'debug' | 'info' | 'warn' | 'error' | 'decision' | 'iteration' | 'plan';
  msg: string;
  corrId?: string;
  attrs?: Record<string, unknown>;
}

export interface LogTab {
  /** Stable id used as the active-tab key. */
  id: string;
  /** Visible label. */
  label: string;
  /** Predicate over events. */
  filter: (e: LogEvent) => boolean;
  /** Optional count badge override (default: filtered.length). */
  count?: number;
}

export interface LogViewProps {
  events: LogEvent[];
  /** Override the tab strip; otherwise tabs are auto-derived from sources. */
  tabs?: LogTab[];
  /** Currently active tab id. Defaults to 'all'. */
  activeTabId?: string;
  onTabChange?: (id: string) => void;
  /**
   * Stable identifier for this view (e.g. harness slug). Used as a key in
   * permalink anchors and as a filename root for exports. Optional — when
   * absent, exports use 'log' and permalinks omit the harness segment.
   */
  contextId?: string;
  /**
   * Called when the user clicks "Load older". Host fetches from the
   * paginated history endpoint and prepends the resulting events to
   * the buffer. `before` is the ts of the oldest event currently in
   * view; the host should request events older than that.
   *
   * Return value indicates whether more history is available beyond
   * what was just fetched (drives the "Load older" button visibility).
   */
  onLoadOlder?: (before: string) => Promise<{ hasMore: boolean }>;
  /**
   * Render newest events at the top instead of the bottom. Auto-scroll
   * sticks to the top (index 0) instead of the bottom; "Load older" appears
   * at the bottom of the visible list. Default false (chronological).
   */
  newestFirst?: boolean;
  /**
   * Domain wiring for in-message clickable ids (e.g. `feature_x`). When
   * omitted, only URLs and file paths are linkified — no app-id links.
   */
  appLinks?: AppLinkConfig;
  /**
   * The "primary" source whose per-line source tag is hidden and which
   * gets its own filter tab. When omitted, every source shows its tag and
   * no extra tab is added (fully generic). E.g. set to `'harness'`.
   */
  primarySource?: string;
  /** Tab label for `primarySource`. Defaults to the capitalized source name. */
  primarySourceLabel?: string;
  /**
   * localStorage key prefix for pinned bookmarks (`<prefix>:<contextId>`).
   * Default `'logBookmarks'`.
   */
  bookmarkKeyPrefix?: string;
}

/** Host wiring for clickable in-message app ids — domain-specific, injected. */
export interface AppLinkConfig {
  /** Global RegExp matching clickable id tokens inside log text. Must have the `g` flag. */
  pattern: RegExp;
  /** Map a matched token to a link `{ kind, id }`. Default `{ kind: 'item', id: token }`. */
  resolve?: (token: string) => { kind: string; id: string };
  /** CustomEvent name dispatched on click for the host to route. Default `'log-link'`. */
  eventName?: string;
}

/** Resolved per-render config threaded to LogLine via context (no prop drilling). */
interface LogViewConfig {
  appIdPattern: RegExp | null;
  resolveAppId: (token: string) => { kind: string; id: string };
  appLinkEventName: string;
  primarySource: string | null;
}

const DEFAULT_LOG_VIEW_CONFIG: LogViewConfig = {
  appIdPattern: null,
  resolveAppId: (id) => ({ kind: 'item', id }),
  appLinkEventName: 'log-link',
  primarySource: null,
};

const LogViewConfigContext = createContext<LogViewConfig>(DEFAULT_LOG_VIEW_CONFIG);

function labelForLevel(level: LogEvent['level']): string {
  switch (level) {
    case 'iteration': return 'iter';
    case 'decision':  return 'decision';
    case 'plan':      return 'plan';
    case 'error':     return 'error';
    case 'warn':      return 'warn';
    case 'info':      return 'info';
    case 'debug':     return 'debug';
  }
}

function classNameForLevel(level: LogEvent['level']): string {
  return `kind-${level}`;
}

/** Format ISO ts as 'MM-DD HH:MM:SS' for the gutter. */
function formatTs(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return iso.slice(0, 14);
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/** Strip the source prefix off a plugin slug — 'plugin:@scope/foo' → 'foo'. */
function shortPluginName(source: string): string {
  if (!source.startsWith('plugin:')) return source;
  const slug = source.slice('plugin:'.length);
  const idx = slug.lastIndexOf('/');
  return idx >= 0 ? slug.slice(idx + 1) : slug;
}

/**
 * Patterns the linkifier recognizes inside log message content. Order
 * matters — first match wins per chunk so we don't double-wrap (e.g.
 * a URL that contains an absolute file path inside its query string).
 */
const URL_RE = /https?:\/\/[^\s<>"']+/g;
// Absolute file paths: /a/b/c or C:\a\b\c — followed by an optional :line:col
const PATH_RE = /\b([\/A-Z]:?[\w./\\-]+\.\w+)(?::(\d+)(?::(\d+))?)?\b/g;
// App-id linkification is host-supplied via `appLinks` (see AppLinkConfig);
// the engine itself recognizes no domain ids.

interface Segment {
  content: string;
  style?: React.CSSProperties;
  href?: string;
  /** When set, click target is local — UI handler dispatches a CustomEvent. */
  appLink?: { kind: string; id: string };
}

/**
 * Take Anser-tokenized parts (color/style chunks) and run each chunk's text
 * through the linkifier patterns, producing finer-grained Segment[]. Style
 * is preserved across the splits so a colored URL stays colored.
 */
function linkifyParts(
  parts: Array<{ content: string; style: React.CSSProperties }>,
  appIdPattern: RegExp | null,
  resolveAppId: (token: string) => { kind: string; id: string },
): Segment[] {
  const out: Segment[] = [];
  for (const part of parts) {
    if (!part.content) continue;
    const text = part.content;
    // Walk through the text, prioritizing URL matches, then paths, then ids.
    // Combined regex with alternation would be tidier but obscures the
    // priority logic — keep separate passes.
    const matches: Array<{ start: number; end: number; seg: Segment }> = [];
    for (const m of text.matchAll(URL_RE)) {
      const start = m.index ?? 0;
      matches.push({
        start,
        end: start + m[0].length,
        seg: { content: m[0], style: part.style, href: m[0] },
      });
    }
    // Skip path/id matches that overlap a URL.
    const overlaps = (s: number, e: number): boolean =>
      matches.some((mm) => !(e <= mm.start || s >= mm.end));
    for (const m of text.matchAll(PATH_RE)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      // Treat as a path only if the file extension looks plausible AND the
      // string contains a path separator. Otherwise it's a normal word.
      if (!/[\/\\]/.test(m[0])) continue;
      // Open-in-editor URL — code-server / vscode protocol.
      const href = `vscode://file${m[0]}`;
      matches.push({ start, end, seg: { content: m[0], style: part.style, href } });
    }
    if (appIdPattern) {
      for (const m of text.matchAll(appIdPattern)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (overlaps(start, end)) continue;
        const { kind, id } = resolveAppId(m[0]);
        matches.push({
          start, end,
          seg: { content: m[0], style: part.style, appLink: { kind, id } },
        });
      }
    }
    matches.sort((a, b) => a.start - b.start);

    // Stitch unmatched plain-text gaps in between.
    let cursor = 0;
    for (const m of matches) {
      if (m.start < cursor) continue; // overlapping — keep first
      if (m.start > cursor) {
        out.push({ content: text.slice(cursor, m.start), style: part.style });
      }
      out.push(m.seg);
      cursor = m.end;
    }
    if (cursor < text.length) {
      out.push({ content: text.slice(cursor), style: part.style });
    }
  }
  return out;
}

/**
 * Click handler for in-app id links. Dispatches a CustomEvent (name set by
 * the host via `appLinks.eventName`) the hosting shell can listen to and
 * route to its panel selectors.
 */
function emitAppLink(eventName: string, kind: string, id: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(eventName, { detail: { kind, id } }),
  );
}

interface LogLineProps {
  index: number;
  event: LogEvent;
  /** When >1, render a "× N" badge that toggles expansion via onToggleCollapse. */
  runLength?: number;
  collapsedKey?: string;
  onToggleCollapse?: (key: string) => void;
  /** Whether this line is pinned (bookmarked). */
  bookmarked?: boolean;
  onToggleBookmark?: (event: LogEvent) => void;
}

const LogLine = memo(function LogLine({ index, event, runLength, collapsedKey, onToggleCollapse, bookmarked, onToggleBookmark }: LogLineProps) {
  const { appIdPattern, resolveAppId, appLinkEventName, primarySource } = useContext(LogViewConfigContext);
  const segments = useMemo(() => {
    const ansi = Anser.ansiToJson(event.msg, { use_classes: false, remove_empty: true }).map((p) => ({
      content: p.content,
      style: {
        color: p.fg ? `rgb(${p.fg})` : undefined,
        background: p.bg ? `rgb(${p.bg})` : undefined,
        fontWeight: p.decoration === 'bold' ? 600 : undefined,
        fontStyle: p.decoration === 'italic' ? 'italic' : undefined,
        textDecoration: p.decoration === 'underline' ? 'underline' : undefined,
      } as React.CSSProperties,
    }));
    return linkifyParts(ansi, appIdPattern, resolveAppId);
  }, [event.msg, appIdPattern, resolveAppId]);

  const sourceTag = event.source === primarySource ? null : (
    <span className="h-log-source" title={event.source}>
      {shortPluginName(event.source)}
    </span>
  );

  return (
    <div className={`h-log-line ${event.level} ${classNameForLevel(event.level)}${bookmarked ? ' bookmarked' : ''}`}>
      <button
        type="button"
        className={`h-log-pin${bookmarked ? ' active' : ''}`}
        onClick={(ev) => { ev.stopPropagation(); onToggleBookmark?.(event); }}
        title={bookmarked ? 'Unpin bookmark' : 'Pin as bookmark'}
        tabIndex={-1}
      >{bookmarked ? '★' : '☆'}</button>
      <span className="h-log-no" aria-hidden="true">{String(index + 1).padStart(4, '0')}</span>
      <span className="h-log-ts">{formatTs(event.ts)}</span>
      {sourceTag}
      <span className={`h-log-tag ${event.level}`}>{labelForLevel(event.level)}</span>
      <span className="h-log-msg">
        {runLength && runLength > 1 && collapsedKey && onToggleCollapse ? (
          <button
            type="button"
            className="h-log-collapse-badge"
            onClick={() => onToggleCollapse(collapsedKey)}
            title={`Click to expand ${runLength} repeated lines`}
          >× {runLength}</button>
        ) : null}
        {segments.map((seg, i) => {
          if (seg.href) {
            return (
              <a
                key={i}
                href={seg.href}
                target={seg.href.startsWith('http') ? '_blank' : undefined}
                rel={seg.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                style={seg.style}
                className="h-log-link"
              >
                {seg.content}
              </a>
            );
          }
          if (seg.appLink) {
            const a = seg.appLink;
            return (
              <button
                key={i}
                type="button"
                style={seg.style}
                className={`h-log-link h-log-link-app h-log-link-${a.kind}`}
                onClick={(ev) => { ev.preventDefault(); emitAppLink(appLinkEventName, a.kind, a.id); }}
              >
                {seg.content}
              </button>
            );
          }
          return <span key={i} style={seg.style}>{seg.content}</span>;
        })}
      </span>
    </div>
  );
});

/**
 * Density-scrubber rendered above the virtualized list. Buckets the
 * filtered buffer into N columns by time, shades each column by event
 * count, and overlays errors as red ticks. Click a bucket to jump.
 *
 * Intentionally cheap: O(n) over events, no DOM per event — the bars
 * are <div>s with width % so a 5000-event buffer is still 60-80 bars.
 */
function TimelineScrubber({
  events,
  onSeek,
}: {
  events: LogEvent[];
  onSeek: (eventIndex: number) => void;
}): ReactElement | null {
  const buckets = useMemo(() => {
    if (events.length < 2) return null;
    const N_BUCKETS = 80;
    const tStart = Date.parse(events[0].ts);
    const tEnd = Date.parse(events[events.length - 1].ts);
    if (!Number.isFinite(tStart) || !Number.isFinite(tEnd) || tEnd <= tStart) return null;
    const span = tEnd - tStart;
    const bucketSize = Math.max(1, Math.ceil(span / N_BUCKETS));
    const out: Array<{ count: number; errors: number; firstIndex: number }> = [];
    let cursor = 0;
    for (let i = 0; i < N_BUCKETS; i++) {
      const bucketEnd = tStart + (i + 1) * bucketSize;
      let count = 0;
      let errors = 0;
      let firstIndex = cursor;
      while (cursor < events.length) {
        const ts = Date.parse(events[cursor].ts);
        if (ts > bucketEnd && i < N_BUCKETS - 1) break;
        if (count === 0) firstIndex = cursor;
        count += 1;
        if (events[cursor].level === 'error') errors += 1;
        cursor += 1;
      }
      out.push({ count, errors, firstIndex });
    }
    return out;
  }, [events]);

  if (!buckets || buckets.length === 0) return null;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div className="h-log-scrubber" role="presentation" aria-label="Log timeline">
      {buckets.map((b, i) => {
        const heightPct = b.count === 0 ? 0 : Math.max(8, (b.count / maxCount) * 100);
        const isErrorBucket = b.errors > 0;
        return (
          <button
            key={i}
            type="button"
            className={`h-log-scrubber-bar${isErrorBucket ? ' has-errors' : ''}`}
            style={{ height: `${heightPct}%` }}
            onClick={() => onSeek(b.firstIndex)}
            title={`${b.count} events${b.errors ? ` (${b.errors} errors)` : ''} — click to jump`}
            tabIndex={-1}
            disabled={b.count === 0}
          />
        );
      })}
    </div>
  );
}

/** Build the auto-derived tab strip from the events buffer. */
function deriveTabs(
  events: LogEvent[],
  primarySource: string | null,
  primarySourceLabel?: string,
): LogTab[] {
  const sources = new Set<string>();
  for (const e of events) sources.add(e.source);
  const pluginSources = Array.from(sources)
    .filter((s) => s.startsWith('plugin:'))
    .sort();
  const tabs: LogTab[] = [
    {
      id: 'all',
      label: 'All',
      filter: () => true,
      count: events.length,
    },
    // Primary-source tab — only when the host designates one.
    ...(primarySource
      ? [{
          id: primarySource,
          label: primarySourceLabel ?? primarySource.charAt(0).toUpperCase() + primarySource.slice(1),
          filter: (e: LogEvent) => e.source === primarySource,
        } as LogTab]
      : []),
    ...pluginSources.map<LogTab>((s) => ({
      id: s,
      label: shortPluginName(s),
      filter: (e) => e.source === s,
    })),
  ];
  return tabs;
}

/** Render a single LogEvent back to a tail-friendly text line for export. */
function eventToText(e: LogEvent, primarySource: string | null): string {
  const sourceTag = e.source === primarySource ? '' : `[${e.source}] `;
  return `[${e.ts}] ${sourceTag}${e.level.toUpperCase()}: ${e.msg}`;
}

/** Trigger a download of the given content as a file with the given name. */
function downloadAs(filename: string, mime: string, content: string): void {
  if (typeof window === 'undefined') return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

/** Copy content to the clipboard, falling back to a synthetic textarea on older browsers. */
async function copyToClipboard(content: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(content);
      return;
    } catch { /* fall through */ }
  }
  if (typeof document !== 'undefined') {
    const ta = document.createElement('textarea');
    ta.value = content;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
  }
}

export function LogView(props: LogViewProps) {
  const { events, tabs: tabsProp, activeTabId: activeTabIdProp, onTabChange, contextId, onLoadOlder, newestFirst = false, appLinks, primarySource = null, primarySourceLabel, bookmarkKeyPrefix = 'logBookmarks' } = props;
  const config = useMemo<LogViewConfig>(() => ({
    appIdPattern: appLinks?.pattern ?? null,
    resolveAppId: appLinks?.resolve ?? DEFAULT_LOG_VIEW_CONFIG.resolveAppId,
    appLinkEventName: appLinks?.eventName ?? DEFAULT_LOG_VIEW_CONFIG.appLinkEventName,
    primarySource,
  }), [appLinks, primarySource]);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const handleLoadOlder = async (): Promise<void> => {
    if (!onLoadOlder || loadingHistory || events.length === 0) return;
    setLoadingHistory(true);
    try {
      const r = await onLoadOlder(events[0].ts);
      setHasMoreHistory(r.hasMore);
    } catch { /* swallow — host shows toast */ }
    finally { setLoadingHistory(false); }
  };
  const [internalActive, setInternalActive] = useState<string>('all');
  const activeTabId = activeTabIdProp ?? internalActive;
  const setActiveTabId = (id: string): void => {
    setInternalActive(id);
    onTabChange?.(id);
  };

  const tabs = useMemo(() => tabsProp ?? deriveTabs(events, primarySource, primarySourceLabel), [tabsProp, events, primarySource, primarySourceLabel]);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const filtered = useMemo(
    () => activeTab ? events.filter(activeTab.filter) : events,
    [events, activeTab],
  );

  // Collapse runs of consecutive identical messages into one row that
  // can be expanded. Same source + same level + same msg → a "× N" badge.
  // Run length is capped at 100; runs longer than that get split so a
  // pathologically-spammy plugin can't put 5000 dupes in a single row.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const collapsed: Array<{ event: LogEvent; runLength: number; runStart: number }> = useMemo(() => {
    const out: Array<{ event: LogEvent; runLength: number; runStart: number }> = [];
    for (let i = 0; i < filtered.length; i++) {
      const e = filtered[i];
      const last = out[out.length - 1];
      const sameAsLast = last
        && last.event.source === e.source
        && last.event.level === e.level
        && last.event.msg === e.msg
        && last.runLength < 100;
      if (sameAsLast) {
        last.runLength += 1;
      } else {
        out.push({ event: e, runLength: 1, runStart: i });
      }
    }
    return out;
  }, [filtered]);

  // When a row is expanded, it contributes runLength events to the
  // virtualized list instead of one collapsed row. Build the actual
  // render list here. Index for the line number is the original event
  // index in the filtered buffer (so expanding doesn't renumber).
  const renderRows = useMemo(() => {
    type Row = { event: LogEvent; index: number; runLength: number; collapsedKey?: string };
    const rows: Row[] = [];
    for (const c of collapsed) {
      const key = `${c.runStart}:${c.event.ts}:${c.event.source}:${c.event.msg}`;
      if (c.runLength === 1 || expandedKeys.has(key)) {
        // Expanded — emit each event in the run.
        for (let i = 0; i < c.runLength; i++) {
          rows.push({
            event: filtered[c.runStart + i],
            index: c.runStart + i,
            runLength: 1,
            ...(c.runLength > 1 && i === 0 ? { collapsedKey: key } : {}),
          });
        }
      } else {
        rows.push({ event: c.event, index: c.runStart, runLength: c.runLength, collapsedKey: key });
      }
    }
    return newestFirst ? rows.slice().reverse() : rows;
  }, [collapsed, expandedKeys, filtered, newestFirst]);

  const toggleCollapsed = (key: string): void => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Pinned bookmarks: per-harness, persisted in localStorage. Bookmark key
  // is `${ts}:${source}:${level}:${msg.slice(0, 80)}` — readable + stable
  // across stream reconnects (events keep their ts when re-replayed).
  // Renders as a strip of pin chips above the log; click to jump.
  const bookmarkStorageKey = contextId ? `${bookmarkKeyPrefix}:${contextId}` : null;
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  useEffect(() => {
    if (!bookmarkStorageKey || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(bookmarkStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) setBookmarks(parsed.filter((x): x is string => typeof x === 'string'));
      }
    } catch { /* ignore corrupt storage */ }
  }, [bookmarkStorageKey]);
  const persistBookmarks = (next: string[]): void => {
    setBookmarks(next);
    if (bookmarkStorageKey && typeof window !== 'undefined') {
      try { window.localStorage.setItem(bookmarkStorageKey, JSON.stringify(next.slice(-50))); } catch { /* quota */ }
    }
  };
  const bookmarkKeyFor = (e: LogEvent): string =>
    `${e.ts}|${e.source}|${e.level}|${e.msg.slice(0, 80)}`;
  const toggleBookmark = (e: LogEvent): void => {
    const key = bookmarkKeyFor(e);
    if (bookmarks.includes(key)) {
      persistBookmarks(bookmarks.filter((k) => k !== key));
    } else {
      persistBookmarks([...bookmarks, key]);
    }
  };
  const bookmarkedEvents = useMemo(() => {
    if (bookmarks.length === 0) return [] as Array<{ key: string; event: LogEvent; index: number }>;
    const set = new Set(bookmarks);
    const out: Array<{ key: string; event: LogEvent; index: number }> = [];
    for (let i = 0; i < filtered.length; i++) {
      const k = bookmarkKeyFor(filtered[i]);
      if (set.has(k)) out.push({ key: k, event: filtered[i], index: i });
    }
    return out;
  }, [bookmarks, filtered]);

  const ref = useRef<VirtuosoHandle>(null);
  const atBottomRef = useRef(true);
  const [paused, setPaused] = useState(false);
  // Count of events arrived while paused — for the "147 new" pill.
  const lastSeenLengthRef = useRef(filtered.length);
  const [unseenCount, setUnseenCount] = useState(0);

  useEffect(() => {
    if (paused) {
      // Track how many new events have arrived since pause started.
      const delta = Math.max(0, filtered.length - lastSeenLengthRef.current);
      setUnseenCount(delta);
    } else {
      lastSeenLengthRef.current = filtered.length;
      setUnseenCount(0);
      if (atBottomRef.current && ref.current && renderRows.length > 0) {
        const targetIndex = newestFirst ? 0 : renderRows.length - 1;
        ref.current.scrollToIndex({ index: targetIndex, behavior: 'auto' });
      }
    }
  }, [filtered.length, paused, renderRows.length, newestFirst]);

  const onResume = (): void => {
    setPaused(false);
    lastSeenLengthRef.current = filtered.length;
    setUnseenCount(0);
    requestAnimationFrame(() => {
      if (ref.current && renderRows.length > 0) {
        const targetIndex = newestFirst ? 0 : renderRows.length - 1;
        ref.current.scrollToIndex({ index: targetIndex, behavior: 'auto' });
      }
    });
  };

  return (
    <LogViewConfigContext.Provider value={config}>
    <div className="h-log-container">
      <div className="h-log-tabs" role="tablist">
        {tabs.map((tab) => {
          const count = tab.count ?? events.filter(tab.filter).length;
          const isActive = tab.id === activeTab?.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`h-log-tab${isActive ? ' active' : ''}`}
              onClick={() => setActiveTabId(tab.id)}
            >
              {tab.label}
              <span className="h-log-tab-count">{count}</span>
            </button>
          );
        })}
        <div className="h-log-tabs-spacer" />
        <div className="h-log-toolbar">
          <button
            type="button"
            className="h-log-toolbar-btn"
            onClick={() => {
              const text = filtered.map((e) => eventToText(e, primarySource)).join('\n') + '\n';
              const name = `${contextId ?? 'log'}-${activeTab?.id ?? 'all'}.log`;
              downloadAs(name, 'text/plain', text);
            }}
            title="Download visible lines as text"
          >⬇ .log</button>
          <button
            type="button"
            className="h-log-toolbar-btn"
            onClick={() => {
              const lines = filtered.map((e) => JSON.stringify(e)).join('\n') + '\n';
              const name = `${contextId ?? 'log'}-${activeTab?.id ?? 'all'}.jsonl`;
              downloadAs(name, 'application/x-ndjson', lines);
            }}
            title="Download visible events as JSONL (preserves attrs/corrId)"
          >⬇ .jsonl</button>
          <button
            type="button"
            className="h-log-toolbar-btn"
            onClick={() => {
              if (typeof window === 'undefined') return;
              // Build a permalink that selects this tab + scrolls to the
              // top of the visible buffer's first event timestamp on load.
              const url = new URL(window.location.href);
              if (activeTab) url.searchParams.set('logTab', activeTab.id);
              if (filtered.length > 0) url.searchParams.set('logAt', filtered[0].ts);
              void copyToClipboard(url.toString());
            }}
            title="Copy a URL that opens this tab + scroll position"
          >🔗 Link</button>
          <button
            type="button"
            className={`h-log-pause-toggle${paused ? ' paused' : ''}`}
            onClick={() => (paused ? onResume() : setPaused(true))}
            title={paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
          >
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="h-empty">
          <span className="h-empty-icon">—</span>
          <span>{events.length === 0 ? 'waiting for log output…' : 'no events match this tab'}</span>
        </div>
      ) : (
        <div className="h-log-body">
          {bookmarkedEvents.length > 0 ? (
            <div className="h-log-bookmarks" aria-label="Pinned bookmarks">
              <span className="h-log-bookmarks-label">Pinned:</span>
              {bookmarkedEvents.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  className="h-log-bookmark-chip"
                  onClick={() => {
                    setPaused(true);
                    ref.current?.scrollToIndex({ index: b.index, align: 'center', behavior: 'smooth' });
                  }}
                  title={b.event.msg}
                >
                  <span className="h-log-bookmark-ts">{formatTs(b.event.ts).slice(6)}</span>
                  <span className="h-log-bookmark-msg">{b.event.msg.slice(0, 60)}</span>
                </button>
              ))}
            </div>
          ) : null}
          {onLoadOlder && hasMoreHistory ? (
            <button
              type="button"
              className="h-log-load-older"
              onClick={() => void handleLoadOlder()}
              disabled={loadingHistory}
            >
              {loadingHistory ? 'Loading older…' : '↑ Load older from history'}
            </button>
          ) : null}
          <TimelineScrubber
            events={filtered}
            onSeek={(eventIndex) => {
              setPaused(true);
              ref.current?.scrollToIndex({ index: eventIndex, align: 'center', behavior: 'smooth' });
            }}
          />
          <Virtuoso
            ref={ref}
            data={renderRows}
            className="h-log"
            style={{ height: '100%' }}
            {...(newestFirst
              ? { atTopStateChange: (atTop: boolean) => { atBottomRef.current = atTop; } }
              : { atBottomStateChange: (atBottom: boolean) => { atBottomRef.current = atBottom; } })}
            followOutput={newestFirst ? false : (paused ? false : 'smooth')}
            itemContent={(_, row) => {
              const isBookmarked = bookmarks.includes(bookmarkKeyFor(row.event));
              return (
                <LogLine
                  index={row.index}
                  event={row.event}
                  runLength={row.runLength}
                  {...(row.collapsedKey ? { collapsedKey: row.collapsedKey } : {})}
                  onToggleCollapse={toggleCollapsed}
                  bookmarked={isBookmarked}
                  onToggleBookmark={toggleBookmark}
                />
              );
            }}
          />
          {paused && unseenCount > 0 && (
            <button
              type="button"
              className="h-log-unseen-pill"
              onClick={onResume}
              title="Click to resume tailing"
            >
              ▼ {unseenCount} new event{unseenCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}
    </div>
    </LogViewConfigContext.Provider>
  );
}
