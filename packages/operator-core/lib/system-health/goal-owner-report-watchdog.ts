/**
 * goal-owner-report-watchdog (P-009 of goal-mode-design-intent-hardening-2026-08-16) —
 * nudge a goal-mode owner whose ACTIVE goal has gone report-silent past the cadence
 * floor, ONCE per silence, with the report skeleton the GOAL contract demands.
 *
 * THE BUG THIS CLOSES, measured (WI-39348, 2026-08-16): the graded run reported
 * exemplarily for 2.5h, then went silent for 5h — INCLUDING at goal-met. The GOAL
 * contract's reporting clause ("REPORT on a standing cadence via coord:escalate /
 * notifyAttention: what moved, what it cost, what is owner-walled, and what you
 * killed") is prose, and prose did not hold; this instrument replaces it (D-001:
 * structural > detector > prose — this is the detector tier, with the D-016 floor
 * discipline below keeping it from decaying into decoration).
 *
 * THE INSTRUMENT reads the rails the contract names PLUS the to-human channel
 * holders demonstrably use, so a compliant owner is never nagged and no
 * self-report is trusted:
 *  - `coord_event_log` surface='escalations' rows whose body `from` is the owner —
 *    coord:escalate is the contract's primary reporting rail, and openEscalation
 *    stamps the raising identity server-side;
 *  - `attention_notifications` rows whose `data` names this goal or this owner —
 *    the notifyAttention rail records no author column (WI-36644 made it an audit
 *    trail, not an attribution surface), so attribution rides on the payload when
 *    the call site provided it. This leg can only SUPPRESS an alarm, so a call
 *    site that omitted the ids degrades toward a (deduped) nudge, never a miss;
 *  - `coord_event_log` surface='messages' rows FROM the owner whose `to` array
 *    includes 'human' — a `coord:send { to: ['human'] }` IS an owner report in
 *    substance. The original design deliberately excluded it ("the nudge teaches
 *    the contract's rail"), and WI-2091959 measured what that bought: the
 *    everything-goal holder's four real owner reports ALL rode to-human sends
 *    while only the two rails above were measured, so a compliant-by-send holder
 *    read as silent — a false-silence that any floor tightening would have
 *    amplified into a nag loop. Counting the channel kills the false-silence;
 *    the nudge skeleton still names the contract's rail.
 * A report by other channels an agent might improvise on (a work-item comment,
 * a plan note) remains unmeasured.
 *
 * EXACTLY ONE CLASSIFIER SPEAKS PER GOAL (the family rule): this one fires ONLY on
 * a goal whose owner is POSITIVELY alive. A dead / unresolved owner is
 * goal-liveness-watchdog's territory — nudging a corpse is noise, and the
 * conservative rule (a degraded read suppresses, never false-alarms) applies to the
 * liveness read exactly as it does in the drain-fleet sibling.
 *
 * ONE NUDGE PER SILENCE, structurally: the escalation of record is PG-deduped per
 * (workspace, goal, owner), and the directed wake fires only when that escalation
 * was NEWLY OPENED — a coalesced repeat keeps the record's repeatCount honest
 * without re-waking the owner every tick. A new report moves the reference
 * timestamp, the overdue condition clears, and the next silence opens a fresh cycle
 * once the previous escalation resolves.
 *
 * D-016 (unified-agent-state-plane-2026-07-27): "a detector without a floor is
 * prose exhortation in a costume" — and a floor with no consequence is how the
 * feature quietly dies. The cadence floor below therefore carries its measured
 * WHY and a REVIEW-BY date; the guard suite fails once that date passes, forcing
 * the number to be re-litigated against fresh evidence instead of fossilizing.
 *
 * Runtime gate: FLAGS.GOAL_OWNER_REPORT_WATCHDOG (default ON; kill-switch at
 * /admin/features), checked per tick like its siblings.
 */
import type { Sql } from 'postgres';

