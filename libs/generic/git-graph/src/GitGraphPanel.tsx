'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { RefreshCw, Check, ChevronDown } from 'lucide-react';
import * as RS from '@radix-ui/react-select';
import { assignLanes, laneColor, type Commit, type LaidOutCommit } from './graphLayout';
import { CommitDetail } from './CommitDetail';
import { GitTooltip } from './GitTooltip';
import { fetchGitLog, getCachedGitLog } from './cache';

interface GitSelectOption { value: string; label: ReactNode; }

/** Local Radix Select wrapper. Mirrors apps/operator/app/harness/Select.tsx
 *  so the git panel matches the canonical input/select look without
 *  depending on the operator app. */
function GitSelect({
  value, onChange, options, ariaLabel, triggerClassName,
}: {
  value: string;
  onChange: (v: string) => void;
  options: GitSelectOption[];
  ariaLabel?: string;
  triggerClassName?: string;
}) {
  return (
    <RS.Root value={value} onValueChange={onChange}>
      <RS.Trigger aria-label={ariaLabel} className={triggerClassName ?? 'h-git-select-trigger'}>
        <RS.Value />
        <RS.Icon><ChevronDown size={11} /></RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content className="h-git-select-content" position="popper" sideOffset={4}>
          <RS.Viewport>
            {options.map((opt) => (
              <RS.Item key={opt.value} value={opt.value} className="h-git-select-item">
                <RS.ItemText>{opt.label}</RS.ItemText>
                <RS.ItemIndicator><Check size={11} /></RS.ItemIndicator>
              </RS.Item>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}

export interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
  isMain: boolean;
  lastCommitTs: number | null;
}
import './git-graph.css';

const LIMITS = [100, 300, 500, 1000] as const;
type GitFilter = 'all' | 'refs' | 'merges' | 'bookmarked';

function formatAge(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function refClass(ref: string): string {
  if (ref === 'HEAD' || ref.startsWith('HEAD ->')) return 'head';
  if (ref.startsWith('tag: ')) return 'tag';
  return 'branch';
}

function refLabel(ref: string): string {
  return ref.replace(/^tag: /, '').replace(/^HEAD -> /, 'HEAD → ');
}

function matchesCommit(commit: LaidOutCommit, needle: string): boolean {
  if (!needle) return true;
  const haystack = [commit.sha, commit.subject, commit.author, ...commit.refs].join(' ').toLowerCase();
  return haystack.includes(needle);
}

function bookmarkKey(scope: string): string {
  return `gitBookmarks.${scope}`;
}

function readBookmarks(scope: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(bookmarkKey(scope));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((sha) => typeof sha === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeBookmarks(scope: string, bookmarks: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(bookmarkKey(scope), JSON.stringify([...bookmarks]));
  } catch {}
}

function GitFilterButton({
  id, label, count, filter, setFilter,
}: {
  id: GitFilter;
  label: string;
  count: number;
  filter: GitFilter;
  setFilter: (filter: GitFilter) => void;
}) {
  const on = filter === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      className={`h-git-filter ${on ? 'on' : ''}`}
      onClick={() => setFilter(id)}
    >
      <span>{label}</span>
      <b>{count}</b>
    </button>
  );
}

function GitCommitRow({
  commit, laneCount, active, bookmarked, onSelect, onBookmark,
}: {
  commit: LaidOutCommit;
  laneCount: number;
  active: boolean;
  bookmarked: boolean;
  onSelect: (sha: string) => void;
  onBookmark: (sha: string) => void;
}) {
  const railWidth = Math.max(18, laneCount * 10);
  const dotLeft = commit.lane * 10 + 4;
  const color = laneColor(commit.lane);

  return (
    <div
      role="button"
      tabIndex={0}
      className={`h-git-row ${active ? 'is-active' : ''} ${bookmarked ? 'is-bookmarked' : ''}`}
      onClick={() => onSelect(commit.sha)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(commit.sha); }}
      title={`${commit.sha.slice(0, 12)} · ${commit.subject}`}
      aria-pressed={active}
    >
      <span className="h-git-rail" style={{ width: railWidth }}>
        {Array.from({ length: laneCount }).map((_, lane) => (
          <span
            key={lane}
            className={`h-git-lane${lane === commit.lane ? ' active' : ''}`}
            style={{ left: lane * 10 + 7, background: laneColor(lane) }}
          />
        ))}
        <span className="h-git-dot" style={{ left: dotLeft, background: color }} />
      </span>

      <span className="h-git-row-body">
        <span className="h-git-subject">{commit.subject}</span>
        <span className="h-git-meta">
          <span>{commit.sha.slice(0, 8)}</span>
          <span>{commit.author}</span>
          <time dateTime={new Date(commit.ts).toISOString()} title={formatTime(commit.ts)}>{formatAge(commit.ts)}</time>
          {commit.parents.length > 1 && <span className="h-git-merge">merge</span>}
        </span>
        {commit.refs.length > 0 && (
          <span className="h-git-refs" aria-label="Git references">
            {commit.refs.slice(0, 4).map((ref) => (
              <span key={ref} className={`h-git-ref ${refClass(ref)}`}>{refLabel(ref)}</span>
            ))}
            {commit.refs.length > 4 && <span className="h-git-ref muted">+{commit.refs.length - 4}</span>}
          </span>
        )}
      </span>
      <button
        type="button"
        className={`h-git-row-bookmark ${bookmarked ? 'on' : ''}`}
        aria-label={`${bookmarked ? 'Remove' : 'Add'} bookmarked commit ${commit.sha.slice(0, 8)}`}
        onClick={(e) => {
          e.stopPropagation();
          onBookmark(commit.sha);
        }}
      >
        ★
      </button>
    </div>
  );
}

export interface GitGraphPanelProps {
  /** Stable cache + bookmark key (e.g. `harness:sheets`, `restart-main`). */
  scope: string;
  /** Build the URL for fetching git log. `ref` is null for all worktrees, or a branch name / sha. */
  gitLogUrl: (limit: number, ref: string | null) => string;
  /** Build the URL for fetching one commit's diff/patch detail. */
  showCommitUrl: (sha: string) => string;
  /** Optional builder for an external commit-view link (e.g. github.com/.../commit/SHA). */
  remoteCommitUrl?: (sha: string) => string;
  /** Optional: short title for the panel header (defaults to "git"). */
  title?: string;
  /** Optional: poll interval in ms; if set, refetch every N ms. */
  pollIntervalMs?: number;
  /**
   * Optional: when set, adds a worktree filter dropdown to the toolbar.
   * Selecting an entry filters the commit graph to that worktree's branch
   * (or sha for detached worktrees). When unset, the log spans all refs.
   */
  worktreesUrl?: () => string;
  /** Optional controlled value for the worktree filter ('' / null = all). */
  worktree?: string | null;
  /** Optional change handler; pairs with `worktree` for controlled mode. */
  onWorktreeChange?: (next: string | null) => void;
  /**
   * Controlled selected commit SHA. When provided, the panel switches to
   * controlled selection mode: the internal CommitDetail overlay is
   * suppressed and the caller is responsible for rendering it. Pair with
   * `onCommitSelect` to track changes.
   */
  selectedSha?: string | null;
  /**
   * Called when the user clicks a commit row (or the close action in the
   * detail, passing null). Only fires in controlled mode (when `selectedSha`
   * is passed).
   */
  onCommitSelect?: (sha: string | null) => void;
}

export default function GitGraphPanel({
  scope,
  gitLogUrl,
  showCommitUrl,
  remoteCommitUrl,
  title,
  pollIntervalMs,
  worktreesUrl,
  worktree: worktreeControlled,
  onWorktreeChange,
  selectedSha: selectedShaControlled,
  onCommitSelect,
}: GitGraphPanelProps) {
  const [limit, setLimit] = useState<number>(300);
  const [worktreeInternal, setWorktreeInternal] = useState<string | null>(null);
  const isWorktreeControlled = worktreeControlled !== undefined;
  const worktree = isWorktreeControlled ? (worktreeControlled ?? null) : worktreeInternal;
  const setWorktree = (next: string | null) => {
    if (!isWorktreeControlled) setWorktreeInternal(next);
    onWorktreeChange?.(next);
  };
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
  const [commits, setCommits] = useState<Commit[] | null>(() => getCachedGitLog(scope, 300, worktree));
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const isSelectionControlled = selectedShaControlled !== undefined;
  const [selectedShaInternal, setSelectedShaInternal] = useState<string | null>(null);
  const selectedSha = isSelectionControlled ? (selectedShaControlled ?? null) : selectedShaInternal;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<GitFilter>('all');
  const [bookmarked, setBookmarked] = useState<Set<string>>(() => readBookmarks(scope));
  const listRef = useRef<HTMLDivElement>(null);

  // Resolve to a string for stable effect deps — see CommitDetail for the
  // full rationale. Inline arrow props change identity on every parent render.
  const logFetchUrl = gitLogUrl(limit, worktree);

  // Fetch worktrees once (and on poll) for the dropdown. Empty list when
  // worktreesUrl isn't provided — dropdown is hidden in that case.
  const worktreesEndpoint = worktreesUrl?.();
  useEffect(() => {
    if (!worktreesEndpoint) return;
    let stop = false;
    const load = () => {
      fetch(worktreesEndpoint)
        .then((r) => r.json())
        .then((d) => { if (!stop && Array.isArray(d?.worktrees)) setWorktrees(d.worktrees); })
        .catch(() => {/* ignore — dropdown stays empty / loading */});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { stop = true; clearInterval(t); };
  }, [worktreesEndpoint]);

  useEffect(() => {
    const cached = getCachedGitLog(scope, limit, worktree);
    setCommits(cached);
    setError(null);
    fetchGitLog(scope, limit, logFetchUrl, worktree)
      .then((c) => setCommits(c))
      .catch((e) => setError(String(e?.message ?? e)));
  }, [scope, limit, reloadTick, logFetchUrl, worktree]);

  useEffect(() => {
    setBookmarked(readBookmarks(scope));
  }, [scope]);

  useEffect(() => {
    writeBookmarks(scope, bookmarked);
  }, [scope, bookmarked]);

  // Optional polling for new commits.
  useEffect(() => {
    if (!pollIntervalMs || pollIntervalMs < 1000) return;
    const t = setInterval(() => setReloadTick((n) => n + 1), pollIntervalMs);
    return () => clearInterval(t);
  }, [pollIntervalMs]);

  useEffect(() => {
    if (!commits) return;
    setBookmarked((prev) => new Set([...prev].filter((sha) => commits.some((commit) => commit.sha === sha))));
  }, [commits]);

  const laidOut = useMemo(() => (commits ? assignLanes(commits) : []), [commits]);
  const laneCount = useMemo(() => Math.max(1, laidOut.reduce((max, commit) => Math.max(max, commit.lane + 1), 1)), [laidOut]);
  const mergeCount = useMemo(() => laidOut.filter((commit) => commit.parents.length > 1).length, [laidOut]);
  const refCommits = useMemo(() => laidOut.filter((commit) => commit.refs.length > 0), [laidOut]);
  const uniqueRefs = useMemo(() => {
    const seen = new Set<string>();
    const refs: string[] = [];
    for (const commit of laidOut) {
      for (const ref of commit.refs) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        refs.push(ref);
      }
    }
    return refs;
  }, [laidOut]);
  const topAuthors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const commit of laidOut) counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4);
  }, [laidOut]);

  const needle = query.trim().toLowerCase();
  const filteredCommits = useMemo(() => laidOut
    .filter((commit) => filter !== 'refs' || commit.refs.length > 0)
    .filter((commit) => filter !== 'merges' || commit.parents.length > 1)
    .filter((commit) => filter !== 'bookmarked' || bookmarked.has(commit.sha))
    .filter((commit) => matchesCommit(commit, needle)), [bookmarked, filter, laidOut, needle]);

  // Virtualize the commit list. The fetch limit goes up to 1000, so without
  // windowing every row mounts as DOM. Only rows in (or near) the viewport
  // render; bounded DOM cost regardless of limit. Rows are variable height
  // (the optional refs row grows them), so heights are measured via the
  // ResizeObserver-backed `measureElement` rather than a fixed estimate.
  // `listRef` (the .h-git-list scroll container) stays the scroll element, so
  // the scrollTo({ top: 0 }) calls on filter/limit change keep working.
  const rowVirtualizer = useVirtualizer({
    count: filteredCommits.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 44,
    overscan: 12,
    getItemKey: (i) => filteredCommits[i]?.sha ?? i,
  });

  // Re-measure when the underlying data changes (filter/search/limit/refetch):
  // row identities shift, so cached measurements must be invalidated.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [filteredCommits, rowVirtualizer]);

  const onLimitChange = (nextLimit: number) => {
    setLimit(nextLimit);
    listRef.current?.scrollTo({ top: 0 });
  };

  const selectCommit = useCallback((sha: string) => {
    if (isSelectionControlled) {
      onCommitSelect?.(sha);
    } else {
      setSelectedShaInternal(sha);
    }
  }, [isSelectionControlled, onCommitSelect]);

  const applyQuery = useCallback((next: string) => {
    setQuery(next);
    setFilter('all');
    listRef.current?.scrollTo({ top: 0 });
  }, []);

  const resetFilters = useCallback(() => {
    setQuery('');
    setFilter('all');
    listRef.current?.scrollTo({ top: 0 });
  }, []);

  const toggleBookmark = useCallback((sha: string) => {
    setBookmarked((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  }, []);

  return (
    <>
      <div className="h-panel h-git-panel">
        <div className="h-panel-head h-git-head">
          <div className="h-git-title-stack">
            <span className="h-panel-title">git</span>
            <span className="h-panel-count">{filteredCommits.length}/{commits?.length ?? 0} visible</span>
          </div>
          <div className="h-panel-actions h-git-actions">
            {worktreesEndpoint && (
              <GitSelect
                triggerClassName="h-git-worktree-filter"
                value={worktree ?? '_all'}
                onChange={(v) => setWorktree(v === '_all' ? null : v)}
                ariaLabel="Filter commits by worktree"
                options={[
                  { value: '_all', label: `All worktrees${worktrees ? ` (${worktrees.length})` : ''}` },
                  ...(worktrees ?? []).flatMap((w) => {
                    const optValue = w.branch ?? w.head;
                    if (!optValue) return [];
                    const label = (w.branch ?? `${w.head?.slice(0, 8)} (detached)`)
                      + (w.isMain ? ' ★' : '')
                      + (w.locked ? ' 🔒' : '')
                      + (w.prunable ? ' ⚠' : '');
                    return [{ value: optValue, label }];
                  }),
                ]}
              />
            )}
            <GitSelect
              triggerClassName="h-git-limit"
              value={String(limit)}
              onChange={(v) => onLimitChange(Number(v))}
              ariaLabel="Git commit limit"
              options={LIMITS.map((n) => ({ value: String(n), label: String(n) }))}
            />
            <GitTooltip label="Refresh git history">
              <button
                className="h-btn-icon"
                onClick={() => setReloadTick((t) => t + 1)}
                aria-label="Refresh git history"
              >
                <RefreshCw size={12} />
              </button>
            </GitTooltip>
          </div>
        </div>

        <div className="h-git-command" aria-label="Git history controls">
          <div className="h-git-search-row">
            <input
              className="h-git-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search SHA, author, ref…"
              aria-label="Search git history"
            />
            {(query || filter !== 'all') && (
              <button type="button" className="h-git-clear" onClick={resetFilters}>clear</button>
            )}
          </div>
          <div className="h-git-filter-row" role="tablist" aria-label="Git commit filter">
            <GitFilterButton id="all" label="All" count={laidOut.length} filter={filter} setFilter={setFilter} />
            <GitFilterButton id="refs" label="Refs" count={refCommits.length} filter={filter} setFilter={setFilter} />
            <GitFilterButton id="merges" label="Merges" count={mergeCount} filter={filter} setFilter={setFilter} />
            <GitFilterButton id="bookmarked" label="Stars" count={bookmarked.size} filter={filter} setFilter={setFilter} />
          </div>
        </div>

        {uniqueRefs.length > 0 && (
          <div className="h-git-ref-rail" aria-label="Important refs">
            {uniqueRefs.slice(0, 8).map((ref) => (
              <button
                key={ref}
                type="button"
                className={`h-git-ref-chip ${refClass(ref)}`}
                onClick={() => applyQuery(ref)}
                title={`Filter by ${ref}`}
              >
                {refLabel(ref)}
              </button>
            ))}
          </div>
        )}

        {topAuthors.length > 1 && (
          <div className="h-git-author-rail" aria-label="Top commit authors">
            {topAuthors.map(([author, count]) => (
              <button key={author} type="button" onClick={() => applyQuery(author)} title={`Filter by ${author}`}>
                <span>{author}</span>
                <b>{count}</b>
              </button>
            ))}
          </div>
        )}

        {error && <div className="h-empty h-git-error">{error}</div>}
        {!commits && !error && <div className="h-empty">loading…</div>}
        {commits && commits.length === 0 && !error && <div className="h-empty">No commits found.</div>}
        {commits && commits.length > 0 && filteredCommits.length === 0 && !error && (
          <div className="h-empty h-git-empty">
            <span>No commits match this view.</span>
            <button type="button" className="h-git-clear" onClick={resetFilters}>clear filters</button>
          </div>
        )}

        {filteredCommits.length > 0 && (
          <div
            ref={listRef}
            className="h-git-list"
            onWheel={(e) => e.stopPropagation()}
          >
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {rowVirtualizer.getVirtualItems().map((vi) => {
                const commit = filteredCommits[vi.index];
                if (!commit) return null;
                return (
                  <div
                    key={commit.sha}
                    data-index={vi.index}
                    ref={rowVirtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                  >
                    <GitCommitRow
                      commit={commit}
                      laneCount={laneCount}
                      active={selectedSha === commit.sha}
                      onSelect={selectCommit}
                      bookmarked={bookmarked.has(commit.sha)}
                      onBookmark={toggleBookmark}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {!isSelectionControlled && selectedSha && (
        <CommitDetail
          sha={selectedSha}
          showCommitUrl={showCommitUrl}
          remoteCommitUrl={remoteCommitUrl}
          onClose={() => setSelectedShaInternal(null)}
        />
      )}
    </>
  );
}
