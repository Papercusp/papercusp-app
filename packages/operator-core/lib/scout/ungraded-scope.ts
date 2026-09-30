/**
 * ungraded-scope.ts — THE ONE definition of "ungraded" for the Blender/Scout rail
 * (blender-su-grade-integration-2026-08-11 P-010).
 *
 * WHY THIS MODULE EXISTS. Three surfaces counted "ungraded routed ideas" and
 * published three different numbers for the same workspace on the same day:
 *
 *   - `ungraded-filings-watchdog` / `watchdog:status` →   15   (agreeing with each other)
 *   - `system-health` scout.grading.ungraded          → 1,103
 *   - plan D-074, reported as "su filings past a day" → 1,082
 *
 * None of them was a bug in the counting. Every one was arithmetically right about a
 * DIFFERENT POPULATION, because "ungraded" leaves three axes implicit and each caller
 * silently chose its own. Measured on the live table 2026-08-11:
 * `origin='scout'` holds 1,146 rows (1,088 ungraded) while `origin='su-ideate'` holds
 * 184 rows EVER (15 ungraded) — so D-074's "1,082 su filings" was the SCOUT population
 * wearing the su label, off by ~70x. It made the su grading backlog look like an
 * emergency while the actionable backlog was fifteen.
 *
 * THE THREE AXES a count must fix before the word "ungraded" means anything:
 *
 *   1. ORIGIN      — who filed it. `su-ideate` (an su's own ideation pass) and `scout`
 *                    (the ideator rail's corpus) have different producers, different
 *                    graders and different deadlines. Summing them answers no question.
 *   2. TERMINALITY — is the routed artifact still open? A filing whose artifact already
 *                    landed or was dropped (`outcome` set and not 'pending') cannot be
 *                    usefully graded; counting it inflates a backlog nobody can drain.
 *   3. EPOCH FLOOR — grading is FORWARD-ONLY, and the floor is PER-ORIGIN (D-014).
 *                    Rows routed before their origin's floor are deliberately excluded,
 *                    not forgotten. A count that omits the floor silently re-imports the
 *                    whole pre-epoch corpus — and a count that applies ONE origin's floor
 *                    to every origin draws the line in a place nobody chose for the
 *                    others. That second failure shipped: until D-014 this module took a
 *                    single `epochMs` and system-health passed the su-ideate floor for
 *                    scout too, which excluded 8 of 1,088 scout rows (0.7%) and left a
 *                    592-row "actionable" backlog produced by an unchosen boundary.
 *
 * THE RULE: a single scalar named `ungraded` is banned on any surface a human reads.
 * Return `UngradedBreakdown` instead — it cannot be rendered without saying which
 * population it describes, which is the only thing that actually prevents the drift.
 * The recurrence guard in `ungraded-scope.test.ts` fails the build if a new raw
 * `human_grade IS NULL` predicate appears outside this module.
 */

import type { Sql } from 'postgres';

import { SHADOW_VARIANT_ORIGIN } from './shadow-variant-origin';
// Both PG-free on purpose — this module is otherwise `type { Sql }` and one constant,
// and `pot-membership` (the usual home of these) would drag `@papercusp/db-org` in.
import {
  enumerableWorkspaceGlobalLabels,
  WORKSPACE_GLOBAL_LABEL_PREFIX,
} from '../workspace-global-labels';
import { canonicalPotSlug, PLATFORM_POT_SLUG } from '../platform-pot-slug';

/**
 * The producers that file into `harness_shared.scout_routed_ideas`.
 *
 * `'shadow-variant'` is deliberately ABSENT and excluded from the census SQL
 * below (counterfactual-critique-lab D-001). It is not a producer whose filings
 * anyone should be nudged to grade: the shadow trial grades its own variants
 * under blinded conditions as part of the trial, and the ungraded-filings
 * watchdog nudging them would be exactly the automatic recurrence D-001
 * forbids. Note the policy's `fallbackMs` rule — a new origin is INCLUDED by
 * default, over-counting rather than silently vanishing — is what makes this
 * explicit exclusion necessary rather than redundant.
 */
export type UngradedOrigin = 'su-ideate' | 'scout' | 'drill';

