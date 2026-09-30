/**
 * The goal ↔ pot edge: which pots (harnesses) a goal is pursued through, and
 * what a goal has cost.
 *
 * Sits beside `goal-lineage.ts` rather than in `operator-core/lib` because both
 * sides of the platform need it and only one of them can import the other:
 * `packages/agent-mcp` (which owns the goals:* write tools) does NOT depend on
 * operator-core, while both reach `@papercusp/db-org`.
 *
 * ── The invariant this module exists to protect ─────────────────────────────
 * A pot can serve MORE THAN ONE goal (goal-mode-2026-08-07 D-021). "Build the
 * payments library" is genuinely part of *ship a paid app* AND of *cut checkout
 * abandonment* — forcing a pot to pick one parent would make the link useless
 * for exactly the pots that matter most. The consequence is counter-intuitive
 * and it is a trap:
 *
 *     GOAL METERS DO NOT SUM.
 *
 * A shared pot's spend counts IN FULL against every goal it serves, because
 * from each goal's point of view that is what pursuing it costs. So
 * `goalSpend(A) + goalSpend(B)` DOUBLE-COUNTS anything A and B share, and is
 * never the portfolio total. `portfolioSpend` exists precisely so nobody has to
 * remember that: it sums over DISTINCT pots. The recurrence guard for this
 * lives in `goal-pots.test.ts` — two goals sharing one pot must total that
 * pot's cost exactly once.
 *
 * ── One MAIN OWNER per pot ─────────────────────────────────────────────────
 * Every link carries a role. `owner` is the goal a pot primarily belongs to;
 * `contributing` is a real but secondary claim. That is enforced by a PARTIAL
 * UNIQUE INDEX (`goal_pots_one_owner_per_pot`), not by convention here — so
 * `setMainOwner` demotes the incumbent in the same statement rather than
 * racing it.
 *
 * ── Unlink is a tombstone, never a DELETE ──────────────────────────────────
 * `removed_at` is set instead. "This pot used to belong to that goal" is
 * exactly the kind of history the owner asks about when a goal's spend looks
 * wrong, and a DELETE destroys it. Every live-set query therefore carries
 * `WHERE removed_at IS NULL`, and the uniqueness indexes are partial on the
 * same predicate so a re-link after a removal is legal.
 */

import type { Sql } from 'postgres';

export type GoalPotRole = 'owner' | 'contributing';

export interface GoalPotLink {
  id: string;
  goalId: string;
  harnessSlug: string;
  role: GoalPotRole;
  addedAt: string;
  addedBy: string | null;
  note: string | null;
  /** Per-link, because a shared pot can warrant different criteria per goal. */
  killCriterion: string | null;
}

export interface GoalPotScope {
  workspaceId: string;
  goalId: string;
  harnessSlug: string;
}

/** One pot's contribution to a goal's spend. */
export interface PotSpend {
  harnessSlug: string;
  costUsd: number;
  samples: number;
}

/** Provenance marker for the only spend snapshot goals:update may persist. */
export const GOAL_SPEND_SNAPSHOT_SOURCE = 'goal-pots-rollup' as const;

/** Provenance marker for the PLATFORM spend-rollup tick's snapshot
 *  (goal-mode-design-intent-hardening-2026-08-16 P-005 / D-003).
 *
 *  ⚠ CURRENTLY WRITTEN BY NOTHING. Readers still accept it (sync-resolver/goals.ts),
 *  but no code path persists it: measured 2026-09-05, the only writers of
 *  `spentCentsSource` are operator-core lib/goals/spend-rollup.ts and goals:update,
 *  and BOTH write GOAL_SPEND_SNAPSHOT_SOURCE.
 *
 *  ⚠ AND ITS ORIGINAL RATIONALE NO LONGER HOLDS — do not restore it. This comment
 *  used to say the tick's value is "a SUPERSET of the pots rollup (it adds the goal
 *  subject/descendant SESSION leg)". It is not: `writeGoalSpendSnapshot` persists
 *  `spentCents: rollup.potCents` — the POT leg alone — and keeps the session leg in
 *  the separately-labelled diagnostic breakdown, which is exactly why writing it
 *  under the pots marker does NOT break goals:update's exact-match verification.
 *
 *  That stale sentence mattered: `goals.metadata.spentCents` is the number the
 *  budget ceiling refuses launches on, and a reader who came here to learn what it
 *  measures was told it included spend it does not include — the misreading
 *  spend-attribution…-2026-09-04 exists to eliminate, sitting in the field's own
 *  documentation. Corrected under that plan's P-004. */
