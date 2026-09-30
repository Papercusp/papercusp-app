/**
 * liveness-alarm — the REQUEST-PATH supervision alarm
 * (infra-self-healing-supervision-2026-06-19, R4-3 + R4-8).
 *
 * `computeSystemHealth` (compute.ts) already aggregates 15 panels — dead routines,
 * queen/overwatch liveness, git-sync staleness, PG, the LLM account pool — and
 * `runSystemHealthTick` keeps a per-workspace cache warm. EI-1622 moved that
 * tick out of DBOS and into the in-process periodic scheduler, so it no longer
 * writes workflow_status rows; this request-path alarm remains as the independent
 * watcher for bg-host down / BACKGROUND_WORKERS=0 regressions and stale snapshots.
 *
 * This alarm runs on a :3070 REQUEST worker loop (in cluster mode the workers are
 * request-only, structurally separate from the bg primary; single-process degrades
 * cleanly), and on a degraded TRANSITION fires an out-of-band owner escalation.
 * Two independent liveness sources:
 *   1. the rollup's own CRITICAL panels (dead routines, queen dark, accounts
 *      starved, any panel self-reporting `crit`); and
 *   2. a STALE shared DBOS `routinesTick` watermark — this is the authoritative
 *      cross-process heartbeat for the separate bg host. The request worker's
 *      `lastSystemHealth` cache is process-local and therefore cannot prove bg-host
 *      liveness (WI-4773). This signal needs NO live engine to detect a dead engine.
 *
 * Transition-only + per-signal debounced so it never spams; env-killable
 * (PAPERCUSP_INFRA_LIVENESS_ALARM=0). The watcher does not live in what it watches.
 *
 * EI-2146 — dedup + auto-resolve (detector-failure fix). The per-signal
 * `lastAlertedAt` debounce is in-memory, so it is per-WORKER and per-PROCESS: in
 * cluster mode (N request workers) and across restarts it does NOT dedup, so one
 * ~4h incident left dozens of identical never-closing `blocker` escalations that
 * drowned real signal and grew coord_event_log unbounded. The durable fix keys
 * off the escalation LOG itself (a stable per-signal signature):
 *   1. DEDUP — never open a second escalation while one with the same signature
 *      is still open (collapse repeats into one row; re-fire only after recovery).
 *   2. AUTO-RESOLVE-ON-RECOVERY — each tick, resolve every open infra-liveness
 *      escalation whose condition is no longer firing. On the first post-deploy
 *      tick this is the one-time backlog sweep of the recovered cohort.
 *   3. FALSE-POSITIVE SUPPRESSION — "no bees running" is NOT a fault when the
 *      placement frontier is genuinely empty (an idle fleet is correct).
 *
 * EI-9939 — flap-episode suppression (the fleet-wide re-broadcast TAX fix).
 * EI-2146's own "re-fire only after auto-resolve" design is CORRECT for a
 * genuine second incident but, for a condition that FLAPS (fires, recovers,
 * re-fires — e.g. the routine-engine-starvation flap observed 2026-07-11/12,
 * repeat_count up to 31 in one session), it meant every flap cycle re-sent a
 * fleet-wide `page()` alarm + `pageResolved()` all-clear to `to:['*']` — pure
 * context tax on every live + parked session, none of whom own the flapping
 * routine. `flapEpisodes` below tracks each blocker signature's fire count
 * within a rolling window (default 30min, `DEFAULT_FLAP_THRESHOLD`=2): the
 * first two fires page normally (byte-identical to pre-EI-9939 behavior); the
 * 3rd+ fire in the same window is classified as flapping and its broadcast is
 * suppressed (the durable escalation row is written regardless — this only
 * gates the fleet-wide push). A suppressed episode gets exactly ONE final
 * all-clear once it stays quiet for a full flap window with no re-fire (the
 * "settle sweep"), which supersedes every earlier alert sharing that
 * condition_key via coord:inbox's `annotateResolvedConditions` — so a reader
 * who only saw the FIRST fire still learns it eventually cleared. A single
 * SUSTAINED incident (fires once, stays open) never enters flap tracking at
 * all and is completely unaffected. The routine-engine flapping ITSELF (why
 * dead-routines keeps firing/recovering) remains its own, separate open bug —
 * this only stops the ALARM SYSTEM from amplifying it into a broadcast storm.
 */
import {
  PANEL_LABELS,
  type SystemHealth,
  type PanelKey,
  type InfraHealth,
  type DeadRoutineNameCoverage,
} from './types';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { lastSystemHealth, readSharedSystemHealthSnapshot } from './compute';
import {
  openEscalation,
  listEscalationsPaginated,
  resolveEscalation,
  type EscalationSeverity,
  type EscalationRecord,
} from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { activeWorkspaceId } from '../workspace-registry';
import { notifyAttention } from '../attention-notify';
import { broadcastSevereEvent, broadcastSevereEventResolvedMany } from '../severe-event-broadcast';
import { resolveSevereEventOwner } from '../severe-event-owner';
import { currentLoopLag } from '../event-loop-lag-monitor';
import {
  readRoutineEngineLiveness as readSharedRoutineEngineLiveness,
  type RoutineEngineLiveness,
} from '../release/routine-engine-liveness';
import {
  d026QuiescenceIsActive,
  readD026QuiescenceEvidence,
  type D026QuiescenceEvidence,
} from './single-primary-check';
import {
  infraCritAmbientOnly,
  POOL_PROJECTION_STALE_WARN_MS,
  projectionWriteStalled,
} from './thresholds';

