"use client";

/**
 * create:observations — the Observations browse pane (turn-end-reflection-
 * observations-2026-06-14 P-043 / D-005).
 *
 * PRE-IDEA sensor readings agents record at the END of a turn (the reflection
 * step), filed in the SEPARATE observation lane. This pane is BROWSE-ONLY:
 * observations never enter the work/triage queue (that is the whole point), so
 * there is deliberately NO triage / dispatch / claim affordance here. Data is
 * the `learning.observations` sync resolver (newest first); the only path from
 * an observation to actual work is Scout clustering a RECURRING one and
 * promoting it to a real idea — never from this surface.
 *
 * P-005: a paired learning.observations.summary query supplies exact corpus
 * totals plus drill-down facets; row payloads stay on 200-row keyset pages.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Table2, Layers, Search, XCircle } from "lucide-react";
import { parseAsString, parseAsStringEnum, useQueryState } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import type { CompanionListSummary } from "@papercusp/facets";
import {
  VirtualGrid,
  usePersistedColumnWidths,
  type ColumnDef,
  type FilterableColumn,
} from "@papercusp/grid-core";
import { readListMeta } from "@papercusp/operator-core/lib/sync-resolver/list-meta";
import type { PanelComponentProps } from "@/app/harness/dock/panel-registry";
import {
  useColumnFilterState,
  useColumnFiltersFromState,
  ColumnFilterBar,
  filterCountLabel,
  type CountEvidence,
} from "@/app/harness/filters";
import { CardStack } from "@papercusp/card-stack";
import { useItemPlanFilter } from "./use-create-data";
import { OBSERVATION_KIND_COLOR } from "@/app/harness/theme";
import { Tooltip } from "@/app/harness/Tooltip";
import { PERF_INTERACTIONS } from "@/app/_components/perf/perf-marks";
import { useInteractionSettle } from "@/app/_components/perf/use-interaction-settle";
import {
  mergeObservationPage,
  observationFacetOptions,
  observationServerFilters,
  observationSignalCounts,
} from "./observation-list-query";

// Mirrors LearningObservationRow (sync-resolver/learning-observations-read.ts).
// The optional fields are OMITTED from the wire when null (D-025, WI-7303) — every
// read site below already goes through `??`/truthiness, so absent and null behave
// identically here.
interface ObservationRow {
  id: string;
  title: string;
  body?: string;
  kind?: string;
  scope?: string;
  confidence?: string;
  refs: string[];
  sourceRole?: string;
  createdAt: string;
}

const KIND_LABEL: Record<string, string> = {
  friction: "Friction",
  workaround: "Workaround",
  gap: "Gap",
  surprise: "Surprise",
  reinforce: "Reinforce",
};

// Same growing server window used by Working → Work Queue. VirtualGrid keeps DOM
// work bounded while the explicit limit makes each next page part of the same
// sync-query stream. The resolver carries the true count on row[0]._meta.
export const OBSERVATIONS_PAGE = 200;

// Module-level EMPTY sentinel, not a `?? []` fresh literal at the use site.
// `allRows` feeds a useMemo dependency array (and, through it, useColumnFilters),
// so a new [] on every render makes every downstream memo miss its cache for as
// long as the query has no data — the same defect WorkItemsPanel's NO_ROWS
// comment names (WI-37386 / WI-39552). One frozen instance keeps the identity
// stable across renders.
const NO_ROWS: ObservationRow[] = [];

/**
 * Render count with "500+" guard: when count >= 500, display "500+"
 * instead of the exact number (WI-4374).
 */
function formatCount(count: number): string {
  return count >= 500 ? "500+" : count.toLocaleString();
}

/**
 * Split an expanded observation's BODY into a bold headline + preview at a
 * sentence-ish boundary (the Retain view's learningPreview pattern). Agents
 * file title = a hard character truncation of the body (often behind a
 * "[kind] " tag), so rendering title + body repeats the text and the stored
 * title can cut mid-word — the body is the readable source of truth.
 */
function splitBodyHeadline(text: string): { headline: string; rest: string } {
  const normalized = text.replace(/\s+/g, " ").trim();
  const boundary = [/\.\s/, /:\s/, / —\s/, /;\s/]
    .map((pattern) => normalized.search(pattern))
    .filter((index) => index >= 32 && index <= 140)
    .sort((a, b) => a - b)[0];
  const cut =
    boundary ??
    (normalized.length > 120
      ? normalized.lastIndexOf(" ", 120)
      : normalized.length);
  const safeCut =
    cut > 0 ? cut + (boundary == null ? 0 : 1) : normalized.length;
  return {
    headline: normalized.slice(0, safeCut).trim(),
    rest: normalized.slice(safeCut).trim(),
  };
}

