"use client";

import { Tooltip } from "@/app/harness/Tooltip";
/**
 * Plans admin tab — nuqs-driven shell, additive-filter model (D-007).
 *
 * The main pane is always a cross-plan ITEM list (PlanItemsList), unless a
 * plan is open (`?plan=` → PlanDetail) or a search is active (`?q=` →
 * PlanSearchResults to find/open a plan). Two multi-select filter facets
 * combine to narrow the item list:
 *   - item-status (`?istatus=`): Needs Human / ToDos / Blocked,
 *     OR within the facet. Empty = all three.
 *   - plan-status (`?pBuckets=`): Draft … Superseded, OR within. Empty =
 *     all plans. Scopes which plans' items show.
 * The facets AND across each other. Output is always items (grouped by
 * plan) — a plan with no matching items doesn't appear (use search to
 * reach an item-less plan).
 *
 * Navigation guard (Bug-1): PlanDetail reports unsaved-edit state via
 * `onDirtyChange`; every path that abandons the open plan runs through
 * `leaveGuard()` first.
 */

import {
  useQueryState,
  parseAsArrayOf,
  parseAsBoolean,
  parseAsInteger,
  parseAsString,
  parseAsStringEnum,
} from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import { wsLocalKey } from "@papercusp/operator-core/lib/browser-workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import PlanRail, { type PlanRailHandle } from "./PlanRail";
import PlanDetail from "./PlanDetail";
import PlanItemsList from "./PlanItemsList";
import PlanOtherList, { OtherDetail } from "./PlanOtherList";
import PlanItemPreview from "./PlanItemPreview";
import NewPlanButton from "./NewPlanButton";
import { FLAGS } from "@papercusp/flags";
import { useFlag } from "@/lib/flag-hooks";
import { useLexicon } from "@/lib/useLexicon";
import { resolveLex } from "@/app/adv/create/use-create-data";
import DecisionLog, {
  DecisionDetail,
  type DecisionRow,
} from "@/app/_components/DecisionLog";
import QueueSummary from "./QueueSummary";
import { queueTabs, queenLogLayers } from "./queue-authorizer";
import {
  ClipboardList,
  Inbox,
  Terminal,
  SlidersHorizontal,
  ChevronDown,
} from "lucide-react";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  SessionsRosterList,
  SessionsRosterDetail,
  type RosterFilters,
} from "@/app/adv/sessions/SessionsRosterView";
import { SessionsRosterProvider } from "@/app/adv/sessions/SessionsRosterContext";
import { useWorkspaceId } from "@/lib/use-workspace-id";
import TwoPaneShell from "@/app/_components/layout/TwoPaneShell";
import PlanFilters from "./PlanFilters";
import PlanBucketTabs from "./PlanBucketTabs";
import PlanSearchResults from "./PlanSearchResults";
import { Select } from "@/app/harness/Select";
import { useConfirmDialog } from "@/app/harness/useConfirmDialog";
import {
  usePlanList,
  mergePlanListResults,
  usePlanItems,
  usePlanAttention,
  usePlanSearch,
  flattenAttentionItems,
  bucketOf,
  PLAN_BUCKETS,
  ATTENTION_TIERS,
  TIER_LABEL,
  type PlanListRow,
  type PlanStatus,
  type PlanBucket,
  type PlanItemRow,
  type AttentionTier,
  type AttentionKind,
} from "./plans-api";
import { launchAgent } from "@papercusp/operator-core/lib/launch-agent";
import {
  resolveHarnessScope,
  type HarnessNodeForScope,
  HARNESS_SCOPE_MODES,
  type HarnessScopeMode,
} from "@papercusp/operator-core/lib/harness/scope";

/** localStorage key AdvShell uses for the fallback active-harness slug. */
const ACTIVE_HARNESS_KEY = "harness.activeProject";

type PaneMode = "read" | "edit";
type PlanDetailTab = "editor" | "revisions" | "agents";

// Additive filter model: item-status facet (OR within) AND plan-status
// bucket facet (OR within). Each item maps to one item-status category.
type ItemStatusFilter =
  | "needs-human"
  | "todo"
  | "blocked"
  | "coord-escalation"
  | "coord-message"
  | "smoke-fail"
  | "operator-report"
  | "improvement"
  | "standing-approval"
  | "conversation"
  | "scout-grade";
const ITEM_STATUS_IDS = [
  "needs-human",
  "todo",
  "blocked",
  "coord-escalation",
  "coord-message",
  "smoke-fail",
  "operator-report",
  "improvement",
  "standing-approval",
  "conversation",
  "scout-grade",
] as const;
// The non-plan-item facets — each maps 1:1 to an AttentionItem kind from
// the plans:attention reader (the "Other" surfaces, now split out).
const OTHER_KIND_IDS = [
  "coord-escalation",
  "coord-message",
  "smoke-fail",
  "operator-report",
  "improvement",
  "standing-approval",
  "conversation",
  "scout-grade",
] as const;

/** Inbox tier filter (inbox-tiering-and-message-agent D-006). 'all' = every tier. */
type QueueTierFilter = AttentionTier | "all";
const QUEUE_TIER_FILTERS = ["all", ...ATTENTION_TIERS] as const;
// B1 (P-006) tab + layer constants moved to ./queue-authorizer (shared with the
// Create dock's QueuePanel so the two Queue surfaces can't diverge).

/** Map a plan-item status category to its inbox tier (D-006): needs-human → a
 *  Decision, blocked → an Alert, an actionable todo → Activity. Plan items don't
 *  carry the operator-only 'handled' tier on the plans:items path. */
function tierOfPlanCategory(
  c: "needs-human" | "todo" | "blocked",
): AttentionTier {
  return c === "needs-human"
    ? "decision"
    : c === "blocked"
      ? "alert"
      : "activity";
}

const ITEM_FILTER_LABEL: Record<ItemStatusFilter, string> = {
  "needs-human": "Needs Human",
  todo: "ToDos",
  blocked: "Blocked",
  "coord-escalation": "Escalations",
  "coord-message": "Messages",
  "smoke-fail": "Smoke",
  "operator-report": "Reports",
  improvement: "Improvements",
  "standing-approval": "Approvals",
  conversation: "Questions",
  // {scout} → active cast word at render ("Blender" in classic/Pot) via resolveLex.
  "scout-grade": "{scout}",
};

const BUCKET_IDS: PlanBucket[] = PLAN_BUCKETS.map((b) => b.id);

