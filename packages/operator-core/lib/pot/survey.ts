/**
 * survey — the Mug's plan-aware placement survey
 * (queen-autonomous-execution-2026-06-13 B-08: P-010, P-012, feeding P-031).
 *
 * The Mug prioritizes across two views of one source (autonomy-policy D-013),
 * BOTH ranked by the one placement registry (placement-ranker.ts):
 *
 *   - PLAN view (P-010): every STARTED plan across the Pot's member harnesses,
 *     ranked to answer "which plan do I pour cups into" — the plan-item / Queue
 *     side, pre-`plan_items:convert`.
 *   - FRONTIER view: every unplaced (todo, unassigned) feature-family work-item
 *     across the same harnesses, ranked to answer "which ready item do I place"
 *     — the work-item dispatch side, post-convert.
 *
 * P-012 — the member-harness survey FIX. The 2026-06-11 live wake surveyed only
 * the Pot's HOME slug (`papercup-pot`, the Mug's seat — almost always empty)
 * and slept through a freshly-filed MEMBER work-item. The robust fix is CODE,
 * not a prompt line: resolve the Pot's member harnesses from the registry and
 * survey EVERY one; and if membership isn't wired (only the home resolves), fall
 * back to a WORKSPACE-WIDE survey rather than the home slug alone — so the
 * home-only blind spot is structurally impossible. `survey.test.ts` pins it.
 *
 * The PG reads are thin + injectable (SurveyDeps) so the candidate-building and
 * ranking unit-test with no database; the real cross-member frontier query is
 * pinned by `survey.integration.test.ts`.
 */
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { IMPORTANCE_LEVELS, type Importance } from '@papercusp/plan-parser';
import { activeWorkspaceId } from '../workspace-registry';
import { withPgRetry } from '../pg-transient-retry';
import { frontierPlacementKindClause } from '../datatype-frontier-placement';
import { admittedWhereSql, autoPickableWhereSql } from '../work-items-admission';
import {
  claimHoldExclusionSql,
  needsOwnerActionExclusionSql,
  crossMachineRigExclusionSql,
} from '../work-items';
import { loadHarnessRegistry } from '../harness-registry';
import type { PlanIndexRow } from '../agent-tools/plans/source';
import { listPlanIndexRowsCached } from '../agent-tools/plans/index-cache';
import { reconcileStartStatus, isTerminalPlanStatus } from '../agent-tools/plans/plan-start-state';
import { rankPlacements, type PlacementCandidate } from './placement-ranker';
import type { Ranked } from '../queue-ranker';
import { ALL_SUCCESSFUL_STATUSES, defaultBlockingStore } from '../work-item-blocking';
import type { WorkItemBlockerRequirement } from '../dbos/work-item-deps-store';
import { selectReady, type ReadinessNode } from '../dbos/frontier-readiness';
import { activeExternalBlockers } from '../external-blockers';
import { placementConfig } from './placement-watchdog';
import { mapWithConcurrency } from '../gym/concurrency';

const MS_PER_DAY = 86_400_000;

/**
 * Keep the per-harness plan slice below the org-app pool width. `surveyPot`
 * starts four other independent database reads alongside this slice, so an
 * unbounded `Promise.all(planSlugs.map(...))` can queue dozens of acquisitions
 * behind an eight-connection pool and make the whole MCP plane go silent.
 */
export const POT_SURVEY_PLAN_READ_CONCURRENCY = 2;

/**
 * WI-10002668: how many POTS {@link surveyWorkspace} surveys at once. One
 * `surveyPot` already peaks at four scope reads plus
 * {@link POT_SURVEY_PLAN_READ_CONCURRENCY} plan reads (6), so a second concurrent
 * pot would exceed the eight-connection org pool the constant above guards. The
 * old unbounded `Promise.all` over every pot (29 on the dev tower) queued ~170
 * acquisitions per call and put 42-80 concurrent frontier scans on the tower PG.
 * Serial pots cost little now that {@link shareScopedSurveyReads} collapses
 * every pot sharing a scope onto one read.
 */
export const WORKSPACE_SURVEY_POT_CONCURRENCY = 1;

/** Importance rank for "hottest open item" (most → least). */
const IMPORTANCE_RANK = Object.fromEntries(IMPORTANCE_LEVELS.map((level, i) => [level, i])) as Record<
  Importance,
  number
>;

function daysSince(ts: unknown, now: number): number {
  if (!ts) return 0;
  const t = new Date(ts as string | number | Date).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now - t) / MS_PER_DAY);
}

// ── Membership (the P-012 fix) ──────────────────────────────────────────────

export interface PotMembership {
  /** The Pot's home (`kind:'hive'`) harness slug. */
  home: string;
  /** Member harness slugs (registry `hive_slug` === home), excluding home. */
  members: string[];
  /**
   * The concrete slugs to survey: home + members when membership is wired, else
   * `[]` — meaning "survey the whole workspace" (the home-only blind-spot guard).
   */
  surveySlugs: string[];
  /** How the survey is scoped — surfaced so a caller can see the fallback. */
  scope: 'members' | 'workspace';
}

type RegistryProjectForPotSurvey = { slug: string; hive_slug?: string; harness_kind?: string };

/**
 * Resolve a Pot's member harnesses from the registry. The home slug plus every
 * project whose `hive_slug` points at it. When no member is wired, `surveySlugs`
 * is empty so the survey runs workspace-wide instead of the (empty) home slug —
 * P-012's structural guard against the 2026-06-11 home-only miss.
 */
export async function resolvePotMembership(
  workspaceId: string,
  potHomeSlug: string,
  loadRegistry: (ws: string) => Promise<{ projects: RegistryProjectForPotSurvey[] }> = loadHarnessRegistry,
): Promise<PotMembership> {
  const reg = await loadRegistry(workspaceId);
  const members = reg.projects.filter((p) => p.hive_slug === potHomeSlug && p.slug !== potHomeSlug).map((p) => p.slug);
  const surveySlugs = members.length > 0 ? Array.from(new Set([potHomeSlug, ...members])) : [];
  return {
    home: potHomeSlug,
    members,
    surveySlugs,
    scope: surveySlugs.length > 0 ? 'members' : 'workspace',
  };
}

// ── Scope / pause enforcement (mug-steering-panel C-2, owned here) ─────────

/**
 * Frontier scope + pause control for the Mug's survey (mug-steering-panel
 * Brief B-03 / contract C-2). The steering panel (or an overwatch nudge) sets
 * this on `surveyPot` to STEER the Mug without stopping her:
 *
 *  - `pauseNewWork` (or `now < pausedUntil`) → the FRONTIER is emptied, so the
 *    Mug places no NEW work and instead drives existing placements to terminal,
 *    then idles. Started-plan momentum is intentionally NOT paused — pause gates
 *    only NEW unplaced work, not the work already in flight.
 *  - `allowedHarnesses` → the survey (frontier AND plans) is restricted to those
 *    harness slugs — a scope boundary the Mug cannot place outside of.
 *
 * Absent / empty ⇒ a no-op (the full, unscoped survey). Pure + side-effect-free
 * so it composes into surveyPot's existing readiness pipeline + unit-tests with
 * no DB.
 */
export interface ScopeFilter {
  /** Restrict the survey to these harness slugs (frontier + plans). Omit/[] ⇒ all. */
  allowedHarnesses?: string[];
  /** STOP-LIST: exclude frontier + plan work whose harness/pot is in this set —
   *  the per-pot Stop (per-pot start-stop 2026-06-30). A stop-list (NOT an
   *  allow-list) so standalone / unhived / started work is never regressed: only
   *  work belonging to an explicitly-STOPPED pot is withheld. Omit/[] ⇒ none. */
  stoppedHarnesses?: string[];
  /** Restrict the PLAN view to these plan slugs — the owner's `eligiblePlans`
   *  (owner-steering C-1): "pour cups only into these plans". Omit/[] ⇒ all. The
   *  frontier (new unplaced work) is gated by pause + allowedHarnesses, not this. */
  eligiblePlans?: string[];
  /** Hard pause: empty the frontier (the Mug places no new work). */
  pauseNewWork?: boolean;
  /** Timed pause: empty the frontier while `now < pausedUntil` (epoch ms). */
  pausedUntil?: number;
  /** Whether plan-LESS ("loose") frontier work-items — directly-filed features,
   *  benchmark/sandbox items, anything with no source plan — are placed. The
   *  owner's "Non-plan work items" steering toggle. Default (undefined) ⇒ TRUE
   *  (loose work is placed); set false to have the Mug work ONLY plan-tied
   *  items. Independent of eligiblePlans: loose work is gated by THIS, plan-tied
   *  work by eligiblePlans. */
  includeUnplannedWork?: boolean;
}

/** Is NEW-work placement paused right now under this filter? (pure) */
export function isNewWorkPaused(f: ScopeFilter | undefined, now: number): boolean {
  if (!f) return false;
  if (f.pauseNewWork) return true;
  return typeof f.pausedUntil === 'number' && now < f.pausedUntil;
}

/** Does `harnessSlug` pass the filter's allow-list? (pure; no list ⇒ allow all) */
export function inAllowedHarness(harnessSlug: string, f: ScopeFilter | undefined): boolean {
  if (!f?.allowedHarnesses || f.allowedHarnesses.length === 0) return true;
  return f.allowedHarnesses.includes(harnessSlug);
}

/** Is `harnessSlug` NOT in the stop-list (a stopped pot)? per-pot Stop gate.
 *  (pure; no list ⇒ pass — a stop-list only WITHHOLDS explicitly-stopped work.) */
export function notStopped(harnessSlug: string, f: ScopeFilter | undefined): boolean {
  if (!f?.stoppedHarnesses || f.stoppedHarnesses.length === 0) return true;
  return !f.stoppedHarnesses.includes(harnessSlug);
}

/** Does `planSlug` pass the filter's eligible-plans list? (pure; no list ⇒ allow all) */
export function inEligiblePlans(planSlug: string, f: ScopeFilter | undefined): boolean {
  if (!f?.eligiblePlans || f.eligiblePlans.length === 0) return true;
  return f.eligiblePlans.includes(planSlug);
}

