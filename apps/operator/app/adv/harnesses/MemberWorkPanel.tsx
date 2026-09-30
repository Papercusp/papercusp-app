'use client';

// adv:member-work — "what is each MEMBER working on" for the selected hive
// (shared-hive-collaboration-2026-06-14 P-010, Brief B10). The sibling of
// AdvAgentsPanel (adv:agents), but sourced from the UNIFIED hive-roster
// projection `hiveRoster.byHarness` (presence-v2 P-007 repoint — the harness is
// resolved to its home Hive, then folded: presence identity + mig-277 scalars +
// Tier-1 + the {doing,queued,load,orphaned} work shape, stamped with the same
// agentPaneKind), grouped by HIVE MEMBER (a federated github participant, or this
// machine) instead of a flat per-agent grid — the shared-hive "who's
// collaborating, and what is each one doing" view. (Was fleetAssignments.byHarness
// — the divergent bare-assignment shape, now deprecated for new consumers.)
// Reuses the dock's visual vocabulary (pc-advpanel
// chrome, AgentKindPill, LivenessDot) so it reads as one language with the rest
// of the dock. Member derivation + bucketing is the pure, unit-tested
// groupByMember (operator-core lib/fleet/member-grouping).
//
// SCOPE (Brief B10): the dashboard only. The role/permission tiers in P-010's
// text (owner / collaborator / read-only) are Brief B11, held separately.

import { useEffect, useMemo } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { RefreshCw } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { groupByMember } from '@papercusp/operator-core/lib/fleet/member-grouping';
import type { Liveness } from '@papercusp/operator-core/lib/liveness';
import type { FilterableColumn } from '@papercusp/grid-core';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { useColumnFilters, ColumnFilterBar, type CountEvidence } from '../../harness/filters';
import { Tooltip } from '../../harness/Tooltip';
import { AgentKindPill } from '../../harness/primitives';
import { LivenessDot, livenessFromHeartbeat } from '../../coord/presence-ui';
import { useLexicon } from '@/lib/useLexicon';
import { agentDisplayLabel } from '../../harness/agent-display';
import type { WorkingAgent } from './AdvAgentsPanel';

// The selected-row tint — the same recipe AdvAgentsPanel / WorkItemsPanel use.
const SELECTED_BG = 'color-mix(in oklab, var(--accent), transparent 80%)';

// Generic column-filter fields for THIS panel's roster (the odd-one-out: a custom
// member LIST, not a RichGrid, so we hand the grid-agnostic hook the minimal
// {key,header,filter} spec shape instead of full ColumnDefs). Filters apply to the
// flat WorkingAgent roster, BEFORE groupByMember, so empty members drop out and the
// header counts reflect exactly what's shown — same as the free-text quick-search.
// Module-level so the array is referentially stable across renders (the hook closes
// over it for the nuqs parser). Fields: kind (enum), status/liveness (enum), load
// (number range) — all real WorkingAgent fields. ns 'mw' → URL param 'mwf'.
const FILTER_COLUMNS: readonly FilterableColumn<WorkingAgent>[] = [
  {
    key: 'kind',
    header: 'Kind',
    filter: { type: 'enum', accessor: (a: WorkingAgent) => a.agentPaneKind },
  },
  {
    key: 'status',
    header: 'Status',
    filter: {
      type: 'enum',
      accessor: (a: WorkingAgent) => livenessFromHeartbeat(a.heartbeatAt ?? ''),
    },
  },
  {
    key: 'load',
    header: 'Load',
    filter: { type: 'number', accessor: (a: WorkingAgent) => a.load },
  },
];

const LIVENESS_LEGEND: Array<{ liveness: Liveness; label: string }> = [
  { liveness: 'live', label: 'live' },
  { liveness: 'idle', label: 'idle' },
  { liveness: 'stale', label: 'stale' },
];

/** A member's aggregate liveness: live if any agent is live, else the freshness
 *  of its newest heartbeat (idle/stale), else stale when it never beat. */
function memberLiveness(liveCount: number, lastHeartbeatAt: string | null): Liveness {
  if (liveCount > 0) return 'live';
  return lastHeartbeatAt ? livenessFromHeartbeat(lastHeartbeatAt) : 'stale';
}

