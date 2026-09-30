/**
 * RecipesClient — the read-only /admin/recipes dashboard over the code:run RECIPE
 * corpus (code-recipes-2026-06-21 P-009).
 *
 * Two live sync reads, no polling, no mutations:
 *   - `codeRecipes`      → the hive's recipe rows (newest-run / most-run first),
 *                          rendered as a sortable-by-URL table.
 *   - `recipeCandidates` → the Queen's DETERMINISTIC graduation worklist (promote
 *                          candidates by promotionScore + near-duplicate merge
 *                          clusters), rendered as a read-only Candidates section.
 *
 * Strictly a DASHBOARD: promote/retire/merge are the Queen's actions (via
 * work-items / recipes:merge / recipes:sweep), never wired here. Both queries fire
 * notifySyncInvalidate on every recipe write (capture / sweep / merge), so the tab
 * updates live over desktop SSE.
 *
 * State that's user-meaningful lives in the URL via nuqs (CLAUDE.md): the recipe
 * STATUS filter (`rstatus`) + the table SORT (`rsort`) are deep-linkable and
 * agent-driveable (ui:get_state / ui:dispatch). Render-only derivations stay in
 * useMemo.
 */
import { useMemo, useRef } from 'react';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSyncQuery } from '@papercusp/sync';
import { readListTotal, listCountLabel } from '@papercusp/operator-core/lib/sync-resolver/list-meta';
import { Beaker, GitMerge, TrendingUp } from 'lucide-react';
import { useLexicon } from '@/lib/useLexicon';
import type { CodeRecipeRow } from '@papercusp/operator-core/lib/code-recipes-store';
import type {
  PromoteCandidate,
  MergeCluster,
} from '@papercusp/operator-core/lib/code-recipes-candidates';

// The recipeCandidates query returns a single envelope row (wrapped in a 1-elem
// array per the resolver's flat-row contract).
interface CandidatesEnvelope {
  promoteCandidates: PromoteCandidate[];
  mergeClusters: MergeCluster[];
}

const STATUS_VALUES = ['all', 'active', 'promoted', 'retired', 'merged'] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

const SORT_VALUES = ['lastRun', 'runCount', 'successRate', 'title'] as const;
type SortKey = (typeof SORT_VALUES)[number];

const SORT_LABELS: Record<SortKey, string> = {
  lastRun: 'Last run',
  runCount: 'Runs',
  successRate: 'Success',
  title: 'Title',
};