export default function PlansClient() {
  const t = useLexicon();
  // The roster (queen/scout/overwatch + all live agents) must be scoped to the
  // workspace THIS window is in — `/api/adv/roster?workspace=<id>`. Without it
  // the fetch is unscoped ("every workspace") and switching workspaces never
  // changes the roster. Read the window's active workspace and thread it in.
  const workspaceId = useWorkspaceId();
  // The OPEN-PLAN slug. Lives on `?plan=`, NOT `?slug=` — AdvShell owns
  // `?slug=` for the active harness (a global query param shared across
  // every /adv tab).
  const [slug, setSlug] = useQueryState("plan", parseAsString);
  const [q, setQ] = useQueryState("q", parseAsString.withDefault(""));
  const [, setPane] = useQueryState(
    "pane",
    parseAsStringEnum<PaneMode>(["read", "edit"]).withDefault("read"),
  );
  // `ptab` (plan-detail tab), NOT `tab` — AdvShell owns `?tab=` on /adv.
  const [, setTab] = useQueryState(
    "ptab",
    parseAsStringEnum<PlanDetailTab>([
      "editor",
      "revisions",
      "agents",
    ]).withDefault("editor"),
  );
  const [, setJump] = useQueryState("jump", parseAsString);
  // Per-plan filter for the item list. The Plans view uses the same rail as
  // the Queue and Sessions views, but a plan click there opens the full plan
  // detail; only the latter two views use this multi-select OR filter.
  const [itemPlans, setItemPlans] = useQueryState(
    "itemPlans",
    parseAsArrayOf(parseAsString).withDefault([]),
  );

  // Sessions view (P-007): the agent whose dossier is open in the right pane.
  const [selectedAgent, setSelectedAgent] = useQueryState(
    "agent",
    parseAsString,
  );
  // Sessions roster facet filters (P-010) — each its own URL param.
  const [sClient, setSClient] = useQueryState("sClient", parseAsString);
  const [sLive, setSLive] = useQueryState("sLive", parseAsString);
  const [sRole, setSRole] = useQueryState("sRole", parseAsString);
  const [sFile, setSFile] = useQueryState(
    "sFile",
    parseAsString.withDefault(""),
  );
  // Stale agents (>10m idle) are hidden by default — show on demand (P perf fix).
  const [sStale, setSStale] = useQueryState(
    "sStale",
    parseAsBoolean.withDefault(false),
  );

  // Additive filter facets.
  const [istatus, setIstatus] = useQueryState(
    "istatus",
    parseAsArrayOf(
      parseAsStringEnum<ItemStatusFilter>([...ITEM_STATUS_IDS]),
    ).withDefault([]),
  );
  const [pBuckets] = useQueryState(
    "pBuckets",
    parseAsArrayOf(parseAsStringEnum<PlanBucket>([...BUCKET_IDS])).withDefault(
      [],
    ),
  );
  // Main-pane view: the plan browser (default — this is the Plans tab) vs the
  // item inbox. The Plans / Inbox header buttons flip it.
  const [view, setView] = useQueryState(
    "view",
    parseAsStringEnum<"plans" | "queue" | "sessions">([
      "plans",
      "queue",
      "sessions",
    ]).withDefault("plans"),
  );
  // queue-authorization-redesign (P-004): the A1 authorizer-split Queue view
  // (group pending items by who must sign off). Default-ON; OFF = legacy tier grouping.
  const queueAuthzView = useFlag(FLAGS.QUEUE_AUTHORIZATION_VIEW);
  // B1 (P-006): which queue tab is shown + the Queen-log layer (disposition/action).
  const [queueTab, setQueueTab] = useQueryState(
    "queueTab",
    parseAsStringEnum<"pending" | "queen-log">([
      "pending",
      "queen-log",
    ]).withDefault("pending"),
  );
  const [qlLayer, setQlLayer] = useQueryState(
    "qlLayer",
    parseAsStringEnum<"disposition" | "action">([
      "disposition",
      "action",
    ]).withDefault("disposition"),
  );
  // Queen's-log selection is URL-driven (?decision=), looked up from the SAME
  // decision.ledger the log renders — the robust 3-pane path the Pending lists use
  // (?item= / ?other=), NOT a child→parent useState mirror (which didn't reliably
  // update the right pane). Deep-linkable + survives the ledger's refresh.
  const [queueDecisionSel] = useQueryState("decision", parseAsInteger);
  const queenLogRows = useSyncQuery<DecisionRow>({
    queryName: "decision.ledger",
    args: { layer: qlLayer, limit: 50 },
  });
  const selectedDecision = useMemo(
    () =>
      queueDecisionSel != null
        ? ((queenLogRows.data ?? []).find((r) => r.id === queueDecisionSel) ??
          null)
        : null,
    [queueDecisionSel, queenLogRows.data],
  );
  // Inbox tier filter (D-006) — Decisions ▸ Handled ▸ Alerts ▸ Activity (or all).
  // Only the Decisions tier demands the user; this lets them focus on it.
  // The local is queueTier, but the URL key stays 'inboxTier' — it's a cross-app
  // deep-link contract (operator-vite's AdvOverviewTab tiles write ?inboxTier=),
  // not internal naming-debt. Renaming the key would be a functional change.
  const [queueTier, setQueueTier] = useQueryState(
    "inboxTier",
    parseAsStringEnum<QueueTierFilter>([...QUEUE_TIER_FILTERS]).withDefault(
      "all",
    ),
  );
  // Inbox shared-preview selection: a plan-item (`?item=`, "<plan>::<id>") or
  // an Other attention item (`?other=`). The two list sections each set their
  // own param and clear the sibling, so at most one is live; the single shared
  // preview pane (right column) renders whichever it is.
  const [queueItemSel] = useQueryState("item", parseAsString);
  const [queueOtherSel, setQueueOtherSel] = useQueryState(
    "other",
    parseAsString,
  );

  // Queue Filter (redesign): the kind facet (qKinds — narrows the Other kinds in
  // the authorizer buckets; plan-items always show), the opt-in backlog toggles
  // (qTodos/qBlocked — append the pickable/blocked plan-item backlog as its own
  // section; default OFF so the Queue defaults to "what needs attention", not the
  // whole work backlog), and the Filter panel's open state (a panel-open flag → nuqs).
  const [queueKinds, setQueueKinds] = useQueryState(
    "qKinds",
    parseAsArrayOf(
      parseAsStringEnum<AttentionKind>([...OTHER_KIND_IDS]),
    ).withDefault([]),
  );
  const toggleQueueKind = useCallback(
    (k: AttentionKind) =>
      void setQueueKinds(
        queueKinds.includes(k)
          ? queueKinds.filter((x) => x !== k)
          : [...queueKinds, k],
      ),
    [queueKinds, setQueueKinds],
  );
  const [qTodos, setQTodos] = useQueryState(
    "qTodos",
    parseAsBoolean.withDefault(false),
  );
  const [qBlocked, setQBlocked] = useQueryState(
    "qBlocked",
    parseAsBoolean.withDefault(false),
  );
  const [qFilterOpen, setQFilterOpen] = useQueryState(
    "qFilter",
    parseAsBoolean.withDefault(false),
  );

  const railRef = useRef<PlanRailHandle | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // P-024 + P-016 + P-015 + P-029: harness scope. `?h=` user filter →
  // `?slug=` active harness → `?scope=` expanded/self toggle.
  const [harnessFilter, setHarnessFilter] = useQueryState("h", parseAsString);
  const [advActiveSlug] = useQueryState("slug", parseAsString);
  const [scopeMode] = useQueryState(
    "scope",
    parseAsStringEnum<HarnessScopeMode>([...HARNESS_SCOPE_MODES]).withDefault(
      "expanded",
    ),
  );
  // LIVE harness registry (harnessProjects.lite). Replaces the old one-shot
  // /api/harness/projects/lite fetch (data-sync-push-completion P-010): the
  // resolver is invalidated from the registry write seam, so creates / deletes
  // / renames / forks from ANY operator process live-update the scope union +
  // the NewPlanButton target list (EI-206). The resolver row is the same
  // ProjectsLiteEntry shape the REST endpoint put under `d.projects`;
  // HarnessNodeForScope is its structural subset (slug + parent_slug), so the
  // cast needs no field renaming.
  const registryQuery = useSyncQuery<HarnessNodeForScope>({
    queryName: "harnessProjects.lite",
    args: { includeHiveHomes: true },
    staleTime: 60_000,
  });
  const registryProjects = useMemo<HarnessNodeForScope[]>(
    () => (registryQuery.data ?? []) as HarnessNodeForScope[],
    [registryQuery.data],
  );
  const harnessSlugsForFetch = useMemo<readonly string[] | undefined>(() => {
    if (harnessFilter) return [harnessFilter];
    // "All harnesses" deliberately reuses the unscoped plans.list query. The
    // UI read dispatcher turns that into workspaceWide:true, which is both the
    // canonical all-workspace contract and the cache key shared by the other
    // unscoped plan readers. Explicitly fanning out the live registry is wrong:
    // harness_slugs is a bounded (max 64) targeted-scope primitive, so a large
    // workspace makes the background list fail before the handler can run.
    if (scopeMode === "all") {
      return undefined;
    }
    if (!advActiveSlug) return undefined;
    if (scopeMode === "self") return [advActiveSlug];
    if (registryProjects.length === 0) return [advActiveSlug];
    return resolveHarnessScope(advActiveSlug, registryProjects);
  }, [harnessFilter, advActiveSlug, scopeMode, registryProjects]);
  const basePlanList = usePlanList({
    includeArchived: true,
    includeLegacy: true,
    includeFinished: false,
    ...(harnessSlugsForFetch ? { harness_slugs: harnessSlugsForFetch } : {}),
  });
  const wantsShippedPlans = pBuckets.includes("shipped");
  const wantsSupersededPlans = pBuckets.includes("rejected");
  const shippedPlanList = usePlanList({
    status: "shipped",
    includeArchived: true,
    includeLegacy: true,
    includeFinished: true,
    enabled: wantsShippedPlans,
    ...(harnessSlugsForFetch ? { harness_slugs: harnessSlugsForFetch } : {}),
  });
  const supersededPlanList = usePlanList({
    status: "superseded",
    includeArchived: true,
    includeLegacy: true,
    includeFinished: true,
    enabled: wantsSupersededPlans,
    ...(harnessSlugsForFetch ? { harness_slugs: harnessSlugsForFetch } : {}),
  });
  const planList = useMemo(
    () => mergePlanListResults([
      basePlanList,
      ...(wantsShippedPlans ? [shippedPlanList] : []),
      ...(wantsSupersededPlans ? [supersededPlanList] : []),
    ]),
    [basePlanList, shippedPlanList, supersededPlanList, wantsShippedPlans, wantsSupersededPlans],
  );
  const harnessOptions = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const p of planList.data?.plans ?? []) {
      if (p.harness) set.add(p.harness);
    }
    return [...set].sort();
  }, [planList.data]);
  const visiblePlans = useMemo<PlanListRow[]>(() => {
    const all = planList.data?.plans ?? [];
    if (!harnessFilter) return all;
    return all.filter((p) => p.harness === harnessFilter);
  }, [planList.data, harnessFilter]);
  const filteredPlanList = useMemo(
    () => ({
      ...planList,
      data: planList.data ? { ...planList.data, plans: visiblePlans } : null,
    }),
    [planList, visiblePlans],
  );

  const harnessByPlan = useMemo(
    () => new Map((planList.data?.plans ?? []).map((p) => [p.slug, p.harness])),
    [planList.data],
  );
  // plan-slug → lifecycle bucket, for scoping items by plan-status.
  const planBucketBySlug = useMemo(() => {
    const m = new Map<string, PlanBucket>();
    for (const p of planList.data?.plans ?? []) m.set(p.slug, bucketOf(p));
    return m;
  }, [planList.data]);
  // plan-slug → display title + lifecycle bucket, for the item-list group
  // headers (show the human title + a ready/running pill instead of the raw
  // slug).
  const planMetaBySlug = useMemo(() => {
    const m = new Map<string, { title?: string | null; bucket: PlanBucket }>();
    for (const p of planList.data?.plans ?? []) {
      m.set(p.slug, { title: p.title ?? null, bucket: bucketOf(p) });
    }
    return m;
  }, [planList.data]);
  // plan-slug → human title, for the Sessions roster's plan-group headers
  // (head each group with the plan's title instead of its raw slug). Derived
  // from the same fetched plan list; under scope=all this spans every harness.
  const planTitleBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const [slug, meta] of planMetaBySlug) {
      if (meta.title) m.set(slug, meta.title);
    }
    return m;
  }, [planMetaBySlug]);

  // The three item-status categories are fetched separately (the server
  // filters each), then unioned + tagged so the additive filter can pick
  // any subset. All three always load — the main pane is always items.
  const itemsNeedsHuman = usePlanItems({ needsHuman: true });
  const itemsActionable = usePlanItems({ actionable: true });
  const itemsBlocked = usePlanItems({ status: "blocked" });
  const itemsLoading =
    itemsNeedsHuman.loading || itemsActionable.loading || itemsBlocked.loading;
  const itemsError =
    itemsNeedsHuman.error ?? itemsActionable.error ?? itemsBlocked.error;
  // The "Other" facet: non-plan-item attention surfaces (coord escalations,
  // smoke-fails, plan reviews, messages) from the plans:attention reader.
  // Scope it to the active harness — otherwise OTHER harnesses' non-plan items
  // leak into a single-harness inbox. Under "All harnesses" (scope=all) pass
  // nothing so the whole workspace shows.
  const attention = usePlanAttention(
    scopeMode === "all"
      ? undefined
      : { harnessSlug: harnessFilter ?? advActiveSlug ?? undefined },
  );
  const refreshItems = () => {
    itemsNeedsHuman.refresh();
    itemsActionable.refresh();
    itemsBlocked.refresh();
    attention.refresh();
  };

  const taggedItems = useMemo(() => {
    const out: Array<{ row: PlanItemRow; category: ItemStatusFilter }> = [];
    for (const r of itemsNeedsHuman.data?.items ?? [])
      out.push({ row: r, category: "needs-human" });
    for (const r of itemsActionable.data?.items ?? [])
      out.push({ row: r, category: "todo" });
    for (const r of itemsBlocked.data?.items ?? [])
      out.push({ row: r, category: "blocked" });
    const seen = new Set<string>();
    const dedup: typeof out = [];
    for (const e of out) {
      const k = `${e.row.plan}::${e.row.item.id}`;
      if (!seen.has(k)) {
        seen.add(k);
        dedup.push(e);
      }
    }
    return dedup;
  }, [itemsNeedsHuman.data, itemsActionable.data, itemsBlocked.data]);

  // flattenAttentionItems dedupes by id first (WI-5337 / EI-19373923898562595):
  // a non-plan-scoped item appears in multiple groups server-side, so a bare
  // flatMap would render it once per group.
  const otherItems = useMemo(
    () =>
      flattenAttentionItems(attention.data?.groups ?? []).filter(
        (i) => i.kind !== "plan-item",
      ),
    [attention.data],
  );

  // The opt-in pickable-work backlog: actionable todos (qTodos) + blocked items
  // (qBlocked), deduped. Rendered as its own "Backlog" section under the
  // authorizer buckets only when a Filter toggle is on (default off);
  // PlanItemsList applies the per-plan filter internally.
  const backlogItems = useMemo(() => {
    const out: PlanItemRow[] = [];
    if (qTodos) out.push(...(itemsActionable.data?.items ?? []));
    if (qBlocked) out.push(...(itemsBlocked.data?.items ?? []));
    const seen = new Set<string>();
    return out.filter((r) => {
      const k = `${r.plan}::${r.item.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [qTodos, qBlocked, itemsActionable.data, itemsBlocked.data]);

  const istatusKey = istatus.join("|");
  const pBucketsKey = pBuckets.join("|");
  // The additive result: items whose category is in the item-status facet
  // (or all if empty) AND whose plan is in the bucket facet (or all).
  const filteredItems = useMemo(
    () =>
      taggedItems
        .filter((e) => istatus.length === 0 || istatus.includes(e.category))
        .filter(
          (e) =>
            pBuckets.length === 0 ||
            pBuckets.includes(planBucketBySlug.get(e.row.plan) ?? "draft"),
        )
        // Inbox tier filter (D-006): plan-item tier derives from its category.
        .filter(
          (e) =>
            queueTier === "all" ||
            tierOfPlanCategory(
              e.category as "needs-human" | "todo" | "blocked",
            ) === queueTier,
        )
        .map((e) => e.row),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taggedItems, istatusKey, pBucketsKey, planBucketBySlug, queueTier],
  );

  // Per-status counts for the item-status chips — scoped by the active
  // plan-status buckets (but NOT by the item-status selection, so each
  // chip shows what selecting it would surface). Shrinks as you narrow
  // the plan buckets.
  const itemStatusCounts = useMemo(() => {
    const acc: Record<ItemStatusFilter, number> = {
      "needs-human": 0,
      todo: 0,
      blocked: 0,
      "coord-escalation": 0,
      "coord-message": 0,
      "smoke-fail": 0,
      "operator-report": 0,
      improvement: 0,
      "standing-approval": 0,
      conversation: 0,
      "scout-grade": 0,
    };
    for (const e of taggedItems) {
      if (
        pBuckets.length &&
        !pBuckets.includes(planBucketBySlug.get(e.row.plan) ?? "draft")
      )
        continue;
      acc[e.category] += 1;
    }
    for (const it of otherItems) {
      if (it.kind in acc) acc[it.kind as ItemStatusFilter] += 1;
    }
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taggedItems, pBucketsKey, planBucketBySlug, otherItems]);

  // Total across every facet — the Inbox button's badge.
  const queueTotal = useMemo(
    () => Object.values(itemStatusCounts).reduce((a, b) => a + b, 0),
    [itemStatusCounts],
  );

  // Per-tier counts for the tier bar (D-006): plan-items by category→tier
  // (respecting the plan-bucket facet, like itemStatusCounts) + other items by
  // their (triage-overlaid) tier. The Decisions count is the headline badge.
  const tierCounts = useMemo(() => {
    const acc: Record<AttentionTier, number> = {
      decision: 0,
      handled: 0,
      alert: 0,
      activity: 0,
    };
    for (const e of taggedItems) {
      if (
        pBuckets.length &&
        !pBuckets.includes(planBucketBySlug.get(e.row.plan) ?? "draft")
      )
        continue;
      acc[
        tierOfPlanCategory(e.category as "needs-human" | "todo" | "blocked")
      ] += 1;
    }
    for (const it of otherItems) acc[it.tier] += 1;
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taggedItems, pBucketsKey, planBucketBySlug, otherItems]);

  // The rail is normally an item-navigator: it lists the plans that have
  // matching items (+ a per-plan itemPlan filter for the item list). BUT when
  // a plan-status bucket filter is active (`?pBuckets=`), the rail switches to
  // listing every plan in those buckets — even ones with no open work items —
  // so it matches the bucket-chip counts and the "N plans waiting" nudge lands
  // on ALL started plans, not just those with actionable items. (PlanRail
  // re-applies the same applyPlanFilters + bucket filter, so passing the full
  // set here yields exactly the chip-counted plans.)
  const itemPlanSlugs = useMemo(
    () => new Set(filteredItems.map((r) => r.plan)),
    [filteredItems],
  );
  const railVisiblePlans = useMemo(
    () =>
      pBuckets.length > 0
        ? visiblePlans
        : visiblePlans.filter((p) => itemPlanSlugs.has(p.slug)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visiblePlans, itemPlanSlugs, pBucketsKey],
  );
  const railList = useMemo(
    () => ({
      ...filteredPlanList,
      data: filteredPlanList.data
        ? { ...filteredPlanList.data, plans: railVisiblePlans }
        : null,
    }),
    [filteredPlanList, railVisiblePlans],
  );

  // Heading text for the item list — reflects the active facets.
  const itemTitle = istatus.length
    ? istatus.map((s) => resolveLex(ITEM_FILTER_LABEL[s], t)).join(" · ")
    : "All items";

  // Search-scope chips in PlanSearchResults (plans with needs-human /
  // todo items). Derived from plan-list item counts.
  const needsHumanPlans = useMemo(
    () =>
      new Set(
        (planList.data?.plans ?? [])
          .filter((p) => (p.itemCounts?.["needs-human"] ?? 0) > 0)
          .map((p) => p.slug),
      ),
    [planList.data],
  );
  const needsDecisionPlans = useMemo(
    () =>
      new Set(
        (planList.data?.plans ?? [])
          .filter((p) => (p.itemCounts?.todo ?? 0) > 0)
          .map((p) => p.slug),
      ),
    [planList.data],
  );

  // Lift cross-plan search up so PlanRail can union its hits into the rail.
  const railSearchHits = usePlanSearch(q);
  const searchHitSlugs = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const h of railSearchHits.data?.hits ?? []) s.add(h.plan);
    return s;
  }, [railSearchHits.data]);

  // Bug-1 guard: PlanDetail keeps this ref current with its unsaved-edit
  // state. `leaveGuard` is consulted before every navigation that abandons
  // the open plan.
  const dirtyRef = useRef(false);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const leaveGuard = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    return askConfirm({
      title: "Discard unsaved edits?",
      body: "Your current plan edits will be discarded.",
      confirmLabel: "Discard",
      destructive: true,
    });
  }, [askConfirm]);

  const navSlug = useCallback(
    async (next: string | null) => {
      if (!(await leaveGuard())) return;
      setPane("read");
      setSlug(next);
    },
    [leaveGuard, setPane, setSlug],
  );

  // Open a plan from the item list / preview (the full PlanDetail), with an
  // optional P-NNN deep-link. Opening the full editor is a Plans-view action:
  // switch the view too, so the full PlanDetail shows (it only renders in the
  // Plans view now) instead of silently shadowing the Queue/Sessions 3-pane.
  const navPlanTarget = useCallback(
    async (next: string, targetId?: string) => {
      if (!(await leaveGuard())) return;
      setPane("read");
      setTab("editor");
      setJump(targetId ?? null);
      void setView("plans");
      setSlug(next);
    },
    [leaveGuard, setJump, setPane, setSlug, setTab, setView],
  );

  // The Plans rail is an opener; Queue and Sessions use the same rail as a
  // multi-select item filter. Keep the callback stable so the memoized rail
  // rows do not all re-render whenever a filter or view changes.
  const viewRef = useRef(view);
  viewRef.current = view;
  const itemPlansRef = useRef(itemPlans);
  itemPlansRef.current = itemPlans;
  const onSelectPlan = useCallback(
    (s: string) => {
      if (viewRef.current === "plans") {
        void navSlug(s);
        return;
      }
      const current = itemPlansRef.current;
      void setItemPlans(
        current.includes(s) ? current.filter((x) => x !== s) : [...current, s],
      );
    },
    [navSlug, setItemPlans],
  );

  // "Queue" — jump to the items view with item-status filters cleared
  // (active plan-status / harness filters stay). Closes any open plan +
  // search + per-plan rail selection so the full cross-plan Queue shows.
  const goQueue = useCallback(async () => {
    if (!(await leaveGuard())) return;
    setPane("read");
    setSlug(null);
    void setQ(null);
    void setIstatus([]);
    void setItemPlans([]);
    void setView("queue");
  }, [leaveGuard, setPane, setSlug, setQ, setIstatus, setItemPlans, setView]);

  // "Plans" — the plan browser view. Closes any open plan + search; plan-status
  // / harness filters stay applied (they scope which plans show).
  const goPlans = useCallback(async () => {
    if (!(await leaveGuard())) return;
    setPane("read");
    setSlug(null);
    void setQ(null);
    void setView("plans");
  }, [leaveGuard, setPane, setSlug, setQ, setView]);

  // "Sessions" — the live agent roster. Closes any open plan + search; the rail
  // plan selection (itemPlans) STAYS, since it filters the roster's plan groups
  // exactly as it filters inbox items (D-003/D-005).
  const goSessions = useCallback(async () => {
    if (!(await leaveGuard())) return;
    setPane("read");
    setSlug(null);
    void setQ(null);
    void setView("sessions");
  }, [leaveGuard, setPane, setSlug, setQ, setView]);

  usePlanShortcuts({ navSlug, setQ, rail: railRef, search: searchRef });

  // P-007: dual-homed (/admin/plans + /adv?tab=plans). Fall back to the
  // localStorage active-harness for the New plan button on standalone /admin.
  const [activeHarnessSlug] = useQueryState("slug", parseAsString);
  const [fallbackHarnessSlug, setFallbackHarnessSlug] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (activeHarnessSlug) return;
    if (typeof window === "undefined") return;
    try {
      setFallbackHarnessSlug(
        window.localStorage.getItem(wsLocalKey(ACTIVE_HARNESS_KEY)),
      );
    } catch {
      /* ignore */
    }
  }, [activeHarnessSlug]);
  const resolvedHarnessSlug = activeHarnessSlug ?? fallbackHarnessSlug;

  const [launchingNewPlan, setLaunchingNewPlan] = useState(false);
  // ownerSlug is the EXPLICIT owning hive (steering-nested-hive-plan-tree P-005) —
  // the active scope when concrete, else the owner's menu choice (null = explicit
  // workspace-level). NewPlanButton makes the choice instead of silently defaulting.
  const onNewPlan = useCallback(
    async (ownerSlug: string | null) => {
      if (launchingNewPlan) return;
      setLaunchingNewPlan(true);
      try {
        const result = await launchAgent({
          slug: ownerSlug ?? null,
          planSlug: null,
          label: ownerSlug ? `new-plan · ${ownerSlug}` : "new-plan",
          kickoff: { kind: "new-plan" },
          // Open as a pane in the zellij dock (owner ask, pui-dock-agent-stack):
          // record a pending workbench launch; the dock's pui dock-driver panes it
          // reactively instead of the server spawning an OS terminal window.
          deferSpawn: true,
        });
        if (result.ok) {
          toast.success(
            "Plan-drafting agent queued — opening as a pane in the dock.",
            { duration: 3000 },
          );
        } else if (result.installCmd) {
          toast.error(
            `${result.error ?? "OMP launch prerequisites are missing."} Run: ${result.installCmd}`,
          );
        } else {
          toast.error(`Launch failed: ${result.error ?? "unknown error"}`);
        }
      } finally {
        setLaunchingNewPlan(false);
      }
    },
    [launchingNewPlan],
  );

  // The inbox's single shared sticky preview — renders the selected plan-item
  // (`?item=`) or Other attention item (`?other=`), or an empty prompt. Both
  // list sections feed this one pane instead of each owning a detail column.
  const renderQueuePreview = () => {
    // Queen's-log tab: the selected decision's full detail shows here (right pane),
    // not as an inline accordion in the list (3-pane consistency, P-004).
    if (queueAuthzView && queueTab === "queen-log") {
      return (
        <aside className="pc-items__detail">
          {selectedDecision ? (
            <DecisionDetail row={selectedDecision} />
          ) : (
            <div className="pc-items__detail-empty">
              Select a decision to see its full detail.
            </div>
          )}
        </aside>
      );
    }
    if (queueItemSel) {
      const idx = queueItemSel.indexOf("::");
      const pSlug = idx === -1 ? null : queueItemSel.slice(0, idx);
      const iId = idx === -1 ? null : queueItemSel.slice(idx + 2);
      return (
        <PlanItemPreview
          key={queueItemSel}
          planSlug={pSlug}
          itemId={iId}
          harnessSlug={pSlug ? (harnessByPlan.get(pSlug) ?? null) : null}
          onResolved={refreshItems}
          onViewFullPlan={navPlanTarget}
        />
      );
    }
    if (queueOtherSel) {
      const sel = otherItems.find((i) => i.id === queueOtherSel) ?? null;
      return (
        <OtherDetail
          key={queueOtherSel}
          item={sel}
          onResolved={() => {
            void setQueueOtherSel(null);
            refreshItems();
          }}
        />
      );
    }
    return (
      <aside className="pc-items__detail">
        <div className="pc-items__detail-empty">
          Select an item to see its detail and actions.
        </div>
      </aside>
    );
  };

  return (
    <div className="pc-plans">
      {confirmEl}
      <aside className="pc-plans__rail">
        <div className="pc-plans__rail-actions">
          <NewPlanButton
            resolvedHarnessSlug={resolvedHarnessSlug}
            projects={registryProjects}
            launching={launchingNewPlan}
            potLabel={t("pot", { lower: true })}
            onLaunch={onNewPlan}
          />
          <Tooltip
            label={`Browse plans — open one to view/edit it. (Plan-status & ${t("pot", { lower: true })} filters stay applied.)`}
          >
            <button
              type="button"
              className={`pc-plans__plans-btn${view === "plans" ? " is-active" : ""}`}
              onClick={() => void goPlans()}
            >
              <ClipboardList size={14} aria-hidden />
              Plans
            </button>
          </Tooltip>
          <Tooltip
            label={`Open the Queue — every decision & action surface across plans the ${t("brain")} did not auto-handle, with item filters cleared (plan filters stay).`}
          >
            <button
              type="button"
              className={`pc-plans__queue-btn${view === "queue" ? " is-active" : ""}`}
              onClick={() => void goQueue()}
            >
              <Inbox size={14} aria-hidden />
              <span className="pc-plans__queue-btn-label">Queue</span>
              {queueTotal > 0 ? (
                <span className="pc-plans__queue-btn-count">{queueTotal}</span>
              ) : null}
            </button>
          </Tooltip>
          <Tooltip label="Live agent roster — who's active across plans, what they're doing, which files. The plan selection filters the plan-grouped section.">
            <button
              type="button"
              className={`pc-plans__sessions-btn${view === "sessions" ? " is-active" : ""}`}
              onClick={() => void goSessions()}
            >
              <Terminal size={14} aria-hidden />
              <span className="pc-plans__queue-btn-label">Sessions</span>
            </button>
          </Tooltip>
        </div>

        {/* ── PLANS group — search + plan-status filters (scope which plans' items show). ── */}
        <div className="pc-plans__group">
          {harnessOptions.length > 1 ? (
            <div className="pc-plans__harness-filter">
              <label
                className="pc-plans__harness-filter-label"
                htmlFor="pc-plans-harness-filter"
              >
                {t("pot")}
              </label>
              <Select
                id="pc-plans-harness-filter"
                triggerClassName="pc-plans__harness-filter-select"
                value={harnessFilter ?? ""}
                onChange={(value) =>
                  void setHarnessFilter(value === "_all" ? null : value)
                }
                ariaLabel={`Filter plans by ${t("pot", { lower: true })}`}
                options={[
                  {
                    value: "_all",
                    label: `All (${planList.data?.plans.length ?? 0})`,
                  },
                  ...harnessOptions.map((h) => {
                    const count = (planList.data?.plans ?? []).filter(
                      (p) => p.harness === h,
                    ).length;
                    return { value: h, label: `${h} (${count})` };
                  }),
                ]}
              />
            </div>
          ) : null}

          <PlanFilters
            list={filteredPlanList}
            query={q}
            onQueryChange={setQ}
            searchRef={searchRef}
          />

          {/* Plan-status bucket chips scope the PLANS browser; they're noise in
              the Queue (which slices by authorizer, not plan lifecycle), so the
              Queue hides them — the rail there is just harness filter + search +
              the plan list as a per-plan queue filter. */}
          {view !== "queue" ? (
            <PlanBucketTabs
              plans={visiblePlans}
              query={q}
              searchHitSlugs={searchHitSlugs}
            />
          ) : null}
        </div>

        <div className="pc-plans__list" aria-label="Plans with matching items">
          <PlanRail
            ref={railRef}
            list={railList}
            selectedSlugs={view === "plans" ? (slug ? [slug] : []) : itemPlans}
            query={q}
            searchHitSlugs={searchHitSlugs}
            onSelect={onSelectPlan}
            onStartToggle={() => planList.refresh()}
          />
        </div>
      </aside>

      <main className="pc-plans__main">
        {/* Only the PLANS view opens the full-width plan editor (?plan=) or
            search (?q=); the Queue + Sessions ignore them so a lingering
            ?plan=/?q= can't shadow their 3-pane (queue nav-tangle fix). All
            three views otherwise render through ONE persistent TwoPaneShell, so
            switching view swaps the list/detail content without remounting the
            2-pane frame. The roster poll is enabled only on Sessions. */}
        {view === "plans" && slug ? (
          <PlanDetail
            key={slug}
            slug={slug}
            harnessSlug={harnessByPlan.get(slug) ?? null}
            onClose={() => void navSlug(null)}
            onDirtyChange={(d) => {
              dirtyRef.current = d;
            }}
            startStatus={
              visiblePlans.find((p) => p.slug === slug)?.startStatus ?? null
            }
            onStartStatusChange={() => planList.refresh()}
            onPlanStatusChange={(status?: PlanStatus) => {
              if (status && planList.setData) {
                planList.setData((prev) =>
                  prev
                    ? {
                        ...prev,
                        plans: prev.plans.map((p) =>
                          p.slug === slug ? { ...p, status } : p,
                        ),
                      }
                    : prev,
                );
              } else {
                planList.refresh();
              }
            }}
          />
        ) : view === "plans" && q.trim() ? (
          <PlanSearchResults
            query={q}
            onPick={(s) => void navSlug(s)}
            needsHumanPlans={needsHumanPlans}
            needsDecisionPlans={needsDecisionPlans}
          />
        ) : (
          <SessionsRosterProvider
            workspaceId={workspaceId}
            enabled={view === "sessions"}
          >
            <TwoPaneShell
              className={
                view === "sessions" ? "pc-twopane--sessions" : undefined
              }
              list={
                view === "sessions" ? (
                  <SessionsRosterList
                    planFilters={itemPlans}
                    planTitleBySlug={planTitleBySlug}
                    selectedAgent={selectedAgent}
                    onSelectAgent={(id) => void setSelectedAgent(id)}
                    filters={
                      {
                        client: sClient,
                        liveness: sLive,
                        role: sRole,
                        file: sFile,
                      } as RosterFilters
                    }
                    onFilterChange={(next) => {
                      void setSClient(next.client);
                      void setSLive(next.liveness);
                      void setSRole(next.role);
                      void setSFile(next.file);
                    }}
                    showStale={sStale}
                    onToggleStale={() => void setSStale(!sStale)}
                  />
                ) : view === "queue" ? (
                  <div className="pc-queue__list">
                    {/* B1 (P-006): the two-halves summary + the Needs Decision|Queen's-log
                        segmented control — only in the redesigned Queue (flag-gated). */}
                    {queueAuthzView ? (
                      <>
                        <QueueSummary waitingOnYou={tierCounts.decision} />
                        <nav className="pc-queue__tabs" aria-label="Queue tab">
                          {queueTabs(t).map((tb) => (
                            <Tooltip key={tb.id} label={tb.hint}>
                              <button
                                type="button"
                                className={`pc-queue__tab${queueTab === tb.id ? " is-active" : ""}`}
                                aria-pressed={queueTab === tb.id}
                                onClick={() => void setQueueTab(tb.id)}
                              >
                                {tb.label}
                              </button>
                            </Tooltip>
                          ))}
                        </nav>
                      </>
                    ) : null}
                    {queueAuthzView && queueTab === "queen-log" ? (
                      <section
                        className="pc-queue__queenlog"
                        aria-label={`${t("brain")}'s decision log`}
                      >
                        <nav
                          className="pc-queue__tabs pc-queue__layer-toggle"
                          aria-label="Decision log layer"
                        >
                          {queenLogLayers(t).map((l) => (
                            <Tooltip key={l.id} label={l.hint}>
                              <button
                                type="button"
                                className={`pc-queue__tab${qlLayer === l.id ? " is-active" : ""}`}
                                aria-pressed={qlLayer === l.id}
                                onClick={() => void setQlLayer(l.id)}
                              >
                                {l.label}
                              </button>
                            </Tooltip>
                          ))}
                        </nav>
                        <DecisionLog
                          layer={qlLayer}
                          limit={50}
                          title={
                            qlLayer === "disposition"
                              ? `What the ${t("brain")} decided`
                              : "Governed actions (audit)"
                          }
                          description={
                            qlLayer === "disposition"
                              ? `Every item the ${t("brain")} considered and what it chose — act, defer, reject, route, or no-op. Newest first.`
                              : "Every governed action that ran, auto or gated — the full audit trail. Newest first."
                          }
                          emptyText={`No decisions logged yet. As the ${t("brain")} considers items, they appear here.`}
                          externalDetail
                        />
                      </section>
                    ) : (
                      <>
                        {/* ONE slicing model: the authorizer buckets (Needs you /
                        Automatable / Alerts) over ALL attention items — needs-human
                        plan-items AND coord/smoke/etc. The old tier bar + 11-chip row
                        collapse into one Filter; the pickable-todo / blocked backlog
                        is opt-in (default off) as its own section so the default view
                        stays "what needs attention", not the whole work backlog. */}
                        <QueueFilterBar
                          kinds={queueKinds}
                          onToggleKind={toggleQueueKind}
                          counts={itemStatusCounts}
                          showTodos={qTodos}
                          showBlocked={qBlocked}
                          onToggleTodos={() => void setQTodos(!qTodos)}
                          onToggleBlocked={() => void setQBlocked(!qBlocked)}
                          todoCount={itemsActionable.data?.items.length ?? 0}
                          blockedCount={itemsBlocked.data?.items.length ?? 0}
                          tierFilter={queueTier}
                          onClearTier={() => void setQueueTier("all")}
                          open={qFilterOpen}
                          onOpenChange={(o) => void setQFilterOpen(o)}
                        />
                        <div className="pc-items__listpane">
                          <PlanOtherList
                            groups={attention.data?.groups ?? []}
                            loading={attention.loading}
                            error={attention.error}
                            refresh={attention.refresh}
                            title="Needs Decision"
                            kinds={queueKinds}
                            planFilters={itemPlans}
                            tierFilter={queueTier}
                            groupByAuthorizer
                            includePlanItems
                            hasMore={attention.hasMore}
                            loadingMore={attention.loadingMore}
                            loadMore={attention.loadMore}
                            totalCount={attention.totalItemCount}
                            loadedCount={attention.loadedItemCount}
                          />
                          {qTodos || qBlocked ? (
                            <PlanItemsList
                              items={backlogItems}
                              loading={itemsLoading}
                              error={itemsError}
                              refresh={refreshItems}
                              harnessByPlan={harnessByPlan}
                              planMeta={planMetaBySlug}
                              planFilters={itemPlans}
                              title="Backlog — pickable work"
                            />
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  /* Plans — the grouped item list (list-only). The selected
                     item's read-only preview shows in the shared detail pane;
                     "Open full plan" sets ?plan= to the editor. */
                  <div className="pc-items__listpane pc-plans__items">
                    <PlanItemsList
                      items={filteredItems}
                      loading={itemsLoading}
                      error={itemsError}
                      refresh={refreshItems}
                      harnessByPlan={harnessByPlan}
                      planMeta={planMetaBySlug}
                      planFilters={itemPlans}
                      title={itemTitle}
                    />
                  </div>
                )
              }
              detail={
                view === "sessions" ? (
                  <SessionsRosterDetail
                    selectedAgent={selectedAgent}
                    onSelectAgent={(id) => void setSelectedAgent(id)}
                  />
                ) : (
                  renderQueuePreview()
                )
              }
            />
          </SessionsRosterProvider>
        )}
      </main>
    </div>
  );
}