/**
 * D-013 su-ideate enablement floor: only rows routed after the ungraded-filings
 * watchdog shipped are ever nudged — the 85-row pre-P-006 corpus belongs to the
 * outcome-backfill sweep, never to triage nudges.
 *
 * OWNED HERE, not by the watchdog that introduced it: this module is the one place
 * that answers "which floor applies to which origin", and a floor defined next to its
 * first consumer is how the single-epoch bug below happened in the first place.
 * `ungraded-filings-watchdog.ts` re-exports this name for its own row selection.
 */
export const SU_IDEATE_UNGRADED_EPOCH_MS = Date.parse('2026-07-11T00:00:00Z');

/**
 * D-014 scout floor [owner 2026-08-11, interactive] — forward-only from the day the
 * ruling landed.
 *
 * WHY A SECOND CONSTANT INSTEAD OF REUSING THE SU-IDEATE ONE. Until D-014 this module
 * took a SINGLE `epochMs` and `system-health/compute.ts` passed the su-ideate floor for
 * EVERY origin. That is not a conservative default — it is a line drawn in a place
 * chosen for a different producer's corpus. Measured on the live table 2026-08-12: of
 * 1,088 ungraded scout rows only EIGHT predate the su-ideate floor, so it excluded 0.7%
 * and left 592 "actionable" — a backlog nobody had decided to own, produced by a
 * boundary nobody had chosen for scout.
 *
 * The owner's rationale for putting scout's line at today: grading is a TEACHING signal
 * back to the producer, and a grade on a weeks-old idea teaches nothing because the
 * context that produced it is gone — full token cost, near-zero learning. The historical
 * corpus is not dropped; it settles through outcome-backfill, and the ~30-row sample
 * taken before the cut confirmed 84% of it had already become open work-items that stand
 * on their own merits (WI-38083).
 */
export const SCOUT_UNGRADED_EPOCH_MS = Date.parse('2026-08-12T00:00:00Z');

/**
 * Which forward-only floor applies to which producer. A census is only interpretable
 * alongside the policy it was taken against, so `UngradedBreakdown` carries this too.
 */
export interface UngradedEpochPolicy {
  /** Per-origin floors. An origin absent here falls back to `fallbackMs`. */
  byOrigin: Readonly<Record<string, number>>;
  /** The floor for any origin not named above — including origins added later. */
  fallbackMs: number;
}

/**
 * The shipped policy. A new producer inherits `fallbackMs` (the oldest, most inclusive
 * floor) rather than silently disappearing behind a floor chosen for someone else —
 * over-counting a new origin is recoverable, silently excluding it is not.
 */
export const DEFAULT_UNGRADED_EPOCH_POLICY: UngradedEpochPolicy = {
  byOrigin: {
    'su-ideate': SU_IDEATE_UNGRADED_EPOCH_MS,
    scout: SCOUT_UNGRADED_EPOCH_MS,
  },
  fallbackMs: SU_IDEATE_UNGRADED_EPOCH_MS,
};

/** PURE: the floor this row's producer is judged against. */
export function epochMsForOrigin(policy: UngradedEpochPolicy, origin: string): number {
  const floor = policy.byOrigin[origin];
  return typeof floor === 'number' && Number.isFinite(floor) ? floor : policy.fallbackMs;
}

/** One routed-idea row, reduced to the fields the scope decision needs. */
export interface UngradedRowLike {
  origin: string;
  /** null ⇒ ungraded. */
  humanGrade: number | string | null;
  /** null or 'pending' ⇒ the routed artifact is still open. */
  outcome: string | null;
  routedAtMs: number;
}

/**
 * Which population a row belongs to. `actionable` is the only bucket a grading
 * backstop may act on; the other three name a REASON for exclusion rather than
 * disappearing, so a caller can always account for the difference between its
 * number and the raw table count.
 */
export type UngradedBucket = 'graded' | 'actionable' | 'terminal' | 'pre-epoch';