/** "3d ago" / "2h ago" / "—" from an ISO timestamp. */
function fmtAgo(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const ms = Date.now() - t;
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** success_count / run_count as a percent string, or "—" when never run. */
function successRate(runCount: number, successCount: number): number | null {
  if (runCount <= 0) return null;
  return Math.max(0, Math.min(1, successCount / runCount));
}
function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

function statusTone(status: string): 'active' | 'promoted' | 'retired' | 'merged' | 'other' {
  if (status === 'active' || status === 'promoted' || status === 'retired' || status === 'merged') return status;
  return 'other';
}

function ToolBadges({ tools }: { tools: string[] }) {
  if (!tools || tools.length === 0) return <span className="pc-recipes__mute">—</span>;
  return (
    <span className="pc-recipes__tools">
      {tools.map((t) => (
        <code key={t} className="pc-recipes__toolbadge">
          {t}
        </code>
      ))}
    </span>
  );
}

export default function RecipesClient() {
  const t = useLexicon();
  const recipesQ = useSyncQuery<CodeRecipeRow>({ queryName: 'codeRecipes', args: {}, staleTime: 30_000 });
  const candidatesQ = useSyncQuery<CandidatesEnvelope>({
    queryName: 'recipeCandidates',
    args: {},
    staleTime: 30_000,
  });

  const [status, setStatus] = useQueryState(
    'rstatus',
    parseAsStringEnum<StatusFilter>([...STATUS_VALUES]).withDefault('all'),
  );
  const [sort, setSort] = useQueryState('rsort', parseAsStringEnum<SortKey>([...SORT_VALUES]).withDefault('lastRun'));

  // Read the RAW synced rows (row[0] carries `_meta.total` from the resolver's
  // attachListMeta) BEFORE any .map/.filter that would drop _meta. allRecipes is
  // the same array, just typed for the table; readListTotal reads off row[0].
  const rawRecipeRows = recipesQ.data ?? [];
  const allRecipes = rawRecipeRows;
  const totalRecipes = readListTotal(rawRecipeRows);
  const candidates = candidatesQ.data?.[0] ?? { promoteCandidates: [], mergeClusters: [] };

  const rows = useMemo(() => {
    const filtered = status === 'all' ? allRecipes : allRecipes.filter((r) => r.status === status);
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'runCount':
          return b.runCount - a.runCount || a.id.localeCompare(b.id);
        case 'successRate': {
          const ra = successRate(a.runCount, a.successCount) ?? -1;
          const rb = successRate(b.runCount, b.successCount) ?? -1;
          return rb - ra || b.runCount - a.runCount;
        }
        case 'title':
          return a.title.localeCompare(b.title);
        case 'lastRun':
        default: {
          const ta = a.lastRunAt ? Date.parse(a.lastRunAt) : 0;
          const tb = b.lastRunAt ? Date.parse(b.lastRunAt) : 0;
          return tb - ta || b.runCount - a.runCount;
        }
      }
    });
    return sorted;
  }, [allRecipes, status, sort]);

  const counts = useMemo(() => {
    const c = { all: allRecipes.length, active: 0, promoted: 0, retired: 0, merged: 0 };
    for (const r of allRecipes) {
      if (r.status === 'active') c.active++;
      else if (r.status === 'promoted') c.promoted++;
      else if (r.status === 'retired') c.retired++;
      else if (r.status === 'merged') c.merged++;
    }
    return c;
  }, [allRecipes]);

  const loading = recipesQ.loading && allRecipes.length === 0;

  // Virtualize the recipe table: its rows are variable-height (multi-line
  // description + wrapping tool badges), so we keep the existing row markup and
  // mount only the visible window via TanStack useVirtualizer with measureElement
  // (exact offsets as rows wrap). The scroll container is pc-recipes__tablescroll.
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => 56,
    overscan: 12,
    measureElement:
      typeof window !== 'undefined' && navigator.userAgent.indexOf('Firefox') === -1
        ? (el) => el?.getBoundingClientRect().height
        : undefined,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="pc-recipes">
      <header className="pc-recipes__head">
        <div className="pc-recipes__title">
          <Beaker size={16} aria-hidden />
          <div>
            <h2>Code recipes</h2>
            <p>
              Reusable code:run scripts captured on successful runs, shared across your {t('pot', { lower: true })}. Read-only — promote, merge,
              and retire are the {t('brain')}&apos;s actions.
            </p>
          </div>
        </div>
        <div className="pc-recipes__stats" aria-label="Recipe corpus summary">
          <span>
            <b>{listCountLabel(allRecipes.length, totalRecipes)}</b> total
          </span>
          <span>
            <b>{counts.active}</b> active
          </span>
          <span>
            <b>{counts.promoted}</b> promoted
          </span>
          <span>
            <b>{counts.retired}</b> retired
          </span>
        </div>
      </header>

      {/* ── Candidates: the Queen's deterministic graduation worklist ── */}
      <section className="pc-recipes__candidates" aria-label="Promotion candidates">
        <h3>
          <TrendingUp size={13} aria-hidden /> Promote candidates
          <span className="pc-recipes__mute">
            {candidates.promoteCandidates.length} ranked by promotion score — file a work-item to graduate one into a tool
          </span>
        </h3>
        {candidates.promoteCandidates.length === 0 ? (
          <p className="pc-recipes__empty">No promote candidates right now.</p>
        ) : (
          <ol className="pc-recipes__candlist">
            {candidates.promoteCandidates.map((c) => (
              <li key={c.id} className="pc-recipes__cand">
                <div className="pc-recipes__candmain">
                  <strong>{c.title}</strong>
                  <span className="pc-recipes__candid">{c.id}</span>
                  <p className="pc-recipes__mute">{c.description}</p>
                </div>
                <dl className="pc-recipes__candsignals">
                  <div>
                    <dt>score</dt>
                    <dd>
                      <span className="pc-recipes__score">{c.promotionScore.toFixed(2)}</span>
                    </dd>
                  </div>
                  <div>
                    <dt>runs</dt>
                    <dd>{c.runCount}</dd>
                  </div>
                  <div>
                    <dt>agents</dt>
                    <dd>{c.distinctAgents}</dd>
                  </div>
                  <div>
                    <dt>success</dt>
                    <dd>{pct(c.successRate)}</dd>
                  </div>
                </dl>
                <div className="pc-recipes__candtools">
                  <ToolBadges tools={c.toolsUsed} />
                </div>
              </li>
            ))}
          </ol>
        )}

        {candidates.mergeClusters.length > 0 && (
          <div className="pc-recipes__clusters">
            <h3>
              <GitMerge size={13} aria-hidden /> Merge clusters
              <span className="pc-recipes__mute">
                {candidates.mergeClusters.length} near-duplicate group(s) — consolidate via recipes:merge
              </span>
            </h3>
            <ul className="pc-recipes__clusterlist">
              {candidates.mergeClusters.map((cl) => (
                <li key={cl.recipeIds.join('+')} className="pc-recipes__cluster">
                  <span className="pc-recipes__clusterids">
                    {cl.recipeIds.map((id) => (
                      <code key={id} className="pc-recipes__toolbadge">
                        {id}
                      </code>
                    ))}
                  </span>
                  <span className="pc-recipes__mute">{cl.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ── Recipe table ── */}
      <section className="pc-recipes__tablewrap" aria-label="Recipes">
        <div className="pc-recipes__controls">
          <div className="pc-recipes__filters" role="group" aria-label="Filter by status">
            {STATUS_VALUES.map((s) => (
              <button
                key={s}
                type="button"
                className={`pc-recipes__chip${status === s ? ' is-active' : ''}`}
                aria-pressed={status === s}
                onClick={() => void setStatus(s)}
              >
                {s === 'all' ? `all (${counts.all})` : `${s} (${counts[s]})`}
              </button>
            ))}
          </div>
          <div className="pc-recipes__sort" role="group" aria-label="Sort recipes">
            <span>sort</span>
            {SORT_VALUES.map((s) => (
              <button
                key={s}
                type="button"
                className={`pc-recipes__sortbtn${sort === s ? ' is-active' : ''}`}
                aria-pressed={sort === s}
                onClick={() => void setSort(s)}
              >
                {SORT_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <p className="pc-recipes__empty">Loading recipes…</p>
        ) : rows.length === 0 ? (
          <p className="pc-recipes__empty">
            {allRecipes.length === 0 ? 'No recipes captured yet.' : 'No recipes match this filter.'}
          </p>
        ) : (
          <div className="pc-recipes__table" role="table" aria-label="Recipes">
            <div className="pc-recipes__thead" role="rowgroup">
              <div className="pc-recipes__tr pc-recipes__tr--head" role="row">
                <span role="columnheader">Recipe</span>
                <span role="columnheader" className="pc-recipes__num">
                  Runs
                </span>
                <span role="columnheader" className="pc-recipes__num">
                  Agents
                </span>
                <span role="columnheader" className="pc-recipes__num">
                  Success
                </span>
                <span role="columnheader">Last run</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Tools</span>
              </div>
            </div>
            {/* Virtualized body: only the visible window mounts (variable-height
                rows measured via measureElement), so a 1000-recipe corpus stays
                cheap. Rows are absolutely positioned inside a getTotalSize()
                spacer; the scroll container owns the overflow. */}
            <div className="pc-recipes__tablescroll" ref={tableScrollRef} role="rowgroup">
              <div className="pc-recipes__vspacer" style={{ height: rowVirtualizer.getTotalSize() }}>
                {virtualItems.map((vi) => {
                  const r = rows[vi.index];
                  const distinct = (r as CodeRecipeRow & { distinctAgents?: number }).distinctAgents;
                  return (
                    <div
                      key={r.id}
                      data-index={vi.index}
                      ref={rowVirtualizer.measureElement}
                      className="pc-recipes__tr pc-recipes__tr--virtual"
                      role="row"
                      style={{ transform: `translateY(${vi.start}px)` }}
                    >
                      <div role="cell">
                        <div className="pc-recipes__name">
                          <strong>{r.title}</strong>
                          <span className="pc-recipes__rid">{r.id}</span>
                        </div>
                        {r.description ? <p className="pc-recipes__desc">{r.description}</p> : null}
                        {r.authorRole ? <span className="pc-recipes__author">by {r.authorRole}</span> : null}
                      </div>
                      <div role="cell" className="pc-recipes__num">{r.runCount}</div>
                      <div role="cell" className="pc-recipes__num">{typeof distinct === 'number' ? distinct : '—'}</div>
                      <div role="cell" className="pc-recipes__num">{pct(successRate(r.runCount, r.successCount))}</div>
                      <div role="cell">{fmtAgo(r.lastRunAt)}</div>
                      <div role="cell">
                        <span className={`pc-recipes__status pc-recipes__status--${statusTone(r.status)}`}>{r.status}</span>
                        {r.promotedTool ? <span className="pc-recipes__promoted">→ {r.promotedTool}</span> : null}
                      </div>
                      <div role="cell">
                        <ToolBadges tools={r.toolsUsed} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </section>

      <style>{`
        .pc-recipes { display: flex; flex-direction: column; gap: 16px; padding: 16px 18px; color: var(--fg, #e6f2fb); }
        .pc-recipes h2 { margin: 0; font-size: 18px; font-weight: 720; }
        .pc-recipes__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
        .pc-recipes__title { display: flex; gap: 10px; align-items: flex-start; }
        .pc-recipes__title p { margin: 3px 0 0; font-size: 12px; color: var(--fg-mute, #8aa6bd); max-width: 60ch; }
        .pc-recipes__stats { display: flex; gap: 14px; font-size: 12px; color: var(--fg-dim, #aac4d8); }
        .pc-recipes__stats b { color: var(--fg, #e6f2fb); font-size: 14px; }
        .pc-recipes__mute { color: var(--fg-mute, #8aa6bd); font-weight: 400; font-size: 11.5px; }
        .pc-recipes__empty { color: var(--fg-mute, #8aa6bd); font-size: 12.5px; padding: 8px 2px; }

        .pc-recipes__candidates { border: 1px solid var(--border, rgba(125,211,252,0.16)); border-radius: 10px; padding: 12px 14px; background: rgba(255,255,255,0.015); }
        .pc-recipes__candidates h3 { margin: 0 0 8px; font-size: 13px; font-weight: 660; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .pc-recipes__candlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .pc-recipes__cand { display: flex; gap: 14px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; border-top: 1px solid var(--border, rgba(125,211,252,0.1)); padding-top: 8px; }
        .pc-recipes__cand:first-child { border-top: none; padding-top: 0; }
        .pc-recipes__candmain { min-width: 220px; flex: 1; }
        .pc-recipes__candmain strong { font-size: 13px; }
        .pc-recipes__candmain p { margin: 2px 0 0; }
        .pc-recipes__candid, .pc-recipes__rid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; color: var(--fg-mute, #8aa6bd); margin-left: 8px; }
        .pc-recipes__candsignals { display: flex; gap: 12px; margin: 0; }
        .pc-recipes__candsignals dt { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #8aa6bd); }
        .pc-recipes__candsignals dd { margin: 1px 0 0; font-size: 13px; font-weight: 640; }
        .pc-recipes__score { color: var(--accent, #7dd3fc); }
        .pc-recipes__candtools { max-width: 280px; }

        .pc-recipes__clusters { margin-top: 12px; }
        .pc-recipes__clusterlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .pc-recipes__cluster { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 12px; }
        .pc-recipes__clusterids { display: inline-flex; gap: 4px; flex-wrap: wrap; }

        .pc-recipes__controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
        .pc-recipes__filters { display: inline-flex; gap: 6px; flex-wrap: wrap; }
        .pc-recipes__chip { border: 1px solid var(--border, rgba(125,211,252,0.16)); background: rgba(255,255,255,0.02); color: var(--fg-dim, #aac4d8); border-radius: 999px; font-size: 11.5px; padding: 3px 10px; cursor: pointer; }
        .pc-recipes__chip.is-active { color: #f7fdff; border-color: var(--accent, #7dd3fc); background: color-mix(in oklab, var(--accent, #38bdf8), transparent 90%); }
        .pc-recipes__sort { font-size: 11.5px; color: var(--fg-mute, #8aa6bd); display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .pc-recipes__sortbtn { border: 1px solid var(--border, rgba(125,211,252,0.16)); background: rgba(255,255,255,0.02); color: var(--fg-dim, #aac4d8); border-radius: 999px; font-size: 11.5px; padding: 3px 9px; cursor: pointer; }
        .pc-recipes__sortbtn.is-active { color: #f7fdff; border-color: var(--accent, #7dd3fc); background: color-mix(in oklab, var(--accent, #38bdf8), transparent 90%); }

        .pc-recipes__tablewrap { overflow-x: auto; }
        .pc-recipes__table { width: 100%; min-width: 780px; font-size: 12px; }
        /* Virtualized body: a fixed-height scroll viewport; rows are absolutely
           positioned inside the getTotalSize() spacer (translateY per row). */
        .pc-recipes__tablescroll { position: relative; max-height: min(70vh, 720px); overflow-y: auto; }
        .pc-recipes__vspacer { position: relative; width: 100%; }
        .pc-recipes__tr--virtual { position: absolute; top: 0; left: 0; width: 100%; }
        .pc-recipes__tr { display: grid; grid-template-columns: minmax(260px, 2fr) 64px 72px 78px 90px minmax(120px, 0.8fr) minmax(180px, 1.1fr); }
        .pc-recipes__tr--head { border-bottom: 1px solid var(--border, rgba(125,211,252,0.16)); }
        .pc-recipes__tr--head > span { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #8aa6bd); padding: 6px 8px; font-weight: 660; }
        .pc-recipes__tr > div { padding: 8px; border-bottom: 1px solid var(--border, rgba(125,211,252,0.08)); min-width: 0; }
        .pc-recipes__num { text-align: right; font-variant-numeric: tabular-nums; }
        .pc-recipes__name { display: flex; align-items: baseline; flex-wrap: wrap; }
        .pc-recipes__name strong { font-size: 12.5px; }
        .pc-recipes__desc { margin: 2px 0 0; color: var(--fg-mute, #8aa6bd); max-width: 48ch; }
        .pc-recipes__author { font-size: 10.5px; color: var(--fg-mute, #8aa6bd); }
        .pc-recipes__tools { display: inline-flex; gap: 4px; flex-wrap: wrap; }
        .pc-recipes__toolbadge { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; background: color-mix(in oklab, var(--accent, #38bdf8), transparent 90%); border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 82%); border-radius: 4px; padding: 1px 5px; color: var(--fg-dim, #aac4d8); }
        .pc-recipes__status { font-size: 10.5px; border-radius: 4px; padding: 1px 7px; text-transform: capitalize; border: 1px solid transparent; }
        .pc-recipes__status--active { color: #34d399; border-color: rgba(52,211,153,0.4); background: rgba(52,211,153,0.08); }
        .pc-recipes__status--promoted { color: var(--accent-strong, var(--accent)); border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 60%); background: color-mix(in oklab, var(--accent, #38bdf8), transparent 92%); }
        .pc-recipes__status--retired { color: #94a3b8; border-color: rgba(148,163,184,0.35); background: rgba(148,163,184,0.06); }
        .pc-recipes__status--merged { color: #c084fc; border-color: rgba(192,132,252,0.4); background: rgba(192,132,252,0.08); }
        .pc-recipes__status--other { color: var(--fg-mute, #8aa6bd); border-color: var(--border, rgba(125,211,252,0.16)); }
        .pc-recipes__promoted { font-size: 10.5px; color: var(--fg-mute, #8aa6bd); margin-left: 6px; }
      `}</style>
    </div>
  );
}
