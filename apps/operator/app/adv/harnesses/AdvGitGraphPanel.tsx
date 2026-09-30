'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * AdvGitGraphPanel — the /adv Git dock's commit-graph panel.
 *
 * Replaces the @papercusp/git-graph library's custom row list with the app's
 * RichGrid (per the user request "make the grid use richgrid"), while keeping
 * the branch-lane graph as the first column. We REUSE the lib's data + layout
 * + detail pieces (fetchGitLog / getCachedGitLog / assignLanes / laneColor /
 * CommitDetail) so this is a presentation swap, not a reimplementation:
 *
 *   commits → assignLanes() → RichGrid rows
 *   columns: [lane graph] [sha] [message + refs] [author] [time]
 *   row click → CommitDetail (inline drawer) below the grid.
 *
 * The lib's rail is a *per-row* set of vertical lane bars + a dot on the
 * commit's lane (no cross-row beziers), so it renders cleanly inside one cell.
 *
 * Toolbar carries search / limit / refresh. Bookmarks, the worktree selector,
 * and the top-authors rail from the old GitGraphPanel are intentionally not
 * carried over here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { useVirtualizer } from '@tanstack/react-virtual';
import { RefreshCw, Star } from 'lucide-react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import {
  CommitDetail,
  assignLanes,
  laneColor,
  fetchGitLog,
  getCachedGitLog,
  type Commit,
  type LaidOutCommit,
  type Worktree,
} from '@papercusp/git-graph';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { Select } from '../../harness/Select';
import { crossOriginUrl } from '@papercusp/operator-core/lib/cross-origin-url';

const LIMITS = [100, 300, 500, 1000] as const;
type GitFilter = 'all' | 'refs' | 'merges' | 'bookmarked';

const GIT_FILTERS: { id: GitFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'refs', label: 'Refs' },
  { id: 'merges', label: 'Merges' },
  { id: 'bookmarked', label: 'Stars' },
];

/* Per-scope commit bookmarks (stars), persisted to localStorage — ported
 * verbatim from the lib's GitGraphPanel so stars survive reloads. */
function bookmarkKey(scope: string): string {
  return `gitBookmarks.${scope}`;
}
function readBookmarks(scope: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(bookmarkKey(scope));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : []);
  } catch {
    return new Set();
  }
}
function writeBookmarks(scope: string, set: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(bookmarkKey(scope), JSON.stringify([...set]));
  } catch {
    /* quota / private mode — ignore */
  }
}