/**
 * PURE: bucket one row. This function IS the definition — `readUngradedBreakdown`'s
 * SQL mirrors it, and the guard test pins the two together.
 *
 * Order matters and is deliberate: a graded row is never counted anywhere else, and a
 * pre-epoch row is excluded even when its artifact is still open (the floor is a policy
 * boundary, not a staleness heuristic).
 *
 * D-014: the row's ORIGIN selects which floor it is judged against. Origin still does
 * not create a bucket of its own — every row lands in exactly one of the four, and the
 * `allUngraded === actionable + preEpoch + terminal` accounting below still holds — but
 * two rows with the same timestamp CAN now bucket differently when their producers have
 * different floors. That is the intended effect, not a leak of the origin axis into
 * eligibility: each producer is judged against the line chosen for it.
 */
export function classifyUngraded(
  row: UngradedRowLike,
  opts: { policy: UngradedEpochPolicy },
): UngradedBucket {
  if (row.humanGrade !== null && row.humanGrade !== undefined) return 'graded';
  const epochMs = epochMsForOrigin(opts.policy, row.origin);
  if (!Number.isFinite(row.routedAtMs) || row.routedAtMs < epochMs) return 'pre-epoch';
  if (row.outcome !== null && row.outcome !== 'pending') return 'terminal';
  return 'actionable';
}

/**
 * A labelled census. Every field names its own population, so no caller can emit a
 * bare "ungraded" number without choosing what it means.
 */
export interface UngradedBreakdown {
  /** Per-origin actionable counts — ungraded, artifact open, at/after the epoch floor.
   *  THIS is the drainable grading backlog, and the only number a backstop may act on. */
  actionableByOrigin: Record<string, number>;
  /** Total actionable across every origin. */
  actionable: number;
  /** EVERY ungraded row: any origin, any outcome, any age. The number that looked like
   *  a crisis. Kept so the difference from `actionable` is always visible — never render
   *  it without its label. */
  allUngraded: number;
  /** Why the two differ. `allUngraded === actionable + preEpoch + terminal` always. */
  excluded: { preEpoch: number; terminal: number };
  /**
   * The floors this census was taken against, so a stored result stays interpretable.
   * Carries the whole POLICY rather than one number: with per-origin floors (D-014) a
   * single `epochMs` on a multi-origin census is not a summary, it is a wrong answer to
   * "which line was drawn here" for every origin but one.
   */
  policy: UngradedEpochPolicy;
}

interface BreakdownRow {
  origin: string;
  actionable: number | string | null;
  all_ungraded: number | string | null;
  pre_epoch: number | string | null;
  terminal: number | string | null;
}

const n = (v: number | string | null | undefined): number => Math.max(0, Number(v ?? 0));

/**
 * PURE: fold per-origin SQL rows into the breakdown. Split from the query so the
 * assembly is unit-testable with no PG.
 */
export function summarizeUngraded(
  rows: readonly BreakdownRow[],
  policy: UngradedEpochPolicy,
): UngradedBreakdown {
  const actionableByOrigin: Record<string, number> = {};
  let actionable = 0;
  let allUngraded = 0;
  let preEpoch = 0;
  let terminal = 0;
  for (const r of rows) {
    const a = n(r.actionable);
    if (a > 0 || r.origin) actionableByOrigin[r.origin] = a;
    actionable += a;
    allUngraded += n(r.all_ungraded);
    preEpoch += n(r.pre_epoch);
    terminal += n(r.terminal);
  }
  return { actionableByOrigin, actionable, allUngraded, excluded: { preEpoch, terminal }, policy };
}

/**
 * Read the labelled census for a workspace (optionally one harness slug).
 *
 * The FILTER clauses below MIRROR `classifyUngraded` bucket-for-bucket; keep them in
 * step. Fail-soft is the CALLER's choice here, not this function's: a health surface
 * that swallows the error must render "unavailable", never a zero — a zeroed backlog
 * is indistinguishable from a drained one, which is the failure this whole module is
 * about.
 */