export const GOAL_SPEND_TICK_SOURCE = 'goal-spend-tick' as const;

export interface GoalSpend {
  goalId: string;
  /** Sum over this goal's linked pots. NOT additive across goals. */
  costUsd: number;
  byPot: PotSpend[];
  /** Number of usage samples included in the rollup. */
  samples: number;
  /** Samples with a provider/estimated cost value. */
  pricedSamples: number;
  /** Samples present in the rollup but lacking a cost value. */
  unpricedSamples: number;
  /** True only when the rollup has at least one sample and every sample is priced. */
  measured: boolean;
}

interface RawLink {
  id: string;
  goal_id: string;
  harness_slug: string;
  role: string;
  added_at: string | Date;
  added_by: string | null;
  note: string | null;
  kill_criterion: string | null;
}

function toLink(r: RawLink): GoalPotLink {
  return {
    id: String(r.id),
    goalId: r.goal_id,
    harnessSlug: r.harness_slug,
    role: r.role === 'owner' ? 'owner' : 'contributing',
    addedAt: r.added_at instanceof Date ? r.added_at.toISOString() : String(r.added_at),
    addedBy: r.added_by,
    note: r.note,
    killCriterion: r.kill_criterion,
  };
}

/**
 * Attach a pot to a goal, or refresh an existing live link.
 *
 * Idempotent on the live pair: re-linking an already-linked pot updates its
 * role/note instead of erroring, because the calling agent is usually asserting
 * a desired state ("this pot serves this goal") rather than performing a
 * one-shot transition.
 *
 * Linking as `owner` DEMOTES whatever goal currently owns the pot — the partial
 * unique index would otherwise reject the write, and failing here would leave
 * the caller with no way to express a legitimate hand-over.
 */
export async function linkPot(
  sql: Sql,
  opts: GoalPotScope & {
    role?: GoalPotRole;
    by?: string | null;
    note?: string | null;
    /** What would make THIS goal stop pursuing THIS pot (clause 4). */
    killCriterion?: string | null;
  },
): Promise<GoalPotLink> {
  const role: GoalPotRole = opts.role ?? 'contributing';
  if (role === 'owner') {
    await demoteIncumbentOwner(sql, opts);
  }
  const rows = await sql<RawLink[]>`
    INSERT INTO harness_shared.goal_pots
      (workspace_id, goal_id, harness_slug, role, added_by, note, kill_criterion)
    VALUES
      (${opts.workspaceId}, ${opts.goalId}, ${opts.harnessSlug}, ${role},
       ${opts.by ?? null}, ${opts.note ?? null}, ${opts.killCriterion ?? null})
    ON CONFLICT (workspace_id, goal_id, harness_slug) WHERE removed_at IS NULL
    DO UPDATE SET role = EXCLUDED.role,
                  -- COALESCE, so re-attaching to change a role does not erase the
                  -- criterion or the note recorded when the pot was adopted.
                  note = COALESCE(EXCLUDED.note, harness_shared.goal_pots.note),
                  kill_criterion = COALESCE(EXCLUDED.kill_criterion,
                                            harness_shared.goal_pots.kill_criterion)
    RETURNING id, goal_id, harness_slug, role, added_at, added_by, note, kill_criterion
  `;
  return toLink(rows[0]!);
}

/**
 * Clear the `owner` role from whichever goal currently holds it for this pot —
 * demoting to `contributing` rather than unlinking, because the old owner's
 * involvement is real and losing it would silently drop the pot off that goal's
 * page.
 */
