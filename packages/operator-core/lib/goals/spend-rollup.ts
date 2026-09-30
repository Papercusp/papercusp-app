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
 * ── The two attribution legs (and their authority boundary) ───────────────────
 *  1. POT leg — `goalSpend()` (@papercusp/db-org): agent_usage_samples summed by
 *     harness_slug over the goal's live goal_pots, bounded to the goal's lifetime.
 *     Covers every fleet/agent working in the goal's pots. NOT additive across
 *     goals (a shared pot bills in full to each — D-021). This is the ONLY
 *     authoritative source for metadata.spentCents, spend tripwires, and budget
 *     enforcement: it is exactly the value exposed by goals:pots and accepted by
 *     goals:update's exact-match verification.
 *  2. SESSION leg — diagnostic-only context about the goal SUBJECT's interactive
 *     session and inherited descendants whose samples carry a harness OUTSIDE
 *     the goal's pots (or none at all). Session-to-goal attribution is not a
 *     reliable billing boundary: it can be incomplete, inherited, or unpriced.
 *     It MUST NOT change spentCents, advance a spend tripwire, or kill a goal.
 *
 * The diagnostic total still partitions the ledger without double-counting:
 * samples whose harness_slug IS one of the goal's pot harnesses are excluded
 * from the session leg. It rides in spentCentsBreakdown so operators can inspect
 * it without promoting an estimate into authoritative spend.
 *
 * Mechanism precedent: the goal watchdog family (goal-liveness-watchdog.ts,
 * goal-drain-fleet-watchdog.ts) — a process-level managedSetInterval sweep
 * started from dbos/bootstrap.ts, deliberately NOT a DBOS workflow (EI-1622
 * workflow_status bloat), flag-gated per tick (FLAGS.GOAL_SPEND_ROLLUP_TICK,
 * default ON). Missing a tick costs nothing: the next tick recomputes from the
 * ledger — the write is idempotent state, not an event.
 */
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { goalSpend, GOAL_SPEND_SNAPSHOT_SOURCE, type GoalSpend } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { GOAL_MODE } from '../modes/goal-session';
import { getGoalTransitionExecutor } from '@papercusp/agent-mcp';
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
export const GOAL_SPEND_POT_SCOPE = 'inside-goal-pots:authoritative' as const;
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
 * So: diagnostic-only, like the session leg, and never added into any total.
 */
export const GOAL_SPEND_LINEAGE_SCOPE = 'attributed-by-lineage:diagnostic-only' as const;

/**
 * How the three scopes relate, as DATA rather than prose, so a consumer can
 * reject an unsafe sum without reading this module. Shipped beside the cents in
 * `spentCentsBreakdown`.
 */
export const GOAL_SPEND_SCOPE_RELATIONS = {
  additive: [GOAL_SPEND_POT_SCOPE, GOAL_SPEND_SESSION_SCOPE],
  overlapping: [GOAL_SPEND_LINEAGE_SCOPE],
  note: 'pot+session partition the ledger and sum to diagnosticTotalCents; lineage cross-cuts them and must never be added to either.',
} as const;

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
  /** POT leg + diagnostic SESSION leg, in integer cents. Never authoritative. */
  totalCents: number;
  /** Authoritative goals:pots value written to metadata.spentCents. */
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
   * Diagnostic write-time-attributed spend. Deliberately NOT part of
   * `totalCents`, `samples`, `unpricedSamples` or `measured`: it overlaps the
   * legs those aggregate, so including it would double-count.
   */
  lineageCents: number;
  /** Measured lineage ∩ pot, in cents — measured every tick, never assumed zero; see GOAL_SPEND_LINEAGE_SCOPE. */
  lineageInsidePotCents: number;
  lineage: GoalLineageSpend;
}

