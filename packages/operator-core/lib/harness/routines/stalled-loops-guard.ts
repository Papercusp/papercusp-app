/**
 * stalled-loops-guard — act on the `turnsStalled` signal instead of leaving a dead
 * loop armed indefinitely (WI-6639).
 *
 * THE GAP THIS CLOSES. `computeTurnsStalled` (loop.ts) already detects a loop that
 * is `active: true` (armed) but has stopped producing turns — fires keep landing (or
 * even the FIRES themselves have stopped) while no genuine turn completes. Before
 * this file, `turnsStalled`'s only consumer was the read-only `loop:status` tool: an
 * agent had to think to ask about ITS OWN loop, or a human had to eyeball the HUD, for
 * the signal to matter at all. Measured live 2026-07-28: 15 sessions carried an armed
 * loop with no tool call in 37h-158h, three of them for a session that had already
 * ENDED — the routine kept being scheduled against an owner that was gone, forever,
 * because nothing ever turned the switch off.
 *
 * WHY DISARM + BROADCAST, NOT DELETE. This is the coherence sibling of
 * `gc-dead-loops.ts`, not a replacement for it: `gc-dead-loops` reaps INACTIVE loop
 * rows whose owner has been silent past a long retention window (14d) — pure
 * space-reclamation on rows that are already known-dead. This module's job is
 * upstream of that: flip an armed-but-dead loop to `active: false` (mirroring
 * `autoPauseLoopRoutine`, the exact primitive the cost-cap and dead-man guards already
 * use — "the paused state IS the notification", per that module's own doc) so
 * `gc-dead-loops` can eventually reap the row, `loop:status` stops reporting a lie,
 * and the routines engine stops scheduling wakes nobody will ever answer. The
 * broadcast (reusing `severe-event-broadcast`, the same rail `green-stall-watchdog` /
 * `git-sync-stall-watchdog` use) is the ESCALATION half WI-6639 asked for: someone
 * running fleet-wide should learn that a batch of loops just went dark, because a
 * cluster of stalls (WI-6639's own sample clustered at ~47-48h and ~155-158h) is
 * usually ONE systemic event — a wedged wake channel, a deploy, an operator restart —
 * not N independent failures, and only a human/fleet-wide read can chase that down.
 *
 * SAFETY. Reuses `computeTurnsStalled` UNCHANGED (loop.ts) via `getLoopStatuses` — the
 * exact same conservative verdict `loop:status` already reports (≥3 fires required,
 * a generous multiple-of-interval floor, exempt whenever the session shows real
 * presence activity). This module adds no new judgement of its own; it only acts on
 * a verdict that was already being computed and silently ignored.
 *
 * SECOND-SOURCE VETO (EI-19362678179163398). The paragraph above was true when this module
 * only READ a verdict; it is not sufficient now that the module ACTS on one. `turnsStalled`
 * rests on a single column, `last_turn_at`, which has under-reported TWICE — WI-6069 (the
 * lifecycle 'ended' marker is never written by a warm loop) and its follow-up (the journal
 * leg covers ~2.3% of real turns) — and both times the failure direction was a healthy,
 * actively-working agent reading as stalled. Measured 2026-08-02 against the live fleet on
 * the pre-fix column: 7 owners would have been disarmed while each had produced a real
 * assistant turn within the previous ~5 minutes. So this module now cross-checks the
 * INDEPENDENT strict signal (`lastRealTurnAt`) before every disarm and refuses when a real
 * turn landed inside the verdict's own floor, surfacing the refusals as
 * `vetoedByRecentTurn`. The data bug is fixed; the rail exists because the NEXT regression
 * in that column would otherwise mass-disarm the fleet, and a disarmed agent cannot
 * re-arm itself.
 *
 * TWO FAULTS, OPPOSITE REMEDIES (EI-19406534159939583). The veto above is a rail against bad
 * DATA. This is a correction to the module's LOGIC: it acted on one verdict that named two
 * different faults, and its own broadcast text said the quiet part out loud: "fires kept landing
 * (OR STOPPED ENTIRELY) with no turn actually produced". Fires LANDING with no turn behind them
 * is evidence about the AGENT. Fires STOPPING is evidence about the FIRING PATH, and the agent
 * underneath may be perfectly alive — asleep, waiting for the wake that never came. Disarming
 * that agent is the worst available move: it cannot re-arm itself, and `reconcileLoopRoutines`
 * gates its re-arm sweep on `active = TRUE` (reconcile-loop-routines.ts:726), so the one
 * mechanism that exists to rescue a stuck loop can never see it again. Measured live 2026-08-03:
 * 5 of a 10-member drain fleet disarmed in a single 23ms batch, each having answered every fire
 * it received; the fleet did the work of one for ~45 minutes against a 1775-item backlog.
 *
 * WHY THE SPLIT LIVES HERE AND NOT IN THE VERDICT. The obvious discriminator — did the last turn
 * land after the last fire? — is NOT sufficient alone, and that is the trap worth naming:
 * WI-6639's measured 156h corpses show exactly the same ordering (last turn ~4 min after the
 * last fire, then silence), which is why `computeTurnsStalled`'s frozen-gap regression test
 * asserts `true` for that shape. Presence does not separate them either — a live agent parked on
 * an event beats no heartbeat. The ONE signal that does is whether the owner is still REACHABLE,
 * and that is an I/O probe a pure verdict cannot make. So the verdict keeps claiming both
 * populations (honest for `loop:status`) and the ACTOR — this module, the one doing the
 * irreversible write — consults `probeWakeReachability` before disarming and RE-ARMS a reachable
 * owner instead. Same oracle `reconcileLoopRoutines` already trusts for "a live owner is NEVER
 * terminated, any dwell": one oracle for "is this owner gone", not two that can disagree.
 *
 * The remaining guess is deliberately biased. A wrong RE-ARM costs one extra fire and
 * self-corrects on the very next sweep — the fire lands, no turn follows, the disarm happens
 * then. A wrong DISARM is permanent. When the evidence is ambiguous, take the reversible mistake.
 *
 * A FOURTH POPULATION: WAKE-STARVED (WI-36685). The split above asks whether the FIRES stopped.
 * It does not ask the next question down: whether a fire that DID happen reached anyone. A wake
 * emits on `coord:inbox-wake:<owner>`; with no standing await registered there it matches nothing
 * and no `event_wake_deliveries` row is created at all — so the agent sleeps on, never having been
 * spoken to, and its `last_turn_at` goes stale for the one reason this module never considered:
 * nobody asked it for a turn. Every exemption above correctly declines (no recent turn, no
 * provider wall, and the fires did NOT stop, so `answeredItsLastFire` is false), and it takes the
 * permanent disarm. Measured on su-4a6e2255, twice in one day, the second time for 2h44m with
 * ZERO delivery rows while fires advanced — disarmed at 22:07:36Z and dark until a human typed
 * into it. Note this module's own OWNER page (EI-19899301656065801) is what should have covered
 * the gap and could not: it fires AFTER the disarm, and its rail writes no durable record
 * (WI-36644).
 *
 * The discriminator costs no new I/O — `lastWakeAt` is DERIVED as
 * COALESCE(delivered_at, created_at) over this routine's own delivery rows (loop.ts:1069), so a
 * created-but-undelivered row would still advance it and a frozen value under an advancing
 * `lastFiredAt` can only mean no row was created. What it CANNOT be keyed on is `reachable`:
 * `deriveWakeReachability`'s Gate 1 returns before consulting any liveness signal, so a
 * wake-starved owner is unreachable by construction and reads identically to a corpse. That
 * conflation is fixed at the source — the verdict now also reports `awaitRepairable` — and it is
 * the gate that keeps a genuine corpse (whose await was cancelled at SessionEnd, giving it the
 * same frozen `lastWakeAt`) on the disarm path.
 *
 * ⚠ The remedy here is TWO writes, not one: `rearmFireStarvedLoop` moves `next_fire_at` and
 * nothing else, so on this population it fires straight back into the same hole. The standing
 * watch must be re-armed FIRST (`armInboxWake` — what `loop:arm` itself does); the nudge only
 * decides when the now-deliverable fire happens.
 *
 * A FIFTH POPULATION, AND THE DOOR ITSELF (WI-37546). Every exemption above asks a question about
 * the DELIVERY PATH — did a turn land, is a wall up, did a fire go out, did a wake reach anyone.
 * None asks the simplest liveness question there is: IS THIS OWNER STILL MAKING TOOL CALLS? An
 * agent issuing tool calls is not wedged, whatever the turn tracker says, and `harness_shared`
 * has recorded every one of those calls all along (`tool_invocations.coord_owner_id`, with a
 * dedicated index).
 *
 * Measured 2026-08-09 on this workspace, the census D-006 of plan
 * fleet-lead-instrumentation-audit-2026-08-09 mandated before any fix was written: of the 19
 * loops disarmed by this module that day, **18 owners were making tool calls in the hour BEFORE
 * their disarm**, and all 19 made calls after. Zero corpses. One of them was the leader of a
 * 10-member fleet: its reaping at 17:07Z is why an owner directive typed at 16:20Z sat
 * unexecuted for 1h45m — nothing could re-wake it.
 *
 * THE CONTROL THAT MAKES THAT A FINDING RATHER THAN A CORRELATION. The same module's OTHER
 * verdict path, the `dead-owner:` disarm, ran 7 times that day and was **7/7 correct** — every
 * one of those owners made zero calls afterwards. Same table, same signal, same sweep window.
 * So `tool_invocations` is not an unreliable signal and the reaper concept is not broken: the
 * defect is specific to the `turns-stalled` INFERENCE, which reads absence-of-recorded-turns as
 * wedged. The `dead-owner` path is deliberately left untouched by everything below.
 *
 * ⚠ WHY THE VETO NEEDS A PROGRESS TERM, NOT CALL VOLUME. D-006's own test is "what ELSE
 * converges on this signal's steady state?", and raw volume has an obvious convergent
 * population: an agent stuck in a tight tool-call RETRY loop hammers one tool forever and would
 * look alive forever. So the term is PROGRESS — a second distinct tool, or at least one call
 * that actually succeeded — which a single-tool error storm cannot satisfy. It is bounded a
 * second way by `TOOL_LIVENESS_VETO_CEILING_MS`: an owner that makes progressing calls yet
 * completes NO turn for hours is pathological by any reading and eventually falls through.
 *
 * AND THE DOOR: A DISARM IS NOW RECOVERABLE (WI-37546, sub-case B). The veto above fixes the 18;
 * it CANNOT fix the 19th, and that one matters most. An owner that is genuinely quiet at the
 * moment of judgement — the fleet leader was, its turn having timed out — is correctly read as
 * stalled, and the disarm is defensible. What is NOT defensible is that the disarm was
 * PERMANENT: it converts a transient stall into an indefinite halt, because the agent cannot
 * re-arm itself and `reconcileLoopRoutines` only ever looks at `active = TRUE` rows. So this
 * sweep now opens with a REVIVAL pass: a loop THIS module disarmed as turn-stalled, whose owner
 * has since made progressing tool calls, is re-armed. The disarm becomes a pause with a
 * condition instead of a one-way door — which is what a wrong verdict is allowed to be.
 *
 * The revival is bounded on four axes so it cannot become a resurrection engine: only rows
 * carrying THIS module's own turns-stalled pause reason (never the `dead-owner` path, never a
 * cost-cap or dead-man pause), only inside `REVIVE_WINDOW_MS`, only `MAX_REVIVALS` times per
 * loop — a loop that keeps needing revival is a real fault, and the ratchet is what makes it
 * stay down and stay visible rather than flapping — and only while this module's disarm is still
 * the transition that put the loop down: a row armed AFTER the pause instant was superseded by
 * its owner (re-arm, and possibly an explicit `loop:end` after that), and reviving it would undo
 * an owner decision rather than correct this module's own wrong verdict.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  CARRY_NOTE_BOOKKEEPING_TOOL_NAMES,
  agentToolInvocationPredicate,
} from '../../agent-tools/sessions/automatic-tool-names';
import {
  getLoopStatuses,
  turnsStalledFloorMs,
  rearmFireStarvedLoop,
  reviveDisarmedLoop,
  computeLifecycleBackoff,
  computeCadenceDrift,
  type LoopStatus,
} from './loop';
import { autoPauseLoopRoutine } from './loop-cost-cap';
import { probeWakeReachability, type WakeReachabilityVerdict } from '../../events/await/wake-reachability';
import type { AttentionNotifyInput } from '../../attention-notify';
import { broadcastSevereEvent } from '../../severe-event-broadcast';

/**
 * WI-37546 — the EXACT prefix this module writes onto a routine it disarms as turn-stalled, and
 * the predicate the revival pass selects on.
 *
 * ONE constant, used by both the write and the read, because the two halves are only correct
 * relative to each other: a revival query keyed on a hand-typed copy of this string silently
 * matches NOTHING the day the reason is reworded, and a revival pass that matches nothing looks
 * exactly like a revival pass that found nobody to revive. (`stalled-loops-guard-revival.test.ts`
 * asserts the disarm reason this module actually writes is selected by the predicate it actually
 * queries with, so the pairing is checked behaviourally rather than by eye.)
 *
 * It deliberately names the TURN-STALLED disarm only. The `dead-owner` verdict — a different
 * write site, measured 7/7 CORRECT on the same day this module measured 18/19 wrong — must never
 * be revived by this pass, and the narrow prefix is what guarantees that structurally rather
 * than by intent.
 */
export const TURN_STALLED_PAUSE_PREFIX = 'stalled-loops-guard (WI-6639): turns-stalled:';