export const INFRA_LIVENESS_IDENTITY: AgentIdentity = {
  ownerId: 'system:infra-liveness-alarm',
  ownerLabel: 'system · infra-liveness-alarm',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** A live supervision problem worth an out-of-band owner alert. */
export type HealthTickStallCause =
  | 'pg-pool-starvation'
  | 'event-loop-pressure'
  | 'routine-engine-stall'
  | 'background-worker-unavailable'
  | 'unattributed-stale-tick';

/** Durable evidence attached to a stale health-tick signal. */
export interface HealthTickStallDiagnosis {
  cause: HealthTickStallCause;
  evidence: string[];
  snapshotAgeMs: number;
  lastSnapshotAtMs: number | null;
  observedAtMs: number;
}

export interface AlarmSignal {
  key: string;
  severity: EscalationSeverity;
  summary: string;
  diagnosis?: HealthTickStallDiagnosis;
}

const DEFAULT_SNAPSHOT_STALE_MS = 6 * 60_000;
const DEFAULT_DEBOUNCE_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 2 * 60_000;
/** 6h since the last wake before an enabled-but-STOPPED overwatch fires
 *  `rubric-emission-dark` — generous vs any deliberate short pause. */
const RUBRIC_EMISSION_DARK_GRACE_MS = 6 * 60 * 60_000;

/**
 * EI-9794 — Kettle silently stopped firing for ~11h while `last_status` stayed
 * 'ok' and `consecutive_errors` stayed 0 (both are only WRITTEN on a fire, so a
 * loop that stops firing entirely freezes them at their last-good values
 * forever — green status is not proof of life). The existing signals #4/#4b/#4c
 * above all gate on `overwatchAlive` / `panels.overwatch.data.started`, which
 * derive from the `overwatch-wake` ROUTINE row's `armed` bit (cross-monitor.ts
 * `isDark`) — but that routine is a self-deactivating ONE-SHOT whose NORMAL
 * resting state between fires is `active=false, next_fire_at=NULL`, identical
 * to a fire that failed to re-arm. `harness_shared.autoloop_state.last_fired_at`
 * (stamped by `recordFire` on every ACTUAL fire, independent of the routine's
 * own re-arm bookkeeping) is the one signal that can't be spoofed by a
 * mid-re-arm crash — this alarm keys on ITS recency instead.
 */
export interface AutoloopFireRow {
  role: string;
  harnessSlug: string;
  /** epoch ms of `autoloop_state.last_fired_at`, or null if it has never fired. */
  lastFiredAtMs: number | null;
  cadenceSec: number;
  /** Is this role SUPPOSED to be actively firing right now (flag on + started)?
   *  false ⇒ vacuously fine, never alarm (mirrors cross-monitor.ts's `isDark`
   *  philosophy — a role that isn't running has nothing to be stale about). */
  expected: boolean;
}

/** How many cadences of silence before a fire-staleness alarm fires (env-tunable,
 *  matches the item's own suggested "N=3" — generous vs one missed/backed-off
 *  tick, sharp enough to catch an hours-long stall fast). */
function autoloopFireStaleMultiplier(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_FIRE_STALE_MULTIPLIER ?? 3);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/**
 * Attribute a stale system-health snapshot from the evidence available to the
 * request-path observer. This is deliberately conservative: a stale snapshot
 * alone proves a missed health tick, not its mechanism. Pool/loop evidence wins
 * over downstream dead-routine symptoms; when no corroborating signal exists we
 * say so explicitly instead of repeating the old unqualified "likely frozen".
 */
export function diagnoseHealthTickStall(
  health: SystemHealth,
  snapshotAgeMs: number,
  observedAtMs: number,
  lastSnapshotAtMs: number | null,
): HealthTickStallDiagnosis {
  const evidence: string[] = [];
  const infra = health.panels.infra?.data as
    | {
        pg?: { total?: number; active?: number } | null;
        pool?: { probeMs?: number; band?: string } | null;
        perf?: { status?: string; stale?: boolean; eventLoopLagP95Ms?: number | null; reasons?: string[] } | null;
      }
    | null
    | undefined;
  const workFeed = health.panels.workFeed?.data as
    | { deadRoutines?: number; deadRoutineNames?: string[] }
    | null
    | undefined;
  const loop = currentLoopLag();

  if (infra?.pool?.band === 'critical') {
    evidence.push(`pg acquire probe ${infra.pool.probeMs ?? '?'}ms (critical)`);
  }
  if (loop && Number.isFinite(loop.p95Ms) && loop.p95Ms >= 600) {
    evidence.push(`event-loop p95 ${Math.round(loop.p95Ms)}ms (critical)`);
  }
  if (infra?.perf && !infra.perf.stale && infra.perf.eventLoopLagP95Ms != null && infra.perf.eventLoopLagP95Ms >= 1000) {
    evidence.push(`captured event-loop p95 ${Math.round(infra.perf.eventLoopLagP95Ms)}ms (critical)`);
  }
  if ((workFeed?.deadRoutines ?? 0) > 0) {
    const names = workFeed?.deadRoutineNames?.slice(0, 3).join(', ');
    evidence.push(`${workFeed?.deadRoutines} overdue routine(s)${names ? `: ${names}` : ''}`);
  }
  if (infra?.pg === null) evidence.push('request-path PG read failed');

  const cause: HealthTickStallCause =
    infra?.pool?.band === 'critical'
      ? 'pg-pool-starvation'
      : loop && loop.p95Ms >= 600
        ? 'event-loop-pressure'
        : infra?.perf && !infra.perf.stale && infra.perf.eventLoopLagP95Ms != null && infra.perf.eventLoopLagP95Ms >= 1000
          ? 'event-loop-pressure'
          : (workFeed?.deadRoutines ?? 0) > 0
            ? 'routine-engine-stall'
            : infra?.pg === null
              ? 'background-worker-unavailable'
              : 'unattributed-stale-tick';

  if (evidence.length === 0) evidence.push('no corroborating pool, loop, routine, or PG evidence was readable');
  return { cause, evidence, snapshotAgeMs, lastSnapshotAtMs, observedAtMs };
}

/**
 * EI-15006 — the gating context for the `panel:bees` "no bees running" signal.
 *
 * A raw `bees.running === 0` is NOT by itself a fault: an idle-by-design pot (no
 * cup-placeable work + healthy capacity + other agents alive) legitimately runs
 * zero cups. The old gate suppressed the false positive ONLY when the raw survey
 * `frontier` was exactly 0 — but the survey frontier can carry non-cup / su-domain
 * / long-stuck residue (or read 0 while the spawner is genuinely DOWN), so it both
 * (a) FALSE-fired a blocker→human page during normal idle (the incident: frontier
 * 6, all su-domain, 9 su agents alive, dispatchBudget 20) AND (b) FALSE-suppressed
 * a genuine spawner-down when the frontier happened to be empty. This context lets
 * the predicate distinguish the three cases the alarm must get right.
 */
export interface BeesLivenessContext {
  /** Admissible cup-placeable frontier being left UNPLACED — the pot's FRESH,
   *  non-stuck placeable feature-family frontier (`frontier - frontierStuck`,
   *  the same "placeable" definition as reconcilePausedQueen
   *  use). >0 means real cup work is waiting while 0 bees run ⇒ genuine starvation. */
  cupPlaceableFrontier: number;
  /** The survey backing `cupPlaceableFrontier` FAILED to read this tick, so that
   *  number is a fabricated 0, not a measurement (`WorkFeedHealth.frontierUnreadable`).
   *  REQUIRED, deliberately: `cupPlaceableFrontier` is the leg that decides this gate
   *  (measured 08-04..08-07 — workspace fact
   *  `panel-bees-deciding-leg-is-cup-placeable-frontier`), and a fabricated 0 reads as
   *  "no cup work waiting" ⇒ `idle-by-design` ⇒ the bees-dead alarm is SUPPRESSED. An
   *  optional field would default that unsafe direction on every construction site that
   *  forgot it, which is the under-reporting the flag exists to prevent. */
  frontierUnreadable: boolean;
  /** Live bee-tier dispatch budget (spare cup-tier admission slots) from the
   *  gateway capacity oracle. null = unknown (gateway off/unreachable) — treated
   *  fail-safe (never forces a page on its own; see `beesIdleByDesign`). */
  dispatchBudget: number | null;
  /** The gateway is inside its fresh-restart recovery window — capacity reads are
   *  unreliable, so 0 bees during it is not proof of a healthy idle. */
  restartRecovering: boolean;
  /** Any OTHER agent is alive (su fleet / other bees / the Mug loop). If so the
   *  spawn+inference engine is demonstrably working, so 0 bees is a placement
   *  DECISION, not an infra outage. false ⇒ the spawner cannot be proven live. */
  otherAgentsAlive: boolean;
}

/**
 * PURE: is `bees.running === 0` the correct IDLE-BY-DESIGN state (⇒ informational,
 * NO blocker→human page)? True only when ALL hold:
 *   - no admissible cup-placeable frontier is being left unplaced, AND
 *   - the gateway is not mid-restart, AND
 *   - some other agent is alive (the spawner/engine is provably live), AND
 *   - capacity is not KNOWN-exhausted (dispatchBudget, when readable, is > 0).
 *
 * Any other shape ⇒ NOT idle-by-design ⇒ the signal fires: real cup work waiting
 * (starvation), or the spawner is not provably live (down / recovering / no other
 * agent alive), or the cup tier is known-full while zero bees run (a leaked/stuck
 * slot). `dispatchBudget === null` (gateway off/unreachable) is deliberately
 * fail-safe — it does NOT by itself force a page, because a pot with the gateway
 * disabled must still be able to sit idle; the other-agents-alive proof carries it.
 */
export function beesIdleByDesign(ctx: BeesLivenessContext): boolean {
  return beesIdleDecision(ctx).leg === 'idle-by-design';
}

/** Which leg of {@link beesIdleDecision} decided the verdict. */
export type BeesIdleLeg =
  | 'frontier-unreadable'
  | 'cup-work-waiting'
  | 'gateway-restart-recovering'
  | 'no-other-agent-alive'
  | 'dispatch-budget-exhausted'
  | 'idle-by-design';

/**
 * EI-19474857043229377 — {@link beesIdleByDesign}'s verdict PLUS the leg that decided it.
 *
 * The boolean alone made every occurrence of this gate flipping undiagnosable after the
 * fact. Diagnosing ONE burst window cost four wakes of elimination — each leg had to be
 * re-measured live, and by then the window had closed and every leg read constant
 * (measured 2026-08-04T01:5xZ: cupPlaceableFrontier 0 across 12 surveyPot samples with 0
 * throws, gateway 60/60 reachable at p50 2ms with dispatchBudget pinned at 15/15,
 * restartRecovering false on 47.6h uptime, otherAgentsAlive true on suLive 65 —
 * `idleByDesign: true` in 6/6 fresh snapshots, ~1h45m AFTER the flap stopped at 00:14:32Z).
 * Every leg is a transient runtime value that NOTHING persists, so a post-hoc reader has
 * no way back to the moment: `system_health_ticks` stores panel STATUSES only, and
 * `workFeedStatus` does not read `frontier`/`frontierStuck` at all, so the frontier can
 * swing 0↔N with every panel status pinned — which is why "all panels constant across the
 * burst" was NOT the exculpatory evidence it appeared to be.
 *
 * So the leg travels with the verdict, and {@link describeBeesLiveness} puts the raw
 * numbers in the durable resolve note. The next occurrence names its own cause.
 */
export function beesIdleDecision(ctx: BeesLivenessContext): { idle: boolean; leg: BeesIdleLeg } {
  // The survey failed ⇒ cupPlaceableFrontier is a fabricated 0, not a measurement, and
  // this gate CANNOT prove idle from it. Checked FIRST — not because the outcome would
  // otherwise differ (a fabricated 0 falls through the next branch anyway) but because
  // the ATTRIBUTION would: the note must say "that number is not an observation" rather
  // than blame whichever downstream leg happened to catch it. Fail-safe: never suppress.
  if (ctx.frontierUnreadable) return { idle: false, leg: 'frontier-unreadable' };
  // real cup work unplaced → starvation, not idle
  if (ctx.cupPlaceableFrontier > 0) return { idle: false, leg: 'cup-work-waiting' };
  // gateway restarting → capacity unproven
  if (ctx.restartRecovering) return { idle: false, leg: 'gateway-restart-recovering' };
  // spawner/engine not provably live
  if (!ctx.otherAgentsAlive) return { idle: false, leg: 'no-other-agent-alive' };
  // cup tier KNOWN-full while 0 bees run → anomaly
  if (ctx.dispatchBudget !== null && ctx.dispatchBudget <= 0) {
    return { idle: false, leg: 'dispatch-budget-exhausted' };
  }
  // 0 bees, no cup work, engine alive, capacity not known-exhausted → correct idle
  return { idle: true, leg: 'idle-by-design' };
}

/**
 * The gate's INPUTS as a durable one-liner — every leg, raw, plus the deciding leg.
 *
 * Written into the resolve note so a future reader can diff the values at fire time
 * against the values at resolve time and read off which number moved, instead of
 * re-deriving it by live elimination after the window has closed.
 */
export function describeBeesLiveness(ctx: BeesLivenessContext): string {
  const { leg } = beesIdleDecision(ctx);
  return (
    // An unreadable survey renders as `unreadable` rather than the fabricated 0 —
    // printing the 0 is what made this indistinguishable from an observed zero.
    `cupPlaceableFrontier=${ctx.frontierUnreadable ? 'unreadable' : ctx.cupPlaceableFrontier} ` +
    `dispatchBudget=${ctx.dispatchBudget ?? 'unknown'} ` +
    `restartRecovering=${ctx.restartRecovering} ` +
    `otherAgentsAlive=${ctx.otherAgentsAlive} ⇒ ${leg}`
  );
}

/**
 * PURE: derive the non-capacity legs of {@link BeesLivenessContext} from a health
 * snapshot, folding in the gateway-sourced capacity legs. Kept pure (capacity is
 * injected) so the whole gate is unit-testable without I/O.
 */
export function beesLivenessFromHealth(
  health: SystemHealth,
  capacity: { dispatchBudget: number | null; restartRecovering: boolean },
): BeesLivenessContext {
  const wf = health.panels.workFeed?.data;
  const frontier = wf?.frontier ?? 0;
  const frontierStuck = wf?.frontierStuck ?? 0;
  const cupPlaceableFrontier = Math.max(0, frontier - frontierStuck);
  // SCOPED DELIBERATELY to the flag the survey's catch sets — the MEASURED defect.
  //
  // A missing/null-data workFeed panel fabricates the same 0 and is arguably "unobserved"
  // too, and treating it as unreadable here is what the `unreadable ≠ clear` principle
  // suggests. It is NOT done, on purpose: no such snapshot has been OBSERVED in production
  // (collectWorkFeed is panelSafe-wrapped, so the panel is present even when the survey
  // fails — which is precisely why the flag was needed), while the change would un-suppress
  // panel:bees for every caller whose snapshot lacks the panel. Widening a fail-safe to
  // cover an unmeasured state, in an alarm that was firing 76×/day, buys a plausible
  // principle with real page volume. If that snapshot shape is ever observed, flag it at
  // its source the way the survey does; do not infer it here.
  const frontierUnreadable = wf?.frontierUnreadable === true;
  const suLive = health.panels.suFleet?.data?.live ?? 0;
  const beesAlive = health.panels.bees?.data?.alive ?? 0;
  const queenAlive = health.crossMonitor?.queenAlive === true;
  return {
    cupPlaceableFrontier,
    frontierUnreadable,
    dispatchBudget: capacity.dispatchBudget,
    restartRecovering: capacity.restartRecovering,
    otherAgentsAlive: suLive > 0 || beesAlive > 0 || queenAlive,
  };
}

/**
 * Fetch the cup(bee)-tier dispatch budget + fresh-restart flag from the gateway
 * capacity oracle (the SAME `buildCapacityReport` the Mug's placement clamp reads,
 * so this can never disagree with what placement sees). Fail-soft: any error /
 * gateway-off ⇒ `{ dispatchBudget: null, restartRecovering: false }` (unknown —
 * `beesIdleByDesign` then relies on the other-agents-alive proof).
 */
async function readGatewayBeeCapacity(): Promise<{ dispatchBudget: number | null; restartRecovering: boolean }> {
  try {
    const [{ fetchGatewayHeadroom }, { buildCapacityReport }] = await Promise.all([
      import('../inference-gateway/observability'),
      import('../fleet/capacity-dispatch'),
    ]);
    const hr = await fetchGatewayHeadroom({ timeoutMs: 1200 });
    const report = buildCapacityReport(hr, { clampArmed: false });
    return { dispatchBudget: report.dispatchBudget, restartRecovering: report.restartRecovering };
  } catch {
    return { dispatchBudget: null, restartRecovering: false };
  }
}

/**
 * Build the full {@link BeesLivenessContext} for a health snapshot: the pure
 * snapshot legs + a live gateway-capacity fetch. Used by BOTH the source alarm
 * (`runLivenessAlarmTick`) AND the condition-staleness RECONCILER
 * (`defaultReadInfraLivenessHealth`) so the two can never drift on whether the
 * `panel:bees` signal is firing. Fail-soft (never throws).
 */
export async function readBeesLivenessContext(health: SystemHealth): Promise<BeesLivenessContext> {
  const capacity = await readGatewayBeeCapacity();
  return beesLivenessFromHealth(health, capacity);
}

/**
 * Render the D-026-specific dead-routine advisory. Keep this wording distinct from
 * `formatDeadRoutinesSummary`: the legacy `dead routine(s)` marker is the fallback
 * classifier for old blocker rows, so a quiesced advisory must never derive that
 * blocker signature by accident.
 */
export function formatD026QuiescedSummary(wf: {
  deadRoutines: number;
  deadRoutineNames?: string[];
  deadRoutinesInScope?: number;
  deadRoutinesDistinct?: number;
}): string {
  const count = wf.deadRoutines;
  const total = wf.deadRoutinesInScope;
  const hasDenominator = typeof total === 'number' && total > 0 && count <= total;
  const population = hasDenominator ? `${count} of ${total}` : `${count}`;
  const names = wf.deadRoutineNames?.length ? `: ${wf.deadRoutineNames.join(', ')}` : '';
  const distinctNote =
    typeof wf.deadRoutinesDistinct === 'number' && wf.deadRoutinesDistinct !== count
      ? ` (${wf.deadRoutinesDistinct} distinct)`
      : '';
  return (
    `expected D-026 quiescence — ${population} overdue routine(s)${distinctNote}${names}; ` +
    `the authorized cut + restore units are active and hold the Corestore lock. ` +
    `Do NOT start or restart bg-host until the restore leg completes.`
  );
}

/**
 * PURE: derive the critical supervision signals from a SystemHealth snapshot.
 * `snapshotAgeMs` is the age of `lastSystemHealth` at evaluation (null = the
 * snapshot was computed fresh this tick, so staleness is not a signal).
 */
/**
 * P-009 (ex-P-010, EI-22489500008234936): git-sync is fleet-blocking. While it is starved, nothing
 * any agent writes reaches a commit. The generic dead-routine alarm fires only once a routine is
 * 10 to 20 minutes overdue. This one fires on the cadence-relative measure
 * (deriveGitSyncFreshness.missed_intervals) once it EXCEEDS this count.
 */
export const GIT_SYNC_MISSED_INTERVALS_ALARM = 3;

export function evaluateLivenessAlarm(
  health: SystemHealth,
  snapshotAgeMs: number | null,
  opts: {
    snapshotStaleMs?: number;
    prevPostmasterStartMs?: number | null;
    /** EI-9794: fresh `autoloop_state` fire-recency rows (see the type doc above).
     *  Optional — omitted/empty means "not evaluated this tick" (fail-open, never
     *  a false negative from a caller that hasn't wired the fetch). */
    autoloopFireRows?: AutoloopFireRow[];
    /** EI-11841: typed evidence for a stale health tick, computed by the request-path
     *  caller while the last successful snapshot is still available. */
    stallDiagnosis?: HealthTickStallDiagnosis;
    /** EI-15006: cup-placeable-frontier + capacity gating for the `panel:bees`
     *  "no bees running" signal. Omitted ⇒ the LEGACY EI-2146 gate (suppress only
     *  when the raw survey frontier is 0) — kept so an old/pure caller never
     *  regresses; the live source + reconciler always thread this. */
    beesLiveness?: BeesLivenessContext;
    /** D-026: complete cut + restore evidence intentionally downgrades overdue
     *  routines to a distinct advisory. Omitted/partial evidence preserves the
     *  ordinary dead-routines blocker (fail-closed). */
    d026Quiescence?: D026QuiescenceEvidence;
  } = {},
): AlarmSignal[] {
  const staleMs = opts.snapshotStaleMs ?? DEFAULT_SNAPSHOT_STALE_MS;
  // EI-1695: a stale snapshot means the bg routine engine is frozen — the SAME
  // condition that blinds the in-engine account-state read into a false
  // all-paused 'accounts-starved'. Compute it once so that derived signal can be
  // folded into the one root-cause (health-tick-stale) blocker below instead of
  // firing N separate rate-starvation blockers for one incident.
  const tickStale = snapshotAgeMs !== null && snapshotAgeMs > staleMs;
  const signals: AlarmSignal[] = [];

  // 1. The bg health-tick itself stalled → the routine engine (and the watchdog
  //    that lives in it) is likely frozen. The request-path catch for the
  //    BACKGROUND_WORKERS=0 / bg-host-down class.
  if (tickStale) {
    const diagnosis = opts.stallDiagnosis;
    const detail = diagnosis
      ? ` Root cause: ${diagnosis.cause}; evidence: ${diagnosis.evidence.join('; ')}; last successful tick ${diagnosis.lastSnapshotAtMs === null ? 'unknown' : new Date(diagnosis.lastSnapshotAtMs).toISOString()}; observed ${new Date(diagnosis.observedAtMs).toISOString()}.`
      : '';
    signals.push({
      key: 'health-tick-stale',
      severity: 'blocker',
      summary: `system-health tick stale for ${Math.round(snapshotAgeMs / 60_000)}m — the background routine engine (DBOS) may be frozen; routines / git-sync / Mug may be stalled and the in-engine watchdog may be blind.${detail}`,
      ...(diagnosis ? { diagnosis } : {}),
    });
  }

  // 2. Dead routines — active cron routines long overdue (the routine engine is
  //    starved/frozen). During the complete D-026 cut + restore contract the same
  //    reading is expected maintenance noise, not a restart-worthy outage. The
  //    advisory gets its own signature so old blocker rows can be reclassified
  //    explicitly rather than treated as recovered.
  const gitSyncMissed = health.panels.deploy?.data?.gitSyncMaxMissedIntervals ?? null;
  if (typeof gitSyncMissed === 'number' && gitSyncMissed > GIT_SYNC_MISSED_INTERVALS_ALARM) {
    const slug = health.panels.deploy?.data?.gitSyncMissedIntervalsInstallSlug ?? null;
    signals.push({
      key: 'git-sync-missed-intervals',
      severity: 'blocker',
      summary:
        `git-sync${slug ? ` on ${slug}` : ''} has missed ${gitSyncMissed} consecutive scheduler intervals: ` +
        `nothing written there is being committed. Read routines:list { name:'git-sync'` +
        `${slug ? `, installSlug:'${slug}'` : ''} } health.git_sync_freshness (the scheduler leg vs the ` +
        `execution leg, and safe_to_restart) before restarting anything.`,
    });
  }
  const wf = health.panels.workFeed?.data;
  if (wf && wf.deadRoutines > 0) {
    if (d026QuiescenceIsActive(opts.d026Quiescence)) {
      signals.push({
        key: 'dead-routines-quiesced',
        severity: 'advisory',
        summary: formatD026QuiescedSummary(wf),
      });
    } else {
      signals.push({
        key: 'dead-routines',
        severity: 'blocker',
        // Pass the deploy panel's measured last-sync so a commit-outage claim can be refuted by
        // direct observation rather than resting on overdue scheduler rows alone (EI-23794126226234520).
        summary: formatDeadRoutinesSummary(wf, {
          gitSyncLastSyncedAtMs: health.panels.deploy?.data?.gitSyncLastSyncedAtMs ?? null,
          nowMs: Date.now(),
        }),
      });
    }
  }

  // 2b. Stale-paused routines (WI-5839 / EI-18654017982759582 items 2+3) — the
  //     PAUSED complement of #2 above, which readDeadRoutines can never see
  //     (active=true only). A release/deploy-critical routine (release-trigger,
  //     green-checkpoint) on a stale/unexplained pause is a `blocker`: main can go
  //     green+ahead for days while nothing deploys, and nobody is told. Any OTHER
  //     stale-paused routine is only an `advisory` — real, but not fleet-blocking.
  if ((wf?.stalePausedRoutines ?? 0) > 0) {
    const critical = wf?.stalePausedCriticalRoutines ?? 0;
    // EI-18718973731535914: `stalePausedRoutineNames` is sorted critical-first (see
    // computeStalePausedRoutines), so its first `critical` entries ARE exactly the
    // critical ones — slice to those for the critical-severity message. Using the
    // unfiltered top-4 here previously mixed in non-critical names (e.g. a long-dead
    // decommissioned routine sharing the "oldest first" sort position) into a message
    // that reads "release/deploy-critical routine(s) … : X, Y, Z", implying more
    // critical routines were paused than actually were.
    const criticalNames = wf?.stalePausedRoutineNames?.slice(0, critical) ?? [];
    const names = critical > 0
      ? (criticalNames.length ? `: ${criticalNames.join(', ')}` : '')
      : (wf?.stalePausedRoutineNames?.length ? `: ${wf.stalePausedRoutineNames.slice(0, 4).join(', ')}` : '');
    const backlog = (wf?.stalePausedBacklogDepth ?? 0) > 0
      ? `; downstream acceptance backlog=${wf?.stalePausedBacklogDepth}`
      : wf?.stalePausedRoutinesUnreadable
        ? '; downstream acceptance backlog unreadable'
        : '';
    signals.push({
      key: 'stale-paused-routines',
      severity: critical > 0 ? 'blocker' : 'advisory',
      summary:
        critical > 0
          ? `${critical} release/deploy-critical routine(s) on a stale/unexplained pause${names}${backlog} — the deploy pipeline may be silently stopped.`
          : `${wf?.stalePausedRoutines} routine(s) on a stale/unexplained pause${names}${backlog} — an unattributed or long-standing pause nobody has re-affirmed.`,
    });
  }

  // 3. Queen loop dark — LIVENESS (started but no live wake), distinct from a
  //    chosen pause.
  if (health.crossMonitor?.queenAlive === false && health.panels.queen?.data?.started) {
    signals.push({
      key: 'queen-dark',
      severity: 'blocker',
      summary: `Mug loop dark (started, no live wake) — ${health.panels.queen?.summary ?? ''}`.trim(),
    });
  }

  // 4. Overwatch dark — only when it is supposed to be running.
  if (health.crossMonitor?.overwatchAlive === false && health.panels.overwatch?.data?.started) {
    signals.push({
      key: 'overwatch-dark',
      severity: 'advisory',
      summary: `Kettle supervisor loop dark — ${health.panels.overwatch?.summary ?? ''}`.trim(),
    });
  }

  // 4b. Overwatch ALIVE but SKIPPING its mandated scorecard (monitor-the-monitor,
  //     hive-loop-supervision 2026-06-21). overwatch-dark catches a NON-waking
  //     supervisor; this catches the OTHER failure — it wakes (autoloop 'ok') yet
  //     silently omits the Owner-#1 every-wake pot-coordination-health scorecard, so
  //     the health-trend goes blind while everything LOOKS alive. The settled-wake grace
  //     lives in compute.ts (the `scorecardSkipped` flag) so this stays pure.
  const ow = health.panels.overwatch?.data;
  if (ow?.started && ow.scorecardSkipped) {
    const e = ow.scorecardEmission;
    signals.push({
      key: 'overwatch-scorecard-skipped',
      severity: 'advisory',
      summary:
        e?.status === 'partial-only'
          ? `Kettle emitting only PARTIAL pot-coordination-health scorecards since its last wake (${e.missingCount} criteria unrated) — Owner #1 mandate (a COMPLETE scorecard EVERY wake) truncated.`
          : `Kettle woke but emitted NO complete pot-coordination-health scorecard since its last wake — Owner #1 mandate (a scorecard EVERY wake) skipped; the health-trend is going blind.`,
    });
  }

  // 4c. Rubric emission dark — flag ON but the supervisor is STOPPED, long past a
  //     wake. 4/4b both gate on `started`, and the freshness interpreter reads
  //     'not-started' as benign — so a monitor stopped mid-flight went silent
  //     FOREVER (WI-2374: emission died with overwatch on 2026-07-02 and nothing
  //     noticed). Fires only when it HAS woken before (lastWakeAt != null — a
  //     never-started fresh install stays quiet) and after a 6h grace. Auto-resolves
  //     when overwatch restarts OR the flag is turned off (making the pause explicit).
  if (ow?.flagEnabled && !ow.started && ow.lastWakeAt != null) {
    const darkMs = health.evaluatedAt - ow.lastWakeAt;
    if (darkMs > RUBRIC_EMISSION_DARK_GRACE_MS) {
      signals.push({
        key: 'rubric-emission-dark',
        severity: 'advisory',
        summary:
          `pot-coordination-health AGENT emission dark ${Math.round(darkMs / 3_600_000)}h — overwatch is enabled but STOPPED ` +
          `(last wake ${new Date(ow.lastWakeAt).toISOString()}). The scheduled pulse keeps a deterministic floor, but the ` +
          `agent trend is blind. kettle:start to resume, or turn the papercusp-overwatch flag OFF to make the pause explicit.`,
      });
    }
  }

  // 5. LLM substrate starved — every pool account unavailable. Trust BOTH clocks:
  //    the health snapshot must be fresh, and the usage-window projection inside
  //    it must still be receiving writes. A fresh tick can faithfully re-read an
  //    OLD projection and turn stale usage walls into a confident pool-wide outage
  //    (EI-21169582379092366). The tokens panel already detects that independent
  //    projection-write stall through the shared predicate below; do not page the
  //    derived accounts-starved blocker until upstream capacity is measured again.
  const tk = health.panels.tokens?.data;
  const poolProjectionStale = accountPoolProjectionStale(health);
  if (!tickStale && !poolProjectionStale && tk && tk.accountsTotal > 0 && tk.accountsAvailable === 0) {
    signals.push({
      key: 'accounts-starved',
      severity: 'blocker',
      summary: `all ${tk.accountsTotal} LLM pool account(s) unavailable by a fresh capacity projection — the fleet is rate-starved.`,
    });
  }

  // 5b. PG RESTART (P-008, mcp-reliability-hardening). The postmaster boot time
  //     (infra panel) DRIFTED since the previous tick → Postgres was restarted, so
  //     every backend connection + prepared statement was dropped fleet-wide. This
  //     was a SILENT class: the 2026-07-10 21:04 EDT restart (an agent's
  //     `sudo apt-get install postgresql-server-dev-18 bison flex` triggered the
  //     postgresql-common maintainer scripts to restart the live cluster) went
  //     undetected until downstream errors surfaced. Fires only when a PRIOR
  //     baseline exists (prev != null — the first observation just seeds it, never
  //     alarms) and the current reading is present (cur != null — an unreadable PG
  //     tick is the pg panel's own concern, not a false "restart"). Transient by
  //     design: the tick updates its baseline to the new value, so this fires once
  //     then auto-resolves next tick — a "PG just restarted, connections blipped"
  //     page, not a stuck condition.
  const curPostmasterStartMs = health.panels.infra?.data?.pg?.postmasterStartMs ?? null;
  const prevPostmasterStartMs = opts.prevPostmasterStartMs ?? null;
  if (
    prevPostmasterStartMs !== null &&
    curPostmasterStartMs !== null &&
    curPostmasterStartMs !== prevPostmasterStartMs
  ) {
    const at = new Date(curPostmasterStartMs).toISOString();
    signals.push({
      key: 'pg-restarted',
      severity: 'blocker',
      summary:
        `Postgres RESTARTED (postmaster start-time drifted to ${at}) — every backend connection + prepared ` +
        `statement was dropped; agents may have hit transient DB errors. If UNPLANNED, root-cause it (a ` +
        `\`sudo apt-get install postgresql-*\` / cluster op restarts the live server — do package work off-hours ` +
        `or against embedded-pg, never the shared :5432).`,
    });
  }

  // 5c. EI-9794: autoloop FIRE-RECENCY staleness — independent of `last_status` /
  //     `consecutive_errors` (frozen the instant a loop stops firing) and of the
  //     `armed` wake-routine bit (a self-deactivating one-shot's normal resting
  //     state is indistinguishable from a failed re-arm — see the type doc
  //     above). A role EXPECTED to be running whose `autoloop_state.last_fired_at`
  //     is stale by more than N cadences is silently dead — page it like any
  //     other dead routine.
  const staleMultiplier = autoloopFireStaleMultiplier();
  for (const row of opts.autoloopFireRows ?? []) {
    if (!row.expected || row.lastFiredAtMs === null) continue;
    const thresholdMs = row.cadenceSec * 1000 * staleMultiplier;
    const staleForMs = health.evaluatedAt - row.lastFiredAtMs;
    if (staleForMs > thresholdMs) {
      signals.push({
        key: `autoloop-fire-stale:${row.role}`,
        severity: 'blocker',
        summary:
          `${row.role}@${row.harnessSlug} has not fired in ${Math.round(staleForMs / 60_000)}m ` +
          `(expected every ${row.cadenceSec}s, alarm threshold ${staleMultiplier}x) — last_status may still ` +
          `read 'ok' since that field only updates on a fire. The supervisor is likely dead; kettle:start to resume.`,
      });
    }
  }

  // 6. Catch-all: any OTHER panel self-reporting `crit` (so a new critical signal
  //    is never silently missed). Sharper-keyed panels above are skipped.
  //    NOTE: the panel KEY for the Queen/Mug card is the STABLE identifier
  //    `'queen'` (types.ts PANEL_LABELS maps queen: 'Mug' — key-stable,
  //    label-renamed seam, cup-lexicon-full-rename-2026-07-09 KEEP-set). A
  //    2026-07-05 edit mis-renamed this entry to the display label `'mug'`,
  //    which never matches `panel.key` — so the queen-dark signal (#3 above)
  //    was silently duplicated by this catch-all whenever the queen panel
  //    went crit. Bug found + fixed 2026-07-10 (cup-lexicon-full-rename
  //    fleet read-only-prep pass, su-78d15).
  const coveredKeys = new Set(['workFeed', 'queen', 'tokens']);
  for (const panel of Object.values(health.panels)) {
    if (panel.status !== 'crit' || coveredKeys.has(panel.key)) continue;
    // EI-2146 #3 + EI-15006: suppress the no-bees-while-idle FALSE POSITIVE.
    // A fleet with zero bees running is CORRECT when the pot is idle by design —
    // no admissible cup-placeable frontier is being left unplaced AND capacity is
    // healthy (spawner/engine provably live) — so it is an idle fleet, not an
    // infra fault. Only the specific no-bees case is gated; a bees-crit for any
    // OTHER reason (a cursed placement while bees run: running > 0) still surfaces.
    // EI-15006: with the threaded cup-placeable + capacity context, suppress ONLY
    // the idle-by-design case (no cup work + spawner provably live + capacity not
    // known-exhausted). A genuine spawner-down / cup-work-waiting / cup-tier-full
    // shape still fires — the two false-directions the raw `frontier === 0` gate
    // got wrong (false page during idle; false SILENCE of a real spawner-down when
    // the frontier read empty).
    //
    // EI-19462267124852221: the gate itself now lives in ONE predicate, shared with
    // `policySuppressedLivenessSignatures` below, so "we did not fire this" and
    // "we must not auto-resolve this" cannot drift apart.
    if (panel.key === 'bees' && beesSignalSuppressed(health, opts.beesLiveness)) continue;
    // EI-21025158485847408: an infra crit caused ONLY by ambient host pressure
    // (D-007's `ambientHost` attribution — ordinary multi-tenant PSI load from
    // peer agents, never an operator defect) downgrades to a visible, non-paging
    // `advisory` instead of a `blocker`. See `infraCritAmbientOnly`'s doc for why:
    // without this, ordinary fleet-load PSI crossing the threshold repeatedly
    // opens/resolves a `panel:infra` blocker as it oscillates — the recurring
    // "PSI thrashing" this item reports, distinct from WI-5471 (a real bg-host
    // event-loop/PG-pool bug that this alarm correctly still pages for). A crit
    // for any OTHER reason — or a mix that ALSO carries an operator-defect leg —
    // still pages exactly as before.
    if (panel.key === 'infra' && panel.data && infraCritAmbientOnly(panel.data as InfraHealth)) {
      signals.push({
        key: 'panel:infra',
        severity: 'advisory',
        summary: `${panel.label} (ambient host pressure, non-blocking): ${panel.summary}`,
      });
      continue;
    }
    signals.push({ key: `panel:${panel.key}`, severity: 'blocker', summary: `${panel.label}: ${panel.summary}` });
  }

  return signals;
}

/**
 * EI-19462267124852221 — the signatures whose INPUT could not be read this tick, so
 * their absence from `evaluateLivenessAlarm`'s output means "NOT EVALUATED", not
 * "evaluated and genuinely clear".
 *
 * THE DEFECT THIS CLOSES. Auto-resolve-on-recovery (below) resolves every open
 * escalation whose signal is no longer firing. But a signal stops firing for two
 * completely different reasons — the condition cleared, or we could not observe it —
 * and both read paths below degrade the second into the first:
 *
 *   - `panelSafe` catches a panel-level throw and returns `data: null` +
 *     `status:'unknown'` + `error`. The consumer then reads `wf?.stalePausedRoutines ?? 0`
 *     → 0 → "not firing" → RESOLVED as recovered. The panel is literally SHOUTING
 *     `status:'unknown'`; nothing was consulting it.
 *   - the stale-paused sub-read has its own fail-soft catch INSIDE a panel that then
 *     succeeds, so panel status looks fine while the count is a fabricated zero. That
 *     one needs the explicit `stalePausedRoutinesUnreadable` flag (compute.ts).
 *
 * ⚠ SCOPE — READ THIS BEFORE CITING THIS GUARD AS A ROOT-CAUSE FIX.
 * This closes a real conflation, but it is NOT established as the cause of the flap
 * that motivated it, and an earlier revision of this very comment asserted that it was.
 *
 *   PROVEN (measured 30d, papercusp-workspace, `coord_event_log`): `stale-paused-routines`
 *   produced 5,303 fire→resolve and 5,303 resolve→fire transitions, median half-period
 *   57s/63s, with a BYTE-IDENTICAL summary naming the same 105 routines throughout. A
 *   condition that genuinely cleared and recurred cannot emit identical text 5,303 times.
 *   The condition was CONSTANT and the DETECTION oscillated. WI-4878's guard (recompute
 *   fresh health before resolving) was already in place throughout. Freshness was not the
 *   problem.
 *
 *   ⚠ CORRECTION (2026-08-04) — an earlier revision of this comment ALSO cited "and ZERO
 *   fire→fire transitions — a perfect square wave" as part of that proof. That observation
 *   is real but carries NO information: the fire loop skips any signature that already has
 *   an open row (the `openForSig` guard in §2; before WI-36010, a bare
 *   `if (openBySig.has(s.key)) continue`), so a second fire coalesces onto the
 *   open row instead of writing an event. fire→fire is therefore IMPOSSIBLE BY CONSTRUCTION
 *   in `coord_event_log`, for every signature, flapping or not — with the ONE exception
 *   WI-36010 added: an advisory→`blocker` escalation now breaks through, and even then it
 *   coalesces onto the same open row rather than writing a second event — measured the same day on
 *   three unrelated live signatures, all with zero fire→fire. The BYTE-IDENTICAL summary is
 *   the load-bearing evidence here; the alternation is not. Citing a structurally-forced
 *   observation as though it discriminated between hypotheses is how a sound-looking proof
 *   launders a schema artifact into a conclusion.
 *
 *   FALSIFIED: the panel-level branch below did NOT cause it. `system_health_ticks` over
 *   the same 30d records 37,319 ticks — 35,119 warn / 1,587 ok / 613 crit — and NOT ONE
 *   `workFeed` tick with `status:'unknown'`. panelSafe's catch never fired for this panel.
 *
 *   UNRESOLVED: which path actually alternated. The sub-read's fail-soft catch (the second
 *   bullet) remains possible and is invisible by construction — it logs nothing and, before
 *   the flag added here, left no trace — which is exactly why the flag exists. A strict
 *   alternation at the tick rate is also consistent with a per-worker/per-snapshot state
 *   flipping, which this guard would NOT fix. Do not close that question by citing this code.
 *
 * Deliberately PARTIAL: it maps only the signatures whose read paths are shown above to
 * degrade. A signature absent from this map keeps the prior behavior (absence ⇒
 * resolvable), so adding one is a safe, additive change — map it to the panel it reads from.
 */
export function unobservableLivenessSignatures(health: SystemHealth): Set<string> {
  const out = new Set<string>();
  const workFeed = health.panels.workFeed;
  // Panel-level unreadable. Key on what panelSafe's CATCH actually emits —
  // `status:'unknown'` + an `error` string — NOT on `data == null` alone. `data: null`
  // is ambiguous: production only produces it via that catch, but it is also the
  // idiomatic "healthy / nothing to report" fixture value throughout this suite, and
  // treating it as unreadable would make a genuine recovery unresolvable. `status`
  // says "we do not know" unambiguously, and a panel that does not know has NOT
  // observed recovery. EVERY signature derived from this panel is then unobservable.
  if (workFeed && (workFeed.status === 'unknown' || workFeed.error != null)) {
    out.add('stale-paused-routines');
    out.add('dead-routines');
    out.add('dead-routines-quiesced');
  } else if (workFeed?.data?.stalePausedRoutinesUnreadable) {
    // Panel succeeded, but this one sub-read's fail-soft catch fired.
    out.add('stale-paused-routines');
  }

  // EI-22806259337076005 — the account-starvation signal is deliberately withheld
  // while the usage-window projection is stale. `accountsAvailable === 0` is not a
  // recovery observation in that state: the same untrusted projection that suppresses
  // the fire path must keep an existing escalation open until a fresh write arrives.
  // Keep this predicate shared with evaluateLivenessAlarm's suppression branch so the
  // two absence paths cannot drift apart again.
  const tokens = health.panels.tokens;
  if (tokens && (tokens.status === 'unknown' || tokens.error != null)) {
    // The panel-level collector failed, so account serviceability was not observed.
    out.add('accounts-starved');
  } else if (accountPoolProjectionStale(health)) {
    out.add('accounts-starved');
  }

  // P-009 (ex-P-010): collectDeploy's git-sync read is fail-soft, so a failed read leaves
  // gitSyncMaxMissedIntervals null and the signal simply vanishes. A vanished reading is not
  // a recovery: keep an open starvation alarm open while the panel errored or the sub-read
  // failed (same shape as the workFeed/stalePausedRoutinesUnreadable pair above).
  const deploy = health.panels.deploy;
  if (
    (deploy && (deploy.status === 'unknown' || deploy.error != null)) ||
    deploy?.data?.gitSyncMissedIntervalsUnreadable === true
  ) {
    out.add('git-sync-missed-intervals');
  }
  return out;
}

/**
 * EI-22806259337076005 — account-starvation depends on a fresh usage-window
 * projection. Keep the freshness test in one place because both the fire path
 * and auto-resolve path must treat stale projection data as unobservable.
 */
function accountPoolProjectionStale(health: SystemHealth): boolean {
  const tokens = health.panels.tokens?.data;
  return tokens ? projectionWriteStalled(tokens, POOL_PROJECTION_STALE_WARN_MS) : false;
}

/**
 * EI-19462267124852221 — the ONE place the `panel:bees` no-bees-while-idle policy gate
 * is decided. Called by BOTH the fire path (`evaluateLivenessAlarm` §6) and the
 * auto-resolve guard (`policySuppressedLivenessSignatures`), so a change to the policy
 * cannot silently desynchronise "we did not fire this" from "we must not resolve this".
 */
function beesSignalSuppressed(health: SystemHealth, beesLiveness?: BeesLivenessContext): boolean {
  const bees = health.panels.bees;
  // Not crit ⇒ this signal is not firing for any reason, so there is nothing to suppress.
  if (bees?.status !== 'crit') return false;
  // A bees-crit for any OTHER reason (a cursed placement while bees run) still fires.
  if (bees?.data?.running !== 0) return false;
  if (beesLiveness) return beesIdleByDesign(beesLiveness);
  // LEGACY EI-2146 gate for a caller that did not thread the context (an old/pure
  // evaluator) — byte-identical to the pre-EI-15006 behavior.
  return health.panels.workFeed?.data?.frontier === 0;
}

/**
 * EI-19462267124852221 — the signatures that ARE still firing this tick but were
 * deliberately WITHHELD by a policy gate, so their absence from `evaluateLivenessAlarm`'s
 * output means "suppressed on purpose", not "the condition cleared".
 *
 * THE THIRD ABSENCE REASON. A signature is missing from `currentSigs` for three
 * completely different reasons, and auto-resolve-on-recovery may only fire on the first:
 *
 *   1. the condition genuinely cleared            → resolve is correct
 *   2. its input could not be READ this tick      → `unobservableLivenessSignatures`
 *   3. the condition is STILL TRUE and we chose not to raise it  → THIS function
 *
 * (2) was closed first and (3) was left open, which is why the fix looked complete while
 * the phenomenon carried on: the two signatures (2) covers had gone quiet, and every
 * occurrence still happening was (3).
 *
 * MEASURED (2026-08-04, papercusp-workspace). Every `panel:bees` auto-resolve in the
 * sampled window announced "condition recovered" while the bees panel read `crit` in the
 * health tick immediately BEFORE *and* immediately AFTER the resolve — 00:14:41.818,
 * 00:12:45.328, 00:12:45.284, 00:10:44.497, all crit/crit. There was no recovery window
 * for the resolve to be describing. `panel:bees` is absent from `coveredKeys`, so while
 * that panel is crit the ONLY path that withholds it is the `beesIdleByDesign` gate
 * above — the resolve was announcing the GATE flipping, not the condition changing.
 *
 * Because auto-resolve drops the open row the next fire would have coalesced onto, an
 * unstable gate becomes fire → false-resolve → fire at the tick rate. That is the
 * mechanism behind the observed burst/quiet pattern: bursts are the windows where the
 * gate oscillates, and quiet windows are where it holds steady and the open row
 * correctly suppresses everything.
 *
 * Deliberately PARTIAL, exactly like its sibling above: a signature absent from here
 * keeps the prior behavior (absence ⇒ resolvable), so adding a gate is additive.
 */
export function policySuppressedLivenessSignatures(
  health: SystemHealth,
  beesLiveness?: BeesLivenessContext,
  d026Quiescence?: D026QuiescenceEvidence,
): Set<string> {
  const out = new Set<string>();
  if (beesSignalSuppressed(health, beesLiveness)) out.add('panel:bees');
  // A complete D-026 contract with overdue rows means the old blocker signature
  // is still TRUE but has been deliberately reclassified as the advisory
  // `dead-routines-quiesced`. Mark the old key so auto-resolve writes a
  // reclassification note instead of claiming recovery.
  if (
    d026QuiescenceIsActive(d026Quiescence) &&
    (health.panels.workFeed?.data?.deadRoutines ?? 0) > 0
  ) {
    out.add('dead-routines');
  }
  return out;
}

/**
 * EI-19462267124852221 — the EVIDENCE stamped onto an auto-resolve's note.
 *
 * WHY THIS EXISTS, AND WHY IT IS THE MORE IMPORTANT HALF OF THIS FIX. Every one of the
 * 5,303 false resolves wrote the SAME constant string, "condition recovered". That
 * sentence is a CONCLUSION with its evidence discarded, and it is unfalsifiable by
 * construction: a resolve that observed a genuine zero and a resolve that observed
 * nothing at all are byte-identical in the durable log. So the log could prove the
 * detector oscillated (identical fire text, 5,303 strict alternations) but could not say
 * WHY — six investigation passes, four of them spent re-reading code, because the one
 * artifact that knew the answer had thrown it away.
 *
 * Stamping the observation makes the next occurrence a single query instead of a
 * multi-pass code hunt, and it is what lets the guard above be CHECKED rather than
 * believed: `no per-signature evidence recorded` on a resolve is itself a finding.
 *
 * Deliberately narrow + fail-soft: it never throws, never blocks a resolve, and returns
 * an explicit "not recorded" for signatures it does not map, so an unmapped signature
 * reads as unknown rather than as observed-clear.
 */
export function resolveEvidenceFor(
  sig: string,
  health: SystemHealth,
  beesLiveness?: BeesLivenessContext,
  d026Quiescence?: D026QuiescenceEvidence,
): string {
  // `panel:<key>` — the catch-all family (evaluateLivenessAlarm §6) fires while a panel
  // self-reports `crit`, so that panel's OWN status at resolve time IS the observation.
  //
  // WHY THIS BRANCH EXISTS (measured 2026-08-04, papercusp-workspace, 24h): these are the
  // signatures that actually flap in production — panel:infra 148 fire/resolve cycles,
  // panel:bees 83, rubric-emission-dark 41 — while the two workFeed signatures mapped
  // below sat completely quiet (stale-paused-routines has held one open row since
  // 2026-08-02T18:14Z). So the version of this helper that mapped only those recorded
  // `no per-signature evidence recorded` for every LIVE occurrence: the instrumentation
  // was blind in exactly the place the phenomenon was still happening. An evidence helper
  // is only worth its weight where the events are.
  //
  // Matched by ITERATING `panels` rather than indexing it with the dynamic key: the
  // string-index form needs a cast, and a cast inside the helper whose job is keeping an
  // observation honest is the same defect one level down.
  if (sig.startsWith('panel:')) {
    const key = sig.slice('panel:'.length);
    // EI-19474857043229377: for `panel:bees` the panel status alone is NOT the whole
    // observation. That signal is withheld by the `beesIdleByDesign` gate, so a resolve
    // can be announcing the GATE flipping while the panel sits crit either side — which
    // is exactly what 83 cycles in 24h were doing. Carry the gate's INPUTS too, so the
    // deciding leg is readable from the durable log instead of by live re-measurement
    // after the window has closed.
    const gate = key === 'bees' && beesLiveness ? ` · gate: ${describeBeesLiveness(beesLiveness)}` : '';
    for (const p of Object.values(health.panels)) {
      if (!p || p.key !== key) continue;
      return `observed panel ${key} status=${p.status}${p.error != null ? ' (panel ERRORED)' : ''}${gate}`;
    }
    // Absent ≠ clear — the panel we would have judged was not in the snapshot at all.
    return `observed panel ${key} status=panel-absent${gate}`;
  }
  if (sig === 'git-sync-missed-intervals') {
    const dp = health.panels.deploy;
    const missed = dp?.data?.gitSyncMaxMissedIntervals;
    return `observed deploy status=${dp?.status ?? 'panel-absent'} gitSyncMaxMissedIntervals=${typeof missed === 'number' ? missed : 'unreadable'} (alarm threshold > ${GIT_SYNC_MISSED_INTERVALS_ALARM})`;
  }
  const wf = health.panels.workFeed;
  const d = wf?.data ?? null;
  // Read the field DIRECTLY per signature rather than indexing by a string key: the
  // string-index form needs a cast that defeats the type check, which is precisely the
  // kind of silent drift this helper exists to make visible.
  let field: string;
  let n: number | undefined;
  if (sig === 'stale-paused-routines') { field = 'stalePausedRoutines'; n = d?.stalePausedRoutines; }
  else if (sig === 'dead-routines' || sig === 'dead-routines-quiesced') { field = 'deadRoutines'; n = d?.deadRoutines; }
  else return 'no per-signature evidence recorded';
  const status = wf?.status ?? 'panel-absent';
  const unreadable = sig === 'stale-paused-routines' && d?.stalePausedRoutinesUnreadable === true;
  const d026 = sig === 'dead-routines' || sig === 'dead-routines-quiesced'
    ? `; ${describeD026Quiescence(d026Quiescence)}`
    : '';
  return `observed workFeed status=${status} ${field}=${typeof n === 'number' ? n : 'unreadable'}${unreadable ? ' (sub-read FAILED)' : ''}${d026}`;
}

function describeD026Quiescence(evidence?: D026QuiescenceEvidence): string {
  if (!evidence) return 'D-026 evidence=unreadable or not supplied (suppression not authorized)';
  return `D-026 evidence cutActive=${evidence.cutActive} restoreActive=${evidence.restoreActive} complete=${d026QuiescenceIsActive(evidence)}`;
}

// ── durable per-signal signature (dedup + auto-resolve key) ────────────────────

/** The summary prefix every fired escalation carries. */
const SUMMARY_PREFIX = '[infra-liveness] ';

/** Reverse map a panel LABEL back to its key, for classifying legacy records.
 * Includes the PRE-pot-rename display labels (WI-2932): escalation rows written
 * before the rename carry them in their summaries forever, and this map exists
 * precisely to classify those old rows — the aliases stay as long as any do. */
const PANEL_LABEL_TO_KEY: Record<string, PanelKey> = {
  ...Object.fromEntries(
    (Object.entries(PANEL_LABELS) as Array<[PanelKey, string]>).map(([k, v]) => [v, k]),
  ),
  // LEGACY aliases — the PRE-rename display labels that old escalation summaries
  // carry forever. The spread above already provides the CURRENT labels (Mug,
  // Kettle, …); these must stay the OLD words so records written before the
  // cup-lexicon rename still classify. Do NOT rename these to Mug/Kettle.
  Queen: 'queen',
  'Bees / fleet': 'bees',
  Overwatch: 'overwatch',
  'Scout / ideation': 'scout',
};

/**
 * How recent a successful git-sync must be to refute a fleet-wide commit-outage claim.
 * Matches `DEAD_ROUTINE_OVERDUE_MS` (compute.ts) on purpose: a sync newer than the same window
 * that defines "overdue" is, by the alarm's own yardstick, commits still flowing.
 */
const COMMIT_REFUTATION_WINDOW_MS = 10 * 60_000;

/**
 * EI-20045691451471399 — the engine-starvation summary line. PURE (no clock, no DB) so the
 * exact operator-facing wording is unit-testable.
 *
 * ## What the old one-liner got wrong
 *
 * It rendered `${count} dead routine(s) overdue >10m: ${first 4 by overdue-seconds}`. Against a
 * TOTAL engine freeze that produced, verbatim, *"1 dead routine(s) overdue >10m: pr-poll — the
 * routine engine is starved"* while every durable routine — git-sync included — was stopped. Two
 * independent defects stack there:
 *
 *  - **No denominator.** "1" and "101" both read as "some routines are late". "101 of 151" reads
 *    as an engine freeze and nothing else. The ratio is what makes the magnitude legible, so it
 *    is printed whenever the denominator was actually observed — and never invented when it
 *    wasn't (an unobserved denominator falls back to the bare count rather than guessing).
 *  - **Ordering by overdue-seconds, presented as severity.** For a frozen engine, "most overdue"
 *    is decided by cron phase, so it is arbitrary — it put `pr-poll` first by seconds and left
 *    `git-sync` unnamed. An operator reading that triages "what is pr-poll, does it matter?"
 *    (answer: barely) instead of "the commit pipeline is down fleet-wide".
 *
 * ⚠ The literal substring `dead routine(s)` is LOAD-BEARING, not stylistic: `deriveSignatureFromSummary`
 * classifies this signal by matching /dead routine\(s\)/ against the summary, and that is the
 * fallback dedup identity for legacy escalation rows written before EI-2146 stamped an explicit
 * `livenessSignature`. Reword it away and those rows stop classifying — they would never
 * auto-resolve, and the backlog sweep would silently skip them. Keep the phrase.
 */
export function formatDeadRoutinesSummary(wf: {
  deadRoutines: number;
  deadRoutineNames?: string[];
  deadRoutinesInScope?: number;
  deadRoutinesDistinct?: number;
  deadRoutineCriticalNames?: string[];
  deadRoutineCoverage?: Record<string, DeadRoutineNameCoverage>;
}, commitEvidence?: {
  /**
   * Most recent SUCCESSFUL git-sync across installs — `DeployHealth.gitSyncLastSyncedAtMs`,
   * computed as a max, which is exactly the polarity needed to refute the word "NOTHING".
   */
  gitSyncLastSyncedAtMs?: number | null;
  /** Caller's clock. Omitted ⇒ the evidence is unreadable and is ignored (see below). */
  nowMs?: number;
  /** How recent a sync must be to count as "commits are flowing". Defaults to the 10m overdue window. */
  windowMs?: number;
}): string {
  const count = wf.deadRoutines;
  const total = wf.deadRoutinesInScope;
  // Only claim a ratio when the denominator was observed AND is consistent with the numerator;
  // an absent or nonsensical scope count degrades to the bare count rather than a made-up one.
  const hasDenominator = typeof total === 'number' && total > 0 && count <= total;
  const population = hasDenominator ? `${count} of ${total}` : `${count}`;
  const named = wf.deadRoutineNames ?? [];
  // Disclose the UNIT when rows and distinct routines diverge: "59 of 144 dead routine(s)" reads
  // as 59 different routines, when it can equally be ONE routine dead across 59 installs. Those
  // are very different incidents and the reader cannot tell them apart from a row count alone.
  const distinctNote =
    typeof wf.deadRoutinesDistinct === 'number' && wf.deadRoutinesDistinct !== count
      ? ` (${wf.deadRoutinesDistinct} distinct)`
      : '';
  // ⚠ UNIT DISCIPLINE: `deadRoutines` counts ROWS (one per install — git-sync alone is 59 here)
  // while `deadRoutineNames` is DEDUPED. Subtracting one from the other would announce
  // "+134 more" when 2 more distinct routines exist. Count the remainder in distinct names, and
  // when that number was not observed, say nothing rather than guess.
  const distinct = wf.deadRoutinesDistinct;
  const unnamed = typeof distinct === 'number' ? Math.max(0, distinct - named.length) : 0;
  const names = named.length ? `: ${named.join(', ')}${unnamed > 0 ? ` (+${unnamed} more)` : ''}` : '';
  // Half the durable engine overdue is no longer "some routines are late" — say the stronger word.
  const frozen = hasDenominator && count / (total as number) >= 0.5;
  const critical = wf.deadRoutineCriticalNames ?? [];
  const gitSyncCoverage = wf.deadRoutineCoverage?.['git-sync'];
  const gitSyncHasStrictMajority =
    gitSyncCoverage != null &&
    gitSyncCoverage.active > 0 &&
    gitSyncCoverage.overdue * 2 > gitSyncCoverage.active;
  // WI-10002084 — LICENSE THE SHARED-TREE SENTENCE ON THE SHARED TREE'S OWN ROW.
  //
  // `gitSyncHasStrictMajority` is a ratio over EVERY git-sync row in the workspace, and those
  // rows belong to ~67 installs (library submodules, toy pots — `hello-world`, `spoon-knife`,
  // `papercusp/libs/generic/*`) that have nothing to do with the canonical shared checkout.
  // A sentence about the shared tree cannot be licensed by a population that is mostly not
  // the shared tree, so consult the release install's OWN row (`releaseInstallSlug()`).
  //
  // REFUTATION-ONLY, for the same reason as the commit-evidence guard below: a measured-current
  // home row may WITHHOLD the strong claim, but nothing here may manufacture one the ratio did
  // not already license. That makes `'absent'` deliberately NON-refuting — it is an UNMEASURED
  // leg, not a healthy one, so it leaves the inference exactly as it stood and a genuine engine
  // freeze still pages at full severity.
  const gitSyncHomeInstall = gitSyncCoverage?.homeInstall;
  const homeInstallCurrent = gitSyncHomeInstall === 'live';
  const homeInstallNote =
    gitSyncHomeInstall === 'overdue'
      ? ", including the shared tree's own"
      : gitSyncHomeInstall === 'live'
        ? ", but not the shared tree's own"
        : '';
  const gitSyncCoverageNote = gitSyncCoverage
    ? ` (${gitSyncCoverage.overdue} of ${gitSyncCoverage.active} active rows overdue${homeInstallNote})`
    : '';
  // EI-23794126226234520 — REFUTATION-ONLY use of direct commit evidence.
  //
  // `gitSyncHasStrictMajority` is circumstantial INFERENCE: it reasons from overdue SCHEDULER
  // ROWS to a conclusion about COMMITS. Those are different things, and the rows belong to ~67
  // sibling installs (library submodules, toy pots) that have nothing to do with the shared tree.
  // A measured successful sync is a DIRECT OBSERVATION of the very thing the sentence denies, so
  // when one exists inside the window it refutes the inference and the strong claim is withheld.
  //
  // Strictly one-directional, for the same reason the non-code proof-floor downgrade is: evidence
  // may only ever WEAKEN the claim. Absent evidence, an unreadable clock, or a stale sync all
  // leave the inference exactly as it was, so a genuine engine freeze still pages at full
  // severity. Nothing here can manufacture an outage claim that the ratio did not already license.
  const syncWindowMs = commitEvidence?.windowMs ?? COMMIT_REFUTATION_WINDOW_MS;
  const lastSyncedAtMs = commitEvidence?.gitSyncLastSyncedAtMs;
  const nowMs = commitEvidence?.nowMs;
  const syncAgoMs =
    typeof lastSyncedAtMs === 'number' && typeof nowMs === 'number' && nowMs >= lastSyncedAtMs
      ? nowMs - lastSyncedAtMs
      : null;
  const commitsObservedRecently = syncAgoMs !== null && syncAgoMs <= syncWindowMs;
  const syncAgoNote = syncAgoMs !== null ? `${Math.round(syncAgoMs / 1000)}s ago` : 'recently';
  const consequence = critical.includes('git-sync') && gitSyncHasStrictMajority && !commitsObservedRecently && !homeInstallCurrent
    ? ` git-sync is among them${gitSyncCoverageNote}, so NOTHING in the shared tree is being committed — the release gate ` +
      'will keep re-judging a candidate that structurally cannot contain anyone\'s fix.'
    : critical.includes('git-sync') && gitSyncHasStrictMajority && homeInstallCurrent
      ? ` Fleet-blocking: git-sync${gitSyncCoverageNote}; the shared tree's own git-sync row is on schedule, so this is not a fleet-wide commit outage.`
    : critical.includes('git-sync') && gitSyncHasStrictMajority
      ? ` Fleet-blocking: git-sync${gitSyncCoverageNote}; a successful sync ${syncAgoNote} directly contradicts a fleet-wide commit outage.`
    : critical.includes('git-sync')
      ? ` Fleet-blocking: git-sync${gitSyncCoverageNote}; this is not evidence of a fleet-wide commit outage.`
    : critical.length > 0
      ? ` Fleet-blocking: ${critical.join(', ')}.`
      : '';
  return `${population} dead routine(s) overdue >10m${distinctNote}${names} — the routine engine is ${frozen ? 'FROZEN' : 'starved'}.${consequence}`;
}

/**
 * Derive a signal's stable signature from an escalation summary — the fallback
 * for LEGACY records written before EI-2146 (which carry no explicit signature),
 * so the one-time backlog sweep can classify and auto-resolve the existing pile.
 * Mirrors the summaries produced by `evaluateLivenessAlarm`. Returns null when
 * the summary is not a recognizable infra-liveness signal (left untouched).
 */
export function deriveSignatureFromSummary(summary: string): string | null {
  let s = summary ?? '';
  if (s.startsWith(SUMMARY_PREFIX)) s = s.slice(SUMMARY_PREFIX.length);
  s = s.trim();
  if (s.startsWith('system-health tick stale')) return 'health-tick-stale';
  if (s.startsWith('expected D-026 quiescence')) return 'dead-routines-quiesced';
  if (/dead routine\(s\)/.test(s)) return 'dead-routines';
  if (/on a stale\/unexplained pause/.test(s)) return 'stale-paused-routines';
  // Dual-recognition: legacy records carry 'Queen'/'Overwatch'; post-rename
  // records carry 'Mug'/'Kettle'. Match both so the classifier never regresses
  // on the old backlog it exists to sweep.
  if (s.startsWith('Queen loop dark') || s.startsWith('Mug loop dark')) return 'queen-dark';
  if (s.startsWith('Overwatch supervisor loop dark') || s.startsWith('Kettle supervisor loop dark'))
    return 'overwatch-dark';
  if (/LLM pool account\(s\) (?:paused|unavailable by a fresh capacity projection)/.test(s)) return 'accounts-starved';
  if (s.startsWith('Postgres RESTARTED')) return 'pg-restarted';
  if (/^git-sync\b.* has missed \d+ consecutive scheduler intervals/.test(s)) return 'git-sync-missed-intervals';
  // EI-9794 fire-staleness form: "<role>@<harness> has not fired in ...".
  const fireStaleMatch = /^([^@\s]+)@\S+ has not fired in/.exec(s);
  if (fireStaleMatch) return `autoloop-fire-stale:${fireStaleMatch[1]}`;
  // Catch-all panel form: "<panel label>: <panel summary>".
  const idx = s.indexOf(': ');
  if (idx > 0) {
    const key = PANEL_LABEL_TO_KEY[s.slice(0, idx)];
    if (key) return `panel:${key}`;
  }
  return null;
}

/**
 * The stable signature of an open escalation: the explicit `livenessSignature`
 * stamped on records this alarm writes (EI-2146), else derived from the summary
 * (legacy). Null = not classifiable as an infra-liveness signal.
 */
export function livenessSignatureOf(rec: EscalationRecord): string | null {
  const explicit = (rec as Record<string, unknown>).livenessSignature;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return deriveSignatureFromSummary(rec.summary ?? '');
}

// ── tick + debounce + starter ─────────────────────────────────────────────────

const lastAlertedAt = new Map<string, number>();

// ── EI-9939: flap-episode tracking (suppress fleet-wide re-broadcast of a
// FLAPPING condition_key) ───────────────────────────────────────────────────
//
// The auto-resolve leg above deliberately clears `lastAlertedAt` on recovery
// ("so a genuine re-occurrence after recovery re-fires immediately") — correct
// for a real second incident, but for a condition that flaps (fires, recovers,
// re-fires, repeatedly — e.g. the routine-engine-starvation dead-routines flap
// observed 2026-07-11/12, repeat_count up to 31 within one session) it means
// EVERY flap cycle re-broadcasts a fresh `page()` alarm + `pageResolved()`
// all-clear to `to:['*']` — every live + parked session, none of whom own the
// flapping routine. Pure context tax.
//
// This map is DISTINCT from `lastAlertedAt` / `openBySig` dedup — a single
// SUSTAINED incident (fires once, stays open until it genuinely resolves)
// never creates more than one episode entry and is completely unaffected;
// only a fire→resolve→refire PATTERN engages it. Only `blocker`-severity
// signals participate (advisory signals never call `page()` regardless).
export interface FlapEpisode {
  /** Fires observed since this episode opened. The episode is NOT time-boxed
   *  by a fixed origin window — it stays open (and, once past threshold,
   *  suppressed) for as long as the signature keeps re-firing, however long
   *  that continues; it closes ONLY via the settle sweep (a full flap window
   *  of genuine quiet), which deletes the entry so a later occurrence starts
   *  fresh. This is deliberate: a fixed "reset 30min after the first fire"
   *  origin would let an hours-long flap earn a fresh non-suppressed
   *  broadcast pair every 30min even though it never actually stopped. */
  fireCount: number;
  /** epoch ms the condition most recently went quiet (no longer firing) with
   *  no page() broadcast for that recovery yet, or null while it is either
   *  currently firing or its recovery was already broadcast. The settle
   *  sweep watches this: once quiet for a full flap window with no re-fire,
   *  it is genuinely settled and gets exactly one final all-clear. */
  quietSinceMs: number | null;
  recoveryObservationCount?: number;
  lastRecoveryObservationAtMs?: number;
}

/** Signature → episode. Persisted as a single JSONB blob (see readFlapState /
 *  writeFlapState below) — a plain object, not a Map, so it round-trips
 *  through JSON without a serialization seam. */
export type FlapState = Record<string, FlapEpisode>;

/**
 * EI-15126: durable cross-worker flap-episode store. `flapEpisodes` used to be
 * a module-level in-memory `Map` — correct for a single process, but
 * `startInfraLivenessAlarm()` runs independently on EVERY `:3070` cluster
 * REQUEST WORKER (see the doc comment on that function), so each worker kept
 * its OWN counter. Which worker's periodic tick happens to observe a given
 * fire/recover transition is effectively uncorrelated across cycles, so no
 * single worker's local counter ever climbed past `flapThreshold` — the
 * fleet-wide page()/pageResolved() suppression this whole file exists to
 * provide never actually engaged in production. Confirmed live: `panel:bees`
 * fire+recovery pairs re-broadcasting every ~1-4min for hours
 * (harness_shared.coord_event_log, 2026-07-17). Same architecture class as
 * the EI-2146 / WI-4181 in-memory-dedup bugs already scarred into this file —
 * applied to newer state. Fixed the same way those were: durable storage
 * (migration 635, `operator_liveness_flap_state`) via the operator-state-pg
 * single-JSONB-row-per-workspace helper, read once and written once per tick.
 *
 * `hermeticFlapStateFallback` is the single-process fallback used ONLY when a
 * caller has overridden `readLast` (the test/hermetic signal every other
 * gated default in this file uses — see `readBeeCapacity`) without also
 * overriding `readFlapState`/`writeFlapState` — i.e. existing unit tests, for
 * which a plain in-memory object is exactly correct (no multi-worker concern
 * in a single-threaded test process) and preserves today's behavior
 * byte-for-byte.
 */
let hermeticFlapStateFallback: FlapState = {};

/**
 * EI-18673998482704275 — atomic flap-decision read-modify-write (lost-update fix).
 *
 * Superseded here: the separate `readOperatorState`/`writeOperatorState` pair
 * this alarm used to call at tick-start/tick-end (a plain, NON-atomic
 * read-modify-write) is exactly the shape that caused the race described
 * below — `defaultUpdateFlapState` replaces it with a single atomic
 * transaction. `deps.readFlapState`/`deps.writeFlapState` remain as a
 * backward-compat injection seam ONLY (see `updateFlapState`'s wiring in
 * `runLivenessAlarmTick`) for existing tests that inject them directly.
 *
 * EI-15126 (above) made the flap-episode STORE durable + cross-worker, but
 * `runLivenessAlarmTick` still read it once at tick start (`flapEpisodes`) and
 * wrote it back once at tick end, with the escalate()/resolve()/page()/
 * pageResolved() I/O calls — each a real await point — running in between. On
 * a `:3070` cluster (N independent request workers each running this tick on
 * their own timer — see the doc comment on `startInfraLivenessAlarm`), two
 * workers' ticks CAN overlap in wall time, especially under the exact
 * "heavily-parallel fleet" load this alarm exists to catch: worker A reads
 * fireCount=1, awaits its escalate() call, worker B reads the SAME
 * fireCount=1 (A hasn't written yet), both independently compute
 * fireCount=2 and page(), and whichever writes last clobbers the other's
 * update — a classic lost-update race. The net effect is indistinguishable
 * from the pre-EI-15126 bug this was supposed to fix: the fire/resolve
 * counter never climbs past `flapThreshold`, so the 3rd+ fire of a genuinely
 * flapping condition (e.g. `panel:infra` bouncing under load) never gets
 * suppressed and keeps re-broadcasting a FIRING+RESOLVED pair every tick
 * (observed live: EI-18673998482704275, 3 `panel:infra` RECOVERED broadcasts
 * ~1-2min apart with no suppression ever engaging).
 *
 * The fix: isolate the flap-episode MUTATION (not the surrounding I/O) into
 * one atomic read-modify-write step, `updateFlapState`. The mutator is a pure
 * synchronous function — it decides `toPage` / `toResolveSigs` from the
 * CURRENT durable state and returns the next state — so there is no await
 * point between reading and writing it:
 *   - production (`deps.readLast === undefined`): `updateOperatorState`
 *     wraps the read+mutate+write in a single PG transaction with
 *     `SELECT ... FOR UPDATE`, so a second concurrent worker's transaction
 *     genuinely blocks until the first commits (see operator-state-pg.ts).
 *   - hermetic (a test injects `readLast`): the fallback below runs the
 *     read+mutate+write with NO intervening `await`, so JS run-to-completion
 *     guarantees it can't be interleaved by a concurrent `Promise.all` caller
 *     either — the same atomicity guarantee, without real PG.
 * A caller that injects the legacy `readFlapState`/`writeFlapState` seam
 * (existing tests) gets a fallback built from them, preserving their exact
 * prior behavior — they call synchronously in sequence with no interleaving
 * side-I/O in between, matching how those tests already exercise this path.
 */
export interface FlapMutationResult {
  next: FlapState;
  toPage: AlarmSignal[];
  toResolveSigs: string[];
  toBumpSigs?: string[];
}

async function defaultUpdateFlapState(
  ws: string,
  mutate: (current: FlapState) => FlapMutationResult,
): Promise<FlapMutationResult> {
  let result: FlapMutationResult | null = null;
  try {
    const { updateOperatorState } = await import('../operator-state-pg');
    await updateOperatorState<FlapState>(
      'operator_liveness_flap_state',
      {},
      (current) => {
        result = mutate(current);
        return result.next;
      },
      ws,
    );
  } catch {
    /* fail-soft: never crash the request worker; fall back to deciding against
     * an empty baseline — matches readFlapState/writeFlapState's existing
     * fail-soft philosophy (a lost read/write just re-derives next tick). */
    result = null;
  }
  return result ?? mutate({});
}

/** The SETTLE duration: how long a signature must stay quiet (no re-fire)
 *  before a suppressed flap episode is considered genuinely over and earns
 *  its one final all-clear. 30min — matches the escalation debounce. */
const DEFAULT_FLAP_WINDOW_MS = DEFAULT_DEBOUNCE_MS;
const RECOVERY_CONFIRMATION_OBSERVATIONS = 2;
const RECOVERY_CONFIRMATION_SIGNATURES = new Set(['stale-paused-routines']);
/** Fires 1 and 2 of an episode page normally (byte-identical to today's
 *  behavior — see the "re-fires only after recovery" test); the 3rd+ fire
 *  of the SAME still-open episode is classified as flapping and its page()
 *  is suppressed (the durable escalation row is still written either way). */
const DEFAULT_FLAP_THRESHOLD = 2;

/** P-008: the per-workspace baseline for the PG postmaster boot time (epoch ms).
 *  A change between ticks = a PG restart → the `pg-restarted` signal. In-memory +
 *  per-worker like `lastAlertedAt`; the durable openBySig dedup collapses the
 *  cross-worker fire into one escalation, and a fresh process re-seeds (prev=null)
 *  so a restart never false-fires on the first tick after a :3070 restart. */
const lastPostmasterStartMs = new Map<string, number>();

export interface AlarmDeps {
  /**
   * Fresh cross-process SystemHealth reader used by request workers. Production
   * defaults to `readSharedSystemHealthSnapshot`, which NEVER computes. A null
   * result means missing/stale evidence and makes the tick a no-op.
   */
  readSharedHealth?: (ws: string) => Promise<SystemHealth | null>;
  /**
   * Legacy hermetic test seam for exercising stale-cache transitions. Production
   * never supplies or defaults this dependency: request workers must not run the
   * full `computeSystemHealth` graph.
   */
  computeHealth?: (ws: string) => Promise<SystemHealth>;
  readLast?: (ws: string) => SystemHealth | null;
  /**
   * WI-4773: authoritative CROSS-PROCESS bg-host heartbeat. The request worker's
   * `lastSystemHealth` cache is process-local, so its age cannot prove whether the
   * separate bg-host ticker is alive. Production reads the shared DBOS
   * `routinesTick` watermark; tests that inject `readLast` retain the legacy cache
   * seam unless they explicitly inject this reader too.
   */
  readRoutineEngineLiveness?: (nowMs: number) => Promise<RoutineEngineLiveness>;
  /** D-026: active cut + restore evidence. Omitted from hermetic callers; the
   *  production tick wires readD026QuiescenceEvidence explicitly. */
  d026Quiescence?: () => D026QuiescenceEvidence | Promise<D026QuiescenceEvidence>;
  escalate?: (input: {
    severity: EscalationSeverity;
    summary: string;
    body?: string;
    meta?: Record<string, unknown>;
  }) => Promise<unknown>;
  /** The currently-OPEN infra-liveness escalations — the durable dedup +
   *  auto-resolve source. Default reads a bounded newest-first window of the
   *  escalation log and filters to this alarm's identity. */
  listOpen?: () => Promise<EscalationRecord[]>;
  /** Resolve one open escalation by msg_id (auto-resolve-on-recovery). The
   *  RESOLVED value matters (WI-4181): resolveEscalation's no-op sentinels
   *  ('not_found' | 'already_resolved' | 'requires_spawn_approve') mean nothing
   *  transitioned, so the tick suppresses the recovery broadcast; any other
   *  resolution (including undefined from a test double) counts as a real
   *  open→resolved transition. */
  resolve?: (msg_id: string, choice: string, note: string) => Promise<unknown>;
  now?: () => number;
  snapshotStaleMs?: number;
  debounceMs?: number;
  /** EI-9939: the rolling window a repeated fire/resolve cycle is measured
   *  against to classify a signature as FLAPPING (default: 30min, same as
   *  `debounceMs`). Test-overridable so a flap scenario doesn't need real
   *  wall-clock minutes. */
  flapWindowMs?: number;
  /** EI-9939: fires within `flapWindowMs` beyond this count are suppressed
   *  (default 2 — the 3rd+ fire in the window is the flap). */
  flapThreshold?: number;
  /** WI-4023: active paging for a NEW `blocker` signal (default: real notifyAttention +
   *  broadcastSevereEvent). Inject a no-op in tests — the default hits the REAL owner
   *  push + fleet broadcast, which a test exercising the blocker path must never do. */
  page?: (s: AlarmSignal, ws: string) => Promise<void>;
  /** WI-4023: the fleet all-clear for recovered `blocker` signatures (default: real
   *  broadcastSevereEventResolvedMany). Inject a no-op in tests for the same reason. */
  pageResolved?: (sigs: string[]) => Promise<void>;
  /** P-008: read/write the per-workspace PG postmaster-start baseline (epoch ms) the
   *  `pg-restarted` drift signal compares against. Default = the module-level map;
   *  tests inject a controlled store to exercise the seed→drift→auto-resolve sequence
   *  hermetically. */
  readPostmasterBaseline?: (ws: string) => number | null;
  writePostmasterBaseline?: (ws: string, ms: number) => void;
  /** EI-9794: fresh `autoloop_state` fire-recency rows for the fire-staleness
   *  signal (5c above). Default = `defaultReadAutoloopFireRows` (kettle/overwatch
   *  today — the proven incident; other supervisor roles with a known cadence +
   *  expected-predicate can extend the same reader). Fail-soft → []: a read
   *  failure must never crash the request worker nor synthesize a false alarm. */
  readAutoloopFireRows?: (ws: string) => Promise<AutoloopFireRow[]>;
  /** EI-15006: read the cup(bee)-tier dispatch budget + fresh-restart flag from the
   *  gateway capacity oracle, for the `panel:bees` idle-by-design gate. Default =
   *  `readGatewayBeeCapacity` (a live gateway fetch, fail-soft to unknown). Injected
   *  by tests to exercise the gate hermetically without real gateway I/O. */
  readBeeCapacity?: () => Promise<{ dispatchBudget: number | null; restartRecovering: boolean }>;
  /** EI-15126 (superseded by EI-18673998482704275's `updateFlapState`, below,
   *  for the production/hermetic defaults — kept as a BACKWARD-COMPAT injection
   *  seam only): a caller that supplies either this or `writeFlapState` (and
   *  not `updateFlapState` directly) gets a fallback that reads via this,
   *  mutates, then writes via `writeFlapState` — no other tick I/O runs in
   *  between, preserving pre-existing tests' exact sequential behavior. */
  readFlapState?: (ws: string) => Promise<FlapState>;
  /** EI-15126 (superseded — see `readFlapState`'s updated doc comment above). */
  writeFlapState?: (ws: string, state: FlapState) => Promise<void>;
  /** EI-18673998482704275: ATOMIC read-modify-write for the flap-decision step —
   *  see the doc comment on `defaultUpdateFlapState` above for why this must be
   *  atomic (a lost-update race across concurrent cluster workers) and how each
   *  default achieves it. Takes precedence over `readFlapState`/`writeFlapState`
   *  when supplied; when only those legacy deps are injected (existing tests),
   *  a fallback built from them preserves their exact prior sequential behavior. */
  updateFlapState?: (
    ws: string,
    mutate: (current: FlapState) => FlapMutationResult,
  ) => Promise<FlapMutationResult>;
  /** EI-19375157952766991: fresh, direct re-verification for the 'dead-routines'
   *  signal at FIRE TIME — see `defaultReverifyDeadRoutines`'s doc comment for why.
   *  Default = `defaultReverifyDeadRoutines` (a live DB re-read), gated identically
   *  to `readRoutineEngineLiveness`/`readAutoloopFireRows` (only when `readLast` is
   *  NOT injected — i.e. production; a test injecting `readLast` gets `null`, so
   *  every existing hermetic test keeps its byte-identical fire behavior). Returning
   *  `null` (unknown/failed) is FAIL-OPEN — it must never suppress a signal, only
   *  confirm one. */
  reverifyDeadRoutines?: (ws: string, now: number) => Promise<string[] | null>;
}

/**
 * EI-19375157952766991 — "cry wolf on git-sync". `evaluateLivenessAlarm`'s
 * `dead-routines` signal pages a fleet-wide `blocker` prescribing engine
 * remediation off whatever `health` snapshot `runLivenessAlarmTick` happened to
 * be holding — which, when the process-local cache is "fresh enough"
 * (`localSnapshotStale` false, i.e. < `DEFAULT_SNAPSHOT_STALE_MS` = 6min old),
 * can be trusted for up to 6 more minutes without ever being re-checked. Against
 * a 10min (`DEAD_ROUTINE_OVERDUE_MS`) overdue threshold, a snapshot taken right
 * as a routine crossed that line — from a genuinely transient tick-duration
 * blip under this box's heavy concurrent-agent load, the same class of
 * transient `deadRoutineOverdueMsForCiWindow` already widens the threshold for
 * during a green-checkpoint run — can self-clear within seconds while the
 * cached reading still pages minutes later.
 *
 * Measured live 2026-08-02 20:27:48Z (EI-19375157952766991): a `dead-routines`
 * blocker fired naming git-sync/cross-hive-outbox-drain/green-checkpoint as 4
 * routines overdue >10m; the escalation's own record shows it auto-resolved
 * 57 SECONDS later, and `git log` proved git-sync had committed continuously
 * through the entire window (largest gap 7.0min) with no >10min gap at any
 * point — the alarm's own prescribed remediation ("Revive the bg-host ticker")
 * would have been destructive against a demonstrably healthy engine.
 *
 * This re-reads `readDeadRoutines` fresh, directly against PG, at the moment
 * this signal is ABOUT TO escalate/page (not from any cached snapshot) — the
 * same "capture the emitter's inputs at fire time" the filed item itself
 * prescribes. An empty fresh re-read means the condition has already cleared:
 * treat it as a confirmed transient blip (no escalation opened, no page) rather
 * than alarming on stale data. A re-verify FAILURE (PG error, a stripped test
 * bundle missing the dynamic imports) returns `null` and is FAIL-OPEN — it must
 * never suppress a genuine incident, only confirm one.
 */
async function defaultReverifyDeadRoutines(ws: string, now: number): Promise<string[] | null> {
  try {
    const [{ getOrgPg }, { readDeadRoutines, resolveDeadRoutineOverdueMs }, { resolvePotHomeSlug }] =
      await Promise.all([import('@papercusp/db-org'), import('./compute'), import('../pot/wake')]);
    const { sql } = getOrgPg();
    const potSlug = resolvePotHomeSlug(undefined, undefined);
    const overdueMs = await resolveDeadRoutineOverdueMs(sql, potSlug, now);
    // EI-20045691451471399: `readDeadRoutines` now returns a census (count + bounded exemplars)
    // rather than a bare name list. Only the EMPTY/NON-EMPTY distinction is consumed here, and
    // `names` is empty exactly when `count` is 0 (the census returns early on zero rows), so
    // this keeps the fresh-re-read semantics byte-identical.
    return (await readDeadRoutines(sql, overdueMs, ws)).names;
  } catch {
    return null;
  }
}

async function defaultReadRoutineEngineLiveness(nowMs: number): Promise<RoutineEngineLiveness> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    return await readSharedRoutineEngineLiveness(getOrgPg().sql, {
      staleMs: DEFAULT_SNAPSHOT_STALE_MS,
      nowMs,
    });
  } catch {
    return { stale: false, unknown: true, lastTickMs: null, staleMs: null };
  }
}