/* ── Queue Filter ─────────────────────────────────────────────────── */

/** The kind facet inside the Queue's collapsed Filter — the non-plan-item
 *  attention kinds. Plan-items always show in the buckets, so they're not here. */
const QUEUE_KIND_CHIPS: readonly AttentionKind[] = [...OTHER_KIND_IDS];

/**
 * QueueFilterBar — the Queue's single, collapsed Filter (queue redesign): one
 * "Filter" trigger (with an active-count badge) replaces the old always-on tier
 * bar + 11-chip row. Expanded, it offers per-kind narrowing of the Other items
 * plus the two opt-in backlog toggles (pickable todos / blocked). When a
 * cross-app deep-link set a tier (?inboxTier from the overview tiles) a
 * clear-chip surfaces it, so the filtered state is never a mystery.
 */
function QueueFilterBar({
  kinds,
  onToggleKind,
  counts,
  showTodos,
  showBlocked,
  onToggleTodos,
  onToggleBlocked,
  todoCount,
  blockedCount,
  tierFilter,
  onClearTier,
  open,
  onOpenChange,
}: {
  kinds: AttentionKind[];
  onToggleKind: (k: AttentionKind) => void;
  counts: Record<string, number>;
  showTodos: boolean;
  showBlocked: boolean;
  onToggleTodos: () => void;
  onToggleBlocked: () => void;
  todoCount: number;
  blockedCount: number;
  tierFilter: QueueTierFilter;
  onClearTier: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useLexicon();
  const activeCount =
    kinds.length +
    (showTodos ? 1 : 0) +
    (showBlocked ? 1 : 0) +
    (tierFilter !== "all" ? 1 : 0);
  return (
    <Collapsible.Root
      className="pc-queue__filterbar"
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="pc-queue__filterhead">
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="pc-queue__filtertoggle"
            aria-expanded={open}
          >
            <SlidersHorizontal size={13} aria-hidden />
            <span>Filter</span>
            {activeCount > 0 ? (
              <span className="pc-queue__filteractive">{activeCount}</span>
            ) : null}
            <ChevronDown
              size={13}
              aria-hidden
              className="pc-queue__filterchev"
            />
          </button>
        </Collapsible.Trigger>
        {tierFilter !== "all" ? (
          <Tooltip label="A linked-in view filtered the Queue to this tier — click to clear.">
            <button
              type="button"
              className="pc-queue__tierchip"
              onClick={onClearTier}
            >
              {TIER_LABEL[tierFilter]} ✕
            </button>
          </Tooltip>
        ) : null}
      </div>
      <Collapsible.Content className="pc-queue__filterpanel">
        <div className="pc-queue__filtergroup">
          <span className="pc-queue__filterlabel">Kinds</span>
          {QUEUE_KIND_CHIPS.map((k) => {
            const active = kinds.includes(k);
            return (
              <button
                key={k}
                type="button"
                className={`pc-queue__filter${active ? " is-active" : ""}`}
                aria-pressed={active}
                onClick={() => onToggleKind(k)}
              >
                <span className="pc-queue__filter-label">
                  {resolveLex(ITEM_FILTER_LABEL[k as ItemStatusFilter], t)}
                </span>
                <span className="pc-queue__filter-count">{counts[k] ?? 0}</span>
              </button>
            );
          })}
        </div>
        <div className="pc-queue__filtergroup">
          <span className="pc-queue__filterlabel">Backlog</span>
          <Tooltip label="Show the agent-pickable todo backlog (off by default — the Queue defaults to what needs attention).">
            <button
              type="button"
              className={`pc-queue__filter${showTodos ? " is-active" : ""}`}
              aria-pressed={showTodos}
              onClick={onToggleTodos}
            >
              <span className="pc-queue__filter-label">Pickable todos</span>
              <span className="pc-queue__filter-count">{todoCount}</span>
            </button>
          </Tooltip>
          <Tooltip label="Show blocked plan items.">
            <button
              type="button"
              className={`pc-queue__filter${showBlocked ? " is-active" : ""}`}
              aria-pressed={showBlocked}
              onClick={onToggleBlocked}
            >
              <span className="pc-queue__filter-label">Blocked</span>
              <span className="pc-queue__filter-count">{blockedCount}</span>
            </button>
          </Tooltip>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/* ── Keyboard shortcuts ───────────────────────────────────────────── */

type PlanShortcutSetters = {
  navSlug: (s: string | null) => unknown;
  setQ: (q: string | null) => unknown;
  rail: React.RefObject<PlanRailHandle | null>;
  search: React.RefObject<HTMLInputElement | null>;
};

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT"
  )
    return true;
  if (t.isContentEditable) return true;
  if (t.closest(".vditor-ir, .vditor-wysiwyg, .vditor-sv")) return true;
  return false;
}

/**
 * Document-level shortcuts:
 *   /       focus rail search
 *   J / K   next / previous plan in the rail
 *   Esc     close the open plan (or clear search if focused there)
 */
function usePlanShortcuts({
  navSlug,
  setQ,
  rail,
  search,
}: PlanShortcutSetters) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A linked work/review popup owns its keys. Escape must close that layer
      // without also dropping the underlying plan and expanded requirement.
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof Element &&
        event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;

      if (event.key === "Escape") {
        if (document.activeElement === search.current) {
          search.current?.blur();
          if (search.current?.value) setQ("");
          return;
        }
        if (!isTypingTarget(event.target)) {
          navSlug(null);
        }
        return;
      }

      if (isTypingTarget(event.target)) return;

      if (event.key === "/") {
        event.preventDefault();
        search.current?.focus();
        search.current?.select();
        return;
      }
      if (event.key === "j" || event.key === "J") {
        event.preventDefault();
        rail.current?.next();
        return;
      }
      if (event.key === "k" || event.key === "K") {
        event.preventDefault();
        rail.current?.prev();
        return;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [navSlug, setQ, rail, search]);
}