/**
 * WI-37546 — how long an owner that is making PROGRESSING tool calls but completing no turn
 * keeps its veto before falling through to the (now revivable) disarm.
 *
 * This is the answer to D-006's convergence test. The veto's other bound is self-limiting by
 * construction — an owner that truly goes comatose stops making calls, and the veto stops
 * matching on the very next sweep — but the eternal-spinner shape (an agent looping on tool
 * calls forever without ever completing a turn) does NOT self-limit, and without a ceiling this
 * exemption would hold on it indefinitely. Six hours is far beyond any legitimate single turn
 * here; past it, "still calling tools" has stopped being evidence of progress.
 *
 * The ceiling is only reachable when the last completed turn is KNOWN. An owner with no turn
 * history at all is unknown, not old, and takes the veto — the module's governing asymmetry (a
 * wrong veto costs one sweep, a wrong disarm is permanent) decides every uncertain read.
 */
export const TOOL_LIVENESS_VETO_CEILING_MS = 6 * 60 * 60 * 1000;

/**
 * WI-37546 — how long after a turn-stalled disarm a loop stays revivable.
 *
 * Bounds the pass to the window in which a revival is plausibly the RIGHT answer. Past it, a
 * silent loop is old news: `gc-dead-loops` owns the row, and re-arming a day-old disarm on the
 * strength of a single tool call would be resurrecting sessions the fleet has moved on from.
 */
export const REVIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * WI-37546 — how many times ONE loop may be revived after a turn-stalled disarm.
 *
 * The flap bound. A loop that is disarmed, revived, and disarmed again is telling us the
 * revival was wrong; the counter is a ratchet (`reviveDisarmedLoop` never resets it), so after
 * this many attempts the loop stays down and stays visible as a repeat offender rather than
 * cycling between the two writes forever.
 */
export const MAX_REVIVALS = 2;

/** P-007 — the behavior window used by the workspace-level starvation census. */
export const LOOP_POPULATION_TOOL_WINDOW_MS = 3 * 60 * 60 * 1000;
/** A ratio is not meaningful enough to page below this active-loop population. */
export const LOOP_POPULATION_MIN_ACTIVE = 10;
/** Never page on a ratio backed by fewer than this many affected owners. */
export const LOOP_POPULATION_MIN_AFFECTED = 5;
/** At least half of the parked population must have produced no agent-authored call. */
export const LOOP_POPULATION_ZERO_TOOL_RATIO = 0.5;
const LOOP_POPULATION_OWNER_SAMPLE_LIMIT = 10;

/**
 * P-007 — one workspace-wide loop census.
 *
 * `unknown` is deliberately a first-class result rather than an empty measured population. A
 * failed advisory read must never disable the existing reaper, but reporting its failure as
 * zero would make the population detector look healthy at exactly the moment it went blind.
 */
export type LoopPopulationSnapshot =
  | {
      status: 'measured';
      active: number;
      parked: number;
      /** `parked / active`; null only for an empty active population. Context, never the alarm gate. */
      parkedRatio: number | null;
      /** Parked owners with no agent-authored, non-bookkeeping tool call in the last three hours. */
      parkedZeroTool3h: number;
      /** `parkedZeroTool3h / parked`; null only when no loop is parked. */
      parkedZeroToolRatio: number | null;
      ownerSample: string[];
    }
  | {
      status: 'unknown';
      reason: string;
    };

/**
 * P-007 — the pure population verdict.
 *
 * The parked share is diagnostic context, not a fault: a long-running turn parks its loop at
 * `infinity` by design. The incident discriminator is a LARGE share of those parked owners all
 * producing zero agent-authored calls at once. Both absolute floors prevent tiny populations
 * from satisfying a ratio vacuously.
 */
export function isLoopPopulationStarvation(
  snapshot: LoopPopulationSnapshot,
): snapshot is Extract<LoopPopulationSnapshot, { status: 'measured' }> {
  return (
    snapshot.status === 'measured' &&
    snapshot.active >= LOOP_POPULATION_MIN_ACTIVE &&
    snapshot.parkedZeroTool3h >= LOOP_POPULATION_MIN_AFFECTED &&
    snapshot.parkedZeroToolRatio != null &&
    snapshot.parkedZeroToolRatio >= LOOP_POPULATION_ZERO_TOOL_RATIO
  );
}

function populationCount(value: unknown, field: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`invalid ${field} from loop population query: ${String(value)}`);
  }
  return count;
}

/**
 * P-007 — one aggregate read for the whole active loop population in a workspace.
 *
 * Active routines are collapsed by owner before counting. That makes the invariant about agents,
 * not rows, and keeps a transient duplicate from inflating both numerator and denominator. Tool
 * activity is intentionally NOT workspace-scoped: owner identity is global, and an owner making
 * real calls under another workspace is demonstrably not a zero-tool owner. The loop population
 * itself remains tenant-scoped through `r.workspace_id`.
 *
 * This reader throws on SQL or shape failure. The sweep catches it into an explicit `unknown`
 * snapshot in an isolated advisory leg, so it can never short-circuit the existing reaper.
 */
export async function readLoopPopulationSnapshot(o: {
  sql: Sql;
  workspaceId: string;
  sinceMs?: number;
  ownerSampleLimit?: number;
}): Promise<LoopPopulationSnapshot> {
  const sinceMs = o.sinceMs ?? Date.now() - LOOP_POPULATION_TOOL_WINDOW_MS;
  if (!Number.isFinite(sinceMs)) throw new Error(`invalid loop population sinceMs: ${String(sinceMs)}`);
  const sampleLimit = Math.max(1, Math.floor(o.ownerSampleLimit ?? LOOP_POPULATION_OWNER_SAMPLE_LIMIT));
  const sinceIso = new Date(sinceMs).toISOString();
  const rows = await o.sql<
    Array<{
      active_loops: number | string;
      parked_loops: number | string;
      parked_zero_tool_3h: number | string;
      owner_sample: string[] | null;
    }>
  >`
    WITH active_loops AS (
      SELECT r.target_owner_id AS owner_id,
             bool_or(r.next_fire_at = 'infinity'::timestamptz) AS parked
        FROM harness_shared.routines r
       WHERE r.workspace_id = ${o.workspaceId}
         AND r.name LIKE 'loop-%'
         AND r.target_owner_id IS NOT NULL
         AND r.active = true
       GROUP BY r.target_owner_id
    ), recent_agent_tool_owners AS (
      SELECT DISTINCT t.coord_owner_id AS owner_id
        FROM harness_shared.tool_invocations t
        JOIN active_loops l ON l.owner_id = t.coord_owner_id
       WHERE t.invoked_at >= ${sinceIso}::timestamptz
         AND ${agentToolInvocationPredicate(o.sql, 't')}
         AND t.tool_name <> ALL(${o.sql.array([...CARRY_NOTE_BOOKKEEPING_TOOL_NAMES])}::text[])
    ), classified AS (
      SELECT l.owner_id,
             l.parked,
             (a.owner_id IS NULL) AS zero_tool
        FROM active_loops l
        LEFT JOIN recent_agent_tool_owners a USING (owner_id)
    )
    SELECT count(*)::int AS active_loops,
           count(*) FILTER (WHERE parked)::int AS parked_loops,
           count(*) FILTER (WHERE parked AND zero_tool)::int AS parked_zero_tool_3h,
           ARRAY(
             SELECT owner_id
               FROM classified
              WHERE parked AND zero_tool
              ORDER BY owner_id
              LIMIT ${sampleLimit}
           ) AS owner_sample
      FROM classified
  `;
  const row = rows[0];
  if (!row) throw new Error('loop population query returned no aggregate row');
  const active = populationCount(row.active_loops, 'active_loops');
  const parked = populationCount(row.parked_loops, 'parked_loops');
  const parkedZeroTool3h = populationCount(row.parked_zero_tool_3h, 'parked_zero_tool_3h');
  if (parked > active || parkedZeroTool3h > parked) {
    throw new Error(
      `inconsistent loop population query: active=${active}, parked=${parked}, parkedZeroTool3h=${parkedZeroTool3h}`,
    );
  }
  return {
    status: 'measured',
    active,
    parked,
    parkedRatio: active > 0 ? parked / active : null,
    parkedZeroTool3h,
    parkedZeroToolRatio: parked > 0 ? parkedZeroTool3h / parked : null,
    ownerSample: Array.isArray(row.owner_sample)
      ? row.owner_sample.filter((owner): owner is string => typeof owner === 'string' && owner.length > 0)
      : [],
  };
}

/**
 * Keep database read failures fail-soft, but never turn a programmer/driver-surface error into
 * an empty activity map. A TypeError or ReferenceError means the reader itself is broken (for
 * example, a malformed SQL double or a missing driver method), and swallowing it disables the
 * liveness veto while making the sweep look healthy.
 */
function rethrowProgrammingError(error: unknown): void {
  if (error instanceof TypeError || error instanceof ReferenceError) throw error;
}

/**
 * WI-37546 — one owner's recent tool-call activity, as the liveness veto and the revival pass
 * both read it.
 *
 * Deliberately more than a count: `calls` alone is the measure D-006 warned against, since a
 * retry storm maximises it. The other three fields are what let {@link isProgressingToolActivity}
 * separate work from spinning.
 */
export interface OwnerToolActivity {
  /** Total calls in the window. Never the sole basis for a verdict — see the interface doc. */
  calls: number;
  /** Distinct `tool_name`s in the window. A retry storm converges on 1. */
  distinctTools: number;
  /** Calls with `status = 'ok'`. A storm of `harness_forbidden` / errors converges on 0. */
  okCalls: number;
  /** ISO timestamp of the most recent call, for the log/reason text. */
  lastCallAt: string | null;
}

/**
 * WI-37546 — is this activity evidence of an agent WORKING, as opposed to an agent SPINNING?
 *
 * Exported and pure so the judgement can be tested directly, rather than only through a sweep
 * that has to be stood up around it.
 *
 * A second distinct tool, or a single successful call. Both are cheap for a working agent to
 * satisfy and neither is reachable by the convergent population D-006 named: an agent stuck
 * retrying ONE failing tool produces `distinctTools === 1` and `okCalls === 0` no matter how
 * many thousands of calls it makes.
 *
 * ⚠ Do NOT "simplify" this to `calls > 0`. That is the exact measure the census could not
 * distinguish from a retry loop, and the reason this fix was filed rather than hot-patched.
 */
export function isProgressingToolActivity(activity: OwnerToolActivity | undefined | null): boolean {
  if (!activity || activity.calls <= 0) return false;
  return activity.distinctTools >= 2 || activity.okCalls >= 1;
}

export interface StalledLoopsSweepDeps {
  /** Injectable for tests; defaults to the real batch status read. */
  getStatuses?: typeof getLoopStatuses;
  /** Injectable for tests; defaults to the real auto-pause write. */
  autoPause?: typeof autoPauseLoopRoutine;
  /** Injectable for tests; defaults to the real re-arm write (EI-19406534159939583). */
  rearm?: typeof rearmFireStarvedLoop;
  /**
   * Injectable for tests; defaults to the real UN-disarm write (WI-37546).
   *
   * Separate from `rearm` and not a variant of it: `rearmFireStarvedLoop` is guarded
   * `AND active = TRUE` and so is a no-op on exactly the population this one exists for. This is
   * the only write in the module that crosses back over `active = FALSE`.
   */
  revive?: typeof reviveDisarmedLoop;
  /**
   * Injectable for tests; defaults to one indexed read of `harness_shared.tool_invocations`
   * (WI-37546).
   *
   * Answers "has this owner been making progressing tool calls since <its own boundary>?" —
   * the liveness question no other exemption in this module asks. The boundary is PER OWNER (a
   * stalled loop's last fire; a disarmed loop's pause time), which is why the probes arrive as
   * pairs rather than as a list plus one shared `since`.
   *
   * NOT dynamically imported and NOT one query per owner: it is a single `unnest`-joined SELECT
   * over `tool_invocations_coord_owner_idx (coord_owner_id, invoked_at DESC)` for the whole
   * sweep, on a connection this sweep already holds.
   *
   * Deliberately NOT workspace-scoped. The question is whether the AGENT is alive, and an owner
   * doing work under another workspace is alive; scoping would turn a cross-workspace session
   * into a corpse on a technicality — which is precisely the failure mode
   * EI-19966210024116714 documents from the other side.
   *
   * Returns a Map keyed by ownerId. An owner ABSENT from the map has NO qualifying activity —
   * callers must treat a read FAILURE as absent too (fail toward the pre-existing behaviour, not
   * toward a blanket veto), which is why the default catches into an empty map at the call site.
   */
  readOwnerToolActivity?: (
    probes: Array<{ ownerId: string; sinceIso: string }>,
    o: { sql: Sql },
  ) => Promise<Map<string, OwnerToolActivity>>;
  /**
   * P-007 — injectable workspace-wide population census. It is an advisory leg and is caught
   * independently: failure produces `population.status = 'unknown'` and never changes whether
   * any loop is reaped, revived, repaired, or vetoed.
   */
  readPopulation?: typeof readLoopPopulationSnapshot;
  /**
   * Injectable for tests; defaults to a plain read of `harness_shared.routines` (WI-37546).
   *
   * The revival pass's candidate set: loops THIS module disarmed as turn-stalled, recently
   * enough to still be revivable and not already at the revival ceiling. Every bound is applied
   * in SQL so the pass cannot accidentally widen — in particular the pause-reason predicate,
   * which is what keeps the 7/7-correct `dead-owner` disarms (and cost-cap / dead-man pauses)
   * structurally out of reach.
   */
  readRevivableLoops?: (o: {
    sql: Sql;
    workspaceId: string;
    pausedAfterMs: number;
    maxRevivals: number;
  }) => Promise<Array<{ routineId: string; ownerId: string; pausedAtMs: number; revivedCount: number }>>;
  /** Injectable for tests; defaults to the real wake-reachability probe — the SAME oracle
   *  reconcileLoopRoutines uses to refuse terminating a live owner (EI-19406534159939583). */
  probeReachability?: typeof probeWakeReachability;
  /**
   * Injectable for tests; defaults to a plain read of `harness_shared.session_briefs`
   * (EI-19966210024116714).
   *
   * Answers "which workspace does this owner's own SESSION resolve to?" — the discriminator for
   * the cross-workspace scope strand. A loop routine on workspace X whose owner session scopes to
   * workspace Y is armed against a harness that session cannot address: every harness-scoped call
   * it makes returns `harness_forbidden`, so its fires land, it cannot do the work it was woken
   * for, and no turn follows.
   *
   * NOT dynamically imported (contrast `armWake`/`notify`): this is one indexed SELECT against a
   * connection this sweep already holds, not a transport with machinery to keep off the hot path.
   *
   * Returns a Map keyed by ownerId. An owner ABSENT from the map is UNKNOWN, never "mismatched" —
   * callers fail OPEN on absence.
   */
  resolveOwnerWorkspaces?: (ownerIds: string[], o: { sql: Sql }) => Promise<Map<string, string>>;
  /**
   * Injectable for tests; defaults to the real standing-await (re-)arm (WI-36685).
   *
   * The REPAIR half of the wake-starved branch, and it has to be a separate write from
   * `rearm`: `rearmFireStarvedLoop` only nudges `next_fire_at`, so on a loop whose fires are
   * black-holing for want of a standing await it would fire straight back into the same hole.
   * Arming the watch is what actually restores delivery — the same call `loop:arm` makes
   * (agent-tools/loop/arm.ts:732).
   *
   * Dynamically imported at call time for the same reason `notify` is: this sweep runs on
   * every routine tick and must not carry the await/handle-capture machinery just to repair
   * the rare wake-starved loop.
   */
  armWake?: (input: { ownerId: string; note?: string | null }) => Promise<unknown>;
  /** Injectable for tests; defaults to the real fleet-wide broadcast. */
  broadcast?: typeof broadcastSevereEvent;
  /**
   * Injectable for tests; defaults to the real OWNER page (EI-19899301656065801).
   *
   * Imported dynamically at call time rather than statically, matching
   * `stale-routine-executor-watchdog.ts`: `attention-notify` pulls in the push/SSE
   * transports, and this sweep must not carry them on every routine tick just to
   * page on the rare disarm. The type-only import above is erased at runtime.
   */
  notify?: (input: AttentionNotifyInput) => Promise<void>;
}