export function formatAge(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function refClass(ref: string): string {
  if (ref === 'HEAD' || ref.startsWith('HEAD ->')) return 'head';
  if (ref.startsWith('tag: ')) return 'tag';
  return 'branch';
}

export function refLabel(ref: string): string {
  return ref.replace(/^tag: /, '').replace(/^HEAD -> /, 'HEAD → ');
}

export function matchesCommit(commit: LaidOutCommit, needle: string): boolean {
  if (!needle) return true;
  const haystack = [commit.sha, commit.subject, commit.author, ...commit.refs].join(' ').toLowerCase();
  return haystack.includes(needle);
}

export function gitWindowLabel(limit: number): string {
  return `latest ${limit.toLocaleString('en-US')} commits`;
}

export default function AdvGitGraphPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const scope = `harness:${slug}`;

  const [limit, setLimit] = useState<number>(300);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<GitFilter>('all');
  const [reloadTick, setReloadTick] = useState(0);
  // URL-backed (not useState) so the diff is deep-linkable + agent/narrator
  // driveable via `ui:dispatch { set_url: { tab:'git', commit:'<sha>' } }`
  // (EI-1595) — the nuqs-everywhere rule for selection state.
  const [selectedSha, setSelectedSha] = useQueryState('commit', parseAsString);
  const [hoveredSha, setHoveredSha] = useState<string | null>(null);
  // Worktree filter (ported from the lib): scopes the log to one worktree's
  // branch/head. null = all worktrees.
  const [worktree, setWorktree] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
  const [bookmarked, setBookmarked] = useState<Set<string>>(() => readBookmarks(scope));
  const [commits, setCommits] = useState<Commit[] | null>(() =>
    slug ? getCachedGitLog(scope, limit, worktree) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const logUrl = `/api/harness/${slug}/git/log?limit=${limit}${
    worktree ? `&ref=${encodeURIComponent(worktree)}` : ''
  }`;

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setCommits(getCachedGitLog(scope, limit, worktree));
    setError(null);
    fetchGitLog(scope, limit, logUrl, worktree)
      .then((c) => { if (!cancelled) setCommits(c); })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [scope, slug, limit, reloadTick, logUrl, worktree]);

  // Worktrees for the dropdown (refreshed on a slow timer, like the lib).
  const worktreesUrl = `/api/harness/${slug}/git/worktrees`;
  useEffect(() => {
    if (!slug) return;
    let stop = false;
    const load = () => {
      fetch(worktreesUrl)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => { if (!stop && Array.isArray(d?.worktrees)) setWorktrees(d.worktrees); })
        .catch(() => { /* dropdown stays empty */ });
    };
    load();
    const t = window.setInterval(load, 30_000);
    return () => { stop = true; window.clearInterval(t); };
  }, [slug, worktreesUrl]);

  // Persist + prune bookmarks per scope.
  useEffect(() => { setBookmarked(readBookmarks(scope)); }, [scope]);
  useEffect(() => { writeBookmarks(scope, bookmarked); }, [scope, bookmarked]);

  const laidOut = useMemo(() => (commits ? assignLanes(commits) : []), [commits]);
  const laneCount = useMemo(
    () => Math.max(1, laidOut.reduce((max, c) => Math.max(max, c.lane + 1), 1)),
    [laidOut],
  );
  const railWidth = Math.max(18, laneCount * 10);

  const mergeCount = useMemo(() => laidOut.filter((c) => c.parents.length > 1).length, [laidOut]);
  const refCount = useMemo(() => laidOut.filter((c) => c.refs.length > 0).length, [laidOut]);
  const uniqueRefs = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of laidOut) for (const r of c.refs) { if (!seen.has(r)) { seen.add(r); out.push(r); } }
    return out;
  }, [laidOut]);
  const topAuthors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of laidOut) counts.set(c.author, (counts.get(c.author) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4);
  }, [laidOut]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () => laidOut
      .filter((c) => filter !== 'refs' || c.refs.length > 0)
      .filter((c) => filter !== 'merges' || c.parents.length > 1)
      .filter((c) => filter !== 'bookmarked' || bookmarked.has(c.sha))
      .filter((c) => matchesCommit(c, needle)),
    [laidOut, filter, bookmarked, needle],
  );

  const toggleBookmark = useCallback((sha: string) => {
    setBookmarked((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha); else next.add(sha);
      return next;
    });
  }, []);
  const resetFilters = useCallback(() => { setQuery(''); setFilter('all'); }, []);
  const applyQuery = useCallback((q: string) => { setQuery(q); setFilter('all'); }, []);

  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 14,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [visible, rowVirtualizer]);

  // Row backgrounds match the Features/Issues grids: selected → accent tint,
  // hovered → bg-3, otherwise undefined (RichGrid's default zebra stripe).
  const richGetRowBg = useMemo(
    () => (row: LaidOutCommit) => {
      if (row.sha === selectedSha) return 'color-mix(in oklab, var(--accent), transparent 80%)';
      if (row.sha === hoveredSha) return 'var(--bg-3)';
      return undefined;
    },
    [selectedSha, hoveredSha],
  );

  const columns = useMemo<ColumnDef<LaidOutCommit>[]>(() => [
    {
      key: 'star',
      header: '',
      headerText: '',
      width: '30px',
      cellStyle: { overflow: 'visible' },
      render: ({ row }) => {
        const on = bookmarked.has(row.sha);
        return (
          <button
            type="button"
            className={`pc-adv-gitgrid__star${on ? ' is-on' : ''}`}
            aria-label={on ? 'Remove bookmark' : 'Bookmark commit'}
            aria-pressed={on}
            onClick={(e) => { e.stopPropagation(); toggleBookmark(row.sha); }}
          >
            <Star size={12} aria-hidden fill={on ? 'currentColor' : 'none'} />
          </button>
        );
      },
    },
    {
      key: 'graph',
      header: '',
      headerText: '',
      width: `${railWidth}px`,
      cellStyle: { position: 'relative', overflow: 'visible' },
      render: ({ row }) => (
        <span className="pc-adv-gitgrid__rail" style={{ width: railWidth }} aria-hidden>
          {Array.from({ length: laneCount }).map((_, lane) => (
            <span
              key={lane}
              className={`pc-adv-gitgrid__lane${lane === row.lane ? ' is-active' : ''}`}
              style={{ left: lane * 10 + 7, background: laneColor(lane) }}
            />
          ))}
          <span
            className="pc-adv-gitgrid__dot"
            style={{ left: row.lane * 10 + 3, background: laneColor(row.lane) }}
          />
        </span>
      ),
    },
    {
      key: 'sha',
      header: 'SHA',
      headerText: 'SHA',
      width: '74px',
      toCopyText: (r) => r.sha,
      render: ({ row }) => <span className="pc-adv-gitgrid__sha">{row.sha.slice(0, 8)}</span>,
    },
    {
      key: 'message',
      header: 'Message',
      headerText: 'Message',
      width: 1,
      toCopyText: (r) => r.subject,
      render: ({ row }) => (
        <span className="pc-adv-gitgrid__msg">
          <span className="pc-adv-gitgrid__subject" title={row.subject}>{row.subject}</span>
          {row.parents.length > 1 ? <span className="pc-adv-gitgrid__merge">merge</span> : null}
          {row.refs.slice(0, 4).map((ref) => (
            <span key={ref} className={`pc-adv-gitgrid__ref is-${refClass(ref)}`}>{refLabel(ref)}</span>
          ))}
          {row.refs.length > 4 ? (
            <span className="pc-adv-gitgrid__ref-more">+{row.refs.length - 4}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'author',
      header: 'Author',
      headerText: 'Author',
      width: '120px',
      toCopyText: (r) => r.author,
      render: ({ row }) => <span className="pc-adv-gitgrid__author" title={row.author}>{row.author}</span>,
    },
    {
      key: 'time',
      header: 'When',
      headerText: 'When',
      width: '84px',
      align: 'right',
      render: ({ row }) => (
        <span className="pc-adv-gitgrid__time" title={new Date(row.ts).toLocaleString()}>
          {formatAge(row.ts)}
        </span>
      ),
    },
  ], [laneCount, railWidth, bookmarked, toggleBookmark]);

  if (!slug) {
    return <div className="pc-adv-gitgrid__empty">No harness slug in params.</div>;
  }

  return (
    <div className="pc-adv-gitgrid">
      <div className="pc-adv-gitgrid__bar">
        {worktrees && worktrees.length > 0 ? (
          <Select
            triggerClassName="pc-adv-gitgrid__limit pc-adv-gitgrid__worktree"
            value={worktree ?? '_all'}
            onChange={(value) => setWorktree(value === '_all' ? null : value)}
            ariaLabel="Filter commits by worktree"
            options={[
              { value: '_all', label: `All worktrees (${worktrees.length})` },
              ...worktrees.flatMap((w) => {
              const v = w.branch ?? w.head;
                if (!v) return [];
              const label =
                (w.branch ?? `${w.head.slice(0, 8)} (detached)`) +
                (w.bare ? ' (bare)' : '') +
                (w.locked ? ' 🔒' : '') +
                (w.prunable ? ' ⚠' : '');
                return [{ value: v, label }];
              }),
            ]}
          />
        ) : null}
        <input
          type="search"
          className="pc-adv-gitgrid__search"
          placeholder="Search SHA, message, author, ref…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query || filter !== 'all' ? (
          <button type="button" className="pc-adv-gitgrid__clear" onClick={resetFilters}>
            clear
          </button>
        ) : null}
        <Select
          triggerClassName="pc-adv-gitgrid__limit"
          value={String(limit)}
          onChange={(value) => setLimit(Number(value))}
          ariaLabel="Git history window"
          options={LIMITS.map((n) => ({ value: String(n), label: gitWindowLabel(n) }))}
        />
        <span
          className="pc-adv-gitgrid__count"
          aria-label={`${visible.length} matches in ${gitWindowLabel(limit)}`}
        >
          {visible.length} · {gitWindowLabel(limit)}
        </span>
        <button
          type="button"
          className="pc-adv-gitgrid__refresh"
          onClick={() => setReloadTick((n) => n + 1)}
          aria-label="Refresh git log"
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>

      <div className="pc-adv-gitgrid__filters" role="tablist" aria-label="Commit filter">
        {GIT_FILTERS.map((f) => {
          const count =
            f.id === 'all' ? laidOut.length
            : f.id === 'refs' ? refCount
            : f.id === 'merges' ? mergeCount
            : bookmarked.size;
          return (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className={`pc-adv-gitgrid__filter pc-adv-gitgrid__filter--${f.id}${filter === f.id ? ' is-active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}<span className="pc-adv-gitgrid__filter-count">{count}</span>
            </button>
          );
        })}
      </div>

      {uniqueRefs.length > 0 ? (
        <div className="pc-adv-gitgrid__refrail" aria-label="Refs">
          {uniqueRefs.slice(0, 8).map((ref) => (
            <Tooltip key={ref} label={`Filter by ${ref}`}><button

              type="button"
              className={`pc-adv-gitgrid__ref is-${refClass(ref)}`}
              onClick={() => applyQuery(ref)}

            >
              {refLabel(ref)}
            </button></Tooltip>
          ))}
        </div>
      ) : null}

      {topAuthors.length > 1 ? (
        <div className="pc-adv-gitgrid__authors" aria-label="Top authors">
          {topAuthors.map(([author, count]) => (
            <Tooltip key={author} label={`Filter by ${author}`}><button

              type="button"
              className="pc-adv-gitgrid__author-chip"
              onClick={() => applyQuery(author)}

            >
              <span>{author}</span><b>{count}</b>
            </button></Tooltip>
          ))}
        </div>
      ) : null}

      <div ref={scrollRef} className="pc-adv-gitgrid__list">
        {error ? (
          <div className="pc-adv-gitgrid__empty pc-adv-gitgrid__empty--err">Failed: {error}</div>
        ) : !commits ? (
          <div className="pc-adv-gitgrid__empty">Loading {slug}…</div>
        ) : (
          <RichGrid<LaidOutCommit>
            inline
            resizableColumns
            virtualMode={{
              virtualizer: rowVirtualizer,
              totalRows: visible.length,
              rowAt: (i) => visible[i],
            }}
            columns={columns}
            getRowId={(r) => r.sha}
            onRowClick={(r) => void setSelectedSha(r.sha)}
            onRowHover={(r) => setHoveredSha(r?.sha ?? null)}
            getRowBg={richGetRowBg}
            headerHeight={28}
            rowMinHeight={40}
            headerStyle={{
              background: 'var(--bg-2, rgba(255,255,255,0.045))',
              color: 'var(--fg-mute, #7f9bb4)',
              borderBottom: '1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%))',
              fontSize: 10,
              textTransform: 'uppercase',
            }}
            empty={<div className="pc-adv-gitgrid__empty">No commits match this view.</div>}
          />
        )}
      </div>

      {selectedSha ? (
        <div className="pc-adv-gitgrid__detail">
          <CommitDetail
            sha={selectedSha}
            showCommitUrl={(sha: string) => crossOriginUrl(`/api/harness/${slug}/git/show/${sha}`)}
            onClose={() => void setSelectedSha(null)}
            inline
          />
        </div>
      ) : null}

      <style>{`
        .pc-adv-gitgrid { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-1, #0b1220); }
        .pc-adv-gitgrid__bar {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 8px; flex-shrink: 0;
          border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        }
        .pc-adv-gitgrid__search {
          flex: 1; min-width: 0; min-height: 26px;
          padding: 0 9px; font: inherit; font-size: 12px;
          color: var(--fg); background: color-mix(in oklab, var(--bg-2), white 2%);
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%)); border-radius: 8px;
          outline: none;
        }
        .pc-adv-gitgrid__search:focus { border-color: var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%)); }
        .pc-adv-gitgrid__limit {
          min-height: 26px; font: inherit; font-size: 12px; color: var(--fg);
          background: color-mix(in oklab, var(--bg-2), white 2%);
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%)); border-radius: 8px;
          padding: 0 6px; cursor: pointer;
        }
        .pc-adv-gitgrid__count { font-size: 10px; color: var(--fg-mute); font-variant-numeric: tabular-nums; }
        .pc-adv-gitgrid__refresh {
          display: inline-flex; align-items: center; padding: 4px;
          color: var(--fg-mute); background: transparent; border: 0; border-radius: 4px; cursor: pointer;
        }
        .pc-adv-gitgrid__refresh:hover { color: var(--fg); }
        .pc-adv-gitgrid__worktree { max-width: 160px; }
        .pc-adv-gitgrid__clear {
          font-size: 11px; padding: 0 9px; min-height: 26px;
          color: var(--fg-mute); background: transparent;
          border: 1px solid var(--border, rgba(125,211,252,0.15)); border-radius: 8px; cursor: pointer;
        }
        .pc-adv-gitgrid__clear:hover { color: var(--fg); border-color: var(--border-strong, rgba(125,211,252,0.32)); }
        .pc-adv-gitgrid__filters {
          display: flex; gap: 4px; flex-wrap: wrap; flex-shrink: 0;
          padding: 6px 8px; border-bottom: 1px solid var(--border, rgba(125,211,252,0.15));
        }
        /* Per-filter tints: each chip carries a --chip-tint (faint on the idle
           border, strong fill when active) so the git filters are colour-coded —
           sky=all, teal=refs, violet=merges, amber=stars. */
        .pc-adv-gitgrid__filter {
          --chip-tint: var(--accent, #38bdf8);
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 11px; padding: 2px 9px; border-radius: 999px;
          border: 1px solid color-mix(in oklab, var(--chip-tint), transparent 80%); background: transparent;
          color: var(--fg-mute); cursor: pointer;
          transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .pc-adv-gitgrid__filter--all { --chip-tint: var(--accent-strong, var(--accent)); }
        .pc-adv-gitgrid__filter--refs { --chip-tint: #2dd4bf; }
        .pc-adv-gitgrid__filter--merges { --chip-tint: #a78bfa; }
        .pc-adv-gitgrid__filter--bookmarked { --chip-tint: #f59e0b; }
        .pc-adv-gitgrid__filter:hover { color: var(--fg); border-color: color-mix(in oklab, var(--chip-tint), transparent 45%); }
        .pc-adv-gitgrid__filter.is-active {
          color: var(--fg);
          background: color-mix(in oklab, var(--chip-tint), transparent 82%);
          border-color: color-mix(in oklab, var(--chip-tint), transparent 40%);
        }
        .pc-adv-gitgrid__filter-count { font-size: 9.5px; color: var(--fg-mute); font-variant-numeric: tabular-nums; }
        .pc-adv-gitgrid__filter.is-active .pc-adv-gitgrid__filter-count { color: color-mix(in oklab, var(--chip-tint), white 22%); }
        .pc-adv-gitgrid__refrail, .pc-adv-gitgrid__authors {
          display: flex; gap: 5px; flex-wrap: wrap; flex-shrink: 0;
          padding: 6px 8px; border-bottom: 1px solid var(--border, rgba(125,211,252,0.15));
          overflow-x: auto; scrollbar-width: thin;
        }
        .pc-adv-gitgrid__refrail .pc-adv-gitgrid__ref { cursor: pointer; }
        .pc-adv-gitgrid__author-chip {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 10.5px; padding: 2px 8px; border-radius: 999px;
          border: 1px solid var(--border, rgba(125,211,252,0.15));
          background: color-mix(in oklab, var(--bg-2), white 2%);
          color: var(--fg-dim); cursor: pointer; white-space: nowrap;
          transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .pc-adv-gitgrid__author-chip:hover { color: var(--fg); border-color: var(--border-strong, rgba(125,211,252,0.32)); }
        .pc-adv-gitgrid__author-chip b { color: var(--fg-mute); font-variant-numeric: tabular-nums; }
        .pc-adv-gitgrid__star {
          all: unset; box-sizing: border-box;
          display: inline-flex; align-items: center; justify-content: center;
          width: 100%; height: 100%; min-height: 24px; cursor: pointer;
          color: var(--fg-mute); transition: color 120ms ease;
        }
        .pc-adv-gitgrid__star:hover { color: var(--warn, #fbbf24); }
        .pc-adv-gitgrid__star.is-on { color: var(--warn, #fbbf24); }
        .pc-adv-gitgrid__list { flex: 1; min-height: 0; overflow: auto; }
        .pc-adv-gitgrid__rail { position: relative; display: block; height: 100%; min-height: 40px; flex-shrink: 0; }
        .pc-adv-gitgrid__lane {
          position: absolute; top: 0; bottom: 0; width: 2px; opacity: 0.4;
        }
        .pc-adv-gitgrid__lane.is-active { opacity: 0.85; }
        .pc-adv-gitgrid__dot {
          position: absolute; top: 50%; transform: translateY(-50%);
          width: 8px; height: 8px; border-radius: 50%;
          box-shadow: 0 0 0 2px var(--bg-1, #0b1220);
        }
        .pc-adv-gitgrid__sha {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 10.5px; color: var(--fg-mute);
        }
        .pc-adv-gitgrid__msg { display: inline-flex; align-items: center; gap: 6px; min-width: 0; width: 100%; }
        .pc-adv-gitgrid__subject {
          min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font-size: 12px; color: var(--fg);
        }
        .pc-adv-gitgrid__merge {
          flex-shrink: 0; padding: 1px 6px; border-radius: 999px; font-size: 9px; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0;
          color: var(--accent, #38bdf8);
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%);
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
        }
        .pc-adv-gitgrid__ref {
          flex-shrink: 0; padding: 1px 6px; border-radius: 999px; font-size: 9.5px; font-weight: 650;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap;
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          color: var(--fg-dim);
        }
        .pc-adv-gitgrid__ref.is-head {
          color: var(--good, #34d399);
          border-color: color-mix(in oklab, var(--good, #34d399), transparent 55%);
          background: color-mix(in oklab, var(--good, #34d399), transparent 88%);
        }
        .pc-adv-gitgrid__ref.is-tag {
          color: var(--warn, #fbbf24);
          border-color: color-mix(in oklab, var(--warn, #fbbf24), transparent 55%);
          background: color-mix(in oklab, var(--warn, #fbbf24), transparent 88%);
        }
        .pc-adv-gitgrid__ref.is-branch {
          color: var(--accent-strong, #7dd3fc);
          border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 90%);
        }
        .pc-adv-gitgrid__ref-more { flex-shrink: 0; font-size: 9.5px; color: var(--fg-mute); }
        .pc-adv-gitgrid__author {
          font-size: 11px; color: var(--fg-mute);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pc-adv-gitgrid__time { font-size: 10px; color: var(--fg-mute); font-variant-numeric: tabular-nums; }
        .pc-adv-gitgrid__detail {
          flex-shrink: 0; max-height: 46%; min-height: 0; overflow: auto;
          border-top: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          background: color-mix(in oklab, var(--bg-2), white 1%);
        }
        .pc-adv-gitgrid__empty { padding: 16px; font-size: 13px; color: var(--fg-mute); }
        .pc-adv-gitgrid__empty--err { color: var(--bad, #f87171); }
      `}</style>
    </div>
  );
}