import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
// P-001: the alive predicate and the oracle fold come from the ONE goal-holder
// module (previously re-imported from the sibling liveness watchdog). This
// file's own `agent_modes` read stays raw on purpose — it is not a plain holder
// read but a LATERAL join carrying each owner's report timestamps — and the
// holder-read guard clears it because the liveness fold below is present, which
// is the property D-003 actually enforces.
import { holderCountsAsAlive, resolveHolderLiveness } from '../goals/holder';
import {
  GOAL_OWNER_REPORT_FIELD,
  GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS,
  GOAL_OWNER_REPORT_SCHEMA_VERSION,
} from '../goal-owner-report';

/** Hours-scale detection needs no seconds-scale sweep: one tick per 10 minutes
 *  bounds the worst-case detection lag to ~4% of the floor. */
export const GOAL_OWNER_REPORT_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * THE CADENCE FLOOR (D-016): silence longer than this is overdue.
 *
 * Why 4 hours — the measured basis (WI-39348, the run this plan hardens against):
 * healthy operation reported at a ≤2.5h cadence; the failure was a 5h silence that
 * swallowed goal-met itself. 4h sits strictly ABOVE the measured healthy cadence
 * (a compliant owner is never nagged) and strictly BELOW the measured failure
 * (the observed silence would have been caught an hour before it ended). The
 * guard suite pins both inequalities, so a future retune that breaks either
 * relation has to bring new measurements, not a mood.
 */
export const GOAL_OWNER_REPORT_MAX_SILENCE_MS = 4 * 3600_000;

/** The measured healthy cadence (ms) the floor must stay ABOVE — see the floor's
 *  doc. Exported so the guard test pins the relation, not a copied number. */
export const GOAL_OWNER_REPORT_MEASURED_HEALTHY_CADENCE_MS = 2.5 * 3600_000;

/** The measured failure silence (ms) the floor must stay AT-OR-BELOW. */
export const GOAL_OWNER_REPORT_MEASURED_FAILURE_SILENCE_MS = 5 * 3600_000;

/**
 * THE STANDING-GOAL CADENCE FLOOR (WI-2091959 — D-016 re-litigation 2026-09-01):
 * a STANDING (stewardship) goal — `goals.standing = true` — carries a TIGHTER
 * reporting expectation than an outcome goal. Its holder is a perpetual steward:
 * there is no goal-met event the owner could wait for, so report cadence is the
 * owner's ONLY window into the goal, and silence is the failure mode itself.
 *
 * Why 1 hour — the measured basis (goal-mode-e2e stewardship cards
 * EI-22039635271337633 and EI-22058120037739249 grading the everything-goal
 * holder, silences corrected per the WI-2094390 audit erratum): compliant
 * reporting ran at ≤14min gaps (04:11:39 → 04:25:38 → 04:28:42Z); the graded
 * failures were silences of 2h14m (04:28:42 → 06:42:34Z) and 1h07m
 * (06:42:34 → 07:50Z) on an actively-working holder — BOTH rated
 * owner-steering-and-reporting FAIL, and both sat BELOW the 4h outcome floor by
 * design. 1h is strictly ABOVE the measured healthy cadence (a compliant
 * steward is never nagged) and strictly BELOW the smaller measured failure
 * (both graded breaches would have been caught). The guard suite pins both
 * inequalities plus standing < outcome.
 */
export const GOAL_OWNER_REPORT_STANDING_MAX_SILENCE_MS = 3600_000;

/** The measured healthy STANDING cadence (ms) — the max gap between the graded
 *  holder's compliant reports. The standing floor must stay strictly ABOVE it. */
export const GOAL_OWNER_REPORT_STANDING_MEASURED_HEALTHY_CADENCE_MS = 14 * 60_000;

/** The SMALLER measured STANDING failure silence (ms) — 1h07m; the standing
 *  floor must stay AT-OR-BELOW it so both graded breaches are caught. */