export interface StalledLoopsSweepResult {
  /** How many active loop-% routines were examined. */
  checked: number;
  /** How many were disarmed (or, under dryRun, matched) this pass. */
  paused: number;
  /** A sample of the disarmed ownerIds, for the log line / broadcast. */
  sample: string[];
  /**
   * EI-19362678179163398: owners whose verdict was `turnsStalled:true` but which this
   * module REFUSED to disarm because they had produced a real assistant turn inside the
   * veto window. A non-zero count here is a live signal that the verdict's `last_turn_at`
   * source is under-reporting again — it should normally be 0.
   */
  vetoedByRecentTurn: string[];
  /**
   * EI-19406534159939583: owners whose loop was FIRE-starved rather than turn-stalled — the
   * agent answered the last fire it received and then no further fire arrived. These are
   * RE-ARMED, never disarmed: the fault is in the firing path, and disarming would be
   * irreversible (the reconciler's re-arm sweep gates on `active = TRUE`). A non-zero count
   * is an INFRASTRUCTURE signal — the loop-fire path stopped serving live agents — and is
   * worth chasing even though no agent is at fault.
   */
  reArmedFireStarved: string[];
  /**
   * EI-19441932615368003: owners whose verdict was `turnsStalled:true` but which this module
   * refused to disarm because their last fire died on a PROVIDER WALL and the lifecycle-death
   * backoff has them parked on a still-future `next_fire_at`. They are waiting out a transient
   * capacity condition, not wedged.
   *
   * A persistently NON-EMPTY list here is normal under load and is NOT a fault — it is the
   * measure of how much silent halting this exemption is preventing. A sustained ZERO on a
   * workspace that is hitting usage walls means the exemption has stopped matching (a changed
   * outcome prefix, a backoff that no longer sets next_fire_at) and walled loops are being
   * disarmed again.
   */
  vetoedByProviderWall: string[];
  /**
   * EI-19899301656065801: the subset of `stalledOwners` that was still answering a reachability
   * probe at the moment it was disarmed — i.e. present sessions made permanently unwakeable, as
   * opposed to the corpses WI-6639 was built to reap. This is the population the owner is paged
   * about, and the only one for which the disarm destroys something recoverable.
   *
   * Expected to be EMPTY on a healthy workspace: a reachable session that stops taking turns is
   * itself a fault (a died carry-respawn, a wedged CLI child). A persistently non-empty list is
   * a signal about session liveness upstream, not about this sweep.
   */
  disarmedWhileReachable: string[];
  /**
   * WI-36685: owners whose loop was WAKE-starved — the routine kept firing, but each fire found
   * no standing `coord:inbox-wake` await, so `wake()` matched nothing, NO `event_wake_deliveries`
   * row was ever created, and the agent was never actually spoken to. It has no recent turn
   * because it was never asked for one.
   *
   * These are REPAIRED (the watch is re-armed, then the loop is made due) and never disarmed —
   * but only when the session is otherwise live (`awaitRepairable`), which is what keeps a
   * genuine corpse, whose await was cancelled at SessionEnd and which shows the SAME frozen
   * `lastWakeAt`, on the disarm path where it belongs.
   *
   * A non-zero count is an INFRASTRUCTURE signal about the wake-delivery path, not about the
   * agent — a sibling of `reArmedFireStarved`, one layer further down: there the fires stopped,
   * here they continued and landed nowhere.
   */
  repairedWakeStarved: string[];
  /**
   * WI-36792: owners whose MOST RECENT fire was never sent at all — the fire gate WITHHELD it
   * (`lastWithheldAt >= lastFiredAt`) while the session was still reachable. They read as
   * wake-starved for the same mechanical reason as `repairedWakeStarved` (a withheld fire
   * creates no `event_wake_deliveries` row, so `lastWakeAt` freezes under an advancing
   * `lastFiredAt`) but there is nothing to repair: the standing await is intact and the session
   * is live. Nothing is wrong with the agent — it was simply never asked for a turn.
   *
   * VETOED, not repaired and not re-armed: the gate's backoff is a deliberate cadence and this
   * module has no business overwriting it (the same "leave it alone" reasoning as
   * `vetoedByProviderWall`). Re-arming a withheld PARKED loop belongs to reconcileLoopRoutines'
   * `gate-backoff` rebase, which honours `retryAfterSec`.
   *
   * A non-zero count is a signal about the FIRE GATE, not the agent — the circuit is denying
   * fires to a live session. Sustained non-zero means the backoff is not clearing.
   */
  vetoedByWithheldFire: string[];
  /**
   * EI-19966210024116714: the subset of `stalledOwners` whose loop is armed against a harness
   * their OWN session scope cannot address. The routine sits on workspace X while the owner's
   * `session_briefs` row resolves to workspace Y, so every harness-scoped call that session makes
   * comes back `harness_forbidden`. Fires land, the agent cannot reach the work it was woken for,
   * no turn follows, and the ordinary turn-stalled verdict reaps it.
   *
   * DISARMED, like the rest of `stalledOwners`, and correctly so — by the same reasoning as the
   * corpse case, more fires will not help a loop whose harness is unreachable. What this
   * population exists for is the REASON. Without it the disarm records a generic
   * "turns-stalled: N fire(s), last turn never" notice that states the symptom and hides the
   * cause, and the remedy every other surface prints — "re-arm with loop:arm" — silently
   * re-creates the identical hole, because re-arming does not change the session's scope.
   *
   * Overlaps `disarmedWhileReachable` BY DESIGN: a scope-stranded session is typically alive and
   * answering probes — it is not wedged, it simply cannot reach its own harness — so most members
   * appear in both lists. Neither is a partition of the other, and neither count subtracts from
   * `paused`.
   *
   * A small non-zero count is EXPECTED on a workspace whose sessions self-relaunch: measured
   * 2026-08-09, 2 of 28 active loop owners carried the strand. A sustained RISE means the upstream
   * scope-resolution fault is worsening — `loop:arm`'s own `harness_workspace_mismatch` guard
   * (agent-tools/loop/arm.ts) refuses to CREATE a new strand, so a rise means sessions are losing
   * their scope AFTER arming. A drop to ZERO on a workspace known to carry strands means the
   * discriminator stopped matching, not that the fault was fixed.
   */
  disarmedUnaddressableHarness: string[];
  /**
   * WI-37546: owners whose verdict was `turnsStalled:true` but which this module refused to
   * disarm because they were still making PROGRESSING tool calls since their last fire — a
   * second distinct tool, or at least one call that succeeded. An agent issuing tool calls is
   * not wedged, whatever the turn tracker says.
   *
   * Expected to be the LARGEST veto population on a busy workspace, and that is the finding, not
   * a fault: measured 2026-08-09, 18 of 19 turn-stalled disarms that day had this evidence
   * available and nothing was reading it. Like `vetoedByProviderWall`, its diagnostic value is
   * INVERTED — a sustained ZERO on a workspace whose agents are demonstrably working means the
   * activity read has stopped matching (a renamed column, an unattributed `coord_owner_id`, a
   * retention window that aged the rows out) and the false disarms have silently resumed.
   */
  vetoedByToolActivity: string[];
  /**
   * P-008: tool-live owners whose turn-stalled loop was still parked at the in-flight sentinel.
   *
   * A plain liveness veto prevents the destructive mistake (disarming a working owner), but it
   * leaves this population parked forever: no completion rebase moves `next_fire_at` off
   * infinity. These loops are made due immediately with the existing self-correcting re-arm
   * write. They are deliberately separate from `vetoedByToolActivity`, because "left alone" and
   * "repaired" are different outcomes and operators need to see which one occurred.
   */
  reArmedToolLiveParked: string[];
  /**
   * WI-37546: loops this module had ALREADY disarmed as turn-stalled and has now RE-ARMED,
   * because the owner made progressing tool calls after the disarm — i.e. the verdict was wrong
   * and the agent came back.
   *
   * This is the population the permanent disarm used to strand. It exists because the veto above
   * cannot help the one shape it does not cover: an owner genuinely quiet AT THE MOMENT OF
   * JUDGEMENT (a turn that timed out, a carry-respawn mid-flight) is correctly read as stalled,
   * and only recovers by being asked again.
   *
   * A non-zero count is a signal about THIS MODULE's verdict quality, not about the agents — each
   * entry is one disarm that should not have stood. Sustained non-zero means the turn-stalled
   * inference is still over-firing and the upstream question is why `last_turn_at` goes stale for
   * owners that are visibly working.
   */
  revivedAfterDisarm: string[];
  /**
   * Owners whose active loop has sustained configured-vs-observed cadence drift. This is an
   * advisory-only signal: unlike `paused`, it never changes routine state and never participates
   * in the `turnsStalled` disarm decision.
   */
  cadenceDrift: string[];
  /** P-007 workspace-wide population signal; explicit unknown on a failed census. */
  population: LoopPopulationSnapshot;
  dryRun: boolean;
}

/**
 * Sweep every ACTIVE `loop-%` routine in the workspace, disarm any whose
 * `computeTurnsStalled` verdict is true, and — if at least one was disarmed —
 * broadcast a single fleet-wide notice naming all of them (never one message per
 * loop, mirroring `broadcastSevereEventResolvedMany`'s "don't spam N inboxes for one
 * root cause" reasoning).
 *
 * Workspace-scoped, not harness-scoped, for the same reason `gc-dead-loops` is:
 * `loop-<ownerId>` rows are keyed by the session that armed them, not by the harness
 * it happens to be working in.
 */