/**
 * Frontier-row work eligibility — two INDEPENDENT owner controls, so plan focus
 * and loose-work handling no longer conflate (mug-steering-panel D-004 → P-008;
 * decoupled by owner directive 2026-06-30). A frontier work-item passes iff:
 *   - it is PLAN-LESS ("loose": a directly-filed feature, a benchmark/sandbox
 *     item) → included IFF `includeUnplannedWork` (the "Non-plan work items"
 *     toggle; default undefined ⇒ TRUE, i.e. loose work is placed); OR
 *   - it is PLAN-TIED → passes when there is no eligiblePlans restriction, else
 *     only when its source plan is in the eligible set.
 * Before this the two were coupled: setting eligiblePlans silently DROPPED all
 * loose work. Now the owner controls loose work explicitly (turn it off to have
 * the Mug work ONLY plan-tied items), and eligiblePlans focuses only plan-tied
 * work. Clearing both restores the full, unscoped frontier.
 * Distinct from {@link inEligiblePlans} (the PLAN view, where every candidate
 * always carries a plan slug). (pure)
 */
export function frontierInEligiblePlans(planSlug: string | null | undefined, f: ScopeFilter | undefined): boolean {
  if (!planSlug) return f?.includeUnplannedWork !== false; // loose work: gated by the toggle (default include)
  if (!f?.eligiblePlans || f.eligiblePlans.length === 0) return true; // plan-tied, no restriction ⇒ pass
  return f.eligiblePlans.includes(planSlug);
}

// ── Candidate builders (pure) ───────────────────────────────────────────────

/** Hottest-open-item importance for a plan (done/dropped excluded), 'normal' floor. */
function planMaxImportance(row: PlanIndexRow): Importance {
  let max: Importance | null = null;
  for (const it of row.items) {
    if (it.status === 'done' || it.status === 'dropped') continue;
    const imp = (IMPORTANCE_LEVELS as readonly string[]).includes(it.importance)
      ? (it.importance as Importance)
      : 'normal';
    if (max === null || IMPORTANCE_RANK[imp] < IMPORTANCE_RANK[max]) max = imp;
  }
  return max ?? 'normal';
}

/**
 * A STARTED plan → a placement candidate (PLAN view). Returns null for any plan
 * not operationally started (the Mug pours cups only into started plans).
 * `escalations` = open `needs-human` items (decisions waiting on a human);
 * `openItems` = todo+wip depth, surfaced as placement-capacity metadata.
 */
export function planToCandidate(
  row: PlanIndexRow,
  now: number,
  opts: { includeUnstarted?: boolean } = {},
): PlacementCandidate | null {
  const reconciled = reconcileStartStatus(row.opStatus, row.status);
  const started = reconciled === 'started';
  if (!started) {
    // By default the Mug pours cups only into STARTED plans, so an unstarted plan is
    // invisible — UNLESS it is owner-EXPLICITLY-eligible (includeUnstarted), in which
    // case we SURFACE it so she can start + decompose it (mug-autonomy-and-selffeed
    // C-1 / P-B1: eligible-plans is a self-FEED, not just a scope restriction). Never
    // surface a TERMINAL plan (shipped/superseded, or a reconciled-done started plan).
    if (!opts.includeUnstarted) return null;
    if (reconciled === 'done' || isTerminalPlanStatus(row.status)) return null;
  }
  let openItems = 0;
  let escalations = 0;
  for (const it of row.items) {
    if (it.status === 'todo' || it.status === 'wip') openItems += 1;
    if (it.status === 'needs-human') escalations += 1;
  }
  return {
    id: row.planSlug,
    view: 'plan',
    harness: row.harnessSlug,
    title: row.title ?? row.planSlug,
    importance: planMaxImportance(row),
    ageDays: daysSince(row.opUpdatedAt ?? row.updatedAt, now),
    opPriority: row.opPriority,
    escalations,
    openItems,
    // Surfaced-but-not-started ⇒ the Mug must start+decompose it before placing its
    // work (vs an already-running plan). She reads this to pick the right action.
    ...(started ? {} : { needsStart: true }),
  };
}

/** A row from the unplaced feature-family frontier query. */
export interface FrontierRow {
  feature_id: string;
  harness_slug: string;
  title: string | null;
  item_kind: string;
  created_ts: number | string | Date | null;
  feature_order: number | null;
  /** Source plan slug (hfc.source_plan_slug) this frontier item was minted from,
   *  or null for unplanned/standalone work. Lets the survey HARD-filter the frontier
   *  by the owner's `eligiblePlans` (mug-steering-panel P-008). Optional so callers
   *  that build a FrontierRow without provenance (e.g. placement-gather) still compile. */
  plan_slug?: string | null;
  /** Feature payload (including external blockers). Optional so callers that build
   *  a FrontierRow without payload still compile. */
  payload?: unknown;
  /** Issue-family severity (bug/change/task rows only — EI-12275), sourced from
   *  `payload->'_ei'->>'severity'` by {@link fetchEscalatedIssueFrontierRows}. Absent
   *  for ordinary feature/chunk rows, which carry no severity prior. */
  severity?: 'critical' | 'major' | 'minor' | 'nit' | null;
}

/** An unplaced work-item row → a placement candidate (FRONTIER view). */
export function frontierRowToCandidate(row: FrontierRow, now: number): PlacementCandidate {
  return {
    id: row.feature_id,
    view: 'work-item',
    harness: row.harness_slug,
    title: row.title ?? row.feature_id,
    // Raw frontier items carry no plan-importance link yet; the PLAN view holds
    // the "which plan matters" signal. Aging + manual priority order them here.
    importance: 'normal',
    ageDays: daysSince(row.created_ts, now),
    opPriority: row.feature_order,
    // EI-12275: carry severity through so the ranker's blocking-impact feature
    // (which already weights severity) actually scores it — previously every
    // frontier candidate scored severity=0 regardless of kind.
    ...(row.severity ? { severity: row.severity } : {}),
  };
}

// ── Readiness: honor blocked_by so the survey skips blocked lanes (W-01/P-010) ─

/**
 * One harness's feature→feature blocking graph, as the readiness filter needs it:
 * the blocker sets (reused from the orchestrator's single source of truth,
 * `getFeatureBlockers` → `coord_links rel='blocks'`) plus the statuses of the
 * referenced blockers (so terminal-ness — passed/deprecated → satisfied — is
 * resolvable). Empty maps ⇒ nothing in this harness is blocked.
 */
export interface HarnessBlockGraph {
  /** blocked feature_id → blocker feature_ids (within-harness, bare ids). */
  blockers: Map<string, (string | WorkItemBlockerRequirement)[]>;
  /** feature_id → status, for the referenced blockers (terminal resolution). */
  statuses: Map<string, string>;
}

/**
 * Plan-item blocking graph for the readiness filter: resolves whether a plan-item
 * is blocked by its blockedBy chain (EI-12372). Since work-items can link to
 * plan-items via `payload.plan_item`, a frontier work-item is unplaceable if its
 * linked plan-item's blockers are unresolved.
 * - `planItemBlockers`: plan_slug → { item_id → blocker_item_ids[] } (the plan-item's `blockedBy` field)
 * - `planItemStatuses`: (plan_slug, item_id) → status, for resolving blocker terminal-ness
 */
export interface PlanItemBlockGraph {
  /** plan_slug → (item_id → blocker_item_ids[]). */
  planItemBlockers: Map<string, Map<string, string[]>>;
  /** plan_slug → (item_id → status), for blocker terminal resolution. */
  planItemStatuses: Map<string, Map<string, string>>;
}

/** Terminal statuses for plan-items (same as the orchestrator uses). */
const PLAN_ITEM_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['passed', 'deprecated', 'done']);

/** Dispatchable status for the survey's frontier: an unplaced lane is a `todo` item. */
const FRONTIER_READINESS: ReadonlySet<string> = new Set(['todo']);

/**
 * Drop frontier rows whose `blocked_by` isn't satisfied — the same predicate the
 * DBOS orchestrator dispatches by (`selectReady`, frontier-readiness.ts): a lane
 * is ready iff every blocker is TERMINAL (passed/deprecated) or absent. So a wave's
 * tier2 stays out of the Mug's frontier until tier1 completes (D-002: one
 * readiness, two consumers). Feature ids aren't globally unique, so readiness is
 * computed per-harness. Also checks plan-item blocking (EI-12372): a work-item
 * whose linked plan-item (via `payload.plan_item`) has unresolved blockers is
 * excluded. Returns the kept (ready) rows and the count dropped.
 */
