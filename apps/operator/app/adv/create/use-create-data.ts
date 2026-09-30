'use client';

/**
 * Shared data hooks for the /adv "Create" dock panels.
 *
 * The Create tab decomposes into independent dock panels (inbox, plans-list,
 * preview, sessions, plan-editor). Rather than a context provider (dockview
 * may render panels across a React-context boundary), each panel calls these
 * composable hooks directly — the shared `['sync', name, args]` cache
 * (useSyncQuery) dedupes the underlying fetches, so N panels reading the same
 * data pay for ONE request and stay coherent + live-invalidated together.
 *
 * The logic here is lifted from the PlansClient monolith (scope resolution,
 * plan-list maps, inbox item tagging/dedup/counts) so the panels render
 * identically — PlansClient stays the live implementation until the dock is
 * verified + the route is swapped.
 */

import { useEffect, useMemo, useState } from 'react';
import { parseAsArrayOf, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import type { BoundLexicon } from '@papercusp/lexicon';
import {
  usePlanList,
  mergePlanListResults,
  usePlanItems,
  usePlanAttention,
  flattenAttentionItems,
  bucketOf,
  type PlanListRow,
  type PlanBucket,
  PLAN_BUCKETS,
  type PlanItemRow,
  type AttentionItem,
  type AttentionGroup,
  type AttentionTier,
} from '@/app/admin/plans/plans-api';
import {
  resolveHarnessScope,
  type HarnessNodeForScope,
  HARNESS_SCOPE_MODES,
  type HarnessScopeMode,
} from '@papercusp/operator-core/lib/harness/scope';

/* ── Item-status filter facets (mirror PlansClient) ──────────────────── */

export type ItemStatusFilter =
  | 'needs-human'
  | 'todo'
  | 'blocked'
  | 'coord-escalation'
  | 'coord-message'
  | 'smoke-fail'
  | 'operator-report'
  | 'improvement'
  | 'standing-approval'
  | 'conversation'
  | 'scout-grade';

export const ITEM_STATUS_IDS = [
  'needs-human',
  'todo',
  'blocked',
  'coord-escalation',
  'coord-message',
  'smoke-fail',
  'operator-report',
  'improvement',
  'standing-approval',
  'conversation',
  'scout-grade',
] as const;

// The non-plan-item facets — each maps 1:1 to an AttentionItem kind from the
// plans:attention reader. Mirrors PlansClient (B-14 / P-100 folded the
// disposition channels onto the Queue; D-027 follow-on (2) extends this shell's
// previously-narrower set to match so the new kinds are filterable + counted).
const OTHER_KIND_IDS = [
  'coord-escalation',
  'coord-message',
  'smoke-fail',
  'operator-report',
  'improvement',
  'standing-approval',
  'conversation',
  'scout-grade',
] as const;
type OtherKind = (typeof OTHER_KIND_IDS)[number];

export const ITEM_FILTERS: Array<{ id: ItemStatusFilter; label: string; hint: string }> = [
  { id: 'needs-human', label: 'Needs Human', hint: 'Items waiting on a human decision.' },
  { id: 'todo', label: 'ToDos', hint: 'Agent-actionable work — effective todo, all blockers cleared. Sorted by importance.' },
  { id: 'blocked', label: 'Blocked', hint: 'Items stuck on unresolved blockers or external waits.' },
  { id: 'coord-escalation', label: 'Escalations', hint: 'Agent escalations from the coord log — a decision is blocking progress.' },
  { id: 'coord-message', label: 'Messages', hint: 'Coord messages addressed to you.' },
  // {pot} is resolved to the active lexicon label ("Hive") at the QueuePanel
  // render site — module-level consts can't call the useLexicon hook.
  { id: 'smoke-fail', label: 'Smoke', hint: 'Failing smoke tests — the {pot} app is broken.' },
  { id: 'operator-report', label: 'Reports', hint: 'Structured operator reports — fleet/plan status routed to the inbox (chat stays conversation only).' },
  { id: 'improvement', label: 'Improvements', hint: 'Self-improvements the auto-implement loop routed to you for triage.' },
  { id: 'standing-approval', label: 'Approvals', hint: 'Standing-approval candidates — grant the operator auto-dispatch, or dismiss.' },
  { id: 'conversation', label: 'Questions', hint: 'Open agent questions / coord:ask conversations awaiting an answer.' },
  // {scout} resolves to the active cast word at the render site ("Blender" in
  // classic/Pot) — module-level consts can't call the useLexicon hook. Same
  // {token} convention as {pot} above; resolve BOTH via resolveLex().
  { id: 'scout-grade', label: '{scout}', hint: 'Routed {scout} ideas awaiting your optional grade.' },
];

export const ITEM_FILTER_LABEL: Record<ItemStatusFilter, string> = {
  'needs-human': 'Needs Human',
  todo: 'ToDos',
  blocked: 'Blocked',
  'coord-escalation': 'Escalations',
  'coord-message': 'Messages',
  'smoke-fail': 'Smoke',
  'operator-report': 'Reports',
  improvement: 'Improvements',
  'standing-approval': 'Approvals',
  conversation: 'Questions',
  'scout-grade': '{scout}',
};

/**
 * Resolve lexicon {tokens} in a filter label/hint at the render site (module
 * consts can't call the useLexicon hook). Extends the existing {pot} convention
 * to the cup cast (restore-pot-lexicon D-006). Every consumer of these labels
 * MUST route the string through here so no literal "{scout}" leaks to the UI.
 */
export function resolveLex(s: string, t: BoundLexicon): string {
  return s
    .replace(/\{pot\}/g, t('pot'))
    .replace(/\{scout\}/g, t('scout'));
}

/** localStorage key AdvShell uses for the fallback active-harness slug. */
const ACTIVE_HARNESS_KEY = 'harness.activeProject';

/* ── Scope resolution (?slug / ?scope / ?h → harness_slugs) ──────────── */

export interface CreateScope {
  harnessFilter: string | null;
  advActiveSlug: string | null;
  scopeMode: HarnessScopeMode;
  /** The slug set to fetch across, or undefined for ctx-harness-only. */
  harnessSlugsForFetch: readonly string[] | undefined;
}

/**
 * Sync reads are a runtime boundary: a stale process can briefly serve rows
 * produced by an older resolver shape. Keep a malformed registry row from
 * escaping into `resolveHarnessScope`, where property access during render
 * would take down the entire /adv shell.
 */
function isHarnessNodeForScope(value: unknown): value is HarnessNodeForScope {
  if (!value || typeof value !== 'object') return false;
  const row = value as { slug?: unknown; parent_slug?: unknown };
  if (typeof row.slug !== 'string' || row.slug.trim().length === 0) return false;
  return row.parent_slug == null || typeof row.parent_slug === 'string';
}

/** The plan-items reader has the same rolling-version boundary as the registry. */
function isPlanItemRow(value: unknown): value is PlanItemRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as { plan?: unknown; item?: { id?: unknown } | null };
  return (
    typeof row.plan === 'string'
    && row.plan.trim().length > 0
    && !!row.item
    && typeof row.item === 'object'
    && typeof row.item.id === 'string'
    && row.item.id.trim().length > 0
  );
}

