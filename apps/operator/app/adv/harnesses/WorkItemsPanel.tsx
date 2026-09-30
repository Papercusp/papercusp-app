'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { RefreshCw } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { VirtualGrid, usePersistedColumnWidths } from '@papercusp/grid-core';
import { readListMeta } from '@papercusp/operator-core/lib/sync-resolver/list-meta';
import type { CompanionListSummary } from '@papercusp/facets';
import { useLexicon } from '@/lib/useLexicon';
import {
  useColumnFilterState,
  useColumnFiltersFromState,
  ColumnFilterBar,
  filterCountLabel,
  type CountEvidence,
} from '../../harness/filters';
import { Tooltip } from '../../harness/Tooltip';
import { buildWorkItemColumns, WORK_ITEM_FILTER_NS } from './work-item-columns';
import {
  mergeWorkItemPage,
  workItemFacetOptions,
  workItemServerFilters,
} from './work-item-list-query';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';

/**
 * Default fetch window for `workItems.byHarness`. Exported so the DetailPanel's
 * work-item lookup uses the SAME `limit` and therefore the SAME React Query key
 * — the two subscriptions dedup into one shared stream instead of opening a
 * second request. A mismatch here reopens the class of bug where the on-click
 * detail fetch starves under the desktop webview's ~6-connection-per-host cap
 * (works over the IPC bypass on mac/linux WebKit, hangs on Windows/WebView2).
 */
export const WORK_ITEMS_PAGE = 500;

/**
 * WorkItemsPanel — the features/issues view PORTED onto the unified `work_items`
 * surface (blueprint-aware-harness-ui-2026-06-09 P-010 / unify-work-items D-001). One
 * table across BOTH families — feature-family {feature,research-task,chunk} +
 * issue-family {bug,change,task} — for the selected member harness, surfacing the
 * dimensions the old per-kind FeaturesPanel/IssuesPanel couldn't: `kind`/`family`, the
 * claim (`assignee` + `assignedBy`), `severity`, backlog `priority`, per-assignee
 * `rank`, plus the v2 dims (plan-link + spine-position).
 *
 * Reads live via `useSyncQuery({ queryName: 'workItems.byHarness' })` — the resolver
 * reuses the route's `listEnrichedWorkItems` assembly, and the table bridge re-fires
 * the query on harness_features_consolidated / engineer_issues (migration 215) /
 * spawned_agents changes. The Refresh button is a manual `invalidate()` escape hatch.
 */

export interface WorkItemRow {
  id: string;
  kind: string;
  family: string;
  title: string;
  summary: string | null;
  state: string;
  assignee: string | null;
  assignedBy: string | null;
  severity: string | null;
  priority: number | null;
  rank: number | null;
  // P-010 v2 (route-side joins): plan-item linkage + spine position (latest role/stage).
  planSlug: string | null;
  spineRole: string | null;
  spineStatus: string | null;
  updatedAt: string;
  // Provenance for the trust badge (Trust A4) — already in the workItems.byHarness
  // payload (EnrichedWorkItem spreads the full WorkItem); local-origin ⇒ no badge.
  origin: string | null;
  auditVerdict: string | null;
  verifiedAuthorGithubUserId: number | null;
}

/**
 * The count label this pane renders MOVED to
 * `../../harness/filters/filter-count-label` as `filterCountLabel` (owner ask
 * 2026-08-17: "mimic how it works in the work queue in the work tab") — three
 * Learning-tab panes had each hand-rolled a different one, so the label the Work
 * Queue got right now lives beside the shared filter hook + bar every pane already
 * imports. `noun` defaults to 'item', exactly what this pane passed before.
 *
 * No `workItemCountLabel` alias is kept here: this repo has no users yet and takes
 * the breaking rename over a deprecation shim (CLAUDE.md), and an alias would ALSO
 * be a live trap — this pane's test mocks `../../harness/filters` wholesale, so a
 * re-export of a mocked symbol resolves to undefined at import time rather than
 * failing loudly at the mock. Import `filterCountLabel` from the barrel instead.
 *
 * P-004 replaces the old growing-window premise: exact match + total now come
 * from workItems.summary while bounded keyset pages supply rows.
 */

/** Stable empty-rows sentinel — see the `useColumnFilters` call below. */
const NO_ROWS: WorkItemRow[] = [];