/**
 * The SESSION leg: samples attributed (via adv_sessions) to owners under the
 * goal, excluding samples already covered by the pot leg's harness match.
 *
 * For legacy NULL rows, owner→goal membership deliberately reads the SAME two
 * tables as resolveGoalContext (modes/goal-context.ts) rather than any
 * agent-supplied list. adv_sessions is NOT workspace-filtered on purpose: coord
 * owner ids are globally unique and a respawn chain can carry rows under more
 * than one workspace label, while the SAMPLE-side workspace_id filter still
 * holds the tenancy line. The goal-lifetime lower bound mirrors goalSpend(): a
 * subject's spend from before the goal existed never bills to it.
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
           AND s.session_id IN (
             SELECT a.session_id
               FROM harness_shared.adv_sessions a
              WHERE a.session_id IS NOT NULL
                AND a.coord_owner_id IN (
                  SELECT m.owner_id FROM harness_shared.agent_modes m
                   WHERE m.workspace_id = ${opts.workspaceId}
                     AND m.mode = ${GOAL_MODE}
                     AND m.subject = ${opts.goalId}
                  UNION
                  SELECT b.owner_id FROM harness_shared.session_briefs b
                   WHERE b.workspace_id = ${opts.workspaceId}
                     AND b.goal_id = ${opts.goalId}
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
 * Both legs, combined for diagnostics. The persisted/controlling number is
 * always `potCents`; `totalCents` is intentionally non-authoritative.
 *
 * `sinceMs` threads to BOTH legs unchanged (each already clamps it up to the
 * goal's creation, so it can narrow the window but never reach back before the
 * goal existed). Omitted ⇒ goal lifetime, which is what the snapshot wants;
 * the rolling-window ceiling (P-004) passes one.
 */