export function filterReadyFrontier(
  rows: readonly FrontierRow[],
  graphByHarness: ReadonlyMap<string, HarnessBlockGraph>,
  planItemGraph?: PlanItemBlockGraph,
): { ready: FrontierRow[]; blockedCount: number } {
  const byHarness = new Map<string, FrontierRow[]>();
  for (const r of rows) {
    const g = byHarness.get(r.harness_slug);
    if (g) g.push(r);
    else byHarness.set(r.harness_slug, [r]);
  }
  const ready: FrontierRow[] = [];
  let blockedCount = 0;
  for (const [harness, hRows] of byHarness) {
    const graph = graphByHarness.get(harness);
    const needsExternalBlockerCheck = hRows.some((r) => r.payload && activeExternalBlockers(r.payload).length > 0);
    if ((!graph || graph.blockers.size === 0) && !needsExternalBlockerCheck) {
      ready.push(...hRows); // nothing blocked in this harness
      continue;
    }
    // Build the node set selectReady scores: each candidate (a `todo` lane) plus
    // its referenced blockers (carrying their real status so terminal blockers
    // satisfy). A blocker with no resolved status is simply absent ⇒ satisfied.
    // Also include active external blockers with both trigger and capability class.
    const nodes = new Map<string, ReadinessNode>();
    for (const r of hRows) {
      const extBlockers = activeExternalBlockers(r.payload).map((b) => `${b.kind}:${b.capability}:${b.ref}`);
      nodes.set(r.feature_id, {
        id: r.feature_id,
        status: 'todo',
        blockedBy: graph?.blockers.get(r.feature_id) ?? [],
        ...(extBlockers.length > 0 ? { externalBlockers: extBlockers } : {}),
      });
    }
    for (const r of hRows) {
      for (const blocker of graph?.blockers.get(r.feature_id) ?? []) {
        const blockerId = typeof blocker === 'string' ? blocker : blocker.id;
        if (nodes.has(blockerId)) continue; // already a candidate node
        const status = graph?.statuses.get(blockerId);
        if (status != null) nodes.set(blockerId, { id: blockerId, status, blockedBy: [] });
      }
    }
    const { ready: readyNodes } = selectReady(
      [...nodes.values()], new Set(), FRONTIER_READINESS, undefined, ALL_SUCCESSFUL_STATUSES,
    );
    const readyIds = new Set(readyNodes.map((n) => n.id));
    for (const r of hRows) {
      if (!readyIds.has(r.feature_id)) {
        blockedCount += 1;
        continue;
      }
      // Check if this work-item's linked plan-item (if any) is blocked (EI-12372).
      // A work-item with payload.plan_item = { plan_slug, item_id } is blocked if
      // its plan-item has unresolved blockers in its blockedBy chain.
      if (planItemGraph && r.payload && typeof r.payload === 'object' && r.payload !== null && 'plan_item' in r.payload) {
        const planItem = (r.payload as Record<string, unknown>).plan_item;
        if (planItem && planItem !== null && typeof planItem === 'object' && 'plan_slug' in planItem && 'item_id' in planItem) {
          const planSlug = (planItem as Record<string, unknown>).plan_slug as string;
          const itemId = (planItem as Record<string, unknown>).item_id as string;
          const planBlockers = planItemGraph.planItemBlockers.get(planSlug)?.get(itemId) ?? [];
          // Check if any blocker is non-terminal.
          let planItemBlocked = false;
          for (const blocker of planBlockers) {
            const blockerStatus = planItemGraph.planItemStatuses.get(planSlug)?.get(blocker);
            if (!blockerStatus || !PLAN_ITEM_TERMINAL_STATUSES.has(blockerStatus)) {
              planItemBlocked = true;
              break;
            }
          }
          if (planItemBlocked) {
            blockedCount += 1;
            continue;
          }
        }
      }
      ready.push(r);
    }
  }
  return { ready, blockedCount };
}

// ── PG reads (thin) ─────────────────────────────────────────────────────────

/**
 * Ephemeral benchmark / throwaway harness instances — the xbench fleet
 * (`xbench-su-*`, `xbq…` pot hashes), memory-capacity probes, per-task
 * `*-instance_*` churn. EI-1525: when a pot's membership isn't wired,
 * {@link resolvePotMembership}'s P-012 workspace-wide fallback (`surveySlugs
 * === []`) has NO harness filter at all — so this ephemeral debris was being
 * surveyed as real frontier work, going Mug-unresolvable, and escalating
 * (~13k false escalations from ~253 torn-down xbench/instance work-items on
 * 2026-06-18). Excluding it here closes that hole regardless of whether
 * membership ever gets wired. Mirrors the watchdog's EPHEMERAL_BENCHMARK_SLUG_RE
 * (watchdog.ts P-006) — kept as a local copy (same convention as
 * git-sync-eligibility.ts's EPHEMERAL_INSTANCE_SLUG_RE) so this hot Mug-wake
 * path gains no dependency on the heavy watchdog module. Real harness slugs
 * (papercup, papercup-org, papercup-pot, sheets, …) never match.
 */
const EPHEMERAL_BENCHMARK_SLUG_SQL_RE =
  '(^|[^a-z0-9])(xbench|xbq[a-z0-9]{6}|hiveloop|memcap|memrun)|-instance[_-]|_instance[_-]|deleteme|^e2e-imp|^sb-gym|gym-eval|^bench-|smoke-p[0-9]';

/**
 * The unplaced FRONTIER across the given harnesses: feature-family work-items
 * that are `todo` and unassigned — exactly what placement would dispatch.
 * `surveySlugs` empty ⇒ workspace-wide (the P-012 fallback), MINUS ephemeral
 * benchmark/instance debris (EI-1525 — see {@link EPHEMERAL_BENCHMARK_SLUG_SQL_RE}).
 * Oldest-first, capped. One query (no per-slug loop).
 *
 * EI-865 / WI-677 — PATHOLOGY-CURSED items are excluded. A watchdog `cursed`
 * row only hard-blocks the frontier when its fail_count reached the real
 * pathology breaker threshold. A fail_count=0 infra curse (host restart /
 * drain / zombie with no task failure) stays re-placeable, matching
 * place_batch's loadCursedWorkItemIds gate; otherwise Mug sees an empty
 * survey frontier while place_batch would have accepted the work.
 *
 * EI-8498 — G2-ADMISSION excluded. `fleet:place_batch`'s gatherFrontier
 * (placement-gather.ts) has applied the G2 admission predicate
 * (`isAutoPickable`/`autoPickableWhereSql`) since shared-pot-trust-admission
 * P-001: a remote, un-admitted item is quarantined and never placed. This
 * survey frontier grew up alongside that path and never inherited the
 * predicate, so a quarantined item (e.g. WI-2601) showed up here as "ready"
 * even though place_batch would refuse it — indistinguishable from a
 * genuinely-stuck placeable item, and the watchdog/escalation surfaces built
 * on this survey kept re-raising "frontier stuck, Mug/Mug nudge not
 * landing" false alarms for it wake after wake. Applying the SAME predicate
 * here (ws-scoped, includes the P-010 trust fast-path) closes that gap so the
 * survey's "ready" frontier matches what placement can actually pick up.
 */
export async function fetchFrontierRows(
  sql: postgres.Sql,
  workspaceId: string,
  surveySlugs: readonly string[],
  limit = 50,
): Promise<FrontierRow[]> {
  const breakerThreshold = placementConfig().breakerThreshold;
  const rows = await sql<FrontierRow[]>`
    SELECT feature_id, harness_slug, title, item_kind, created_ts, feature_order,
           source_plan_slug AS plan_slug, payload
      FROM harness_shared.harness_features_consolidated wi
     WHERE workspace_id = ${workspaceId}
       AND ${frontierPlacementKindClause(sql, workspaceId)}
       -- WI-42165: callers speak the canonical open token, while the storage boundary
       -- read-folds the retired feature-family todo alias. Raw writers have regressed
       -- after migration 638, and a raw equality permanently stranded those rows.
       AND (CASE WHEN status = 'todo' THEN 'open' ELSE status END) = 'open'
       AND (taken_by IS NULL OR taken_by = '')
       AND ${autoPickableWhereSql(sql, workspaceId)}
       AND ${admittedWhereSql(sql)}
       -- EI-13501: a claim-held item (payload._claimHold — the SAME general-purpose
       -- "do not self-place" marker claimFloorsWhereSql already honors for the scheduler
       -- claim path, e.g. a leader-held feature or an owner GO/NO-GO gate) is structurally
       -- NOT cup-placeable. Without this the Mug's own frontier count disagreed with what
       -- claim_next/scheduler:get_next would actually serve — every item in the live feature
       -- frontier was claim-held on 2026-07-17 (WI-321/357/662/1281/1774), so this floor was
       -- previously a 100% false-positive "N ready to place" signal, not an edge case.
       AND ${claimHoldExclusionSql(sql)}
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.pot_placements p
          WHERE p.workspace_id = wi.workspace_id
            AND p.work_item_id = wi.feature_id
            AND p.status = 'cursed'
            AND p.fail_count >= ${breakerThreshold}
            -- Scope the curse to THIS pot's own installs (papercup→papercusp migration follow-up,
            -- 2026-06-20): a curse from a RETIRED/foreign install must not hide the item from the
            -- home pot's frontier. Unscoped only in the workspace-wide fallback (surveySlugs empty).
            ${surveySlugs.length > 0 ? sql`AND p.install_slug = ANY(${surveySlugs as string[]})` : sql``}
       )
       -- EI-13695: a row carrying a surviving work-item checkpoint was already
       -- attempted (a cup died before converging state) — it is RECONCILE work
       -- (fetchReconcileFrontier), never fresh placeable frontier.
       AND NOT ${hasWorkItemCheckpointSql(sql)}
       ${surveySlugs.length > 0 ? sql`AND harness_slug = ANY(${surveySlugs as string[]})` : sql``}
       AND harness_slug !~* ${EPHEMERAL_BENCHMARK_SLUG_SQL_RE}
     ORDER BY created_ts ASC
     LIMIT ${limit}`;
  return rows;
}

/**
 * The escalated-ISSUE slice of the frontier (EI-12275). `frontierPlacementKindClause`
 * — and the `harness_features_consolidated` view it's applied to — deliberately
 * restrict {@link fetchFrontierRows} to the feature-family kinds ('feature'/'chunk'
 * + opted-in generic-kind datatypes): issue-family work-items (bug/change/task) are
 * dispatched through a wholly separate tier-3 claim pool (SCHEDULER_ISSUES_CLAIMABLE
 * / `claimNextIssueWorkItem`), not the Mug's proactive new-cup-spawn frontier — by
 * design, not oversight (work-items.ts's D-006 comment).
 *
 * But that split had a real gap: a release-blocking issue-family item (severity
 * major/critical) that ISN'T picked up promptly by an idle bee pulling the tier-3
 * pool was **structurally invisible** to the Mug's ranked survey too — it could never
 * appear in `frontier` no matter how many open escalations were attached, because it
 * was excluded from the query before `rankPlacements` (and its escalation-pressure /
 * severity weights) ever ran. EI-12220 sat unplaced ~2h despite three open
 * blocker-severity escalations before a human manually intervened.
 *
 * Fix: surface ONLY the high-bar subset (severity critical/major) as additional
 * `FrontierRow`s, carrying `severity` so the existing blocking-impact feature
 * (severity prior: critical=10, major=6) finally scores them — and pass them through
 * the SAME readiness/G2-admission/cursed/scope machinery as the feature frontier
 * (concatenated before {@link filterReadyFrontier} in `surveyPot`), so a blocked or
 * quarantined escalated issue is excluded exactly like a blocked feature would be.
 * Deliberately narrow (severity gate, not "every open bug") — the tier-3 claim pool
 * stays the primary issue-dispatch path; this only ensures a genuinely urgent one is
 * never silently invisible to the Mug's own placement decision.
 */