/**
 * EI-9794 default `readAutoloopFireRows` — kettle/overwatch, the diagnosed
 * incident. Resolves the pot's home harness the same way `kettle:start` /
 * `isOverwatchAlive` do, reads its `autoloop_state` row (role = OVERWATCH_ROLE),
 * and reuses the EXACT `overwatchExpected` + `getOverwatchCadenceSec` predicates
 * the wake-liveness leg already trusts — so this alarm can never disagree with
 * "is kettle expected to be running" from a second, drifted implementation.
 */
async function defaultReadAutoloopFireRows(ws: string): Promise<AutoloopFireRow[]> {
  try {
    const [{ resolvePotHomeSlug }, { getOrgPg }, { overwatchExpected }, { getOverwatchCadenceSec }, { OVERWATCH_ROLE }] =
      await Promise.all([
        import('../pot/wake'),
        import('@papercusp/db-org'),
        import('../overwatch/cross-monitor'),
        import('../overwatch/control-state'),
        import('../overwatch/liveness'),
      ]);
    const installSlug = resolvePotHomeSlug(undefined, undefined);
    if (!installSlug) return [];
    const [expected, cadenceSec] = await Promise.all([
      overwatchExpected(ws, installSlug),
      getOverwatchCadenceSec(ws, installSlug),
    ]);
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ last_fired_at: Date | string | null }>>`
      SELECT last_fired_at FROM harness_shared.autoloop_state
       WHERE workspace_id = ${ws} AND harness_slug = ${installSlug} AND role = ${OVERWATCH_ROLE}
       LIMIT 1
    `;
    const raw = rows[0]?.last_fired_at ?? null;
    const lastFiredAtMs = raw == null ? null : new Date(raw).getTime();
    return [
      {
        role: OVERWATCH_ROLE,
        harnessSlug: installSlug,
        lastFiredAtMs: Number.isFinite(lastFiredAtMs) ? lastFiredAtMs : null,
        cadenceSec,
        expected,
      },
    ];
  } catch {
    return []; // fail-soft: never synthesize a false alarm from a broken read
  }
}

