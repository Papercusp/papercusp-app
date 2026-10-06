/**
 * Goal spend rollup — the durable tick that makes goals.metadata.spentCents TRUE
 * (goal-mode-design-intent-hardening-2026-08-16 P-005, D-003).
 *
 * D-003 (binding): "Spend truth comes from the platform cost ledger rolled up by
 * goal_id; agents never hand-write spentCents." Before this tick the snapshot only
 * existed when an agent called goals:update { spentCents } with a value exactly
 * matching the goals:pots rollup — measured: 3 of 17 goals ever carried one, and
 * the graded GOAL-mode subject had to self-instrument via loop costCapCents and
 * hand-track ~4300→4500c. This module writes the snapshot PLATFORM-SIDE, on a
 * recurring tick, for every ACTIVE goal — no agent in the loop.
 *
 * ── The authority boundary (work-on-everything-stewardship-remediation P-003, D-011) ─
 *  LINEAGE leg — `lineageSpendForGoal`: samples whose `goal_id` was STAMPED AT
 *     INSERT, over the goal's budget window (its lifetime when none is
 *     declared). This is the ONLY authoritative source for metadata.spentCents,
 *     spend tripwires, the launch gate and breach enforcement — one figure for
 *     all four, so the number shown, the number gated on and the number that
 *     pauses the goal cannot disagree. Null, never 0, when it is not a complete
 *     measurement (no attributed samples, or any unpriced one).
 *
 * Before D-011 the POT leg held that authority. It was wrong twice over: an
 * INNER JOIN on goal_pots made a pot-less goal whose fleets really spend
 * unmeasurable forever (so its launches were refused), and the snapshot was a
 * LIFETIME figure judged against a weekly budget. It stays below as a diagnostic.
 *
 * Diagnostic legs (never control anything):
 *  1. POT leg — `goalSpend()` (@papercusp/db-org): agent_usage_samples summed by
 *     harness_slug over the goal's live goal_pots. NOT additive across goals (a
 *     shared pot bills in full to each — D-021).
 *  2. SESSION leg — the goal SUBJECT's interactive session and inherited
 *     descendants whose samples carry a harness OUTSIDE the goal's pots.
 *
 * Pot + session partition the ledger without double-counting (samples whose
 * harness_slug IS a pot harness are excluded from the session leg); the lineage
 * leg cross-cuts both. All three ride in spentCentsBreakdown, labelled.
 *
 * Mechanism precedent: the goal watchdog family (goal-liveness-watchdog.ts,
 * goal-drain-fleet-watchdog.ts) — a process-level managedSetInterval sweep
 * started from dbos/bootstrap.ts, deliberately NOT a DBOS workflow (EI-1622
 * workflow_status bloat), flag-gated per tick (FLAGS.GOAL_SPEND_ROLLUP_TICK,
 * default ON). Missing a tick costs nothing: the next tick recomputes from the
 * ledger — the write is idempotent state, not an event.
 */