export default function MemberWorkPanel({ params, api }: PanelComponentProps) {
  const lex = useLexicon();
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';

  // user-meaningful state → URL (nuqs). `mw`-prefixed so the filter doesn't
  // collide with the Agents/Work-items panels (akind/aq · wkind/wq) in the same
  // dock; selection rides the GLOBAL `?sel` (agent:<id>) the Detail pane reads —
  // same contract AdvAgentsPanel has, so clicking a member's agent opens it.
  const [search, setSearch] = useQueryState('mwq', parseAsString.withDefault(''));
  const [selectedId, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));

  const query = useSyncQuery<WorkingAgent>({
    queryName: 'hiveRoster.byHarness',
    args: { harnessSlug: slug },
    enabled: Boolean(slug),
  });
  const agents = query.loading ? null : query.data;
  const loading = query.fetching;
  const error = query.error ? query.error.message : null;

  // The free-text quick-search runs first (cross-field substring), then the
  // structured column-filter bar narrows further — same layering the reference
  // WorkItemsPanel adoption keeps (plan P-010/P-013: keep the global quick-search
  // alongside the bar). Enum option counts then reflect the search-narrowed set.
  const searchFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = agents ?? [];
    if (!q) return rows;
    return rows.filter((a) => {
      const hay =
        `${a.agentId} ${a.name ?? ''} ${a.label ?? ''} ${a.intent} ${a.doing?.id ?? ''} ${a.doing?.title ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [agents, search]);

  // Generic column filters (nuqs-backed via the hook, ns 'mw'); apply to the flat
  // roster BEFORE groupByMember so empty members drop and the counts stay honest.
  const countEvidence = useMemo<CountEvidence>(
    () => agents == null
      ? { kind: 'unknown', reason: 'loading' }
      : {
          kind: 'corpus',
          count: searchFiltered.length,
          population: search.trim() === '' ? 'the exhaustive live roster' : 'the exhaustive live roster after search',
        },
    [agents, search, searchFiltered.length],
  );
  const cf = useColumnFilters(FILTER_COLUMNS, searchFiltered, {
    ns: 'mw',
    countEvidence,
  });

  const members = useMemo(() => groupByMember(cf.rows), [cf.rows]);

  useEffect(() => {
    if (agents) api.setTitle(`Members · ${slug} (${groupByMember(agents).length})`);
  }, [agents, slug, api]);

  if (!slug) {
    return <div className="pc-advpanel__empty">No harness slug in params.</div>;
  }

  return (
    <div className="pc-advpanel pc-adv-memberwork">
      <div className="pc-advpanel__bar">
        <span className="pc-memberwork__title">Members</span>
        <input
          type="text"
          className="pc-advpanel__input"
          value={search}
          onChange={(e) => void setSearch(e.target.value)}
          placeholder="Filter members / agents…"
          aria-label="Filter members"
        />
        <Tooltip label="Refresh members">
          <button
            type="button"
            className="pc-advpanel__iconbtn"
            style={{ marginLeft: 'auto' }}
            onClick={() => query.invalidate()}
            disabled={loading}
            aria-label="Refresh members"
          >
            <RefreshCw size={13} aria-hidden className={loading ? 'pc-advpanel__spin' : undefined} />
          </button>
        </Tooltip>
      </div>

      <ColumnFilterBar
        controller={cf.controller}
        activeChips={cf.activeChips}
        hasActive={cf.hasActive}
        clearAll={cf.clearAll}
      />

      {error ? (
        <div className="pc-advpanel__empty pc-advpanel__empty--err">Failed: {error}</div>
      ) : !agents ? (
        <div className="pc-advpanel__empty">Loading {slug}…</div>
      ) : members.length === 0 ? (
        <div className="pc-advpanel__empty">
          {(agents?.length ?? 0) === 0
            ? `No members working in ${slug} right now — presence and claims land here live.`
            : 'No members match the filter.'}
        </div>
      ) : (
        <div className="pc-memberwork__scroll">
          {members.map((m) => (
            <section key={m.key} className="pc-memberwork__member">
              <header className="pc-memberwork__mhead">
                <LivenessDot
                  liveness={memberLiveness(m.liveCount, m.lastHeartbeatAt)}
                  title={`${m.liveCount}/${m.agents.length} live`}
                  size={9}
                />
                <span className="pc-memberwork__mname" title={m.host ?? undefined}>
                  {m.displayName}
                </span>
                {m.kind === 'local' ? (
                  <span className="pc-memberwork__youbadge">you</span>
                ) : m.host ? (
                  <span className="pc-memberwork__host" title={m.host}>
                    {m.host}
                  </span>
                ) : null}
                <span className="pc-memberwork__mmeta">
                  {m.agents.length} agent{m.agents.length === 1 ? '' : 's'} · {m.liveCount} live
                  {m.totalLoad > 0 ? ` · ⇄${m.totalLoad}` : ''}
                </span>
              </header>
              <ul className="pc-memberwork__agents">
                {m.agents.map((a) => {
                  const liveness = livenessFromHeartbeat(a.heartbeatAt ?? '');
                  const selected = `agent:${a.agentId}` === selectedId;
                  return (
                    <li key={a.agentId}>
                      <button
                        type="button"
                        className={`pc-memberwork__agent${selected ? ' is-selected' : ''}`}
                        style={selected ? { background: SELECTED_BG } : undefined}
                        onClick={() => void setSelectedId(`agent:${a.agentId}`)}
                      >
                        <span className={a.alive ? undefined : 'pc-memberwork__dim'}>
                          <AgentKindPill kind={a.agentPaneKind} size="xs" />
                        </span>
                        <span className="pc-memberwork__aname" title={a.intent || a.agentId}>
                          {agentDisplayLabel(a.name ?? a.label ?? a.agentId, lex)}
                        </span>
                        <span
                          className="pc-memberwork__doing"
                          title={a.doing?.title || a.intent || undefined}
                        >
                          {a.doing ? (
                            <>
                              <code className="pc-memberwork__item">{a.doing.id}</code>{' '}
                              {a.doing.title}
                            </>
                          ) : (
                            <em className="pc-memberwork__idle">
                              {a.intent ||
                                (a.declaredUnclaimed ? '⚠ declared, unclaimed' : 'idle')}
                            </em>
                          )}
                        </span>
                        <span className="pc-memberwork__load">
                          {a.load > 0 ? `⇄${a.load}` : a.claims.length > 0 ? `▣${a.claims.length}` : '—'}
                        </span>
                        <LivenessDot
                          liveness={liveness}
                          title={`${liveness} — heartbeat ${a.heartbeatAt ?? 'never'}`}
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <div className="pc-memberwork__legend" aria-label="Liveness legend">
        {LIVENESS_LEGEND.map(({ liveness, label }) => (
          <span key={liveness} className="pc-memberwork__legend-item">
            <LivenessDot liveness={liveness} size={7} title="" />
            {label}
          </span>
        ))}
      </div>

      <PanelStyles />
    </div>
  );
}

function PanelStyles() {
  return (
    <style>{`
      .pc-adv-memberwork { display: flex; flex-direction: column; height: 100%; }
      .pc-memberwork__title { font-size: 11px; font-weight: 700; color: var(--fg, #e7f7ff); text-transform: uppercase; letter-spacing: 0; }
      .pc-memberwork__scroll { flex: 1; min-height: 0; overflow: auto; }
      .pc-memberwork__member { border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 88%)); }
      .pc-memberwork__mhead {
        position: sticky; top: 0; z-index: 1;
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px;
        background: color-mix(in oklab, var(--accent), transparent 92%);
        border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        backdrop-filter: blur(4px);
      }
      .pc-memberwork__mname { font-size: 12px; font-weight: 700; color: var(--fg, #e7f7ff); }
      .pc-memberwork__youbadge {
        font-size: 9px; font-weight: 700; letter-spacing: 0; text-transform: uppercase;
        padding: 1px 6px; border-radius: 999px;
        color: var(--fg-dim, #b9d4e8);
        background: color-mix(in oklab, var(--accent), transparent 82%);
      }
      .pc-memberwork__host { font-size: 10px; color: var(--fg-mute, #7f9bb4); font-family: ui-monospace, monospace; }
      .pc-memberwork__mmeta { margin-left: auto; font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-memberwork__agents { list-style: none; margin: 0; padding: 0; }
      .pc-memberwork__agent {
        display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 4px 10px 4px 18px; border: 0; background: transparent;
        text-align: left; cursor: pointer; font: inherit; color: inherit;
      }
      .pc-memberwork__agent:hover { background: color-mix(in oklab, var(--accent), transparent 90%); }
      .pc-memberwork__agent:focus-visible { outline: 2px solid var(--accent, #38bdf8); outline-offset: -2px; }
      .pc-memberwork__dim { opacity: 0.45; filter: grayscale(0.8); }
      .pc-memberwork__aname {
        flex: 0 0 26%; min-width: 0; font-size: 11px; color: var(--fg, #e7f7ff);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-memberwork__doing {
        flex: 1; min-width: 0; font-size: 11px; color: var(--fg-dim, #b9d4e8);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-memberwork__item { font-family: ui-monospace, monospace; font-size: 10px; color: var(--accent-strong, #7dd3fc); }
      .pc-memberwork__idle { color: var(--fg-mute, #7f9bb4); font-style: italic; }
      .pc-memberwork__load { flex-shrink: 0; font-size: 11px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; min-width: 36px; text-align: right; }
      .pc-memberwork__legend {
        display: flex; align-items: center; gap: 10px; flex-shrink: 0;
        padding: 5px 10px; font-size: 10px; color: var(--fg-mute, #7f9bb4);
        border-top: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
      }
      .pc-memberwork__legend-item { display: inline-flex; align-items: center; gap: 3px; }
    `}</style>
  );
}