/** Does the body's text subsume the stored title (title = body-head truncation)? */
function bodySubsumesTitle(title: string, body: string): boolean {
  const head = title
    .replace(/^\[[^\]]{1,32}\]\s*/, "")
    .replace(/[…\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return head.length > 0 && body.replace(/\s+/g, " ").trim().startsWith(head);
}

/**
 * Compute staleness tone based on the newest observation's age.
 * Returns "fresh" | "stale" | "very-stale" for visual indication.
 */
function getStalenessFromNewest(
  newestCreatedAt: string | null | undefined,
): "fresh" | "stale" | "very-stale" {
  if (!newestCreatedAt) return "very-stale";
  const newestMs = new Date(newestCreatedAt).getTime();
  const nowMs = Date.now();
  const ageMs = nowMs - newestMs;
  const ageMinutes = ageMs / (1000 * 60);
  // fresh: <30min, stale: 30min-2h, very-stale: >2h
  if (ageMinutes < 30) return "fresh";
  if (ageMinutes < 120) return "stale";
  return "very-stale";
}

export default function ObservationsPanel({
  onStatus,
  active = true,
}: Partial<PanelComponentProps> & {
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
  /** True when this pane is the SELECTED learning view. LearningTab keeps warm
   *  panes mounted and only flips `hidden`, so the settle point needs this to
   *  fire on a revisit that does not remount (EI-19383745196363732). */
  active?: boolean;
} = {}) {
  const [itemPlans] = useItemPlanFilter();
  const [signalFilter, setSignalFilter] = useState<string | null>(null);
  // The selected row is user-meaningful state, so it rides in the URL exactly
  // the way the Retained ledger's `?rsel` does (CLAUDE.md: user-meaningful
  // state → nuqs). That is what lets an agent reading `ui:get_state` see the
  // row the person is actually looking at, and a shared link reopen it.
  const [selectedId, setSelectedId] = useQueryState("obssel", parseAsString);
  // P-003 parity with Retain: the same persisted, resizable widths its ledger
  // has, under this pane's own key so the two tables never fight over one.
  const [colWidths, setColWidths] = usePersistedColumnWidths(
    "pc-colw:learning:observations",
  );
  // #4: shared filter/search libs, mirroring the Working → Work Queue pane.
  // A global quick-search (`obsq`) sits beside the shared ColumnFilterBar
  // (scope / role / confidence enums, `obsf` param via useColumnFilters).
  const [search, setSearch] = useQueryState(
    "obsq",
    parseAsString.withDefault(""),
  );
  // #7: Table (the rich grid) vs Stacks (same-kind cards overlapping, browsed
  // one at a time). Owner ask 2026-07-19.
  const [obsView, setObsView] = useQueryState(
    "obsview",
    parseAsStringEnum(["table", "stacks"]).withDefault("table"),
  );

  // The URL filter state exists before either query so rows, totals and facets
  // compile from the same server predicate. Kind keeps its compact chip UI.
  const filterColumns = useMemo<FilterableColumn<ObservationRow>[]>(
    () => [
      {
        key: "scope",
        header: "Scope",
        filter: { type: "enum", accessor: (row) => row.scope ?? "—" },
      },
      {
        key: "sourceRole",
        header: "Role",
        filter: { type: "enum", accessor: (row) => row.sourceRole ?? "—" },
      },
      {
        key: "confidence",
        header: "Confidence",
        filter: { type: "enum", accessor: (row) => row.confidence ?? "—" },
      },
    ],
    [],
  );
  const filterBinding = useColumnFilterState(filterColumns, "obs");
  const itemPlanKey = itemPlans.join("\0");
  const serverFilters = useMemo(
    () =>
      observationServerFilters(
        filterBinding.state,
        itemPlans,
        signalFilter,
      ),
    [filterBinding.state, itemPlanKey, signalFilter],
  );
  const filterFingerprint = JSON.stringify(serverFilters);
  const serverPredicateActive =
    search.trim() !== "" || Object.keys(serverFilters).length > 0;

  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedRows, setLoadedRows] = useState<ObservationRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  useEffect(() => {
    setCursor(null);
    setNextCursor(null);
    setLoadedRows([]);
  }, [search, filterFingerprint]);

  const sharedArgs = useMemo(
    () => ({ q: search, filters: serverFilters }),
    [search, serverFilters],
  );
  const query = useSyncQuery<ObservationRow>({
    queryName: "learning.observations",
    args: {
      ...sharedArgs,
      limit: OBSERVATIONS_PAGE,
      ...(cursor ? { cursor } : {}),
    },
    staleTime: 30_000,
  });
  const summaryQuery = useSyncQuery<CompanionListSummary>({
    queryName: "learning.observations.summary",
    args: sharedArgs,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (query.loading || !query.data) return;
    setLoadedRows((previous) =>
      mergeObservationPage(previous, query.data, cursor),
    );
    const meta = readListMeta(query.data);
    setNextCursor(
      typeof meta?.nextCursor === "string" ? meta.nextCursor : null,
    );
  }, [query.data, query.loading, cursor]);

  // Keep cached pages painted while either member of the pair refetches.
  const allRows = loadedRows.length > 0 ? loadedRows : (query.data ?? NO_ROWS);
  const summary = summaryQuery.data?.[0] ?? null;
  const pairedFetching = Boolean(query.fetching || summaryQuery.fetching);
  const facetCountEvidence = useMemo<CountEvidence>(() => {
    if (!summary) {
      return {
        kind: "unknown",
        reason: summaryQuery.error ? "failed" : "loading",
      };
    }
    if (pairedFetching) return { kind: "unknown", reason: "updating" };
    return {
      kind: "corpus",
      count: summary.matched,
      ...(serverPredicateActive ? { total: summary.total } : {}),
      population: "the observation corpus",
    };
  }, [summary, summaryQuery.error, pairedFetching, serverPredicateActive]);
  const facetOptions = useMemo(
    () => observationFacetOptions(summary),
    [summary],
  );
  const cf = useColumnFiltersFromState(
    filterColumns,
    allRows,
    {
      ns: "obs",
      countEvidence: facetCountEvidence,
      serverEnumOptions: facetOptions,
    },
    filterBinding,
  );
  // NOTE (WI-7304): this LOOKS redundant with the server-side `q` (sharedArgs ->
  // observationPredicateSql ORs title/body/observation_kind/refs ILIKE) and in the
  // STEADY state it is — the server keeps a row when any of those fields contains
  // `q`, and the concatenation below necessarily contains it too. It is NOT
  // redundant TEMPORALLY, which is the case that matters: between the keystroke
  // and the server's response, `loadedRows` has been reset but `query.data` can
  // still hold the pre-`q` page, so this pass is what narrows the list instantly
  // instead of showing stale unfiltered rows. Removing it was tried and reverted;
  // it is pinned by "filters the loaded rows through the quick-search box (#4)",
  // whose static mock models exactly that not-yet-filtered server.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cf.rows.filter((row) => {
      if (signalFilter && (row.kind ?? "other") !== signalFilter) return false;
      if (!q) return true;
      return `${row.title} ${row.body ?? ""} ${row.kind ?? ""} ${row.refs.join(" ")}`
        .toLowerCase()
        .includes(q);
    });
  }, [cf.rows, search, signalFilter]);
  const hasMore = nextCursor !== null;
  const isFiltered = serverPredicateActive;
  const counts = filterCountLabel(facetCountEvidence, "observation");
  const signalCounts = useMemo(
    () => observationSignalCounts(summary),
    [summary],
  );

  useEffect(() => {
    if (
      summary &&
      !pairedFetching &&
      signalFilter &&
      !signalCounts.some(([kind]) => kind === signalFilter)
    ) {
      setSignalFilter(null);
    }
  }, [summary, pairedFetching, signalCounts, signalFilter]);
  useEffect(() => {
    if (selectedId && !rows.some((row) => row.id === selectedId)) {
      void setSelectedId(null);
    }
  }, [rows, selectedId, setSelectedId]);
  const selectedRow = useMemo(
    () => (selectedId ? (rows.find((row) => row.id === selectedId) ?? null) : null),
    [rows, selectedId],
  );

  // Staleness tone: based on the newest observation's age
  const newestCreatedAt = allRows[0]?.createdAt ?? null;
  const stalenessLevel = getStalenessFromNewest(newestCreatedAt);

  useEffect(() => {
    onStatus?.(
      query.error ? "bad" : allRows.length > 0 ? "good" : "neutral",
    );
  }, [onStatus, query.error, allRows.length]);

  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch — LearningTab
  // renders this panel as its "observations" view and begins the interaction on
  // the view change (EI-19375505819043214).
  //
  // The summary is now a first-class member of the pair, so the interaction
  // settles only when both row and count/facet evidence have reached a verdict.
  //
  // endInteraction is measure-once and no-ops without a matching begin, so this
  // stays inert when the panel mounts outside a Learning-tab view switch.
  //
  // Gated on `active` as well as `settled`: LearningTab keeps this pane MOUNTED
  // when the user switches away, so on a revisit `settled` is already true and
  // never changes — an effect keyed on it alone would never re-run and the
  // switch would measure nothing (EI-19383745196363732).
  const settled = Boolean(
    !query.loading &&
      !summaryQuery.loading &&
      (query.data !== undefined || query.error) &&
      (summaryQuery.data !== undefined || summaryQuery.error),
  );
  useInteractionSettle(PERF_INTERACTIONS.learningViewSwitch, settled, active);
  const loadMore = useCallback(() => {
    if (nextCursor) setCursor(nextCursor);
  }, [nextCursor]);

  const columns = useMemo<ColumnDef<ObservationRow>[]>(
    () => [
      {
        key: "observation",
        header: "Observation",
        width: 8,
        toCopyText: (row) =>
          [
            row.kind ? (KIND_LABEL[row.kind] ?? row.kind) : null,
            row.title,
            row.body,
            [row.sourceRole, row.scope, row.confidence, ...row.refs]
              .filter(Boolean)
              .join(" · "),
          ]
            .filter(Boolean)
            .join("\n"),
        // The row is now an INDEX ENTRY, not an accordion: body, context and
        // refs live in the detail aside beside the grid (Retain's
        // RetainDetailAside pattern). That is what lets the row settle at
        // Retain's 30px and drop `measureVariableHeight` — a fixed-height slot
        // cannot clip a body it no longer renders, which is the whole class of
        // defect WI-5419 chased through the virtualizer.
        render: ({ row }) => {
          const selected = selectedId === row.id;
          const signal = row.kind
            ? (KIND_LABEL[row.kind] ?? row.kind)
            : "Other";
          return (
            <button
              type="button"
              className={`pc-observations__entry${selected ? " is-selected" : ""}`}
              aria-label={`${selected ? "Collapse" : "Expand"} observation ${row.title}`}
              aria-expanded={selected}
              // The grid's own onRowClick selects too; without this the click
              // would toggle twice and land back where it started.
              onClick={(e) => {
                e.stopPropagation();
                void setSelectedId(selected ? null : row.id);
              }}
            >
              <span
                className="pc-observations__signalmark"
                aria-label={`${signal} signal`}
                title={signal}
              >
                <i
                  aria-hidden
                  style={{
                    background:
                      OBSERVATION_KIND_COLOR[row.kind ?? ""] ??
                      "var(--fg-mute)",
                  }}
                />
                <span className="pc-observations__sr-only">{signal}</span>
              </span>
              <span className="pc-observations__copy">
                <strong>{row.title}</strong>
              </span>
            </button>
          );
        },
      },
      {
        key: "createdAt",
        header: "Observed",
        width: 2,
        toCopyText: (row) => row.createdAt,
        render: ({ row }) => (
          <span
            className="pc-observations__time"
            title={new Date(row.createdAt).toLocaleString()}
          >
            {new Date(row.createdAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        ),
      },
    ],
    [selectedId],
  );

  return (
    // The Retained ledger's card (pc-learning__retained): one bordered, rounded
    // surface whose head strip is the toolbar and whose body is the grid, so
    // the two tables read as one component rather than two house styles.
    <section className="pc-observations" aria-label="Observations">
      {/* The Retained ledger's own toolbar chrome. `--wrap` because this bar
          carries status chips (the signal distribution), which the shared
          stylesheet says should wrap to a second line rather than crush. */}
      <div className="pc-advpanel__bar pc-advpanel__bar--wrap">
        <label className="pc-observations__search">
          <Search size={12} aria-hidden />
          <input
            type="text"
            value={search}
            onChange={(e) => void setSearch(e.target.value)}
            placeholder="Search observations…"
            aria-label="Search observations"
          />
        </label>
        <ColumnFilterBar
          controller={cf.controller}
          activeChips={cf.activeChips}
          hasActive={cf.hasActive}
          clearAll={cf.clearAll}
        />
        {signalCounts.length > 0 ? (
          <div
            className="pc-observations__distribution"
            aria-label="Signal distribution (database counts)"
            data-staleness={stalenessLevel}
          >
            {signalCounts.map(([kind, count]) => (
              <Tooltip
                key={kind}
                label={`${KIND_LABEL[kind] ?? kind}: ${count.toLocaleString()}`}
              >
                <button
                  type="button"
                  aria-label={`Filter by ${KIND_LABEL[kind] ?? kind}, ${count.toLocaleString()}`}
                  aria-pressed={signalFilter === kind}
                  onClick={() =>
                    setSignalFilter((current) =>
                      current === kind ? null : kind,
                    )
                  }
                  className={kind === "other" ? "is-other" : undefined}
                >
                  <i
                    aria-hidden
                    style={{
                      background:
                        OBSERVATION_KIND_COLOR[kind] ?? "var(--fg-mute)",
                    }}
                  />
                  <span>{KIND_LABEL[kind] ?? kind}</span>
                  <strong>{formatCount(count)}</strong>
                </button>
              </Tooltip>
            ))}
          </div>
        ) : null}
        {counts ? (
          <span
            data-testid="observations-count"
            aria-label={counts.ariaLabel}
            title={
              isFiltered
                ? "Observations matching the current filter / search, out of the total"
                : "Observations available"
            }
            style={{
              color: "var(--fg-mute)",
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {counts.title}
          </span>
        ) : null}
        <div
          className="pc-observations__viewtoggle"
          role="group"
          aria-label="Observation view"
        >
          <button
            type="button"
            aria-pressed={obsView === "table"}
            aria-label="Table view"
            onClick={() => void setObsView("table")}
          >
            <Table2 size={13} aria-hidden />
          </button>
          <button
            type="button"
            aria-pressed={obsView === "stacks"}
            aria-label="Stacked cards view"
            onClick={() => void setObsView("stacks")}
          >
            <Layers size={13} aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className="pc-advpanel__iconbtn"
          aria-label="Refresh observations"
          disabled={pairedFetching}
          onClick={() => {
            query.invalidate();
            summaryQuery.invalidate();
          }}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>
      {query.loading && rows.length === 0 ? (
        // D-004: never claim a bare "loading" once an attempt has actually
        // FAILED. `loading` is TanStack's isLoading (isPending && isFetching),
        // which stays TRUE for the whole retry sequence while `error` stays
        // NULL until the retries are exhausted — so a read whose every attempt
        // times out shows a motionless spinner here and the error branch below
        // never gets a turn. failureCount/failureReason are the only signals
        // that separate "still working" from "failing and retrying", and a
        // manual retry beats waiting out the backoff.
        <div style={{ color: "var(--fg-mute)", padding: 12 }}>
          {query.failureCount > 0 ? (
            <>
              Still loading observations — {query.failureCount} attempt
              {query.failureCount === 1 ? "" : "s"} failed, retrying…
              <button
                type="button"
                className="pc-observations__retry"
                onClick={() => query.invalidate()}
              >
                Retry now
              </button>
              {query.failureReason ? (
                <div style={{ marginTop: 4, fontSize: 11 }}>
                  Last attempt:{" "}
                  {String(query.failureReason.message ?? query.failureReason)}
                </div>
              ) : null}
            </>
          ) : (
            "Loading observations…"
          )}
        </div>
      ) : query.error ? (
        <div style={{ color: "var(--bad)", padding: 12 }}>
          Could not load observations.
        </div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--fg-mute)", padding: 12 }}>
          {isFiltered || itemPlans.length
            ? "No observations match the current filter / search."
            : "No observations yet — they appear as agents reflect at the end of their turns."}
        </div>
      ) : obsView === "stacks" ? (
        <ObservationStacks
          rows={rows}
          selectedId={selectedId}
          onSelect={(id) => void setSelectedId(id)}
        />
      ) : (
        // Retain's index + detail split (pc-learning__retainlayout): the grid
        // narrows when a row is selected and the detail takes the other track,
        // instead of the row growing inside the virtualizer.
        <div
          className={`pc-observations__layout${selectedRow ? " has-detail" : ""}`}
        >
          <div className="pc-observations__index">
            <VirtualGrid<ObservationRow>
              columns={columns}
              rows={rows}
              resizableColumns
              columnWidths={colWidths}
              onColumnWidthsChange={setColWidths}
              getRowId={(row) => row.id}
              onRowClick={(row) =>
                void setSelectedId((current) =>
                  current === row.id ? null : row.id,
                )
              }
              getRowBg={(row) =>
                row.id === selectedId
                  ? "color-mix(in oklab, var(--accent), transparent 80%)"
                  : undefined
              }
              rowMinHeight={30}
              headerHeight={30}
              scrollStyle={{ maxHeight: 340 }}
              onEndReached={hasMore ? loadMore : undefined}
            />
          </div>
          {selectedRow ? (
            <ObservationDetailAside
              row={selectedRow}
              onClose={() => void setSelectedId(null)}
            />
          ) : null}
        </div>
      )}
      <style>{`
        .pc-observations__search { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2); color: var(--fg-mute); }
        .pc-observations__search:focus-within { border-color: color-mix(in srgb, var(--accent) 48%, var(--border)); color: var(--fg); }
        .pc-observations__search input { border: 0; background: none; outline: none; color: var(--fg); font: inherit; font-size: 11px; width: 150px; }
        .pc-observations__search input::placeholder { color: var(--fg-mute); }
        .pc-observations__retry { margin-left: 8px; padding: 2px 9px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2); color: var(--fg); font: inherit; font-size: 11px; cursor: pointer; }
        .pc-observations__retry:hover { border-color: color-mix(in srgb, var(--accent) 48%, var(--border)); }
        .pc-observations__viewtoggle { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
        .pc-observations__viewtoggle button { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 22px; min-height: 22px; border: 0; border-radius: 6px; background: none; color: var(--fg-mute); cursor: pointer; }
        .pc-observations__viewtoggle button:hover { color: var(--fg); }
        .pc-observations__viewtoggle button[aria-pressed="true"] { background: color-mix(in srgb, var(--accent) 16%, var(--bg-2)); color: var(--fg); }
        .pc-observations__stacks { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; align-content: start; padding: 8px; }
        /* The kind label + count render as CardStack's on-card header badge. */
        .pc-observations__stackgroup { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
        .pc-observations__kinddot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
        .pc-observations__card { display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 0 12px 11px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-2); color: inherit; text-align: left; font: inherit; cursor: pointer; }
        /* Accent header band (design pass 2026-07-19f), tinted by the deck's
           kind color via --cs-accent. */
        .pc-observations__card-head {
          margin: 0 -12px 2px; padding: 7px 12px 6px;
          background: linear-gradient(
            color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 10%, transparent),
            color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 3%, transparent));
          border-bottom: 1px solid color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 16%, var(--border));
        }
        .pc-observations__card:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
        .pc-observations__card.is-selected { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
        .pc-observations__card-head { display: flex; align-items: center; gap: 8px; }
        .pc-observations__card-title { font-size: 12.5px; font-weight: 620; color: var(--fg); overflow-wrap: anywhere; }
        .pc-observations__card.is-selected .pc-observations__card-title { color: var(--accent); }
        .pc-observations__distribution { display: flex; flex: 1 1 auto; align-items: center; gap: 5px; min-width: 0; overflow-x: auto; opacity: 1; transition: opacity 140ms ease; }
        .pc-observations__distribution[data-staleness="stale"] { opacity: 0.72; }
        .pc-observations__distribution[data-staleness="very-stale"] { opacity: 0.5; }
        .pc-observations__distribution button { display: inline-flex; flex: none; align-items: center; gap: 5px; min-height: 25px; padding: 3px 7px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2); color: var(--fg-mute); font: inherit; font-size: 9.5px; cursor: pointer; transition: color 140ms ease, border-color 140ms ease, background 140ms ease; }
        .pc-observations__distribution button:hover, .pc-observations__distribution button[aria-pressed="true"] { border-color: color-mix(in srgb, var(--accent) 48%, var(--border)); background: color-mix(in srgb, var(--accent) 7%, var(--bg-2)); color: var(--fg); }
        .pc-observations__distribution button.is-other { margin-left: 4px; border-style: dashed; opacity: .82; }
        .pc-observations__distribution button > i { width: 6px; height: 6px; flex: none; border-radius: 50%; }
        .pc-observations__distribution button > strong { color: var(--fg); font-size: 9.5px; font-variant-numeric: tabular-nums; }
        /* Centred and full-height, because the row is a fixed 30px slot now
           rather than a box that grows with an expanded body. */
        .pc-observations__entry { width: 100%; height: 100%; min-width: 0; display: grid; grid-template-columns: 10px minmax(0, 1fr); align-items: center; gap: 7px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
        .pc-observations__entry:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
        .pc-observations__entry.is-selected .pc-observations__copy > strong { color: var(--accent); }
        .pc-observations__signalmark { display: grid; place-items: center; width: 10px; height: 20px; }
        .pc-observations__signalmark i { width: 7px; height: 7px; border-radius: 50%; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 6%, transparent); }
        .pc-observations__copy { display: grid; gap: 2px; min-width: 0; }
        .pc-observations__copy > strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-observations__copy > strong { font-size: 12px; font-weight: 620; }
        /* The row no longer expands, so the head stays a single ellipsized
           line at every selection state — the full text is in the aside. */
        .pc-observations__body, .pc-observations__context { display: block; color: var(--fg-mute); font-size: 10.5px; line-height: 1.4; }
        .pc-observations__body { overflow-wrap: anywhere; white-space: normal; }
        .pc-observations__context { overflow-wrap: anywhere; font-style: normal; white-space: normal; }
        .pc-observations__time { display: block; overflow: hidden; color: var(--fg-mute); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
        .pc-observations__sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

        /* ── Retain parity: the card, the index/detail split, the aside ───── */
        /* Mirrors .pc-learning__retained — one bordered rounded surface whose
           head strip is the toolbar (pc-advpanel__bar brings its own
           border-bottom) and whose body is the grid. */
        .pc-observations {
          display: flex; flex-direction: column; height: 100%; min-height: 0;
          border: 1px solid var(--border); border-radius: 10px;
          background: var(--bg-2); overflow: hidden;
        }
        /* Mirrors .pc-learning__retainlayout, including its column ratio: the
           index gives way to the detail rather than the detail overlaying it. */
        .pc-observations__layout {
          display: grid; grid-template-columns: minmax(0, 1fr);
          gap: 8px; align-items: start; padding: 8px; min-height: 0;
        }
        .pc-observations__layout.has-detail { grid-template-columns: minmax(320px, .9fr) minmax(360px, 1.1fr); }
        .pc-observations__index { min-width: 0; }
        /* Mirrors .pc-learning__retaindetail. */
        .pc-observations__detail {
          min-width: 0; padding: 10px; border-radius: 9px;
          border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
          background: var(--bg-1);
        }
        .pc-observations__detail > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
        .pc-observations__detail > header button { all: unset; cursor: pointer; display: inline-flex; color: var(--fg-mute); }
        .pc-observations__detail > header button:hover { color: var(--fg); }
        .pc-observations__detail > header button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
        /* Tracking would be the obvious way to set a small uppercase label
           apart; it is not an approved primitive (lint:design-primitives), so
           the separation comes from case + size + weight — the same move
           chat-controls.css and .pc-learning__loopseclabel make. */
        .pc-observations__detailkind { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--fg-mute); }
        .pc-observations__detailkind i { width: 7px; height: 7px; border-radius: 50%; flex: none; }
        .pc-observations__detailtitle { display: block; font-size: 12.5px; font-weight: 620; color: var(--fg); overflow-wrap: anywhere; }
        .pc-observations__detailmeta { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 8px; }
        .pc-observations__detailmeta span { font-size: 10px; color: var(--fg-mute); border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; white-space: nowrap; }
      `}</style>
    </section>
  );
}

/**
 * The selected observation's detail, beside the index — Retain's
 * RetainDetailAside, in this pane's vocabulary (owner ask: "side panel like
 * Retain"). It carries what the row used to grow to show: the full body, the
 * refs, and the role / scope / confidence context.
 *
 * The headline split survives the move and matters MORE here, not less: agents
 * file `title` as a hard character truncation of the body, so rendering title
 * then body repeats the same words with the first copy cut mid-token. When the
 * body subsumes the title we re-split the BODY at a sentence boundary instead.
 */
function ObservationDetailAside({
  row,
  onClose,
}: {
  row: ObservationRow;
  onClose: () => void;
}) {
  const signal = row.kind ? (KIND_LABEL[row.kind] ?? row.kind) : "Other";
  const context = [row.sourceRole, row.scope, row.confidence].filter(Boolean);
  const subsumed = row.body ? bodySubsumesTitle(row.title, row.body) : false;
  const split = subsumed ? splitBodyHeadline(row.body ?? "") : null;
  const headline = split ? split.headline : row.title;
  const bodyTail = split ? split.rest || null : (row.body ?? null);
  return (
    <aside className="pc-observations__detail" aria-label="Observation detail">
      <header>
        <span className="pc-observations__detailkind">
          <i
            aria-hidden
            style={{
              background:
                OBSERVATION_KIND_COLOR[row.kind ?? ""] ?? "var(--fg-mute)",
            }}
          />
          {signal}
        </span>
        <button type="button" aria-label="Close detail" onClick={onClose}>
          <XCircle size={14} aria-hidden />
        </button>
      </header>
      <strong className="pc-observations__detailtitle">{headline}</strong>
      {/* Just the timestamp: role / scope / confidence are already in the
          context line below, and saying them twice in one panel is noise. */}
      <div className="pc-observations__detailmeta">
        <span>
          {new Date(row.createdAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
      </div>
      {bodyTail ? (
        <span className="pc-observations__body">{bodyTail}</span>
      ) : null}
      {/* The refs stay in the same single joined string the row used to show,
          so the copy text and this panel keep saying the same thing. */}
      {context.length > 0 || row.refs.length > 0 ? (
        <em className="pc-observations__context">
          {[...context, ...row.refs].join(" · ")}
        </em>
      ) : null}
    </aside>
  );
}

/**
 * #7 (owner ask 2026-07-19): the Stacks view — observations of the SAME kind
 * overlap into one deck the user browses one card at a time (via CardStack).
 * Groups render biggest-first with "other" pinned last, mirroring the count
 * chips' ordering so the two views read consistently.
 */
function ObservationStacks({
  rows,
  selectedId,
  onSelect,
}: {
  rows: ObservationRow[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const groups = useMemo(() => {
    const byKind = new Map<string, ObservationRow[]>();
    for (const row of rows) {
      const kind = row.kind ?? "other";
      const bucket = byKind.get(kind);
      if (bucket) bucket.push(row);
      else byKind.set(kind, [row]);
    }
    return [...byKind.entries()].sort((a, b) => {
      if (a[0] === "other") return 1;
      if (b[0] === "other") return -1;
      return b[1].length - a[1].length || a[0].localeCompare(b[0]);
    });
  }, [rows]);
  return (
    <div className="pc-observations__stacks">
      {groups.map(([kind, group]) => (
        <section
          key={kind}
          className="pc-observations__stackgroup"
          aria-label={`${KIND_LABEL[kind] ?? kind} observations`}
        >
          <CardStack
            items={group}
            getKey={(row) => row.id}
            ariaLabel={`${KIND_LABEL[kind] ?? kind} observations`}
            accent={OBSERVATION_KIND_COLOR[kind]}
            // The kind badge rides ON the active card's top edge (CardStack
            // renders it overlapping), keeping it attached to its deck.
            header={
              <>
                <i
                  className="pc-observations__kinddot"
                  aria-hidden
                  style={{
                    background:
                      OBSERVATION_KIND_COLOR[kind] ?? "var(--fg-mute)",
                  }}
                />
                <span className="pc-cardstack__header-label">
                  {KIND_LABEL[kind] ?? kind}
                </span>
                <span className="pc-cardstack__header-count">
                  {group.length}
                </span>
              </>
            }
            renderCard={(row) => (
              <ObservationCard
                row={row}
                selected={selectedId === row.id}
                onToggle={() =>
                  onSelect(selectedId === row.id ? null : row.id)
                }
              />
            )}
          />
        </section>
      ))}
    </div>
  );
}

function ObservationCard({
  row,
  selected,
  onToggle,
}: {
  row: ObservationRow;
  selected: boolean;
  onToggle: () => void;
}) {
  const context = [row.sourceRole, row.scope, row.confidence, ...row.refs]
    .filter(Boolean)
    .join(" · ");
  const subsumed =
    selected && row.body ? bodySubsumesTitle(row.title, row.body) : false;
  const split = subsumed ? splitBodyHeadline(row.body ?? "") : null;
  const headline = split ? split.headline : row.title;
  const bodyTail = selected ? (split ? split.rest || null : row.body) : null;
  return (
    <button
      type="button"
      className={`pc-observations__card${selected ? " is-selected" : ""}`}
      aria-expanded={selected}
      aria-label={`${selected ? "Collapse" : "Expand"} observation ${row.title}`}
      onClick={onToggle}
    >
      <span className="pc-observations__card-head">
        <span className="pc-observations__time">
          {new Date(row.createdAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </span>
      <strong className="pc-observations__card-title">{headline}</strong>
      {selected && bodyTail ? (
        <span className="pc-observations__body">{bodyTail}</span>
      ) : null}
      {selected && context ? (
        <em className="pc-observations__context">{context}</em>
      ) : null}
    </button>
  );
}