/**
 * Lifted from PlansClient: resolve the harness scope the list/inbox/sessions
 * panels fetch across. `?h` user filter → `?slug` active harness → `?scope`
 * expand/self/all toggle, unioned with sub-harnesses via the registry.
 */
export function useCreateScope(): CreateScope {
  const [harnessFilter] = useQueryState('h', parseAsString);
  const [advActiveSlug] = useQueryState('slug', parseAsString);
  const [scopeMode] = useQueryState(
    'scope',
    parseAsStringEnum<HarnessScopeMode>([...HARNESS_SCOPE_MODES]).withDefault('expanded'),
  );
  // LIVE harness registry (harnessProjects.lite). Replaces the old one-shot
  // /api/harness/projects/lite fetch (data-sync-push-completion P-010): the
  // resolver is invalidated from the registry write seam, so creates / deletes
  // / renames / forks from ANY operator process live-update the scope union
  // (EI-206). The resolver row is the same ProjectsLiteEntry shape the REST
  // endpoint put under `d.projects`; HarnessNodeForScope is its structural
  // subset (slug + parent_slug), so the cast needs no field renaming.
  const registryQuery = useSyncQuery<HarnessNodeForScope>({
    queryName: 'harnessProjects.lite',
    args: { includeHiveHomes: true },
    staleTime: 60_000,
  });
  const registryProjects = useMemo<HarnessNodeForScope[]>(() => {
    const rows: unknown = registryQuery.data;
    return Array.isArray(rows) ? rows.filter(isHarnessNodeForScope) : [];
  }, [registryQuery.data]);

  const harnessSlugsForFetch = useMemo<readonly string[] | undefined>(() => {
    if (harnessFilter) return [harnessFilter];
    // "All harnesses" is the unscoped workspace-wide list, not an explicit
    // fan-out over the registry. `callPlansRead('list', …)` maps an omitted
    // harness_slugs field to workspaceWide:true; the explicit field is a
    // bounded (max 64) targeted-scope primitive.
    if (scopeMode === 'all') {
      return undefined;
    }
    if (!advActiveSlug) return undefined;
    if (scopeMode === 'self') return [advActiveSlug];
    if (registryProjects.length === 0) return [advActiveSlug];
    return resolveHarnessScope(advActiveSlug, registryProjects);
  }, [harnessFilter, advActiveSlug, scopeMode, registryProjects]);

  return { harnessFilter, advActiveSlug, scopeMode, harnessSlugsForFetch };
}