export async function readUngradedBreakdown(
  sql: Sql,
  args: { workspaceId: string; harnessSlug?: string; policy: UngradedEpochPolicy },
): Promise<UngradedBreakdown> {
  const { workspaceId, harnessSlug, policy } = args;
  // D-014: each row is judged against ITS OWN producer's floor. Resolving `epoch_ms`
  // once per row in the CTE — rather than repeating a CASE in all four FILTERs — is
  // what keeps this mirroring `epochMsForOrigin` instead of drifting from it, and the
  // jsonb lookup means a policy gaining an origin needs no SQL change at all.
  const floors = JSON.stringify(policy.byOrigin);
  const fallback = policy.fallbackMs;
  const rows = harnessSlug
    ? await sql<BreakdownRow[]>`
        WITH scoped AS (
          SELECT origin, human_grade, outcome, routed_at,
                 coalesce((${floors}::jsonb ->> origin)::bigint, ${fallback}::bigint) AS epoch_ms
            FROM harness_shared.scout_routed_ideas
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
             AND origin <> ${SHADOW_VARIANT_ORIGIN}
        )
        SELECT origin,
               count(*) FILTER (WHERE human_grade IS NULL AND routed_at >= epoch_ms
                                  AND (outcome IS NULL OR outcome = 'pending'))::int AS actionable,
               count(*) FILTER (WHERE human_grade IS NULL)::int AS all_ungraded,
               count(*) FILTER (WHERE human_grade IS NULL AND routed_at < epoch_ms)::int AS pre_epoch,
               count(*) FILTER (WHERE human_grade IS NULL AND routed_at >= epoch_ms
                                  AND outcome IS NOT NULL AND outcome <> 'pending')::int AS terminal
          FROM scoped
         GROUP BY origin`
    : await sql<BreakdownRow[]>`
        WITH scoped AS (
          SELECT origin, human_grade, outcome, routed_at,
                 coalesce((${floors}::jsonb ->> origin)::bigint, ${fallback}::bigint) AS epoch_ms
            FROM harness_shared.scout_routed_ideas
           WHERE workspace_id = ${workspaceId}
             AND origin <> ${SHADOW_VARIANT_ORIGIN}
        )
        SELECT origin,
               count(*) FILTER (WHERE human_grade IS NULL AND routed_at >= epoch_ms
                                  AND (outcome IS NULL OR outcome = 'pending'))::int AS actionable,
               count(*) FILTER (WHERE human_grade IS NULL)::int AS all_ungraded,
               count(*) FILTER (WHERE human_grade IS NULL AND routed_at < epoch_ms)::int AS pre_epoch,
               count(*) FILTER (WHERE human_grade IS NULL AND routed_at >= epoch_ms
                                  AND outcome IS NOT NULL AND outcome <> 'pending')::int AS terminal
          FROM scoped
         GROUP BY origin`;
  return summarizeUngraded(rows, policy);
}

// ── the ROW-selection counterpart of the census (P-001) ──────────────────────

/**
 * One actionable ungraded filing, reduced to the fields a nudge needs.
 *
 * `origin` is carried on the ROW, not fixed by the caller. That is the whole point:
 * a consumer that already knows which origin it asked for cannot report which origin
 * it is nudging about, and cannot pick up a producer nobody has heard of yet.
 */
export interface UngradedFilingRow {
  ideaId: string;
  origin: string;
  title: string | null;
  /** Change-feed ref of the routed artifact — the blender:grade-idea handle. */
  routedRef: string;
  routedAtMs: number;
}

/**
 * Read the ACTIONABLE ungraded filings for one scope, every origin at once.
 *
 * WHY THIS LIVES HERE AND NOT IN THE CONSUMER (P-001). `readUngradedBreakdown` above
 * made every surface AGREE on how many ungraded filings exist. It did not make them
 * agree on WHICH ROWS those are — so `ungraded-filings-watchdog.ts`, the one rail that
 * MAKES grading happen, kept its own `origin = 'su-ideate'` SELECT and acted on a
 * fourth, narrower population than the census it was meant to drain. Measured
 * 2026-09-02 (EI-22180311569503146): that rail covered 22 of 1,675 actionable rows,
 * and `agent-review` — 1,397 actionable, 27 arrivals in 24h, the largest and most
 * active producer — had no consumer at all.
 *
 * So the selection is defined HERE, beside the classification it must mirror, and the
 * rail borrows it. The three axes are resolved exactly as `classifyUngraded` resolves
 * them (per-origin floor via the policy jsonb, terminality, `shadow-variant` excluded),
 * and no origin is named anywhere in this query. A producer that starts filing
 * tomorrow is swept tomorrow, inheriting `fallbackMs` — which is what the policy's
 * "a new origin is INCLUDED by default" has always promised, now true of the RAIL and
 * not only of the count.
 *
 * `limitPerOrigin` bounds the read PER PRODUCER rather than overall: a single origin's
 * backlog (agent-review's 1,397) must not be able to starve every other origin out of
 * the result the way one global `ORDER BY routed_at LIMIT n` would.
 */