export const GOAL_OWNER_REPORT_STANDING_MEASURED_FAILURE_SILENCE_MS = 67 * 60_000;

/**
 * D-016's consequence clause: past this date the guard suite FAILS until whoever
 * finds it re-litigates BOTH floors against current evidence (rubric trends,
 * scorecard cadence data) and bumps this date with an updated WHY above. A floor
 * that can never demand review is a comment.
 *
 * Re-litigated 2026-09-01 (WI-2091959, was 2026-09-17): two stewardship cards
 * measured standing-goal silences of 2h14m/1h07m rated FAIL below the 4h floor
 * → the floor SPLIT by goal kind (1h standing, above). The 4h outcome floor
 * stands unchanged — no new outcome-goal evidence contradicted WI-39348's
 * measurements. Same evidence drove the to-human rail widening (see the
 * instrument doc): rails first, so the tighter floor never nags a
 * compliant-by-send holder.
 */
export const GOAL_OWNER_REPORT_REVIEW_BY = '2026-10-01';

/** True when `reviewBy` (an ISO date) is strictly before `now`. Exported for the
 *  guard test so the comparison the test runs is the one shipped here. */
export function isPastReportFloorReview(reviewBy: string, now: Date): boolean {
  const t = Date.parse(reviewBy);
  if (Number.isNaN(t)) return true; // an unparseable date must fail review, not skate
  return t < now.getTime();
}

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'goal-owner-report-watchdog',
  ownerLabel: 'system · goal owner reports',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One goal-mode registration on an ACTIVE goal, with its report timestamps. */
export interface GoalOwnerReportRowLike {
  workspaceId: string;
  goalId: string;
  /** The goal-mode owner (agent_modes.owner_id). */
  agentId: string;
  /** Grace baseline: GREATEST(goal created_at, mode set_at) — no report is
   *  expected before the goal existed or before this owner took it on. */
  baselineTsMs: number;
  /** Newest report on any measured rail, or null when none has one. */
  lastReportTsMs: number | null;
  /** `goals.standing` — a standing (stewardship) goal is judged against the
   *  tighter standing floor (WI-2091959). */
  standing: boolean;
}

/** One overdue verdict. */
export interface GoalOwnerReportAlert {
  workspaceId: string;
  goalId: string;
  agentId: string;
  /** The timestamp silence is measured FROM (last report, floored at baseline). */
  referenceTsMs: number;
  silentMs: number;
  /** The floor this row was judged against (standing vs outcome) — carried so
   *  the escalation/nudge text states the bound that actually applied. */
  floorMs: number;
  standing: boolean;
}

/**
 * PURE: which owners are overdue. The reference point is the last report, but
 * never earlier than the baseline — a report that PREDATES this goal/mode
 * registration proves nothing about it, and a freshly-taken goal earns the full
 * grace window before its first nudge. Strictly-greater comparison: silence
 * exactly AT the floor is not yet past it. The floor is per-row: a standing
 * goal is judged against the standing floor (WI-2091959), an outcome goal
 * against the original.
 */
export function findOverdueReports(
  rows: readonly GoalOwnerReportRowLike[],
  nowMs: number,
  maxSilenceMs: number = GOAL_OWNER_REPORT_MAX_SILENCE_MS,
  standingMaxSilenceMs: number = GOAL_OWNER_REPORT_STANDING_MAX_SILENCE_MS,
): GoalOwnerReportAlert[] {
  const out: GoalOwnerReportAlert[] = [];
  for (const row of rows) {
    const floorMs = row.standing ? standingMaxSilenceMs : maxSilenceMs;
    const referenceTsMs = Math.max(row.baselineTsMs, row.lastReportTsMs ?? row.baselineTsMs);
    const silentMs = nowMs - referenceTsMs;
    if (silentMs > floorMs) {
      out.push({
        workspaceId: row.workspaceId,
        goalId: row.goalId,
        agentId: row.agentId,
        referenceTsMs,
        silentMs,
        floorMs,
        standing: row.standing,
      });
    }
  }
  return out;
}