async function demoteIncumbentOwner(
  sql: Sql,
  opts: { workspaceId: string; goalId: string; harnessSlug: string },
): Promise<void> {
  await sql`
    UPDATE harness_shared.goal_pots
       SET role = 'contributing'
     WHERE workspace_id = ${opts.workspaceId}
       AND harness_slug = ${opts.harnessSlug}
       AND goal_id <> ${opts.goalId}
       AND role = 'owner'
       AND removed_at IS NULL
  `;
}

/** Promote an existing (or new) link to be the pot's one main owner. */
export async function setMainOwner(
  sql: Sql,
  opts: GoalPotScope & { by?: string | null },
): Promise<GoalPotLink> {
  return linkPot(sql, { ...opts, role: 'owner' });
}

/**
 * Tombstone the link. Returns false when there was no live link to remove, so
 * a caller can tell "unlinked" from "was never linked" instead of reporting a
 * no-op as success.
 */
export async function unlinkPot(
  sql: Sql,
  opts: GoalPotScope & { by?: string | null },
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.goal_pots
       SET removed_at = now(), removed_by = ${opts.by ?? null}
     WHERE workspace_id = ${opts.workspaceId}
       AND goal_id = ${opts.goalId}
       AND harness_slug = ${opts.harnessSlug}
       AND removed_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/** The goal's live pots, main owner first. */
export async function potsForGoal(
  sql: Sql,
  opts: { workspaceId: string; goalId: string },
): Promise<GoalPotLink[]> {
  const rows = await sql<RawLink[]>`
    SELECT id, goal_id, harness_slug, role, added_at, added_by, note, kill_criterion
      FROM harness_shared.goal_pots
     WHERE workspace_id = ${opts.workspaceId}
       AND goal_id = ${opts.goalId}
       AND removed_at IS NULL
     ORDER BY (role = 'owner') DESC, added_at ASC
  `;
  return rows.map(toLink);
}

/**
 * The goals a pot serves. This is the read behind the "shared with N goals"
 * badge — the one signal that stops a shared pot's spend from looking like a
 * double charge when the owner sees it on two pages.
 */
export async function goalsForPot(
  sql: Sql,
  opts: { workspaceId: string; harnessSlug: string },
): Promise<GoalPotLink[]> {
  const rows = await sql<RawLink[]>`
    SELECT id, goal_id, harness_slug, role, added_at, added_by, note, kill_criterion
      FROM harness_shared.goal_pots
     WHERE workspace_id = ${opts.workspaceId}
       AND harness_slug = ${opts.harnessSlug}
       AND removed_at IS NULL
     ORDER BY (role = 'owner') DESC, added_at ASC
  `;
  return rows.map(toLink);
}

/**
 * What this goal has cost: `agent_usage_samples.cost_usd` summed over its
 * linked pots.
 *
 * ⚠ CALL IT FLEET SPEND, NOT "TOTAL GOAL COST". Measured over 7 days, the
 * spawned roles (cup/mug/kettle/release-fixer/content-fixer) are ~100%
 * harness-attributed, but `role='interactive'` — the goal agent's OWN turns —
 * measures ≈$0 because those are subscription-billed rather than metered. So
 * this number is what the goal's spawned CHILDREN cost, which is the number
 * that actually moves and the one a ceiling should govern; it is not a total
 * cost of ownership.
 */
export async function goalSpend(
  sql: Sql,
  opts: { workspaceId: string; goalId: string; sinceMs?: number },
): Promise<GoalSpend> {
  const since = opts.sinceMs ?? 0;
  const rows = await sql<
    Array<{
      harness_slug: string;
      cost: string | null;
      samples: string;
      priced_samples: string;
      unpriced_samples: string;
    }>
  >`
    SELECT s.harness_slug,
           COALESCE(SUM(s.cost_usd), 0) AS cost,
           COUNT(*)                     AS samples,
           COUNT(*) FILTER (WHERE s.cost_usd IS NOT NULL) AS priced_samples,
           COUNT(*) FILTER (WHERE s.cost_usd IS NULL) AS unpriced_samples
      FROM harness_shared.agent_usage_samples s
      JOIN harness_shared.goal_pots gp
        ON gp.harness_slug = s.harness_slug
       AND gp.workspace_id = s.workspace_id
       AND gp.removed_at IS NULL
      JOIN harness_shared.goals g
        ON g.id = gp.goal_id
       AND g.workspace_id = gp.workspace_id
     WHERE s.workspace_id = ${opts.workspaceId}
       AND gp.goal_id = ${opts.goalId}
       -- A pot can predate both the goal and the link that made it part of the
       -- goal. Charging either slice of historical spend makes a fresh ceiling
       -- look blown the instant the pot is attached. Goal creation and per-pot
       -- link time are therefore hard lower bounds; an explicit sinceMs may
       -- narrow the window further but can never reach behind either boundary.
       -- Usage timestamps have integer-millisecond precision, so FLOOR the
       -- timestamptz values instead of letting PostgreSQL round a fractional
       -- millisecond into the future and exclude a sample at the exact edge.
       AND s.ts >= GREATEST(
         ${since}::bigint,
         FLOOR(EXTRACT(EPOCH FROM g.created_at) * 1000)::bigint,
         FLOOR(EXTRACT(EPOCH FROM gp.added_at) * 1000)::bigint
       )
     GROUP BY s.harness_slug
     ORDER BY cost DESC
  `;
  const byPot: PotSpend[] = rows.map((r) => ({
    harnessSlug: r.harness_slug,
    costUsd: Number(r.cost ?? 0),
    samples: Number(r.samples),
  }));
  const samples = rows.reduce((sum, r) => sum + Number(r.samples), 0);
  const pricedSamples = rows.reduce((sum, r) => sum + Number(r.priced_samples), 0);
  const unpricedSamples = rows.reduce((sum, r) => sum + Number(r.unpriced_samples), 0);
  return {
    goalId: opts.goalId,
    costUsd: byPot.reduce((acc, p) => acc + p.costUsd, 0),
    byPot,
    samples,
    pricedSamples,
    unpricedSamples,
    measured: samples > 0 && unpricedSamples === 0,
  };
}

/**
 * Spend across SEVERAL goals, counting each pot once.
 *
 * This is NOT `goalSpend` summed. A pot serving two of the goals would be
 * charged twice by that sum, inflating the portfolio total by exactly the
 * shared work — the overlap being largest precisely where goals are most
 * related, i.e. where the owner is most likely to be looking. The DISTINCT is
 * the whole point of the function.
 *
 * Pass no `goalIds` to total every goal in the workspace.
 */
export async function portfolioSpend(
  sql: Sql,
  opts: { workspaceId: string; goalIds?: string[]; sinceMs?: number },
): Promise<{ costUsd: number; pots: number; byPot: PotSpend[] }> {
  const since = opts.sinceMs ?? 0;
  const goalIds = opts.goalIds ?? null;
  const rows = await sql<Array<{ harness_slug: string; cost: string | null; samples: string }>>`
    WITH linked AS (
      -- DISTINCT is load-bearing: without it a pot linked to two of the named
      -- goals joins the usage rows twice and its cost is counted twice.
      SELECT DISTINCT harness_slug
        FROM harness_shared.goal_pots
       WHERE workspace_id = ${opts.workspaceId}
         AND removed_at IS NULL
         AND (${goalIds}::text[] IS NULL OR goal_id = ANY(${goalIds}::text[]))
    )
    SELECT s.harness_slug,
           COALESCE(SUM(s.cost_usd), 0) AS cost,
           COUNT(*)                     AS samples
      FROM harness_shared.agent_usage_samples s
      JOIN linked l ON l.harness_slug = s.harness_slug
     WHERE s.workspace_id = ${opts.workspaceId}
       AND s.ts >= ${since}
     GROUP BY s.harness_slug
     ORDER BY cost DESC
  `;
  const byPot: PotSpend[] = rows.map((r) => ({
    harnessSlug: r.harness_slug,
    costUsd: Number(r.cost ?? 0),
    samples: Number(r.samples),
  }));
  return {
    costUsd: byPot.reduce((acc, p) => acc + p.costUsd, 0),
    pots: byPot.length,
    byPot,
  };
}