export async function sweepStalledLoops(
  opts: { sql?: Sql; workspaceId?: string; dryRun?: boolean } = {},
  deps: StalledLoopsSweepDeps = {},
): Promise<StalledLoopsSweepResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const dryRun = opts.dryRun === true;
  const getStatuses = deps.getStatuses ?? getLoopStatuses;
  const autoPause = deps.autoPause ?? autoPauseLoopRoutine;
  const rearm = deps.rearm ?? rearmFireStarvedLoop;
  const revive = deps.revive ?? reviveDisarmedLoop;
  const probeReachability = deps.probeReachability ?? probeWakeReachability;
  // WI-37546 — one indexed read for the whole sweep. `unnest` pairs each owner with its OWN
  // boundary (last fire for a live candidate, pause time for a revival candidate), so the
  // per-owner `since` costs no extra round-trips. The join drives off
  // `tool_invocations_coord_owner_idx (coord_owner_id, invoked_at DESC)`.
  const readOwnerToolActivity =
    deps.readOwnerToolActivity ??
    (async (probes: Array<{ ownerId: string; sinceIso: string }>, o: { sql: Sql }) => {
      const out = new Map<string, OwnerToolActivity>();
      if (probes.length === 0) return out;
      const ownerIds = probes.map((p) => p.ownerId);
      const sinceIsos = probes.map((p) => p.sinceIso);
      const rows = await o.sql<
        Array<{
          owner_id: string;
          calls: number;
          distinct_tools: number;
          ok_calls: number;
          last_call_at: string | null;
        }>
      >`
        SELECT t.coord_owner_id                                   AS owner_id,
               count(*)::int                                      AS calls,
               count(DISTINCT t.tool_name)::int                   AS distinct_tools,
               count(*) FILTER (WHERE t.status = 'ok')::int        AS ok_calls,
               max(t.invoked_at)::text                            AS last_call_at
          FROM unnest(${o.sql.array(ownerIds)}::text[], ${o.sql.array(sinceIsos)}::timestamptz[])
               AS b(owner_id, since)
          JOIN harness_shared.tool_invocations t
            ON t.coord_owner_id = b.owner_id
           AND t.invoked_at > b.since
           AND ${agentToolInvocationPredicate(o.sql, 't')}
           AND t.tool_name <> ALL(${o.sql.array([...CARRY_NOTE_BOOKKEEPING_TOOL_NAMES])}::text[])
         GROUP BY t.coord_owner_id
      `;
      for (const r of rows) {
        if (typeof r?.owner_id !== 'string' || r.owner_id.length === 0) continue;
        out.set(r.owner_id, {
          calls: Number(r.calls) || 0,
          distinctTools: Number(r.distinct_tools) || 0,
          okCalls: Number(r.ok_calls) || 0,
          lastCallAt: r.last_call_at ?? null,
        });
      }
      return out;
    });
  // WI-37546 — the revival candidate set. Every bound lives in SQL: this module's OWN
  // turns-stalled pause reason (never `dead-owner`, never a cost-cap/dead-man pause), inside the
  // revival window, under the revival ceiling, and — the supersession bound — only while this
  // module's disarm is still the transition that put the row down.
  //
  // The supersession bound exists because `loop_paused_reason`/`pause` are deliberately sticky
  // (reviveDisarmedLoop must never clear them — see its doc), so a row that was disarmed here,
  // explicitly RE-ARMED by its owner, and then explicitly ENDED by its owner (`loop:end`) matches
  // every other predicate again: `active = false` with this module's stale pause residue. Reviving
  // it "compensates" a disarm the owner already compensated, and undoes an owner decision this
  // module has no mandate over — measured live 2026-08-18: the 04:07:03Z sweep re-armed a loop
  // whose owner had re-armed at 00:18:52Z and loop:end'd at 03:44:18Z under a fleet stand-down.
  // `armed_at` is stamped on EVERY arm (stampLoopArmedAt), so `armed_at` newer than the pause
  // instant proves the disarm was superseded, covering the end-after-RE-ARM shape. It does NOT
  // cover end-after-DISARM (guard disarms, owner `loop:end`s with no intervening re-arm): there
  // the deactivation no-ops and `armed_at` never advances, so this bound reads "not superseded"
  // (measured live by su-50a96a51, WI-39786 — the original 03:26Z case). That shape is excluded
  // by the reason-prefix predicate above instead: `deactivateLoop` stamps `loop_paused_reason`
  // with its own LOOP_END_PAUSE_PREFIX even when the loop is already inactive, so a
  // deliberately-ended row no longer carries this module's prefix and never re-enters the
  // revivable set. Both bounds stay: the prefix is the primary discriminator, this comparison
  // is defence in depth. An absent `armed_at` reads as '-infinity' — failing toward revival,
  // the module's designed direction for uncertain reads.
  const readRevivableLoops =
    deps.readRevivableLoops ??
    (async (o: { sql: Sql; workspaceId: string; pausedAfterMs: number; maxRevivals: number }) => {
      const rows = await o.sql<
        Array<{ id: string; target_owner_id: string; paused_at_ms: string | number; revived_count: number }>
      >`
        SELECT id,
               target_owner_id,
               (metadata->'pause'->>'pausedAtMs')::bigint            AS paused_at_ms,
               COALESCE((metadata->>'loop_revived_count')::int, 0)   AS revived_count
          FROM harness_shared.routines
         WHERE workspace_id = ${o.workspaceId}
           AND name LIKE 'loop-%'
           AND target_owner_id IS NOT NULL
           AND active = false
           AND metadata->>'loop_paused_reason' LIKE ${TURN_STALLED_PAUSE_PREFIX + '%'}
           AND (metadata->'pause'->>'pausedAtMs')::bigint >= ${o.pausedAfterMs}
           AND COALESCE((metadata->>'loop_revived_count')::int, 0) < ${o.maxRevivals}
           AND COALESCE((metadata->>'armed_at')::timestamptz, '-infinity'::timestamptz)
               < to_timestamp(((metadata->'pause'->>'pausedAtMs')::bigint) / 1000.0)
      `;
      return rows
        .filter((r) => typeof r?.target_owner_id === 'string' && r.target_owner_id.length > 0)
        .map((r) => ({
          routineId: r.id,
          ownerId: r.target_owner_id,
          pausedAtMs: Number(r.paused_at_ms),
          revivedCount: Number(r.revived_count) || 0,
        }))
        .filter((r) => Number.isFinite(r.pausedAtMs));
    });
  const resolveOwnerWorkspaces =
    deps.resolveOwnerWorkspaces ??
    (async (ownerIds: string[], o: { sql: Sql }) => {
      const out = new Map<string, string>();
      if (ownerIds.length === 0) return out;
      const briefs = await o.sql<Array<{ owner_id: string; workspace_id: string | null }>>`
        SELECT owner_id, workspace_id
          FROM harness_shared.session_briefs
         WHERE owner_id = ANY(${ownerIds}::text[])
      `;
      for (const b of briefs) {
        if (typeof b.workspace_id === 'string' && b.workspace_id.length > 0) out.set(b.owner_id, b.workspace_id);
      }
      return out;
    });
  const armWake =
    deps.armWake ??
    (async (input: { ownerId: string; note?: string | null }) => {
      const { armInboxWake } = await import('../../events/await/inbox-wake-arm');
      return armInboxWake(input);
    });
  const notify =
    deps.notify ??
    (async (input: AttentionNotifyInput) => {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention(input);
    });
  const broadcast = deps.broadcast ?? broadcastSevereEvent;
  const readPopulation = deps.readPopulation ?? readLoopPopulationSnapshot;

  // ── WI-37546: REVIVAL PASS ────────────────────────────────────────────────────────────────
  //
  // Runs FIRST, and deliberately ahead of the active-loop discovery below, for a reason that is
  // easy to get wrong: its candidates are `active = FALSE` rows, so a workspace whose every loop
  // has already been disarmed reads as "nothing to do" to the rest of this sweep — which is
  // exactly the state that most needs a revival pass, and exactly the state the early return
  // below would have bailed out of.
  //
  // What it undoes: a disarm THIS module wrote as turn-stalled, whose owner has since made
  // progressing tool calls. That combination means the verdict was wrong and the agent came
  // back — a fact nothing else in this system was reading, so the loop stayed dark until a human
  // noticed and typed `loop:arm`.
  //
  // The bounds are in `readRevivableLoops`'s SQL, not here, so the candidate set cannot widen by
  // accident: this module's own pause-reason prefix (never the `dead-owner` path, which measured
  // 7/7 CORRECT on the day this one measured 18/19 wrong), inside REVIVE_WINDOW_MS, under
  // MAX_REVIVALS. The progress term is the same one the veto uses.
  //
  // Fails toward the STATUS QUO on a read fault: an empty candidate set means "revive nobody",
  // which is precisely the behaviour that existed before this pass. A revival is a correction, so
  // failing to make one costs a sweep; the disarm it would have undone is already written.
  const revivedAfterDisarm: string[] = [];
  const reviveCandidates = await readRevivableLoops({
    sql,
    workspaceId: ws,
    pausedAfterMs: Date.now() - REVIVE_WINDOW_MS,
    maxRevivals: MAX_REVIVALS,
  }).catch((e) => {
    console.warn(
      `[stalled-loops-guard] revival candidate read failed (${e instanceof Error ? e.message : e}) — ` +
        `reviving nobody this sweep; previously-disarmed loops stay down.`,
    );
    return [] as Array<{ routineId: string; ownerId: string; pausedAtMs: number; revivedCount: number }>;
  });
  if (reviveCandidates.length > 0) {
    const sinceDisarm = await readOwnerToolActivity(
      reviveCandidates.map((c) => ({ ownerId: c.ownerId, sinceIso: new Date(c.pausedAtMs).toISOString() })),
      { sql },
    ).catch((e) => {
      rethrowProgrammingError(e);
      console.warn(
        `[stalled-loops-guard] revival activity read failed (${e instanceof Error ? e.message : e}) — ` +
          `reviving nobody this sweep.`,
      );
      return new Map<string, OwnerToolActivity>();
    });
    for (const c of reviveCandidates) {
      const activity = sinceDisarm.get(c.ownerId);
      if (!isProgressingToolActivity(activity)) continue;
      revivedAfterDisarm.push(c.ownerId);
      console.warn(
        `[stalled-loops-guard] REVIVED ${c.ownerId}: disarmed as turn-stalled at ` +
          `${new Date(c.pausedAtMs).toISOString()}, but has made ${activity?.calls} tool call(s) since ` +
          `(${activity?.distinctTools} distinct tool(s), ${activity?.okCalls} ok, last ` +
          `${activity?.lastCallAt ?? 'unknown'}) — the owner is working, so the verdict was wrong. ` +
          `Re-arming (revival ${c.revivedCount + 1}/${MAX_REVIVALS}); a disarm is a pause with a ` +
          `condition, not a one-way door (WI-37546).`,
      );
      if (!dryRun) {
        await revive(
          sql,
          c.routineId,
          `stalled-loops-guard (WI-37546): revived — disarmed as turn-stalled at ` +
            `${new Date(c.pausedAtMs).toISOString()}, then made ${activity?.calls} tool call(s) ` +
            `(${activity?.distinctTools} distinct, ${activity?.okCalls} ok, last ` +
            `${activity?.lastCallAt ?? 'unknown'}). The owner was working; the turn-stalled verdict ` +
            `was wrong. Revival ${c.revivedCount + 1} of ${MAX_REVIVALS}.`,
        );
      }
    }
  }
  /**
   * WI-37546 — owners the revival pass just re-armed, held so the disarm loop below SKIPS them.
   *
   * Load-bearing, not defensive. The revival sets `active = TRUE`, and the discovery query below
   * runs after it, so a just-revived loop reappears in `rows` — carrying the SAME stale
   * `turnsStalled` verdict that got it disarmed in the first place (its rescue fire has not
   * happened yet, by construction: it is scheduled for `now()`). Without this skip the sweep
   * would revive a loop and re-disarm it in the same pass, burning a revival off the ratchet each
   * time and leaving the loop exactly where it started.
   */
  const revivedThisSweep = new Set(revivedAfterDisarm);

  const rows = await sql<Array<{ id: string; target_owner_id: string }>>`
    SELECT id, target_owner_id
      FROM harness_shared.routines
     WHERE workspace_id = ${ws}
       AND name LIKE 'loop-%'
       AND target_owner_id IS NOT NULL
       AND active = true
  `;
  // WI-37546: NO early return here any more, and the reason is a bug this restructure fixes.
  //
  // This used to `return` as soon as there were no ACTIVE loop rows, which reads as an obvious
  // optimisation and is not: the revival pass above operates on INACTIVE rows, so the state where
  // every loop in the workspace has already been disarmed — the state a revival most urgently
  // needs to be announced in — returned before reaching any broadcast. The revivals were
  // performed and reported to nobody.
  //
  // The reads below are gated on `rows.length` instead, so a workspace with nothing active still
  // pays nothing (no status read, no scope read, no activity read) while the reporting at the
  // bottom of the sweep stays reachable on every path.
  const hasActiveLoops = rows.length > 0;

  // Latest routine id per owner (an owner should carry exactly one active loop row,
  // but guard against a duplicate the same way materializeLoop's own overwrite logic
  // does — last one wins).
  const routineIdByOwner = new Map<string, string>();
  for (const r of rows) routineIdByOwner.set(r.target_owner_id, r.id);

  const statuses: Map<string, LoopStatus> = hasActiveLoops
    ? await getStatuses([...routineIdByOwner.keys()], { sql })
    : new Map<string, LoopStatus>();

  // Cadence is observational: a pure loop re-arms after its turn settles, so a long turn can
  // legitimately inflate the ratio. Keep this verdict independent from turnsStalled and use it
  // only for a one-shot advisory below; the irreversible action loop still checks turnsStalled.
  const cadenceDriftDetails = [...routineIdByOwner.keys()]
    .map((ownerId) => {
      const status = statuses.get(ownerId);
      if (!status || !computeCadenceDrift(status)) return null;
      return { ownerId, status };
    })
    .filter((value): value is { ownerId: string; status: LoopStatus } => value != null);
  const cadenceDrift = cadenceDriftDetails.map(({ ownerId }) => ownerId);

  // EI-19966210024116714: one batch read of the owners' OWN session scopes, for the disarm reason
  // below. Deliberately hoisted out of the per-owner loop — it is a single indexed SELECT for the
  // whole sweep, and the loop body must not grow a query per iteration.
  //
  // Fails OPEN to an EMPTY map. An owner missing from it is UNKNOWN, never "mismatched", so a read
  // fault costs at most the extra sentence in a disarm reason — never a wrong accusation, and
  // never a changed disposition.
  const ownerWorkspaces = !hasActiveLoops
    ? new Map<string, string>()
    : await resolveOwnerWorkspaces([...routineIdByOwner.keys()], { sql }).catch((e) => {
        console.warn(
          `[stalled-loops-guard] owner-workspace resolve failed (${e instanceof Error ? e.message : e}) — ` +
            `proceeding without the unaddressable-harness discriminator; disarm reasons stay generic.`,
        );
        return new Map<string, string>();
      });

  // WI-37546 — one batched activity read for every owner the verdict has already condemned.
  //
  // Hoisted out of the per-owner loop for the same reason `ownerWorkspaces` is: it is a single
  // indexed SELECT for the whole sweep, and the loop body must not grow a query per iteration.
  // Scoped to `turnsStalled` owners only — the rest are not candidates for any disposition here,
  // so reading their activity would be work with no reader.
  //
  // The boundary is each loop's own LAST FIRE, not a shared window: the question this veto asks
  // is "has this owner done anything since we last asked it for a turn?", and every loop was
  // last asked at a different moment. A loop that has never fired falls back to the verdict's own
  // stall floor, which is the same window `turnsStalled` itself judged over.
  const stalledCandidates = [...routineIdByOwner.keys()].filter((o) => statuses.get(o)?.turnsStalled === true);
  const nowMsForProbe = Date.now();
  const toolActivity =
    stalledCandidates.length === 0
      ? new Map<string, OwnerToolActivity>()
      : await readOwnerToolActivity(
          stalledCandidates.map((ownerId) => {
            const s = statuses.get(ownerId);
            const firedMs = s?.lastFiredAt ? Date.parse(s.lastFiredAt) : NaN;
            const sinceMs = Number.isFinite(firedMs)
              ? firedMs
              : nowMsForProbe - turnsStalledFloorMs(s?.intervalSec ?? null);
            return { ownerId, sinceIso: new Date(sinceMs).toISOString() };
          }),
          { sql },
        ).catch((e) => {
          rethrowProgrammingError(e);
          // Fails toward the PRE-EXISTING behaviour (no veto), never toward a blanket exemption. A read
          // fault must not silently disable the reaper for the whole workspace — that would be the
          // WI-36792 lesson (blunting a reaper is invisible; it still reports `checked: N`) with a
          // wider blast radius than any single wrong disarm.
          console.warn(
            `[stalled-loops-guard] tool-activity read failed (${e instanceof Error ? e.message : e}) — ` +
              `proceeding WITHOUT the liveness veto; disarms this sweep are decided as they were before ` +
              `WI-37546. A repeat here is a real fault: it re-opens the 18-of-19 false-disarm window.`,
          );
          return new Map<string, OwnerToolActivity>();
        });

  const stalledOwners: string[] = [];
  const vetoedByRecentTurn: string[] = [];
  /** WI-37546: owners still making PROGRESSING tool calls since their last fire. */
  const vetoedByToolActivity: string[] = [];
  /** P-008: progressing owners whose active loop was still parked at infinity. */
  const reArmedToolLiveParked: string[] = [];
  const reArmedFireStarved: string[] = [];
  const vetoedByProviderWall: string[] = [];
  /** EI-19899301656065801: disarmed owners the reachability probe still finds PRESENT. */
  const disarmedWhileReachable: string[] = [];
  /** WI-36685: owners whose fires were black-holing for want of a standing await. */
  const repairedWakeStarved: string[] = [];
  /** WI-36792: owners whose last fire the GATE withheld — never sent, so never answerable. */
  const vetoedByWithheldFire: string[] = [];
  /** EI-19966210024116714: disarmed owners whose loop harness their own session cannot address. */
  const disarmedUnaddressableHarness: string[] = [];
  const nowMs = Date.now();
  for (const [ownerId, routineId] of routineIdByOwner) {
    const status = statuses.get(ownerId);
    // EI-22778953572067990 — `fireStarved` is a distinct actor candidate from
    // `turnsStalled`: a current arm can cross its no-post-arm-fire floor while
    // `turnsStalled` remains false because there is no post-fire gap to measure.
    if (!status || (!status.turnsStalled && !status.fireStarved)) continue;

    // WI-37546 — do not judge a loop this same sweep just revived. Its `turnsStalled` verdict is
    // the stale one that got it disarmed; the fire that will refresh it is scheduled for `now()`
    // and has not happened yet. Re-disarming here would undo the revival within milliseconds and
    // spend one of its bounded revival attempts doing it.
    if (revivedThisSweep.has(ownerId)) continue;

    // EI-19362678179163398 — SECOND-SOURCE VETO. Disarming a loop is an automated write
    // against a live agent, and the verdict above rests on ONE column (`last_turn_at`)
    // that has now under-reported twice: WI-6069 (lifecycle marker only — never written
    // by a warm loop) and its follow-up (the journal leg covers ~2.3% of real turns). Each
    // time, the failure direction was "a healthy, actively-working agent reads as stalled".
    // So before acting, cross-check the INDEPENDENT strict signal: `lastRealTurnAt`
    // (session_turn_journal + session_turns assistant rows, no lifecycle marker). An owner
    // that produced a real assistant turn inside the verdict's own floor is demonstrably
    // producing turns and must never be disarmed, whatever `last_turn_at` claims.
    //
    // This CANNOT mask the case the guard exists for: a comatose/dead session emits no
    // session_turns rows at all, so its `lastRealTurnAt` is null or ancient and the veto
    // never engages. Deliberately NOT keyed on presence/heartbeat — that is process
    // keepalive, not evidence of work (EI-18712366018708650), and gating on it would
    // exempt exactly the comatose-host population WI-6639 targets.
    const realTurnMs = status.lastRealTurnAt ? Date.parse(status.lastRealTurnAt) : NaN;
    if (Number.isFinite(realTurnMs) && nowMs - realTurnMs < turnsStalledFloorMs(status.intervalSec)) {
      vetoedByRecentTurn.push(ownerId);
      console.warn(
        `[stalled-loops-guard] VETO ${ownerId}: turnsStalled:true but a real turn landed ` +
          `${Math.round((nowMs - realTurnMs) / 1000)}s ago (lastTurnAt=${status.lastTurnAt ?? 'never'}, ` +
          `lastRealTurnAt=${status.lastRealTurnAt}) — refusing to disarm. ` +
          `A non-zero veto count means last_turn_at is under-reporting (EI-19362678179163398).`,
      );
      continue;
    }

    // EI-19441932615368003 — WALLED, NOT STALLED. The third population, and the one this
    // guard was silently converting into permanent halts.
    //
    // When a provider usage/rate wall kills a loop's wake turn, the lifecycle-death backoff
    // (loop-turn-outcome.ts P1a / reconcile-loop-routines.ts) does the RIGHT thing: it pushes
    // `next_fire_at` out by the provider's own retry-after — up to the `clampUsageRearmDelayMs` cap
    // (6h) — and leaves the loop ARMED so it resumes when the wall lifts. Self-healing by design.
    //
    // But that healthy state is, by construction, byte-identical to the corpse signature this
    // guard hunts: a fire landed, no turn came back (the provider killed it), and no turn CAN
    // come back until the wall lifts, so presence goes stale too. Both exemptions above then
    // correctly decline — `lastRealTurnAt` is older than the floor (nothing has run), and the
    // loop did NOT answer its last fire, so it is not fire-starved either. It falls straight
    // through to the disarm.
    //
    // Measured 2026-08-03 on this workspace: THREE sweeps (11:07Z, 13:07Z, 14:07Z) disarmed
    // 7 + 2 + 6 = 15 loops. At least two are confirmed walled-not-dead — su-b9269a31 (~4h
    // silent) and su-3a5df0ae (~2h50m silent, ended only when a human typed "continue"). Each
    // was waiting out a transient capacity condition that would have cleared on its own.
    //
    // loop.ts:682 (EI-19325288514307343) already documented this ambiguity — "PIXEL-IDENTICAL
    // to a genuinely dead loop for up to 6h" — but framed it as a REPORTING problem for owners
    // reading loop:status. This module is also one of those surfaces, and it does not merely
    // display the ambiguity, it ACTS irreversibly on it.
    //
    // SKIP rather than re-arm: the backoff already computed a provider-informed `next_fire_at`.
    // Re-arming would overwrite it with a plain interval and fire straight back into the wall —
    // the exact blind retry loop-turn-outcome's P1a exists to prevent. Leave it alone.
    //
    // `computeLifecycleBackoff` is the SAME pure derivation loop:status renders (it matches BOTH
    // observer prefixes, `loop-lifecycle-death:` and `resume-turn-death:` — recognizing only one
    // was itself a past bug, EI-19381528967421062). `resumesInMs > 0` is what makes this narrow:
    // once the backoff has ELAPSED and still no turn followed, the loop is genuinely stuck and
    // falls through to the disarm below, exactly as before.
    const wall = computeLifecycleBackoff({
      active: true, // by construction here — the sweep only selects active loops
      lastDeliveryOutcome: status.lastDeliveryOutcome,
      nextFireAtIso: status.nextFireAt,
      nowMs,
    });
    if (wall && wall.resumesInMs != null && wall.resumesInMs > 0) {
      vetoedByProviderWall.push(ownerId);
      console.warn(
        `[stalled-loops-guard] WALLED ${ownerId}: turnsStalled:true but the last fire died on a ` +
          `provider wall (${wall.reason}) and the loop is backed off until ${wall.until} ` +
          `(~${Math.round(wall.resumesInMs / 1000)}s away) — refusing to disarm. It is waiting out a ` +
          `TRANSIENT capacity condition, not wedged; disarming would make a self-healing backoff ` +
          `permanent (EI-19441932615368003).`,
      );
      continue;
    }

    // EI-19406534159939583 — FIRE-STARVED, NOT TURN-STALLED. The veto above catches an agent
    // that produced a turn RECENTLY. It cannot catch the one that bit us: an agent that
    // answered every fire it received and then went quiet BECAUSE THE FIRES STOPPED — it has
    // no recent turn precisely because it has had nothing to answer, so it sails past the veto
    // and reads exactly like a corpse.
    //
    // The verdict cannot separate these two on its own, and this is worth stating plainly
    // because it is the trap: WI-6639's measured 156h corpses ALSO show a last turn shortly
    // after their last fire (see computeTurnsStalled's frozen-gap regression test), and a live
    // agent parked on an event beats no heartbeat, so presence is stale for both. Turn
    // ordering alone would have re-armed the corpses; presence alone would have disarmed the
    // living. The ONE signal that does separate them is whether the owner is still REACHABLE —
    // and that is an I/O probe, which is why this lives in the actor and not in the verdict.
    //
    // Reuses `probeWakeReachability`, the SAME oracle reconcileLoopRoutines already trusts for
    // "a live owner is NEVER terminated, any dwell" (loop-unreachable-guard.ts). One oracle for
    // "is this owner gone", not two that can disagree.
    //
    // Re-arm rather than disarm when it is reachable, because the two mistakes are not
    // symmetric. A wrong RE-ARM costs one extra fire and self-corrects on the very next sweep:
    // the fire lands, no turn follows it, `lastRealTurnAt` stays ancient, and the disarm
    // happens then. A wrong DISARM is PERMANENT — reconcileLoopRoutines gates its re-arm sweep
    // on `active = TRUE` (reconcile-loop-routines.ts:726), so the mechanism that exists to
    // rescue a stuck loop can never see it again, and the agent cannot re-arm itself because it
    // is asleep waiting for the fire that stopped coming. Live on 2026-08-03 the wrong
    // direction took 5 of a 10-member drain fleet dark in a single 23ms batch.
    const answeredItsLastFire =
      status.lastTurnAt != null &&
      status.lastFiredAt != null &&
      Date.parse(status.lastTurnAt) >= Date.parse(status.lastFiredAt);
    // EI-22778953572067990 — an explicit no-post-arm-fire verdict has no
    // `lastTurnAt >= lastFiredAt` ordering to satisfy, but it needs the same
    // reachable-vs-corpse split as the older answered-last-fire shape.
    let probed: WakeReachabilityVerdict | null = null;
    if (status.fireStarved || answeredItsLastFire) {
      const reachable = await probeReachability(ownerId)
        .then((v) => {
          probed = v;
          return v.reachable;
        })
        // Fail-soft in the SAFE direction: an uncertain reachability read must not license an
        // irreversible disarm, so treat it as reachable and let the next sweep decide with
        // better information (mirrors checkUnreachableTerminalGuard's own catch).
        .catch(() => true);
      if (reachable) {
        reArmedFireStarved.push(ownerId);
        console.warn(
          `[stalled-loops-guard] FIRE-STARVED ${ownerId}: ` +
            (status.fireStarved
              ? `the current arm crossed its no-post-arm-fire floor`
              : `answered its last fire (turn ${status.lastTurnAt} >= fire ${status.lastFiredAt})`) +
            ` and is still REACHABLE, yet no fire ` +
            `has arrived since. Re-arming, NOT disarming — the fault is in the firing path, not the agent ` +
            `(EI-19406534159939583).`,
        );
        if (!dryRun) {
          await rearm(
            sql,
            routineId,
            `stalled-loops-guard (EI-19406534159939583): fire-starved — answered its last fire at ` +
              `${status.lastTurnAt}, reachable, no fire since ${status.lastFiredAt}`,
          );
        }
        continue;
      }
    }

    // WI-36685 — WAKE-STARVED, NOT TURN-STALLED. The fourth population, and the one that took
    // this very session dark twice in one day.
    //
    // The branch above catches an agent whose fires STOPPED. This one catches the opposite
    // signature: fires kept arriving on schedule and every one of them landed on NOBODY. A wake
    // emits on `coord:inbox-wake:<owner>`; with no standing await registered there,
    // emitAwaitedEvent matches nothing (woken:0, staged:0), loop-fire records `no-session-now`,
    // and — the part that makes this detectable — NO `event_wake_deliveries` row is ever
    // created. The agent is asleep, was never spoken to, and therefore has no recent turn. To
    // `last_turn_at` that is byte-identical to an agent that stopped answering, so it sails past
    // every exemption above and takes the permanent disarm.
    //
    // THE DISCRIMINATOR NEEDS NO NEW I/O, because it is a fact about history the status already
    // carries. `lastWakeAt` is NOT a stored column: loop.ts:1069 derives it as
    // COALESCE(delivered_at, created_at) over this routine's own wake-delivery rows. A row that
    // was created but never delivered would STILL advance it via created_at — so a frozen
    // `lastWakeAt` under an advancing `lastFiredAt` has exactly ONE explanation: no delivery row
    // was created at all. That is what separates this from a delivered-but-wedged child
    // (EI-19478552459475620), where the wake IS delivered (lastWakeStatus 'delivered', channel
    // 'psu-socket-reset') and `lastWakeAt` tracks the fires — correctly NOT this population.
    //
    // Measured on su-4a6e2255 (2026-08-08): ZERO delivery rows for 2h44m while fires advanced to
    // 21:54:31Z, every row that did exist status=delivered with an empty error. Never a delivery
    // FAILURE — no wake was ever attempted. Disarmed at 22:07:36Z, dark until the owner typed
    // into it by hand ~55 minutes later.
    //
    // WHY THE REPAIRABILITY GATE IS LOAD-BEARING, not a formality. The history test alone also
    // matches a genuine CORPSE: a session's standing await is cancelled by its SessionEnd hook,
    // so a dead owner's later fires create no delivery rows either and its `lastWakeAt` is just
    // as frozen. `awaitRepairable` is what separates them — it is true only when the await gate
    // is the ONLY thing blocking delivery and the session is otherwise live and injectable, so a
    // corpse (nothing live, nothing resumable) reads false and falls through to the disarm
    // exactly as before. Note this could NOT have been keyed on `reachable`: Gate 1 of
    // deriveWakeReachability returns before consulting any liveness signal, so a wake-starved
    // owner is unreachable BY CONSTRUCTION and a `reachable` gate would veto nothing, ever.
    //
    // AND THE REPAIR MUST ACTUALLY REPAIR. `rearmFireStarvedLoop` only moves `next_fire_at` — on
    // this population that fires straight back into the same black hole. Arming the standing
    // watch is the write that restores delivery; the nudge then makes it due immediately. Both,
    // in that order, or neither is worth doing. (The arm is deliberately NOT applied to owners
    // that fail the repairability gate: arming a watch for a dead session manufactures precisely
    // the zombie await that reads as a false `parked`/`wakeable` session and pins it against the
    // idle-session-reaper, which counts a standing await as alive.)
    //
    // Same asymmetry as the branch above, and it binds harder here: a wrong repair costs one
    // extra fire and self-corrects on the next sweep — the wake now genuinely lands, no turn
    // follows, `lastWakeAt` has advanced so this branch no longer matches, and the ordinary
    // disarm happens. A wrong disarm is permanent.
    const lastFiredMs = status.lastFiredAt ? Date.parse(status.lastFiredAt) : NaN;
    const lastWakeMs = status.lastWakeAt ? Date.parse(status.lastWakeAt) : NaN;
    const wakeStarved =
      Number.isFinite(lastFiredMs) &&
      (!Number.isFinite(lastWakeMs) || lastFiredMs - lastWakeMs >= turnsStalledFloorMs(status.intervalSec));

    // WI-36792 — WITHHELD, NOT WAKE-STARVED. The block below has THREE sub-cases and until now
    // implemented only two, so the third fell through to the permanent disarm.
    //
    // `wakeStarved` is already TRUE for a gate-withheld fire, and that is not a coincidence — it
    // is the same mechanical signature by a different cause. The claim stamps `last_fired_at` and
    // parks the row; the gate then DENIES the fire before `wake()` is ever called, so no
    // `event_wake_deliveries` row is created and `lastWakeAt` stays frozen under an advancing
    // `lastFiredAt`. Identical history, opposite remedy: there the wake was attempted and reached
    // nobody, here it was never attempted at all.
    //
    // The block escapes only via `awaitRepairable`, and that is exactly where this case falls
    // through: a withheld fire leaves the session's standing await INTACT (nothing consumed it),
    // so there is nothing to repair, `awaitRepairable` is false, and control reaches the disarm.
    // The healthiest possible state — live session, valid await — was being read as terminal.
    //
    // Measured on su-4a6e2255 (2026-08-08): `last_withheld_at` 21:54:40.570Z, reason 'fire-gate',
    // detail 'backoff (consecutive_errors=4, retry in ~454s)' — 9s after the 21:54:31.403Z claim,
    // with await 44729 alive and unfired the whole window. Disarmed at 22:07:36Z; dark until the
    // owner typed into the session by hand ~55 minutes later. `lastWithheldAt >= lastFiredAt` is
    // the whole discriminator, and it needs no new I/O — see LoopStatus.lastWithheldAt (loop.ts),
    // where it was surfaced for this reader.
    const withheldMs = status.lastWithheldAt ? Date.parse(status.lastWithheldAt) : NaN;
    const lastFireWasWithheld =
      Number.isFinite(withheldMs) && Number.isFinite(lastFiredMs) && withheldMs >= lastFiredMs;

    // Held so the disarm path below can reuse this probe instead of paying a second one.
    if (wakeStarved) {
      probed = await probeReachability(ownerId).catch(() => null);
      if (probed?.awaitRepairable) {
        repairedWakeStarved.push(ownerId);
        console.warn(
          `[stalled-loops-guard] WAKE-STARVED ${ownerId}: fires advanced to ${status.lastFiredAt} while ` +
            `lastWakeAt stayed at ${status.lastWakeAt ?? 'never'} — no wake-delivery row was created, so the ` +
            `fires reached nobody. The session is alive and would take the ${probed.wouldBeChannel} channel ` +
            `once its inbox-wake watch is armed. Repairing + re-arming, NOT disarming — it was never asked ` +
            `for a turn (WI-36685).`,
        );
        if (!dryRun) {
          // Fail-soft: if the arm write fails, do NOT nudge the loop — a re-arm without a
          // restored watch just black-holes another fire and, worse, would leave this branch
          // reporting a repair that did not happen. Fall through to the disarm instead.
          const armed = await armWake({
            ownerId,
            note: `stalled-loops-guard wake-starved repair (WI-36685)`,
          })
            .then(() => true)
            .catch((e) => {
              console.warn(
                `[stalled-loops-guard] WAKE-STARVED ${ownerId}: armInboxWake FAILED ` +
                  `(${e instanceof Error ? e.message : e}) — not re-arming the loop, since a nudge without a ` +
                  `standing watch black-holes again.`,
              );
              return false;
            });
          if (!armed) {
            repairedWakeStarved.pop();
          } else {
            await rearm(
              sql,
              routineId,
              `stalled-loops-guard (WI-36685): wake-starved — fires advanced to ${status.lastFiredAt} with no ` +
                `wake delivery since ${status.lastWakeAt ?? 'never'}; inbox-wake watch re-armed ` +
                `(would-be channel ${probed.wouldBeChannel})`,
            );
            continue;
          }
        } else {
          continue;
        }
      }

      // WI-36792 — Case 2 of the wake-starved split: NOT repairable (a live session with a
      // VALID standing await has nothing for `armWake` to fix), but the reason `lastWakeAt`
      // is frozen is that the fire GATE withheld the most recent fire outright — it never
      // went out, so nobody was ever asked for a turn. Only reachable when the branch above
      // did not already `continue` (i.e. `!probed?.awaitRepairable`, or its repair write
      // failed and fell through — see the `repairedWakeStarved.pop()` path just above).
      //
      // `lastWithheldAt >= lastFiredAt` is the discriminator loop.ts documents on the field
      // itself: the claim stamps `lastFiredAt` and the gate is consulted immediately after,
      // so a withheld-at at or after it means THIS fire, not a stale one from a prior cycle.
      //
      // VETOED, not repaired and not re-armed — the gate's backoff is a deliberate cadence
      // (reconcileLoopRoutines' `gate-backoff` rebase honours `retryAfterSec`; re-arming here
      // would fight it, the same "leave it alone" reasoning as `vetoedByProviderWall`).
      //
      // ⚠ THE REACHABILITY TERM IS LOAD-BEARING — the withhold stamp ALONE would blunt exactly
      // the population WI-6639 exists to reap, permanently. A corpse is not merely compatible
      // with a perpetual withhold, it CONVERGES on one: its wakes find no standing await, so
      // every fire records `no-session-now`, `consecutive_errors` climbs without bound, and the
      // circuit denies an ever-growing share of its claims — while `lastWakeAt` stays frozen
      // (no delivery row is created either way), so `wakeStarved` is permanently true. Sample it
      // at any sweep and `lastWithheldAt >= lastFiredAt` reads true, forever.
      //
      // Reachability separates the two, and — unlike the WI-36685 case above, where it could NOT
      // be used — it is MEANINGFUL here, for a reason specific to this sub-case: a withheld fire
      // never reached `wake()`, so it never touched the standing await. Gate 1 of
      // `deriveWakeReachability` therefore PASSES and the verdict reflects real liveness, instead
      // of the `false`-by-construction it returns for an owner whose await is missing. A corpse's
      // await was cancelled at SessionEnd ⇒ Gate 1 fails ⇒ `reachable:false` ⇒ no veto ⇒ it takes
      // the disarm exactly as it did before this branch existed.
      //
      // `!== false` and not `=== true`: `null` is the probe having THROWN, i.e. presence UNKNOWN,
      // and by this module's own asymmetry (a wrong veto costs one sweep; a wrong disarm is
      // permanent) an uncertain read must not license the irreversible write — the same direction
      // as the fire-starved branch's `.catch(() => true)` earlier in this loop.
      //
      // SELF-LIMITING even when it does engage, so it cannot silently become a standing
      // exemption: the veto holds only while the withhold is the most recent event. Once the
      // backoff clears and a fire actually goes out, a delivery row is created, `lastWakeAt`
      // advances past `lastFiredAt`, `wakeStarved` goes false, and an agent that still is not
      // answering takes the ordinary disarm on the very next sweep.
      if (!probed?.awaitRepairable && lastFireWasWithheld && probed?.reachable !== false) {
        vetoedByWithheldFire.push(ownerId);
        console.warn(
          `[stalled-loops-guard] WITHHELD-FIRE VETO ${ownerId}: fires advanced to ${status.lastFiredAt} ` +
            `while lastWakeAt stayed at ${status.lastWakeAt ?? 'never'} — but the fire gate WITHHELD that ` +
            `claim (lastWithheldAt=${status.lastWithheldAt}), so it was never actually sent and no delivery ` +
            `row exists. The session is ` +
            `${probed == null ? 'of UNKNOWN reachability (the probe failed — declining an irreversible write on an uncertain read)' : `reachable via ${probed.channel}`} ` +
            `with its standing await intact, so there is nothing to repair. Refusing to disarm — the agent ` +
            `was never asked for a turn; the gate's own backoff owns the retry (WI-36792).`,
        );
        continue;
      }
    }

    // EI-20502003602774122 — COLD DELIVERED RESET, NOT WEDGED. A cold psu-socket-reset
    // delivery tears down the predecessor and hands the next turn to a fresh context. The
    // fire claims `last_fired_at` before that handoff, so this sweep can observe `turnsStalled`
    // while the successor's turn markers are still null. Do not let delivery alone exempt a
    // loop: the handoff must be recent and there must already be strict agent-authored activity
    // after this fire. This is intentionally narrower than the general activity veto below;
    // one automatic/status call or a one-tool retry storm cannot keep an arbitrary loop armed.
    const firedAtMs = status.lastFiredAt ? Date.parse(status.lastFiredAt) : NaN;
    const wakeAtMs = status.lastWakeAt ? Date.parse(status.lastWakeAt) : NaN;
    const deliveredColdResetWake =
      status.carry === 'cold' &&
      status.lastWakeStatus === 'delivered' &&
      status.lastWakeChannel === 'psu-socket-reset' &&
      Number.isFinite(firedAtMs) &&
      Number.isFinite(wakeAtMs) &&
      wakeAtMs >= firedAtMs;
    const activity = toolActivity.get(ownerId);
    if (deliveredColdResetWake && activity != null && activity.calls > 0) {
      vetoedByToolActivity.push(ownerId);
      console.warn(
        `[stalled-loops-guard] COLD DELIVERED WAKE VETO ${ownerId}: the latest ` +
          `psu-socket-reset wake was delivered at ${status.lastWakeAt}, but cold successor turn ` +
          `markers have not landed yet; ${activity.calls} recent agent-authored tool call(s) ` +
          `show the successor is productive. Refusing to disarm this handoff (EI-20502003602774122).`,
      );
      continue;
    }

    // WI-37546 — LIVE, NOT STALLED. The fifth and last exemption, deliberately positioned HERE,
    // after every other branch has taken the population it can explain.
    //
    // Placement is a design choice, not an accident. Put earlier, this veto would poach owners
    // that `vetoedByProviderWall` and `vetoedByWithheldFire` currently claim, and those counts
    // are read as measurements ("how much silent halting is this exemption preventing"). Put
    // last, its own count means exactly one thing and can be compared straight against the census
    // that motivated it: DISARMS PREVENTED.
    //
    // The question it asks is the one no other branch asks. Every exemption above interrogates
    // the DELIVERY PATH — did a turn land, is a wall up, did a fire go out, did a wake reach
    // anyone. This one interrogates the AGENT: is it still making tool calls? That evidence sat
    // in `harness_shared.tool_invocations` the whole time, indexed by `coord_owner_id`, and
    // nothing read it.
    //
    // Measured 2026-08-09 on this workspace: 18 of the 19 loops disarmed that day had an owner
    // making tool calls in the hour BEFORE the disarm — this branch is the difference between
    // that day and a correct one. The 19th was genuinely quiet at judgement time and is NOT
    // rescued here; it is rescued by the revival pass at the top of this sweep, which is why both
    // halves had to ship together. Shipping only this branch would have left the worst case (a
    // transient stall converted into an indefinite halt) exactly as it was.
    //
    // ⚠ PROGRESS, NOT VOLUME — see `isProgressingToolActivity`. Raw call count has a convergent
    // population (an agent stuck retrying one failing tool), which would read as alive forever.
    //
    // BOUNDED, so it cannot become a standing exemption: `TOOL_LIVENESS_VETO_CEILING_MS` past the
    // owner's last COMPLETED turn, "still calling tools" stops counting as evidence and the loop
    // falls through to the disarm — which is now revivable, so even that is no longer terminal.
    if (isProgressingToolActivity(activity)) {
      // P-008 — THIRD OUTCOME: LIVE AND PARKED, SO REPAIR INSTEAD OF ONLY VETOING.
      //
      // The ordinary veto below is correct for an unparked loop: refusing the destructive disarm
      // is all that is needed, because its schedule can still advance. It is incomplete for the
      // in-flight sentinel. A parked loop has `next_fire_at = infinity`; if the completion rebase
      // never lands, `continue` leaves a demonstrably-working owner there forever. The guard then
      // observes the fault on every sweep and deliberately does nothing to clear it.
      //
      // Reuse `rearmFireStarvedLoop`, the existing system-actor write that moves an ACTIVE loop to
      // `next_fire_at = now()` without clearing history. This is the same self-correcting experiment
      // as the fire-starved branch: if the owner really is healthy, the next fire completes and the
      // stale turn verdict clears; if not, the new fire advances the activity boundary and the next
      // sweep can disarm normally. The ceiling still bounds the plain veto below. It does not turn
      // a repairable parked loop into a disarm merely because the completion rebase has been missing
      // for longer — the park itself is the condition this third outcome repairs.
      if (status.parked) {
        reArmedToolLiveParked.push(ownerId);
        console.warn(
          `[stalled-loops-guard] TOOL-LIVE PARK REPAIR ${ownerId}: turnsStalled:true and still ` +
            `parked at the in-flight sentinel, but the owner has made ${activity?.calls} progressing ` +
            `tool call(s) since its last fire (${activity?.distinctTools} distinct, ${activity?.okCalls} ` +
            `ok, last ${activity?.lastCallAt ?? 'unknown'}). Making the active loop due immediately ` +
            `instead of only vetoing its disarm (P-008 / WI-41231).`,
        );
        if (!dryRun) {
          await rearm(
            sql,
            routineId,
            `stalled-loops-guard (WI-41231): tool-live parked repair — ${activity?.calls} ` +
              `progressing tool call(s) since ${status.lastFiredAt ?? 'the last fire'}, but ` +
              `next_fire_at remained at the in-flight sentinel`,
          );
        }
        continue;
      }

      // The ceiling anchors on the last time this owner FINISHED something. Unknown (a loop whose
      // owner has no turn history at all) is not old — it takes the veto, per this module's
      // governing asymmetry.
      const lastCompletedMs = [status.lastRealTurnAt, status.lastTurnAt, status.armedAt]
        .map((t) => (t ? Date.parse(t) : NaN))
        .find((n) => Number.isFinite(n));
      const turnlessForMs = lastCompletedMs == null ? null : nowMs - lastCompletedMs;
      if (turnlessForMs == null || turnlessForMs < TOOL_LIVENESS_VETO_CEILING_MS) {
        vetoedByToolActivity.push(ownerId);
        console.warn(
          `[stalled-loops-guard] LIVE ${ownerId}: turnsStalled:true but the owner has made ` +
            `${activity?.calls} tool call(s) since its last fire (${activity?.distinctTools} distinct ` +
            `tool(s), ${activity?.okCalls} ok, last ${activity?.lastCallAt ?? 'unknown'}) — refusing to ` +
            `disarm. An agent issuing tool calls is not wedged, whatever last_turn_at claims ` +
            `(WI-37546: 18 of 19 disarms on 2026-08-09 had exactly this evidence available).`,
        );
        continue;
      }
      console.warn(
        `[stalled-loops-guard] CEILING ${ownerId}: making progressing tool calls ` +
          `(${activity?.calls} since last fire) yet has completed NO turn for ` +
          `${Math.round(turnlessForMs / 3600_000)}h — past TOOL_LIVENESS_VETO_CEILING_MS, so tool ` +
          `activity has stopped counting as progress. Disarming; the disarm is revivable ` +
          `(WI-37546).`,
      );
    }

    stalledOwners.push(ownerId);

    // EI-19966210024116714: name WHY, when the why is knowable.
    //
    // A loop whose routine sits on THIS workspace while its owner's own session resolves to a
    // DIFFERENT one is armed against a harness that session cannot address — every harness-scoped
    // call it makes comes back `harness_forbidden`. That agent is neither wedged nor a corpse: it
    // is being woken, repeatedly, to do work it is structurally unable to reach.
    //
    // Disarming is still right (more fires will not help), so this changes no disposition. What it
    // changes is the RECORD. The generic reason below states the symptom and loses the cause, and
    // every remedy the other surfaces print — "re-arm with loop:arm" — silently re-creates the
    // identical hole, because re-arming does not change the session's scope. `loop:arm`'s own
    // `harness_workspace_mismatch` guard now refuses to CREATE a strand; nothing repairs an
    // existing one, so the disarm reason is the only place a human learns what happened.
    //
    // Pushed BEFORE the dryRun bail, like `stalledOwners` itself: this is a pure lookup in a map
    // already in hand, so a dry run can report the population honestly.
    //
    // Fails OPEN on an owner absent from the map (an unknown scope, or a failed resolve): only a
    // CONFIRMED, different workspace qualifies. The module's governing asymmetry is that a wrong
    // repair self-corrects and a wrong disarm is permanent — and while this branch flips no
    // disposition, a wrong ACCUSATION in a permanent record carries its own cost.
    const ownerWs = ownerWorkspaces.get(ownerId);
    const unaddressableHarness = typeof ownerWs === 'string' && ownerWs !== ws;
    if (unaddressableHarness) disarmedUnaddressableHarness.push(ownerId);

    if (dryRun) continue;
    // WI-37546: composed FROM the shared prefix rather than re-typing it, because the revival
    // pass selects on that exact string. Two hand-written copies of one predicate is how a
    // revival query silently starts matching nothing.
    const reason =
      `${TURN_STALLED_PAUSE_PREFIX} ${status.fireCount} fire(s), last fired ${status.lastFiredAt ?? 'never'}, ` +
      `last turn ${status.lastTurnAt ?? 'never'}` +
      (unaddressableHarness
        ? ` — UNADDRESSABLE HARNESS: this loop's routine is on workspace '${ws}', but the owner's ` +
          `own session scope resolves to '${ownerWs}', so every harness-scoped call it makes ` +
          `returns harness_forbidden. It was being woken to do work it cannot reach, which is why ` +
          `no turn followed. Re-arming alone will NOT fix this — the session must be relaunched ` +
          `with the correct workspace scope (EI-19966210024116714).`
        : '');
    await autoPause(sql, routineId, reason);

    // EI-19899301656065801: ask whether the owner we just permanently disarmed is STILL THERE.
    //
    // Note where this probe sits. The fire-starved branch above consults reachability only
    // behind `answeredItsLastFire`, so on THIS path — the turn-stalled one — reachability was
    // never measured at all. That is the gap: a session whose last turn PRECEDES its last fire
    // is indistinguishable here from a 156h corpse, and both take the irreversible disarm. But
    // the two are not the same animal. A corpse is gone and disarming it is pure hygiene
    // (WI-6639's original population: 15 loops whose sessions had already ENDED). A session that
    // is still REACHABLE and simply stopped turning — a carry-respawn that died mid-flight, a
    // wedged CLI child — is recoverable, and after this write nothing will ever recover it: it
    // cannot re-arm itself (see the asymmetry argument above), `reconcileLoopRoutines` gates its
    // rescue sweep on `active = TRUE`, and its next `coord:orient` — whose `wakeSourceLostWarning`
    // is the designed catch for exactly this state — will never run, because running it requires
    // the turn it can no longer take.
    //
    // Disarming is still CORRECT for this shape: fires were landing and no turn followed, so
    // re-arming would only feed an agent that is not answering. What is missing is telling a
    // human, and the module's existing broadcast cannot do it — `broadcastSevereEvent` addresses
    // the FLEET, and no peer has a mandate to revive someone else's session. `notifyAttention` is
    // the OWNER rail (desktop SSE + APNs/FCM), and pairing the two is the established idiom for
    // "a human must act" (stale-routine-executor-watchdog.ts, EI-19388269294151851).
    //
    // Measured instance: su-4a6e2255 disarmed 2026-08-04T09:07:15Z, then dark for 4d6h until the
    // owner happened to resume that session BY HAND — which it did warm, with its context intact,
    // i.e. it had been sitting there recoverable the whole time.
    //
    // Fail-soft to `true` (page on an uncertain probe), matching the sibling branch's direction:
    // this only gates a NOTIFICATION, and one spurious page is far cheaper than the miss it
    // guards against. Reaching this line at all is rare, so it cannot become a flood.
    //
    // WI-36685: reuse the wake-starved branch's probe when it already ran for this owner rather
    // than paying a second one. Note the semantics survive the reuse: an owner that reached this
    // line WITH a `probed` verdict is one whose repairability gate said no, and `reachable` on
    // that same verdict is the honest answer to the different question asked here.
    const stillReachable =
      probed != null
        ? probed.reachable
        : await probeReachability(ownerId)
            .then((v) => v.reachable)
            .catch(() => true);
    if (stillReachable) disarmedWhileReachable.push(ownerId);
  }

  if (stalledOwners.length > 0 && !dryRun) {
    await broadcast({
      summary:
        `${stalledOwners.length} armed engine loop(s) auto-disarmed on ${ws} — fires kept LANDING ` +
        `with no turn produced behind them (WI-6639).`,
      body:
        `Owners: ${stalledOwners.join(', ')}. Each carried an ARMED loop (active:true) whose ` +
        `computeTurnsStalled verdict was true: fires were arriving and no turn followed them. ` +
        `Auto-disarmed by stalled-loops-guard. This is REVERSIBLE since WI-37546: if one of these ` +
        `owners makes progressing tool calls before the next sweep, the disarm is undone ` +
        `automatically (bounded to ${MAX_REVIVALS} revivals inside ` +
        `${Math.round(REVIVE_WINDOW_MS / 3600_000)}h) — so no action is needed for an agent that ` +
        `comes back on its own; re-arm with loop:arm only for one that does not. A cluster of ` +
        `stalls in one sweep is usually ONE systemic event (a wedged wake channel, a deploy, an ` +
        `operator restart) rather than independent failures — worth chasing if this recurs.` +
        (revivedAfterDisarm.length > 0
          ? `\n\nIN THE SAME SWEEP, ${revivedAfterDisarm.length} previously-disarmed loop(s) were ` +
            `REVIVED (${revivedAfterDisarm.join(', ')}) — each had been disarmed as turn-stalled and ` +
            `has since made progressing tool calls, so that verdict was wrong and the owner is working. ` +
            `Disarms and revivals in the SAME sweep mean this module's turn-stalled inference is ` +
            `over-firing right now, not that two unrelated things happened: treat the disarm list above ` +
            `with suspicion until the cause is known (WI-37546).`
          : '') +
        (reArmedFireStarved.length > 0
          ? `\n\nSEPARATELY, and NOT disarmed: ${reArmedFireStarved.length} loop(s) were FIRE-STARVED ` +
            `(${reArmedFireStarved.join(', ')}) — each answered the last fire it received and then no ` +
            `further fire arrived. That is a fault in the loop-FIRING path, not in those agents, so they ` +
            `were re-armed instead. Both symptoms appearing in the same sweep points at the scheduler ` +
            `itself (EI-19406534159939583).`
          : '') +
        (reArmedToolLiveParked.length > 0
          ? `\n\nALSO NOT disarmed: ${reArmedToolLiveParked.length} loop(s) were TOOL-LIVE BUT ` +
            `PARKED (${reArmedToolLiveParked.join(', ')}) — their owners were making progressing ` +
            `tool calls while next_fire_at remained at the in-flight sentinel. A liveness veto ` +
            `would only preserve that stuck park, so the active loops were made due immediately ` +
            `(P-008 / WI-41231).`
          : '') +
        (repairedWakeStarved.length > 0
          ? `\n\nALSO NOT disarmed: ${repairedWakeStarved.length} loop(s) were WAKE-STARVED ` +
            `(${repairedWakeStarved.join(', ')}) — their fires kept arriving but reached nobody, because no ` +
            `standing inbox-wake await was registered, so no wake-delivery row was ever created. Those ` +
            `agents were never asked for a turn. Their watch has been re-armed and the loops made due ` +
            `(WI-36685).`
          : '') +
        (disarmedUnaddressableHarness.length > 0
          ? `\n\nOF THE DISARMED ABOVE, ${disarmedUnaddressableHarness.length} could not have produced a ` +
            `turn: ${disarmedUnaddressableHarness.join(', ')} were armed against a harness their OWN ` +
            `session scope cannot address — the routine is on ${ws} while those sessions resolve to a ` +
            `different workspace, so every harness-scoped call they made returned harness_forbidden. They ` +
            `are not wedged; they were woken repeatedly to do work they could not reach. For THESE the ` +
            `"re-arm with loop:arm" advice above does NOT apply — re-arming leaves the scope unchanged ` +
            `and re-creates the same hole. Those sessions have to be relaunched with the correct ` +
            `workspace scope. Start at agent-tools/loop/arm.ts's harness_workspace_mismatch guard (it ` +
            `refuses to CREATE a new strand but cannot repair an existing one) and at whatever ` +
            `re-resolved those sessions' scope after they armed (EI-19966210024116714).`
          : ''),
      category: 'severe-event',
    });
  }

  // EI-19899301656065801: page the OWNER for the subset that was still REACHABLE when disarmed.
  //
  // Deliberately separate from the broadcast above rather than folded into it, because the two
  // have different audiences and different jobs. The broadcast tells the FLEET that a batch went
  // dark, which is a systemic-pattern signal ("a cluster is usually ONE event"). This tells the
  // ONE person who can do anything about it that a specific, still-present session has been made
  // permanently unwakeable and needs a manual `loop:arm` to come back.
  //
  // Guarded on a non-empty reachable subset, so the corpse-reaping case WI-6639 was built for —
  // sessions that ended long ago — stays as silent as it is today.
  //
  // The notify is wrapped in its own try/catch: paging is strictly an addition to this sweep's
  // job, and a push transport being down must never cost us the disarm bookkeeping or the
  // broadcast that already succeeded.
  // EI-19966210024116714: the subset of the page's population whose remedy is DIFFERENT. A
  // scope-stranded session is typically alive and answering probes — it is not wedged, it simply
  // cannot reach its own harness — so it lands in `disarmedWhileReachable` and would already be
  // paged today, with advice ("resume the session and re-arm its loop") that CANNOT work for it:
  // re-arming leaves the workspace scope exactly as it was and the next sweep disarms it again.
  //
  // Intersected rather than unioned, deliberately. This does NOT widen the gate below: a strand
  // that is NOT reachable is a corpse, and corpse-reaping staying silent is the whole point of
  // gating on a non-empty reachable subset (see the rationale above). Paging for one would be the
  // noise that guard exists to prevent.
  const unaddressableSet = new Set(disarmedUnaddressableHarness);
  const strandedAndReachable = disarmedWhileReachable.filter((o) => unaddressableSet.has(o));

  if (disarmedWhileReachable.length > 0 && !dryRun) {
    try {
      await notify({
        kind: 'intervention',
        title:
          disarmedWhileReachable.length === 1
            ? `Agent ${disarmedWhileReachable[0]} was disarmed while still reachable — it cannot wake itself`
            : `${disarmedWhileReachable.length} reachable agents were disarmed — they cannot wake themselves`,
        body:
          `${disarmedWhileReachable.join(', ')}\n\n` +
          `Each was still answering a reachability probe when stalled-loops-guard disarmed its ` +
          `engine loop for producing no turns despite repeated fires. The disarm is correct — an ` +
          `agent that is not answering its fires will not be helped by more of them — and it is ` +
          `no longer permanent: since WI-37546 a turn-stalled disarm is AUTOMATICALLY REVERSED by ` +
          `the next sweep if the owner makes progressing tool calls in the meantime (up to ` +
          `${MAX_REVIVALS} revivals, within ${Math.round(REVIVE_WINDOW_MS / 3600_000)}h). So an agent ` +
          `that comes back on its own will be re-armed without you.\n\n` +
          `You still matter to the ones that DON'T come back: an owner that makes no tool calls at ` +
          `all stays down, because nothing distinguishes it from a corpse. To bring one back by ` +
          `hand: resume the session and re-arm its loop (loop:arm). If this keeps happening, the ` +
          `upstream question is why the sessions stop turning — a died carry-respawn and a wedged ` +
          `CLI child both present this way.` +
          (strandedAndReachable.length > 0
            ? `\n\n⚠ ${strandedAndReachable.length} of these will NOT be fixed by that: ` +
              `${strandedAndReachable.join(', ')} had their loop armed against a harness their own ` +
              `session scope cannot address — the routine is on ${ws} while the session resolves to a ` +
              `different workspace, so every harness-scoped call returns harness_forbidden. Nothing was ` +
              `wrong with the agent; it was woken to do work it could not reach. Re-arming leaves the ` +
              `scope unchanged and the next sweep disarms it again. RELAUNCH those sessions with the ` +
              `correct workspace scope, or re-arm them against a harness the session can actually ` +
              `reach (EI-19966210024116714).`
            : ''),
        importance: 'urgent',
        workspaceId: ws,
        data: {
          owners: disarmedWhileReachable.join(','),
          count: disarmedWhileReachable.length,
          unaddressableHarness: strandedAndReachable.join(','),
          unaddressableHarnessCount: strandedAndReachable.length,
        },
      });
    } catch (e) {
      console.warn(
        `[stalled-loops-guard] owner page failed for ${disarmedWhileReachable.length} reachable ` +
          `disarm(s) (${disarmedWhileReachable.join(', ')}): ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // EI-19406534159939583: a fire-starved batch with NO turn-stalled disarms alongside it still
  // needs to be loud. It is arguably the MORE serious of the two — agents that are alive and
  // working are receiving no wakes — and before this split it was invisible, because the only
  // broadcast in this module was gated on `stalledOwners.length > 0`.
  //
  // WI-36685 folds the WAKE-starved population into this same broadcast rather than adding a
  // second one. Both are "live agents the delivery path stopped serving", they differ only in
  // WHERE it broke (no fire emitted vs. a fire that reached nobody), and a sweep that turns up
  // both at once is emphatically ONE event — emitting two notices for it would be the exact
  // "don't spam N inboxes for one root cause" failure this module's own broadcast avoids.
  //
  // The SUMMARY still names the specific fault when only one population is present — a reader
  // paged by this line should not have to open the body to learn whether fires stopped or fires
  // landed nowhere, since those point at different code. Only a genuinely mixed sweep gets the
  // generic wording.
  //
  // WI-37546 folds REVIVALS into this same notice for the same reason, and it is the sharpest
  // case for not adding a third broadcast: a revival is the module reporting that its OWN earlier
  // verdict was wrong. That belongs next to the starved populations — all three say "this system,
  // not these agents" — and a sweep that produces revivals alongside starvation is emphatically
  // one event. When revivals are the ONLY finding, the summary says so plainly rather than
  // reporting them under a starvation headline.
  const starved = [...reArmedFireStarved, ...repairedWakeStarved, ...reArmedToolLiveParked];
  if ((starved.length > 0 || revivedAfterDisarm.length > 0) && stalledOwners.length === 0 && !dryRun) {
    await broadcast({
      summary:
        starved.length === 0
          ? `${revivedAfterDisarm.length} engine loop(s) on ${ws} were RE-ARMED after a wrong ` +
            `turn-stalled disarm — their owners were working all along (WI-37546).`
          : repairedWakeStarved.length === 0 && reArmedToolLiveParked.length === 0
            ? `${reArmedFireStarved.length} armed engine loop(s) on ${ws} stopped RECEIVING fires while still ` +
              `answering them — re-armed, not disarmed (EI-19406534159939583).`
            : reArmedFireStarved.length === 0 && reArmedToolLiveParked.length === 0
              ? `${repairedWakeStarved.length} armed engine loop(s) on ${ws} had every fire reach NOBODY — no ` +
                `standing inbox-wake await, so nothing was ever delivered; repaired, not disarmed (WI-36685).`
              : reArmedFireStarved.length === 0 && repairedWakeStarved.length === 0
                ? `${reArmedToolLiveParked.length} armed engine loop(s) on ${ws} were TOOL-LIVE but stuck ` +
                  `parked at the in-flight sentinel — made due immediately, not disarmed (WI-41231).`
                : `${starved.length} armed engine loop(s) on ${ws} were being STARVED of turns while still alive — ` +
                  `repaired, not disarmed (EI-19406534159939583 / WI-36685 / WI-41231).`,
      body:
        (reArmedFireStarved.length > 0
          ? `FIRE-STARVED (no fire emitted): ${reArmedFireStarved.join(', ')}. Each one's most recent turn ` +
            `is at or after its most recent fire — it answered every fire it was given — and then a stall ` +
            `floor's worth of time passed with no new fire. They have been made due immediately ` +
            `(next_fire_at = now). A cluster here means the scheduler tick, the loop completion-rebase, or ` +
            `a shed that skips it — start at routines-workflow.ts's routinesTick.\n\n`
          : '') +
        (repairedWakeStarved.length > 0
          ? `WAKE-STARVED (fires emitted, reached nobody): ${repairedWakeStarved.join(', ')}. Fires kept ` +
            `arriving on schedule, but no standing coord:inbox-wake await was registered for these owners, ` +
            `so each emit matched nothing and NO event_wake_deliveries row was created — the agents were ` +
            `never actually spoken to. Their watch has been re-armed and the loops made due. A cluster ` +
            `here means awaits are being cancelled or never armed — start at the SessionEnd hook's ` +
            `cancel path and loop-fire's ensureInboxWakeArmedForActiveSession self-heal.\n\n`
          : '') +
        (reArmedToolLiveParked.length > 0
          ? `TOOL-LIVE PARKED (working owner, completion rebase missing): ` +
            `${reArmedToolLiveParked.join(', ')}. Each owner made progressing tool calls after its ` +
            `last fire while the active routine remained parked at next_fire_at = infinity. A plain ` +
            `liveness veto would leave that schedule stuck, so the loops were made due immediately ` +
            `with the existing self-correcting re-arm write (WI-41231).\n\n`
          : '') +
        (revivedAfterDisarm.length > 0
          ? `REVIVED (wrongly disarmed earlier, owner demonstrably working): ` +
            `${revivedAfterDisarm.join(', ')}. Each had been disarmed by THIS module as turn-stalled and ` +
            `has since made progressing tool calls — a second distinct tool or a successful call, not ` +
            `merely call volume. Their loops have been re-armed and made due. A disarm is a pause with a ` +
            `condition, not a one-way door; this is bounded to ${MAX_REVIVALS} revivals per loop inside ` +
            `${Math.round(REVIVE_WINDOW_MS / 3600_000)}h, after which a repeat offender stays down and ` +
            `stays visible. A sustained non-zero count here is a signal about the turn-stalled ` +
            `INFERENCE — start at why last_turn_at goes stale for owners that are visibly working ` +
            `(WI-37546).\n\n`
          : '') +
        `The agents are not at fault in any of these cases. If they resume, the delivery path (or this ` +
        `module's own verdict) was the problem; if a fire now lands and no turn follows, the next sweep ` +
        `reclassifies and disarms them normally.`,
      category: 'severe-event',
    });
  }

  // Cadence drift is a diagnostic condition, not a liveness verdict. Emit one ambient notice for
  // the workspace so operators can inspect scheduler/turn duration without turning a slow loop
  // into an irreversible pause. The one-shot condition avoids an inbox storm while the same
  // sustained episode remains visible; the condition resolver can close it once the signal clears.
  if (cadenceDriftDetails.length > 0 && !dryRun) {
    await broadcast({
      summary:
        `${cadenceDriftDetails.length} active engine loop(s) on ${ws} show sustained cadence drift ` +
        `(advisory only; no loop was paused).`,
      body:
        cadenceDriftDetails
          .map(
            ({ ownerId, status }) =>
              `${ownerId}: ratio=${status.cadenceRatio}, firesSinceArm=${status.firesSinceArm}, ` +
              `expected=${status.expectedFiresSinceArm}, longestGapSec=${status.longestObservedGapSec}`,
          )
          .join('\n') +
        `\n\nThis signal requires multiple fires plus a large observed gap. Pure loops re-arm after ` +
        `turn completion, so a long-running turn can inflate the ratio; inspect scheduler and ` +
        `turn duration before treating it as a defect. Cadence drift never disarms or re-arms a loop.`,
      category: 'loop-cadence-advisory',
      conditionKey: `loop-cadence-drift:${ws}`,
      oneShot: true,
    });
  }

  // P-007 — independent, fail-open advisory read. It deliberately runs AFTER every existing
  // reaper/revival/repair decision and its reporting, so a broken or slow aggregate cannot alter
  // their ordering, widen a veto, suppress a disarm, or prevent their broadcast. The explicit
  // unknown result also keeps a blind monitor from masquerading as a healthy zero.
  const population: LoopPopulationSnapshot = !hasActiveLoops
    ? {
        status: 'measured',
        active: 0,
        parked: 0,
        parkedRatio: null,
        parkedZeroTool3h: 0,
        parkedZeroToolRatio: null,
        ownerSample: [],
      }
    : await readPopulation({ sql, workspaceId: ws }).catch((e) => {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(
          `[stalled-loops-guard] population read failed (${reason}) — population status is UNKNOWN; ` +
            `the existing reaper continues unchanged.`,
        );
        return { status: 'unknown' as const, reason };
      });

  // P-007 — forty individually ordinary-looking parked rows can be ONE workspace incident. The
  // high zero-tool share is the gate; parkedRatio is included only as context because a healthy
  // long turn is parked at infinity by design. One-shot prevents an inbox storm while the same
  // episode persists.
  if (isLoopPopulationStarvation(population) && !dryRun) {
    await broadcast({
      summary:
        `${population.parkedZeroTool3h} of ${population.parked} parked engine-loop owners on ${ws} ` +
        `made zero agent-authored tool calls in the last 3h — workspace population starvation.`,
      body:
        `Active loops: ${population.active}. Parked at infinity: ${population.parked} ` +
        `(${(population.parkedRatio! * 100).toFixed(1)}% of active; context only). Parked with zero ` +
        `agent-authored, non-bookkeeping tool calls in 3h: ${population.parkedZeroTool3h} ` +
        `(${(population.parkedZeroToolRatio! * 100).toFixed(1)}% of parked). ` +
        `Owner sample: ${population.ownerSample.join(', ') || '(none)'}.\n\n` +
        `This is an aggregate scheduler/wake-path signal: each row may look like an ordinary ` +
        `in-flight park, but a majority of the parked population going tool-silent together is ` +
        `one systemic incident. The detector is advisory only and did not pause, re-arm, revive, ` +
        `or otherwise change any loop. Start with the shared fire/delivery path and provider ` +
        `availability, not the individual owners.`,
      category: 'loop-population-advisory',
      conditionKey: `loop-population-starvation:${ws}`,
      oneShot: true,
    });
  }

  return {
    checked: rows.length,
    paused: stalledOwners.length,
    sample: stalledOwners.slice(0, 5),
    vetoedByRecentTurn,
    reArmedFireStarved,
    vetoedByProviderWall,
    disarmedWhileReachable,
    repairedWakeStarved,
    vetoedByWithheldFire,
    disarmedUnaddressableHarness,
    vetoedByToolActivity,
    reArmedToolLiveParked,
    revivedAfterDisarm,
    cadenceDrift,
    population,
    dryRun,
  };
}