/**
 * WI-2140700: how close to the floor a wake counts as "due now". The holder's
 * contract says report at the 55-minute mark of a standing goal's 60-minute
 * floor; this margin is that 5 minutes, expressed against whichever floor
 * applies so an outcome goal gets the same last-wake warning.
 */
export const GOAL_OWNER_REPORT_DUE_SOON_MARGIN_MS = 5 * 60_000;

/** The per-wake verdict a goal holder reads from `modes.ownerReport` (orient). */
export interface GoalOwnerReportObligation {
  /** Newest owner-facing event on any measured rail, ISO — null when none since the baseline. */
  lastReportAt: string | null;
  /** Minutes since the reference point (last report, floored at the baseline). */
  ageMin: number;
  /** The floor this owner is judged against, in minutes (standing vs outcome). */
  floorMin: number;
  /** Minutes until the floor is crossed; negative once overdue. */
  dueInMin: number;
  /** Exact cadence boundary from the canonical reference + floor. Unlike the
   * rounded display minutes, this is stable across repeated reminder reads. */
  dueAt: string;
  standing: boolean;
  obligation: 'overdue' | 'due-now' | 'not-due';
  /** One imperative line the contract tells the holder to obey before any other work. */
  instruction: string;
}

/**
 * PURE: the same arithmetic `findOverdueReports` applies, projected for ONE row
 * and rendered as the holder's own obligation instead of a watchdog alert. Kept
 * beside the sweep so the two can never disagree about the floor or the
 * reference point: a holder that reads `not-due` here is exactly a holder the
 * sweep would not nudge.
 */
export function describeGoalOwnerReportObligation(
  row: GoalOwnerReportRowLike,
  nowMs: number,
  maxSilenceMs: number = GOAL_OWNER_REPORT_MAX_SILENCE_MS,
  standingMaxSilenceMs: number = GOAL_OWNER_REPORT_STANDING_MAX_SILENCE_MS,
  dueSoonMarginMs: number = GOAL_OWNER_REPORT_DUE_SOON_MARGIN_MS,
): GoalOwnerReportObligation {
  const floorMs = row.standing ? standingMaxSilenceMs : maxSilenceMs;
  const referenceTsMs = Math.max(row.baselineTsMs, row.lastReportTsMs ?? row.baselineTsMs);
  const silentMs = nowMs - referenceTsMs;
  const dueInMs = floorMs - silentMs;
  const dueAt = new Date(referenceTsMs + floorMs).toISOString();
  const obligation: GoalOwnerReportObligation['obligation'] =
    silentMs > floorMs ? 'overdue' : dueInMs <= dueSoonMarginMs ? 'due-now' : 'not-due';
  const toMin = (ms: number): number => Math.round(ms / 60_000);
  const lastReportAt =
    row.lastReportTsMs !== null && row.lastReportTsMs >= row.baselineTsMs
      ? new Date(row.lastReportTsMs).toISOString()
      : null;
  const report =
    "send the four-element owner report NOW — coord:send { to:['human'] } with MOVED / COST / OWNER-WALLED / KILLED — before any other work";
  const instruction =
    obligation === 'overdue'
      ? `OVERDUE by ${toMin(-dueInMs)} min (floor ${toMin(floorMs)} min, last owner-facing report ${lastReportAt ?? 'none since you took this goal'}): ${report}.`
      : obligation === 'due-now'
        ? `DUE NOW (${toMin(dueInMs)} min to the ${toMin(floorMs)}-min floor): ${report}.`
        : `not due: ${toMin(dueInMs)} min until the ${toMin(floorMs)}-min floor (last owner-facing report ${lastReportAt ?? 'none yet — the baseline is your goal/mode start'}).`;
  return {
    lastReportAt,
    ageMin: toMin(silentMs),
    floorMin: toMin(floorMs),
    dueInMin: toMin(dueInMs),
    dueAt,
    standing: row.standing,
    obligation,
    instruction,
  };
}