export async function fetchEscalatedIssueFrontierRows(
  sql: postgres.Sql,
  workspaceId: string,
  surveySlugs: readonly string[],
  limit = 10,
): Promise<FrontierRow[]> {
  const breakerThreshold = placementConfig().breakerThreshold;
  const rows = await sql<FrontierRow[]>`
    SELECT feature_id, harness_slug, title, item_kind, created_ts, feature_order,
           source_plan_slug AS plan_slug, payload,
           COALESCE(payload -> '_ei' ->> 'severity', 'minor') AS severity
      FROM harness_shared.work_items wi
     WHERE workspace_id = ${workspaceId}
       AND item_kind IN ('bug', 'change', 'task')
       -- Keep this storage-alias fold identical to fetchFrontierRows above: this count
       -- gates starvation/throughput signals and must describe the same row set.
       AND (CASE WHEN status = 'todo' THEN 'open' ELSE status END) = 'open'
       AND (taken_by IS NULL OR taken_by = '')
       AND COALESCE(payload -> '_ei' ->> 'severity', 'minor') IN ('critical', 'major')
       AND ${autoPickableWhereSql(sql, workspaceId)}
       AND ${admittedWhereSql(sql)}
       -- EI-13501: this escalated-issue slice grew up alongside the feature frontier
       -- (see fetchFrontierRows) and never inherited the self-select exclusion floors
       -- claimNextIssueWorkItem already enforces for the SAME kinds — so an item that is
       -- structurally cup-forbidden (owner-decision/needs-human, an explicit GO/NO-GO
       -- claim-hold, or last-mile LIVE-rig/VM verification) still counted as a "ready to
       -- place" frontier item, driving recurring false Mug-dark blocker escalations
       -- (live-verified 2026-07-17: 4/10 of the current escalated-issue frontier carried
       -- payload.needsHuman:true). Migration 864 retired that ambiguous legacy payload
       -- floor; mirror the remaining typed owner-action, claim-hold, and rig floors.
       AND ${needsOwnerActionExclusionSql(sql)}
       AND ${claimHoldExclusionSql(sql)}
       AND ${crossMachineRigExclusionSql(sql, false)}
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.pot_placements p
          WHERE p.workspace_id = wi.workspace_id
            AND p.work_item_id = wi.feature_id
            AND p.status = 'cursed'
            AND p.fail_count >= ${breakerThreshold}
            ${surveySlugs.length > 0 ? sql`AND p.install_slug = ANY(${surveySlugs as string[]})` : sql``}
       )
       ${surveySlugs.length > 0 ? sql`AND harness_slug = ANY(${surveySlugs as string[]})` : sql``}
       AND harness_slug !~* ${EPHEMERAL_BENCHMARK_SLUG_SQL_RE}
     ORDER BY (COALESCE(payload -> '_ei' ->> 'severity', 'minor') = 'critical') DESC, created_ts ASC
     LIMIT ${limit}`;
  return rows;
}

/**
 * COUNT of the pot's REAL placeable frontier — the same row set
 * {@link fetchFrontierRows} returns (feature-family, `todo`, unassigned, not
 * cursed), scoped to the pot's member harnesses. This is the depth a per-pot
 * STARVATION signal must gate on (WI-267).
 *
 * The throughput breach previously read `potDemandCheck.todoItems` — a
 * WORKSPACE-WIDE `harness_features_consolidated status='todo'` count that ignored
 * `item_kind`, `taken_by`, the cursed exclusion, AND pot membership. So one
 * workspace-wide number fired identical false "fleet saturated with work still
 * queued" alarms across every pot in the workspace at once (a pot whose own
 * placement frontier is empty/all-taken/cursed was flagged "starved" off another
 * pot's queued work it could never place).
 *
 * MUST mirror fetchFrontierRows' WHERE clause. (Pre-readiness: a `blocked_by`
 * lane is still counted here — the survey's {@link filterReadyFrontier} refines
 * that. A starvation/throughput consumer must NOT gate on this count directly:
 * use {@link potReadyFrontierDepth}, which applies the readiness refinement —
 * the all-blocked-frontier edge fired a phantom Mug-stall scorecard FAIL when a
 * dependency-chained wave sat "placeable" for hours, EI-12461.)
 */