import type { JSONValue, Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { goalSpend, GOAL_SPEND_SNAPSHOT_SOURCE, type GoalSpend } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { GOAL_MODE } from '../modes/goal-session';
import { getGoalTransitionExecutor } from '@papercusp/agent-mcp';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';
import {
  isInteractiveUsageUnmeasuredReason,
  readInteractiveUsageFreshness,
  type InteractiveUsageFreshness,
  type InteractiveUsageUnmeasuredReason,
} from '../interactive-usage/freshness';
import { appendGoalWriteAudit } from './write-audit';
import {
  breachedTripwires,
  populationForMetric,
  refreshTripwireCurrents,
  type GoalTripwireLike,
} from './tripwire-refresh';

export const GOAL_SPEND_ROLLUP_INTERVAL_MS = 5 * 60_000;

/**
 * Self-describing scope labels for the PERSISTED breakdown.
 *
 * Every caveat about these two numbers used to live only in this module's
 * comments, while the jsonb an operator actually reads showed `potCents` and
 * `sessionCents` bare and side by side, with nothing on the values saying they
 * measure DISJOINT populations. Read cold, that shape says "two meters for one
 * quantity", and the ~2x gap between them then reads as a defect rather than as
 * the partition it is.
 *
 * That is not hypothetical: EI-21970344408288271 was filed as a major bug
 * concluding the spend tripwire "is not a trustworthy circuit breaker — it is a
 * coin flip between two instruments." The natural repair from that reading is to
 * switch enforcement to the larger meter — which is precisely what the authority
 * boundary above forbids, since the session leg is unpriced-tolerant and its
 * attribution is not a billing boundary. A misreading whose obvious fix is a
 * real regression is worth spending two fields to prevent.
 *
 * So the constraint rides ON the value. Pinned, not hand-maintained: the session
 * label is only true while the session query keeps its goal_pots exclusion, and
 * `spend-rollup-scope-labels.test.ts` fails if that clause is removed.
 */
export const GOAL_SPEND_POT_SCOPE = 'inside-goal-pots:diagnostic-only' as const;
export const GOAL_SPEND_SESSION_SCOPE = 'outside-goal-pots:diagnostic-only' as const;

/**
 * The THIRD scope (spend-attribution…-2026-09-04 P-004, D-006).
 *
 * The two labels above partition the ledger by WHERE a sample was billed. This
 * one cuts the other way: it names the samples whose attribution was STAMPED AT
 * WRITE TIME (`agent_usage_samples.goal_id`, fed by goal_id_for_usage_session at
 * INSERT) rather than INFERRED afterwards by joining adv_sessions. Same cents,
 * different epistemic standing — and that distinction is the one this plan
 * proved we cannot read off a bare number.
 *
 * ⚠ IT IS NOT A THIRD DISJOINT PARTITION, and must never be rendered as one.
 * P-004's wording ("a THIRD scope alongside") invites that reading; the code
 * does not support it. `sessionSpendForGoal`'s predicate already begins
 * `s.goal_id = <goal> OR (...)`, so every write-time-attributed sample that is
 * not billed to a goal pot is ALREADY inside `sessionCents`.
 *
 * The overlap with the POT leg is CONTINGENT, which is why it is MEASURED every
 * tick (`lineageInsidePotCents`) instead of asserted here. Read that field for
 * the live figure; do not restate one in this comment.
 *
 * History, because it is the cautionary case: this block used to assert that
 * every lineage row carried harness_slug NULL, hence lineage ⊆ session and
 * lineage ∩ pot = ∅. That was measured on 2026-09-05, hours before WI-2144763
 * began stamping attribution at INSERT — a sharp writer cutover (last NULL-slug
 * lineage row 01:48:18Z, first non-NULL 01:52:37Z). Since the cutover, lineage
 * rows DO match goal pots and the intersection is non-empty and still growing,
 * so the sentence was false the same day it was written. It was caught only
 * because the shipped code measures the overlap rather than hardcoding zero —
 * exactly the drift the derived-truth ladder exists to prevent (WI-2145059).
 *
 * So it is never added into any total. Since D-011 it is also the AUTHORITATIVE
 * leg: the one stamped at write time is the one that cannot be wrong about its
 * own provenance, and it sees every fleet a goal runs, pot or no pot.
 */
export const GOAL_SPEND_LINEAGE_SCOPE = 'attributed-by-lineage:authoritative' as const;

/**
 * How the three scopes relate, as DATA rather than prose, so a consumer can
 * reject an unsafe sum without reading this module. Shipped beside the cents in
 * `spentCentsBreakdown`.
 */
export const GOAL_SPEND_SCOPE_RELATIONS = {
  authoritative: GOAL_SPEND_LINEAGE_SCOPE,
  additive: [GOAL_SPEND_POT_SCOPE, GOAL_SPEND_SESSION_SCOPE],
  overlapping: [GOAL_SPEND_LINEAGE_SCOPE],
  note: 'lineage is the authoritative spentCents; pot+session partition the ledger and sum to diagnosticTotalCents; lineage cross-cuts them and must never be added to either.',
} as const;

/** Why `spentCents` is null. Only `unpriced-lineage-samples` means spend exists. */
export type GoalSpendUnmeasuredReason =
  | 'no-lineage-samples'
  | 'unpriced-lineage-samples'
  | InteractiveUsageUnmeasuredReason;

/** The SESSION leg's contribution — samples the pot leg cannot see. */
export interface GoalSessionSpend {
  costUsd: number;
  samples: number;
  pricedSamples: number;
  unpricedSamples: number;
  /** Distinct native session ids that contributed samples. */
  sessions: number;
}

/**
 * The LINEAGE leg — samples carrying write-time goal provenance. Cross-cuts the
 * other two legs (see {@link GOAL_SPEND_LINEAGE_SCOPE}); never summed with them.
 */
export interface GoalLineageSpend {
  costUsd: number;
  samples: number;
  pricedSamples: number;
  unpricedSamples: number;
  /** Distinct native session ids that contributed samples. */
  sessions: number;
  /**
   * The MEASURED intersection with the pot leg, in USD: lineage samples whose
   * harness_slug is one of the goal's live pots. Measured every tick, never
   * assumed — it was zero until WI-2144763 began stamping harness_slug at
   * INSERT (2026-09-05), and has been non-empty since. See
   * {@link GOAL_SPEND_LINEAGE_SCOPE}.
   */
  insidePotCostUsd: number;
}

export interface GoalSpendRollup {
  goalId: string;
  /**
   * AUTHORITATIVE (D-011): lineage cents over `windowSec`, written to
   * metadata.spentCents and judged by the launch gate, tripwires and breach
   * check. Null when it is not a complete measurement — see `unmeasuredReason`.
   */
  spentCents: number | null;
  /** Why `spentCents` is null; null when it is measured. */
  unmeasuredReason: GoalSpendUnmeasuredReason | null;
  /** Goal-scoped ingestion freshness for the usage rows behind this read. */
  interactiveUsageFreshness: InteractiveUsageFreshness;
  /** The budget window every leg was judged over; null ⇒ the goal's lifetime. */
  windowSec: number | null;
  /** POT leg + diagnostic SESSION leg, in integer cents. Never authoritative. */
  totalCents: number;
  /** Diagnostic goals:pots value. */
  potCents: number;
  /** Diagnostic-only interactive-session estimate. */
  sessionCents: number;
  /** Diagnostic union count (pot + session). */
  samples: number;
  /** Diagnostic union count (pot + session). */
  unpricedSamples: number;
  /** Whether the diagnostic union is fully priced. Not an authority signal. */
  measured: boolean;
  pot: GoalSpend;
  session: GoalSessionSpend;
  /**
   * Priced write-time-attributed spend — `spentCents` when complete, otherwise a
   * FLOOR. Deliberately NOT part of `totalCents`, `samples`, `unpricedSamples`
   * or `measured`: it overlaps the legs those aggregate, so including it would
   * double-count.
   */
  lineageCents: number;
  /** Measured lineage ∩ pot, in cents — measured every tick, never assumed zero; see GOAL_SPEND_LINEAGE_SCOPE. */
  lineageInsidePotCents: number;
  lineage: GoalLineageSpend;
}

/**
 * The SESSION leg: samples attributed to owners under the goal plus selected
 * consult answer sessions they opened, excluding samples already covered by
 * the pot leg's harness match.
 *
 * For legacy NULL rows, owner→goal membership deliberately reads the SAME two
 * tables as resolveGoalContext (modes/goal-context.ts) rather than any
 * agent-supplied list. Consult answer sessions are linked through the persisted
 * routing snapshot for consults requested by those owners, with the same
 * answer-session start bound as conversations:get. adv_sessions for goal owners
 * is NOT workspace-filtered on purpose: coord owner ids are globally unique
 * and a respawn chain can carry rows under more than one workspace label, while
 * the SAMPLE-side workspace_id filter still holds the tenancy line. The
 * goal-lifetime lower bound mirrors goalSpend(): a subject's spend from before
 * the goal existed never bills to it.
 */
export async function sessionSpendForGoal(
  sql: Sql,
  opts: { workspaceId: string; goalId: string; sinceMs?: number },
): Promise<GoalSessionSpend> {
  const since = opts.sinceMs ?? 0;
  const rows = await sql<
    Array<{
      cost: string | null;
      samples: string;
      priced_samples: string;
      unpriced_samples: string;
      sessions: string;
    }>
  >`
    WITH goal_owners AS (
      SELECT m.owner_id FROM harness_shared.agent_modes m
       WHERE m.workspace_id = ${opts.workspaceId}
         AND m.mode = ${GOAL_MODE}
         AND m.subject = ${opts.goalId}
      UNION
      SELECT b.owner_id FROM harness_shared.session_briefs b
       WHERE b.workspace_id = ${opts.workspaceId}
         AND b.goal_id = ${opts.goalId}
    ),
    -- P-014(a): the selected consult answer sessions, computed ONCE. This used
    -- to be a correlated EXISTS evaluated per usage sample, rescanning
    -- consult_state + jsonb_array_elements for each of ~126k samples
    -- (~24.7 s and ~48M buffers per call, every 5 min per active goal). The
    -- per-sample conditions (session match, s.ts >= answer start) moved to the
    -- probe below; MIN(started_ms) preserves "any qualifying answer session".
    -- Live equivalence across all 5 active goals 2026-10-01: identical cost,
    -- samples, priced/unpriced and session counts; 20–37 s → 0.4–0.8 s.
    consult_answer_sessions AS MATERIALIZED (
      SELECT answer_session.session_id,
             MIN((EXTRACT(EPOCH FROM answer_session.started_at) * 1000)::bigint) AS started_ms
        FROM harness_shared.consult_state cs
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(cs.routing #> '{selection,selected}') = 'array'
              THEN cs.routing #> '{selection,selected}'
            ELSE '[]'::jsonb
          END
        ) selected
        JOIN harness_shared.adv_sessions answer_session
          ON answer_session.workspace_id = cs.workspace_id
         AND answer_session.coord_owner_id = NULLIF(selected->>'answeringOwnerId', '')
         AND answer_session.session_id IS NOT NULL
         AND answer_session.started_at >= cs.created_at
       WHERE cs.workspace_id = ${opts.workspaceId}
         AND cs.requester_id IN (SELECT owner_id FROM goal_owners)
         AND NULLIF(selected->>'answeringOwnerId', '') IS NOT NULL
       GROUP BY answer_session.session_id
    )
    SELECT COALESCE(SUM(s.cost_usd), 0) AS cost,
           COUNT(*)                     AS samples,
           COUNT(*) FILTER (WHERE s.cost_usd IS NOT NULL) AS priced_samples,
           COUNT(*) FILTER (WHERE s.cost_usd IS NULL) AS unpriced_samples,
           COUNT(DISTINCT s.session_id) AS sessions
      FROM harness_shared.agent_usage_samples s
      JOIN harness_shared.goals g
        ON g.id = ${opts.goalId}
       AND g.workspace_id = ${opts.workspaceId}
     WHERE s.workspace_id = ${opts.workspaceId}
       AND (
         s.goal_id = ${opts.goalId}
         OR (
           s.goal_id IS NULL
           AND (
             s.session_id IN (
               SELECT a.session_id
                 FROM harness_shared.adv_sessions a
                WHERE a.session_id IS NOT NULL
                  AND a.coord_owner_id IN (SELECT owner_id FROM goal_owners)
             )
             OR EXISTS (
               SELECT 1
                 FROM consult_answer_sessions cas
                WHERE cas.session_id = s.session_id
                  AND s.ts >= cas.started_ms
             )
           )
         )
       )
       AND (s.harness_slug IS NULL OR s.harness_slug NOT IN (
         SELECT gp.harness_slug FROM harness_shared.goal_pots gp
          WHERE gp.workspace_id = ${opts.workspaceId}
            AND gp.goal_id = ${opts.goalId}
            AND gp.removed_at IS NULL))
       AND s.ts >= GREATEST(
         ${since}::bigint,
         (EXTRACT(EPOCH FROM g.created_at) * 1000)::bigint
       )
  `;
  const r = rows[0];
  return {
    costUsd: Number(r?.cost ?? 0),
    samples: Number(r?.samples ?? 0),
    pricedSamples: Number(r?.priced_samples ?? 0),
    unpricedSamples: Number(r?.unpriced_samples ?? 0),
    sessions: Number(r?.sessions ?? 0),
  };
}

/**
 * The LINEAGE leg: samples the ledger itself stamped with this goal at INSERT.
 *
 * Deliberately the SIMPLEST predicate in this module — `goal_id = <goal>` and
 * nothing else. That is the whole point: it measures what was recorded, not
 * what can be reconstructed, so it is the one leg that cannot be wrong about
 * its own provenance. It shares the goal-lifetime lower bound and the
 * workspace tenancy filter with the other legs so the three remain comparable.
 *
 * `insidePotCostUsd` measures the intersection with the pot leg in the same
 * pass, because a consumer holding three cent figures needs to know they are
 * not addable, and a comment cannot tell it that at read time.
 */
export async function lineageSpendForGoal(
  sql: Sql,
  opts: { workspaceId: string; goalId: string; sinceMs?: number },
): Promise<GoalLineageSpend> {
  const since = opts.sinceMs ?? 0;
  const rows = await sql<
    Array<{
      cost: string | null;
      samples: string;
      priced_samples: string;
      unpriced_samples: string;
      sessions: string;
      inside_pot_cost: string | null;
    }>
  >`
    SELECT COALESCE(SUM(s.cost_usd), 0) AS cost,
           COUNT(*)                     AS samples,
           COUNT(*) FILTER (WHERE s.cost_usd IS NOT NULL) AS priced_samples,
           COUNT(*) FILTER (WHERE s.cost_usd IS NULL) AS unpriced_samples,
           COUNT(DISTINCT s.session_id) AS sessions,
           COALESCE(SUM(s.cost_usd) FILTER (
             WHERE s.harness_slug IN (
               SELECT gp.harness_slug FROM harness_shared.goal_pots gp
                WHERE gp.workspace_id = ${opts.workspaceId}
                  AND gp.goal_id = ${opts.goalId}
                  AND gp.removed_at IS NULL)
           ), 0) AS inside_pot_cost
      FROM harness_shared.agent_usage_samples s
      JOIN harness_shared.goals g
        ON g.id = ${opts.goalId}
       AND g.workspace_id = ${opts.workspaceId}
     WHERE s.workspace_id = ${opts.workspaceId}
       AND s.goal_id = ${opts.goalId}
       AND s.ts >= GREATEST(
         ${since}::bigint,
         (EXTRACT(EPOCH FROM g.created_at) * 1000)::bigint
       )
  `;
  const r = rows[0];
  return {
    costUsd: Number(r?.cost ?? 0),
    samples: Number(r?.samples ?? 0),
    pricedSamples: Number(r?.priced_samples ?? 0),
    unpricedSamples: Number(r?.unpriced_samples ?? 0),
    sessions: Number(r?.sessions ?? 0),
    insidePotCostUsd: Number(r?.inside_pot_cost ?? 0),
  };
}

/**
 * Every leg over one window. The controlling number is `spentCents` (the
 * lineage leg); `totalCents` is intentionally non-authoritative.
 *
 * `windowSec` is the goal's budget window (goals.budget_window_sec). It becomes
 * a `sinceMs` lower bound on EVERY leg, and each leg clamps it up to the goal's
 * creation, so it can narrow the span but never reach back before the goal
 * existed. Null/omitted ⇒ the goal's lifetime. One window for the snapshot, the
 * gate and the breach check is the point of D-011: a lifetime snapshot judged
 * against a weekly budget is how a standing goal gets refused for spend it
 * made months ago.
 */
export async function computeGoalSpendRollup(
  sql: Sql,
  opts: {
    workspaceId: string;
    goalId: string;
    windowSec?: number | null;
    nowMs?: number;
    /** A goal-scoped read can be shared by this goal's snapshot and controls. */
    interactiveUsageFreshness?: InteractiveUsageFreshness;
  },
): Promise<GoalSpendRollup> {
  const windowSec = opts.windowSec ?? null;
  const legOpts = {
    workspaceId: opts.workspaceId,
    goalId: opts.goalId,
    ...(windowSec === null ? {} : { sinceMs: (opts.nowMs ?? Date.now()) - windowSec * 1000 }),
  };
  const [pot, session, lineage, interactiveUsageFreshness] = await Promise.all([
    goalSpend(sql, legOpts),
    sessionSpendForGoal(sql, legOpts),
    lineageSpendForGoal(sql, legOpts),
    opts.interactiveUsageFreshness
      ? Promise.resolve(opts.interactiveUsageFreshness)
      : readInteractiveUsageFreshness(sql, { workspaceId: opts.workspaceId, goalId: opts.goalId, nowMs: opts.nowMs }),
  ]);
  const potCents = Math.round(pot.costUsd * 100);
  const sessionCents = Math.round(session.costUsd * 100);
  const lineageCents = Math.round(lineage.costUsd * 100);
  // D-011 clause 3: unmeasured stays unmeasured. No attributed samples is not
  // a measured zero, and a window with an unpriced sample has only a floor.
  const freshnessReason: GoalSpendUnmeasuredReason | null =
    interactiveUsageFreshness.status === 'stale'
      ? 'interactive-usage-stale'
      : interactiveUsageFreshness.status === 'unavailable'
        ? 'interactive-usage-unavailable'
        : null;
  const unmeasuredReason: GoalSpendUnmeasuredReason | null = lineage.samples === 0
    ? 'no-lineage-samples'
    : freshnessReason ?? (lineage.unpricedSamples > 0 ? 'unpriced-lineage-samples' : null);
  // The pot/session partition is what aggregates. The lineage leg is EXCLUDED
  // from every aggregate below on purpose: it overlaps both (see
  // GOAL_SPEND_LINEAGE_SCOPE), so folding it in would double-count rather than
  // widen coverage — and a too-large `samples` would flip `measured`, which
  // gates tripwire advancement.
  const samples = pot.samples + session.samples;
  const unpricedSamples = pot.unpricedSamples + session.unpricedSamples;
  return {
    goalId: opts.goalId,
    spentCents: unmeasuredReason === null ? lineageCents : null,
    unmeasuredReason,
    interactiveUsageFreshness,
    windowSec,
    totalCents: potCents + sessionCents,
    potCents,
    sessionCents,
    samples,
    unpricedSamples,
    measured: samples > 0 && unpricedSamples === 0,
    pot,
    session,
    lineageCents,
    lineageInsidePotCents: Math.round(lineage.insidePotCostUsd * 100),
    lineage,
  };
}

/**
 * Persist the snapshot onto goals.metadata. Deliberately does NOT bump
 * updated_at: that column is the goal's DEFINITION-edit time (the sync board
 * reads it as such), and a background rollup is not an edit.
 */
export async function writeGoalSpendSnapshot(
  sql: Sql,
  opts: { workspaceId: string; goalId: string },
  rollup: GoalSpendRollup,
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  const patch = {
    // The ONE authoritative goal spend (D-011): lineage cents over the budget
    // window, or null with a named reason. Never 0 for "nothing measured": the
    // launch gate reads THIS field, and a bare 0 would admit every launch under
    // budget on a number nothing measured. The reason is what lets the gate tell
    // "nothing spent in the window" (admit, degraded) from "spent, but unpriced"
    // (refuse as unmeasurable).
    spentCents: rollup.spentCents,
    spentCentsSource: GOAL_SPEND_SNAPSHOT_SOURCE,
    spentCentsAt: nowIso,
    spentCentsWindowSec: rollup.windowSec,
    spentCentsUnmeasuredReason: rollup.unmeasuredReason,
    spentCentsFreshness: rollup.interactiveUsageFreshness,
    spentCentsBreakdown: {
      measured: rollup.spentCents !== null,
      lineageScope: GOAL_SPEND_LINEAGE_SCOPE,
      lineageCents: rollup.lineageCents,
      lineageSamples: rollup.lineage.samples,
      lineageUnpricedSamples: rollup.lineage.unpricedSamples,
      lineageSessionCount: rollup.lineage.sessions,
      // The measured intersection with the pot leg. Present even when 0 — a
      // zero a reader can SEE is what makes the non-additivity checkable
      // rather than a claim they have to trust.
      lineageInsidePotCents: rollup.lineageInsidePotCents,
      // How the three relate, as data. A consumer can reject an unsafe sum
      // without reading this module — which is the whole point of P-004.
      scopeRelations: GOAL_SPEND_SCOPE_RELATIONS,
      // Everything below is diagnostic-only and must never be read as the
      // authoritative spend snapshot or a terminal-control input. Pot and
      // session are disjoint partitions of the ledger, not rival meters.
      potCents: rollup.potCents,
      potSamples: rollup.pot.samples,
      potUnpricedSamples: rollup.pot.unpricedSamples,
      potMeasured: rollup.pot.measured,
      potScope: GOAL_SPEND_POT_SCOPE,
      sessionScope: GOAL_SPEND_SESSION_SCOPE,
      sessionCents: rollup.sessionCents,
      sessionSamples: rollup.session.samples,
      sessionUnpricedSamples: rollup.session.unpricedSamples,
      sessionMeasured: rollup.session.samples > 0 && rollup.session.unpricedSamples === 0,
      sessionCount: rollup.session.sessions,
      diagnosticTotalCents: rollup.totalCents,
      diagnosticSamples: rollup.samples,
      diagnosticUnpricedSamples: rollup.unpricedSamples,
    },
  };
  // sql.json, NOT a pre-stringified text param: postgres-js JSON-serializes a
  // parameter bound to jsonb, so passing JSON.stringify(patch) double-encodes it
  // into a jsonb SCALAR STRING — and `object || scalar` concatenates into an
  // ARRAY instead of merging, silently destroying the metadata shape (measured
  // live: metadata became [{}, "{…}"] while the UPDATE reported count=1).
  const res = await sql`
    UPDATE harness_shared.goals
       SET metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json(patch as unknown as JSONValue)}
     WHERE id = ${opts.goalId}
       AND workspace_id = ${opts.workspaceId}
  `;
  return res.count;
}

/**
 * Advance this goal's generically-measurable tripwires from the rollup just
 * computed (plan blender-goal-amendment-rail-2026-08-19 P-004, D-014).
 *
 * ⚠ THE `spentCents` NULL GATE IS THE POINT, not a detail. Only a complete
 * lineage measurement (D-011) advances a spend tripwire — the same windowed
 * figure the snapshot and the ceiling use; a floor or an absent measurement
 * leaves the value unchanged. The pot and session legs never reach it.
 *
 * Like {@link writeGoalSpendSnapshot} this deliberately does NOT bump
 * `updated_at`: scoring a tripwire reports a measurement, it does not edit the
 * goal's intent (which is precisely why P-004 needs no amendment authority).
 */
export async function refreshGoalTripwires(
  sql: Sql,
  opts: { workspaceId: string; goalId: string },
  goal: { tripwires: GoalTripwireLike[] | null; createdAtMs: number },
  rollup: GoalSpendRollup,
  nowMs: number = Date.now(),
): Promise<{ advanced: number; written: boolean; breached: ReturnType<typeof breachedTripwires> }> {
  if (isInteractiveUsageUnmeasuredReason(rollup.unmeasuredReason)) {
    return { advanced: 0, written: false, breached: [] };
  }
  const res = refreshTripwireCurrents(goal.tripwires, {
    measuredSpentCents: rollup.spentCents,
    // The window the cents were summed over, so a window-suffixed metric
    // (`spend_usd_7d`) resolves only when it names this window (WI-10004419).
    measuredWindowSec: rollup.windowSec,
    goalAgeMs: nowMs - goal.createdAtMs,
    // The stamp's clock comes from the caller for the same reason the rest of the
    // measurement does: the refresh stays pure and testable without a fake timer.
    nowMs,
  });
  // EI-22795409618800494: preserving the last visible value is NOT permission
  // to enforce it. An unmeasured refresh deliberately retains manual/stale
  // current values; only this sweep's resolved measurements may cause a stop.
  // Include unchanged-but-confirmed readings: a real breach remains enforceable
  // even when neither its number nor its stored provenance needed a write.
  const measuredMetrics = new Set(
    res.outcomes
      .filter((outcome) => outcome.reason === 'advanced' || outcome.reason === 'unchanged')
      .map((outcome) => outcome.metric),
  );
  const breached = breachedTripwires(res.next.filter((tripwire) => measuredMetrics.has(tripwire.metric)));
  if (!res.changed) {
    return { advanced: 0, written: false, breached };
  }

  // sql.json for the same double-encoding reason documented on the snapshot write.
  const upd = await sql`
    UPDATE harness_shared.goals
       SET tripwires = ${sql.json(res.next as unknown as JSONValue)}
     WHERE id = ${opts.goalId}
       AND workspace_id = ${opts.workspaceId}
  `;
  if (upd.count !== 1) throw new Error(`tripwire UPDATE matched ${upd.count} rows`);

  return { advanced: res.advanced, written: true, breached };
}

/** The identity every rollup-driven goal write is attributed to. */
export const GOAL_SPEND_ROLLUP_ACTOR = 'goal-spend-rollup' as const;

/** Decide whether the authoritative windowed spend requires a lifecycle pause. */
export function goalSpendBreachDecision(
  rollup: GoalSpendRollup,
  breached: ReturnType<typeof breachedTripwires>,
  budgetCents: number | null,
): { judgedCents: number; budgetBreached: boolean; reasons: string[] } | null {
  if (isInteractiveUsageUnmeasuredReason(rollup.unmeasuredReason)) return null;
  // A partially priced lineage still has an enforceable priced floor.
  const judgedCents = rollup.spentCents ?? rollup.lineageCents;
  const budgetBreached = budgetCents !== null && judgedCents >= budgetCents;
  if (!budgetBreached && breached.length === 0) return null;

  const per = rollup.windowSec === null ? '' : ` per ${rollup.windowSec}s window`;
  const reasons = [
    ...(budgetBreached
      ? [
          rollup.spentCents !== null
            ? `measured goal-attributed spend ${judgedCents}c reached budget ${budgetCents}c${per}`
            : `goal-attributed spend floor ${judgedCents}c reached budget ${budgetCents}c${per} with ${rollup.lineage.unpricedSamples} unpriced sample(s)`,
        ]
      : []),
    ...breached.map((b) => {
      const pop = populationForMetric(b.metric);
      return `${b.metric} ${b.current} reached threshold ${b.threshold}${pop ? ` [measured over ${pop}]` : ''}`;
    }),
  ];
  return { judgedCents, budgetBreached, reasons };
}

/**
 * A spend ceiling breach is a control, not merely telemetry. The launch gate
 * prevents new work, but an active goal otherwise keeps its existing pots and
 * attributed loops alive indefinitely, so a breach stops it through the shared
 * goal-stop seam — the same fan-out as an explicit goals:update call.
 *
 * It PAUSES rather than kills (D-011 clause 5). A kill is terminal and has hit
 * a goal carrying ~89 live agents; a budget running out is an owner decision
 * (raise it, wait for the window, or wind down), not a verdict on the goal.
 * The pause carries `holderRespawn.needsHuman` with no `escalatedAtMs`, so the
 * holder respawner stays off it while paused and the liveness reconciler
 * clears the latch once the owner resumes it.
 *
 * `rollup` must already be windowed to `budgetWindowSec` — the sweep computes
 * it that way — so the figure judged here is the one the snapshot shows and the
 * launch gate reads. A lifetime figure judged against a per-window ceiling is a
 * guaranteed-termination bug for a standing goal (work-on-everything-goal P-004).
 */
async function enforceGoalBreaches(
  sql: Sql,
  scope: { workspaceId: string; goalId: string },
  rollup: GoalSpendRollup,
  breached: ReturnType<typeof breachedTripwires>,
  budgetCents: number | null,
  nowMs: number = Date.now(),
): Promise<void> {
  const decision = goalSpendBreachDecision(rollup, breached, budgetCents);
  if (!decision) return;
  const { judgedCents, budgetBreached, reasons } = decision;
  const evidence = {
    reason: budgetBreached && rollup.spentCents === null ? 'spend-floor-goal-breach' : 'measured-goal-breach',
    at: new Date(nowMs).toISOString(),
    reasons,
    spentCents: judgedCents,
    measured: rollup.spentCents !== null,
    /*
     * THE PAUSE'S OWN PROVENANCE (P-004).
     *
     * Read cold on a paused goal, `spentCents` looks like "what this goal
     * cost". It is the goal-attributed stream over `judgedWindowSec`; the pot
     * and session legs measure other populations and routinely disagree with
     * it. The readout carries its own scope rather than relying on a reader to
     * know the rule.
     */
    spentCentsScope: GOAL_SPEND_LINEAGE_SCOPE,
    /** Lifetime, or the rolling window the ceiling was actually judged over. */
    judgedWindowSec: rollup.windowSec,
    /** Diagnostic-only context, labelled, so it cannot be mistaken for the cause. */
    notJudged: {
      potCents: rollup.potCents,
      potScope: GOAL_SPEND_POT_SCOPE,
      sessionCents: rollup.sessionCents,
      sessionScope: GOAL_SPEND_SESSION_SCOPE,
      note: 'Present for context only. Neither figure advanced a tripwire or contributed to this pause.',
    },
  };
  const pause = {
    reason: `Spend ceiling reached: ${reasons.join('; ')}. Raise the budget, wait for the window to roll, or wind the goal down.`,
    pausedBy: GOAL_SPEND_ROLLUP_ACTOR,
    pausedAtMs: nowMs,
  };
  // Every bare parameter inside jsonb_build_object carries a cast: the function
  // is VARIADIC "any", so an uncast one fails at PARSE time on every call (see
  // pauseGoalForHolderRespawnRateCap and sql-variadic-any-uncast-param.test.ts).
  const [changed] = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.goals
       SET status = 'paused',
           -- A status transition is a definition-state change, just like
           -- goals:update { status: 'paused' }. Measurement-only writes above
           -- deliberately leave updated_at alone, but omitting this stamp makes
           -- the lifecycle transition invisible to recency-ordered reads.
           updated_at = to_timestamp(${nowMs}::double precision / 1000.0),
           metadata = jsonb_set(
             (CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END) ||
               ${sql.json({ autoPaused: evidence, pause })},
             '{holderRespawn}',
             (CASE WHEN jsonb_typeof(metadata -> 'holderRespawn') = 'object'
                   THEN metadata -> 'holderRespawn' ELSE '{}'::jsonb END) ||
               jsonb_build_object(
                 'needsHuman', true,
                 'needsHumanAtMs', ${nowMs}::bigint
               ),
             true
           )
     WHERE id = ${scope.goalId}
       AND workspace_id = ${scope.workspaceId}
       AND status = 'active'
    RETURNING id
  `;
  if (!changed) return;

  await appendGoalWriteAudit(sql as unknown as GoalSqlTag, {
    workspaceId: scope.workspaceId,
    goalId: scope.goalId,
    author: GOAL_SPEND_ROLLUP_ACTOR,
    writeKind: 'spend-breach-pause',
    actorClass: GOAL_SPEND_ROLLUP_ACTOR,
    detail: reasons.join('; '),
    atMs: nowMs,
  }).catch((error) => {
    console.warn(
      `[goal-spend-rollup] goal:write pause audit failed for ${scope.goalId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const executor = getGoalTransitionExecutor();
  if (executor) {
    await executor({
      goalId: scope.goalId,
      workspaceId: scope.workspaceId,
      status: 'paused',
      actor: GOAL_SPEND_ROLLUP_ACTOR,
    });
  }
  escalateBreachPause({ ...scope, budgetCents, spentCents: judgedCents, reasons });
}

/**
 * Tell the owner the goal was paused and why. Fire-and-forget, deduped per goal
 * so a re-pause after a premature resume bumps the one card instead of
 * stacking another — the escalateBudgetRefusal pattern in goal-launch-settings.
 */
function escalateBreachPause(args: {
  workspaceId: string;
  goalId: string;
  budgetCents: number | null;
  spentCents: number;
  reasons: string[];
}): void {
  void (async () => {
    const { openEscalation } = await import('../agent-tools/coordination/escalations');
    await openEscalation(
      {
        ownerId: `${GOAL_SPEND_ROLLUP_ACTOR}:${args.goalId}`,
        ownerLabel: 'goal spend rollup',
        source: 'principal',
        workspaceId: args.workspaceId,
        userId: null,
      },
      {
        // 'blocker': the goal is stopped until the owner acts on its budget.
        severity: 'blocker',
        summary: `goal ${args.goalId}: PAUSED — spend ceiling reached`,
        body:
          `${args.reasons.join('\n')}\n\n` +
          'The goal is paused, not killed. Raise its budget, wait for the budget window to roll, ' +
          'or wind it down; resuming it while it is still over budget pauses it again on the next rollup tick.',
        meta: {
          dedupKind: 'goal-spend-breach-paused',
          subjectSignature: `${args.workspaceId}:${args.goalId}`,
          goalId: args.goalId,
          budgetCents: args.budgetCents,
          spentCents: args.spentCents,
        },
      },
    );
  })().catch((error) => {
    console.warn(
      `[goal-spend-rollup] breach escalation failed for ${args.goalId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

export interface GoalSpendRollupSweepResult {
  ok: boolean;
  /** false when the flag gate stood the sweep down before any read. */
  ran: boolean;
  checked: number;
  written: number;
  /** Tripwires advanced to a freshly measured value this sweep (P-004). */
  tripwiresAdvanced: number;
  errors: Array<{ goalId: string; error: string }>;
}

/**
 * One sweep: snapshot every ACTIVE goal. Per-goal error isolation — one goal's
 * failure never starves the rest (same contract as the watchdog siblings).
 *
 * Each goal's rollup is computed ONCE, over its budget window, and that single
 * figure feeds the snapshot, the tripwires and the breach check (D-011).
 */
export async function runGoalSpendRollupOnce(
  sql: Sql,
  opts: { nowMs?: number } = {},
): Promise<GoalSpendRollupSweepResult> {
  const enabled = await getFlag(FLAGS.GOAL_SPEND_ROLLUP_TICK, 'system').catch(() => false);
  if (!enabled) return { ok: true, ran: false, checked: 0, written: 0, tripwiresAdvanced: 0, errors: [] };
  const goals = await sql<
    Array<{
      id: string;
      workspace_id: string;
      tripwires: GoalTripwireLike[] | null;
      created_at: Date;
      budget_cents: string | null;
      budget_window_sec: number | null;
    }>
  >`
    SELECT id, workspace_id, tripwires, created_at, budget_cents, budget_window_sec
      FROM harness_shared.goals WHERE status = 'active'
  `;
  const errors: Array<{ goalId: string; error: string }> = [];
  let written = 0;
  let tripwiresAdvanced = 0;
  const nowMs = opts.nowMs ?? Date.now();
  const freshnessEntries = await Promise.all(goals.map(async (goal) => [
    goal.id,
    await readInteractiveUsageFreshness(sql, { workspaceId: goal.workspace_id, goalId: goal.id, nowMs }),
  ] as const));
  const freshnessByGoal = new Map(freshnessEntries);
  for (const g of goals) {
    try {
      const scope = { workspaceId: g.workspace_id, goalId: g.id };
      const rollup = await computeGoalSpendRollup(sql, {
        ...scope,
        windowSec: g.budget_window_sec == null ? null : Number(g.budget_window_sec),
        nowMs,
        interactiveUsageFreshness: freshnessByGoal.get(g.id),
      });
      const count = await writeGoalSpendSnapshot(sql, scope, rollup);
      // A zero-row write means the snapshot silently went nowhere (the goal row
      // vanished mid-sweep, or a scope mismatch) — an error, never a success.
      if (count !== 1) throw new Error(`snapshot UPDATE matched ${count} rows`);
      written += 1;

      // P-004: carry the number one field further, onto the tripwire it was
      // always meant to advance. Isolated from the snapshot write above — a
      // tripwire refresh failing must never lose the spend snapshot that
      // already succeeded, so it throws only after `written` is banked.
      const refreshed = await refreshGoalTripwires(
        sql,
        scope,
        {
          tripwires: g.tripwires ?? null,
          createdAtMs: new Date(g.created_at).getTime(),
        },
        rollup,
        nowMs,
      );
      tripwiresAdvanced += refreshed.advanced;
      await enforceGoalBreaches(
        sql,
        scope,
        rollup,
        refreshed.breached,
        g.budget_cents == null ? null : Number(g.budget_cents),
        nowMs,
      );
    } catch (e) {
      errors.push({ goalId: g.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    ok: errors.length === 0,
    ran: true,
    checked: goals.length,
    written,
    tripwiresAdvanced,
    errors,
  };
}

let tickTimer: ManagedHandle | null = null;

/**
 * Start the recurring rollup tick. Idempotent. Runtime gate:
 * FLAGS.GOAL_SPEND_ROLLUP_TICK (checked per tick, default ON).
 */
export function startGoalSpendRollupTick(sql: Sql, opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? GOAL_SPEND_ROLLUP_INTERVAL_MS;
  if (tickTimer) tickTimer.stop();
  let sweeping = false;
  tickTimer = managedSetInterval(
    'goal-spend-rollup',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runGoalSpendRollupOnce(sql)
        .catch((e) => {
          console.warn(`[goal-spend-rollup] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // 'must-sample': the cost ledger emits no event this could subscribe to —
    // periodic aggregation is the only trigger available for a spend snapshot.
    // 'global-sweep', not 'watchdog': this is a host-wide idempotent aggregation,
    // not an out-of-band sentinel — it recovers nothing, so it does not belong in
    // RECOVERY_MECHANISMS (the recovery-dependency-audit enumerates 'watchdog').
    { category: 'global-sweep', classification: 'must-sample' },
  );
}