/**
 * WI-2140700: the holder's own every-wake read — ONE goal-mode registration on
 * an active goal, through the exact population query the sweep uses, projected
 * with `describeGoalOwnerReportObligation`. Null when the caller holds no
 * active goal-mode row for that goal (the sweep would not measure it either).
 */
export async function readGoalOwnerReportObligation(
  sql: Sql,
  filter: GoalOwnerReportOwnerFilter,
  nowMs: number = Date.now(),
): Promise<GoalOwnerReportObligation | null> {
  const rows = await makeReadGoalModeOwners(sql, filter)();
  const row = rows[0];
  return row ? describeGoalOwnerReportObligation(row, nowMs) : null;
}

/** The contract's report shape, handed to the owner as a fill-in skeleton rather
 *  than a bare scold — the four fields are the GOAL contract's own list. */
export function buildReportSkeleton(alert: GoalOwnerReportAlert): Record<string, string> {
  return {
    channel:
      "coord:escalate (or notifyAttention with { goalId } in data) — the GOAL contract's standing-cadence rail",
    whatMoved: `<plans / fleets / work-items that advanced for goal '${alert.goalId}', with ids>`,
    whatItCost:
      '<measured spend: goals:pots rollup vs the declared ceiling — never an invented spentCents (D-003)>',
    ownerWalled: '<queued owner asks: app-store, payments, domains, real spend, approvals>',
    whatYouKilled: '<pots/fleets killed or wound down, each with the criterion that tripped>',
  };
}