export async function countPlaceableFrontier(
  sql: postgres.Sql,
  workspaceId: string,
  surveySlugs: readonly string[],
): Promise<number> {
  const breakerThreshold = placementConfig().breakerThreshold;
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.harness_features_consolidated wi
     WHERE workspace_id = ${workspaceId}
       AND ${frontierPlacementKindClause(sql, workspaceId)}
       -- WI-42165: mirror fetchFrontierRows' legacy todo -> canonical open storage fold.
       AND (CASE WHEN status = 'todo' THEN 'open' ELSE status END) = 'open'
       AND (taken_by IS NULL OR taken_by = '')
       AND ${autoPickableWhereSql(sql, workspaceId)}
       AND ${admittedWhereSql(sql)}
       -- EI-13501: MUST mirror fetchFrontierRows' claim-hold exclusion (this count
       -- gates starvation/throughput signals — the same drift class this comment
       -- already warns about for the checkpoint exclusion below).
       AND ${claimHoldExclusionSql(sql)}
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.pot_placements p
          WHERE p.workspace_id = wi.workspace_id
            AND p.work_item_id = wi.feature_id
            AND p.status = 'cursed'
            AND p.fail_count >= ${breakerThreshold}
            -- Scope the curse to THIS pot's own installs (papercup→papercusp migration follow-up,
            -- 2026-06-20): a curse from a RETIRED/foreign install must not hide the item from the
            -- home pot's frontier. Unscoped only in the workspace-wide fallback (surveySlugs empty).
            ${surveySlugs.length > 0 ? sql`AND p.install_slug = ANY(${surveySlugs as string[]})` : sql``}
       )
       -- EI-13695: checkpoint-carrying rows are RECONCILE, not placeable — MUST
       -- mirror fetchFrontierRows (this count gates starvation/throughput signals).
       AND NOT ${hasWorkItemCheckpointSql(sql)}
       ${surveySlugs.length > 0 ? sql`AND harness_slug = ANY(${surveySlugs as string[]})` : sql``}
       AND harness_slug !~* ${EPHEMERAL_BENCHMARK_SLUG_SQL_RE}`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * COUNT of the frontier withheld PURELY by the G2 admission gate — rows identical
 * to {@link countPlaceableFrontier}'s (feature-kind, `todo`, unassigned, not cursed,
 * in-scope) that fail ONLY `autoPickableWhereSql`: a remote item with no `admit`
 * verdict and no trusted verified author.
 *
 * This is the SILENT-STARVATION signal, and it exists because the loop had no way
 * to say why it was idle. On 2026-07-13 the papercusp pot's ENTIRE placeable pool
 * was 10 federated `feature` items, every one of them quarantined here; the Mug woke
 * every ~20min, surveyed a frontier of zero, correctly placed nothing, and reported
 * a SUCCESSFUL turn — for five hours, with every health signal green. An empty
 * frontier caused by quarantine is indistinguishable from "no work to do" unless
 * something counts the withheld rows, so nothing ever raised a hand.
 *
 * The gate itself is correct (never auto-execute unvetted remote work). What was
 * missing is that a pot starving BEHIND it must be loud: callers pair this with the
 * placeable depth — `placeable === 0 && quarantined > 0` is a deadlock, not an idle
 * pot, and there is no admit path in production that will clear it on its own.
 */
export async function countQuarantinedFrontier(
  sql: postgres.Sql,
  workspaceId: string,
  surveySlugs: readonly string[],
): Promise<number> {
  const breakerThreshold = placementConfig().breakerThreshold;
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.harness_features_consolidated f
     WHERE workspace_id = ${workspaceId}
       AND ${frontierPlacementKindClause(sql, workspaceId)}
       -- work-item-status-full-unify (2026-07-19, migration 638): feature-family status
       -- 'todo' was rewritten to the unified claimable token 'open' (issue-family already
       -- used 'open'). This literal was never updated, so every genuinely-placeable
       -- feature-family row has been silently invisible to the Mug's survey since that
       -- migration ran (EI-13699 2026-07-17 pre-dates it and had a different proximate
       -- cause; EI-18690462961089460 2026-07-26 is the post-migration recurrence this
       -- fixes — pot:survey read frontier:0 while work_items:claimable read ~1062).
       AND status = 'open'
       AND (taken_by IS NULL OR taken_by = '')
       -- The ONE inverted leg: everything else mirrors countPlaceableFrontier, so
       -- the two partition the same row set into admissible vs. quarantined.
       --
       -- COALESCE(..., FALSE) IS LOAD-BEARING — do not "simplify" it to a bare NOT.
       -- SQL three-valued logic: for the rows this counter EXISTS to find (remote,
       -- never audited) the audit_verdict = 'admit' test is NULL, not FALSE, so the
       -- whole admission expression is NULL — and NOT NULL is NULL, which a WHERE
       -- treats as no-match. A bare NOT (...) therefore returns ZERO quarantined for
       -- precisely the deadlock this counter is meant to detect, and every unit test
       -- still passes (fixtures pass booleans, never NULL). Caught against the live
       -- DB on 2026-07-13. The positive form in countPlaceableFrontier is safe as-is
       -- (a NULL there is falsy in WHERE, which correctly EXCLUDES the row) — it is
       -- only the NEGATION that must pin NULL to FALSE.
       -- NB: no backticks anywhere in this comment — it lives inside a tagged template
       -- literal, so a markdown-style quote would terminate the SQL and break the build.
       AND COALESCE(${autoPickableWhereSql(sql, workspaceId)}, FALSE) = FALSE
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.pot_placements p
          WHERE p.workspace_id = f.workspace_id
            AND p.work_item_id = f.feature_id
            AND p.status = 'cursed'
            AND p.fail_count >= ${breakerThreshold}
            ${surveySlugs.length > 0 ? sql`AND p.install_slug = ANY(${surveySlugs as string[]})` : sql``}
       )
       ${surveySlugs.length > 0 ? sql`AND harness_slug = ANY(${surveySlugs as string[]})` : sql``}
       AND harness_slug !~* ${EPHEMERAL_BENCHMARK_SLUG_SQL_RE}`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * EI-13695 — the FALSE-FRESH guard: does frontier row `f` carry a non-empty
 * work-item CHECKPOINT (harness_shared.carry_notes, workitem scope)? A cup that
 * finishes work and dies before `work_items:complete` leaves the item `todo` with
 * its surviving checkpoint asserting COMPLETE/BLOCKED — indistinguishable from
 * never-touched work everywhere the frontier is read. Re-placing it re-does
 * finished work, and the repeated true-at-the-data-layer / wrong-as-an-action
 * "fresh item" nudges train the Mug to distrust genuinely-fresh signals. So a
 * checkpoint-carrying row is a RECONCILE row, never a fresh placeable one: the
 * Mug converges it (checkpoint says done → verify + complete; says blocked →
 * set_blocker; genuinely mid-flight → deliberately re-place, the checkpoint is
 * the successor's continuity) via {@link fetchReconcileFrontier}. The scope
 * matches work-item-checkpoint.ts's workItemScope + its EI-8805 wildcard
 * canonicalization (a harness-null item keys under 'workitem:*:<id>').
 */
function hasWorkItemCheckpointSql(sql: postgres.Sql) {
  return sql`EXISTS (
    SELECT 1 FROM harness_shared.carry_notes cn
     WHERE cn.workspace_id = wi.workspace_id
       AND cn.scope IN ('workitem:' || wi.harness_slug || ':' || wi.feature_id, 'workitem:*:' || wi.feature_id)
       AND btrim(cn.note) <> '')`;
}

/** A placeable-SHAPED frontier row withheld as RECONCILE (EI-13695): a prior cup
 *  attempted it and died before converging item state — its checkpoint survives.
 *  Carries the checkpoint head + write instant so the Mug routes it (complete /
 *  set_blocker / deliberate re-place) without a per-item read. */
export interface ReconcileFrontierRow {
  feature_id: string;
  harness_slug: string;
  title: string;
  item_kind: string;
  /** First chars of the surviving checkpoint — enough to route the convergence. */
  checkpoint_head: string;
  /** Epoch ms of the checkpoint's last write (staleness signal, EI-8885). */
  checkpoint_updated_ts: number | null;
}

/** The reconcile slice of the frontier: rows + the un-capped total. */
export interface ReconcileFrontier {
  rows: ReconcileFrontierRow[];
  total: number;
}

/**
 * Fetch the RECONCILE frontier (EI-13695): rows matching {@link fetchFrontierRows}'
 * placeable shape (feature-family, `todo`, unassigned, admissible, not cursed,
 * in-scope) that carry a non-empty work-item checkpoint — the set the fresh
 * frontier now EXCLUDES. Newest-checkpoint first (the most recently attempted item
 * is the most likely to have a decisive checkpoint), capped, with the un-capped
 * total alongside.
 */
export async function fetchReconcileFrontier(
  sql: postgres.Sql,
  workspaceId: string,
  surveySlugs: readonly string[],
  limit = 10,
): Promise<ReconcileFrontier> {
  const breakerThreshold = placementConfig().breakerThreshold;
  const rows = await sql<(ReconcileFrontierRow & { total: number })[]>`
    SELECT f.feature_id, f.harness_slug, f.title, f.item_kind,
           left(btrim(cn.note), 240) AS checkpoint_head,
           cn.updated_ts AS checkpoint_updated_ts,
           count(*) OVER ()::int AS total
      FROM harness_shared.harness_features_consolidated f
      JOIN LATERAL (
        SELECT note, updated_ts FROM harness_shared.carry_notes cn
         WHERE cn.workspace_id = f.workspace_id
           AND cn.scope IN ('workitem:' || f.harness_slug || ':' || f.feature_id, 'workitem:*:' || f.feature_id)
           AND btrim(cn.note) <> ''
         ORDER BY cn.updated_ts DESC NULLS LAST
         LIMIT 1
      ) cn ON true
     WHERE workspace_id = ${workspaceId}
       AND ${frontierPlacementKindClause(sql, workspaceId)}
       -- work-item-status-full-unify (2026-07-19, migration 638): feature-family status
       -- 'todo' was rewritten to the unified claimable token 'open' (issue-family already
       -- used 'open'). This literal was never updated, so every genuinely-placeable
       -- feature-family row has been silently invisible to the Mug's survey since that
       -- migration ran (EI-13699 2026-07-17 pre-dates it and had a different proximate
       -- cause; EI-18690462961089460 2026-07-26 is the post-migration recurrence this
       -- fixes — pot:survey read frontier:0 while work_items:claimable read ~1062).
       AND status = 'open'
       AND (taken_by IS NULL OR taken_by = '')
       AND ${autoPickableWhereSql(sql, workspaceId)}
       AND ${admittedWhereSql(sql)}
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.pot_placements p
          WHERE p.workspace_id = f.workspace_id
            AND p.work_item_id = f.feature_id
            AND p.status = 'cursed'
            AND p.fail_count >= ${breakerThreshold}
            ${surveySlugs.length > 0 ? sql`AND p.install_slug = ANY(${surveySlugs as string[]})` : sql``}
       )
       ${surveySlugs.length > 0 ? sql`AND harness_slug = ANY(${surveySlugs as string[]})` : sql``}
       AND harness_slug !~* ${EPHEMERAL_BENCHMARK_SLUG_SQL_RE}
     ORDER BY cn.updated_ts DESC NULLS LAST
     LIMIT ${limit}`;
  return {
    rows: rows.map(({ total: _total, ...r }) => ({
      ...r,
      // carry_notes.updated_ts is a bigint — postgres.js returns it as a string;
      // coerce like getWorkItemCheckpointWithMeta does so the type is honest.
      checkpoint_updated_ts:
        r.checkpoint_updated_ts == null || !Number.isFinite(Number(r.checkpoint_updated_ts))
          ? null
          : Number(r.checkpoint_updated_ts),
    })),
    total: Number(rows[0]?.total ?? 0),
  };
}

/**
 * Resolve a pot's membership and return its placeable-frontier depth (WI-267) —
 * the count a per-pot starvation breach should use instead of the workspace-wide
 * `potDemandCheck.todoItems`. Member-scoped when membership is wired, else the
 * workspace-wide P-012 fallback (mirrors {@link surveyPot}'s own scope choice).
 */
export async function potPlaceableFrontierDepth(workspaceId: string, potHomeSlug: string): Promise<number> {
  const { sql } = getOrgPg();
  const membership = await resolvePotMembership(workspaceId, potHomeSlug);
  return countPlaceableFrontier(sql, workspaceId, membership.surveySlugs);
}

/** A pot's frontier split by the admission gate: what it MAY place vs. what is
 *  withheld from it. `placeable === 0 && quarantined > 0` is the silent-starvation
 *  deadlock (see {@link countQuarantinedFrontier}) — the pot has work and cannot
 *  touch any of it. */
export interface FrontierAdmission {
  placeable: number;
  quarantined: number;
}

/** Both halves of the frontier in ONE membership resolve — the pair a starvation
 *  check needs (an empty frontier only means "deadlock" when something is being
 *  withheld; on its own it just means "no work"). */
export async function potFrontierAdmission(workspaceId: string, potHomeSlug: string): Promise<FrontierAdmission> {
  const { sql } = getOrgPg();
  const membership = await resolvePotMembership(workspaceId, potHomeSlug);
  const [placeable, quarantined] = await Promise.all([
    countPlaceableFrontier(sql, workspaceId, membership.surveySlugs),
    countQuarantinedFrontier(sql, workspaceId, membership.surveySlugs),
  ]);
  return { placeable, quarantined };
}

/** Is the pot DEADLOCKED behind the admission gate — nothing it may place, but work
 *  being withheld? Pure, so the readiness gate can assert it with no DB. */
export function isAdmissionStarved(f: FrontierAdmission): boolean {
  return f.placeable === 0 && f.quarantined > 0;
}

/**
 * Readiness-refined frontier depth — the {@link countPlaceableFrontier} follow-up
 * that comment promised ("the residual all-blocked-frontier edge"). The
 * placeable-SHAPED count includes rows whose `blocked_by` / plan-item chain is
 * unsatisfied, so a starvation alarm gating on it fires "N ready, 0 placed" while
 * every one of the N is dependency-held. EI-12461 (2026-07-17): a 25-item wave
 * landed with its tiers blocked_by-chained; the throughput tick's
 * `frontier_depth` read ~14 through ~2.5h of CORRECT zero placement, and the
 * release scorecard failed placement-throughput on a phantom Mug stall. `ready`
 * is the same predicate the Mug's survey and the orchestrator dispatch by
 * ({@link filterReadyFrontier}) — what placement can pick up NOW.
 */
export interface ReadyFrontierDepth {
  /** Rows placement can pick up NOW (placeable-shaped AND readiness-satisfied). */
  ready: number;
  /** Placeable-shaped rows held back by an unsatisfied blocked_by / plan-item chain. */
  blocked: number;
  /** The pre-readiness placeable-shaped count ({@link countPlaceableFrontier}). */
  placeableShaped: number;
}

/**
 * Resolve a pot's membership and return its frontier depth with the readiness
 * refinement applied ({@link ReadyFrontierDepth}). Cheap in the common idle case:
 * the graph/plan reads are spent only when the placeable-shaped count is nonzero
 * (an empty frontier needs no refinement), so a 30s ticker can afford it.
 * Fail-open mirrors {@link surveyPot}: an unreadable block graph or plan index
 * treats lanes as unblocked — worst case `ready` is over-reported (the
 * pre-refinement behaviour), never under.
 */
export async function potReadyFrontierDepth(workspaceId: string, potHomeSlug: string): Promise<ReadyFrontierDepth> {
  const { sql } = getOrgPg();
  const membership = await resolvePotMembership(workspaceId, potHomeSlug);
  const placeableShaped = await countPlaceableFrontier(sql, workspaceId, membership.surveySlugs);
  if (placeableShaped === 0) return { ready: 0, blocked: 0, placeableShaped: 0 };

  const rows = await fetchFrontierRows(
    sql,
    workspaceId,
    membership.surveySlugs,
    Math.min(Math.max(placeableShaped, 50), 200),
  );
  const graphByHarness = new Map<string, HarnessBlockGraph>();
  await Promise.all(
    [...new Set(rows.map((r) => r.harness_slug))].map(async (h) => {
      try {
        graphByHarness.set(h, await fetchHarnessBlockGraph(sql, workspaceId, h));
      } catch (err) {
        console.warn(
          `[pot-frontier-depth] block-graph read failed for '${h}' — lanes treated unblocked:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
  // Plan-item chains (EI-12372) scope like surveyPot: the survey slugs, or the
  // home slug on the workspace-wide membership fallback.
  const planSlugs = membership.surveySlugs.length > 0 ? membership.surveySlugs : [potHomeSlug];
  const planRowsPerHarness = await Promise.all(
    planSlugs.map(async (slug) => {
      try {
        return await listPlanIndexRowsCached({ harnessSlug: slug, workspaceId });
      } catch (err) {
        console.warn(
          `[pot-frontier-depth] plan read failed for '${slug}' — plan-item lanes treated unblocked:`,
          err instanceof Error ? err.message : err,
        );
        return [] as PlanIndexRow[];
      }
    }),
  );
  const { ready, blockedCount } = filterReadyFrontier(rows, graphByHarness, buildPlanItemBlockGraph(planRowsPerHarness));
  return { ready: ready.length, blocked: blockedCount, placeableShaped };
}

/**
 * One harness's blocking graph for the readiness filter: the blocker sets (the
 * orchestrator's single source of truth, `getFeatureBlockers`) plus the statuses
 * of the referenced blockers (one indexed lookup; skipped when nothing blocks).
 */
export async function fetchHarnessBlockGraph(
  sql: postgres.Sql,
  workspaceId: string,
  harness: string,
): Promise<HarnessBlockGraph> {
  const blockers = await defaultBlockingStore.blockersFor(harness);
  const blockerIds = new Set<string>();
  for (const arr of blockers.values()) {
    for (const blocker of arr) blockerIds.add(typeof blocker === 'string' ? blocker : blocker.id);
  }
  let statuses = new Map<string, string>();
  if (blockerIds.size > 0) {
    const rows = await sql<{ feature_id: string; status: string }[]>`
      SELECT feature_id, status
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${harness}
         AND feature_id = ANY(${Array.from(blockerIds)})`;
    statuses = new Map(rows.map((r) => [r.feature_id, r.status]));
  }
  return { blockers, statuses };
}

/**
 * Build a plan-item blocking graph from plan rows (EI-12372): maps each plan's
 * items to their blockedBy dependencies and resolved statuses. This allows the
 * frontier filter to exclude work-items whose linked plan-item has unresolved
 * blockers. Pure, injected for testability.
 */
export function buildPlanItemBlockGraph(planRowsPerHarness: readonly PlanIndexRow[][]): PlanItemBlockGraph {
  const planItemBlockers = new Map<string, Map<string, string[]>>();
  const planItemStatuses = new Map<string, Map<string, string>>();

  for (const rows of planRowsPerHarness) {
    for (const row of rows) {
      const planSlug = row.planSlug;
      // Initialize maps for this plan if not already present
      if (!planItemBlockers.has(planSlug)) {
        planItemBlockers.set(planSlug, new Map());
        planItemStatuses.set(planSlug, new Map());
      }
      const itemBlockers = planItemBlockers.get(planSlug)!;
      const itemStatuses = planItemStatuses.get(planSlug)!;

      // Build a map of item_id → status for quick lookup
      const itemStatusMap = new Map<string, string>();
      for (const item of row.items) {
        itemStatusMap.set(item.id, item.status);
      }

      // Record blockedBy and statuses for each item
      for (const item of row.items) {
        itemBlockers.set(item.id, item.blockedBy ?? []);
        // Also record all blocker statuses for terminal resolution
        for (const blocker of item.blockedBy ?? []) {
          const blockerStatus = itemStatusMap.get(blocker);
          if (blockerStatus) {
            itemStatuses.set(blocker, blockerStatus);
          }
        }
      }
    }
  }

  return { planItemBlockers, planItemStatuses };
}

// ── The assembled survey ────────────────────────────────────────────────────

export interface PotSurvey {
  home: string;
  members: string[];
  scope: 'members' | 'workspace';
  /** Started plans, ranked (which plan to pour cups into) — PLAN view. */
  plans: Ranked<PlacementCandidate>[];
  /** Unplaced + READY work-items, ranked (which ready item to place) — FRONTIER view. */
  frontier: Ranked<PlacementCandidate>[];
  /** Frontier rows dropped because their `blocked_by` wasn't satisfied (W-01/P-010). */
  frontierBlocked: number;
  /**
   * Frontier rows WITHHELD purely by the G2 admission gate (remote + un-admitted)
   * — the silent-starvation signal (EI-8498). `frontier.length === 0 &&
   * frontierQuarantined > 0` is an admission DEADLOCK, not an idle pot: the pot
   * has placeable-SHAPED work (todo, unassigned, not cursed, in-scope) it is
   * structurally blocked from touching. Surfaced so an empty frontier is
   * diagnosable AT A GLANCE — the WI-4563 fix. Before this, a survey that
   * returned `frontier: []` for the same reason wake after wake was
   * indistinguishable from "no work to do", and read as a mysterious read-path
   * bug for 14+ consecutive Mug wakes. The counts EXISTED
   * ({@link countQuarantinedFrontier}); the survey just never wired one in.
   */
  frontierQuarantined: number;
  /**
   * EI-13695: placeable-SHAPED rows carrying a surviving work-item CHECKPOINT — a
   * prior cup attempted them and died before converging item state (the false-fresh
   * class). EXCLUDED from `frontier`: re-placing one invites re-doing finished work.
   * The Mug RECONCILES these instead: checkpoint says done → verify + complete;
   * says blocked → set_blocker; genuinely mid-flight → deliberately re-place (the
   * checkpoint is the successor's continuity).
   */
  frontierReconcile: number;
  /** The reconcile rows themselves (capped), with checkpoint heads — enough for the
   *  Mug to route each convergence without a per-item read. */
  reconcileRows: ReconcileFrontierRow[];
}

export interface SurveyDeps {
  loadRegistry: (ws: string) => Promise<{ projects: RegistryProjectForPotSurvey[] }>;
  listPlanRows: (harnessSlug: string) => Promise<PlanIndexRow[]>;
  fetchFrontier: (surveySlugs: readonly string[], limit: number) => Promise<FrontierRow[]>;
  /** The escalated-issue slice (EI-12275) — severity critical/major bug/change/task
   *  rows, otherwise invisible to the feature-only {@link fetchFrontier}. Injectable,
   *  mirroring `fetchFrontier`; defaults to {@link fetchEscalatedIssueFrontierRows}. */
  fetchEscalatedIssues: (surveySlugs: readonly string[], limit: number) => Promise<FrontierRow[]>;
  /** Resolve one harness's blocking graph for the readiness filter (W-01/P-010). */
  fetchBlockGraph: (harness: string) => Promise<HarnessBlockGraph>;
  /** Count the frontier withheld PURELY by the G2 admission gate (remote +
   *  un-admitted), scoped to the SAME surveySlugs as the frontier fetch — the
   *  silent-starvation signal (EI-8498 / WI-4563). Injectable so the survey
   *  unit-tests with no DB, mirroring {@link fetchFrontier}. */
  fetchQuarantinedCount: (surveySlugs: readonly string[]) => Promise<number>;
  /** The RECONCILE slice (EI-13695) — placeable-shaped rows a fresh frontier now
   *  excludes because a dead cup's checkpoint survives on them. Injectable,
   *  mirroring {@link fetchFrontier}; defaults to {@link fetchReconcileFrontier}. */
  fetchReconcile: (surveySlugs: readonly string[], limit: number) => Promise<ReconcileFrontier>;
  now: () => number;
}

function defaultSurveyDeps(workspaceId: string): SurveyDeps {
  return {
    loadRegistry: loadHarnessRegistry,
    // Pass the survey's known workspaceId so resolvePlanScope short-circuits on it
    // instead of throwing for a harness not (yet) in harness_shared.projects — the
    // WI-148 survey-starvation: an unregistered harness made the plan-read throw,
    // emptying the Mug's frontier so she placed nothing. The survey already scopes
    // to this workspace's harnesses, so its workspaceId IS the correct plan scope
    // (the error's sanctioned "or pass an explicit workspaceId" path).
    listPlanRows: (harnessSlug) => listPlanIndexRowsCached({ harnessSlug, workspaceId }),
    fetchFrontier: (surveySlugs, limit) => {
      const { sql } = getOrgPg();
      return fetchFrontierRows(sql, workspaceId, surveySlugs, limit);
    },
    fetchEscalatedIssues: (surveySlugs, limit) => {
      const { sql } = getOrgPg();
      return fetchEscalatedIssueFrontierRows(sql, workspaceId, surveySlugs, limit);
    },
    fetchBlockGraph: (harness) => {
      const { sql } = getOrgPg();
      return fetchHarnessBlockGraph(sql, workspaceId, harness);
    },
    fetchQuarantinedCount: async (surveySlugs) => {
      // The silent-starvation count (EI-8498 / WI-4563). FAIL-OPEN: a legibility
      // signal must never blank or break the Mug's placement survey — worst case
      // we under-report the deadlock (→ 0), the pre-WI-4563 behaviour. A read-only
      // aggregate, safe to re-issue on a transient pooler blip (mirrors the plan read).
      try {
        const { sql } = getOrgPg();
        return await withPgRetry(() => countQuarantinedFrontier(sql, workspaceId, surveySlugs), {
          label: 'pot-survey.countQuarantinedFrontier',
        });
      } catch (err) {
        console.warn(
          '[pot-survey] quarantined-frontier count failed — reporting 0:',
          err instanceof Error ? err.message : err,
        );
        return 0;
      }
    },
    fetchReconcile: async (surveySlugs, limit) => {
      // EI-13695 legibility slice — FAIL-OPEN like the quarantined count: a broken
      // reconcile read must never blank the Mug's placement survey; worst case the
      // reconcile lane under-reports (→ empty) for one wake.
      try {
        const { sql } = getOrgPg();
        return await withPgRetry(() => fetchReconcileFrontier(sql, workspaceId, surveySlugs, limit), {
          label: 'pot-survey.fetchReconcileFrontier',
        });
      } catch (err) {
        console.warn(
          '[pot-survey] reconcile-frontier read failed — reporting none:',
          err instanceof Error ? err.message : err,
        );
        return { rows: [], total: 0 };
      }
    },
    now: () => Date.now(),
  };
}

/** Order-insensitive identity of a survey scope (`[]` = the workspace-wide fallback). */
function surveyScopeKey(surveySlugs: readonly string[]): string {
  return JSON.stringify([...surveySlugs].sort());
}

/** Share one in-flight/settled promise per key for the lifetime of the returned fn. */
function shareByKey<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  keyOf: (...args: A) => string,
): (...args: A) => Promise<R> {
  const shared = new Map<string, Promise<R>>();
  return (...args: A): Promise<R> => {
    const key = keyOf(...args);
    let pending = shared.get(key);
    if (!pending) {
      // Promise.resolve().then(...) turns a synchronous throw into a rejection every
      // sharer observes, instead of throwing only at the first caller.
      pending = Promise.resolve().then(() => fn(...args));
      shared.set(key, pending);
    }
    return pending;
  };
}

/**
 * WI-10002668: make every SCOPE-KEYED survey read shared across pots for one
 * {@link surveyWorkspace} call. The frontier, escalated-issue, quarantined-count
 * and reconcile reads depend only on `(surveySlugs, limit)`, and the block graph
 * only on the harness, so pots resolving to the SAME scope asked PG the same
 * question N times. On the dev tower 20 of 29 pots fall back to the workspace-wide
 * scope (`surveySlugs: []`), so each call ran 20 identical workspace-wide scans
 * of each query (pg_stat_statements: 510k calls at a 1.3s / 0.46s mean, the #2
 * and #5 DB consumers). Sharing collapses that to one read per distinct scope.
 * Results are only read downstream (spread/mapped, never mutated), so sharing
 * the rows between pot sections is safe. A rejection is shared too, so each
 * pot's existing fail-open handling still applies exactly as before.
 */
export function shareScopedSurveyReads(deps: SurveyDeps): SurveyDeps {
  return {
    ...deps,
    fetchFrontier: shareByKey(deps.fetchFrontier, (slugs, limit) => `${surveyScopeKey(slugs)}|${limit}`),
    fetchEscalatedIssues: shareByKey(deps.fetchEscalatedIssues, (slugs, limit) => `${surveyScopeKey(slugs)}|${limit}`),
    fetchQuarantinedCount: shareByKey(deps.fetchQuarantinedCount, (slugs) => surveyScopeKey(slugs)),
    fetchReconcile: shareByKey(deps.fetchReconcile, (slugs, limit) => `${surveyScopeKey(slugs)}|${limit}`),
    fetchBlockGraph: shareByKey(deps.fetchBlockGraph, (harness) => harness),
  };
}

/**
 * Survey a Pot's member harnesses and return BOTH ranked views (P-010 + the
 * P-012 fix). The plan-survey harness set mirrors the frontier scope: the
 * member slugs when wired, else every registered project (workspace-wide).
 */
export async function surveyPot(
  workspaceId: string,
  potHomeSlug: string,
  opts: {
    frontierLimit?: number;
    scopeFilter?: ScopeFilter;
    deps?: Partial<SurveyDeps>;
    /** Extra harness slugs to UNION into a members-wired survey scope — the
     *  workspace Mug passes the STARTED-pot set here (owner model 2026-07-01:
     *  "the Mug works ANY started pot"). Without this, a home pot with
     *  members wired narrowed the survey to home+members and every OTHER
     *  started pot's work was invisible to her (the stop-list only SUBTRACTS
     *  stopped hives; nothing added started ones back). A workspace-wide
     *  fallback scope (`surveySlugs: []`) already sees everything, so the
     *  union only applies when membership is wired. */
    extraSurveySlugs?: string[];
  } = {},
): Promise<PotSurvey> {
  const deps: SurveyDeps = { ...defaultSurveyDeps(workspaceId), ...opts.deps };
  const now = deps.now();
  const sf = opts.scopeFilter; // scope/pause filter (C-2) — used by both the plan loop + the frontier filter
  const membership = await resolvePotMembership(workspaceId, potHomeSlug, deps.loadRegistry);
  const surveySlugs =
    membership.surveySlugs.length > 0 && (opts.extraSurveySlugs?.length ?? 0) > 0
      ? Array.from(new Set([...membership.surveySlugs, ...opts.extraSurveySlugs!]))
      : membership.surveySlugs;

  // Which harnesses to read plans from: the survey slugs, or pot HOME slugs
  // when membership isn't wired. The frontier fallback is workspace-wide, but
  // plans are Pot-scoped; ordinary project slugs make resolvePlanScope reject
  // and caused a live Mug wake to spend its floor gather on hundreds of
  // repeated "not a Pot home" warnings. So the plan side falls back only to
  // real kind:'hive' homes (plus this home for legacy registries), while the
  // frontier keeps the workspace-wide blind-spot guard.
  let planSlugs: string[];
  if (surveySlugs.length > 0) {
    planSlugs = surveySlugs;
  } else {
    const reg = await deps.loadRegistry(workspaceId);
    planSlugs = Array.from(
      new Set([potHomeSlug, ...reg.projects.filter((p) => p.harness_kind === 'hive').map((p) => p.slug)]),
    );
  }

  const [planRowsPerHarness, featureFrontierRows, escalatedIssueRows, frontierQuarantined, reconcile] = await Promise.all([
    mapWithConcurrency(
      planSlugs,
      POT_SURVEY_PLAN_READ_CONCURRENCY,
      async (slug) => {
        try {
          // Bounded retry on a transient CONNECT_TIMEOUT (WI-2776): a read-only plan
          // list, safe to re-issue. Absorbs the self-healing pooler blip that made a
          // live Mug wake skip a member's plan; a sustained outage still logs below.
          return await withPgRetry(() => deps.listPlanRows(slug), { label: 'pot-survey.listPlanRows' });
        } catch (err) {
          console.warn(
            `[pot-survey] plan read failed for '${slug}' — skipped:`,
            err instanceof Error ? err.message : err,
          );
          return [] as PlanIndexRow[];
        }
      },
    ),
    deps.fetchFrontier(surveySlugs, opts.frontierLimit ?? 50),
    // EI-12275: the escalated-issue slice (severity critical/major bug/change/task),
    // otherwise invisible to the feature-only fetchFrontier above. Fail-open — a
    // flaky read here must not blank the (much larger, higher-traffic) feature
    // frontier alongside it.
    deps
      .fetchEscalatedIssues(surveySlugs, 10)
      .catch((err) => {
        console.warn(
          '[pot-survey] escalated-issue frontier read failed — reporting none:',
          err instanceof Error ? err.message : err,
        );
        return [] as FrontierRow[];
      }),
    // The admission-withheld count, scoped identically to the frontier fetch (the
    // same surveySlugs) so `frontier: []` is diagnosable as deadlock-vs-idle
    // (EI-8498 / WI-4563). Fail-open in the default dep → never blanks the survey.
    deps.fetchQuarantinedCount(surveySlugs),
    // The reconcile slice (EI-13695) — what the fresh frontier now excludes.
    // Fail-open in the default dep → never blanks the survey.
    deps.fetchReconcile(surveySlugs, 10),
  ]);
  // One combined row set flows through readiness/scope filtering below (EI-12275)
  // so an escalated issue is excluded by the same blocked_by/pause/eligible-plan
  // rules a feature frontier row would be — no separate code path to drift.
  const frontierRows = [...featureFrontierRows, ...escalatedIssueRows];

  const planCandidates: PlacementCandidate[] = [];
  // EI-18669294545467516: planSlugs is a set of SURVEY slugs, not distinct
  // harnesses — a member slug commonly resolves (via resolvePlanScope's
  // "member harness resolves to its hive's home" behavior) to the SAME
  // underlying plan rows as another slug in the same union. Without a dedup
  // key here, an N-member pot reports every plan N times (counts.plans and
  // the candidate list both inflate), handing the Mug's placement decider a
  // wrong world model. Dedup on (harnessSlug, planSlug) — the plan's real
  // identity — so a genuinely distinct cross-harness plan sharing a bare
  // slug is never collapsed, only true repeats from the per-slug re-read.
  const seenPlanKeys = new Set<string>();
  for (const rows of planRowsPerHarness) {
    for (const row of rows) {
      const planKey = `${row.harnessSlug}::${row.planSlug}`;
      if (seenPlanKeys.has(planKey)) continue;
      seenPlanKeys.add(planKey);
      // mug-autonomy-and-selffeed C-1 (P-B1): an owner-EXPLICITLY-eligible plan is
      // surfaced even when unstarted (flagged needsStart) so the Mug can start +
      // decompose it. Only for plans in a non-empty eligiblePlans list — an un-steered
      // survey is unchanged (started plans only). The later inEligiblePlans filter then
      // keeps the eligible set; a started-but-not-eligible plan still gets filtered out.
      const includeUnstarted = (sf?.eligiblePlans?.length ?? 0) > 0 && !!sf?.eligiblePlans?.includes(row.planSlug);
      const c = planToCandidate(row, now, { includeUnstarted });
      if (c) planCandidates.push(c);
    }
  }

  // Honor blocked_by (W-01/P-010): resolve each surveyed harness's blocking graph
  // and drop frontier lanes whose blockers aren't satisfied — the SAME readiness
  // the orchestrator dispatches by. Per-harness because feature ids aren't global.
  // Also check plan-item blocking (EI-12372): exclude work-items whose linked
  // plan-item has unresolved blockers.
  const frontierHarnesses = [...new Set(frontierRows.map((r) => r.harness_slug))];
  const graphByHarness = new Map<string, HarnessBlockGraph>();
  await Promise.all(
    frontierHarnesses.map(async (h) => {
      try {
        graphByHarness.set(h, await deps.fetchBlockGraph(h));
      } catch (err) {
        // Fail-open: a flaky blocker read must not blank the frontier — treat as
        // unblocked (an empty graph) so placement still proceeds, but say so.
        console.warn(
          `[pot-survey] block-graph read failed for '${h}' — lanes treated unblocked:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
  // Build plan-item blocking graph from the plan rows (EI-12372).
  const planItemGraph = buildPlanItemBlockGraph(planRowsPerHarness);
  const { ready: readyFrontierRowsAll, blockedCount } = filterReadyFrontier(
    frontierRows,
    graphByHarness,
    planItemGraph,
  );
  if (blockedCount > 0) {
    console.log(
      `[pot-survey] frontier: ${blockedCount} lane(s) held back by unsatisfied blocked_by; ${readyFrontierRowsAll.length} ready`,
    );
  }
  // mug-steering-panel C-2 + P-008 — scope/pause/plan enforcement (applied AFTER
  // the readiness filter so it never resurrects a blocked lane): a PAUSE empties the
  // frontier so the Mug places no NEW work (and instead drives existing placements
  // to terminal, then idles); `allowedHarnesses` restricts the harness scope; and the
  // P-008 plan HARD-filter drops any frontier row minted from a plan that is NOT in
  // the owner's `eligiblePlans` (unplanned rows pass — they are not plan-gated). So
  // "work on these plans only" is structurally binding at the frontier, not advisory.
  // Started-plan momentum is intentionally NOT paused — pause gates only new work.
  const paused = isNewWorkPaused(sf, now);
  const readyFrontierRows = paused
    ? []
    : readyFrontierRowsAll.filter(
        (r) =>
          inAllowedHarness(r.harness_slug, sf) &&
          notStopped(r.harness_slug, sf) &&
          frontierInEligiblePlans(r.plan_slug, sf),
      );
  if (paused) {
    console.log(
      `[pot-survey] new-work PAUSED (scopeFilter) — frontier emptied (${readyFrontierRowsAll.length} ready item(s) withheld); Mug drives existing placements to terminal.`,
    );
  }
  const frontierCandidates = readyFrontierRows.map((r) => frontierRowToCandidate(r, now));

  const [plans, frontier] = await Promise.all([
    rankPlacements(
      planCandidates.filter(
        (c) => inAllowedHarness(c.harness, sf) && notStopped(c.harness, sf) && inEligiblePlans(c.id, sf),
      ),
    ),
    rankPlacements(frontierCandidates),
  ]);

  return {
    home: membership.home,
    members: membership.members,
    scope: membership.scope,
    plans,
    frontier,
    frontierBlocked: blockedCount,
    frontierQuarantined,
    frontierReconcile: reconcile.total,
    reconcileRows: reconcile.rows,
  };
}

// ── Cross-pot workspace survey (P-003 / D-002 — the central dispatcher) ───────

/**
 * The workspace-wide survey the ONE central-dispatcher Mug reads when
 * FLAGS.WORKSPACE_COORDINATION is ON (workspace-scoped-coordination-2026-06-20
 * P-003 / D-002): every pot in the workspace, surveyed individually so ideation
 * stays focused (`perPot` — the per-pot sections, mitigating the D-004
 * cross-domain-dilution risk), PLUS one cross-pot ranked backlog
 * (`crossPot`) merged from all hives and re-ranked by the SAME placement
 * registry so the Mug prioritizes across hives and dispatches by cross-pot
 * priority. Every candidate carries its `hive` tag (the source/target-pot
 * routing of P-001) so the placement path lands work on the right pot's cups.
 */
export interface WorkspaceSurvey {
  /** Per-pot sections — one {@link PotSurvey} per pot, tagged by home slug. */
  perPot: Array<{ pot: string; survey: PotSurvey }>;
  /** The cross-pot ranked backlog (all hives merged + re-ranked, pot-tagged). */
  crossPot: {
    plans: Ranked<PlacementCandidate>[];
    frontier: Ranked<PlacementCandidate>[];
    frontierBlocked: number;
    /** Admission-withheld frontier summed across every surveyed pot (EI-8498 /
     *  WI-4563) — so the cross-pot view is deadlock-vs-idle legible too. */
    frontierQuarantined: number;
    /** Reconcile frontier summed across every surveyed pot (EI-13695) — attempted
     *  items whose dead cup's checkpoint survives; excluded from `frontier`. The
     *  per-pot rows (with checkpoint heads) live on each perPot survey. */
    frontierReconcile: number;
  };
  /** The pot home slugs surveyed (registry order). */
  hives: string[];
}

type SurveyScope = PotSurvey['scope'];

function crossPotCandidateKey(c: PlacementCandidate): string {
  return `${c.view}:${c.harness}:${c.id}`;
}

function addCrossPotCandidate(
  acc: Map<string, { candidate: PlacementCandidate; scope: SurveyScope }>,
  candidate: PlacementCandidate,
  scope: SurveyScope,
) {
  const key = crossPotCandidateKey(candidate);
  const existing = acc.get(key);
  if (!existing || (existing.scope === 'workspace' && scope === 'members')) {
    acc.set(key, { candidate, scope });
  }
}

/**
 * Survey the WHOLE workspace for the central-dispatcher Mug (P-003). Resolves
 * every pot (registry `kind:'hive'` projects), surveys each individually (the
 * focused per-pot sections), then merges + RE-RANKS the combined candidate sets
 * into one cross-pot backlog so cross-pot priority is a single ordering. Each
 * candidate carries its `hive` tag so {@link surveyPot}'s `harness` field +
 * this tag together route a placement onto the right pot's cups.
 *
 * Falls back to surveying the supplied home pot alone when no pot resolves (a
 * never-registered box stays sane). The caller decides whether to call this
 * (WORKSPACE_COORDINATION ON) or {@link surveyPot} (OFF, byte-identical to today).
 */
export async function surveyWorkspace(
  workspaceId: string,
  opts: {
    frontierLimit?: number;
    scopeFilter?: ScopeFilter;
    deps?: Partial<SurveyDeps>;
    /** Resolve the workspace's pot home slugs. Default: the registry's
     *  `kind:'hive'` projects (injectable so this unit-tests without PG). */
    listPotSlugs?: (ws: string) => Promise<string[]>;
    /** Fallback home when no pot resolves (the per-pot survey seat). */
    fallbackHome?: string;
  } = {},
): Promise<WorkspaceSurvey> {
  const listPotSlugs =
    opts.listPotSlugs ??
    (async (ws: string): Promise<string[]> => {
      const { listPots } = await import('../agent-tools/pot/_resolve');
      return (await listPots(ws)).map((h) => h.slug);
    });

  let potSlugs = await listPotSlugs(workspaceId).catch(() => [] as string[]);
  if (potSlugs.length === 0 && opts.fallbackHome) potSlugs = [opts.fallbackHome];
  // De-dup + stable order (registry order); a workspace==pot shape is one entry.
  potSlugs = Array.from(new Set(potSlugs));

  // WI-10002668: one shared read per distinct survey scope (not per pot), and a
  // bounded pot fan-out that stays inside the org pool width.
  const deps = shareScopedSurveyReads({ ...defaultSurveyDeps(workspaceId), ...opts.deps });
  const perPot = await mapWithConcurrency(potSlugs, WORKSPACE_SURVEY_POT_CONCURRENCY, async (pot) => ({
    pot,
    survey: await surveyPot(workspaceId, pot, {
      frontierLimit: opts.frontierLimit,
      scopeFilter: opts.scopeFilter,
      deps,
    }),
  }));

  // Merge every pot's candidates (each tagged with its source/target pot — the
  // P-001 routing tag) and re-rank through the ONE placement registry, so the
  // cross-pot priority is a SINGLE ordering, never a per-pot sort concatenated.
  // The ranker is pot-agnostic and re-derives the rank from the candidate fields,
  // so re-ranking the union is correct; the `hive` tag rides through as metadata
  // the placement path routes on.
  const planCandidates = new Map<string, { candidate: PlacementCandidate; scope: SurveyScope }>();
  const frontierCandidates = new Map<string, { candidate: PlacementCandidate; scope: SurveyScope }>();
  let frontierBlocked = 0;
  let frontierQuarantined = 0;
  let frontierReconcile = 0;
  for (const { pot, survey } of perPot) {
    for (const c of survey.plans) addCrossPotCandidate(planCandidates, { ...c, pot }, survey.scope);
    for (const c of survey.frontier) addCrossPotCandidate(frontierCandidates, { ...c, pot }, survey.scope);
    frontierBlocked += survey.frontierBlocked;
    frontierQuarantined += survey.frontierQuarantined;
    frontierReconcile += survey.frontierReconcile;
  }
  const [plans, frontier] = await Promise.all([
    rankPlacements([...planCandidates.values()].map((v) => v.candidate)),
    rankPlacements([...frontierCandidates.values()].map((v) => v.candidate)),
  ]);

  return {
    perPot,
    crossPot: { plans, frontier, frontierBlocked, frontierQuarantined, frontierReconcile },
    hives: potSlugs,
  };
}