/**
 * The FOURTH axis (EI-23811029152367526): does this harness scope absorb rows filed
 * under a workspace-global label?
 *
 * `harness_slug` is a legitimate partition — measured 2026-09-20, this workspace's
 * ledger carries seven REAL harnesses (papercusp, sb-devboard-hive, sidestage,
 * portal, email, oddsmith, …) and the live producers key it correctly. What it ALSO
 * carries is the workspace-brain grain: 1,615 `scout` rows under `@singleton` and the
 * bare workspace id, split at the `WORKSPACE_COORDINATION` cutover that "flipped the
 * writer's install_slug from @singleton to the workspaceId" (success-metrics.ts).
 * Neither value names a registered Blender scope, so `listBlenderMaintenanceScopes`
 * never hands them to the sweep and no harness-scoped caller can ask for them.
 *
 * So do NOT normalize the column — that would merge seven tenants. Resolve the label
 * the way the rest of the system already ratified it: `learning/pot-scope` step 3, "a
 * WORKSPACE-GLOBAL label homes to the workspace PLATFORM pot", mirroring
 * `resolveWorkItemPot`. The platform harness absorbs them; `sidestage` and `portal`
 * must not, or one pot's grader inherits another's workspace-brain backlog.
 *
 * A workspace with no platform pot absorbs nothing and falls through — the same
 * fail-open `pot-scope` chose, never inventing an owner.
 */
export function harnessScopeAbsorbsWorkspaceGlobal(harnessSlug: string): boolean {
  return canonicalPotSlug(harnessSlug.trim()) === PLATFORM_POT_SLUG;
}

function workspaceGlobalScopeFor(
  workspaceId: string,
  harnessSlug: string,
): { absorbsWorkspaceGlobal: boolean; labels: string[]; likePattern: string } {
  return {
    absorbsWorkspaceGlobal: harnessScopeAbsorbsWorkspaceGlobal(harnessSlug),
    labels: enumerableWorkspaceGlobalLabels(workspaceId),
    // The `operator:<ws>` family cannot be enumerated; matching it by prefix is what
    // keeps this predicate equal to `isWorkspaceGlobalLabel` rather than a subset.
    likePattern: `${WORKSPACE_GLOBAL_LABEL_PREFIX}%`,
  };
}

export async function readActionableUngradedFilings(
  sql: Sql,
  args: {
    workspaceId: string;
    harnessSlug: string;
    policy: UngradedEpochPolicy;
    limitPerOrigin?: number;
  },
): Promise<UngradedFilingRow[]> {
  const { workspaceId, harnessSlug, policy } = args;
  const limitPerOrigin = Math.max(1, Math.floor(args.limitPerOrigin ?? 50));
  const floors = JSON.stringify(policy.byOrigin);
  const fallback = policy.fallbackMs;
  const scope = workspaceGlobalScopeFor(workspaceId, harnessSlug);
  const rows = await sql<
    { idea_id: string; origin: string; title: string | null; routed_ref: string; routed_at: string | number | null }[]
  >`
    WITH scoped AS (
      SELECT idea_id, origin, title, routed_ref, routed_at,
             coalesce((${floors}::jsonb ->> origin)::bigint, ${fallback}::bigint) AS epoch_ms
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${workspaceId}
         AND (
              harness_slug = ${harnessSlug}
           OR (${scope.absorbsWorkspaceGlobal}
               AND (harness_slug = ANY(${scope.labels}) OR harness_slug LIKE ${scope.likePattern}))
         )
         AND origin <> ${SHADOW_VARIANT_ORIGIN}
         AND human_grade IS NULL
         AND (outcome IS NULL OR outcome = 'pending')
    ), ranked AS (
      SELECT idea_id, origin, title, routed_ref, routed_at,
             row_number() OVER (PARTITION BY origin ORDER BY routed_at ASC) AS rn
        FROM scoped
       WHERE routed_at >= epoch_ms
    )
    SELECT idea_id, origin, title, routed_ref, routed_at
      FROM ranked
     WHERE rn <= ${limitPerOrigin}
     ORDER BY origin ASC, routed_at ASC`;
  return rows.map((r) => ({
    ideaId: r.idea_id,
    origin: r.origin,
    title: r.title,
    routedRef: r.routed_ref,
    routedAtMs: Number(r.routed_at ?? 0),
  }));
}