export default function WorkItemsPanel({ params, api }: PanelComponentProps) {
  const t = useLexicon();
  const slug = (params.harnessSlug as string) || '';
  const workUnit = t('workUnit', { lower: true });
  const workUnits = t('workUnit', { plural: true, lower: true });
  const workUnitsTitle = t('workUnit', { plural: true });
  // The per-column filters (kind/state/severity/priority/…) live in ONE nuqs param
  // (`wif`) owned by useColumnFilters below. The global quick-search is a separate
  // affordance — `wq`, applied as a substring match ON TOP of the column filters.
  const [search, setSearch] = useQueryState('wq', parseAsString.withDefault(''));
  // Row selection drives the global `?sel` the Detail pane reads — F-* resolves
  // to the feature view, WI-* to the work-item view (same contract the retired
  // Features/Issues panels had).
  const [selectedId, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));
  // Dragged column widths survive dockview remounts (panel tab switches
  // remount panels, which used to reset every resize). Render-only
  // preference, not user-meaningful URL state → localStorage, not nuqs.
  const [colWidths, setColWidths] = usePersistedColumnWidths('pc-colw:adv:work-items');

  // The owner's trust list — to mark a verified remote author as "trusted" on the
  // badge (Trust A4). Fail-soft: no data ⇒ empty set ⇒ verified authors read as
  // "admitted"/"pending", never falsely "trusted".
  const trustQuery = useSyncQuery<{ githubUserId: number }>({ queryName: 'trust.list' });
  const trustedSet = useMemo(
    () => new Set((trustQuery.data ?? []).map((t) => t.githubUserId)),
    [trustQuery.data],
  );
  // Column + filter definitions live in ./work-item-columns — SHARED with the
  // dependency-graph pane (dependency-health-pane-2026-08-02 P-010 / D-003 req 4:
  // "all the filters from the work item list pane should also be brought over").
  //
  // MEMOIZED (P-BUG-WI-37386) on `trustedSet` — not rebuilt every render like the
  // inline array it replaced. `useColumnFilters`'s `controller`/`activeChips` are
  // only as stable as the `cols` array passed in (see useColumnFilters.ts's own
  // note: "cols is a fresh array literal per render in most panels"), and
  // ColumnFilterBar is now memo()'d specifically so that instability doesn't
  // matter ONLY IF callers hold up their end. Rebuilding `columns` fresh every
  // render fed a Radix `@radix-ui/react-slot` SlotClone ref-churn landmine in
  // ColumnFilterBar's Tooltip/Select triggers into "Maximum update depth
  // exceeded" (WI-37386) — this pane's own re-renders (search typing, sync
  // polling, etc.) were sustained fuel for it. `isTrusted` closes over
  // `trustedSet` (itself already memoized on `trustQuery.data`), so keying on
  // `trustedSet` keeps this correctly fresh whenever the trust list actually
  // changes, and stable otherwise.
  const columns = useMemo(
    () =>
      buildWorkItemColumns({
        isTrusted: (r: WorkItemRow) =>
          r.verifiedAuthorGithubUserId != null && trustedSet.has(r.verifiedAuthorGithubUserId),
      }),
    [trustedSet],
  );

  // The URL state exists BEFORE the row request so every filter compiles into
  // the server predicate. Both list and graph share this same `wif` binding.
  const filterBinding = useColumnFilterState(columns, WORK_ITEM_FILTER_NS);
  const serverFilters = useMemo(
    () => workItemServerFilters(filterBinding.state),
    [filterBinding.state],
  );
  const filterFingerprint = JSON.stringify(serverFilters);
  const serverPredicateActive = search.trim() !== '' || Object.keys(serverFilters).length > 0;

  // Bounded keyset pagination: every request stays at 500 rows. Cursor pages
  // append idempotently in the client; the server never re-fetches a growing
  // LIMIT over this mutable newest-first corpus.
  const [cursor, setCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<WorkItemRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  useEffect(() => {
    setCursor(null);
    setNextCursor(null);
    setRows([]);
  }, [slug, search, filterFingerprint]);

  const sharedArgs = useMemo(
    () => ({ harnessSlug: slug, q: search, filters: serverFilters }),
    [slug, search, serverFilters],
  );
  const query = useSyncQuery<WorkItemRow>({
    queryName: 'workItems.byHarness',
    args: {
      ...sharedArgs,
      limit: WORK_ITEMS_PAGE,
      ...(cursor ? { cursor } : {}),
    },
    enabled: Boolean(slug),
  });
  const summaryQuery = useSyncQuery<CompanionListSummary>({
    queryName: 'workItems.summary',
    args: sharedArgs,
    enabled: Boolean(slug),
  });
  useEffect(() => {
    if (query.loading || !query.data) return;
    setRows((previous) => mergeWorkItemPage(previous, query.data, cursor));
    setNextCursor(
      typeof readListMeta(query.data)?.nextCursor === 'string'
        ? readListMeta(query.data)!.nextCursor as string
        : null,
    );
  }, [query.data, query.loading, cursor]);
  const items = query.loading && cursor === null && rows.length === 0 ? null : rows;
  const summary = summaryQuery.data?.[0] ?? null;
  const pairedFetching = Boolean(query.fetching || summaryQuery.fetching);
  const loading = pairedFetching;
  const error = query.error?.message ?? summaryQuery.error?.message ?? null;
  const hasMore = nextCursor !== null;
  const loadMore = useCallback(() => {
    if (nextCursor) setCursor(nextCursor);
  }, [nextCursor]);

  // Per-column filters (kind/state/severity/priority/…) → ONE `wif` nuqs param.
  // The hook re-derives enum options from the live rows and AND-s every active
  // filter; `cf.rows` is the input ref when nothing is active (cheap fast-path).
  // The `ns` is shared with DepGraphPanel, so filtering EITHER pane filters both.
  //
  // ⚠ `NO_ROWS`, not `items ?? []`: an inline `[]` is a FRESH array literal on every
  // render, and useColumnFilters keys `filteredRows`/`optionsByKey` — and therefore
  // `controller` — on its `rows` arg. A fresh literal breaks every one of those memos,
  // which is precisely the "callers must hold up their end" contract ColumnFilterBar's
  // memo() note spells out (P-BUG-WI-37386). The sibling DepGraphPanel shipped the same
  // class of instability into an effect dep and ran a real render loop for it (WI-39552).
  const filterCountEvidence = useMemo<CountEvidence>(() => {
    if (!summary) return { kind: 'unknown', reason: summaryQuery.error ? 'failed' : 'loading' };
    if (pairedFetching) return { kind: 'unknown', reason: 'updating' };
    return {
      kind: 'corpus',
      count: summary.matched,
      ...(serverPredicateActive ? { total: summary.total } : {}),
      population: `the selected harness ${workUnit} corpus`,
    };
  }, [summary, summaryQuery.error, pairedFetching, serverPredicateActive, workUnit]);
  const facetOptions = useMemo(() => workItemFacetOptions(summary), [summary]);
  const cf = useColumnFiltersFromState(columns, items ?? NO_ROWS, {
    ns: WORK_ITEM_FILTER_NS,
    countEvidence: filterCountEvidence,
    serverEnumOptions: facetOptions,
  }, filterBinding);

  // Global quick-search (`wq`) is a separate affordance — apply it as a substring
  // match ON TOP of the column-filtered rows (id/title/state/assignee).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cf.rows;
    return cf.rows.filter((i) =>
      `${i.id} ${i.title} ${i.state} ${i.assignee ?? ''}`.toLowerCase().includes(q),
    );
  }, [cf.rows, search]);

  // The counts drive BOTH the tab title and the in-pane badge — filter-aware, so
  // narrowing the list shows how many rows matched out of the store total; when
  // unfiltered it's just the store total.
  const isFiltered = cf.hasActive || search.trim() !== '';
  const displayedCountEvidence = filterCountEvidence;
  const counts = filterCountLabel(displayedCountEvidence, workUnit);
  const titleCount = counts?.title;
  useEffect(() => {
    if (titleCount != null) api.setTitle(`${workUnitsTitle} · ${slug} (${titleCount})`);
  }, [titleCount, slug, api, workUnitsTitle]);

  if (!slug) return <div className="pc-advpanel__empty">Pick a harness to view its {workUnits}.</div>;

  return (
    <div className="pc-advpanel">
      <div className="pc-advpanel__bar">
        <input
          type="text"
          className="pc-advpanel__input"
          value={search}
          onChange={(e) => void setSearch(e.target.value)}
          placeholder={`Filter ${workUnits}…`}
          aria-label={`Filter ${workUnits}`}
        />
        <ColumnFilterBar
          controller={cf.controller}
          activeChips={cf.activeChips}
          hasActive={cf.hasActive}
          clearAll={cf.clearAll}
        />
        {counts ? (
          <Tooltip
            label={
              isFiltered
                ? 'Rows matching the current filter / search, out of the store total.'
                : `Total ${workUnits} for this harness.`
            }
          >
            <span
              className="pc-advpanel__count"
              data-testid="wi-count"
              aria-live="polite"
              aria-label={counts.ariaLabel}
              style={{
                marginLeft: 'auto',
                fontSize: 11,
                color: 'var(--fg-mute)',
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {counts.summary}
            </span>
          </Tooltip>
        ) : null}
        <Tooltip label={`Refresh ${workUnits}`}>
          <button
            type="button"
            className="pc-advpanel__iconbtn"
            onClick={() => {
              query.invalidate();
              summaryQuery.invalidate();
            }}
            disabled={loading}
            aria-label={`Refresh ${workUnits}`}
          >
            <RefreshCw size={13} aria-hidden className={loading ? 'pc-advpanel__spin' : undefined} />
          </button>
        </Tooltip>
      </div>
      {error ? (
        <div className="pc-advpanel__empty pc-advpanel__empty--err">Could not load {workUnits}: {error}</div>
      ) : !items ? (
        <div className="pc-advpanel__empty">Loading {workUnits}…</div>
      ) : filtered.length === 0 ? (
        <div className="pc-advpanel__empty">
          {items.length === 0 ? `No ${workUnits} for this harness.` : `No ${workUnits} match the filter.`}
        </div>
      ) : (
        <VirtualGrid<WorkItemRow>
          columns={columns}
          rows={filtered}
          resizableColumns
          columnWidths={colWidths}
          onColumnWidthsChange={setColWidths}
          getRowId={(r) => r.id}
          onRowClick={(r) => void setSelectedId(r.id)}
          getRowBg={(r) =>
            r.id === selectedId ? 'color-mix(in oklab, var(--accent), transparent 80%)' : undefined
          }
          rowMinHeight={30}
          headerHeight={30}
          onEndReached={hasMore ? loadMore : undefined}
        />
      )}
    </div>
  );
}
