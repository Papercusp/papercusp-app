"use client";

/**
 * PlansPane (owner-plans-single-pane-2026-07-17 P-001/P-002) — the simplified
 * plan-tracking face of the op-chat sidebar (`?opcv=plans`), beside the Inbox
 * face. The owner's ask: plan tracking is too complicated — so this pane is a
 * STATUS GLANCE, not a browser:
 *
 *   - ACTIVE plans only by default (bucketOf ∈ draft/ready/running); one
 *     search box; ONE "show finished" toggle. None of the Create dock's 11
 *     filter facets — authoring/power-filtering stays in /adv Create.
 *   - A sort picker (WI-40982) whose orders run over the ALREADY-FILTERED set:
 *     buildGlanceRows filters first and sorts last, so changing the sort never
 *     changes WHICH plans are shown, only their order.
 *   - Every row answers "does this need me?" without opening it: a needs-you
 *     badge (decision-tier attention count), a live-agents count, item
 *     progress (done/total), and last-activity recency.
 *   - Sorted needs-you first, then most recently active.
 *   - Clicking a row opens the plan DASHBOARD — the option-C app-pane takeover
 *     (plan-visibility-revamp-2026-08-23 P-005 / D-002: `?pdash`, rendered by
 *     PlanDashboardHost full-width in the app pane, back-affordanced and
 *     deep-linkable). The POPUP path is retired for this click; PlanPopupModal
 *     stays mounted for its other writers (`?pplan` deep links).
 *
 * REUSE, not re-derivation:
 *   - plan rows: the SAME `plans.list` sync feed (usePlanList) the Create
 *     dock + /admin/plans read (shared cache entry, SSE-invalidated);
 *   - needs-you counts: the SAME `plans.attention` feed the Inbox badge and
 *     Queue read (useInboxAttention → effectiveTier === 'decision');
 *   - live-agent counts: the SAME `advRoster.list` sync feed the Sessions
 *     roster reads (active entries' currentPlanSlug).
 *
 * State lives in the URL (nuqs) so the pane is deep-linkable and
 * agent-driveable: `?plq` search, `?plf` show-finished, `?plTrigger` trigger
 * facet, `?plSource` source facet, `?plSort` sort order, `?opcln` clean-up run,
 * `?pplan` popup plan, and `?ppv` popup tab (see PlanPopupModal).
 *
 * The filter row is ALWAYS OPEN (owner ask 2026-08-23, WI-40982). The old
 * `?plFilters` disclosure and its "Filters" toggle button are GONE: the compact
 * filter set costs less to show than a button that hides it, and the toolbar slot
 * the toggle vacated is exactly where the sort picker belongs — a fixed position
 * that cannot drift as facet chips wrap. A stale `?plFilters=…` deep link is
 * inert (the row it used to reveal is already open).
 */
import { Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Archive,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Hammer,
  Pencil,
  Search,
  X,
} from "lucide-react";
import {
  parseAsBoolean,
  parseAsString,
  parseAsStringEnum,
  useQueryState,
} from "nuqs";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { useSyncQuery } from "@papercusp/sync";
import { Select } from "@/app/harness/Select";
import { Tooltip } from "@/app/harness/Tooltip";
import { useDebouncedValue } from "@/app/harness/picker-kit";
import { useConfirmDialog } from "@/app/harness/useConfirmDialog";
import { preloadVditor } from "@/app/_components/MarkdownEditor";
import {
  bucketOf,
  setPlanArchived,
  planTriggerSourceLabel,
  usePlanList,
  type PlanBucket,
  type PlanListRow,
} from "@/app/admin/plans/plans-api";
import {
  PLAN_TRIGGER_FILTERS,
  type PlanTriggerFilter,
} from "@/app/admin/plans/plan-filtering";
import { comparePlans, type PlanSort } from "@/app/admin/plans/plan-sorting";
import { effectiveTier, useInboxAttention } from "../inbox/use-inbox-pending";
import { useWorkspaceId } from "@/lib/use-workspace-id";
import { useFlag } from "@/lib/flag-hooks";
import { FLAGS } from "@papercusp/flags";
import PlanPopupModal from "./PlanPopupModal";
import PlanProvenanceBadge, {
  matchesPlanSource,
  PLAN_SOURCE_FILTERS,
  planSourceFilterLabel,
  type PlanSourceFilter,
} from "./PlanProvenanceBadge";
import { LazyPlanDashboard, PLAN_DASHBOARD_PARAM } from "./PlanDashboardHost";
import PlanCleanupEntryButton from "./PlanCleanupEntryButton";
import PlansCleanupStrip from "./PlansCleanupStrip";
import {
  PLAN_CLEANUP_RUN_PARAM,
  usePlanCleanupRun,
} from "./use-plan-cleanup-run";
import {
  decodeScopedRef,
  encodeScopedRef,
} from "../chat/chat-ref-popup-params";
import "./plans-pane.css";
import { advRosterArgs } from "@/lib/adv-roster-args";