/**
 * Count actionable ungraded filings across a WORKSPACE that are already older than
 * `staleBeforeMs` — the nudge rail's coverage probe for "eligible backlog exists, but
 * no registered scope was evaluated". Workspace-wide on purpose: it exists precisely
 * for the case where the harness-scoped read found nothing to look at.
 */
export async function countActionableUngradedOlderThan(
  sql: Sql,
  args: { workspaceId: string; policy: UngradedEpochPolicy; staleBeforeMs: number },
): Promise<number> {
  const { workspaceId, policy, staleBeforeMs } = args;
  const floors = JSON.stringify(policy.byOrigin);
  const fallback = policy.fallbackMs;
  const rows = await sql<{ c: number | string | null }[]>`
    WITH scoped AS (
      SELECT origin, routed_at,
             coalesce((${floors}::jsonb ->> origin)::bigint, ${fallback}::bigint) AS epoch_ms
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${workspaceId}
         AND origin <> ${SHADOW_VARIANT_ORIGIN}
         AND human_grade IS NULL
         AND (outcome IS NULL OR outcome = 'pending')
    )
    SELECT count(*)::int AS c
      FROM scoped
     WHERE routed_at >= epoch_ms AND routed_at <= ${staleBeforeMs}`;
  return Math.max(0, Number(rows[0]?.c ?? 0));
}

/**
 * Count actionable stale filings that NO registered scope can reach (WI-10002098).
 *
 * The sibling probe above answers "is there eligible backlog at all?" and the sweep
 * gated it on `scopes.length === 0` — so it could only ever catch TOTAL blindness. The
 * failure that actually happened was PARTIAL: grading ran normally and current for every
 * registered partition while 249 `scout` rows under the workspace-global grain sat
 * unreachable for a month (EI-23811029152367526). `scopes.length` was never 0, so nothing
 * fired. A coverage check that only fires at ZERO coverage is a liveness check.
 *
 * Two properties make this safe to run on EVERY tick, which is the point — a coverage
 * alarm that cries wolf on a healthy workspace is one that gets deleted:
 *
 *  1. It is the SAME population as `readActionableUngradedFilings`, minus the rows that
 *     function's own scope predicate would reach — derived by calling the very same
 *     `workspaceGlobalScopeFor` helper rather than restating its rules. So "covered"
 *     cannot drift from what the sweep actually reads; a fully-covered workspace returns
 *     exactly 0 by construction, not by tuning.
 *  2. It counts in SQL and is UNCAPPED. Deriving coverage by counting rows returned from
 *     `readActionableUngradedFilings` would compare against a `limitPerOrigin` FLOOR, so
 *     any scope holding more than the cap would manufacture phantom uncovered backlog on
 *     a perfectly healthy tick.
 *
 * With `harnessSlugs: []` nothing is reachable, so this degenerates exactly to
 * `countActionableUngradedOlderThan` — the zero-scope case stays consistent by
 * construction instead of by a second hand-maintained branch.
 */