export interface GoalOwnerReportSweepDeps {
  /** Every goal-mode registration on an ACTIVE goal, with report timestamps. */
  readGoalModeOwners: () => Promise<GoalOwnerReportRowLike[]>;
  /** Shared liveness oracle — positive-alive gates an alert; missing = unknown = suppress. */
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, LivenessVerdict>>;
  /** Open/coalesce the escalation of record; `coalesced` gates the nudge. */
  escalate: (alert: GoalOwnerReportAlert) => Promise<{ coalesced: boolean }>;
  /** Directed wake of the owner with the report skeleton — fired ONCE per silence. */
  nudge: (alert: GoalOwnerReportAlert) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.GOAL_OWNER_REPORT_WATCHDOG, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

/** WI-2140700: narrow the population read to ONE goal-mode registration — the
 *  orient-time self-read a holder performs every wake. Same query, one filter. */
export interface GoalOwnerReportOwnerFilter {
  workspaceId: string;
  ownerId: string;
  goalId: string;
}

function makeReadGoalModeOwners(
  sql: Sql,
  filter?: GoalOwnerReportOwnerFilter,
): GoalOwnerReportSweepDeps['readGoalModeOwners'] {
  return async () => {
    // Population first (goal-mode rows on ACTIVE goals — measured base rate is
    // single-digit owners), then one LATERAL per rail per row. The escalations
    // scan rides the (workspace_id, surface, msg_id) unique index's leading
    // columns; the body->>'from' filter is a heap check over that already-small
    // subset, which a 10-minute cadence absorbs comfortably. GREATEST ignores
    // NULLs in Postgres, so a rail with no rows simply drops out.
    const rows = await sql<
      {
        workspace_id: string;
        goal_id: string;
        owner_id: string;
        standing: boolean;
        baseline_ts_ms: string;
        last_report_ts_ms: string | null;
      }[]
    >`
      SELECT m.workspace_id,
             m.subject AS goal_id,
             m.owner_id,
             g.standing,
             (extract(epoch FROM GREATEST(g.created_at, m.set_at)) * 1000)::bigint AS baseline_ts_ms,
             (extract(epoch FROM GREATEST(er.last_escalation_ts, an.last_attention_ts, hm.last_human_msg_ts)) * 1000)::bigint AS last_report_ts_ms
        FROM harness_shared.agent_modes m
        JOIN harness_shared.goals g
          ON g.id = m.subject AND g.workspace_id = m.workspace_id AND g.status = 'active'
        LEFT JOIN LATERAL (
          SELECT max(e.ts) AS last_escalation_ts
            FROM harness_shared.coord_event_log e
           WHERE e.workspace_id = m.workspace_id
             AND e.surface = 'escalations'
             AND e.body->>'from' = m.owner_id
             AND (
               (
                 e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'schemaVersion' = ${GOAL_OWNER_REPORT_SCHEMA_VERSION}
                 AND e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'goalId' = m.subject
                 AND NULLIF(BTRIM(e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'moved'), '') IS NOT NULL
                 AND NULLIF(BTRIM(e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'cost'), '') IS NOT NULL
                 AND NULLIF(BTRIM(e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'ownerWalled'), '') IS NOT NULL
                 AND NULLIF(BTRIM(e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'killed'), '') IS NOT NULL
               )
               OR (
                 -- Bounded compatibility for pre-stamp reports. Keep the old
                 -- exact-subject requirement and require FOUR non-empty label
                 -- values; an arbitrary escalation is not report evidence.
                 strpos(COALESCE(e.body->>'body', ''), m.subject) > 0
                 AND COALESCE(e.body->>'body', '') ~* ${GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS.moved}
                 AND COALESCE(e.body->>'body', '') ~* ${GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS.cost}
                 AND COALESCE(e.body->>'body', '') ~* ${GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS.ownerWalled}
                 AND COALESCE(e.body->>'body', '') ~* ${GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS.killed}
               )
             )
        ) er ON true
        LEFT JOIN LATERAL (
          SELECT max(a.created_at) AS last_attention_ts
            FROM harness_shared.attention_notifications a
           WHERE a.workspace_id = m.workspace_id
             -- notifyAttention has no authenticated author column. It counts
             -- only when the producer explicitly attributes THIS owner and
             -- carries a complete current-subject report stamp; goalId alone
             -- is context, not proof the holder reported.
             AND a.data->>'ownerId' = m.owner_id
             AND a.data -> ${GOAL_OWNER_REPORT_FIELD} ->> 'schemaVersion' = ${GOAL_OWNER_REPORT_SCHEMA_VERSION}
             AND a.data -> ${GOAL_OWNER_REPORT_FIELD} ->> 'goalId' = m.subject
             AND NULLIF(BTRIM(a.data -> ${GOAL_OWNER_REPORT_FIELD} ->> 'moved'), '') IS NOT NULL
             AND NULLIF(BTRIM(a.data -> ${GOAL_OWNER_REPORT_FIELD} ->> 'cost'), '') IS NOT NULL
             AND NULLIF(BTRIM(a.data -> ${GOAL_OWNER_REPORT_FIELD} ->> 'ownerWalled'), '') IS NOT NULL
             AND NULLIF(BTRIM(a.data -> ${GOAL_OWNER_REPORT_FIELD} ->> 'killed'), '') IS NOT NULL
        ) an ON true
        LEFT JOIN LATERAL (
          -- WI-2091959: a coord:send addressed to 'human' is an owner report in
          -- substance — the graded holder's four real reports all rode this
          -- channel while it went unmeasured, reading as silence. Containment
          -- (@>) also matches a multi-recipient send that includes 'human'.
          SELECT max(h.ts) AS last_human_msg_ts
            FROM harness_shared.coord_event_log h
           WHERE h.workspace_id = m.workspace_id
             AND h.surface = 'messages'
             AND h.body->>'from' = m.owner_id
             AND h.body->'to' @> '["human"]'::jsonb
             AND (
               (
                 h.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'schemaVersion' = ${GOAL_OWNER_REPORT_SCHEMA_VERSION}
                 AND h.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'goalId' = m.subject
                 AND NULLIF(BTRIM(h.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'moved'), '') IS NOT NULL
                 AND NULLIF(BTRIM(h.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'cost'), '') IS NOT NULL
                 AND NULLIF(BTRIM(h.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'ownerWalled'), '') IS NOT NULL
                 AND NULLIF(BTRIM(h.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'killed'), '') IS NOT NULL
               )
               OR (
                 strpos(COALESCE(h.body->>'body', ''), m.subject) > 0
                 AND COALESCE(h.body->>'body', '') ~* ${GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS.moved}
                 AND COALESCE(h.body->>'body', '') ~* ${GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS.cost}
                 AND COALESCE(h.body->>'body', '') ~* ${GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS.ownerWalled}
                 AND COALESCE(h.body->>'body', '') ~* ${GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS.killed}
               )
             )
        ) hm ON true
       WHERE m.mode = 'goal' AND m.subject IS NOT NULL
         ${
           filter
             ? sql`AND m.workspace_id = ${filter.workspaceId} AND m.owner_id = ${filter.ownerId} AND m.subject = ${filter.goalId}`
             : sql``
         }`;
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      goalId: r.goal_id,
      agentId: r.owner_id,
      standing: r.standing,
      baselineTsMs: Number(r.baseline_ts_ms),
      lastReportTsMs: r.last_report_ts_ms === null ? null : Number(r.last_report_ts_ms),
    }));
  };
}