/** Buckets shown by default — "not started + started", never the finished. */
const ACTIVE_BUCKETS: ReadonlySet<PlanBucket> = new Set([
  "draft",
  "ready",
  "running",
]);

/** An active plan with no real activity for this long reads as "stale" — a
 *  visibility nudge against plan sprawl (owner-plans-single-pane P-008). */
export const STALE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * True when an active plan moved on NEITHER clock in ≥ STALE_MS — plan doc
 * unedited AND no work-item activity (plan-visibility-revamp-2026-08-23
 * P-002 / D-003: "a plan being worked without edits no longer reads stale",
 * the false-positive the single-clock read produced). Object args on purpose:
 * the old positional `(updated, now)` form would have silently read a `now`
 * passed by an un-migrated caller as the WORK clock — with an object every
 * call site was migrated by the compiler instead.
 */
export function isStale(opts: {
  updated?: string | null;
  lastWorkAtMs?: number | null;
  now?: number;
}): boolean {
  const now = opts.now ?? Date.now();
  const edit = opts.updated ? Date.parse(opts.updated) : NaN;
  const work = opts.lastWorkAtMs ?? NaN;
  const newest = Math.max(
    Number.isFinite(edit) ? edit : -Infinity,
    Number.isFinite(work) ? work : -Infinity,
  );
  return Number.isFinite(newest) && now - newest >= STALE_MS;
}

/** Work-item activity fresher than this renders the ⚒ time "hot" (green). */
export const WORK_HOT_MS = 60 * 60 * 1000;

/** Shared bucket logic behind both ago-label forms. */
function agoFromDelta(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Compact relative recency — same local convention as the roster/backup panes. */
export function agoLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  return agoFromDelta(Date.now() - Date.parse(iso));
}

/** `agoLabel` over an epoch-ms number (the planWorkActivity.list wire form). */
export function agoLabelMs(
  ms: number | null | undefined,
  now = Date.now(),
): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return agoFromDelta(now - ms);
}

/** "2m" → "2m ago", "now" → "just now" — for the hover titles. */
function agoPhrase(label: string): string {
  return label === "now" ? "just now" : `${label} ago`;
}

/** done / total-open+done item progress from the list row's itemCounts. */
export function progressOf(
  row: Pick<PlanListRow, "itemCounts">,
): { done: number; total: number } | null {
  const c = row.itemCounts;
  if (!c) return null;
  let done = 0;
  let total = 0;
  for (const [k, v] of Object.entries(c)) {
    const n = v ?? 0;
    if (k === "unknown") continue;
    total += n;
    if (k === "done") done += n;
  }
  return total > 0 ? { done, total } : null;
}

export interface PlanGlanceRow {
  plan: PlanListRow;
  needsYou: number;
  liveAgents: number;
}

/**
 * Sort orders this pane offers (WI-40982). Two of them are PANE-LOCAL because
 * they rank by data the shared plan comparator cannot see — `needsYou` comes
 * from the attention feed and `liveAgents` from the sessions roster, neither of
 * which is a field on PlanListRow. Every other order is DELEGATED to
 * `comparePlans` rather than re-derived here, so "Recently updated" means the
 * same thing in this pane as it does in the /adv Create dock (and the
 * undated-sorts-last and stable-tiebreak rules come along for free).
 */
const DELEGATED_SORTS = [
  "updated-desc",
  "updated-asc",
  "created-desc",
  "progress",
  "title",
] as const;
type DelegatedSort = (typeof DELEGATED_SORTS)[number];

/** Compile-time pin: every delegated id must still BE a `PlanSort`. Renaming one
 *  upstream fails here instead of silently falling through to the default sort. */
const _DELEGATED_ARE_PLAN_SORTS: readonly PlanSort[] = DELEGATED_SORTS;
void _DELEGATED_ARE_PLAN_SORTS;

export type PlansPaneSort = "needs" | "live" | DelegatedSort;

export const PLANS_PANE_SORTS: ReadonlyArray<{
  id: PlansPaneSort;
  label: string;
}> = [
  { id: "needs", label: "Needs you" },
  { id: "live", label: "Live agents" },
  { id: "updated-desc", label: "Recently updated" },
  { id: "updated-asc", label: "Oldest updated" },
  { id: "created-desc", label: "Recently created" },
  { id: "progress", label: "Progress" },
  { id: "title", label: "Title A–Z" },
];

export const PLANS_PANE_SORT_IDS: PlansPaneSort[] = PLANS_PANE_SORTS.map(
  (s) => s.id,
);

/** The default order — needs-you first, then most recently active. */
export const DEFAULT_PLANS_PANE_SORT: PlansPaneSort = "needs";

export function plansPaneSortLabel(sort: PlansPaneSort): string {
  return PLANS_PANE_SORTS.find((s) => s.id === sort)?.label ?? sort;
}