export async function computeGoalSpendRollup(
  sql: Sql,
  opts: { workspaceId: string; goalId: string; sinceMs?: number },
): Promise<GoalSpendRollup> {
  const [pot, session, lineage] = await Promise.all([
    goalSpend(sql, opts),
    sessionSpendForGoal(sql, opts),
    lineageSpendForGoal(sql, opts),
  ]);
  const potCents = Math.round(pot.costUsd * 100);
  const sessionCents = Math.round(session.costUsd * 100);
  // The pot/session partition is what aggregates. The lineage leg is EXCLUDED
  // from every aggregate below on purpose: it overlaps both (see
  // GOAL_SPEND_LINEAGE_SCOPE), so folding it in would double-count rather than
  // widen coverage — and a too-large `samples` would flip `measured`, which
  // gates tripwire advancement.
  const samples = pot.samples + session.samples;
  const unpricedSamples = pot.unpricedSamples + session.unpricedSamples;
  return {
    goalId: opts.goalId,
    totalCents: potCents + sessionCents,
    potCents,
    sessionCents,
    samples,
    unpricedSamples,
    measured: samples > 0 && unpricedSamples === 0,
    pot,
    session,
    lineageCents: Math.round(lineage.costUsd * 100),
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
    // Hard authority boundary: this must remain byte-for-byte equivalent to
    // goals:pots, even when the diagnostic session leg is larger or unpriced.
    //
    // ...but it must never assert a number the pot leg did not MEASURE. goalSpend()
    // is an INNER JOIN on goal_pots, so a goal with ZERO attached pots yields
    // samples === 0 and potCents === 0: "unmeasurable" and "measured zero" are
    // indistinguishable in the value alone. That distinction is load-bearing here,
    // because the budget launch gate reads THIS field: its `spentCents == null`
    // branch (goal-launch-settings.ts) records a degraded reason naming the goal and
    // fails OPEN, whereas a bare 0 is accepted as an authoritative measurement and
    // silently admits every launch under budget. Writing null therefore turns a
    // SILENT fail-open into a LOUD one — it cannot freeze launches — and restores
    // the symmetry with refreshGoalTripwires below, which already guards this way.
    //
    // The discriminator is `samples`, NOT `measured`. `measured` is
    // `samples > 0 && unpricedSamples === 0` (goal-pots.ts), so keying on it would
    // ALSO null out a partially-priced pot — and judgeGoalSpend deliberately uses
    // that pot's potCents as a spend FLOOR (the spend-floor-goal-breach branch
    // below). Copying the tripwire sibling verbatim would regress a live budget
    // control, not merely a diagnostic.
    spentCents: rollup.pot.samples > 0 ? rollup.potCents : null,
    spentCentsSource: GOAL_SPEND_SNAPSHOT_SOURCE,
    spentCentsAt: nowIso,
    spentCentsBreakdown: {
      potCents: rollup.potCents,
      potSamples: rollup.pot.samples,
      potUnpricedSamples: rollup.pot.unpricedSamples,
      measured: rollup.pot.measured,
      // The scope labels are what stop potCents and sessionCents being read as
      // rival totals of one quantity: they are disjoint partitions of the
      // ledger, and only the pot leg may control anything.
      potScope: GOAL_SPEND_POT_SCOPE,
      sessionScope: GOAL_SPEND_SESSION_SCOPE,
      lineageScope: GOAL_SPEND_LINEAGE_SCOPE,
      // How the three relate, as data. A consumer can reject an unsafe sum
      // without reading this module — which is the whole point of P-004.
      scopeRelations: GOAL_SPEND_SCOPE_RELATIONS,
      // Everything below is diagnostic-only and must never be read as the
      // authoritative spend snapshot or a terminal-control input.
      sessionCents: rollup.sessionCents,
      sessionSamples: rollup.session.samples,
      sessionUnpricedSamples: rollup.session.unpricedSamples,
      sessionMeasured: rollup.session.samples > 0 && rollup.session.unpricedSamples === 0,
      sessionCount: rollup.session.sessions,
      // LINEAGE leg — cross-cutting, never added to the totals below.
      lineageCents: rollup.lineageCents,
      lineageSamples: rollup.lineage.samples,
      lineageUnpricedSamples: rollup.lineage.unpricedSamples,
      lineageSessionCount: rollup.lineage.sessions,
      // The measured intersection with the pot leg. Present even when 0 — a
      // zero a reader can SEE is what makes the non-additivity checkable
      // rather than a claim they have to trust.
      lineageInsidePotCents: rollup.lineageInsidePotCents,
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
       SET metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json(patch)}
     WHERE id = ${opts.goalId}
       AND workspace_id = ${opts.workspaceId}
  `;
  return res.count;
}

/**
 * Advance this goal's generically-measurable tripwires from the rollup just
 * computed (plan blender-goal-amendment-rail-2026-08-19 P-004, D-014).
 *
 * ⚠ THE POT-LEG `measured` GATE IS THE POINT, not a detail. The session leg is
 * diagnostic-only and may neither inflate the current nor make an otherwise
 * measured goals:pots value look unmeasured. Only a fully-priced POT rollup
 * advances a spend tripwire; everything else leaves the value unchanged.
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
  const res = refreshTripwireCurrents(goal.tripwires, {
    measuredSpentCents: rollup.pot.measured ? rollup.potCents : null,
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
       SET tripwires = ${sql.json(res.next)}
     WHERE id = ${opts.goalId}
       AND workspace_id = ${opts.workspaceId}
  `;
  if (upd.count !== 1) throw new Error(`tripwire UPDATE matched ${upd.count} rows`);

  return { advanced: res.advanced, written: true, breached };
}

/**
 * A spend ceiling breach is a terminal control, not merely telemetry. The
 * launch gate prevents new work, but an active goal otherwise keeps its
 * existing pots and attributed loops alive indefinitely. Transition through
 * the shared goal-stop seam after the row is marked killed so placement and
 * loops receive the same fan-out as an explicit goals:update call.
 */
async function enforceGoalBreaches(
  sql: Sql,
  scope: { workspaceId: string; goalId: string },
  rollup: GoalSpendRollup,
  breached: ReturnType<typeof breachedTripwires>,
): Promise<void> {
  const budgetRows = await sql<Array<{ budget_cents: string | null; budget_window_sec: number | null }>>`
    SELECT budget_cents, budget_window_sec
      FROM harness_shared.goals
     WHERE id = ${scope.goalId}
       AND workspace_id = ${scope.workspaceId}
       AND status = 'active'
     LIMIT 1
  `;
  const budgetCents = budgetRows[0]?.budget_cents == null ? null : Number(budgetRows[0].budget_cents);
  const windowSec =
    budgetRows[0]?.budget_window_sec == null ? null : Number(budgetRows[0].budget_window_sec);

  /*
   * THE DENOMINATOR (work-on-everything-goal-2026-08-23 P-004).
   *
   * With no window the ceiling is per goal LIFETIME and `rollup` — computed
   * over exactly that — is the figure to judge. That is correct for an outcome
   * goal: the ceiling bounds a bet.
   *
   * With a window the ceiling is spend-per-window and lifetime spend is the
   * WRONG number, not merely a stricter one. A standing goal (P-001) pursues an
   * ongoing duty, so its lifetime spend crosses any finite ceiling by
   * construction — judging it against lifetime does not budget the goal, it
   * schedules its auto-kill for whenever the total happens to arrive. Since
   * this function KILLS on breach, getting the denominator wrong here is a
   * silent guaranteed-termination bug, which is why the window is re-measured
   * rather than approximated from the lifetime figure.
   *
   * The extra query is paid ONLY by goals that declare a window; every other
   * goal keeps the single pre-existing read.
   */
  const judged =
    budgetCents !== null && windowSec !== null
      ? await computeGoalSpendRollup(sql, { ...scope, sinceMs: Date.now() - windowSec * 1000 })
      : rollup;

  // Only goals:pots can govern the goal. A POT floor still necessarily reaches
  // the ceiling when its known priced portion does; the diagnostic session leg
  // is never part of this comparison.
  const budgetBreached = budgetCents !== null && judged.potCents >= budgetCents;
  if (!budgetBreached && breached.length === 0) return;

  const per = windowSec === null ? '' : ` per ${windowSec}s window`;
  const reasons = [
    ...(budgetBreached
      ? [
          judged.pot.measured
            ? `measured goals:pots spend ${judged.potCents}c reached budget ${budgetCents}c${per}`
            : `goals:pots spend floor ${judged.potCents}c reached budget ${budgetCents}c${per} with ${judged.pot.unpricedSamples} unpriced sample(s)`,
        ]
      : []),
    ...breached.map((b) => {
      // NAME THE POPULATION (P-004). `spend_usd 62 reached threshold 100` reads
      // as a fact about the goal; it is a fact about the goal's pot subset.
      const pop = populationForMetric(b.metric);
      return `${b.metric} ${b.current} reached threshold ${b.threshold}${pop ? ` [measured over ${pop}]` : ''}`;
    }),
  ];
  const evidence = {
    reason: budgetBreached && !judged.pot.measured ? 'spend-floor-goal-breach' : 'measured-goal-breach',
    at: new Date().toISOString(),
    reasons,
    spentCents: judged.potCents,
    measured: judged.pot.measured,
    /*
     * THE KILL'S OWN PROVENANCE (P-004).
     *
     * `spentCents` above is the POT leg — the only leg allowed to govern. Read
     * cold on a killed goal it looks like "what this goal cost", and when the
     * diagnostic session leg is larger (routinely ~2x) that reads as the kill
     * having fired at the wrong number. It did not; the two measure disjoint
     * populations. This plan is itself the case study for what happens when a
     * number is read without its population, so the terminal readout carries
     * its own scope rather than relying on a reader to know the rule.
     */
    spentCentsScope: GOAL_SPEND_POT_SCOPE,
    /** Lifetime, or the rolling window the ceiling was actually judged over. */
    judgedWindowSec: windowSec,
    /** Diagnostic-only context, labelled, so it cannot be mistaken for the cause. */
    notJudged: {
      sessionCents: judged.sessionCents,
      sessionScope: GOAL_SPEND_SESSION_SCOPE,
      lineageCents: judged.lineageCents,
      lineageScope: GOAL_SPEND_LINEAGE_SCOPE,
      note: 'Present for context only. Neither figure advanced a tripwire or contributed to this kill.',
    },
  };
  const changed = await sql`
    UPDATE harness_shared.goals
       SET status = 'killed',
           -- A terminal status transition is a definition-state change, just
           -- like goals:update { status: 'killed' }. Measurement-only writes
           -- above deliberately leave updated_at alone, but omitting this stamp
           -- makes the lifecycle transition invisible to recency-ordered reads.
           updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json({ autoKilled: evidence })}
     WHERE id = ${scope.goalId}
       AND workspace_id = ${scope.workspaceId}
       AND status = 'active'
  `;
  if (changed.count !== 1) return;

  const executor = getGoalTransitionExecutor();
  if (executor) {
    await executor({
      goalId: scope.goalId,
      workspaceId: scope.workspaceId,
      status: 'killed',
      actor: 'goal-spend-rollup',
    });
  }
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
 */
export async function runGoalSpendRollupOnce(sql: Sql): Promise<GoalSpendRollupSweepResult> {
  const enabled = await getFlag(FLAGS.GOAL_SPEND_ROLLUP_TICK, 'system').catch(() => false);
  if (!enabled) return { ok: true, ran: false, checked: 0, written: 0, tripwiresAdvanced: 0, errors: [] };
  const goals = await sql<
    Array<{
      id: string;
      workspace_id: string;
      tripwires: GoalTripwireLike[] | null;
      created_at: Date;
    }>
  >`
    SELECT id, workspace_id, tripwires, created_at
      FROM harness_shared.goals WHERE status = 'active'
  `;
  const errors: Array<{ goalId: string; error: string }> = [];
  let written = 0;
  let tripwiresAdvanced = 0;
  for (const g of goals) {
    try {
      const scope = { workspaceId: g.workspace_id, goalId: g.id };
      const rollup = await computeGoalSpendRollup(sql, scope);
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
      );
      tripwiresAdvanced += refreshed.advanced;
      await enforceGoalBreaches(sql, scope, rollup, refreshed.breached);
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