async function defaultEscalate(alert: GoalOwnerReportAlert): Promise<{ coalesced: boolean }> {
  const silentHours = Math.round((alert.silentMs / 3600_000) * 10) / 10;
  const floorLabel = alert.standing
    ? `${alert.floorMs / 3600_000}h — the STANDING-goal steward cadence (WI-2091959)`
    : `${alert.floorMs / 3600_000}h`;
  const result = await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal-mode owner ${alert.agentId} is report-silent on active goal '${alert.goalId}' — ` +
      `past the cadence floor with no report on any measured rail (coord:escalate / ` +
      `notifyAttention / coord:send to human)`,
    body:
      `Session ${alert.agentId}, registered in GOAL mode on active goal '${alert.goalId}' ` +
      `(workspace ${alert.workspaceId}), has produced no owner report for ~${silentHours}h ` +
      `(floor: ${floorLabel}; last reference ` +
      `${new Date(alert.referenceTsMs).toISOString()}).\n\n` +
      `The GOAL contract's reporting clause: "REPORT on a standing cadence via ` +
      `coord:escalate / notifyAttention: what moved, what it cost, what is owner-walled, ` +
      `and what you killed. Without it the owner learns goal state only by asking." The ` +
      `measured failure this instrument closes (WI-39348): exemplary reporting for 2.5h, ` +
      `then 5h of silence including at goal-met.\n\n` +
      `Remedy (subject ${alert.agentId}): send the report now on the contract's rail — ` +
      `the directed wake accompanying this escalation carries the skeleton. A report on ` +
      `any measured rail clears the condition; this escalation coalesces (never ` +
      `re-wakes) until then.`,
    meta: {
      // WI-7353: the signature carries NO duration or timestamp — one silence,
      // one row, however many ticks observe it.
      dedupKind: 'goal-owner-report-overdue',
      subjectSignature: `${alert.workspaceId}:${alert.goalId}:${alert.agentId}`,
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      subjectAgentId: alert.agentId,
      referenceTs: new Date(alert.referenceTsMs).toISOString(),
      silentMs: alert.silentMs,
    },
  });
  return { coalesced: Boolean((result as { coalesced?: boolean } | null)?.coalesced) };
}