/** Comparator for one glance-row order. Pure — exported for unit tests. */
export function compareGlanceRows(
  sort: PlansPaneSort,
): (a: PlanGlanceRow, b: PlanGlanceRow) => number {
  // Shared tail for the two pane-local orders: within an equal rank, the most
  // recently active plan reads first (what the pane has always done).
  const byRecency = comparePlans("updated-desc");
  switch (sort) {
    case "needs":
      return (a, b) => b.needsYou - a.needsYou || byRecency(a.plan, b.plan);
    case "live":
      // Busiest plans first; a tie falls back to the needs-you read, so the
      // "does this need me?" signal is never buried by a quiet plan.
      return (a, b) =>
        b.liveAgents - a.liveAgents ||
        b.needsYou - a.needsYou ||
        byRecency(a.plan, b.plan);
    default: {
      const cmp = comparePlans(sort);
      return (a, b) => cmp(a.plan, b.plan);
    }
  }
}

/** Filter + decorate + sort the raw plan list into the glance rows.
 *  Pure — exported for unit tests.
 *
 *  ORDER OF OPERATIONS is the contract (WI-40982): every filter runs first and
 *  the sort runs last, over whatever survived. A sort can therefore never
 *  re-admit a plan the search/finished/trigger facets excluded. */
export function buildGlanceRows(opts: {
  plans: readonly PlanListRow[];
  query: string;
  showFinished: boolean;
  needsYouByPlan: ReadonlyMap<string, number>;
  liveByPlan: ReadonlyMap<string, number>;
  triggerFilter?: PlanTriggerFilter;
  sourceFilter?: PlanSourceFilter;
  sort?: PlansPaneSort;
}): PlanGlanceRow[] {
  const q = opts.query.trim().toLowerCase();
  const rows: PlanGlanceRow[] = [];
  for (const plan of opts.plans) {
    if (plan.archived || plan.isLegacy) continue;
    const bucket = bucketOf(plan);
    if (!opts.showFinished && !ACTIVE_BUCKETS.has(bucket)) continue;
    if (opts.triggerFilter === "triggered" && plan.triggered !== true) continue;
    if (opts.triggerFilter === "one-time" && plan.triggered === true) continue;
    if (!matchesPlanSource(plan, opts.sourceFilter ?? "all")) continue;
    if (q) {
      const hay = `${plan.title ?? ""} ${plan.slug}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    rows.push({
      plan,
      needsYou: opts.needsYouByPlan.get(plan.slug) ?? 0,
      liveAgents: opts.liveByPlan.get(plan.slug) ?? 0,
    });
  }
  rows.sort(compareGlanceRows(opts.sort ?? DEFAULT_PLANS_PANE_SORT));
  return rows;
}

/** The advRoster.list payload's one row (subset this pane reads). */
interface RosterPayloadRow {
  active?: Array<{ currentPlanSlug?: string | null }>;
}

/** One planWorkActivity.list wire row (plan-visibility-revamp P-001). */
interface PlanWorkActivityRow {
  slug?: string;
  lastWorkAtMs?: number;
}

/**
 * How the pane lays out its list and the selected plan's dashboard
 * (portal-work-two-pane-2026-09-01 D-001).
 *  - `stack` — the chat-sidebar list; a row click opens the app-pane
 *    PlanDashboardHost takeover. The default, and unchanged by this prop.
 *  - `split` — list on the left, the selected plan's dashboard in a
 *    right-hand aside. Used only by the operator-vite `/plans` full-page
 *    route the cloud portal embeds (which skips the root takeover host).
 *    Selection is the same `?pdash` either way.
 */
export type PlansPaneLayout = "stack" | "split";

export default function PlansPane({
  layout = "stack",
}: {
  layout?: PlansPaneLayout;
} = {}) {
  const split = layout === "split";
  const [query, setQuery] = useQueryState("plq", parseAsString.withDefault(""));
  const [showFinished, setShowFinished] = useQueryState(
    "plf",
    parseAsBoolean.withDefault(false),
  );
  const [sort, setSort] = useQueryState(
    "plSort",
    parseAsStringEnum<PlansPaneSort>([...PLANS_PANE_SORT_IDS]).withDefault(
      DEFAULT_PLANS_PANE_SORT,
    ),
  );
  const [triggerFilter, setTriggerFilter] = useQueryState(
    "plTrigger",
    parseAsStringEnum<PlanTriggerFilter>([...PLAN_TRIGGER_FILTERS]).withDefault(
      "all",
    ),
  );
  const [sourceFilter, setSourceFilter] = useQueryState(
    "plSource",
    parseAsStringEnum<PlanSourceFilter>([...PLAN_SOURCE_FILTERS]).withDefault(
      "all",
    ),
  );
  const [popupPlan, setPopupPlan] = useQueryState("pplan", parseAsString);
  // P-006: the selected clean-up RUN is URL-owned. A reload or copied link
  // resumes against the persisted phase instead of resetting to local idle.
  const [cleanupRunId, setCleanupRunId] = useQueryState(
    PLAN_CLEANUP_RUN_PARAM,
    parseAsString,
  );
  // P-005 (D-002): a row click opens the app-pane dashboard takeover — the
  // param PlanDashboardHost renders. `pplan` (the popup) remains for its other
  // writers; this pane no longer writes it from rows.
  const [dashPlan, setDashPlan] = useQueryState(
    PLAN_DASHBOARD_PARAM,
    parseAsString,
  );
  // The selected plan (D-001): the same scoped ref the row click writes. In
  // split mode the aside renders its dashboard; in every mode the matching
  // row reads `is-selected`.
  const dashTarget = useMemo(
    () => decodeScopedRef(dashPlan ?? null),
    [dashPlan],
  );
  // Split mode's detail column — a focus landmark (tabIndex -1) so the
  // dashboard's unmount never strands keyboard focus on <body>.
  const asideRef = useRef<HTMLElement | null>(null);

  // Warm the Vditor stack shortly after the Plans face mounts, so the first
  // plan popup opens WARM (~430ms) instead of paying the ~600ms cold Lute/WASM
  // init on the click (WI-5547 — the "several seconds to load a plan" report).
  // A plain setTimeout (NOT requestIdleCallback — unreliable in the Tauri
  // WebKitGTK webview) guarantees it fires; the 600ms delay yields the mount +
  // initial list render before the warm work runs off the critical path.
  useEffect(() => {
    const t = window.setTimeout(() => void preloadVditor(), 600);
    return () => window.clearTimeout(t);
  }, []);

  // The input updates ?plq on every keystroke (instant), but the EXPENSIVE
  // consumer — buildGlanceRows re-filtering + re-rendering the whole (up to
  // ~500-row) unvirtualized list — reads this DEBOUNCED value, so typing stays
  // responsive and the heavy re-render runs once typing settles. Same lesson
  // the Create dock's PlanRail learned (a fresh filter per keystroke lagged ~1s).
  const debouncedQuery = useDebouncedValue(query, 200);

  const planList = usePlanList({});
  const { items: attentionItems } = useInboxAttention();
  const workspaceId = useWorkspaceId();

  // Live-agent counts: the shared Sessions-roster sync entry (no new query
  // when the roster panel is also mounted). Reading only active[].currentPlanSlug.
  // NB this comment was ASPIRATIONAL until P-026 — the call site omitted
  // `endedLimit`, and an omitted field is a different query key even though the
  // resolver defaults it to the same value. advRosterArgs makes it true.
  const roster = useSyncQuery<RosterPayloadRow>({
    queryName: "advRoster.list",
    args: advRosterArgs(workspaceId),
  });

  const needsYouByPlan = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of attentionItems) {
      if (!i.planSlug) continue;
      if (effectiveTier(i) !== "decision") continue;
      m.set(i.planSlug, (m.get(i.planSlug) ?? 0) + 1);
    }
    return m;
  }, [attentionItems]);

  const liveByPlan = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of roster.data?.[0]?.active ?? []) {
      const slug = e.currentPlanSlug;
      if (!slug) continue;
      m.set(slug, (m.get(slug) ?? 0) + 1);
    }
    return m;
  }, [roster.data]);

  // ⚒ last-work timestamps: the planWorkActivity.list sync feed (P-001 —
  // slug → max work-item activity in epoch ms, work_items-invalidated).
  // Joined client-side by slug exactly like needsYouByPlan / liveByPlan.
  // A plan absent from the map was simply never worked (dim em-dash).
  const workActivity = useSyncQuery<PlanWorkActivityRow>({
    queryName: "planWorkActivity.list",
    args: { workspaceId },
  });
  const lastWorkByPlan = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of workActivity.data ?? []) {
      if (
        typeof r?.slug === "string" &&
        r.slug &&
        typeof r.lastWorkAtMs === "number"
      ) {
        m.set(r.slug, r.lastWorkAtMs);
      }
    }
    return m;
  }, [workActivity.data]);

  const plans = planList.data?.plans;
  const rows = useMemo(
    () =>
      buildGlanceRows({
        plans: plans ?? [],
        query: debouncedQuery,
        showFinished,
        needsYouByPlan,
        liveByPlan,
        triggerFilter,
        sourceFilter,
        sort,
      }),
    [
      plans,
      debouncedQuery,
      showFinished,
      needsYouByPlan,
      liveByPlan,
      triggerFilter,
      sourceFilter,
      sort,
    ],
  );

  // Plans clean-up acts on the EXACT rows above — after every pane filter and
  // before no server-side re-derivation. Sorting is retained as provenance but
  // does not change membership. Flag OFF holds no sync subscription and mounts
  // no additive strip.
  const cleanupEnabled = useFlag(FLAGS.PLAN_CLEANUP);
  const cleanup = usePlanCleanupRun(cleanupRunId, { enabled: cleanupEnabled });
  const cleanupPlanSlugs = useMemo(
    () => rows.map((row) => row.plan.slug),
    [rows],
  );
  const cleanupFilterSnapshot = useMemo(
    () => ({
      query: debouncedQuery.trim() || null,
      showFinished,
      trigger: triggerFilter,
      source: sourceFilter,
      sort,
      shownCount: cleanupPlanSlugs.length,
    }),
    [
      debouncedQuery,
      showFinished,
      triggerFilter,
      sourceFilter,
      sort,
      cleanupPlanSlugs.length,
    ],
  );

  const popupRow = popupPlan
    ? ((plans ?? []).find((p) => p.slug === popupPlan) ?? null)
    : null;

  // Stale-plan sweep (P-008 / EI-15304): archive a stale plan in one click,
  // behind a confirm. Archiving flips the PG-canonical harness_plans.archived
  // flag (plans:set-archived) — reversible; the row then drops out of this list
  // because every plan reader filters `archived = false`.
  //
  // We refresh the plan list EXPLICITLY after the write instead of waiting on
  // the harness_plans → plans.list SSE invalidation: live-verified in an
  // isolated shell, the archived row was still rendered 3s after a confirmed
  // write, so relying on the push alone leaves the user staring at a plan they
  // just archived. Same post-write refresh PlansListPanel already does.
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const onArchive = useCallback(
    async (plan: PlanListRow) => {
      const ok = await askConfirm({
        title: "Archive this plan?",
        body: `“${plan.title ?? plan.slug}” will drop out of your plan lists. You can restore it later — archiving is reversible and never deletes anything.`,
        confirmLabel: "Archive",
      });
      if (!ok) return;
      try {
        const res = await setPlanArchived({
          slug: plan.slug,
          archived: true,
          harness: plan.harness,
        });
        if ((res as { ok?: boolean }).ok === false) {
          toast.error(
            `Could not archive: ${(res as { error?: string }).error ?? "unknown error"}`,
          );
          return;
        }
        toast.success(`Archived “${plan.title ?? plan.slug}”.`);
        planList.refresh();
      } catch (e) {
        toast.error(
          `Could not archive: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
    },
    [askConfirm, planList],
  );

  // Virtualize the row list (WI-5339): the active set is ~466 rows and up to
  // ~977 with Finished on — rendering them all unvirtualized made a ~89k-px DOM
  // and a ~600ms filter re-render in an always-visible sidebar. Only the rows
  // near the viewport mount now; heights self-correct via measureElement.
  const listRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 104,
    overscan: 10,
    getItemKey: (i) => `${rows[i]!.plan.harness}:${rows[i]!.plan.slug}`,
  });

  // `data-has-selection` is presence-only: the narrow-width split CSS swaps
  // which column is shown on it. The `plans-pane__column` wrapper is
  // display:contents in stack mode (the sidebar's box tree is unchanged); in
  // split mode it is the left (list) column.
  return (
    <div
      className={`plans-pane${split ? " plans-pane--split" : ""}`}
      data-testid="plans-pane"
      data-layout={layout}
      data-has-selection={split && dashTarget.id ? "" : undefined}
    >
      <div className="plans-pane__column">
      <header className="plans-pane__masthead">
        <span className="plans-pane__masthead-icon" aria-hidden="true">
          <ClipboardList size={20} />
        </span>
        <span className="plans-pane__masthead-copy">
          <span className="plans-pane__masthead-eyebrow">Plan workspace</span>
          <strong>Plans</strong>
          <span className="plans-pane__masthead-subtitle">
            Track active work, decisions, and live progress in one place.
          </span>
        </span>
        <span
          className="plans-pane__masthead-count"
          aria-label={`${rows.length} ${rows.length === 1 ? "plan" : "plans"} shown`}
          data-testid="plans-pane-count"
        >
          <span
            className="plans-pane__masthead-count-value"
            data-testid="plans-pane-count-value"
          >
            {rows.length}
          </span>
          <span className="plans-pane__masthead-count-label">shown</span>
        </span>
      </header>

      {cleanupEnabled ? (
        <PlansCleanupStrip
          planSlugs={cleanupPlanSlugs}
          filterSnapshot={cleanupFilterSnapshot}
          run={cleanup.run}
          findings={cleanup.findings}
          recommendations={cleanup.recommendations}
          pending={cleanup.pending}
          isRunning={cleanup.isRunning}
          isReview={cleanup.isReview}
          onRunStarted={(runId) => void setCleanupRunId(runId)}
          onReview={(runId) => void setCleanupRunId(runId)}
          onRunCleared={() => void setCleanupRunId(null)}
        />
      ) : null}

      <section
        className="plans-pane__controls"
        aria-label="Plan search and filters"
      >
        <div className="plans-pane__controls-head">
          <span className="plans-pane__controls-label">Find and focus</span>
          <span
            className="plans-pane__controls-scope"
            data-testid="plans-pane-visible-scope"
          >
            {rows.length} shown ·{" "}
            {showFinished ? "active + finished" : "active only"}
          </span>
        </div>
        <div className="plans-pane__toolbar">
          <label className="plans-pane__search-shell">
            <Search
              size={14}
              className="plans-pane__search-icon"
              aria-hidden="true"
            />
            <input
              type="search"
              className="plans-pane__search"
              placeholder="Search plans…"
              value={query}
              onChange={(e) => void setQuery(e.target.value || null)}
              aria-label="Search plans"
              data-testid="plans-pane-search"
            />
            {query ? (
              <button
                type="button"
                className="plans-pane__search-clear"
                aria-label="Clear plan search"
                onClick={() => void setQuery(null)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
          </label>
          {/* Sort picker — the shared Radix Select (native <select> is banned by
              _lints/design-primitives). It sits in the slot the deleted "Filters"
              toggle vacated, so it holds a FIXED position: parking it in the
              filter row below would let it drift sideways as facet chips wrap. */}
          <Select
            value={sort}
            onChange={(v) =>
              void setSort(
                v === DEFAULT_PLANS_PANE_SORT ? null : (v as PlansPaneSort),
              )
            }
            options={PLANS_PANE_SORTS.map((s) => ({
              value: s.id,
              label: s.label,
            }))}
            ariaLabel="Sort plans"
            testId="plans-pane-sort"
            triggerClassName="plans-pane__sort"
            align="end"
            triggerChildren={
              <>
                <ArrowUpDown size={13} aria-hidden="true" />
                <span className="plans-pane__sort-label">
                  {plansPaneSortLabel(sort)}
                </span>
                <ChevronDown size={11} aria-hidden="true" />
              </>
            }
          />
        </div>

        {/* Always open (WI-40982) — no disclosure, no toggle. */}
        <div
          id="plans-pane-filters"
          className="plans-pane__filters"
          data-testid="plans-pane-filters"
        >
          <Tooltip
            label={
              showFinished
                ? "Hide finished plans"
                : "Also show shipped / superseded plans"
            }
          >
            <button
              type="button"
              className={`plans-pane__finished-toggle${showFinished ? " is-on" : ""}`}
              onClick={() => void setShowFinished(showFinished ? null : true)}
              aria-pressed={showFinished}
              data-testid="plans-pane-finished-toggle"
            >
              Finished
            </button>
          </Tooltip>
          <div
            className="plans-pane__trigger-filter"
            role="group"
            aria-label="Plan trigger type"
          >
            {PLAN_TRIGGER_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                className={`plans-pane__trigger-chip${triggerFilter === value ? " is-on" : ""}`}
                aria-pressed={triggerFilter === value}
                onClick={() =>
                  void setTriggerFilter(value === "all" ? null : value)
                }
              >
                {value}
              </button>
            ))}
          </div>
          <div
            className="plans-pane__source-filter"
            role="group"
            aria-label="Plan source"
            data-testid="plans-pane-source-filter"
          >
            {PLAN_SOURCE_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                className={`plans-pane__source-chip${sourceFilter === value ? " is-on" : ""}`}
                aria-pressed={sourceFilter === value}
                onClick={() =>
                  void setSourceFilter(value === "all" ? null : value)
                }
              >
                {planSourceFilterLabel(value)}
              </button>
            ))}
          </div>
        </div>
      </section>

      {planList.loading && !plans ? (
        <div className="plans-pane__empty">Loading plans…</div>
      ) : rows.length === 0 ? (
        <div className="plans-pane__empty">
          <ClipboardList
            size={20}
            className="plans-pane__empty-icon"
            aria-hidden="true"
          />
          <span>
            {debouncedQuery.trim()
              ? "No plans match the search."
              : triggerFilter !== "all" || sourceFilter !== "all"
                ? "No plans match the current filters."
                : !plans || plans.length === 0
                  ? // Feed not yet hydrated (or a genuinely empty workspace) — NEVER
                    // the celebratory "all finished" here. On a cold/slow load
                    // `plans` is briefly empty (sometimes with loading already
                    // false), which used to flash "everything is finished 🎉" over
                    // ~466 real active plans before the list populated (WI-5338).
                    planList.loading
                    ? "Loading plans…"
                    : "No plans yet."
                  : showFinished
                    ? "No plans yet."
                    : "No active plans — everything is finished. 🎉"}
          </span>
        </div>
      ) : (
        <div
          className="plans-pane__list"
          ref={listRef}
          role="list"
          aria-label="Plans"
        >
          <div
            style={{
              height: rowVirtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const { plan, needsYou, liveAgents } = rows[vi.index]!;
              const progress = progressOf(plan);
              const bucket = bucketOf(plan);
              // ⚒ last-work clock (P-002/D-003): hot under 1h; absent = never
              // worked. Stale now means NEITHER clock moved in 14d.
              const lastWorkAtMs = lastWorkByPlan.get(plan.slug) ?? null;
              const workHot =
                lastWorkAtMs != null && Date.now() - lastWorkAtMs < WORK_HOT_MS;
              const stale =
                !showFinished &&
                isStale({ updated: plan.updated, lastWorkAtMs });
              // WI-5365: left-accent priority — needs-you (red) outranks live (green).
              const accent =
                needsYou > 0
                  ? " plans-pane__row--needs"
                  : liveAgents > 0
                    ? " plans-pane__row--live"
                    : "";
              // D-001: the row whose dashboard `?pdash` currently opens.
              const isSel =
                dashTarget.id === plan.slug &&
                (!dashTarget.harness || dashTarget.harness === plan.harness);
              return (
                <div
                  key={vi.key}
                  role="listitem"
                  data-index={vi.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    paddingBottom: 4,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <button
                    type="button"
                    className={`plans-pane__row${accent}${isSel ? " is-selected" : ""}`}
                    aria-current={isSel ? "true" : undefined}
                    aria-label={`Open plan ${plan.title ?? plan.slug}`}
                    onClick={() => {
                      // P-005 (D-002): the row opens the option-C DASHBOARD
                      // app-pane takeover, not the popup. The ref carries its
                      // own harness (wpop/wppop grammar) — this sidebar is a
                      // cross-harness mount. No beginInteraction here: the
                      // WI-5547 planPopupOpen mark is closed by the Vditor
                      // parse, which the dashboard does not render (the popup
                      // path — now the dashboard's "Open full plan" — still
                      // times itself end-to-end via the ?wppop host).
                      void setDashPlan(
                        encodeScopedRef(plan.harness, plan.slug),
                      );
                    }}
                    data-testid={`plans-pane-row-${plan.slug}`}
                  >
                    <span className="plans-pane__row-icon" aria-hidden="true">
                      <ClipboardList size={16} />
                    </span>
                    <span className="plans-pane__row-main">
                      <span className="plans-pane__row-head">
                        <span
                          className={`plans-pane__bucket plans-pane__bucket--${bucket}`}
                        >
                          {bucket === "running" ? "plan" : bucket}
                        </span>
                        <span className="plans-pane__row-harness">
                          {plan.harness}
                        </span>
                        <span className="plans-pane__row-head-spacer" />
                        {/* V1 header pair (RowTimestamps.dc.html): ✎ last plan
                            edit + ⚒ last work-item activity. Native titles per
                            the in-row convention (badges do the same). */}
                        <span
                          className="plans-pane__row-t"
                          title={
                            plan.updated
                              ? `✎ Plan edited ${agoPhrase(agoLabel(plan.updated))} — ${new Date(Date.parse(plan.updated)).toLocaleString()}`
                              : "✎ Plan edit time unknown"
                          }
                          data-testid={`plans-pane-edit-t-${plan.slug}`}
                        >
                          <Pencil size={11} aria-hidden="true" />
                          {agoLabel(plan.updated)}
                        </span>
                        <span
                          className={`plans-pane__row-t${
                            workHot
                              ? " plans-pane__row-t--hot"
                              : lastWorkAtMs == null
                                ? " plans-pane__row-t--dim"
                                : ""
                          }`}
                          title={
                            lastWorkAtMs != null
                              ? `⚒ Last work ${agoPhrase(agoLabelMs(lastWorkAtMs))} — ${new Date(lastWorkAtMs).toLocaleString()}`
                              : "⚒ No work-item activity yet"
                          }
                          data-testid={`plans-pane-work-t-${plan.slug}`}
                        >
                          <Hammer size={11} aria-hidden="true" />
                          {agoLabelMs(lastWorkAtMs)}
                        </span>
                      </span>
                      <span className="plans-pane__row-title">
                        {plan.title ?? plan.slug}
                      </span>
                      <span className="plans-pane__row-status">
                        {needsYou > 0
                          ? `${needsYou} decision${needsYou === 1 ? "" : "s"} need you`
                          : liveAgents > 0
                            ? `${liveAgents} agent${liveAgents === 1 ? "" : "s"} working now`
                            : progress
                              ? `${progress.done} of ${progress.total} items done`
                              : "Open plan details"}
                      </span>
                    </span>
                    <span className="plans-pane__row-badges">
                      {plan.triggered ? (
                        <span
                          className="plans-pane__badge plans-pane__badge--trigger"
                          title={`Triggered plan · ${planTriggerSourceLabel(plan.triggerSources)}`}
                          data-testid="plans-pane-trigger-badge"
                        >
                          {planTriggerSourceLabel(plan.triggerSources)}
                        </span>
                      ) : null}
                      <PlanProvenanceBadge
                        origin={plan.origin}
                        ownerIdentity={plan.ownerIdentity}
                        testId="plans-pane-source-badge"
                      />
                      {needsYou > 0 ? (
                        <span
                          className="plans-pane__badge plans-pane__badge--needs"
                          title={`${needsYou} decision${needsYou === 1 ? "" : "s"} need you`}
                          data-testid="plans-pane-needs-badge"
                        >
                          {needsYou}
                        </span>
                      ) : null}
                      {liveAgents > 0 ? (
                        <span
                          className="plans-pane__badge plans-pane__badge--live"
                          title={`${liveAgents} agent${liveAgents === 1 ? "" : "s"} working now`}
                          data-testid="plans-pane-live-badge"
                        >
                          ●&nbsp;{liveAgents}
                        </span>
                      ) : null}
                      {progress ? (
                        <span
                          className="plans-pane__badge plans-pane__badge--progress"
                          title={`${progress.done} of ${progress.total} items done`}
                        >
                          {progress.done}/{progress.total}
                        </span>
                      ) : null}
                      {stale ? (
                        <span
                          className="plans-pane__badge plans-pane__badge--stale"
                          title="No plan edits or work-item activity in 14 days — a candidate to archive"
                          data-testid="plans-pane-stale-badge"
                        >
                          stale
                        </span>
                      ) : null}
                    </span>
                    <ChevronRight
                      className="plans-pane__row-chevron"
                      size={16}
                      aria-hidden="true"
                    />
                    {progress ? (
                      // WI-5365: glanceable done/total as a 2px strip along the
                      // row's bottom edge (the n/m badge stays the precise read).
                      <span
                        className="plans-pane__progress-track"
                        aria-hidden="true"
                      >
                        <span
                          className="plans-pane__progress-fill"
                          style={{
                            width: `${Math.round((progress.done / progress.total) * 100)}%`,
                          }}
                        />
                      </span>
                    ) : null}
                  </button>
                  {cleanupEnabled ? (
                    <PlanCleanupEntryButton
                      planSlug={plan.slug}
                      harness={plan.harness}
                      title={plan.title ?? plan.slug}
                      appearance="row"
                      active={Boolean(
                        cleanup.isRunning &&
                        cleanup.run?.seedRefs.length === 1 &&
                        cleanup.run.seedRefs[0] === plan.slug,
                      )}
                      onRunStarted={(runId) => void setCleanupRunId(runId)}
                    />
                  ) : null}
                  {/* P-008 / EI-15304: one-click archive for a STALE row — the
                    sprawl sweep. A SIBLING of the row button, never nested
                    (a <button> inside a <button> is invalid HTML — the trap
                    InboxPane already hit). Scoped to stale rows so the
                    ~466-row list stays visually clean. */}
                  {stale ? (
                    <Tooltip label="Archive this stale plan (reversible)">
                      <button
                        type="button"
                        className="plans-pane__archive"
                        onClick={() => void onArchive(plan)}
                        aria-label={`Archive ${plan.title ?? plan.slug}`}
                        data-testid={`plans-pane-archive-${plan.slug}`}
                      >
                        <span
                          className="plans-pane__row-action-icon"
                          aria-hidden="true"
                        >
                          <Archive size={12} />
                        </span>
                      </button>
                    </Tooltip>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="plans-pane__foot">
        <span>{rows.length} shown</span>
        <span>{showFinished ? "Active + finished" : "Active plans"}</span>
      </div>
      </div>

      {split ? (
        <aside
          ref={asideRef}
          tabIndex={-1}
          className="plans-pane__aside"
          data-testid="plans-pane-aside"
          aria-label="Selected plan"
        >
          {dashTarget.id ? (
            // The dashboard's own back control (`onBack`) clears `?pdash`;
            // at narrow widths that is the way back to the list.
            <Suspense fallback={null}>
              <LazyPlanDashboard
                key={dashTarget.id}
                planSlug={dashTarget.id}
                harnessSlug={dashTarget.harness}
                onBack={() => void setDashPlan(null)}
              />
            </Suspense>
          ) : (
            <div
              className="plans-pane__aside-empty"
              data-testid="plans-pane-aside-empty"
            >
              <ClipboardList size={22} aria-hidden="true" />
              <span>Select a plan to open its dashboard here</span>
            </div>
          )}
        </aside>
      ) : null}

      {confirmEl}

      <PlanPopupModal
        planSlug={popupPlan}
        harnessSlug={popupRow?.harness ?? null}
        planTitle={popupRow?.title ?? popupPlan}
        origin={popupRow ? (popupRow.origin ?? null) : undefined}
        ownerIdentity={popupRow ? (popupRow.ownerIdentity ?? null) : undefined}
        onClose={() => void setPopupPlan(null)}
      />
    </div>
  );
}