/** localStorage fallback for the active harness (the New-plan target). */
export function useResolvedHarnessSlug(): string | null {
  const [activeHarnessSlug] = useQueryState('slug', parseAsString);
  const [fallback, setFallback] = useState<string | null>(null);
  useEffect(() => {
    if (activeHarnessSlug) return;
    if (typeof window === 'undefined') return;
    try {
      // wsLocalKey-free read: AdvShell writes the bare key; the operator is
      // single-workspace at this layer. Match PlansClient's wsLocalKey usage
      // loosely — a miss only affects the New-plan default harness hint.
      setFallback(window.localStorage.getItem(ACTIVE_HARNESS_KEY));
    } catch {
      /* ignore */
    }
  }, [activeHarnessSlug]);
  return activeHarnessSlug ?? fallback;
}

/* ── Plan list + derived maps ────────────────────────────────────────── */

export interface PlanListMaps {
  planList: ReturnType<typeof usePlanList>;
  visiblePlans: PlanListRow[];
  harnessOptions: string[];
  harnessByPlan: Map<string, string>;
  planBucketBySlug: Map<string, PlanBucket>;
  planMetaBySlug: Map<string, { title: string | null; bucket: PlanBucket }>;
  planTitleBySlug: Map<string, string>;
}

/** Lifted from PlansClient: the scoped plan list + the derived lookup maps
 *  the panels need (harness-by-plan, bucket-by-slug, title maps). */
export function usePlanListMaps(scope: CreateScope): PlanListMaps {
  const [pBuckets] = useQueryState(
    'pBuckets',
    parseAsArrayOf(
      parseAsStringEnum<PlanBucket>(PLAN_BUCKETS.map((bucket) => bucket.id)),
    ).withDefault([]),
  );
  const basePlanList = usePlanList({
    includeArchived: true,
    includeLegacy: true,
    includeFinished: false,
    ...(scope.harnessSlugsForFetch ? { harness_slugs: scope.harnessSlugsForFetch } : {}),
  });
  const wantsShippedPlans = pBuckets.includes('shipped');
  const wantsSupersededPlans = pBuckets.includes('rejected');
  const shippedPlanList = usePlanList({
    status: 'shipped',
    includeArchived: true,
    includeLegacy: true,
    includeFinished: true,
    enabled: wantsShippedPlans,
    ...(scope.harnessSlugsForFetch ? { harness_slugs: scope.harnessSlugsForFetch } : {}),
  });
  const supersededPlanList = usePlanList({
    status: 'superseded',
    includeArchived: true,
    includeLegacy: true,
    includeFinished: true,
    enabled: wantsSupersededPlans,
    ...(scope.harnessSlugsForFetch ? { harness_slugs: scope.harnessSlugsForFetch } : {}),
  });
  const planList = useMemo(
    () => mergePlanListResults([
      basePlanList,
      ...(wantsShippedPlans ? [shippedPlanList] : []),
      ...(wantsSupersededPlans ? [supersededPlanList] : []),
    ]),
    [basePlanList, shippedPlanList, supersededPlanList, wantsShippedPlans, wantsSupersededPlans],
  );
  const plans = useMemo(() => planList.data?.plans ?? [], [planList.data]);

  const harnessOptions = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const p of plans) if (p.harness) set.add(p.harness);
    return [...set].sort();
  }, [plans]);

  const visiblePlans = useMemo<PlanListRow[]>(() => {
    if (!scope.harnessFilter) return plans;
    return plans.filter((p) => p.harness === scope.harnessFilter);
  }, [plans, scope.harnessFilter]);

  const harnessByPlan = useMemo(() => new Map(plans.map((p) => [p.slug, p.harness])), [plans]);

  const planBucketBySlug = useMemo(() => {
    const m = new Map<string, PlanBucket>();
    for (const p of plans) m.set(p.slug, bucketOf(p));
    return m;
  }, [plans]);

  const planMetaBySlug = useMemo(() => {
    const m = new Map<string, { title: string | null; bucket: PlanBucket }>();
    for (const p of plans) m.set(p.slug, { title: p.title ?? null, bucket: bucketOf(p) });
    return m;
  }, [plans]);

  const planTitleBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const [slug, meta] of planMetaBySlug) if (meta.title) m.set(slug, meta.title);
    return m;
  }, [planMetaBySlug]);

  return {
    planList,
    visiblePlans,
    harnessOptions,
    harnessByPlan,
    planBucketBySlug,
    planMetaBySlug,
    planTitleBySlug,
  };
}