async function defaultNudge(alert: GoalOwnerReportAlert): Promise<void> {
  const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
  const silentHours = Math.round((alert.silentMs / 3600_000) * 10) / 10;
  await wakeRecipients([alert.agentId], {
    summary:
      `goal-owner-report: goal '${alert.goalId}' has had no owner report for ~${silentHours}h — ` +
      `send one now (skeleton in payload): what moved, what it cost, what is owner-walled, what you killed`,
    payload: {
      goalId: alert.goalId,
      agentId: alert.agentId,
      silentMs: alert.silentMs,
      referenceTs: new Date(alert.referenceTsMs).toISOString(),
      reportSkeleton: buildReportSkeleton(alert),
    },
    source: 'goal-owner-report-watchdog',
    workspaceId: alert.workspaceId,
  });
}

function sweepDeps(sql: Sql, overrides: Partial<GoalOwnerReportSweepDeps>): GoalOwnerReportSweepDeps {
  return {
    readGoalModeOwners: makeReadGoalModeOwners(sql),
    resolveLiveness: resolveHolderLiveness,
    escalate: defaultEscalate,
    nudge: defaultNudge,
    flagEnabled: defaultFlagEnabled,
    ...overrides,
  };
}

/**
 * One sweep. Per-alert containment like the family; the nudge is gated on the
 * escalation being NEWLY opened (one nudge per silence), so an escalate failure
 * skips the nudge for this tick — the deduped retry next tick is the recovery
 * path, and under-nudging beats a nag loop.
 */
export async function runGoalOwnerReportSweepOnce(
  sql: Sql,
  overrides: Partial<GoalOwnerReportSweepDeps> = {},
): Promise<{ scanned: number; overdue: number; nudged: number; skipped: boolean }> {
  const deps = sweepDeps(sql, overrides);
  if (!(await deps.flagEnabled())) {
    return { scanned: 0, overdue: 0, nudged: 0, skipped: true };
  }

  const rows = await deps.readGoalModeOwners();
  const candidates = findOverdueReports(rows, Date.now());
  let nudged = 0;
  if (candidates.length === 0) {
    return { scanned: rows.length, overdue: 0, nudged, skipped: false };
  }

  // The liveness gate — a degraded oracle read suppresses EVERY alert this tick
  // (unknown is not dead, and it is definitely not "nudge it"): the sibling rule.
  let verdicts: Map<string, LivenessVerdict>;
  try {
    verdicts = await deps.resolveLiveness([...new Set(candidates.map((a) => a.agentId))]);
  } catch {
    return { scanned: rows.length, overdue: candidates.length, nudged, skipped: false };
  }

  const alerts = candidates.filter((a) => {
    const v = verdicts.get(a.agentId);
    return v ? holderCountsAsAlive(v) : false;
  });

  for (const alert of alerts) {
    let opened = false;
    try {
      const { coalesced } = await deps.escalate(alert);
      opened = !coalesced;
    } catch (e) {
      console.warn(
        `[goal-owner-report-watchdog] escalate failed for ${alert.goalId}/${alert.agentId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!opened) continue; // coalesced repeat (or failed open): the one nudge already went out (or waits for the retry)
    try {
      await deps.nudge(alert);
      nudged += 1;
    } catch (e) {
      console.warn(
        `[goal-owner-report-watchdog] nudge failed for ${alert.goalId}/${alert.agentId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { scanned: rows.length, overdue: alerts.length, nudged, skipped: false };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the goal owner-report watchdog: a recurring process-level sweep. Idempotent.
 * Runtime gate: FLAGS.GOAL_OWNER_REPORT_WATCHDOG (checked per tick).
 */
export function startGoalOwnerReportWatchdog(sql: Sql, opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? GOAL_OWNER_REPORT_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'goal-owner-report-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runGoalOwnerReportSweepOnce(sql)
        .catch((e) => {
          console.warn(
            `[goal-owner-report-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // 'timeout-reaper' like its goal-watchdog siblings: no event fires when a
    // report DOESN'T happen — absence is only observable by a timed sweep.
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}