/** Exported (not module-private) so the EI-10060 route leg is directly
 *  unit-testable against mocked notifyAttention/broadcastSevereEvent — see
 *  liveness-alarm-route.test.ts. */
export async function defaultPage(s: AlarmSignal, ws: string): Promise<void> {
  try {
    await notifyAttention({
      kind: 'intervention',
      title: 'Infra-liveness BLOCKER',
      body: s.summary,
      importance: 'urgent',
      workspaceId: ws,
      data: { signal: s.key },
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
  try {
    // EI-10060: resolve the responsible party for this SIGNAL (raw s.key — the
    // registry keys off the un-prefixed condition class; the broadcast's own
    // `conditionKey` below stays `infra-liveness:${s.key}`-prefixed for the
    // WI-1444 lifecycle join, a SEPARATE concern from ownership). Additive: the
    // fleet-wide broadcast below is unchanged either way; a resolved owner just
    // ALSO gets a directed, woken, full-fidelity notice.
    const route = resolveSevereEventOwner(s.key);
    // EI-14091: the panel:bees signal ("no bees running") measures ONLY
    // Mug-placed cups — a human reading a bare blocker escalation for it can
    // misread "no bees" as "the whole fleet is idle". Fold the scope caveat
    // into the escalation BODY itself (not just the summary text, which can
    // be re-worded independently) so every reader gets it, not only readers
    // who separately consult the Kettle brief.
    const beesScopeCaveat =
      s.key === 'panel:bees'
        ? ` NOTE: this measures only Mug-placed cup agents, not the broader SU/agent fleet — ` +
          `cross-check fleet:assignments / coord:presence before treating this as a whole-fleet outage.`
        : '';
    await broadcastSevereEvent({
      summary: `${SUMMARY_PREFIX}${s.summary}`,
      body:
        `Detected by the request-path infra-liveness alarm (R4-3/R4-8), independent of the background ` +
        `routine engine. Signal: ${s.key}. Workspace: ${ws}. See harness_escalations for the durable record.${beesScopeCaveat}`,
      category: 'severe-event',
      conditionKey: `infra-liveness:${s.key}`,
      // The request-path alarm pages only on the rising edge of a durable
      // open escalation; while the underlying signal remains true, the open
      // row suppresses repeat broadcasts until an explicit recovery. Mark
      // that envelope one-shot so condition-staleness-alarm does not mistake
      // the intentional silence for evidence that the signal recovered.
      oneShot: true,
      ...(route ? { route: { ownerSelector: route.ownerSelector, reason: route.reason } } : {}),
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
}

async function defaultPageResolved(sigs: string[]): Promise<void> {
  if (sigs.length === 0) return;
  try {
    await broadcastSevereEventResolvedMany({
      conditionKeys: sigs.map((sig) => `infra-liveness:${sig}`),
      summary: `infra-liveness RECOVERED (${sigs.join(', ')}) — condition(s) no longer firing.`,
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
}

/** Bound the per-tick escalation-log read: large enough to cover the recently-
 *  open infra-liveness set (and the recovered cohort on the first sweep), small
 *  enough not to re-load the whole ~13k backlog every ~2min (cf. EI-1490). */
const OPEN_SCAN_WINDOW = 500;

/**
 * One alarm tick: request workers read the fresh cross-process snapshot written
 * by the bg tick; hermetic tests may still exercise the legacy cache seam. A
 * missing/stale shared row is unknown/no-op. Then, against the OPEN
 * infra-liveness escalations (EI-2146):
 *   - auto-resolve every open escalation whose condition no longer fires (the
 *     one-time backlog sweep on the first post-deploy tick), and
 *   - fire each NEW signal, durably deduped (one open row per signature, across
 *     workers + restarts) and in-memory cooldown-debounced.
 * Best-effort: never throws.
 */
export async function runLivenessAlarmTick(
  workspaceId?: string,
  deps: AlarmDeps = {},
): Promise<{ fired: AlarmSignal[]; signals: AlarmSignal[]; resolved: string[] }> {
  const ws = workspaceId ?? activeWorkspaceId();
  const now = (deps.now ?? Date.now)();
  const readLast = deps.readLast ?? lastSystemHealth;
  const compute = deps.computeHealth;
  const readSharedHealth = deps.readSharedHealth ?? readSharedSystemHealthSnapshot;
  // Production has neither of the hermetic cache/recompute seams. It MUST read
  // the cross-process snapshot directly so a cold/stale request-worker cache can
  // never fall through into the full health aggregation. Supplying
  // readSharedHealth explicitly takes the same path in recurrence tests even
  // when legacy seams are also injected.
  const useSharedSnapshot =
    deps.readSharedHealth !== undefined || (deps.readLast === undefined && deps.computeHealth === undefined);
  const escalate = deps.escalate ?? ((input) => openEscalation(INFRA_LIVENESS_IDENTITY, input));
  const listOpen =
    deps.listOpen ??
    (async () => {
      // EI-19403159016550818: scope the read to THIS alarm server-side. Reading a
      // workspace-wide page and filtering `from` in JS silently drops this alarm's
      // own rows once the workspace open set exceeds the window — the page is
      // ordered oldest-first, so an actively-minting alarm's rows are the ones cut
      // off, and the auto-resolve below then becomes a no-op that is
      // indistinguishable from "nothing of mine is open". Measured 2026-08-03:
      // 6 open rows for this alarm, only 1 inside a 500-row window.
      const { escalations } = await listEscalationsPaginated({
        status: 'open',
        maxRecords: OPEN_SCAN_WINDOW,
        from: INFRA_LIVENESS_IDENTITY.ownerId,
      });
      return escalations;
    });
  const resolve =
    deps.resolve ??
    ((msg_id, choice, note) =>
      resolveEscalation({ msg_id, choice, note, resolver: INFRA_LIVENESS_IDENTITY.ownerId }));
  const staleMs = deps.snapshotStaleMs ?? DEFAULT_SNAPSHOT_STALE_MS;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const flapWindowMs = deps.flapWindowMs ?? DEFAULT_FLAP_WINDOW_MS;
  const flapThreshold = deps.flapThreshold ?? DEFAULT_FLAP_THRESHOLD;
  // WI-4023: paging defaults to a NO-OP here — a bare call to this pure(ish) tick
  // function (every unit test) must NEVER fire a real owner push / fleet broadcast.
  // The live scheduled loop (startInfraLivenessAlarm below) explicitly wires the
  // real defaultPage/defaultPageResolved. Getting this backwards (real-by-default)
  // is exactly the bug that fired live false alarms during this fix's own first
  // test run — see the coord broadcast + apology, 2026-07-11 02:10Z.
  const page = deps.page ?? (async () => {});
  const pageResolved = deps.pageResolved ?? (async () => {});
  // EI-15126: durable cross-worker flap-episode store — gated identically to
  // readBeeCapacity (deps.readLast === undefined ⇒ production, real PG;
  // otherwise the single-process hermetic fallback every existing test relies on).
  // EI-18673998482704275: the flap-episode MUTATION is now a single atomic
  // read-modify-write (see defaultUpdateFlapState's doc comment) instead of a
  // read-at-start/write-at-end pair straddling this tick's other await points
  // — that gap was the lost-update race across concurrent cluster workers.
  const updateFlapState: (
    w: string,
    mutate: (current: FlapState) => FlapMutationResult,
  ) => Promise<FlapMutationResult> =
    deps.updateFlapState ??
    (deps.readFlapState || deps.writeFlapState
      ? // A caller injected the legacy read/write seam directly (existing
        // tests) — preserve its exact prior sequential semantics: read once,
        // mutate synchronously, write once, no interleaving side-I/O between.
        async (w, mutate) => {
          const readFn = deps.readFlapState ?? (async () => hermeticFlapStateFallback);
          const writeFn =
            deps.writeFlapState ??
            (async (_w: string, s: FlapState) => {
              hermeticFlapStateFallback = s;
            });
          const current = await readFn(w).catch(() => ({}) as FlapState);
          const result = mutate(current);
          await writeFn(w, result.next).catch(() => {});
          return result;
        }
      : deps.readLast === undefined
        ? defaultUpdateFlapState
        : // Hermetic default: read+mutate+write with NO await between them, so
          // JS run-to-completion makes this critical section atomic even under
          // a Promise.all-concurrent test caller — mirrors the real PG
          // transaction's row-lock guarantee without needing real PG.
          async (_w, mutate) => {
            const result = mutate(hermeticFlapStateFallback);
            hermeticFlapStateFallback = result.next;
            return result;
          });

  const cached = readLast(ws);
  const localSnapshotAgeMs = cached ? now - cached.evaluatedAt : null;
  const localSnapshotStale = localSnapshotAgeMs === null || localSnapshotAgeMs > staleMs;
  let health: SystemHealth | null;
  if (useSharedSnapshot) {
    health = await readSharedHealth(ws).catch(() => null);
  } else if (localSnapshotStale) {
    health = compute ? await compute(ws).catch(() => null) : null;
  } else {
    health = cached;
  }
  // Missing or stale shared evidence is UNKNOWN, never an all-clear and never a
  // reason to recreate the full graph on a request worker. No open row is read,
  // fired, or reconciled from an unobservable snapshot.
  if (!health) return { fired: [], signals: [], resolved: [] };

  // D-026 evidence is intentionally read only for production/default ticks unless a
  // caller explicitly injects it. A hermetic `readLast` seam must never shell out to
  // systemd, while reader failures remain fail-closed (undefined => blocker path).
  const readD026Quiescence =
    deps.d026Quiescence ?? (deps.readLast === undefined ? readD026QuiescenceEvidence : null);
  let d026Quiescence: D026QuiescenceEvidence | undefined;
  if (readD026Quiescence) {
    try {
      d026Quiescence = await readD026Quiescence();
    } catch {
      d026Quiescence = undefined;
    }
  }

  // WI-4773: `lastSystemHealth` is an in-memory Map. In production the periodic
  // writer runs in papercup-bg-host while this alarm runs in a :3070 request
  // worker, so the local cache can age forever while the real engine is healthy.
  // Gate the engine-death signal on the shared DBOS routinesTick watermark. The
  // unknown case is fail-soft (no fabricated outage), matching probeBgHostTicker.
  // Existing unit fixtures that inject only the local cache keep their hermetic
  // legacy behavior; production and the new recurrence tests take this branch.
  const readRoutineEngine =
    deps.readRoutineEngineLiveness ?? (deps.readLast === undefined ? defaultReadRoutineEngineLiveness : null);
  const routineEngine = readRoutineEngine
    ? await readRoutineEngine(now).catch(
        () => ({ stale: false, unknown: true, lastTickMs: null, staleMs: null }) as RoutineEngineLiveness,
      )
    : null;
  // A successfully-read shared snapshot is fresh by construction; the independent
  // routine-engine watermark can still prove the bg host stale. Hermetic legacy
  // callers that recomputed through their injected seam also report fresh.
  const snapshotAgeMs = useSharedSnapshot
    ? routineEngine
      ? routineEngine.unknown || !routineEngine.stale
        ? null
        : (routineEngine.staleMs ?? staleMs + 1)
      : null
    : localSnapshotStale
      ? null  // A hermetic test seam just recomputed fresh.
      : routineEngine
        ? routineEngine.unknown || !routineEngine.stale
          ? null
          : (routineEngine.staleMs ?? staleMs + 1)
        : localSnapshotAgeMs;
  const lastSuccessfulTickMs = routineEngine?.lastTickMs ?? health.evaluatedAt ?? cached?.evaluatedAt ?? null;

  // P-008: the PG-restart drift baseline. Read the previous postmaster-start value,
  // evaluate against it, then advance it to the current reading — but ONLY when PG
  // was readable this tick (cur != null). An unreadable tick must not clobber the
  // baseline, else the next readable tick would false-fire a "restart".
  const readBaseline = deps.readPostmasterBaseline ?? ((w: string) => lastPostmasterStartMs.get(w) ?? null);
  const writeBaseline = deps.writePostmasterBaseline ?? ((w: string, ms: number) => void lastPostmasterStartMs.set(w, ms));
  const prevPostmasterStartMs = readBaseline(ws);

  // EI-9794: fetch fresh fire-recency rows every tick (cheap — one indexed PK
  // read + two already-cached control-state reads) rather than folding into the
  // cached SystemHealth snapshot, so this signal is NEVER blinded by a stale
  // cache the way tickStale-suppressed signals can be — it is the one check that
  // must keep evaluating even when everything else is frozen.
  const readAutoloopFireRows = deps.readAutoloopFireRows ?? defaultReadAutoloopFireRows;
  const autoloopFireRows = await readAutoloopFireRows(ws).catch(() => [] as AutoloopFireRow[]);

  // EI-15006: the cup-placeable + capacity gate for the `panel:bees` "no bees
  // running" signal. Fetch the bee-tier capacity ONCE per tick (fail-soft to
  // unknown), then derive the context per-snapshot so the recovery-recompute
  // below re-evaluates the FRESH frontier under the same capacity reading.
  // Mirror the readRoutineEngine gating: a test that injects `readLast` (the
  // hermetic-cache seam) gets the no-I/O unknown-capacity stub unless it
  // explicitly injects `readBeeCapacity`, so a unit tick never hits the gateway.
  const readBeeCapacity =
    deps.readBeeCapacity ??
    (deps.readLast === undefined
      ? readGatewayBeeCapacity
      : async () => ({ dispatchBudget: null as number | null, restartRecovering: false }));
  const beeCapacity = await readBeeCapacity().catch(() => ({ dispatchBudget: null, restartRecovering: false }));

  // EI-19462267124852221: keep the EXACT beesLiveness that produced `signals`, so the
  // policy-suppression guard below judges the same evidence the fire decision used.
  let beesLivenessForSignals = beesLivenessFromHealth(health, beeCapacity);
  let signals = evaluateLivenessAlarm(health, snapshotAgeMs, {
    snapshotStaleMs: staleMs,
    prevPostmasterStartMs,
    autoloopFireRows,
    beesLiveness: beesLivenessForSignals,
    d026Quiescence,
    ...(snapshotAgeMs !== null && snapshotAgeMs > staleMs
      ? { stallDiagnosis: diagnoseHealthTickStall(health, snapshotAgeMs, now, lastSuccessfulTickMs) }
      : {}),
  });
  let currentSigs = new Set(signals.map((s) => s.key));

  const curPostmasterStartMs = health.panels.infra?.data?.pg?.postmasterStartMs ?? null;
  if (curPostmasterStartMs !== null) writeBaseline(ws, curPostmasterStartMs);

  // Read the open infra-liveness escalations ONCE, bucketed by signature. The
  // durable, cross-worker/cross-restart dedup the in-memory debounce cannot give.
  // Fail-soft: a log-read error degrades to the in-memory debounce only — it must
  // never crash the request worker nor block a genuine alarm.
  let openBySig = new Map<string, EscalationRecord[]>();
  try {
    for (const rec of await listOpen()) {
      const sig = livenessSignatureOf(rec);
      if (!sig) continue;
      const list = openBySig.get(sig);
      if (list) list.push(rec);
      else openBySig.set(sig, [rec]);
    }
  } catch {
    openBySig = new Map();
  }

  // WI-4878: if there are open escalations but no newly-firing signals, ensure
  // we use fresh health data when checking for recovery.
  // A cached snapshot can blind the auto-resolve detector: if the cache was
  // computed while failures were active, it would keep showing those failures
  // even after they roll out of the 1h window, so the signal would never stop
  // firing and recovery would never be detected. Recompute fresh when we have
  // open escalations that SHOULD be recovering (no signals currently firing for
  // their signatures).
  //
  // BUGFIX: recovery detection must run REGARDLESS of cache freshness. If the
  // cache was stale (> 6 min old), line 762 already computed a fresh snapshot.
  // If there are open escalations, we must check if they've recovered against
  // fresh data. Production re-reads the shared row; if it disappeared or aged
  // out, the tick stops with no reconciliation. The prior condition
  // `&& !localSnapshotStale` was inverted and skipped recovery detection exactly
  // when a hermetic caller had just refreshed a stale cache.
  // EI-19462267124852221: track WHICH snapshot produced `currentSigs`, so the
  // unobservability check below judges the same evidence the signals came from.
  let healthForSignals = health;
  if (openBySig.size > 0) {
    const sigsShouldRecover = Array.from(openBySig.keys()).some((sig) => !currentSigs.has(sig));
    if (sigsShouldRecover) {
      // Recompute fresh health snapshot for accurate recovery detection
      // (or verify the fresh snapshot we computed on line 762).
      const freshHealth = useSharedSnapshot
        ? await readSharedHealth(ws).catch(() => null)
        : localSnapshotStale
          ? health
          : compute
            ? await compute(ws).catch(() => null)
            : null;
      // A recovery decision requires current evidence. If the shared row aged
      // out between the initial read and this re-check, preserve every open row
      // and make the whole tick a no-op rather than false-clearing it.
      if (!freshHealth) return { fired: [], signals: [], resolved: [] };
      healthForSignals = freshHealth;
      beesLivenessForSignals = beesLivenessFromHealth(freshHealth, beeCapacity);
      signals = evaluateLivenessAlarm(freshHealth, null, {
        snapshotStaleMs: staleMs,
        prevPostmasterStartMs,
        autoloopFireRows,
        beesLiveness: beesLivenessForSignals,
        d026Quiescence,
      });
      currentSigs = new Set(signals.map((s) => s.key));
    }
  }

  // 1. Auto-resolve-on-recovery: every open infra-liveness escalation whose
  //    signal is no longer firing. On the first post-deploy tick this drains the
  //    recovered backlog (gateway/accounts/no-bees-while-idle) so the pile clears.
  //    EI-18673998482704275: this loop no longer touches `flapEpisodes` directly —
  //    it only records WHICH blocker signatures genuinely transitioned; the flap
  //    accounting for them happens atomically below, alongside the fire loop's.
  //    EI-19462267124852221: a signal that is not firing because its input was
  //    UNREADABLE this tick has not recovered — we simply did not look. Resolving it
  //    drops the open row the next fire would have coalesced onto, so the next
  //    readable tick re-fires a fresh escalation: fire → false-resolve → fire, at the
  //    tick rate, forever. Skip those signatures and leave the open row standing.
  const unobservableSigs = unobservableLivenessSignatures(healthForSignals);
  // EI-19462267124852221: the THIRD absence reason. A signal withheld by a policy gate
  // (`beesIdleByDesign`) is still TRUE — measured 2026-08-04, every `panel:bees`
  // auto-resolve announced "condition recovered" with the panel reading crit in the
  // ticks either side of it. Resolving it drops the open row the next fire would have
  // coalesced onto, so an unstable GATE — not a changing condition — drives
  // fire → false-resolve → fire at the tick rate.
  const suppressedSigs = policySuppressedLivenessSignatures(
    healthForSignals,
    beesLivenessForSignals,
    d026Quiescence,
  );
  const openSigs = new Set(openBySig.keys());
  const confirmedRecoverySigs = new Set(
    [...openSigs].filter((sig) => !RECOVERY_CONFIRMATION_SIGNATURES.has(sig) || suppressedSigs.has(sig)),
  );
  let repeatedAfterPendingRecoverySigs = new Set<string>();
  const recoverySignature = 'stale-paused-routines';
  if (openSigs.has(recoverySignature) || currentSigs.has(recoverySignature)) {
    const recoveryDecision = await updateFlapState(ws, (current) => {
      const episodes = new Map<string, FlapEpisode>(Object.entries(current));
      const episode = episodes.get(recoverySignature) ?? { fireCount: 0, quietSinceMs: null };
      const toResolveSigs: string[] = [];
      const toBumpSigs: string[] = [];
      const hasRecoveryCandidate = (episode.recoveryObservationCount ?? 0) > 0;

      if (hasRecoveryCandidate && (!openSigs.has(recoverySignature) || currentSigs.has(recoverySignature) || unobservableSigs.has(recoverySignature))) {
        if (openSigs.has(recoverySignature) && currentSigs.has(recoverySignature)) toBumpSigs.push(recoverySignature);
        episode.recoveryObservationCount = 0;
        delete episode.lastRecoveryObservationAtMs;
      }

      if (openSigs.has(recoverySignature) && !currentSigs.has(recoverySignature) && !unobservableSigs.has(recoverySignature)) {
        if (suppressedSigs.has(recoverySignature)) {
          toResolveSigs.push(recoverySignature);
          episode.recoveryObservationCount = 0;
          delete episode.lastRecoveryObservationAtMs;
        } else {
          const observedAtMs = healthForSignals.evaluatedAt;
          if (
            Number.isFinite(observedAtMs) &&
            (episode.lastRecoveryObservationAtMs === undefined || observedAtMs > episode.lastRecoveryObservationAtMs)
          ) {
            episode.recoveryObservationCount = (episode.recoveryObservationCount ?? 0) + 1;
            episode.lastRecoveryObservationAtMs = observedAtMs;
          }
          if ((episode.recoveryObservationCount ?? 0) >= RECOVERY_CONFIRMATION_OBSERVATIONS) {
            toResolveSigs.push(recoverySignature);
            episode.recoveryObservationCount = 0;
            delete episode.lastRecoveryObservationAtMs;
          }
        }
      }

      if (episodes.has(recoverySignature) || (episode.recoveryObservationCount ?? 0) > 0) {
        episodes.set(recoverySignature, episode);
      }
      return {
        next: Object.fromEntries(episodes),
        toPage: [],
        toResolveSigs,
        toBumpSigs,
      };
    });
    recoveryDecision.toResolveSigs.forEach((sig) => confirmedRecoverySigs.add(sig));
    repeatedAfterPendingRecoverySigs = new Set(recoveryDecision.toBumpSigs ?? []);
  }
  const resolved: string[] = [];
  const transitionedBlockerSigs: string[] = [];
  for (const [sig, recs] of openBySig) {
    if (currentSigs.has(sig)) continue; // still firing — keep the single open row
    if (unobservableSigs.has(sig)) continue; // NOT OBSERVED this tick ≠ recovered
    // NOTE: a POLICY-SUPPRESSED signature is deliberately NOT skipped here. Closing its
    // row is correct — an idle-by-design fleet needs no human attention, so the open
    // "no bees running" blocker is a false positive that must drain (the one-time
    // backlog sweep depends on exactly this). What must NOT happen is announcing it as
    // a RECOVERY, which is what made the durable log unreadable; see `reason` below.
    const policySuppressed = suppressedSigs.has(sig);
    if (!policySuppressed && !confirmedRecoverySigs.has(sig)) continue;
    // WI-4181: only a resolve that actually TRANSITIONED the row (wrote the
    // sibling escalation_resolved event) counts. resolveEscalation is idempotent
    // and returns the sentinel strings 'not_found' / 'already_resolved' /
    // 'requires_spawn_approve' WITHOUT writing — and broadcasting recovery on
    // mere PRESENCE of an "open" row turned a fold-window zombie (an old open
    // whose resolution had been evicted from listEscalationsPaginated's bounded
    // resolves window) into a storm: resolve() returned 'already_resolved' every
    // tick, nothing ever re-entered the window, and 17 request workers re-emitted
    // "RECOVERED (health-tick-stale)" every ~2min for ~12h (6,000+ duplicates).
    // Gating on the transition also collapses the multi-worker race on a GENUINE
    // recovery: only the worker whose resolve actually landed announces it.
    let transitioned = false;
    for (const rec of recs) {
      try {
        // EI-19462267124852221: carry the OBSERVATION, not just the conclusion. A bare
        // "condition recovered" is identical whether we saw a real zero or saw nothing,
        // which is why 5,303 false resolves were undiagnosable from the durable log.
        // EI-19462267124852221: say WHICH of the two closes this is. "cleared (condition
        // recovered)" on a policy-suppressed signal is simply false — measured 2026-08-04,
        // every panel:bees auto-resolve carried it while the panel read crit in the ticks
        // either side. A reader cannot tell a recovery from a reclassification if both
        // write the same sentence, and that is why six passes could not diagnose this.
        const d026Reclassified = sig === 'dead-routines' && d026QuiescenceIsActive(d026Quiescence);
        const reason = d026Reclassified
          ? 'reclassified as expected D-026 quiescence — the condition is STILL TRUE (NOT recovered)'
          : policySuppressed
            ? 'withheld by a policy gate — the condition is STILL TRUE, reclassified as benign (NOT recovered)'
          : 'condition recovered';
        const outcome = await resolve(
          rec.msg_id,
          'auto-resolved',
          `infra-liveness signal '${sig}' cleared (${reason}) — ${resolveEvidenceFor(sig, healthForSignals, beesLivenessForSignals, d026Quiescence)}`,
        );
        if (outcome === 'not_found' || outcome === 'already_resolved' || outcome === 'requires_spawn_approve') continue;
        resolved.push(rec.msg_id);
        transitioned = true;
      } catch {
        /* a resolve failure must never crash the request worker */
      }
    }
    if (transitioned && recs.some((r) => r.severity === 'blocker') && !policySuppressed) {
      transitionedBlockerSigs.push(sig);
    }
    // Drop the in-memory cooldown so a genuine re-occurrence after recovery
    // re-fires immediately ("re-fire only after auto-resolve").
    lastAlertedAt.delete(sig);
  }

  // 2. Fire each NEW signal — durably deduped (skip a signature that already has
  //    an open escalation AT >= THIS SEVERITY; WI-36010 lets an advisory→blocker
  //    escalation through, coalescing onto that same row) then in-memory
  //    cooldown-debounced. The escalation row
  //    itself is opened unconditionally here (WI-4181 dedup only); whether it ALSO
  //    pages the fleet is decided atomically below, together with the resolve
  //    step's recovery-broadcast decision.
  // EI-19375157952766991: fresh re-verification for 'dead-routines' at FIRE TIME —
  // see `defaultReverifyDeadRoutines`'s doc comment. Gated identically to
  // `readRoutineEngine`/`readAutoloopFireRows`/`readBeeCapacity` above: only wired
  // in production (deps.readLast === undefined); a test injecting `readLast` keeps
  // every existing hermetic fixture's byte-identical fire behavior (reverify: null).
  const reverifyDeadRoutines =
    deps.reverifyDeadRoutines ?? (deps.readLast === undefined ? defaultReverifyDeadRoutines : null);

  const fired: AlarmSignal[] = [];
  const newBlockerSignals: AlarmSignal[] = [];
  const escalationInput = (s: AlarmSignal) => ({
    severity: s.severity,
    summary: `${SUMMARY_PREFIX}${s.summary}`,
    body:
      `Detected by the request-path infra-liveness alarm (R4-3/R4-8) — it runs on a request worker, ` +
      `independent of the background routine engine, so it fires even when that engine is frozen ` +
      `(the failure that blinds the in-engine watchdog). Signal: ${s.key}. Workspace: ${ws}.`,
    // EI-2146: stamp the signature so dedup + auto-resolve match exactly
    // (no summary-parsing needed for records this alarm writes).
    meta: {
      // EI-11841: stable dedup identity must not include dynamic timing/evidence
      // fields, or concurrent request workers can open duplicate flap rows.
      livenessSignature: s.key,
      dedupKind: 'infra-liveness',
      subjectSignature: s.key,
      ...(s.diagnosis ? { healthTickStallDiagnosis: s.diagnosis } : {}),
      // EI-10060: no registered/derivable owner for this signal — nobody is
      // durably on the hook for it beyond the ambient `to:['*']` broadcast
      // (which digest-suppresses after EI-9939's flap threshold like every
      // other repeat fire). Stamped so a human-facing surface can filter on
      // "escalations nobody owns" instead of that fact staying implicit.
      needsHumanRoute: resolveSevereEventOwner(s.key) === null,
    },
  });
  for (const s of signals) {
    // WI-36010: this dedup used to be `if (openBySig.has(s.key)) continue` — keyed on
    // the signature ALONE, so it was SEVERITY-BLIND. Both stale-paused branches emit
    // key 'stale-paused-routines' and differ only in severity (see §2b above), so one
    // open `advisory` row silently swallowed every later `blocker` for the same key.
    // Measured live: an advisory opened 2026-08-06T19:20Z never resolved, and for the
    // 2 days after it the alarm fired ZERO times while the detector still matched 57
    // routines — i.e. a release-critical stale pause (the literal WI-5839 incident:
    // release-trigger silently paused ~4 days, twice) could no longer page anyone.
    //
    // A signal that has ESCALATED to `blocker` must therefore reach `escalate()`. That
    // does NOT open a second row or re-arm the fire/resolve churn: we stamp an explicit
    // `dedupKind`/`subjectSignature` (below), and openEscalation's coalesce matches on
    // exactly those two — both severity-independent — so it folds onto the ONE open row
    // and refreshes its severity in place (EI-12546's advisory→blocker upgrade path,
    // escalations.ts withRepeatMetadata). The machinery was already correct; this early
    // `continue` was simply returning before it could ever run.
    //
    // Deliberately NARROW: only a `blocker` breaks through, and only when no open row is
    // already `blocker`. Same-severity repeats stay suppressed exactly as before, and we
    // do not rank 'question' against 'advisory' — that ordering is orthogonal, not a
    // severity ladder, and inventing one here would change behavior nobody measured.
    const openForSig = openBySig.get(s.key);
    if (openForSig?.length) {
      const escalatesToBlocker = s.severity === 'blocker' && !openForSig.some((r) => r.severity === 'blocker');
      if (!escalatesToBlocker) {
        // EI-20068390701347529: dead-routines is already a blocker, so severity
        // cannot express a worsening incident. If its rendered magnitude/text
        // changed, refresh the one durable row in place. This deliberately runs
        // before the in-memory cooldown and does not enter `fired` or
        // `newBlockerSignals`: it updates operator context without re-paging or
        // re-opening the flap episode.
        const renderedSummary = `${SUMMARY_PREFIX}${s.summary}`;
        const shouldBump =
          repeatedAfterPendingRecoverySigs.has(s.key) && openForSig.some((record) => record.severity === s.severity);
        const shouldRefresh =
          s.key === 'dead-routines' && openForSig.some((record) => record.summary !== renderedSummary);
        if (shouldBump || shouldRefresh) {
          try {
            await escalate(escalationInput(s));
          } catch {
            /* a refresh failure must never crash the request worker */
          }
        }
        continue; // an open escalation at >= this severity already covers it
      }
    }
    if (s.key === 'dead-routines' && reverifyDeadRoutines) {
      const fresh = await reverifyDeadRoutines(ws, now).catch(() => null);
      // A confirmed-empty fresh re-read means the condition already cleared —
      // a transient blip, not the sustained engine-starvation this signal exists
      // to catch. `null` (re-verify unknown/failed) is fail-OPEN: fall through
      // and fire as before, never silently suppress a genuine incident.
      if (fresh !== null && fresh.length === 0) continue;
    }
    const prev = lastAlertedAt.get(s.key);
    if (prev !== undefined && now - prev < debounceMs) continue;
    lastAlertedAt.set(s.key, now);
    fired.push(s);
    try {
      await escalate(escalationInput(s));
    } catch {
      /* an alarm-send failure must never crash the request worker */
    }
    // WI-4023 (root-cause fix, 2026-07-11): a `blocker` signal used to reach ONLY
    // `openEscalation` — a durable PG row with no active push. Verified live
    // (2026-07-10 20:38-21:22 incident): this alarm fired `health-tick-stale` /
    // `dead-routines` blockers correctly within ~1-8min of the DBOS engine dying,
    // but NOBODY noticed for ~40min because nothing paged — the escalation just sat
    // in `harness_escalations` behind the ambient/no-default-surface coord:inbox
    // filter, alongside 292 OTHER escalations that had aged past the attention
    // threshold unread. git-sync-stall-watchdog.ts already pages on its own alarms
    // (notifyAttention + broadcastSevereEvent) — this brings the SAME active paging
    // to every `blocker`-severity infra-liveness signal, not just git-sync's.
    if (s.severity === 'blocker') newBlockerSignals.push(s);
  }

  // EI-18673998482704275: ATOMICALLY decide the flap accounting for BOTH the
  // resolve step (§1) and the fire step (§2) in a single read-modify-write —
  // see `defaultUpdateFlapState`'s doc comment for why this must be atomic
  // (a lost-update race across concurrent cluster workers otherwise lets a
  // genuinely-flapping condition re-broadcast every fire/resolve cycle
  // forever, never actually engaging the EI-9939 suppression).
  const { toPage, toResolveSigs } = await updateFlapState(ws, (current) => {
    const episodes = new Map<string, FlapEpisode>(Object.entries(current));
    const toResolveSigsInner: string[] = [];
    for (const sig of transitionedBlockerSigs) {
      // EI-9939: a signature already classified as FLAPPING (>flapThreshold
      // fires seen this episode) does NOT get its own recovery broadcast —
      // that would just be the other half of the flap-storm this exists to
      // stop. Mark it quiet-since-now instead; the settle sweep below decides
      // whether/when it earns exactly one final all-clear. A non-flapping
      // signature (≤flapThreshold fires) keeps today's byte-identical
      // behavior: broadcast the recovery immediately.
      const ep = episodes.get(sig);
      if (ep && ep.fireCount > flapThreshold) {
        ep.quietSinceMs = now;
      } else {
        toResolveSigsInner.push(sig);
      }
    }
    // EI-9939 settle sweep: a previously-flapping signature that has stayed
    // quiet (no re-fire) for a FULL flap window is genuinely settled — send the
    // one final recovery broadcast now (it supersedes every earlier alert
    // sharing this condition_key, per coord:inbox's annotateResolvedConditions,
    // so a reader who only saw the FIRST fire still learns it cleared) and reset
    // the episode so a later genuine re-occurrence is treated as a fresh first
    // fire rather than staying suppressed forever.
    for (const [sig, ep] of episodes) {
      if (ep.quietSinceMs === null) continue;
      if (now - ep.quietSinceMs < flapWindowMs) continue;
      toResolveSigsInner.push(sig);
      episodes.delete(sig);
    }
    // EI-9939: classify each newly-fired blocker against its (possibly
    // still-open) flap episode BEFORE deciding whether to page. Fires 1 and 2
    // of a fresh or reopened episode always page (byte-identical to
    // pre-EI-9939 behavior); the 3rd+ fire of the SAME still-open episode is a
    // flap and is suppressed here (the durable escalation opened in §2 above
    // is written regardless — this only gates the fleet-wide broadcast). The
    // episode has no fixed expiry — see the FlapEpisode doc comment for why.
    const toPageInner: AlarmSignal[] = [];
    for (const s of newBlockerSignals) {
      const ep = episodes.get(s.key) ?? { fireCount: 0, quietSinceMs: null };
      ep.fireCount += 1;
      ep.quietSinceMs = null; // firing again cancels any pending settle
      episodes.set(s.key, ep);
      if (ep.fireCount <= flapThreshold) toPageInner.push(s);
    }
    return { next: Object.fromEntries(episodes), toPage: toPageInner, toResolveSigs: toResolveSigsInner };
  });

  // WI-4023: pair the fleet-facing all-clear with the auto-resolve above — see the
  // paging note on the fire loop for why this is needed (a durable escalation row
  // alone is not an active page, so its recovery deserves the same fleet visibility).
  await pageResolved(toResolveSigs);
  // WI-4023 (root-cause fix, 2026-07-11): active-page every blocker fire this tick's
  // atomic flap decision surfaced (fires 1-2 of an episode; the 3rd+ is suppressed).
  for (const s of toPage) await page(s, ws);

  return { fired, signals, resolved };
}

/**
 * Start the alarm on a request-worker loop. The timer is `unref`'d so it never
 * keeps the process alive. Env-killable (PAPERCUSP_INFRA_LIVENESS_ALARM=0);
 * interval overridable (PAPERCUSP_INFRA_LIVENESS_ALARM_MS).
 */
export function startInfraLivenessAlarm(opts: { intervalMs?: number } = {}): { stop(): void } {
  if (process.env.PAPERCUSP_INFRA_LIVENESS_ALARM === '0') return { stop() {} };
  const envMs = Number(process.env.PAPERCUSP_INFRA_LIVENESS_ALARM_MS);
  const intervalMs = opts.intervalMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  // .then(() => undefined) narrows to Promise<void> for the registry WITHOUT hiding the
  // promise — a tick that looked synchronous would release the re-entrancy guard early.
  const timer = managedSetInterval(
    'liveness-alarm',
    intervalMs,
    () =>
      runLivenessAlarmTick(undefined, {
        page: defaultPage,
        pageResolved: defaultPageResolved,
        d026Quiescence: readD026QuiescenceEvidence,
      }).then(
        () => undefined,
        () => undefined,
      ),
    { category: 'watchdog' },
  );
  return {
    stop() {
      timer.stop();
    },
  };
}

/** Test-only — clear the per-signal debounce, the P-008 PG-restart baseline,
 *  AND the EI-9939 flap-episode map (all module-level per-worker state a
 *  hermetic test must reset). */
export function _resetLivenessAlarmDebounce(): void {
  lastAlertedAt.clear();
  lastPostmasterStartMs.clear();
  hermeticFlapStateFallback = {};
}