/* ── Inbox items (the 3 status queries unioned + the attention feed) ──── */

export interface QueueData {
  loading: boolean;
  error: string | null;
  refresh: () => void;
  filteredItems: PlanItemRow[];
  otherItems: AttentionItem[];
  otherGroups: AttentionGroup[];
  attentionRaw: ReturnType<typeof usePlanAttention>;
  itemStatusCounts: Record<ItemStatusFilter, number>;
  /** Per-tier counts (decision/handled/alert/activity) — `decision` is the
   *  QueueSummary "waiting on you" headline (B1). Mirrors PlansClient.tierCounts. */
  tierCounts: Record<AttentionTier, number>;
  queueTotal: number;
  showOther: boolean;
  showPlanItems: boolean;
  otherFacets: OtherKind[];
}

/** Plan-item status category → inbox tier (mirrors PlansClient.tierOfPlanCategory):
 *  needs-human → decision, blocked → alert, an actionable todo → activity. */
function tierOfPlanCategory(c: 'needs-human' | 'todo' | 'blocked'): AttentionTier {
  return c === 'needs-human' ? 'decision' : c === 'blocked' ? 'alert' : 'activity';
}

/** Lifted from PlansClient: the additive item-status × plan-bucket filter
 *  over the three item-status queries + the attention ("Other") feed. */