export async function countActionableUngradedOutsideScopes(
  sql: Sql,
  args: {
    workspaceId: string;
    harnessSlugs: string[];
    policy: UngradedEpochPolicy;
    staleBeforeMs: number;
  },
): Promise<number> {
  const { workspaceId, harnessSlugs, policy, staleBeforeMs } = args;
  const floors = JSON.stringify(policy.byOrigin);
  const fallback = policy.fallbackMs;
  const reach = JSON.stringify(
    harnessSlugs.map((slug) => {
      const scope = workspaceGlobalScopeFor(workspaceId, slug);
      return {
        slug,
        absorbs: scope.absorbsWorkspaceGlobal,
        labels: scope.labels,
        like_pattern: scope.likePattern,
      };
    }),
  );
  const rows = await sql<{ c: number | string | null }[]>`
    WITH reach AS (
      SELECT slug, absorbs, labels, like_pattern
        FROM jsonb_to_recordset(${reach}::jsonb)
          AS s(slug text, absorbs boolean, labels jsonb, like_pattern text)
    ), scoped AS (
      SELECT harness_slug, origin, routed_at,
             coalesce((${floors}::jsonb ->> origin)::bigint, ${fallback}::bigint) AS epoch_ms
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${workspaceId}
         AND origin <> ${SHADOW_VARIANT_ORIGIN}
         AND human_grade IS NULL
         AND (outcome IS NULL OR outcome = 'pending')
    )
    SELECT count(*)::int AS c
      FROM scoped r
     WHERE r.routed_at >= r.epoch_ms
       AND r.routed_at <= ${staleBeforeMs}
       AND NOT EXISTS (
         SELECT 1
           FROM reach s
          WHERE r.harness_slug = s.slug
             OR (s.absorbs
                 AND (r.harness_slug IN (SELECT jsonb_array_elements_text(s.labels))
                      OR r.harness_slug LIKE s.like_pattern))
       )`;
  return Math.max(0, Number(rows[0]?.c ?? 0));
}

/** What `watchdog:status` reports about the nudge rail's pending/eligible backlog. */
export interface UngradedEligibility {
  byOrigin: Record<string, { pendingCount: number; eligibleCount: number; oldestRoutedAtMs: number | null }>;
}

/**
 * Read the rail's eligibility for ONE scope, every origin at once.
 *
 * Split out of `watchdog/status.ts` (P-001) for the same reason as the row selection
 * above: a status surface that scoped itself to `origin = 'su-ideate'` reported 22
 * pending while the rail it describes now nudges every producer — a readout that
 * disagrees with the thing it is reading out is the drift this module exists to end.
 */
export async function readUngradedEligibility(
  sql: Sql,
  args: {
    workspaceId: string;
    harnessSlug: string;
    policy: UngradedEpochPolicy;
    eligibleBeforeMs: number;
  },
): Promise<UngradedEligibility> {
  const { workspaceId, harnessSlug, policy, eligibleBeforeMs } = args;
  const floors = JSON.stringify(policy.byOrigin);
  const fallback = policy.fallbackMs;
  const scope = workspaceGlobalScopeFor(workspaceId, harnessSlug);
  const rows = await sql<
    { origin: string; pending_count: number | string | null; eligible_count: number | string | null; oldest_routed_at: string | number | null }[]
  >`
    WITH scoped AS (
      SELECT origin, routed_at,
             coalesce((${floors}::jsonb ->> origin)::bigint, ${fallback}::bigint) AS epoch_ms
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${workspaceId}
         AND (
              harness_slug = ${harnessSlug}
           OR (${scope.absorbsWorkspaceGlobal}
               AND (harness_slug = ANY(${scope.labels}) OR harness_slug LIKE ${scope.likePattern}))
         )
         AND origin <> ${SHADOW_VARIANT_ORIGIN}
         AND human_grade IS NULL
         AND (outcome IS NULL OR outcome = 'pending')
    ), actionable AS (
      SELECT origin, routed_at FROM scoped WHERE routed_at >= epoch_ms
    )
    SELECT origin, count(*)::int AS pending_count,
           count(*) FILTER (WHERE routed_at <= ${eligibleBeforeMs})::int AS eligible_count,
           min(routed_at) AS oldest_routed_at
      FROM actionable
     GROUP BY origin`;
  const byOrigin: UngradedEligibility['byOrigin'] = {};
  for (const row of rows) {
    const oldest = Number(row.oldest_routed_at ?? Number.NaN);
    byOrigin[row.origin] = {
      pendingCount: Math.max(0, Number(row.pending_count ?? 0)),
      eligibleCount: Math.max(0, Number(row.eligible_count ?? 0)),
      oldestRoutedAtMs: Number.isFinite(oldest) ? oldest : null,
    };
  }
  return { byOrigin };
}

/** PURE: split a mixed-origin filing list into one bucket per origin, insertion-ordered. */
export function groupFilingsByOrigin<T extends { origin: string }>(rows: readonly T[]): Map<string, T[]> {
  const byOrigin = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = byOrigin.get(row.origin);
    if (bucket) bucket.push(row);
    else byOrigin.set(row.origin, [row]);
  }
  return byOrigin;
}