export function useQueueData(opts: {
  istatus: ItemStatusFilter[];
  pBuckets: PlanBucket[];
  planBucketBySlug: Map<string, PlanBucket>;
  scope: CreateScope;
}): QueueData {
  const { istatus, pBuckets, planBucketBySlug, scope } = opts;

  const itemsNeedsHuman = usePlanItems({ needsHuman: true });
  const itemsActionable = usePlanItems({ actionable: true });
  const itemsBlocked = usePlanItems({ status: 'blocked' });
  const itemsLoading = itemsNeedsHuman.loading || itemsActionable.loading || itemsBlocked.loading;
  const itemsError = itemsNeedsHuman.error ?? itemsActionable.error ?? itemsBlocked.error;

  const attention = usePlanAttention(
    scope.scopeMode === 'all'
      ? undefined
      : { harnessSlug: scope.harnessFilter ?? scope.advActiveSlug ?? undefined },
  );

  const refresh = () => {
    itemsNeedsHuman.refresh();
    itemsActionable.refresh();
    itemsBlocked.refresh();
    attention.refresh();
  };

  const taggedItems = useMemo(() => {
    const out: Array<{ row: PlanItemRow; category: ItemStatusFilter }> = [];
    const append = (rows: unknown, category: ItemStatusFilter) => {
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (isPlanItemRow(row)) out.push({ row, category });
      }
    };
    append(itemsNeedsHuman.data?.items, 'needs-human');
    append(itemsActionable.data?.items, 'todo');
    append(itemsBlocked.data?.items, 'blocked');
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
    () => flattenAttentionItems(attention.data?.groups ?? []).filter((i) => i.kind !== 'plan-item'),
    [attention.data],
  );

  const otherFacets = useMemo(
    () => istatus.filter((s): s is OtherKind => (OTHER_KIND_IDS as readonly string[]).includes(s)),
    [istatus],
  );
  const planItemFacetCount = istatus.length - otherFacets.length;
  const showOther = istatus.length === 0 || otherFacets.length > 0;
  const showPlanItems = istatus.length === 0 || planItemFacetCount > 0;

  const istatusKey = istatus.join('|');
  const pBucketsKey = pBuckets.join('|');

  const filteredItems = useMemo(
    () =>
      taggedItems
        .filter((e) => istatus.length === 0 || istatus.includes(e.category))
        .filter(
          (e) => pBuckets.length === 0 || pBuckets.includes(planBucketBySlug.get(e.row.plan) ?? 'draft'),
        )
        .map((e) => e.row),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taggedItems, istatusKey, pBucketsKey, planBucketBySlug],
  );

  const itemStatusCounts = useMemo(() => {
    const acc: Record<ItemStatusFilter, number> = {
      'needs-human': 0,
      todo: 0,
      blocked: 0,
      'coord-escalation': 0,
      'coord-message': 0,
      'smoke-fail': 0,
      'operator-report': 0,
      improvement: 0,
      'standing-approval': 0,
      conversation: 0,
      'scout-grade': 0,
    };
    for (const e of taggedItems) {
      if (pBuckets.length && !pBuckets.includes(planBucketBySlug.get(e.row.plan) ?? 'draft')) continue;
      acc[e.category] += 1;
    }
    for (const it of otherItems) {
      if (it.kind in acc) acc[it.kind as ItemStatusFilter] += 1;
    }
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taggedItems, pBucketsKey, planBucketBySlug, otherItems]);

  const queueTotal = useMemo(
    () => Object.values(itemStatusCounts).reduce((a, b) => a + b, 0),
    [itemStatusCounts],
  );

  // Per-tier counts (B1 QueueSummary): plan-items by category→tier (respecting
  // the plan-bucket facet, like itemStatusCounts) + other items by their tier.
  const tierCounts = useMemo(() => {
    const acc: Record<AttentionTier, number> = { decision: 0, handled: 0, alert: 0, activity: 0 };
    for (const e of taggedItems) {
      if (pBuckets.length && !pBuckets.includes(planBucketBySlug.get(e.row.plan) ?? 'draft')) continue;
      acc[tierOfPlanCategory(e.category as 'needs-human' | 'todo' | 'blocked')] += 1;
    }
    for (const it of otherItems) acc[it.tier] += 1;
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taggedItems, pBucketsKey, planBucketBySlug, otherItems]);

  return {
    loading: itemsLoading,
    error: itemsError,
    refresh,
    filteredItems,
    otherItems,
    otherGroups: attention.data?.groups ?? [],
    attentionRaw: attention,
    itemStatusCounts,
    tierCounts,
    queueTotal,
    showOther,
    showPlanItems,
    otherFacets,
  };
}

/* ── Shared nuqs hooks for the additive filters ──────────────────────── */

// Derived from PLAN_BUCKETS rather than re-listed — see the same note in
// PlanRail.tsx. P-004 added `awaiting`.
const BUCKET_IDS: PlanBucket[] = PLAN_BUCKETS.map((b) => b.id);

export function useItemStatusFilter() {
  return useQueryState(
    'istatus',
    parseAsArrayOf(parseAsStringEnum<ItemStatusFilter>([...ITEM_STATUS_IDS])).withDefault([]),
  );
}

export function usePlanBucketFilter() {
  return useQueryState(
    'pBuckets',
    parseAsArrayOf(parseAsStringEnum<PlanBucket>([...BUCKET_IDS])).withDefault([]),
  );
}

export function useItemPlanFilter() {
  return useQueryState('itemPlans', parseAsArrayOf(parseAsString).withDefault([]));
}

/* ── Active view (the create:filter buttons set it; create:main renders it) ── */

// 'observations' was removed from the Create dock (owner ask 2026-07-11) — the
// Observations feed now lives in the /adv Learning loop (?lview=observations),
// which reuses ObservationsPanel directly. Keep ObservationsPanel.tsx.
export type CreateView = 'plans' | 'queue' | 'sessions';
export const CREATE_VIEWS: CreateView[] = ['plans', 'queue', 'sessions'];

/** Shared `?view` selector for the Create dock (Plans = single pane;
 *  Queue/Sessions = split). Defaults to Plans, matching the old Plans tab. */
export function useCreateView() {
  return useQueryState('view', parseAsStringEnum<CreateView>(CREATE_VIEWS).withDefault('plans'));
}
