/**
 * green-stall-watchdog — EI-455 bug #2: a "no green verdict in N hours" /
 * "green-checkpoint stopped firing" alarm that runs INDEPENDENTLY of the
 * green-checkpoint routine.
 *
 * THE GAP: the in-routine stall detector (`trackGateStall` in
 * harness/routines/release-actions.ts) fires only when green-checkpoint
 * produces a verdict. It already catches stuck-red, no-green-while-firing
 * (>6h), and a crashing/timing-out suite (counted as a red). But it is
 * structurally BLIND to the one failure that actually bit us on 2026-06-13/19:
 * the green-checkpoint routine NOT FIRING AT ALL (the dead-executor dedup
 * wedge). When the routine never runs, `trackGateStall` never runs either —
 * `gate_health` just freezes (`consecutiveReds:0, lastGreenAt:stale,
 * stallAlerted:false`) and NOTHING alarms. `main` froze for ~23h, silently.
 *
 * THE FIX: a process-level watcher — deliberately NOT a DBOS routine, for the
 * same reason the dead-executor reaper isn't one: a routine-based watchdog
 * would queue on the very engine that wedges, so it couldn't fire when most
 * needed. This runs in the operator process, independent of the routine
 * engine, and alarms on EITHER:
 *   1. fire-staleness  — an ACTIVE green-checkpoint routine whose `last_fired_at`
 *      is older than FIRE_STALE_MS (cron is hourly, so ~3 missed fires ⇒ the
 *      scheduler isn't running it). This is the novel signal the in-routine
 *      detector cannot see.
 *   2. verdict-staleness — no GREEN verdict (`lastGreenAt`) in NO_GREEN_MS
 *      (12h). A deep backstop, set well past the in-routine 6h alarm so the two
 *      don't double-ping in the overlap; this only trips if the in-routine path
 *      somehow failed to alarm too.
 *
 * It reuses the exact alarm surfaces of the in-routine detector — an urgent
 * `notifyAttention` + a durable `harness_escalations` row — under its OWN phase
 * (`green-checkpoint-watchdog`) and its OWN dedup flag (`watchdogAlerted`) so it
 * never clobbers the in-routine `green-checkpoint-stall` row/flag. Both can
 * coexist; in the wedge case only the watchdog can fire. Recovery (the routine
 * fires + greens again) clears the flag + escalation idempotently.
 *
 * Kill-switch: PAPERCUSP_GREEN_STALL_WATCHDOG='0'.
 */
import type { Sql } from 'postgres';
import { execFileSync } from 'node:child_process';
// EI-21297913810967409: every `(non-fatal)` swallow below reports its outcome here, so a pass
// that CANNOT RUN is distinguishable from a pass that ran and found nothing. Called from each
// pass's `finally` — see recordWatchdogPassOutcome's own note on why the tail of the try is the
// wrong place (these passes have early `return out` paths).
import { recordWatchdogPassOutcome } from './watchdog-health';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { broadcastSevereEvent, broadcastSevereEventResolved } from '../severe-event-broadcast';
import { readRoutineEngineLiveness } from './routine-engine-liveness';
import {
  isCheckpointRunLockHeldCheap,
  launchDetachedCheckpoint,
  readCheckpointRunPhaseCheap,
  type LaunchCheckpointResult,
} from '../release-checkpoint-launch';
import { readManualRunAdmission, readQualificationAdmission } from '../release-checkpoint-config';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { integrationRoot } from '../release-deploy-launch';
import {
  DEFAULT_RELEASE_TRIGGER_FIRE_STALE_MS as RELEASE_TRIGGER_FIRE_STALE_MS,
  evaluateReleaseTriggerFireStale as evaluateReleaseTriggerFireStaleShared,
} from './release-trigger-fire-stale';
import { resolveCheckpointRouting } from '../harness/routines/hive-release-env';
import { resolveWorkspaceForHarness } from '../harness/workspace-for-harness';
import { PRESENCE_STALE_MS } from '../agent-tools/coordination/presence';
import {
  CHECKPOINT_SERIALIZER_HOLD_REASON_PREFIX,
  classifyCheckpointSerializerAuthority,
  checkpointQuiescenceItemId,
} from './checkpoint-serializer-authority';
import { classifyGateAbort, type GateAbortKind } from './gate-abort-status';
import { evaluateVerdictRateAlarm, readVerdictRateWindow } from './gate-verdict-rate-alarm';
import { GREEN_CHECKPOINT_SUITE_TIMEOUT_MS } from './green-checkpoint-schedule';
import {
  clearInFlightCandidateIfUnchanged,
  describeAbandonedInFlightCandidate,
  isPidAlive,
  judgeAbandonedInFlightCandidate,
  parseInFlightCandidate,
  recordLostGateRun,
  type StoredInFlightCandidate,
} from './in-flight-candidate';
import { buildKey } from '../events/await/catalog';
import type { EmitAwaitedEventOpts } from '../events/await/engine';
import type { GateOwnershipAssessment } from '../coord/gate-ownership';

/** An ACTIVE green-checkpoint that hasn't FIRED in this long ⇒ the scheduler isn't
 *  running it (cron is hourly at :15, so this is ~3 missed fires). */
const DEFAULT_FIRE_STALE_MS = 3 * 60 * 60 * 1000; // 3h
/** No GREEN verdict in this long ⇒ alarm. A deep backstop past the in-routine 6h
 *  alarm (STALL_AGE_MS) so the two detectors don't double-ping. */
const DEFAULT_NO_GREEN_MS = 12 * 60 * 60 * 1000; // 12h
/** How often the watchdog sweeps. green-checkpoint is hourly, so 15m is ample. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 15 * 60 * 1000; // 15 min

/** EI-9762: `main` can fall behind `staging` for hours WITHOUT tripping either
 *  alarm above — the routine keeps firing (fireStale stays false) and each fire
 *  keeps producing a verdict, just a RED one (verdictStale's 12h backstop only
 *  fires on the ABSENCE of green, not on main failing to advance). A run can also
 *  be externally killed (SIGKILL) before it ever writes a verdict at all — same
 *  blind spot. Both leave `main` frozen with nothing watching it: the 2026-07-11
 *  incident sat ~4.8h/56 commits behind before the OWNER had to ask. This is a
 *  DIFFERENT, tighter, more direct signal than the 12h no-green backstop: it
 *  doesn't care why main isn't advancing (red suite, killed run, wedged engine),
 *  only that staging has pulled meaningfully ahead for meaningfully long. */
const DEFAULT_MAIN_BEHIND_COMMITS = 20;
const DEFAULT_MAIN_BEHIND_MS = 60 * 60 * 1000; // 1h — deliberately far tighter than the 12h verdict-stale backstop
/** EI-10202: even a deep+old backlog is NOT a stall if the green-checkpoint gate
 *  has ADVANCED main within this long — that is normal churn (dozens of agents'
 *  staging commits briefly outrunning the ~15-20-min full-suite cycle), not a
 *  wedge. green-checkpoint's cron is hourly, so ~2 cycles (2h) is the "advanced
 *  recently" window the bug asks for; only NO green advance in >2h alongside a
 *  deep old backlog is the genuinely-stuck signature (persistent red / killed
 *  runs) EI-9762 was built to catch. */
const DEFAULT_MAIN_BEHIND_RECENT_GREEN_MS = 2 * 60 * 60 * 1000; // 2h ≈ ~2 hourly green-checkpoint cycles
/** WI-38340: how far `behindMs` may exceed `lastGreenAgeMs` before a recent
 *  advance stops counting as evidence the backlog is being CONSUMED.
 *
 *  EI-10202's suppression asks "did the gate advance main recently?" and answers
 *  a DIFFERENT question — "is main catching up?" — by assuming the two are the
 *  same. WI-38218's partial-green salvage broke that equivalence: it advances
 *  `main` to the longest green PREFIX while the tip stays red, so the gate can
 *  emit advance after advance (each one resetting `lastGreenAt`) while the old
 *  end of the backlog never moves. Measured 2026-08-12: a 3-commit prefix
 *  advance against a 327-commit backlog reset the suppression and fired an
 *  all-clear. Worse, it RE-ARMS on every partial advance, so the alarm can
 *  never fire again while the tip stays red.
 *
 *  The fix is to stop inferring progress from motion and MEASURE it, using a
 *  signal we already compute. `behindMs` is the age of the OLDEST commit on
 *  staging but not main — the old END of the backlog, which only a genuine
 *  advance consumes. Right after a FULL advance `main` IS the candidate, so
 *  everything older than that candidate's cut is gone and `behindMs` collapses
 *  to roughly the candidate's own age; from there it grows one-for-one with
 *  elapsed time. So a real advance `t` ago leaves `behindMs ≲ t + (one suite
 *  cut)`. When `behindMs` runs FURTHER ahead than that, whatever the gate
 *  advanced was not the old backlog, and the advance proves nothing about
 *  catch-up — do not suppress.
 *
 *  Deliberately measured rather than keyed on the gate's `advanced-prefix`
 *  status: the same hole opens for any future mechanism that moves `main`
 *  without consuming the backlog (a pin moved outside the routine by a manual
 *  prefix promotion already does), and a depth/age measurement cannot fall
 *  behind a taxonomy it does not know about. 2h covers a full ~55-min
 *  green-checkpoint suite plus slack. */
const DEFAULT_MAIN_BEHIND_ADVANCE_HORIZON_MS = 2 * 60 * 60 * 1000; // 2h ≈ one full suite + slack
const MAIN_BEHIND_PHASE = 'main-behind-staging-watchdog';

/** Phase + kind for the durable escalation — distinct from the in-routine
 *  `green-checkpoint-stall` so the two never clobber each other. */
const WATCHDOG_PHASE = 'green-checkpoint-watchdog';
const WATCHDOG_KIND = 'green-checkpoint-watchdog';

/**
 * A paused release gate is a different failure axis from an active gate that
 * stopped firing. Keep its durable row and condition independent so clearing
 * one signal can never erase the other.
 */
const PAUSED_GREEN_CHECKPOINT_PHASE = 'green-checkpoint-paused-watchdog';
const PAUSED_GREEN_CHECKPOINT_KIND = 'green-checkpoint-paused-watchdog';
const PAUSED_GREEN_CHECKPOINT_CONDITION_PREFIX = 'green-checkpoint-paused:';

/**
 * The paused gate is deliberately quiet only for the one accountable
 * serializer/quiescence shape. Keep this tied to the canonical presence
 * freshness window so a parked/dead owner cannot suppress the alarm forever.
 */
const LIVE_SERIALIZER_PRESENCE_STALE_MS = PRESENCE_STALE_MS;

export interface GreenStallThresholds {
  fireStaleMs?: number;
  noGreenMs?: number;
  /**
   * P-006 (WI-41755): how long a FIRING gate may record no verdict of any kind before that
   * silence is itself the alarm. Defaults to `DEFAULT_VERDICTLESS_GRACE_MS` (3h).
   */
  verdictlessMs?: number;
  /** How long a durable green-checkpoint-stall row may sit before recovery is retried. */
  greenCheckpointStallRecoveryStaleMs?: number;
  /** Maximum number of bounded recovery dispatch attempts for one stall episode. */
  greenCheckpointStallRecoveryMaxAttempts?: number;
  /**
   * D-006 ACTUATION SEAMS (gate-verdict-liveness-and-repair-reliability-2026-08-31 D-003).
   * `checkGreenStall` fires a verdict-less auto-refire ONLY when BOTH are wired; a caller
   * that omits them (every unit test, any bare sweep call) gets the pre-actuation advisory
   * behaviour, with the owner wall read fail-closed as ACTIVE. `startGreenStallWatchdog`
   * wires the production implementations, so actuation is a property of the running
   * watchdog process, never of an ad-hoc sweep invocation.
   */
  readGateFireWall?: () => Promise<GateFireWall>;
  launchCheckpoint?: () => Promise<LaunchCheckpointResult>;
  /** The one install refire actuation is scoped to (default: the operator-home harness). */
  refireHomeSlug?: string;
}

/**
 * The in-routine green-checkpoint-stall row is written at the alert edge and then
 * deliberately stays quiet until a green tick clears it. Three hourly cycles is
 * long enough to avoid racing the normal fixer path while still bounding an
 * unowned red gate.
 */
const DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_STALE_MS = 3 * 60 * 60 * 1000;
const DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_MAX_ATTEMPTS = 3;

export interface GreenCheckpointStallRecoveryMarker {
  attempts: number;
  lastAttemptAt: number | null;
  outcome: 'claimed' | 'dispatched' | 'no-progress' | 'max-attempts' | null;
  notifiedAt: number | null;
}

/**
 * Exact evidence for the checkpoint run that produced a gate-stall row.
 *
 * This is deliberately a structural mirror of release-actions.ts's
 * `CheckpointEvidence`: the watchdog cannot import the routine module without pulling in
 * its registration side effects. Null fields mean the historical row predates this
 * evidence, not that a different log may be selected. Missing fields remain
 * missing so a consumer can distinguish legacy evidence from a measured value.
 */
export interface CheckpointEvidence {
  logPath?: string;
  runId?: string;
  integrationRoot?: string;
}

export interface GreenCheckpointStallEscalation {
  /** The original JSON object, preserved so recovery markers never discard evidence. */
  raw: Record<string, unknown>;
  installSlug: string | null;
  candidate: string | null;
  failingTests: string[];
  /** Exact producing-run identity, when the row was written by an evidence-aware producer. */
  checkpointEvidence: CheckpointEvidence | null;
  ownershipCovered: boolean | null;
  recovery: GreenCheckpointStallRecoveryMarker;
}

export interface GreenCheckpointStallRecoveryDecision {
  action: 'none' | 'dispatch' | 'notify';
  reason: 'not-stale' | 'covered' | 'invalid' | 'retry' | 'max-attempts';
  nextAttempt: number;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const parseTimestamp = (value: unknown): number | null => {
  const numeric = finiteTimestamp(value);
  if (numeric != null) return numeric;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const displayTimestamp = (value: number | null): string =>
  value != null && Number.isFinite(value) ? new Date(value).toISOString() : '(unknown)';

const boundedText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
};

const displayPauseText = (value: string | null, fallback: string): string => {
  const text = value?.trim();
  return text ? text.slice(0, 1000) : fallback;
};

/** The pause evidence needed to judge one release green-checkpoint row. */
export interface PausedGreenCheckpointSnapshot {
  active: boolean | null;
  /** Optional in direct unit calls; the DB scan supplies both discriminators. */
  groupSlug?: string | null;
  targetRole?: string | null;
  nextFireMs: number | null;
  /** True when metadata.pause was present, even if all of its fields are empty. */
  pauseRecorded?: boolean;
  pauseReason?: string | null;
  pausedBy?: string | null;
  pausedAtMs?: number | null;
  /** DB-backed evidence for the exact D-012/D-016 serializer exception. */
  serializerItemId?: string | null;
  serializerClaimHold?: boolean;
  serializerOwner?: string | null;
  serializerHoldReason?: string | null;
  serializerOwnerLive?: boolean;
}

export interface PausedGreenCheckpointVerdict {
  overdue: boolean;
  reason: string | null;
}

export type PausedGreenCheckpointRecoveryDecision =
  | { action: 'none'; reason: 'not-overdue' | 'not-structured-serializer-hold' | 'serializer-live' }
  | {
      action: 'rearm';
      reason: 'serializer-owner-non-live';
      itemId: string;
      ownerId: string;
      holdReason: string;
    };

/**
 * Pure: an explicitly paused release green-checkpoint is overdue only after
 * its next scheduled fire has passed. Unknown/missing pause evidence is not a
 * verdict; the caller must not turn an unscoped inactive routine into a gate
 * alarm merely because its next_fire_at is old.
 */
export function evaluatePausedGreenCheckpoint(
  s: PausedGreenCheckpointSnapshot,
  now: number,
): PausedGreenCheckpointVerdict {
  if (s.active !== false) return { overdue: false, reason: null };
  if (s.groupSlug != null && s.groupSlug !== 'release') return { overdue: false, reason: null };
  if (s.targetRole != null && s.targetRole !== 'system:green-checkpoint') return { overdue: false, reason: null };
  if (s.pauseRecorded === false) return { overdue: false, reason: null };
  const hasPauseEvidence =
    s.pauseRecorded === true || s.pauseReason != null || s.pausedBy != null || s.pausedAtMs != null;
  if (!hasPauseEvidence || s.nextFireMs == null || !Number.isFinite(s.nextFireMs) || now <= s.nextFireMs) {
    return { overdue: false, reason: null };
  }

  // D-012/D-013 deliberately pauses the gate while D-016's sole serializer
  // owns the held work-item. Suppress only when every discriminator agrees:
  // the pause marker names the same item, that item still carries the durable
  // claim hold + exact serializer reason, and its canonical owner is fresh.
  // Any missing/unknown leg fails open to the ordinary overdue alarm.
  const serializerAuthority = classifyCheckpointSerializerAuthority({
    active: s.active,
    groupSlug: s.groupSlug ?? null,
    targetRole: s.targetRole ?? null,
    pauseReason: s.pauseReason ?? null,
    serializerItemId: s.serializerItemId ?? null,
    serializerClaimHold: s.serializerClaimHold ?? null,
    serializerOwner: s.serializerOwner ?? null,
    serializerHoldReason: s.serializerHoldReason ?? null,
  });
  const liveSerializerQuiescence = serializerAuthority.status === 'held' && s.serializerOwnerLive === true;
  if (liveSerializerQuiescence) return { overdue: false, reason: null };

  const pauseReason = displayPauseText(s.pauseReason ?? null, '(no pause reason recorded)');
  const pausedBy = displayPauseText(s.pausedBy ?? null, '(unknown pause owner)');
  const nextFireAt = displayTimestamp(s.nextFireMs);
  const pausedAt = displayTimestamp(s.pausedAtMs ?? null);
  return {
    overdue: true,
    reason:
      `green-checkpoint is PAUSED (active:false) past its scheduled fire at ${nextFireAt}; ` +
      `pause reason: ${pauseReason}; paused by: ${pausedBy}; paused at: ${pausedAt}. ` +
      `This is a release-critical hold that will not self-clear while inactive. ` +
      `Review the hold before resuming it with routines:set { name: 'green-checkpoint', active: true }`,
  };
}

/**
 * P-009: only one paused shape is safe to auto-recover — the structured
 * D-012/D-016 serializer hold whose durable item/owner/reason still match but
 * whose owner is no longer live. Generic/manual pauses remain alarm-only: their
 * external condition cannot be inferred from an old next_fire_at timestamp.
 * Re-arming produces a fresh run; it never writes a green/red gate verdict.
 */
export function decidePausedGreenCheckpointRecovery(
  s: PausedGreenCheckpointSnapshot,
  nowMs: number,
): PausedGreenCheckpointRecoveryDecision {
  if (!evaluatePausedGreenCheckpoint(s, nowMs).overdue) {
    return { action: 'none', reason: 'not-overdue' };
  }
  const itemId = checkpointQuiescenceItemId(s.pauseReason ?? null);
  const authority = classifyCheckpointSerializerAuthority({
    active: s.active,
    groupSlug: s.groupSlug ?? null,
    targetRole: s.targetRole ?? null,
    pauseReason: s.pauseReason ?? null,
    serializerItemId: s.serializerItemId ?? null,
    serializerClaimHold: s.serializerClaimHold ?? null,
    serializerOwner: s.serializerOwner ?? null,
    serializerHoldReason: s.serializerHoldReason ?? null,
  });
  if (!itemId || authority.status !== 'held') {
    return { action: 'none', reason: 'not-structured-serializer-hold' };
  }
  if (s.serializerOwnerLive === true) {
    return { action: 'none', reason: 'serializer-live' };
  }
  return {
    action: 'rearm',
    reason: 'serializer-owner-non-live',
    itemId,
    ownerId: authority.ownerId,
    holdReason: authority.holdReason,
  };
}

/** Durable body for the paused-gate alarm; keep the raw pause evidence visible. */
export function greenCheckpointPausedEscalationBody(opts: {
  installSlug: string;
  verdict: PausedGreenCheckpointVerdict;
  pauseReason: string | null;
  pausedBy: string | null;
  pausedAtMs: number | null;
  nextFireMs: number | null;
  nowMs: number;
  autoRecovery?: {
    state: 'rearmed';
    itemId: string;
    ownerId: string;
    rearmedAtMs: number;
    reason: string;
  } | null;
}): string {
  return JSON.stringify({
    kind: PAUSED_GREEN_CHECKPOINT_KIND,
    harness_slug: opts.installSlug,
    overdue: opts.verdict.overdue,
    reason: opts.verdict.reason,
    pauseReason: opts.pauseReason,
    pausedBy: opts.pausedBy,
    pausedAt: displayTimestamp(opts.pausedAtMs),
    pausedAtMs: opts.pausedAtMs,
    nextFireAt: displayTimestamp(opts.nextFireMs),
    nextFireMs: opts.nextFireMs,
    // A re-armed routine has not rendered a verdict. Keep that null explicit so
    // recovery of the EXECUTOR can never be read as recovery of the CODE.
    verdict: null,
    autoRecovery: opts.autoRecovery ?? null,
    emitted_at: opts.nowMs,
    detail:
      `green-checkpoint paused-release watchdog: ${opts.verdict.reason ?? 'no overdue pause detected'}. ` +
      (opts.autoRecovery
        ? `The structured serializer owner is non-live, so the existing routine was atomically re-armed at ${new Date(opts.autoRecovery.rearmedAtMs).toISOString()}. ` +
          `A fresh verdict is pending; no green/red result has been invented.`
        : `The release gate is inactive, so it cannot self-recover or advance deploys until the hold is reviewed.`),
  });
}

const finiteNonNegativeInt = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
};

const finiteTimestamp = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Parse the existing TEXT escalation body without trusting malformed/legacy rows.
 * A candidate and at least one named failing test are required by the recovery
 * decision; the parser keeps those checks separate so callers can report why a
 * row was skipped rather than treating malformed JSON as a live red.
 */
export function parseGreenCheckpointStallEscalation(raw: unknown): GreenCheckpointStallEscalation | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const record = asRecord(value);
  if (!record || record.kind !== 'green-checkpoint-stall') return null;

  const candidateValue = typeof record.candidate === 'string' ? record.candidate.trim() : '';
  const candidate = candidateValue.length >= 4 && candidateValue.length <= 128 ? candidateValue : null;
  const failingTests = Array.isArray(record.failingTests)
    ? record.failingTests
        .filter((test): test is string => typeof test === 'string' && test.trim().length > 0)
        .map((test) => test.trim())
        .slice(0, 20)
    : [];
  const evidenceRecord = asRecord(record.checkpointEvidence);
  const logPath = boundedText(evidenceRecord?.logPath, 1000);
  const runId = boundedText(evidenceRecord?.runId, 128);
  const integrationRoot = boundedText(evidenceRecord?.integrationRoot, 1000);
  const checkpointEvidence = evidenceRecord
    ? {
        ...(logPath ? { logPath } : {}),
        ...(runId ? { runId } : {}),
        ...(integrationRoot ? { integrationRoot } : {}),
      }
    : null;
  const ownership = asRecord(record.ownership);
  const recoveryRecord = asRecord(record.recovery);

  return {
    raw: record,
    installSlug: typeof record.harness_slug === 'string' && record.harness_slug.trim() ? record.harness_slug.trim() : null,
    candidate,
    failingTests,
    checkpointEvidence,
    ownershipCovered: typeof ownership?.covered === 'boolean' ? ownership.covered : null,
    recovery: {
      attempts: finiteNonNegativeInt(recoveryRecord?.attempts, 0),
      lastAttemptAt: finiteTimestamp(recoveryRecord?.lastAttemptAt),
      outcome:
        recoveryRecord?.outcome === 'claimed' ||
        recoveryRecord?.outcome === 'dispatched' ||
        recoveryRecord?.outcome === 'no-progress' ||
        recoveryRecord?.outcome === 'max-attempts'
          ? recoveryRecord.outcome
          : null,
      notifiedAt: finiteTimestamp(recoveryRecord?.notifiedAt),
    },
  };
}

/**
 * Pure recovery gate for one stale in-routine escalation. It is intentionally
 * stricter than the alarm itself: only a known uncovered owner, a usable candidate,
 * and named failing tests may cause an automated re-dispatch. Attempts are bounded
 * so a broken launch path becomes a loud owner/fleet signal instead of a spawn loop.
 */
export function decideGreenCheckpointStallRecovery(opts: {
  mtimeMs: number | null;
  nowMs: number;
  ownershipCovered: boolean | null;
  candidate: string | null;
  failingTests: readonly string[];
  recoveryAttempts?: number;
  recoveryNotifiedAt?: number | null;
  staleMs?: number;
  maxAttempts?: number;
}): GreenCheckpointStallRecoveryDecision {
  const attempts = finiteNonNegativeInt(opts.recoveryAttempts, 0);
  const staleMs = Math.max(0, opts.staleMs ?? DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_STALE_MS);
  const maxAttempts = Math.max(
    1,
    finiteNonNegativeInt(opts.maxAttempts, DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_MAX_ATTEMPTS),
  );
  if (opts.mtimeMs == null || !Number.isFinite(opts.mtimeMs) || opts.nowMs - opts.mtimeMs <= staleMs) {
    return { action: 'none', reason: 'not-stale', nextAttempt: attempts };
  }
  if (opts.ownershipCovered !== false) {
    return { action: 'none', reason: 'covered', nextAttempt: attempts };
  }
  if (!opts.candidate || opts.failingTests.length === 0) {
    return { action: 'none', reason: 'invalid', nextAttempt: attempts };
  }
  if (attempts >= maxAttempts) {
    return {
      action: opts.recoveryNotifiedAt == null ? 'notify' : 'none',
      reason: 'max-attempts',
      nextAttempt: attempts,
    };
  }
  return { action: 'dispatch', reason: 'retry', nextAttempt: attempts + 1 };
}

/**
 * P-006 (WI-41755), ruled by D-006 — may a detected verdict-less death be met with an
 * AUTOMATIC gate re-fire?
 *
 * ## The whole point: detection does not authorize actuation
 *
 * `evaluateGreenStall().verdictless` says "the gate is firing and recording nothing".
 * The tempting next line is "so fire it again". D-006 forbids that, and the reason is
 * asymmetric cost: a re-fire that helps saves one human read, and a re-fire that does
 * not costs a ~55min full suite, holds the exclusive pc-heavy slot against every other
 * install, and renders NO verdict while doing it — so the burn is invisible to every
 * green/red signal. Repeat that on a timer and a single standing fault freezes
 * promotion fleet-wide while looking, to every dashboard, like silence.
 *
 * So the burden of proof sits on re-firing. Every gate below is a reason to DECLINE.
 *
 * ## Why `transient` is necessary but NOT sufficient — the measured part
 *
 * D-006 gates the re-fire on D-004's taxonomy: re-fire only a `transient` abort (nothing
 * latched, so a re-fire may genuinely finish), never a `standing-condition` (a named
 * blocker a re-fire hits again). That is correct and load-bearing, but it is not enough
 * on its own, and the live data says why.
 *
 * Measured 2026-08-26 across the active installs: five of them (calendar, hello-world-3,
 * hello-world-3-pot, hotel-reservations, oddsmith) sat at `inconclusive.status = 'error'`,
 * which `KIND_BY_STATUS` classifies — correctly — as `transient`. `'error'` means the run
 * faulted for an unrecorded reason and latched nothing, so there is genuinely no condition
 * to clear. But oddsmith had done it 530 consecutive times. Whatever that fault is, it is
 * perfectly reproducible, and "nothing to clear" plainly did not make it self-clearing.
 *
 * That is the gap between the two words D-004 is careful to separate: the taxonomy asks
 * *is there a condition to clear?* and re-firing needs the answer to *will waiting fix it?*
 * For a one-off crash those coincide. For a reproducible one they do not, and `transient`
 * answers the first question while the re-fire decision depends on the second.
 *
 * `reproduced` closes exactly that gap, empirically rather than by re-classifying: if the
 * abort status now on record is the SAME status the previous re-fire attempt already saw,
 * that attempt is a completed experiment and its result was "it happened again". Stop and
 * alarm. This is what keeps the oddsmith shape from spending the full attempt budget to
 * re-learn a fact the first attempt established.
 *
 * ## Ordering is part of the contract
 *
 * `ownerWallActive` is checked before anything can return `refire`, so "while the wall
 * stands this function cannot re-fire" is a property of the FUNCTION, provable in
 * isolation, not an emergent consequence of the classification arms below it. D-006's
 * last clause ("never auto-refire past the owner wall while D-080 stands") is a hard
 * prohibition, and a hard prohibition should not be reachable only by argument.
 *
 * Pure by design: every input is passed in and nothing is persisted here.
 *
 * ACTUATION STATUS (2026-08-31, gate-verdict-liveness-and-repair-reliability-2026-08-31
 * D-003): the advisory-only phase D-038 documented is over for the OPERATOR-HOME gate. The
 * sweep now wires `ownerWallActive` to the LIVE release checkpoint-config holds (see
 * readGateFireOwnerWall — either scope held, or an unreadable hold, reads as an active
 * wall) and, when this function returns `refire` for the home install, actually launches
 * the detached checkpoint, persisting the episode budget in
 * `gate_health.verdictlessRefire`. D-080 itself was a bounded ruling: it exhausted D-077's
 * ONE manual-run authority (2026-08-26) and required "newer explicit authority" for the
 * next transition — supplied by the owner's 2026-08-31 implement-start-to-finish directive
 * on the plan above. Re-walling is one owner call, no deploy:
 * `release:checkpoint-config { op:'hold', scope, governingRef }`. Non-home installs remain
 * advisory-only (their gates route to roots the launcher does not target).
 */
export type VerdictlessRefireAction = 'refire' | 'alarm' | 'none';

export type VerdictlessRefireReason =
  | 'not-verdictless'
  | 'owner-wall'
  | 'refire-in-flight'
  | 'unclassifiable'
  | 'not-transient'
  | 'reproduced'
  | 'max-attempts'
  | 'cooling-down'
  | 'transient-retry';

export interface VerdictlessRefireDecision {
  /** `refire` = safe to fire; `alarm` = a human must look; `none` = nothing to say yet. */
  action: VerdictlessRefireAction;
  reason: VerdictlessRefireReason;
  /** P-002: which detection axis engaged this decision — the verdict-less CLOCK
   *  (`evaluateGreenStall().verdictless`) or the P-003 verdict-RATE alarm. The clock wins
   *  the label when both fire. `null` on the nothing-detected early-out. */
  axis: 'verdictless-clock' | 'verdict-rate' | null;
  abortKind: GateAbortKind;
  abortStatus: string | null;
  /** the attempt number a `refire` would become; unchanged on every declining arm. */
  nextAttempt: number;
  /** one operator-facing sentence — the whole judgement, quotable into an alarm. */
  detail: string;
}

/**
 * D-006 actuation, second half (gate-verdict-liveness-and-repair-reliability-2026-08-31
 * D-003; supersedes the hardcoded `ownerWallActive: true` documented by
 * green-main-fast-2026-08-25 D-038). The owner wall is now a REAL signal: the release
 * checkpoint-config hold tokens. EITHER scope being held — 'qualification' (scheduled
 * admission) or 'manual-run' — reads as an active wall: an owner who has placed either
 * lever has withheld machine-initiated gate fires, and an automatic recovery must not
 * out-clever that. A FAILED read is an ACTIVE wall (fail-closed), for the same reason the
 * decision function defaults `ownerWallActive` to true. Re-arming the wall is one owner
 * call, no deploy: `release:checkpoint-config { op:'hold', scope, governingRef }`.
 */
export interface GateFireWall {
  active: boolean;
  detail: string | null;
}

export async function readGateFireOwnerWall(
  readQual: typeof readQualificationAdmission = readQualificationAdmission,
  readManual: typeof readManualRunAdmission = readManualRunAdmission,
): Promise<GateFireWall> {
  try {
    const [qual, manual] = await Promise.all([readQual(), readManual()]);
    if (qual.status === 'held') {
      return { active: true, detail: `qualification hold: ${qual.hold?.governingRef ?? 'unattributed'}` };
    }
    if (manual.status === 'held') {
      return { active: true, detail: `manual-run hold: ${manual.hold?.governingRef ?? 'unattributed'}` };
    }
    return { active: false, detail: null };
  } catch (e) {
    return {
      active: true,
      detail: `hold read failed (fail-closed): ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * The durable verdict-less refire EPISODE carried in `gate_health.verdictlessRefire`,
 * resolved against the newest recorded verdict: a verdict of ANY colour landing AFTER the
 * last refire attempt ends the episode, so the next verdict-less death starts a fresh
 * budget. This keeps the reset self-contained in the watchdog — no release-actions.ts hook
 * is needed, because `lastVerdictAtMs` is already in the sweep's row. Absent or malformed
 * state reads as a FRESH episode — never as spent budget.
 */
export interface VerdictlessRefireEpisode {
  attempts: number;
  lastAttemptStatus: string | null;
  lastAttemptAtMs: number | null;
}

export function resolveVerdictlessRefireEpisode(
  gh:
    | {
        verdictlessRefire?: {
          attempts?: number;
          lastAttemptStatus?: string | null;
          lastAttemptAtMs?: number | null;
        } | null;
      }
    | null
    | undefined,
  lastVerdictAtMs: number | null,
): VerdictlessRefireEpisode {
  const fresh: VerdictlessRefireEpisode = { attempts: 0, lastAttemptStatus: null, lastAttemptAtMs: null };
  const raw = gh?.verdictlessRefire;
  if (!raw || typeof raw !== 'object') return fresh;
  const attempts = Number(raw.attempts);
  const lastAttemptAtMs = Number(raw.lastAttemptAtMs);
  if (!Number.isFinite(attempts) || attempts <= 0 || !Number.isFinite(lastAttemptAtMs)) return fresh;
  if (lastVerdictAtMs != null && lastVerdictAtMs > lastAttemptAtMs) return fresh;
  return {
    attempts: Math.floor(attempts),
    lastAttemptStatus: typeof raw.lastAttemptStatus === 'string' ? raw.lastAttemptStatus : null,
    lastAttemptAtMs,
  };
}

/** Best-effort operator-home slug; null when the registry cannot answer (fail toward advisory). */
function safeOperatorHomeSlug(): string | null {
  try {
    return operatorHomeHarnessSlug();
  } catch {
    return null;
  }
}

/**
 * Minimum spacing between re-fire attempts. A full suite is ~55min, so this is deliberately
 * longer than one run: it means a second attempt can only happen after the first has had time
 * to either finish or die, never stacked on top of a run still in flight. `refireInFlight`
 * is the precise signal; this is the backstop for when we cannot see one.
 */
const DEFAULT_VERDICTLESS_REFIRE_COOLDOWN_MS = 90 * 60 * 1000;

export function decideVerdictlessRefire(opts: {
  /** `evaluateGreenStall().verdictless` — the detection this actuation hangs off. */
  verdictless: boolean;
  /** P-002 wiring: the P-003 verdict-RATE alarm axis — true when the no-verdict rate
   *  alarm is firing for this install. Engages the same bounded recovery: an abort stream
   *  with INTERMITTENT verdicts keeps resetting the verdict-less clock while most fires
   *  still render nothing, and the rate alarm is the axis that sees it. Every declining
   *  arm below (wall, in-flight, unclassifiable, reproduced, budget, cooldown) governs
   *  this axis identically — the alarm only changes what counts as a detection. */
  rateAlarmed?: boolean;
  /** `gate_health.inconclusive.status`, or null when the abort recorded no typed status. */
  abortStatus: string | null;
  /** true while an owner wall (D-080) forbids firing the gate. Fail-CLOSED: default true. */
  ownerWallActive?: boolean;
  /** true when a re-fire/re-triage for this install is already running. */
  refireInFlight?: boolean;
  /** attempts already spent this stall episode. */
  attempts?: number;
  /** the abort status the PREVIOUS attempt was fired against, if any. */
  lastAttemptStatus?: string | null;
  lastAttemptAtMs?: number | null;
  nowMs: number;
  maxAttempts?: number;
  cooldownMs?: number;
}): VerdictlessRefireDecision {
  const abortStatus = opts.abortStatus ?? null;
  const abortKind: GateAbortKind = abortStatus == null ? 'unknown' : classifyGateAbort(abortStatus);
  const attempts = finiteNonNegativeInt(opts.attempts, 0);
  const maxAttempts = Math.max(
    1,
    finiteNonNegativeInt(opts.maxAttempts, DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_MAX_ATTEMPTS),
  );
  // P-002: which axis detected the pathology. The clock wins the label when both fire —
  // it is the older, stricter signal — and the lead-in below keeps every detail sentence
  // honest when the clock is quiet but the rate alarm is what engaged.
  const axis: VerdictlessRefireDecision['axis'] = opts.verdictless
    ? 'verdictless-clock'
    : opts.rateAlarmed === true
      ? 'verdict-rate'
      : null;
  const base = { abortKind, abortStatus, nextAttempt: attempts, axis } as const;

  if (axis === null) {
    return {
      ...base,
      action: 'none',
      reason: 'not-verdictless',
      detail:
        'no verdict-less death detected and the verdict-rate alarm is quiet; nothing to re-fire.',
    };
  }
  const lead =
    axis === 'verdictless-clock'
      ? 'the gate died without a verdict'
      : 'the verdict-rate alarm is firing (most recent gate fires render no verdict)';

  // D-006's hard prohibition, checked FIRST so no arm below can reach `refire` past it.
  // Fail-closed: an unspecified wall is treated as standing, because the cost of wrongly
  // firing past an owner wall is far above the cost of wrongly declining to.
  if (opts.ownerWallActive !== false) {
    return {
      ...base,
      action: 'alarm',
      reason: 'owner-wall',
      detail:
        `${lead}, but an owner wall (D-080) forbids firing it — ` +
        'alarming instead. Clear the wall to allow automatic recovery.',
    };
  }

  if (opts.refireInFlight === true) {
    return {
      ...base,
      action: 'none',
      reason: 'refire-in-flight',
      detail: 'a re-fire is already running for this install; never stack a second onto it.',
    };
  }

  // D-006: "An UNCLASSIFIABLE abort is NOT transient. Default to alarm-and-stop."
  if (abortStatus == null || abortKind === 'unknown') {
    return {
      ...base,
      action: 'alarm',
      reason: 'unclassifiable',
      detail:
        `${lead} and the abort is unclassifiable (${abortStatus ?? 'no status recorded'}) — ` +
        'declining to re-fire. An unknown cause is not evidence of a transient one.',
    };
  }

  if (abortKind !== 'transient') {
    return {
      ...base,
      action: 'alarm',
      reason: 'not-transient',
      detail:
        `${lead} on a ${abortKind} abort (${abortStatus}) — re-firing hits the ` +
        'same wall, so this needs a human, not another suite.',
    };
  }

  // The empirical falsifier for "transient". See the measured oddsmith case above: a status
  // that latches nothing can still reproduce perfectly, and the previous attempt already
  // ran that experiment for us.
  if (attempts > 0 && opts.lastAttemptStatus != null && opts.lastAttemptStatus === abortStatus) {
    return {
      ...base,
      action: 'alarm',
      reason: 'reproduced',
      detail:
        `a re-fire was already attempted against this exact abort (${abortStatus}) and it happened again — ` +
        'so it is reproducible, not self-clearing. Stopping rather than spending the rest of the budget.',
    };
  }

  if (attempts >= maxAttempts) {
    return {
      ...base,
      action: 'alarm',
      reason: 'max-attempts',
      detail: `re-fire budget spent (${attempts}/${maxAttempts}) without a verdict — escalating to a human.`,
    };
  }

  const cooldownMs = Math.max(0, opts.cooldownMs ?? DEFAULT_VERDICTLESS_REFIRE_COOLDOWN_MS);
  const lastAttemptAtMs = finiteTimestamp(opts.lastAttemptAtMs);
  if (lastAttemptAtMs != null && opts.nowMs - lastAttemptAtMs < cooldownMs) {
    return {
      ...base,
      action: 'none',
      reason: 'cooling-down',
      detail: 'the previous re-fire is still within its cooldown; waiting rather than stacking runs.',
    };
  }

  return {
    ...base,
    action: 'refire',
    reason: 'transient-retry',
    nextAttempt: attempts + 1,
    detail:
      `${lead} on a transient abort (${abortStatus}) that has not yet repeated — ` +
      `re-firing (attempt ${attempts + 1}/${maxAttempts}).`,
  };
}

/** The bits of one green-checkpoint routine row the verdict is computed from. */
export interface GreenStallSnapshot {
  /** epoch ms of the routine's last fire (`last_fired_at`), or null if never fired. */
  lastFiredMs: number | null;
  /** epoch ms of the last green verdict (`gate_health.lastGreenAt`), or null. */
  lastGreenAt: number | null;
  /** the watchdog's own dedup flag (`gate_health.watchdogAlerted`). */
  watchdogAlerted: boolean;
  /**
   * P-006 (WI-41755): epoch ms of the newest recorded verdict of ANY kind (green OR red) —
   * the newest `pipeline_events` row of kind `green_checkpoint` for this install.
   *
   * Deliberately not `lastGreenAt`: a gate producing honest reds is WORKING, so keying the
   * verdict-less-death limb on greens would alarm on a healthy red streak. Optional so that
   * every existing constructor (and every test fixture) keeps compiling; absent ⇒ the limb
   * declines, matching the never-fired / fresh-install rule.
   */
  lastVerdictAtMs?: number | null;
  /** The root routine engine is stale; infra-liveness owns this root-cause alarm. */
  routineEngineStale?: boolean;
  /** EI-7505: the failing verdict test(s) from the last red green-checkpoint tick
   *  (`gate_health.failingTests`, threaded through by `trackGateStall` in
   *  release-actions.ts), when the stall is verdict-staleness (a failing suite)
   *  rather than fire-staleness (the routine engine not running). Absent/empty
   *  when the stall is fire-stale or the field predates this fix. */
  failingTests?: string[];
  /** EI-20378004056924553: the per-root checkpoint run-lock was held by a live process when
   *  the phase marker was read. A missing value is UNKNOWN and must not suppress an alarm. */
  checkpointRunActive?: boolean;
  /** EI-20378004056924553: the run's published phase, when its marker was readable. Only an
   *  active `delivering` phase is a suppression; missing/unreadable phase fails open. */
  checkpointRunPhase?: string | null;
}

export interface GreenStallVerdict {
  stalled: boolean;
  /** the routine is active but hasn't fired in fireStaleMs (the scheduler is wedged). */
  fireStale: boolean;
  /** no green verdict in noGreenMs (the deep backstop). */
  verdictStale: boolean;
  /**
   * P-006 (WI-41755): the routine is FIRING but has recorded no verdict of ANY kind in
   * `verdictlessMs` — every run is dying before it writes one.
   *
   * ⚠ Distinct from `verdictStale`, and the two must not be collapsed: `verdictStale` means
   * "no GREEN in 12h", which a gate producing honest reds satisfies while working perfectly.
   * This means "no verdict AT ALL", which no working gate ever satisfies. It is also the only
   * limb that can fire while `fireStale` is false — which is the whole point, because a gate
   * whose every run dies keeps updating `last_fired_at` and so looks healthy to that limb.
   */
  verdictless: boolean;
  /**
   * P-016: this pass DECLINED TO JUDGE — the root routine engine is stale, so
   * infra-liveness owns the root-cause alarm and this symptom-level one is
   * deliberately muted (EI-2994).
   *
   * ⚠ `suppressed` is NOT `!stalled`, and collapsing the two is the defect this
   * field exists to end. Both render `stalled: false`, but they mean opposite
   * things: healthy means "I looked and the gate is fine", suppressed means "I
   * did not look". Treating suppressed as healthy makes the watchdog broadcast
   * `green-checkpoint RECOVERED — the gate is producing verdicts again` off a
   * code path that explicitly refused to evaluate whether the gate is producing
   * verdicts. It is a false all-clear, and because engine staleness flickers
   * around its own threshold on a loaded box it emits one on every flicker —
   * which is how STALLED/RECOVERED alternated several times inside one window
   * on oddsmith. Read this field before taking the recovery branch.
   */
  suppressed: boolean;
  /** human reason for the alarm body, or null when not stalled. */
  reason: string | null;
}

const hrs = (ms: number): number => Math.round(ms / 3_600_000);

/**
 * Pure: decide whether one ACTIVE green-checkpoint routine is in a silent stall
 * the in-routine detector cannot see. Exported for unit testing (the DB wiring
 * around it is integration-covered, like the reaper's live self-test).
 *
 * A never-fired routine (`lastFiredMs === null` with no `lastGreenAt`) is a fresh
 * install — no evidence it SHOULD have greened — and never alarms.
 */
export function evaluateGreenStall(
  s: GreenStallSnapshot,
  now: number,
  opts: GreenStallThresholds = {},
): GreenStallVerdict {
  const fireStaleMs = opts.fireStaleMs ?? DEFAULT_FIRE_STALE_MS;
  const noGreenMs = opts.noGreenMs ?? DEFAULT_NO_GREEN_MS;

  // EI-2994: when the root DBOS routinesTick is stale, green-checkpoint not
  // firing is a downstream symptom. The request-path infra-liveness alarm owns
  // the single "background routine engine frozen" escalation and auto-resolves
  // it; suppress this symptom-level alarm to avoid a restart cascade being
  // triaged as independent release failures. Unknown liveness is fail-open.
  const rootEngineStale = s.routineEngineStale === true;
  // EI-20378004056924553: partial-green salvage publishes `delivering` only after
  // the suite has completed and while the run is still actively publishing its
  // bounded result. That phase is a real in-flight run, not evidence of a silent
  // gate. Suppress only on the exact pair; a stale marker, missing lock, unknown
  // route, or any other phase must fail open to the ordinary stall verdict.
  const checkpointRunDelivering =
    s.checkpointRunActive === true && s.checkpointRunPhase === 'delivering';
  const suppressed = rootEngineStale || checkpointRunDelivering;
  const fireStale = !suppressed && s.lastFiredMs != null && now - s.lastFiredMs > fireStaleMs;
  const verdictStale = !suppressed && s.lastGreenAt != null && now - s.lastGreenAt > noGreenMs;
  /**
   * P-006 (WI-41755): the gate is FIRING but has recorded no verdict of any kind — every run
   * is dying before it can write one.
   *
   * This limb exists because the other two structurally cannot see that failure:
   *   · `fireStale` asks whether the routine FIRED. In a verdict-less death it fires fine —
   *     `last_fired_at` updates on every hourly tick — so this stays false forever.
   *   · `verdictStale` keys on `lastGreenAt`, so it waits out DEFAULT_NO_GREEN_MS (12h) before
   *     saying anything, and a gate that greened two hours ago and has been dying ever since
   *     is silent for the rest of that window.
   * Between them a dead gate can run unreported for up to 12h — which is the shape of the
   * 2026-08-02 647-minute incident.
   *
   * Keyed on ANY verdict (green OR red), never on greens: a gate legitimately producing reds
   * is WORKING, and must not trip this. Measured 2026-08-25 across 10 installs, a healthy gate
   * records a verdict every ~45min, so the 3h window sits >3x above the healthy interval.
   *
   * Requires `lastVerdictAtMs != null`: with no verdict ever recorded there is no reference
   * point to measure a silent window against, and a fresh install must not alarm (same rule
   * the never-fired case follows above).
   */
  const verdictlessMs = opts.verdictlessMs ?? DEFAULT_VERDICTLESS_GRACE_MS;
  const verdictless =
    !suppressed &&
    !fireStale &&
    s.lastFiredMs != null &&
    s.lastVerdictAtMs != null &&
    now - s.lastVerdictAtMs > verdictlessMs;
  const stalled = fireStale || verdictStale || verdictless;

  let reason: string | null = null;
  if (stalled) {
    const parts: string[] = [];
    if (fireStale && s.lastFiredMs != null) {
      parts.push(
        `the routine has not FIRED in ~${hrs(now - s.lastFiredMs)}h (active, cron hourly) — the routine scheduler/engine is not running it`,
      );
    }
    if (verdictStale && s.lastGreenAt != null) {
      parts.push(`no GREEN verdict in ~${hrs(now - s.lastGreenAt)}h`);
    }
    if (verdictless && s.lastVerdictAtMs != null) {
      parts.push(
        `the routine is FIRING but has recorded NO verdict (green or red) in ~${hrs(now - s.lastVerdictAtMs)}h — ` +
          `every run is dying before it can write one. This is NOT a failing suite and NOT a red: no verdict about the code exists`,
      );
    }
    reason = parts.join('; ');
    // EI-7505: name the failing test(s) directly in the alarm reason so a
    // responder doesn't have to hand-spelunk harness_shared.test_runs (which
    // mixes every agent's local dev-test runs with the verdict run and is
    // inconclusive) just to start diagnosing a verdict-staleness stall.
    const tests = (s.failingTests ?? []).slice(0, 20);
    if (tests.length) {
      reason += `. Failing verdict test(s): ${tests.slice(0, 5).join(', ')}${tests.length > 5 ? ` (+${tests.length - 5} more)` : ''}`;
    }
  }
  return { stalled, fireStale, verdictStale, verdictless, suppressed, reason };
}

/** Pure: the `harness_escalations` body for a watchdog-detected stall (testable). */
export function greenStallEscalationBody(opts: {
  installSlug: string;
  verdict: GreenStallVerdict;
  lastFiredMs: number | null;
  lastGreenAt: number | null;
  nowMs: number;
  /** EI-7505: gate_health.failingTests, when available (verdict-staleness only). */
  failingTests?: string[];
}): string {
  return JSON.stringify({
    kind: WATCHDOG_KIND,
    harness_slug: opts.installSlug,
    fireStale: opts.verdict.fireStale,
    verdictStale: opts.verdict.verdictStale,
    lastFiredAt: opts.lastFiredMs != null ? new Date(opts.lastFiredMs).toISOString() : null,
    lastGreenAt: opts.lastGreenAt != null ? new Date(opts.lastGreenAt).toISOString() : null,
    failingTests: (opts.failingTests ?? []).slice(0, 20),
    emitted_at: opts.nowMs,
    // `verdict.reason` already carries the failing-test suffix (EI-7505) when present.
    detail: `green-checkpoint silent stall (watchdog): ${opts.verdict.reason}. ` +
      `\`main\` is frozen and the in-routine stall detector cannot see this (it runs only when the routine fires). ` +
      `The dead-executor reaper should auto-recover a wedge; if this persists the bg-host / DBOS engine needs a look.`,
  });
}

// ── verdict-stale ATTRIBUTION (WI-39704) ──────────────────────────────────────

/**
 * WI-39704: what this alarm said about a verdict-staleness stall used to be a GUESS
 * dressed as a finding. `verdictStale` measures exactly ONE thing — no green verdict in
 * 12h — and the broadcast then asserted the cause: "verdict-staleness ⇒ a failing suite.
 * release:checkpoint-run forces a fresh gate run." That inference is wrong for every
 * stall whose gate never reached the tests, and wrong in the most expensive direction:
 * it sends each reader hunting failing tests that do not exist, and its remedy costs a
 * full ~55min suite that then dies exactly where the last one did.
 *
 * Measured on oddsmith 2026-08-17: the gate fired hourly on schedule, the suite PASSED,
 * and every run died in the publish step — `git push origin <sha>:refs/heads/main exited
 * 128: fatal: could not read Username for 'https://github.com'` (a missing push
 * credential, WI-39549). gate_health recorded 359 consecutive "reds" with
 * `failingTests: []`; the alarm said "no green verdicts … a failing suite"; WI-39671
 * spent an entire investigation establishing that the tests were fine — and then the
 * condition singleton re-minted the identical alarm (WI-39704) 34 seconds after that
 * item closed, primed to cost the next reader the same investigation.
 *
 * The datum was never missing. The run's own pipeline_event already records
 * `crashed: true` and the thrown error's text; it simply never reached the alarm. That
 * is the same defect WI-38340 fixed two functions down in this very file — an alarm
 * that misstates its own trigger sends the reader after a wedged gate that is running
 * fine — so this extends that convention rather than inventing one.
 *
 * ⚠ This deliberately does NOT suppress the alarm. Deploys really are frozen; that half
 * was always true. It changes only WHICH of the alarm's several possible causes it
 * claims, and makes it QUOTE the evidence instead of inferring from it.
 */
export interface LastGateRunEvidence {
  /** the run crashed before rendering a verdict (`CheckpointResult.crashed`). */
  crashed: boolean;
  /** the suite verdict the run rendered — or null when it never rendered one, which is
   *  what `buildCrashCheckpointResult` writes (EI-20702428259478130: `null`, not `false`,
   *  precisely so "no verdict exists" cannot be read as "the code is RED"). */
  green: boolean | null;
  /** FIRST line of the crash summary — the fault itself, QUOTED, never pattern-matched.
   *  The later stack frames are noise to a responder; the first line is the blocker. */
  firstLine: string | null;
  candidate: string | null;
  observedAt: string | null;
}

/**
 * Read the newest green_checkpoint verdict this install recorded. Fail-soft by design
 * (any error ⇒ null): this only ENRICHES an alarm that is already firing, so a read
 * problem must degrade the alarm's wording, never suppress or break the alarm itself.
 */
export async function readLastGateRunEvidence(
  sql: Sql,
  installSlug: string,
): Promise<LastGateRunEvidence | null> {
  try {
    const rows = await sql<
      {
        detail: {
          crashed?: unknown;
          green?: unknown;
          summary?: unknown;
          candidate?: unknown;
        } | null;
        created_at: Date | string | null;
      }[]
    >`
      SELECT detail, created_at
        FROM harness_shared.pipeline_events
       WHERE install_slug = ${installSlug}
         AND kind = 'green_checkpoint'
       ORDER BY created_at DESC
       LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    const d = row.detail ?? {};
    const summary = typeof d.summary === 'string' ? d.summary : null;
    const firstLine = summary ? (summary.split('\n')[0] ?? '').trim().slice(0, 400) : null;
    let observedAt: string | null = null;
    if (row.created_at != null) {
      const t = new Date(row.created_at as string | Date);
      observedAt = Number.isNaN(t.getTime()) ? null : t.toISOString();
    }
    return {
      crashed: d.crashed === true,
      green: typeof d.green === 'boolean' ? d.green : null,
      firstLine: firstLine || null,
      candidate: typeof d.candidate === 'string' ? d.candidate.slice(0, 12) : null,
      observedAt,
    };
  } catch {
    return null;
  }
}

/**
 * P-006 (WI-41755). How long after a fire a verdict must exist before its ABSENCE is
 * itself the alarm.
 *
 * Tied deliberately to `SELF_WATCHDOG_MS` in apps/operator/lib/release/green-checkpoint.ts
 * (3h), which is the gate's OWN maximum lifetime for a single run: past it the run kills
 * itself. So a fire older than this window has, by the gate's own rule, either produced a
 * verdict or died — which makes "fired, and still nothing on record" a statement about a
 * DEAD run rather than a slow one. Picking any smaller number would alarm on runs that are
 * legitimately still working.
 *
 * `operator-core` must not import from `apps/operator` (wrong layering direction), so this
 * is a second copy of that constant — and a second copy of a truth the code owns is exactly
 * what drifts. It is therefore PINNED by `doc-claims/verdictless-death-grace.test.ts`, which
 * reads the real `SELF_WATCHDOG_MS` out of green-checkpoint.ts and fails the build if the two
 * diverge. Do not hand-maintain this number; change it there and let the pin force it here.
 */
export const DEFAULT_VERDICTLESS_GRACE_MS = 3 * 60 * 60 * 1000;

export interface VerdictlessDeathVerdict {
  /** the fire produced NO record at all, and the grace window has passed. */
  verdictless: boolean;
  /**
   * Which observation supports it — never a guess:
   *   'no-evidence-at-all'     — the ledger holds no run for this install.
   *   'evidence-predates-fire' — the newest run on record is OLDER than the last fire,
   *                              so the fire itself left nothing.
   */
  reason: 'no-evidence-at-all' | 'evidence-predates-fire' | null;
  /** ms by which the newest evidence PREDATES the last fire (null when not applicable). */
  evidencePredatesFireByMs: number | null;
}

/**
 * Pure: did the last fire die WITHOUT recording any verdict?
 *
 * This is the gap that let two verdict-less deaths pass unattributed on 2026-08-25 (a gate
 * run that exited 74 having executed zero tests, and a verification run SIGTERM'd mid-flight).
 * `readLastGateRunEvidence` takes the newest green_checkpoint event with NO time bound, and
 * `attributeVerdictStale` then narrates that row as though it described the current run. When
 * the current run left no row, the newest row is an EARLIER run — so the alarm confidently
 * explains the stall with a cause that belongs to a different run, and points the responder
 * at that run's failing files. `observedAt` was already being read; it was only ever used to
 * format a display string, never compared to anything.
 *
 * Conservative in every ambiguous direction — it declines to claim a verdict-less death when
 * it cannot prove one, because a false "the run vanished" sends a responder hunting a corpse
 * that does not exist:
 *   - never fired            ⇒ no, nothing was expected.
 *   - inside the grace window ⇒ no, the run may legitimately still be working. (UNKNOWN, and
 *                              deliberately silent, rather than alarming on a slow suite.)
 *   - evidence with no usable timestamp ⇒ no; let the existing branches narrate it.
 *   - evidence NEWER than the fire      ⇒ no; that fire did produce this record.
 */
export function judgeVerdictlessDeath(opts: {
  last: LastGateRunEvidence | null;
  lastFiredMs: number | null;
  now: number;
  graceMs?: number;
}): VerdictlessDeathVerdict {
  const { last, lastFiredMs, now } = opts;
  const graceMs = opts.graceMs ?? DEFAULT_VERDICTLESS_GRACE_MS;
  const none: VerdictlessDeathVerdict = {
    verdictless: false,
    reason: null,
    evidencePredatesFireByMs: null,
  };

  // Never fired ⇒ no verdict was ever owed.
  if (lastFiredMs == null || !Number.isFinite(lastFiredMs)) return none;
  // Still inside the window where a live run could legitimately not have finished.
  if (now - lastFiredMs <= graceMs) return none;

  if (last == null) {
    return { verdictless: true, reason: 'no-evidence-at-all', evidencePredatesFireByMs: null };
  }

  // A row we cannot date cannot be compared. Stay silent rather than guess.
  if (!last.observedAt) return none;
  const observedMs = new Date(last.observedAt).getTime();
  if (Number.isNaN(observedMs)) return none;

  if (observedMs < lastFiredMs) {
    return {
      verdictless: true,
      reason: 'evidence-predates-fire',
      evidencePredatesFireByMs: lastFiredMs - observedMs,
    };
  }
  return none;
}

const durationMs = (ms: number): string => {
  if (ms >= 3_600_000) return `~${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `~${Math.round(ms / 60_000)}m`;
  return `~${Math.round(ms / 1000)}s`;
};

/**
 * Pure: given what the ledger actually recorded, say which cause of "no green verdict"
 * was OBSERVED — and give the remedy that matches THAT cause. Exported for unit testing,
 * matching the `evaluateGreenStall` / `mainBehindRecoverySummary` convention in this file.
 *
 * The ordering is by strength of evidence, not by likelihood:
 *   1. named failing tests  — the only branch entitled to say "a failing suite".
 *   2. a VERDICT-LESS DEATH — the fire left no record at all, so branches 3-5 would be
 *                             narrating an EARLIER run's cause as if it were this one.
 *                             Must precede them for exactly that reason (P-006/WI-41755).
 *   3. a crash              — the gate never reached a verdict; zero tests are implicated.
 *   4. a red with no test   — a real red the gate could not attribute; say so rather than
 *                             implying a test list exists to go fix.
 *   5. anything else / no run on record — state the gap instead of filling it with a guess.
 *
 * Branch 1 stays above branch 2 because `failingTests` is independently sourced
 * (`gate_health.failingTests`, threaded by `trackGateStall`) and names concrete tests to go
 * fix — actionable regardless of which run recorded them.
 */
export function attributeVerdictStale(opts: {
  failingTests: string[];
  last: LastGateRunEvidence | null;
  /**
   * Epoch ms of the routine's last fire. Supplying it enables the verdict-less-death branch;
   * OMITTING it skips that branch entirely (preserving the pre-P-006 behaviour), because
   * without a fire time there is nothing to compare the evidence's age against.
   */
  lastFiredMs?: number | null;
  now?: number;
  graceMs?: number;
}): { summary: string; cause: string; remedy: string } {
  const { failingTests, last } = opts;
  const when = last?.observedAt ? ` at ${last.observedAt}` : '';
  const cand = last?.candidate ? ` (candidate ${last.candidate})` : '';

  if (failingTests.length > 0) {
    return {
      summary: 'no green verdicts; deploys frozen (a failing suite).',
      cause: `The last verdict named ${failingTests.length} failing test(s), so this IS a failing suite.`,
      remedy: 'Fix the named test(s), then release:checkpoint-run for a fresh verdict.',
    };
  }

  const verdictless =
    opts.lastFiredMs !== undefined
      ? judgeVerdictlessDeath({
          last,
          lastFiredMs: opts.lastFiredMs,
          now: opts.now ?? Date.now(),
          graceMs: opts.graceMs,
        })
      : null;

  if (verdictless?.verdictless) {
    const firedAt =
      opts.lastFiredMs != null ? new Date(opts.lastFiredMs).toISOString() : '(unknown)';
    const gap =
      verdictless.evidencePredatesFireByMs != null
        ? ` — ${durationMs(verdictless.evidencePredatesFireByMs)} BEFORE it`
        : '';
    const evidence =
      verdictless.reason === 'no-evidence-at-all'
        ? 'no green-checkpoint run is on record for this install at all'
        : `the newest run on record is from ${last?.observedAt ?? '(undated)'}${gap}${cand}`;
    return {
      summary:
        'deploys frozen — the gate FIRED but left NO verdict on record. This is NOT a failing suite and NOT a red.',
      cause:
        `⚠ VERDICT-LESS DEATH — the gate fired at ${firedAt}, but ${evidence}. ` +
        `So the run that fired recorded NOTHING: it died before it could write a verdict (a kill, an OOM, a host restart, ` +
        `a crash upstream of the reporting step). ZERO tests are implicated, and no verdict about the code exists. ` +
        `A crash that DOES manage to render a verdict is reported separately and names its own fault; this branch is the case where nothing was written at all.`,
      remedy:
        '⛔ Do NOT fix tests, and do NOT read the newest run on record for failing files — it describes a DIFFERENT, EARLIER run, and treating it as this one sends you to fix code that no run tonight ever executed. ' +
        'Find why the process died without recording: read the run-lock phase marker and the self-watchdog ARM marker written beside it (`writeSelfWatchdogArmMarker`, WI-7069) to tell "never armed" from "armed but never fired", then the host/unit logs for the fire window. ' +
        'Re-firing before you know that costs a full suite and, if the cause is environmental, dies at the same step.',
    };
  }

  if (last?.crashed) {
    return {
      summary:
        'deploys frozen — the gate\'s last run CRASHED before rendering a verdict, naming NO failing test. This is NOT a failing suite.',
      cause:
        `⚠ NOT a failing suite — the gate's last run${cand}${when} CRASHED before rendering a verdict and named ZERO failing tests. ` +
        `The crash: ${last.firstLine ?? '(no summary was recorded)'}`,
      remedy:
        'Fix THAT, not the tests. Do NOT reflexively fire release:checkpoint-run — a fresh run costs a full suite (~55min) and then dies at the same step. ' +
        'A crash inside a `git push` to origin means the CODE IS FINE and the PUBLISH step is blocked (credential / remote), which no amount of test-fixing reaches. ' +
        "Confirm from the run's own trailer: `grep -o 'GATE_PROMOTION candidate=.*' <run log> | tail -1` — `green=true promoted=false` names the step that blocked it.",
    };
  }

  if (last && last.green === false) {
    return {
      summary: 'no green verdicts; deploys frozen (last verdict RED, but it named no failing test).',
      cause: `The last run${cand}${when} rendered a RED verdict but named no failing test — an unattributable red.`,
      remedy:
        "Read that run's own record before re-firing: its AFFECTED_TESTS_FAILING_FILES line names the failing files (read `coverage` first — `files=[]` means \"not attributable\", NOT \"nothing failed\").",
    };
  }

  if (last) {
    return {
      summary: 'no green verdicts; deploys frozen (the last run recorded no green, and named no failing test).',
      cause:
        `The last run${cand}${when} recorded green=${String(last.green)} and named no failing test, yet no green verdict has landed in the window.`,
      remedy:
        "Read that run's own record before re-firing — a verdict that did not COUNT (held, superseded, or green-but-not-promoted) reads here as \"no green\" while the tests are fine.",
    };
  }

  return {
    summary: 'no green verdicts; deploys frozen (no run on record to attribute it to).',
    cause:
      'No green-checkpoint run is on record for this install, so the cause of the missing green cannot be attributed from the ledger.',
    remedy:
      'Check whether the routine is firing at all (fire-staleness is reported separately above), then release:checkpoint-run for a fresh verdict.',
  };
}

export interface GreenStallWatchdogResult {
  /** install slugs that crossed into a stall this pass (one-shot, deduped). */
  alarmed: string[];
  /** install slugs whose prior stall recovered this pass. */
  recovered: string[];
  /**
   * P-016: install slugs this pass DECLINED TO JUDGE because the root routine
   * engine is stale — muted, not healthy, and deliberately absent from both
   * `alarmed` and `recovered`. Reported so a mute is OBSERVABLE: previously a
   * suppressed pass was indistinguishable from a recovery in this result, which
   * is the same conflation the `suppressed` verdict field exists to end.
   */
  suppressed: string[];
}

export type AbandonedCheckpointAwaitWakeResult =
  | { status: 'not-abandoned'; reason: string }
  | { status: 'emit-failed'; candidate: string }
  | { status: 'dedup-clear-failed'; candidate: string }
  | { status: 'woken'; candidate: string; markerCleared: boolean };

interface AbandonedCheckpointAwaitWakeDeps {
  nowMs?: number;
  selfPid?: number;
  pidAlive?: (pid: number) => boolean | null;
  recordLostRun?: typeof recordLostGateRun;
  clearIfUnchanged?: typeof clearInFlightCandidateIfUnchanged;
  dbosSql?: Sql;
  emit?: (opts: EmitAwaitedEventOpts) => Promise<unknown>;
}

/**
 * WI-6989: wake checkpoint waiters when a published run process disappears before
 * producing any verdict.
 *
 * Managed SIGTERM/SIGINT, fatal exceptions and the in-process self-watchdog already
 * publish the normal `green-checkpoint:inconclusive` outcome. A hard loss (SIGKILL,
 * OOM, host-generation replacement) cannot run that finalizer; its durable
 * `inFlightCandidate` marker is the independent witness. Reuse the SAME inconclusive
 * keys `checkpoint:await` already arms rather than inventing an abort subscription.
 * An unfiltered await matches the payload immediately, while a candidate-bound await
 * matches the dead sha. Sibling cancellation retires the other green/red/held rows in
 * that same registration group.
 *
 * The marker is cleared only AFTER both emits succeed, and only if its generation is
 * unchanged. An emit failure therefore leaves evidence for the next 15-minute watchdog
 * pass to retry; a concurrent replacement run is never erased.
 */
export async function wakeAbandonedCheckpointAwaits(
  input: { installSlug: string; workspaceId: string; rawMarker: unknown },
  deps: AbandonedCheckpointAwaitWakeDeps = {},
): Promise<AbandonedCheckpointAwaitWakeResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const marker = parseInFlightCandidate(input.rawMarker, nowMs);
  if (!marker) return { status: 'not-abandoned', reason: 'no-current-marker' };

  const verdict = judgeAbandonedInFlightCandidate(marker, {
    selfPid: deps.selfPid ?? process.pid,
    pidAlive: (deps.pidAlive ?? isPidAlive)(marker.pid),
    nowMs,
  });
  if (!verdict.abandoned) return { status: 'not-abandoned', reason: verdict.reason };

  const target = { installSlug: input.installSlug, workspaceId: input.workspaceId };
  const summary = describeAbandonedInFlightCandidate(verdict) ??
    `Checkpoint run for ${marker.candidate.slice(0, 12)} disappeared without a verdict.`;
  const recordLostRun = deps.recordLostRun ?? recordLostGateRun;
  if (marker.routineId && marker.routineFireWorkflowId) {
    if (!deps.dbosSql) {
      console.warn(
        `[green-stall-watchdog] abandoned checkpoint DBOS pin not cleared for ${input.installSlug}: SQL transaction unavailable (will retry)`,
      );
      return { status: 'dedup-clear-failed', candidate: marker.candidate };
    }
    try {
      await deps.dbosSql.begin(async (transaction) => {
        // Lost-run evidence and release of the exact DBOS pin are one state transition. If either
        // write fails, rollback both and leave the marker for the next watchdog pass.
        await recordLostRun(target, verdict, process.pid, transaction);
        const { clearAbandonedCheckpointRoutineFire } = await import('../dbos/dbos-executor-reaper');
        await clearAbandonedCheckpointRoutineFire(transaction, {
          installSlug: input.installSlug,
          workspaceId: input.workspaceId,
          routineId: marker.routineId!,
          workflowId: marker.routineFireWorkflowId!,
          observedAtMs: marker.observedAtMs,
        });
      });
    } catch (error) {
      console.warn(
        `[green-stall-watchdog] abandoned checkpoint lost-run/dedup transaction failed for ${input.installSlug} (will retry): ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: 'dedup-clear-failed', candidate: marker.candidate };
    }
  } else {
    try {
      await recordLostRun(target, verdict);
    } catch (error) {
      // Legacy/manual markers lack a DBOS row identity; keep their historical best-effort wake.
      console.warn(
        `[green-stall-watchdog] abandoned checkpoint record failed for ${input.installSlug} (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const eventPayload = {
    sha: marker.candidate,
    from: marker.base,
    pipeline: input.installSlug,
    candidateSource: marker.candidateSource,
    reason: 'process-disappeared',
    summary,
    runId: null,
  };
  const params = (pipeline?: string) => ({ pipeline });
  const inconclusiveKeys = [
    buildKey('checkpoint-inconclusive', params()),
    buildKey('checkpoint-inconclusive', params(input.installSlug)),
  ];
  const siblingKeys = [
    buildKey('checkpoint', params()),
    buildKey('checkpoint', params(input.installSlug)),
    buildKey('checkpoint-red', params()),
    buildKey('checkpoint-red', params(input.installSlug)),
    buildKey('checkpoint-held', params()),
    buildKey('checkpoint-held', params(input.installSlug)),
  ];
  const emit =
    deps.emit ??
    (async (opts: EmitAwaitedEventOpts) => {
      const { emitAwaitedEvent } = await import('../events/await/engine');
      return emitAwaitedEvent(opts);
    });
  try {
    for (const key of inconclusiveKeys) {
      await emit({
        key,
        summary,
        payload: eventPayload,
        source: 'green-stall-watchdog:abandoned-checkpoint',
        cancelSiblingKeysFor: siblingKeys,
      });
    }
  } catch (error) {
    console.warn(
      `[green-stall-watchdog] abandoned checkpoint wake failed for ${input.installSlug} (will retry): ${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: 'emit-failed', candidate: marker.candidate };
  }

  const markerCleared = await (deps.clearIfUnchanged ?? clearInFlightCandidateIfUnchanged)(target, marker);
  return { status: 'woken', candidate: marker.candidate, markerCleared };
}

/**
 * Resolve and read the checkpoint run state for one routine row.
 *
 * The watchdog runs in the operator process, while a subject hive's run-lock
 * lives under that hive's routed integration root and log directory. Keep the
 * routing and both cheap reads together so this path cannot accidentally inspect
 * the operator-home lock for every hive. Any routing/read uncertainty is UNKNOWN
 * and returns an empty partial snapshot: evaluateGreenStall deliberately fails
 * open unless it can prove both a live lock and the exact `delivering` phase.
 */
async function readCheckpointRunState(
  installSlug: string,
  workspaceId: string,
): Promise<Pick<GreenStallSnapshot, 'checkpointRunActive' | 'checkpointRunPhase'>> {
  try {
    const routing = await resolveCheckpointRouting({ installSlug, workspaceId }, integrationRoot());
    if (routing.skip) return {};

    const root = routing.extraEnv.PAPERCUSP_INTEGRATION_ROOT ?? routing.root;
    const checkpointLogDir = routing.extraEnv.PAPERCUSP_CHECKPOINT_LOG_DIR;
    const lock = isCheckpointRunLockHeldCheap(root, undefined, undefined, undefined, checkpointLogDir);
    const phase = readCheckpointRunPhaseCheap(root, checkpointLogDir)?.phase ?? null;
    return { checkpointRunActive: lock.held, checkpointRunPhase: phase };
  } catch (error) {
    // The alert must remain useful when registry/routing state is temporarily
    // unreadable. Unknown is not "no run": it simply cannot suppress a stall.
    console.warn(
      `[green-stall-watchdog] checkpoint run state unavailable for '${installSlug}'; fail-open: ${error instanceof Error ? error.message : error}`,
    );
    return {};
  }
}

type GreenCheckpointStallEscalationRow = {
  harness_slug: string;
  workspace_id: string;
  escalation: unknown;
  mtime_ms: string | number | null;
};

const GREEN_CHECKPOINT_STALL_PHASE = 'green-checkpoint-stall';

const recoveryBody = (
  parsed: GreenCheckpointStallEscalation,
  recovery: GreenCheckpointStallRecoveryMarker,
): string => JSON.stringify({ ...parsed.raw, recovery });

/**
 * Deliver the owner/fleet signal for a recovery that could not make progress.
 * The escalation row is already the durable evidence; these two rails are best-effort
 * and deliberately one-shot via the recovery marker in that row.
 */
async function notifyGreenCheckpointStallRecovery(opts: {
  installSlug: string;
  workspaceId: string;
  candidate: string;
  failingTests: readonly string[];
  checkpointEvidence: CheckpointEvidence | null;
  attempts: number;
  reason: 'no-progress' | 'max-attempts';
}): Promise<void> {
  const title = `green-checkpoint-stall recovery blocked on ${opts.installSlug}`;
  const body =
    `The green-checkpoint-stall escalation for ${opts.installSlug} remains stale and uncovered ` +
    `(candidate ${opts.candidate.slice(0, 12)}; recovery attempts: ${opts.attempts}). ` +
    `${opts.reason === 'max-attempts' ? 'The bounded release-fixer retry budget is exhausted.' : 'A release-fixer dispatch made no progress.'} ` +
    `Named failing test(s): ${opts.failingTests.slice(0, 5).join(', ')}. ` +
    (opts.checkpointEvidence?.logPath
      ? `Exact checkpoint log: ${opts.checkpointEvidence.logPath}. `
      : '') +
    `Inspect the gate row and release-fixer liveness before taking further action.`;
  const fleetSlug = (process.env.PAPERCUSP_FLEET_SLUG ?? '').trim();
  const route = fleetSlug
    ? {
        ownerSelector: `@fleet-leader:${fleetSlug}`,
        reason: `green-checkpoint-stall recovery for ${opts.installSlug} needs fleet-leader attention`,
      }
    : undefined;

  try {
    const { notifyAttention } = await import('../attention-notify');
    await notifyAttention({
      kind: 'intervention',
      title,
      body,
      importance: 'urgent',
      workspaceId: opts.workspaceId,
      data: {
        installSlug: opts.installSlug,
        candidate: opts.candidate.slice(0, 12),
        failingTests: opts.failingTests.slice(0, 20),
        ...(opts.checkpointEvidence ? { checkpointEvidence: opts.checkpointEvidence } : {}),
        attempts: opts.attempts,
        reason: opts.reason,
      },
    });
  } catch (e) {
    console.warn(`[green-stall-watchdog] recovery notify failed: ${e instanceof Error ? e.message : e}`);
  }

  try {
    await broadcastSevereEvent({
      summary: title,
      body,
      category: 'severe-event',
      conditionKey: `green-checkpoint-stall-recovery:${opts.installSlug}`,
      oneShot: true,
      ...(route ? { route } : {}),
    });
  } catch (e) {
    console.warn(`[green-stall-watchdog] recovery broadcast failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Revisit old in-routine stall rows independently of a fresh checkpoint verdict.
 * `trackGateStall` records the exact red signature, but its normal dispatcher only
 * runs while a verdict is being produced; this sweep closes that silent gap.
 */
async function recoverStaleGreenCheckpointStalls(
  sql: Sql,
  nowMs: number,
  opts: GreenStallThresholds,
): Promise<void> {
  let rows: GreenCheckpointStallEscalationRow[];
  try {
    rows = await sql<GreenCheckpointStallEscalationRow[]>`
      SELECT harness_slug, workspace_id, escalation, mtime_ms
        FROM harness_shared.harness_escalations
       WHERE phase = ${GREEN_CHECKPOINT_STALL_PHASE}
         AND escalation IS NOT NULL`;
  } catch (e) {
    console.warn(`[green-stall-watchdog] green-checkpoint-stall recovery scan failed: ${e instanceof Error ? e.message : e}`);
    return;
  }

  const staleMs = opts.greenCheckpointStallRecoveryStaleMs ?? DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_STALE_MS;
  const maxAttempts = opts.greenCheckpointStallRecoveryMaxAttempts ?? DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_MAX_ATTEMPTS;

  for (const row of rows) {
    const parsed = parseGreenCheckpointStallEscalation(row.escalation);
    if (!parsed || parsed.installSlug !== row.harness_slug) continue;
    const mtimeMs = finiteTimestamp(row.mtime_ms);
    const decision = decideGreenCheckpointStallRecovery({
      mtimeMs,
      nowMs,
      ownershipCovered: parsed.ownershipCovered,
      candidate: parsed.candidate,
      failingTests: parsed.failingTests,
      recoveryAttempts: parsed.recovery.attempts,
      recoveryNotifiedAt: parsed.recovery.notifiedAt,
      staleMs,
      maxAttempts,
    });
    if (decision.action === 'none') continue;

    const originalBody = typeof row.escalation === 'string' ? row.escalation : JSON.stringify(row.escalation);
    if (!originalBody) continue;

    const claimedRecovery: GreenCheckpointStallRecoveryMarker =
      decision.action === 'notify'
        ? {
            attempts: parsed.recovery.attempts,
            lastAttemptAt: parsed.recovery.lastAttemptAt,
            outcome: 'max-attempts',
            notifiedAt: nowMs,
          }
        : {
            attempts: decision.nextAttempt,
            lastAttemptAt: nowMs,
            outcome: 'claimed',
            notifiedAt: parsed.recovery.notifiedAt,
          };
    const claimedBody = recoveryBody(parsed, claimedRecovery);
    let claimed: { count?: number };
    try {
      claimed = await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = ${claimedBody}
         WHERE harness_slug = ${row.harness_slug}
           AND phase = ${GREEN_CHECKPOINT_STALL_PHASE}
           AND escalation IS NOT DISTINCT FROM ${originalBody}`;
    } catch (e) {
      console.warn(`[green-stall-watchdog] recovery claim failed for ${row.harness_slug}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (claimed.count !== 1) continue; // another watchdog process owns this row

    if (decision.action === 'notify') {
      if (parsed.candidate && parsed.failingTests.length > 0) {
        await notifyGreenCheckpointStallRecovery({
          installSlug: row.harness_slug,
          workspaceId: row.workspace_id,
          candidate: parsed.candidate,
          failingTests: parsed.failingTests,
          checkpointEvidence: parsed.checkpointEvidence,
          attempts: parsed.recovery.attempts,
          reason: 'max-attempts',
        });
      }
      continue;
    }

    let dispatched = false;
    try {
      const { dispatchReleaseFixer } = await import('../harness/routines/release-actions');
      dispatched =
        // 4th positional is `repairQueue?: FrozenCandidateRepairQueue`, NOT checkpoint
        // evidence. Passing `parsed.checkpointEvidence` here was not merely a type error:
        // dispatchReleaseFixer dereferences `repairQueue.candidate.slice(0, 8)` and
        // `.repairHead`/`.attempts` when building the fixer's instructions,
        // and CheckpointEvidence carries none of those — so a watchdog-driven recovery
        // dispatch would have thrown a TypeError on `undefined.slice` inside the very path
        // meant to rescue a stalled gate. The watchdog has no frozen repair queue to hand
        // over (its `parsed` exposes only checkpointEvidence), so the argument is omitted;
        // the evidence continues to travel on the verdict records built above. The repo's
        // two other callers pass three arguments for the same reason.
        (await dispatchReleaseFixer(
          { installSlug: row.harness_slug, workspaceId: row.workspace_id },
          parsed.candidate!,
          parsed.failingTests,
        )) != null;
    } catch (e) {
      console.warn(`[green-stall-watchdog] recovery dispatch failed for ${row.harness_slug}: ${e instanceof Error ? e.message : e}`);
    }

    const outcome: GreenCheckpointStallRecoveryMarker['outcome'] = dispatched ? 'dispatched' : 'no-progress';
    const finalRecovery: GreenCheckpointStallRecoveryMarker = { ...claimedRecovery, outcome };
    try {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = ${recoveryBody(parsed, finalRecovery)}
         WHERE harness_slug = ${row.harness_slug}
           AND phase = ${GREEN_CHECKPOINT_STALL_PHASE}
           AND escalation IS NOT DISTINCT FROM ${claimedBody}`;
    } catch (e) {
      console.warn(`[green-stall-watchdog] recovery result write failed for ${row.harness_slug}: ${e instanceof Error ? e.message : e}`);
    }

    if (!dispatched && parsed.candidate && parsed.failingTests.length > 0 && parsed.recovery.notifiedAt == null) {
      await notifyGreenCheckpointStallRecovery({
        installSlug: row.harness_slug,
        workspaceId: row.workspace_id,
        candidate: parsed.candidate,
        failingTests: parsed.failingTests,
        checkpointEvidence: parsed.checkpointEvidence,
        attempts: decision.nextAttempt,
        reason: 'no-progress',
      });
      // Best-effort one-shot latch. The marker is deliberately written without touching mtime_ms.
      try {
        await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = ${recoveryBody(parsed, { ...finalRecovery, notifiedAt: nowMs })}
           WHERE harness_slug = ${row.harness_slug}
             AND phase = ${GREEN_CHECKPOINT_STALL_PHASE}
             AND escalation IS NOT DISTINCT FROM ${recoveryBody(parsed, finalRecovery)}`;
      } catch (e) {
        console.warn(`[green-stall-watchdog] recovery notify marker failed for ${row.harness_slug}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

type PausedGreenCheckpointRoutineRow = {
  install_slug: string;
  workspace_id: string;
  active: boolean | null;
  group_slug: string | null;
  target_role: string | null;
  next_fire_ms: string | number | null;
  pause: unknown;
  serializer_item_id: string | null;
  serializer_claim_hold: boolean | null;
  serializer_owner: string | null;
  serializer_hold_reason: string | null;
  serializer_owner_live: boolean | null;
};

type PausedGreenCheckpointEscalationRow = {
  escalation: unknown;
};

type PausedGreenCheckpointPauseEvidence = {
  pauseRecorded: boolean;
  pauseReason: string | null;
  pausedBy: string | null;
  pausedAtMs: number | null;
};

function readPausedGreenCheckpointPause(value: unknown): PausedGreenCheckpointPauseEvidence {
  const pause = asRecord(value);
  if (!pause) {
    return { pauseRecorded: false, pauseReason: null, pausedBy: null, pausedAtMs: null };
  }
  const reason = pause.reason ?? pause.pauseReason;
  const by = pause.pausedBy ?? pause.by ?? pause.owner;
  const at = pause.pausedAtMs ?? pause.pausedAt ?? pause.atMs ?? pause.at;
  return {
    pauseRecorded: true,
    pauseReason: typeof reason === 'string' ? reason : null,
    pausedBy: typeof by === 'string' ? by : null,
    pausedAtMs: parseTimestamp(at),
  };
}

/**
 * Scan the release-group paused gate independently from the active-stall loop.
 * The query intentionally includes resumed/future rows too: an existing
 * paused-watchdog escalation must be cleared when the routine becomes active
 * again or its next fire is no longer overdue.
 */
async function checkPausedGreenCheckpoint(
  sql: Sql,
  nowMs: number,
): Promise<{ alarmed: string[]; recovered: string[] }> {
  const out = { alarmed: [] as string[], recovered: [] as string[] };
  let passError: unknown;
  try {
    const rows = await sql<PausedGreenCheckpointRoutineRow[]>`
      SELECT r.install_slug,
             r.workspace_id,
             r.active,
             r.group_slug,
             r.target_role,
             extract(epoch from r.next_fire_at) * 1000 AS next_fire_ms,
             r.metadata->'pause' AS pause,
             serializer.feature_id AS serializer_item_id,
             serializer.claim_hold AS serializer_claim_hold,
             serializer.held_open_by AS serializer_owner,
             serializer.held_open_reason AS serializer_hold_reason,
             serializer.owner_live AS serializer_owner_live
        FROM harness_shared.routines r
        LEFT JOIN LATERAL (
          SELECT wi.feature_id,
                 (wi.payload->>'_claimHold') = 'true' AS claim_hold,
                 wi.payload->>'held_open_by' AS held_open_by,
                 wi.payload->>'held_open_reason' AS held_open_reason,
                 EXISTS (
                   SELECT 1
                     FROM harness_shared.coord_presence cp
                    WHERE cp.workspace_id = wi.workspace_id
                      AND cp.owner_id = wi.payload->>'held_open_by'
                      -- NO revoked_at predicate: harness_shared.coord_presence has no such
                      -- column (EI-21291109975568717). Presence rows are deleted, not revoked.
                      AND cp.heartbeat_at > now() - ${`${Math.floor(LIVE_SERIALIZER_PRESENCE_STALE_MS / 1000)} seconds`}::interval
                      AND cp.last_active_at > now() - ${`${Math.floor(LIVE_SERIALIZER_PRESENCE_STALE_MS / 1000)} seconds`}::interval
                 ) AS owner_live
            FROM harness_shared.work_items wi
           WHERE wi.workspace_id = r.workspace_id
             AND wi.harness_slug = r.install_slug
             AND wi.feature_id = substring(
                   r.metadata->'pause'->>'reason'
                   FROM '^D-012/D-013 live quiescence hold under ((WI|EI)-[0-9]+):'
                 )
             AND (wi.payload->>'_claimHold') = 'true'
             AND wi.payload->>'held_open_reason' LIKE ${`${CHECKPOINT_SERIALIZER_HOLD_REASON_PREFIX}%`}
           ORDER BY wi.updated_ts DESC NULLS LAST
           LIMIT 1
        ) serializer ON true
       WHERE r.group_slug = 'release'
         AND r.target_role = 'system:green-checkpoint'`;

    for (const row of rows) {
      const pause = readPausedGreenCheckpointPause(row.pause);
      const nextFireMs = row.next_fire_ms != null ? Number(row.next_fire_ms) : null;
      const verdict = evaluatePausedGreenCheckpoint(
        {
          active: row.active,
          groupSlug: row.group_slug,
          targetRole: row.target_role,
          nextFireMs: Number.isFinite(nextFireMs) ? nextFireMs : null,
          serializerItemId: row.serializer_item_id,
          serializerClaimHold: row.serializer_claim_hold ?? undefined,
          serializerOwner: row.serializer_owner,
          serializerHoldReason: row.serializer_hold_reason,
          serializerOwnerLive: row.serializer_owner_live ?? undefined,
          ...pause,
        },
        nowMs,
      );
      const recovery = decidePausedGreenCheckpointRecovery(
        {
          active: row.active,
          groupSlug: row.group_slug,
          targetRole: row.target_role,
          nextFireMs: Number.isFinite(nextFireMs) ? nextFireMs : null,
          serializerItemId: row.serializer_item_id,
          serializerClaimHold: row.serializer_claim_hold ?? undefined,
          serializerOwner: row.serializer_owner,
          serializerHoldReason: row.serializer_hold_reason,
          serializerOwnerLive: row.serializer_owner_live ?? undefined,
          ...pause,
        },
        nowMs,
      );

      const existing = await sql<PausedGreenCheckpointEscalationRow[]>`
        SELECT escalation
          FROM harness_shared.harness_escalations
         WHERE harness_slug = ${row.install_slug}
           AND phase = ${PAUSED_GREEN_CHECKPOINT_PHASE}`;
      const alreadyAlarmed = existing.length > 0 && existing[0]?.escalation != null;

      if (verdict.overdue) {
        if (alreadyAlarmed) continue; // one-shot until the pause clears or is no longer overdue

        let autoRecovery: {
          state: 'rearmed';
          itemId: string;
          ownerId: string;
          rearmedAtMs: number;
          reason: string;
        } | null = null;
        if (recovery.action === 'rearm') {
          const pauseRecord = asRecord(row.pause) ?? {};
          const lastPause = {
            ...pauseRecord,
            autoRecoveredAtMs: nowMs,
            autoRecoveredBy: 'green-stall-watchdog',
            autoRecoveryReason: recovery.reason,
          };
          const rearmed = await sql<{ install_slug: string }[]>`
            UPDATE harness_shared.routines r
               SET active = true,
                   next_fire_at = now(),
                   metadata = jsonb_set(
                     r.metadata - 'pause',
                     '{lastPause}',
                     ${JSON.stringify(lastPause)}::text::jsonb,
                     true
                   ),
                   updated_at = now()
             WHERE r.workspace_id = ${row.workspace_id}
               AND r.install_slug = ${row.install_slug}
               AND r.name = 'green-checkpoint'
               AND r.group_slug = 'release'
               AND r.target_role = 'system:green-checkpoint'
               AND r.active = false
               AND r.metadata->'pause' = ${JSON.stringify(row.pause)}::text::jsonb
               AND EXISTS (
                 SELECT 1
                   FROM harness_shared.work_items wi
                  WHERE wi.workspace_id = r.workspace_id
                    AND wi.harness_slug = r.install_slug
                    AND wi.feature_id = ${recovery.itemId}
                    AND (wi.payload->>'_claimHold') = 'true'
                    AND wi.payload->>'held_open_by' = ${recovery.ownerId}
                    AND wi.payload->>'held_open_reason' = ${recovery.holdReason}
                    AND NOT EXISTS (
                      SELECT 1
                        FROM harness_shared.coord_presence cp
                       WHERE cp.workspace_id = wi.workspace_id
                         AND cp.owner_id = ${recovery.ownerId}
                         AND cp.heartbeat_at > now() - ${`${Math.floor(LIVE_SERIALIZER_PRESENCE_STALE_MS / 1000)} seconds`}::interval
                         AND cp.last_active_at > now() - ${`${Math.floor(LIVE_SERIALIZER_PRESENCE_STALE_MS / 1000)} seconds`}::interval
                    )
               )
            RETURNING r.install_slug`;
          if (!rearmed[0]) {
            // The pause/claim/liveness changed between the read and the write. Do not
            // alarm from the stale snapshot; the next pass will classify the new state.
            continue;
          }
          autoRecovery = {
            state: 'rearmed',
            itemId: recovery.itemId,
            ownerId: recovery.ownerId,
            rearmedAtMs: nowMs,
            reason: recovery.reason,
          };
        }

        const body = greenCheckpointPausedEscalationBody({
          installSlug: row.install_slug,
          verdict,
          pauseReason: pause.pauseReason,
          pausedBy: pause.pausedBy,
          pausedAtMs: pause.pausedAtMs,
          nextFireMs,
          nowMs,
          autoRecovery,
        });
        try {
          const { notifyAttention } = await import('../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: autoRecovery
              ? 'Release pipeline RECOVERING — stranded green-checkpoint pause was re-armed'
              : 'Release pipeline PAUSED — green-checkpoint hold is overdue',
            body: autoRecovery
              ? `${verdict.reason ?? ''} The structured owner is non-live; the existing routine was re-armed. A fresh verdict is pending.`
              : (verdict.reason ?? ''),
            importance: 'urgent',
            workspaceId: row.workspace_id,
            data: {
              pausedBy: pause.pausedBy,
              pausedAtMs: pause.pausedAtMs,
              nextFireMs,
              condition: PAUSED_GREEN_CHECKPOINT_KIND,
            },
          });
        } catch (e) {
          console.warn(`[green-stall-watchdog] paused green-checkpoint notify failed: ${e instanceof Error ? e.message : e}`);
        }
        await broadcastSevereEvent({
          summary: autoRecovery
            ? `green-checkpoint RECOVERING on ${row.install_slug} — stranded serializer pause was re-armed; fresh verdict pending.`
            : `green-checkpoint PAUSED on ${row.install_slug} — scheduled fire is overdue; release deploys may be frozen.`,
          body: autoRecovery
            ? `${verdict.reason ?? ''} The routine is re-armed, but no gate verdict exists yet.`
            : (verdict.reason ?? ''),
          category: 'severe-event',
          conditionKey: `${PAUSED_GREEN_CHECKPOINT_CONDITION_PREFIX}${row.install_slug}`,
          oneShot: true,
        });
        try {
          await sql`
            INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
            VALUES (${row.install_slug}, ${PAUSED_GREEN_CHECKPOINT_PHASE}, ${body}, ${nowMs}, ${row.workspace_id})
            ON CONFLICT (harness_slug, phase)
            DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
        } catch (e) {
          console.warn(`[green-stall-watchdog] paused green-checkpoint escalation write failed for ${row.install_slug}: ${e instanceof Error ? e.message : e}`);
        }
        out.alarmed.push(row.install_slug);
        console.warn(`[green-stall-watchdog] PAUSED ALARM ${row.install_slug}: ${verdict.reason}`);
      } else if (alreadyAlarmed) {
        await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = NULL, mtime_ms = ${nowMs}
           WHERE harness_slug = ${row.install_slug}
             AND phase = ${PAUSED_GREEN_CHECKPOINT_PHASE}
             AND escalation IS NOT NULL`;
        await broadcastSevereEventResolved({
          conditionKey: `${PAUSED_GREEN_CHECKPOINT_CONDITION_PREFIX}${row.install_slug}`,
          summary: `green-checkpoint PAUSED alarm recovered on ${row.install_slug} — the hold is active no longer overdue.`,
        });
        out.recovered.push(row.install_slug);
      }
    }
    return out;
  } catch (e) {
    // A paused-gate read must never disable the existing active-stall watchdog.
    passError = e;
    console.warn(`[green-stall-watchdog] paused green-checkpoint scan failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  } finally {
    // Scans every green-checkpoint row (no install filter), so a failure means every one of
    // them went unwatched — the marker is written just as widely.
    await recordWatchdogPassOutcome(sql, 'paused-green-checkpoint', { routineName: 'green-checkpoint' }, passError);
  }
}

/**
 * One watchdog pass: scan every ACTIVE green-checkpoint routine, alarm once per
 * stall transition (cross-process exactly-once via a conditional flag flip), and
 * clear the flag + escalation on recovery. Never throws — it rides boot + an
 * interval and must not break either.
 */
export async function checkGreenStall(
  sql: Sql,
  opts: GreenStallThresholds = {},
): Promise<GreenStallWatchdogResult> {
  const out: GreenStallWatchdogResult = { alarmed: [], recovered: [], suppressed: [] };
  let passError: unknown;
  try {
    const rows = await sql<
      {
        install_slug: string;
        workspace_id: string;
        last_fired_ms: string | number | null;
        last_verdict_ms: string | number | null;
        gh: {
          lastGreenAt?: number;
          watchdogAlerted?: boolean;
          failingTests?: string[];
          // P-003 (gate-verdict-liveness): red-state inputs + the rate alarm's own one-shot flag.
          consecutiveReds?: number;
          green?: boolean;
          verdictRateAlarmed?: boolean;
          // WI-6989: a hard-killed checkpoint cannot emit its own inconclusive result.
          // The process-level watchdog reads the producer-published marker and wakes
          // checkpoint:await registrations as soon as the marker's pid is proven gone.
          inFlightCandidate?: unknown;
          // P-006 (WI-41755): the typed abort record release-actions.ts writes on an aborted
          // tick. Already inside the `gate_health` jsonb this query selects, so reading it
          // costs nothing extra — it is what lets the re-fire advisory classify the abort.
          inconclusive?: { status?: string; candidate?: string | null; observedAtMs?: number } | null;
          // D-003 (gate-verdict-liveness-and-repair-reliability-2026-08-31): the durable
          // verdict-less refire episode this sweep both reads and writes; see
          // resolveVerdictlessRefireEpisode for the reset rule.
          verdictlessRefire?: {
            attempts?: number;
            lastAttemptStatus?: string | null;
            lastAttemptAtMs?: number | null;
          } | null;
        } | null;
      }[]
    >`
      SELECT r.install_slug,
             r.workspace_id,
             extract(epoch from r.last_fired_at) * 1000 AS last_fired_ms,
             r.metadata->'gate_health' AS gh,
             -- P-006 (WI-41755): when this install last recorded ANY verdict (green OR red),
             -- so "the gate is firing but recording nothing" is detectable. Deliberately a
             -- correlated subquery on the EXISTING sweep rather than a second round-trip:
             -- pipeline_events_slug_kind_created_idx is (install_slug, kind, created_at DESC),
             -- so this is an O(1) index lookup per install and the sweep stays cheap.
             (SELECT extract(epoch from pe.created_at) * 1000
                FROM harness_shared.pipeline_events pe
               WHERE pe.install_slug = r.install_slug
                 AND pe.kind = 'green_checkpoint'
               ORDER BY pe.created_at DESC
               LIMIT 1) AS last_verdict_ms
        FROM harness_shared.routines r
       WHERE r.target_role = 'system:green-checkpoint'
         AND r.active = true`;

    const now = Date.now();
    // This axis is deliberately independent: a paused routine never reaches
    // the active-fire query below, and its escalation/condition must not share
    // the active watchdog's dedup flag or recovery row.
    const paused = await checkPausedGreenCheckpoint(sql, now);
    for (const installSlug of paused.alarmed) {
      if (!out.alarmed.includes(installSlug)) out.alarmed.push(installSlug);
    }
    for (const installSlug of paused.recovered) {
      if (!out.recovered.includes(installSlug)) out.recovered.push(installSlug);
    }
    await recoverStaleGreenCheckpointStalls(sql, now, opts);
    const routineEngine = await readRoutineEngineLiveness(sql, { nowMs: now });
    for (const row of rows) {
      const lastFiredMs = row.last_fired_ms != null ? Number(row.last_fired_ms) : null;
      const lastVerdictAtMs = row.last_verdict_ms != null ? Number(row.last_verdict_ms) : null;
      const lastGreenAt = row.gh?.lastGreenAt ?? null;
      const watchdogAlerted = row.gh?.watchdogAlerted ?? false;
      // EI-7505: gate_health.failingTests, threaded through by trackGateStall
      // (release-actions.ts) on the last red green-checkpoint tick.
      const failingTests = row.gh?.failingTests ?? [];
      await wakeAbandonedCheckpointAwaits({
        installSlug: row.install_slug,
        workspaceId: row.workspace_id,
        rawMarker: row.gh?.inFlightCandidate,
      }, { dbosSql: sql });
      const checkpointRun = await readCheckpointRunState(row.install_slug, row.workspace_id);
      const verdict = evaluateGreenStall(
        {
          lastFiredMs,
          lastVerdictAtMs,
          lastGreenAt,
          watchdogAlerted,
          routineEngineStale: routineEngine.stale,
          failingTests,
          ...checkpointRun,
        },
        now,
        opts,
      );

      // ---- P-003 (gate-verdict-liveness): no-verdict RATE alarm — evaluated FIRST ----
      // Hoisted above the D-006 actuation block (P-002 wiring): the alarm axis feeds the
      // refire decision, because an abort stream with INTERMITTENT verdicts keeps
      // resetting the verdict-less clock while most fires still render nothing — the
      // rate alarm is the axis that sees it. Independent axis on purpose — a red verdict
      // resetting consecutiveNoVerdict must not silence it, so it reads the P-001 fire
      // ledger and the verdict-bearing clock, never the streak counters. Cost-gated: a
      // green, un-alarmed gate pays zero extra queries; on a failed read the PERSISTED
      // one-shot flag governs the axis (fail-soft — a broken read neither invents nor
      // clears an alarm).
      let rateAlarmActive = row.gh?.verdictRateAlarmed ?? false;
      {
        const gateRed = (row.gh?.consecutiveReds ?? 0) > 0 || row.gh?.green === false;
        const rateAlarmed = row.gh?.verdictRateAlarmed ?? false;
        if (gateRed || rateAlarmed) {
          try {
            const target = { workspaceId: row.workspace_id, installSlug: row.install_slug };
            const window = await readVerdictRateWindow(sql, target);
            const rate = evaluateVerdictRateAlarm({
              nowMs: now,
              gateRed,
              window,
              suiteBudgetMs: GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
            });
            rateAlarmActive = rate.alarmed;
            if (rate.alarmed && !rateAlarmed) {
              // Cross-process exactly-once, same convention as watchdogAlerted below.
              const flip = await sql`
                UPDATE harness_shared.routines
                   SET metadata = jsonb_set(
                         COALESCE(metadata, '{}'::jsonb),
                         '{gate_health}',
                         COALESCE(metadata->'gate_health', '{}'::jsonb) || '{"verdictRateAlarmed":true}'::jsonb
                       ),
                       updated_at = now()
                 WHERE install_slug = ${row.install_slug}
                   AND target_role = 'system:green-checkpoint'
                   AND COALESCE((metadata->'gate_health'->>'verdictRateAlarmed')::boolean, false) = false`;
              if (flip.count === 1) {
                if (!out.alarmed.includes(row.install_slug)) out.alarmed.push(row.install_slug);
                const { notifyAttentionOnce } = await import('../attention-notify');
                await notifyAttentionOnce({
                  kind: 'intervention',
                  title: `Green gate is firing but NOT rendering verdicts on ${row.install_slug} (${rate.reason})`,
                  body:
                    `${rate.detail} Fires (P-001 anchors) in window: ${window.fires}; verdict-bearing outcomes: ` +
                    `${window.verdicts}; newest verdict: ${
                      window.lastVerdictBearingAtMs != null
                        ? new Date(window.lastVerdictBearingAtMs).toISOString()
                        : 'none recorded'
                    }.`,
                  importance: 'urgent',
                  dedupeKey: `gate-verdict-rate:${row.install_slug}:${rate.reason}:${row.gh?.consecutiveReds ?? 0}`,
                  workspaceId: row.workspace_id,
                  data: {
                    alarmAxis: 'verdict-rate',
                    reason: rate.reason,
                    fires: window.fires,
                    verdicts: window.verdicts,
                    lastVerdictBearingAtMs: window.lastVerdictBearingAtMs,
                  },
                });
              }
            } else if (!rate.alarmed && rateAlarmed) {
              // Recovery: clear the one-shot so a future episode can page again.
              await sql`
                UPDATE harness_shared.routines
                   SET metadata = jsonb_set(
                         COALESCE(metadata, '{}'::jsonb),
                         '{gate_health}',
                         COALESCE(metadata->'gate_health', '{}'::jsonb) || '{"verdictRateAlarmed":false}'::jsonb
                       ),
                       updated_at = now()
                 WHERE install_slug = ${row.install_slug}
                   AND target_role = 'system:green-checkpoint'`;
              if (!out.recovered.includes(row.install_slug)) out.recovered.push(row.install_slug);
            }
          } catch (e) {
            // Fail-soft like every other limb: a broken rate read must not take the sweep down.
            console.warn(
              `[green-stall-watchdog] P-003 verdict-rate alarm failed for ${row.install_slug} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }

      // ---- D-006 actuation (gate-verdict-liveness-and-repair-reliability-2026-08-31 D-003) ----
      // Runs EVERY pass, deliberately upstream of the one-shot `watchdogAlerted` gate below:
      // the alarm fires once per episode, but a bounded multi-attempt recovery must keep
      // evaluating (its own cooldown / reproduced / max-attempts arms bound it). The decision
      // is reused verbatim in the alarm's structured data below, so what we DID and what we
      // SAID can never diverge. P-002: the P-003 verdict-RATE alarm (evaluated above) is a
      // second engagement axis — prompt-requeue on an abort stream the verdict-less clock
      // cannot see; every declining arm (wall, in-flight, unclassifiable, reproduced,
      // budget, cooldown) governs both axes identically.
      let refire: VerdictlessRefireDecision | null = null;
      if (verdict.verdictless || rateAlarmActive) {
        const episode = resolveVerdictlessRefireEpisode(row.gh, lastVerdictAtMs);
        const wall: GateFireWall = opts.readGateFireWall
          ? await opts.readGateFireWall().catch((e: unknown) => ({
              active: true,
              detail: `wall reader threw (fail-closed): ${e instanceof Error ? e.message : String(e)}`,
            }))
          : { active: true, detail: 'fail-closed: no wall reader wired (bare sweep call)' };
        refire = decideVerdictlessRefire({
          verdictless: verdict.verdictless,
          rateAlarmed: rateAlarmActive,
          abortStatus: row.gh?.inconclusive?.status ?? null,
          ownerWallActive: wall.active,
          refireInFlight: checkpointRun.checkpointRunActive === true,
          attempts: episode.attempts,
          lastAttemptStatus: episode.lastAttemptStatus,
          lastAttemptAtMs: episode.lastAttemptAtMs,
          nowMs: now,
          maxAttempts: opts.greenCheckpointStallRecoveryMaxAttempts,
        });
        if (refire.action === 'refire') {
          const homeSlug = opts.refireHomeSlug ?? safeOperatorHomeSlug();
          if (!opts.launchCheckpoint || homeSlug == null || row.install_slug !== homeSlug) {
            // Advisory-only for non-home installs (their gates route to roots this launcher
            // does not target) and for callers that wired no launcher.
            console.warn(
              `[green-stall-watchdog] D-006 refire warranted for ${row.install_slug} but actuation is ${
                !opts.launchCheckpoint ? 'not wired' : 'home-scoped'
              } — advisory only (${refire.detail})`,
            );
          } else {
            try {
              const launch = await opts.launchCheckpoint();
              if (launch.launched) {
                await sql`
                  UPDATE harness_shared.routines
                     SET metadata = jsonb_set(
                           COALESCE(metadata, '{}'::jsonb),
                           '{gate_health}',
                           COALESCE(metadata->'gate_health', '{}'::jsonb) ||
                             ${JSON.stringify({
                               verdictlessRefire: {
                                 attempts: refire.nextAttempt,
                                 lastAttemptStatus: refire.abortStatus,
                                 lastAttemptAtMs: now,
                               },
                             })}::jsonb
                         ),
                         updated_at = now()
                   WHERE install_slug = ${row.install_slug}
                     AND target_role = 'system:green-checkpoint'`;
                console.warn(
                  `[green-stall-watchdog] D-006 ACTUATED verdict-less auto-refire ${refire.nextAttempt} for ${row.install_slug} (abort: ${refire.abortStatus ?? 'unknown'}; unit ${launch.unit})`,
                );
              } else {
                console.warn(
                  `[green-stall-watchdog] D-006 refire declined by launcher for ${row.install_slug} (${launch.reason ?? 'no reason'}) — no attempt burned`,
                );
              }
            } catch (e) {
              console.warn(
                `[green-stall-watchdog] D-006 refire launch failed for ${row.install_slug} (non-fatal, no attempt burned): ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
        }
      }

      // (The P-003 no-verdict RATE alarm evaluation was HOISTED above the D-006 actuation
      // block — P-002 wiring: the alarm axis feeds the refire decision via
      // `rateAlarmActive`. See the "evaluated FIRST" block above.)

      if (verdict.stalled) {
        if (watchdogAlerted) continue; // already alarmed; one-shot until recovery
        // Cross-process exactly-once: only the writer that flips watchdogAlerted
        // false→true gets to alarm. jsonb_set merges into the existing gate_health
        // so we never drop consecutiveReds/lastGreenAt/etc.
        const flip = await sql`
          UPDATE harness_shared.routines
             SET metadata = jsonb_set(
                   COALESCE(metadata, '{}'::jsonb),
                   '{gate_health}',
                   COALESCE(metadata->'gate_health', '{}'::jsonb) || '{"watchdogAlerted":true}'::jsonb
                 ),
                 updated_at = now()
           WHERE install_slug = ${row.install_slug}
             AND target_role = 'system:green-checkpoint'
             AND COALESCE((metadata->'gate_health'->>'watchdogAlerted')::boolean, false) = false`;
        if (flip.count !== 1) continue; // another process won the flip

        // WI-39704: attribute a verdict-staleness stall from the LEDGER before saying
        // anything about its cause. One query, only on the transition that actually
        // alarms (we have already won the one-shot flip), so a healthy sweep pays
        // nothing. Fail-soft: no evidence ⇒ `attributeVerdictStale` says so plainly
        // rather than falling back to the old "⇒ a failing suite" guess.
        //
        // P-006 (WI-41755): this read is gated on `verdictStale || verdictless`, and the
        // second half is not cosmetic — without it the alarm is evidence-BLIND in exactly
        // the case the verdictless limb was built to catch.
        //
        // The two limbs fire on different clocks: `verdictless` at 3h, `verdictStale` only
        // after 12h with no GREEN. So a gate that greened recently and has been dying ever
        // since alarms via `verdictless` ALONE, with `verdictStale` still false for the next
        // nine hours. Gated on `verdictStale` only, that alarm read no evidence, produced no
        // attribution, and — worst of the three — emitted `verdictlessDeath: null`, i.e. the
        // structured field that says "the run left no verdict" read as absent precisely when
        // the death WAS verdict-less. A consumer branching on it would conclude the opposite
        // of the truth, which is worse than the field not existing at all.
        const needsEvidence = verdict.verdictStale || verdict.verdictless;
        const lastRun = needsEvidence ? await readLastGateRunEvidence(sql, row.install_slug) : null;
        // Pass the fire time so a fire that recorded NOTHING is named as such, instead of being
        // explained with an earlier run's cause. Both values are already in scope here; before
        // this the evidence's age was never compared to anything.
        const attribution = needsEvidence
          ? attributeVerdictStale({ failingTests, last: lastRun, lastFiredMs, now })
          : null;
        // D-006: the refire judgement was computed — and possibly ACTED ON — upstream of the
        // one-shot alarm gate (see the actuation block above), so the alarm's structured data
        // below reports exactly what the actuation path decided.
        const reasonText = attribution
          ? `${verdict.reason} — ${attribution.cause}`
          : (verdict.reason ?? '');

        try {
          const { notifyAttention } = await import('../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: 'Release pipeline STALLED — green-checkpoint not producing greens',
            body: `green-checkpoint (${row.install_slug}) silent stall: ${reasonText}. \`main\` is frozen and the per-verdict detector can't see this. ${attribution?.remedy ?? 'The dead-executor reaper should auto-recover a wedge; manual help may be needed if it persists.'}`,
            importance: 'urgent',
            workspaceId: row.workspace_id,
            data: {
              fireStale: verdict.fireStale,
              verdictStale: verdict.verdictStale,
              lastRunCrashed: lastRun?.crashed ?? null,
              // P-006 (WI-41755): structured, so a consumer can branch on "the run left no
              // verdict" without parsing prose. `lastRunCrashed` cannot express this case —
              // it reports the newest RECORDED run, which in a verdict-less death is an
              // earlier run entirely, so it can read `false` while the current fire is dead.
              verdictlessDeath: needsEvidence
                ? judgeVerdictlessDeath({ last: lastRun, lastFiredMs, now }).reason
                : null,
              // D-006: what an automatic re-fire WOULD do, and why. Structured so a consumer
              // can branch on the judgement without parsing prose; `refireAction: 'refire'` is
              // unreachable while the owner wall stands.
              refireAction: refire?.action ?? null,
              refireReason: refire?.reason ?? null,
              abortKind: refire?.abortKind ?? null,
            },
          });
        } catch (e) {
          console.warn(`[green-stall-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
        }
        // Fleet broadcast (owner-requested): inject-only (wake=false) so every running agent
        // sees it next turn and someone can claim greening the gate, without a wake storm.
        await broadcastSevereEvent({
          // WI-39704: the summary is the highest-leverage string in this whole path — it is
          // what every agent sees in its inbox AND what the condition bridge titles the
          // owning work-item. "no green verdicts" unqualified reads as "the suite is red",
          // which is the misattribution itself, so it is now stated by the evidence.
          summary: `green-checkpoint STALLED on ${row.install_slug} — ${attribution?.summary ?? 'no green verdicts; deploys frozen.'}`,
          body:
            `${reasonText}\n\nThe release gate isn't producing greens, so nothing new can deploy. ` +
            (verdict.fireStale
              ? `fire-staleness ⇒ the routine engine/DBOS is wedged (a reaper should recover; manual help if it persists). `
              : '') +
            (attribution?.remedy ?? `release:checkpoint-run forces a fresh gate run.`) +
            // D-006: say plainly whether a re-fire is the right move. A responder reading a
            // verdict-less stall's default remedy ("release:checkpoint-run forces a fresh gate
            // run") would otherwise re-fire into a standing abort — which is the exact mistake
            // that burned the D-077 one-shot on 2026-08-25.
            (refire ? `\n\nAuto-refire judgement: ${refire.detail}` : ''),
          category: 'severe-event',
          // WI-1444 condition lifecycle: recovery below broadcasts the matching
          // resolution, so late inbox readers see this alarm annotated resolved.
          conditionKey: `green-stall:${row.install_slug}`,
          // WI-6228: one-shot until recovery (see `watchdogAlerted` above) — our
          // silence is deliberate, never evidence the gate recovered.
          oneShot: true,
        });
        try {
          await sql`
            INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
            VALUES (${row.install_slug}, ${WATCHDOG_PHASE}, ${greenStallEscalationBody({
              installSlug: row.install_slug,
              // WI-39704: the DURABLE record carries the attributed reason too. An
              // escalation row outlives the broadcast, so leaving the un-attributed text
              // here would just relocate the misattribution to the surface a responder
              // reaches for last (and trusts most).
              verdict: { ...verdict, reason: reasonText },
              lastFiredMs,
              lastGreenAt,
              nowMs: now,
              failingTests,
            })}, ${now}, ${row.workspace_id})
            ON CONFLICT (harness_slug, phase)
            DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
        } catch (e) {
          console.warn(`[green-stall-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
        }
        out.alarmed.push(row.install_slug);
        console.warn(`[green-stall-watchdog] ALARM ${row.install_slug}: ${reasonText}`);
      } else if (verdict.suppressed) {
        // P-016: DECLINED TO JUDGE — not healthy. The root routine engine is stale,
        // so infra-liveness owns the root-cause alarm and this symptom-level one is
        // muted (EI-2994). Muting must be SILENT: falling through to the recovery
        // branch would clear `watchdogAlerted`, wipe a still-valid escalation row,
        // and broadcast "the gate is producing verdicts again" — an all-clear issued
        // by the one code path that deliberately did not look at whether the gate is
        // producing verdicts. Engine staleness flickers around its own threshold on a
        // loaded box, so that false all-clear fired on every flicker and produced the
        // observed STALLED/RECOVERED alternation within a single window on oddsmith.
        // Leaving the alarm state UNTOUCHED is what makes the mute a pause rather
        // than a retraction: if the gate really was stalled, the alarm is still up
        // when the engine steadies and we re-evaluate.
        out.suppressed.push(row.install_slug);
        continue;
      } else {
        // Healthy — and we actually looked. Clear the watchdog flag (a green verdict
        // already wipes gate_health, so this is belt-and-suspenders) and the
        // escalation row, both idempotently.
        if (watchdogAlerted) {
          await sql`
            UPDATE harness_shared.routines
               SET metadata = jsonb_set(
                     COALESCE(metadata, '{}'::jsonb),
                     '{gate_health}',
                     COALESCE(metadata->'gate_health', '{}'::jsonb) || '{"watchdogAlerted":false}'::jsonb
                   ),
                   updated_at = now()
             WHERE install_slug = ${row.install_slug}
               AND target_role = 'system:green-checkpoint'`;
        }
        // Independent of the flag: a green-verdict wipe can clear watchdogAlerted while
        // leaving our escalation row, so always run the idempotent clear (no-op when null).
        const cleared = await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = NULL, mtime_ms = ${now}
           WHERE harness_slug = ${row.install_slug}
             AND phase = ${WATCHDOG_PHASE}
             AND escalation IS NOT NULL`;
        if (cleared.count === 1 || watchdogAlerted) {
          // WI-1444: supersede the fleet alarm — coord:inbox annotates every prior
          // `green-stall:<slug>` broadcast resolved, so a late reader never chases
          // a gate stall that already cleared. Guarded on the same transition edge
          // as `recovered` so a routinely-healthy pass broadcasts nothing.
          await broadcastSevereEventResolved({
            conditionKey: `green-stall:${row.install_slug}`,
            summary: `green-checkpoint RECOVERED on ${row.install_slug} — the gate is producing verdicts again; the earlier stall alarm is stale.`,
          });
          out.recovered.push(row.install_slug);
        }
      }
    }
    return out;
  } catch (e) {
    passError = e;
    console.warn(`[green-stall-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  } finally {
    // Scans every ACTIVE green-checkpoint row with no install filter — same width as the write.
    await recordWatchdogPassOutcome(sql, 'green-stall', { routineName: 'green-checkpoint' }, passError);
  }
}

// ── main-behind-staging guard (EI-9762) ────────────────────────────────────────

export interface MainBehindStagingSnapshot {
  /** `git rev-list --count <mainBranch>..<stagingBranch>` — null if unresolvable
   *  (e.g. a branch missing in a fresh/partial checkout — fail-open, never alarm). */
  commitsBehind: number | null;
  /** How long `staging` has been ahead of `main` by at least one commit — the age
   *  (ms) of the OLDEST commit reachable from staging but not main. null if
   *  commitsBehind is 0/null. This is the "~4.8h" half of the EI-9762 signal. */
  behindMs: number | null;
  /** EI-10202: ms since the green-checkpoint gate last ADVANCED `main` (an age
   *  derived from `gate_health.lastGreenAt`, like `behindMs` is derived from the
   *  oldest commit's timestamp). null when unreadable / the gate never greened —
   *  in which case we cannot prove the gate is advancing, so we fall back to the
   *  depth+age-only signal (never silently suppress a possible real stall). A
   *  SMALL value means the gate is demonstrably still advancing main every cycle,
   *  so a deep backlog is normal churn, NOT a wedge. */
  lastGreenAgeMs?: number | null;
  /** EI-19459452257836856: is a green-checkpoint run held by a LIVE process right
   *  now? This alarm is broadcast hive-wide as a severe-event, and its remedy used
   *  to tell EVERY agent to fire `release:checkpoint-run` unconditionally — the one
   *  action the repo guide flags in bold as never-do-while-a-run-is-live (firing
   *  inside a run's re-triage window discards an in-progress rescue and costs a
   *  full ~55min suite). An agent did exactly that during the 2026-08-03 stall and
   *  conceded it was premature. THREE states, deliberately:
   *    - `true`      a run IS in flight → the remedy must say WAIT, never "fire".
   *    - `false`     no run in flight  → firing really is the right remedy.
   *    - `undefined`/`null` UNKNOWN    → its own arm. Treating unknown as `true`
   *      would suppress the remedy on a genuine stall; treating it as `false` is
   *      exactly the bug this field fixes. So we alarm, and say "check first".
   *  Note this gates only the REMEDY TEXT, never `stalled`: a run being in flight
   *  does not mean the gate is healthy (it may be the 12th consecutive red), and
   *  suppressing the alarm on it would hide a real wedge. Gate-is-advancing
   *  suppression is `lastGreenAgeMs`'s job (EI-10202), not this field's. */
  runInFlight?: boolean | null;
  /** Seconds the in-flight run has been going, when measurable — turns "wait" into
   *  "wait, it started ~Nm ago". null/undefined when no run or unmeasurable. */
  runInFlightElapsedSec?: number | null;
}

export interface MainBehindStagingVerdict {
  stalled: boolean;
  reason: string | null;
}

/** Pure: decide whether `main`'s lag behind `staging` has crossed from "normal
 *  promotion latency" into "the gate stopped advancing main". THREE conditions —
 *  depth + age must BOTH trip (a lot of commits queued in the last few minutes is
 *  normal churn; a small lag sitting for hours is also normal on a quiet day),
 *  AND (EI-10202) the gate must NOT have advanced `main` recently. That last
 *  condition is the fix for the false STALLED alarm: a healthy gate greening
 *  every ~15-20 min still lets `main` fall dozens of commits / >1h behind under a
 *  busy fleet (staging outruns the full-suite cycle) — but that is backlog depth,
 *  not a wedge. Only when the gate has produced NO green advance in >recentGreenMs
 *  alongside the deep old backlog is it the genuinely-stuck signature (persistent
 *  red / killed runs) EI-9762 targets. A null `lastGreenAgeMs` (gate signal
 *  unreadable) falls back to depth+age only — we never hide a possible real stall.
 *  Exported for unit testing. */
export function evaluateMainBehindStaging(
  s: MainBehindStagingSnapshot,
  opts: {
    commitsThreshold?: number;
    msThreshold?: number;
    recentGreenMs?: number;
    advanceHorizonMs?: number;
  } = {},
): MainBehindStagingVerdict {
  const commitsThreshold = opts.commitsThreshold ?? DEFAULT_MAIN_BEHIND_COMMITS;
  const msThreshold = opts.msThreshold ?? DEFAULT_MAIN_BEHIND_MS;
  const recentGreenMs = opts.recentGreenMs ?? DEFAULT_MAIN_BEHIND_RECENT_GREEN_MS;
  const advanceHorizonMs = opts.advanceHorizonMs ?? DEFAULT_MAIN_BEHIND_ADVANCE_HORIZON_MS;
  if (s.commitsBehind == null || s.behindMs == null) return { stalled: false, reason: null };
  // EI-10202: the gate is demonstrably advancing main → a deep backlog is churn,
  // not a stall. Only known-and-recent green suppresses; an unknown/absent signal
  // does not (fall through to depth+age so a real stall still alarms).
  // WI-38340: …and only when that advance actually CONSUMED the backlog. A recent
  // advance whose `behindMs` still runs far ahead of it moved the tip end, not the
  // old end (the partial-green salvage's signature) — motion, not progress. See
  // DEFAULT_MAIN_BEHIND_ADVANCE_HORIZON_MS for the derivation of the bound.
  const advanceConsumedBacklog =
    s.lastGreenAgeMs != null && s.behindMs <= s.lastGreenAgeMs + advanceHorizonMs;
  const recentlyAdvanced =
    s.lastGreenAgeMs != null && s.lastGreenAgeMs <= recentGreenMs && advanceConsumedBacklog;
  const stalled = s.commitsBehind > commitsThreshold && s.behindMs > msThreshold && !recentlyAdvanced;
  if (!stalled) return { stalled: false, reason: null };
  const hoursBehind = (s.behindMs / 3_600_000).toFixed(1);
  // When we know the gate has ALSO not greened for a while, name it — it turns the
  // alarm from "main is behind" (ambiguous) into "main is behind AND the gate has
  // not advanced it in ~Xh" (the actual stall), and proves the depth number wasn't
  // the sole trigger (EI-10202).
  // WI-38340: there are now TWO ways to reach this alarm, and they need OPPOSITE
  // responses, so they must not share one sentence. The clause below used to be
  // emitted off `lastGreenAgeMs != null` alone — which, once a recent-but-
  // unproductive advance could reach here, would have printed "no green-checkpoint
  // advance in ~0.1h" about a gate that had just advanced. An alarm that misstates
  // its own trigger sends the reader hunting a wedged gate that is running fine.
  const advanceAgeHours = s.lastGreenAgeMs != null ? (s.lastGreenAgeMs / 3_600_000).toFixed(1) : null;
  // The gate advanced main recently, yet the old end of the backlog did not move:
  // the partial-green-salvage signature (WI-38218 promotes the longest green PREFIX
  // while the tip stays red). Motion without progress.
  const advancedButUnproductive =
    s.lastGreenAgeMs != null && s.lastGreenAgeMs <= recentGreenMs && !advanceConsumedBacklog;
  const noGreenClause = advancedButUnproductive
    ? ` (the gate DID advance main ~${advanceAgeHours}h ago, but the oldest un-promoted commit is still ~${hoursBehind}h old — it advanced the tip end, not this backlog)`
    : advanceAgeHours != null
      ? ` (no green-checkpoint advance in ~${advanceAgeHours}h)`
      : '';
  const notAdvancing = advancedButUnproductive
    ? 'the gate is not consuming this backlog'
    : 'the gate is not advancing main';
  const lede =
    `\`main\` is ${s.commitsBehind} commits / ~${hoursBehind}h behind \`staging\`${noGreenClause} — ${notAdvancing}, regardless ` +
    `of why (red verdicts, a killed/wedged run, or a wedged routine engine). `;
  // EI-19459452257836856: the remedy is the part that was wrong, and it is read by
  // every agent in the hive at once. Point at the run's OWN authoritative break-set
  // line rather than the old undirected "find whatever is failing" — the agent who
  // mis-fired during the 2026-08-03 stall did exactly that and verified ONE red,
  // never the failing SET.
  const breakSet =
    `its verdict's own AFFECTED_TESTS_FAILING_FILES line names the failing files ` +
    `(read \`coverage\` first — \`files=[]\` means "not attributable", NOT "nothing failed").`;
  if (s.runInFlight === true) {
    const started =
      s.runInFlightElapsedSec != null ? ` (started ~${Math.round(s.runInFlightElapsedSec / 60)}m ago)` : '';
    return {
      stalled: true,
      reason:
        lede +
        `A green-checkpoint run IS IN FLIGHT right now${started} — do NOT launch another: the run lock would refuse ` +
        `it, and firing inside a live run's re-triage window DISCARDS an in-progress rescue and costs a full suite. ` +
        `Wait for this run's verdict (checkpoint:await); if it reds, ${breakSet}`,
    };
  }
  if (s.runInFlight === false) {
    return {
      stalled: true,
      reason:
        lede +
        `No checkpoint run is in flight. Fire a fresh gate run (release:checkpoint-run), then fix what it names — ${breakSet}`,
    };
  }
  // UNKNOWN — never the old unconditional instruction (that is the defect), and
  // never silent suppression either. Alarm, and make the check the first step.
  return {
    stalled: true,
    reason:
      lede +
      `Whether a checkpoint run is currently in flight could NOT be determined here — CHECK FIRST ` +
      `(dev:pipeline_position → gate.checkpointRunInFlight) before launching one: firing inside a live run's ` +
      `re-triage window discards an in-progress rescue. If none is running, fire one — then fix what it names: ${breakSet}`,
  };
}

/** WI-38340: the all-clear text for the main-behind-staging alarm.
 *
 *  The bug that produced this function: the recovery broadcast was a CONSTANT
 *  string asserting `main` was "no longer meaningfully behind staging", emitted
 *  purely off `stalled` flipping false. But `stalled` can flip false via the
 *  recent-advance suppression ALONE, with `commitsBehind` untouched — so on
 *  2026-08-12T23:03Z the fleet was told main had recovered while it was measured
 *  327 commits behind. An all-clear must never claim a property it did not
 *  measure; both arms below state the number they actually read.
 *
 *  The two arms are genuinely different situations and are worded so a reader can
 *  tell them apart:
 *    · caught up  — the backlog really is at/below the alarm threshold.
 *    · suppressed — the alarm is CLEARED, but main is still deep behind; what
 *      changed is that the gate is advancing again. Saying "recovered" flatly
 *      here is the false all-clear this fixes.
 *
 *  Pure + exported for a DB-free regression test, matching the convention
 *  `evaluateMainBehindStaging` / `shouldWarnOnStallClearMiss` already set. */
export function mainBehindRecoverySummary(
  harnessSlug: string,
  s: Pick<MainBehindStagingSnapshot, 'commitsBehind'>,
  opts: { commitsThreshold?: number } = {},
): string {
  const commitsThreshold = opts.commitsThreshold ?? DEFAULT_MAIN_BEHIND_COMMITS;
  const behind = s.commitsBehind;
  // Unmeasurable depth (a branch missing / git error) is its own arm: the alarm is
  // cleared because the signal went unreadable, which is NOT evidence main caught
  // up. Never dress that up as a recovery.
  if (behind == null) {
    return (
      `main-behind-staging alarm CLEARED on ${harnessSlug} — but the staging/main distance could NOT be measured ` +
      `on this pass, so this is not a confirmation that main caught up. Re-check with dev:pipeline_position.`
    );
  }
  if (behind <= commitsThreshold) {
    return `main RECOVERED on ${harnessSlug} — now ${behind} commits behind staging (at/below the ${commitsThreshold} threshold); the earlier stall alarm is stale.`;
  }
  return (
    `main-behind-staging alarm CLEARED on ${harnessSlug}, but main is STILL ${behind} commits behind staging — ` +
    `cleared because the gate has advanced main recently and is consuming the backlog, NOT because main caught up. ` +
    `Do not read this as "the pipeline is fine": re-check the real distance with dev:pipeline_position.`
  );
}

function gitOut(root: string, args: string[]): string | null {
  try {
    // EI-9922 (EI-8794 class): a failing git call — e.g. this watchdog's boot pass
    // running in a PACKAGED install's non-repo dir — must NOT leak "fatal: not a git
    // repository" onto the parent's own stderr/serve.log. `execFileSync`'s default
    // stdio inherits the child's stderr; pin it to ['ignore','pipe','ignore'] so we
    // capture stdout but discard stderr (mirrors build-info.ts / workspace-map.ts).
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Reads the live commits-behind + how-long-behind gap between `main` and
 *  `staging` in `root` via plain git shell-outs — deliberately NOT importing
 *  from apps/operator/lib/release/* (wrong dependency direction for
 *  operator-core; mirrors dev-deploy-state.ts's own self-contained pattern).
 *  Fails open (all-null) on any git error — a missing branch/checkout must
 *  never itself trigger the alarm it's trying to compute. */
export function computeMainBehindStaging(
  root: string,
  mainBranch = 'main',
  stagingBranch = 'staging',
): MainBehindStagingSnapshot {
  const countRaw = gitOut(root, ['rev-list', '--count', `${mainBranch}..${stagingBranch}`]);
  const commitsBehind = countRaw != null && /^\d+$/.test(countRaw) ? Number(countRaw) : null;
  if (commitsBehind == null || commitsBehind === 0) return { commitsBehind: commitsBehind ?? null, behindMs: null };

  // The OLDEST commit reachable from staging but not main — its age is how
  // long main has been behind by at least this much (a fresh-only lag from
  // commits landing in the last minute reads as ~0, not an hours-old stall).
  const oldestTsRaw = gitOut(root, [
    'log',
    `${mainBranch}..${stagingBranch}`,
    '--format=%ct',
    '--reverse',
  ]);
  const oldestTs = oldestTsRaw ? Number(oldestTsRaw.split('\n')[0]) : NaN;
  if (!Number.isFinite(oldestTs)) return { commitsBehind, behindMs: null };
  return { commitsBehind, behindMs: Math.max(0, Date.now() - oldestTs * 1000) };
}

/** EI-10202: read ms-since the green-checkpoint gate last ADVANCED `main` for a
 *  harness (`gate_health.lastGreenAt`, the same field trackGateStall stamps to
 *  Date.now() on every green tick). Fail-soft: any read error / missing routine /
 *  never-greened gate returns null, and evaluateMainBehindStaging then falls back
 *  to the depth+age-only signal — an unreadable gate must never SUPPRESS a real
 *  stall, only a demonstrably-recent green does. */
export async function readGateLastGreenAgeMs(
  sql: Sql,
  installSlug: string,
  nowMs: number,
): Promise<number | null> {
  try {
    const rows = await sql<{ last_green_at: string | number | null }[]>`
      SELECT (metadata->'gate_health'->>'lastGreenAt') AS last_green_at
        FROM harness_shared.routines
       WHERE install_slug = ${installSlug}
         AND target_role = 'system:green-checkpoint'
         AND active = true
       LIMIT 1`;
    const raw = rows[0]?.last_green_at;
    if (raw == null) return null;
    const lastGreenAt = Number(raw);
    if (!Number.isFinite(lastGreenAt)) return null;
    return Math.max(0, nowMs - lastGreenAt);
  } catch {
    return null;
  }
}

/** One watchdog pass for the main-behind-staging guard, scoped to a single git
 *  root (the operator's own home harness — this is a local-git-tree signal,
 *  not a per-tenant DB one, so it does not loop over `harness_shared.routines`
 *  the way `checkGreenStall` does). Reuses the exact alarm plumbing
 *  (notifyAttention + broadcastSevereEvent + harness_escalations) under its OWN
 *  phase so it never clobbers either of the other two conditions' dedup state.
 *  Dedup is the escalation row's own presence — no gate_health flag needed.
 *  Never throws — rides the same interval as checkGreenStall and must not
 *  break it. */
export async function checkMainBehindStaging(
  sql: Sql,
  opts: {
    root?: string;
    harnessSlug?: string;
    workspaceId?: string;
    commitsThreshold?: number;
    msThreshold?: number;
    recentGreenMs?: number;
    /** WI-38340 — threaded straight through to evaluateMainBehindStaging. */
    advanceHorizonMs?: number;
    mainBranch?: string;
    stagingBranch?: string;
  } = {},
): Promise<{ alarmed: boolean; recovered: boolean }> {
  const out = { alarmed: false, recovered: false };
  let passError: unknown;
  try {
    const root =
      opts.root ??
      process.env.PAPERCUSP_INTEGRATION_ROOT ??
      gitOut(process.cwd(), ['rev-parse', '--show-toplevel']) ??
      process.cwd();
    const harnessSlug = opts.harnessSlug ?? 'papercusp';
    const gitSnapshot = computeMainBehindStaging(root, opts.mainBranch, opts.stagingBranch);
    // EI-10202: fold in "has the gate advanced main recently?" so a deep-but-
    // healthy backlog (gate greening every cycle) is not mislabeled STALLED.
    // Only read the DB signal when the git snapshot could even alarm — a quiet
    // in-sync tree short-circuits without touching PG.
    const lastGreenAgeMs =
      gitSnapshot.commitsBehind && gitSnapshot.behindMs != null
        ? await readGateLastGreenAgeMs(sql, harnessSlug, Date.now())
        : null;
    // EI-19459452257836856: is a run in flight RIGHT NOW? Same gating as above —
    // only read when the git snapshot could even alarm. `isCheckpointRunLockHeldCheap`
    // reads only the file-based run-lock's owner.json (no subprocess) and
    // pid-liveness-verifies the owner, so it sees CRON and MANUAL runs alike — both
    // hold the same lock for the run's whole duration. It is documented fail-soft,
    // but this watchdog must never throw, and "unknown" is a real, deliberately
    // distinct arm of the remedy (see MainBehindStagingSnapshot.runInFlight), so a
    // throw degrades to unknown rather than to a wrong `false`.
    let runInFlight: boolean | undefined;
    let runInFlightElapsedSec: number | null | undefined;
    if (gitSnapshot.commitsBehind && gitSnapshot.behindMs != null) {
      try {
        const lock = isCheckpointRunLockHeldCheap(root);
        runInFlight = lock.held;
        runInFlightElapsedSec = lock.elapsedSec;
      } catch {
        runInFlight = undefined; // UNKNOWN — never silently "no run in flight"
      }
    }
    const snapshot: MainBehindStagingSnapshot = {
      ...gitSnapshot,
      lastGreenAgeMs,
      runInFlight,
      runInFlightElapsedSec,
    };
    const verdict = evaluateMainBehindStaging(snapshot, opts);

    const existing = await sql<{ escalation: unknown }[]>`
      SELECT escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${harnessSlug} AND phase = ${MAIN_BEHIND_PHASE}`;
    const alreadyAlarmed = existing.length > 0 && existing[0].escalation != null;

    if (verdict.stalled) {
      if (alreadyAlarmed) return out; // one-shot until recovery, like checkGreenStall
      // EI-10103: harness_escalations.workspace_id is NOT NULL (default ''); this check is
      // single-harness-scoped (unlike checkGreenStall's per-tenant `routines` scan, which
      // gets a real workspace_id off each row) and had no caller ever pass opts.workspaceId,
      // so the insert below explicitly wrote NULL — bypassing the column default (a default
      // only applies when the column is OMITTED, not when it's explicitly set to NULL) and
      // violating the not-null constraint on every real stall, silently swallowed by this
      // function's own outer catch (the watchdog that should escalate a promotion stall
      // could never actually write its escalation). Resolve the real workspace the harness
      // lives in, lazily (only on an actual stall, not every quiet pass); never let a
      // resolution failure block the escalation itself (an empty string falls back to
      // exactly what the column's own default would have been for an unresolvable harness).
      const workspaceId =
        opts.workspaceId ??
        (await resolveWorkspaceForHarness(harnessSlug).catch((e) => {
          console.warn(
            `[main-behind-staging-watchdog] workspace resolution failed for '${harnessSlug}': ${e instanceof Error ? e.message : e}`,
          );
          return '';
        }));
      try {
        const { notifyAttention } = await import('../attention-notify');
        const activeCheckpointRun = snapshot.runInFlight === true;
        await notifyAttention({
          kind: 'intervention',
          // A live checkpoint run keeps the alarm's intervention/remedy path, but
          // its alert classification must not call the promotion pipeline stalled
          // while the protected producer is still delivering a verdict.
          title: activeCheckpointRun
            ? 'Release pipeline ACTIVE — main is falling behind staging while a checkpoint run is in flight'
            : 'Release pipeline STALLED — main is falling behind staging',
          body: verdict.reason ?? '',
          importance: 'urgent',
          workspaceId,
          data: { commitsBehind: snapshot.commitsBehind, behindMs: snapshot.behindMs },
        });
      } catch (e) {
        console.warn(`[main-behind-staging-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
      }
      await broadcastSevereEvent({
        summary:
          snapshot.runInFlight === true
            ? `main is ${snapshot.commitsBehind} commits behind staging on ${harnessSlug} — checkpoint run is active; wait for its verdict before classifying promotion as stalled.`
            : `main is ${snapshot.commitsBehind} commits behind staging on ${harnessSlug} — promotion pipeline stalled.`,
        body: verdict.reason ?? '',
        category: 'severe-event',
        conditionKey: `main-behind-staging:${harnessSlug}`,
        // WI-6228: one-shot until recovery (`alreadyAlarmed` below) — our silence
        // is deliberate, never evidence main caught up.
        oneShot: true,
      });
      await sql`
        INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
        VALUES (${harnessSlug}, ${MAIN_BEHIND_PHASE}, ${JSON.stringify({
          kind: MAIN_BEHIND_PHASE,
          harness_slug: harnessSlug,
          commitsBehind: snapshot.commitsBehind,
          behindMs: snapshot.behindMs,
          detail: verdict.reason,
          emitted_at: Date.now(),
        })}, ${Date.now()}, ${workspaceId})
        ON CONFLICT (harness_slug, phase)
        DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
      out.alarmed = true;
      console.warn(`[main-behind-staging-watchdog] ALARM ${harnessSlug}: ${verdict.reason}`);
    } else if (alreadyAlarmed) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${Date.now()}
         WHERE harness_slug = ${harnessSlug} AND phase = ${MAIN_BEHIND_PHASE} AND escalation IS NOT NULL`;
      await broadcastSevereEventResolved({
        conditionKey: `main-behind-staging:${harnessSlug}`,
        // WI-38340: state the depth we actually measured on THIS pass. The old
        // constant claimed main was "no longer meaningfully behind staging" off
        // nothing but `stalled` going false, and broadcast that to the whole fleet
        // while main was 327 commits behind.
        summary: mainBehindRecoverySummary(harnessSlug, snapshot, opts),
      });
      out.recovered = true;
    }
    return out;
  } catch (e) {
    passError = e;
    console.warn(`[main-behind-staging-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  } finally {
    // Single-install pass. `harnessSlug` is resolved inside the try, so it is re-derived here
    // from `opts` rather than referenced — a throw before its initialiser would otherwise make
    // this `finally` itself throw (TDZ) and replace the pass's return value.
    await recordWatchdogPassOutcome(
      sql,
      'main-behind-staging',
      { routineName: 'green-checkpoint', installSlug: opts.harnessSlug ?? 'papercusp' },
      passError,
    );
  }
}

// ── release-trigger silent-freeze guard (WI-4322) ──────────────────────────────

/** How long release-trigger may sit PAUSED (active:false) while green code is
 *  deployable-but-not-live before this alarms. Default 30 min: this failure mode
 *  (the routine auto-tripped during a deploy incident and never re-enabled
 *  itself — recurred 2026-06-18 + 2026-07-12, both times completely silent) can
 *  NEVER self-recover, so a much tighter window than the other two checks in
 *  this file is correct — a paused routine has no cadence to eventually catch
 *  up on its own, unlike a merely-stalled one. 30 min still absorbs a short
 *  deliberate manual pause (e.g. "pause auto-deploy, I'm fixing the checkout by
 *  hand") without false-alarming on it. `<=0` disables the check. */
const DEFAULT_RELEASE_TRIGGER_FREEZE_MS = 30 * 60 * 1000; // 30 min
const RELEASE_TRIGGER_FREEZE_PHASE = 'release-trigger-freeze-watchdog';

export interface ReleaseTriggerFreezeSnapshot {
  /** the release-trigger routine's `active` flag, or null when the row doesn't
   *  exist (a hive with no deploy target never seeds one — never alarm on that). */
  active: boolean | null;
  /** epoch ms of the routine row's `active_changed_at` — the instant `active` last
   *  FLIPPED, stamped by the `routines_active_changed_at_trg` database trigger
   *  (migration 933), never by application code. null if unresolvable.
   *
   *  ⚠ This used to read `updated_at`, justified by "routines:set is the ONLY writer
   *  of `active`, so updated_at doubles as 'since when it went inactive'". That
   *  invariant was already false — ~8 raw `UPDATE harness_shared.routines` sites stamp
   *  `updated_at` (this file's own watchdogAlerted flips and gate-health-merge's
   *  candidate markers among them), mostly without touching `active`. Every such write
   *  moves the timestamp FORWARD, so the derived age UNDER-stated the pause and the
   *  alarm below fired late or never — the dangerous direction for a guard whose
   *  condition "will NEVER self-clear". EI-21299569563939689. */
  activeChangedAtMs: number | null;
  /** green commits deployable but not live right now
   *  (`release-deploy-launch`'s `computeDeployStatus().deploy.deployedBehindGreenPin`). */
  deployedBehindGreenPin: number | null;
}

export interface ReleaseTriggerFreezeVerdict {
  frozen: boolean;
  reason: string | null;
}

/**
 * WI-4329: WHO paused release-trigger, so an alarm/responder can coordinate with the actual
 * owner instead of blind-toggling it back on (which just fights a still-in-progress protective
 * pause and produces the exact re-disable ping-pong that made WI-4322's recurrence look like an
 * unexplained "auto-disable" for weeks). `routines:set`'s gateway-control audit trail only
 * records `actor: role:${ctx.role}` (e.g. `role:operator`) — never WHICH session — so this reads
 * the richer `harness_shared.tool_invocations` telemetry instead, which carries `coord_owner_id`
 * for every MCP call. Best-effort / fail-soft: a lookup failure or empty history must never block
 * the alarm itself.
 */
export async function lastReleaseTriggerPauseOwner(
  sql: Sql,
): Promise<{ ownerId: string; invokedAtMs: number } | null> {
  try {
    const rows = await sql<{ coord_owner_id: string | null; invoked_at_ms: number | string | null }[]>`
      SELECT coord_owner_id, extract(epoch from invoked_at) * 1000 AS invoked_at_ms
        FROM harness_shared.tool_invocations
       WHERE tool_name = 'routines:set'
         AND status = 'ok'
         AND (args_json->>'name') = 'release-trigger'
         AND (args_json->>'active') = 'false'
       ORDER BY invoked_at DESC
       LIMIT 1`;
    const row = rows[0];
    if (!row?.coord_owner_id) return null;
    const invokedAtMs = row.invoked_at_ms != null ? Number(row.invoked_at_ms) : null;
    if (invokedAtMs == null || Number.isNaN(invokedAtMs)) return null;
    return { ownerId: row.coord_owner_id, invokedAtMs };
  } catch {
    return null;
  }
}

/**
 * Pure: is release-trigger PAUSED while green code is stranded, long enough to
 * call it a silent freeze rather than a normal short pause? Exported for unit
 * testing.
 */
export function evaluateReleaseTriggerFreeze(
  s: ReleaseTriggerFreezeSnapshot,
  now: number,
  opts: { thresholdMs?: number } = {},
): ReleaseTriggerFreezeVerdict {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_RELEASE_TRIGGER_FREEZE_MS;
  if (thresholdMs <= 0) return { frozen: false, reason: null };
  if (s.active !== false) return { frozen: false, reason: null }; // no row, or actively running
  if (s.deployedBehindGreenPin == null || s.deployedBehindGreenPin <= 0) {
    return { frozen: false, reason: null }; // nothing green is waiting — a paused trigger is harmless
  }
  // An unresolvable `active_changed_at` is treated as maximally stale (never assumed
  // fresh) — mirrors evaluateDeployStaleness's handling of a null deployedAtMs
  // in the sibling release-deploy-staleness-watchdog.
  const ageMs = s.activeChangedAtMs != null ? now - s.activeChangedAtMs : Number.POSITIVE_INFINITY;
  if (ageMs <= thresholdMs) return { frozen: false, reason: null };
  const mins = Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null;
  return {
    frozen: true,
    reason:
      `release-trigger has been PAUSED (active:false)${mins != null ? ` for ~${mins}m` : ' — pause duration unknown'} ` +
      `while ${s.deployedBehindGreenPin} green commit(s) are deployable but not live: a SILENT fleet-wide deploy ` +
      `freeze — this exact signature has recurred twice (2026-06-18, 2026-07-12) with no auto-recovery. It will ` +
      `NEVER self-clear (a paused routine has no cadence to catch up on). Resume it: routines:set { name: ` +
      `'release-trigger', active: true }; then expedite with release:deploy { op: 'trigger', confirm: true } if ` +
      `code has been waiting a while.`,
  };
}

/**
 * One watchdog pass for the release-trigger silent-freeze guard, scoped to a
 * single install (mirrors `checkMainBehindStaging`'s single-harness shape —
 * this reads ONE routine row + the deploy pipeline snapshot, not every hive's
 * routines the way `checkGreenStall` scans). Reuses the exact alarm plumbing
 * (notifyAttention + broadcastSevereEvent + harness_escalations) under its OWN
 * phase so it never clobbers either of the other two conditions' dedup state.
 * Never throws — rides the same interval as the other two checks and must not
 * break them.
 */
export async function checkReleaseTriggerFreeze(
  sql: Sql,
  opts: {
    installSlug?: string;
    workspaceId?: string;
    thresholdMs?: number;
  } = {},
): Promise<{ alarmed: boolean; recovered: boolean }> {
  const out = { alarmed: false, recovered: false };
  let passError: unknown;
  try {
    const installSlug = opts.installSlug ?? 'papercusp';
    // `active_changed_at` (migration 933) is stamped by a trigger ONLY when `active` flips, so
    // it keeps accruing across the metadata-only writes that constantly bump `updated_at`.
    // COALESCE is a floor, not a fallback we expect to hit: 933 backfills every existing row and
    // defaults every new one, so this only covers a row inserted by some path that names the
    // column explicitly. `updated_at` under-states the age, so the coalesced value can only ever
    // alarm LATER than the truth, never spuriously.
    const rows = await sql<{ active: boolean; active_changed_at_ms: string | number | null; workspace_id: string }[]>`
      SELECT active,
             extract(epoch from COALESCE(active_changed_at, updated_at)) * 1000 AS active_changed_at_ms,
             workspace_id
        FROM harness_shared.routines
       WHERE install_slug = ${installSlug} AND name = 'release-trigger'
       LIMIT 1`;
    if (rows.length === 0) return out; // no deploy target declared for this hive — nothing to guard

    const workspaceId = opts.workspaceId ?? rows[0].workspace_id;
    const { gitPipelineSnapshot } = await import('../git-pipeline-stats');
    const { computeDeployStatus } = await import('../release-deploy-launch');
    const snap = await gitPipelineSnapshot(installSlug);
    const status = computeDeployStatus(snap);
    const now = Date.now();
    const verdict = evaluateReleaseTriggerFreeze(
      {
        active: rows[0].active,
        activeChangedAtMs:
          rows[0].active_changed_at_ms != null ? Number(rows[0].active_changed_at_ms) : null,
        deployedBehindGreenPin: status.deploy.deployedBehindGreenPin,
      },
      now,
      opts,
    );

    const existing = await sql<{ escalation: unknown }[]>`
      SELECT escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${installSlug} AND phase = ${RELEASE_TRIGGER_FREEZE_PHASE}`;
    const alreadyAlarmed = existing.length > 0 && existing[0].escalation != null;

    if (verdict.frozen) {
      if (alreadyAlarmed) return out; // one-shot until recovery
      // WI-4329: attribute the pause so the alarm reads "coordinate with su-X", not just "someone
      // paused this" — cuts the ping-pong of a responder blind-re-enabling a still-needed pause.
      const pausedBy = await lastReleaseTriggerPauseOwner(sql);
      const pausedByLine = pausedBy
        ? `\n\nLast paused by ${pausedBy.ownerId} (routines:set active:false) at ${new Date(pausedBy.invokedAtMs).toISOString()}. ` +
          `Coordinate with them before re-enabling — a repeated pause is often a deliberate protective hold (e.g. a long-running ` +
          `demo/capture session that a deploy restart would kill), not a stuck bug; blind-toggling it back on just fights their hold.`
        : '';
      const reasonWithOwner = (verdict.reason ?? '') + pausedByLine;
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: 'Release pipeline FROZEN — release-trigger is paused with green code stranded',
          body: reasonWithOwner,
          importance: 'urgent',
          workspaceId,
          data: { deployedBehindGreenPin: status.deploy.deployedBehindGreenPin, pausedBy: pausedBy?.ownerId ?? null },
        });
      } catch (e) {
        console.warn(`[release-trigger-freeze-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
      }
      await broadcastSevereEvent({
        summary: `release-trigger is PAUSED on ${installSlug} with ${status.deploy.deployedBehindGreenPin} green commit(s) stranded — silent fleet-wide deploy freeze.`,
        body: reasonWithOwner,
        category: 'severe-event',
        conditionKey: `release-trigger-freeze:${installSlug}`,
        // WI-6228: one-shot until recovery (`alreadyAlarmed` below) — our silence
        // is deliberate, never evidence the deploy freeze lifted.
        oneShot: true,
      });
      try {
        await sql`
          INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
          VALUES (${installSlug}, ${RELEASE_TRIGGER_FREEZE_PHASE}, ${JSON.stringify({
            kind: RELEASE_TRIGGER_FREEZE_PHASE,
            harness_slug: installSlug,
            deployedBehindGreenPin: status.deploy.deployedBehindGreenPin,
            detail: reasonWithOwner,
            pausedBy: pausedBy?.ownerId ?? null,
            pausedAtMs: pausedBy?.invokedAtMs ?? null,
            emitted_at: now,
          })}, ${now}, ${workspaceId})
          ON CONFLICT (harness_slug, phase)
          DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
      } catch (e) {
        console.warn(`[release-trigger-freeze-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
      }
      out.alarmed = true;
      console.warn(`[release-trigger-freeze-watchdog] ALARM ${installSlug}: ${reasonWithOwner}`);
    } else if (alreadyAlarmed) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${now}
         WHERE harness_slug = ${installSlug} AND phase = ${RELEASE_TRIGGER_FREEZE_PHASE} AND escalation IS NOT NULL`;
      await broadcastSevereEventResolved({
        conditionKey: `release-trigger-freeze:${installSlug}`,
        summary: `release-trigger RECOVERED on ${installSlug} — active again (or nothing green is stranded); the earlier freeze alarm is stale.`,
      });
      out.recovered = true;
    }
    return out;
  } catch (e) {
    passError = e;
    console.warn(`[release-trigger-freeze-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  } finally {
    // Records on the RELEASE-TRIGGER row this pass watches, not on the gate's — an agent
    // investigating release-trigger reads that row, and would never think to look at another.
    await recordWatchdogPassOutcome(
      sql,
      'release-trigger-freeze',
      { routineName: 'release-trigger', installSlug: opts.installSlug ?? 'papercusp' },
      passError,
    );
  }
}

// ── release-trigger fire-staleness guard (EI-14003) ────────────────────────────

/** release-trigger's documented cadence is <=15 min (cron fires every 15 minutes,
 *  seed-release-routines.ts). An ACTIVE routine that hasn't FIRED (`last_fired_at`)
 *  in this long, while green code is deployable-but-not-live, means the tick
 *  engine silently stopped driving it — a DIFFERENT failure mode than
 *  `checkReleaseTriggerFreeze` above, which only catches an EXPLICITLY PAUSED
 *  routine (active:false). This is the fire-staleness half of the same class
 *  `checkGreenStall` already covers for green-checkpoint — release-trigger never
 *  had the equivalent. EI-14003 (2026-07-17, reproduced via journalctl): a real
 *  65-min silent gap (03:34->05:35, cron is 15-min) went completely undetected
 *  because `active` stayed true the whole time (no pause, so
 *  checkReleaseTriggerFreeze never looked at it) and nothing else watches
 *  `last_fired_at` for this specific routine. 30 min = 2x the documented cadence
 *  + jitter headroom, well under the 65-min real gap. Independent of the 60-min
 *  `DEPLOY_BACKOFF_MS` (release-actions.ts): a routine correctly backing off
 *  still TICKS / updates `last_fired_at` every cron fire (`claim.ts` stamps it
 *  unconditionally at claim time, before the target action's own business logic
 *  runs), so a legitimate backoff never trips this false. `<=0` disables the
 *  check. */
const DEFAULT_RELEASE_TRIGGER_FIRE_STALE_MS = RELEASE_TRIGGER_FIRE_STALE_MS;
const RELEASE_TRIGGER_FIRE_STALE_PHASE = 'release-trigger-fire-stale-watchdog';

export interface ReleaseTriggerFireStaleSnapshot {
  /** the release-trigger routine's `active` flag, or null when the row doesn't
   *  exist (never alarm — mirrors ReleaseTriggerFreezeSnapshot). */
  active: boolean | null;
  /** epoch ms of the routine row's `last_fired_at` (claim.ts stamps this
   *  unconditionally on every claimed tick, regardless of whether the action
   *  found work to do) — null if never fired. */
  lastFiredMs: number | null;
  /** green commits deployable but not live right now. */
  deployedBehindGreenPin: number | null;
}

export interface ReleaseTriggerFireStaleVerdict {
  stale: boolean;
  reason: string | null;
}

/**
 * Pure: is release-trigger ACTIVE but silently not firing on its documented
 * cadence, while green code is stranded? Exported for unit testing.
 */
export function evaluateReleaseTriggerFireStale(
  s: ReleaseTriggerFireStaleSnapshot,
  now: number,
  opts: { thresholdMs?: number } = {},
): ReleaseTriggerFireStaleVerdict {
  return evaluateReleaseTriggerFireStaleShared(s, now, {
    thresholdMs: opts.thresholdMs ?? DEFAULT_RELEASE_TRIGGER_FIRE_STALE_MS,
  });
}

/**
 * One watchdog pass for the release-trigger fire-staleness guard. Mirrors
 * `checkReleaseTriggerFreeze`'s shape (own routine-row read, own alarm plumbing,
 * own escalation phase/conditionKey so it never clobbers the paused-freeze
 * check's dedup state) but keys off `last_fired_at` instead of `updated_at`, and
 * fires on `active:true` instead of `active:false` — the two are deliberately
 * independent checks, not a shared branch, so each debounces on its own
 * transition. Never throws — rides the same interval as the other checks.
 */
export async function checkReleaseTriggerFireStale(
  sql: Sql,
  opts: { installSlug?: string; workspaceId?: string; thresholdMs?: number } = {},
): Promise<{ alarmed: boolean; recovered: boolean }> {
  const out = { alarmed: false, recovered: false };
  let passError: unknown;
  try {
    const installSlug = opts.installSlug ?? 'papercusp';
    const rows = await sql<{ active: boolean; last_fired_ms: string | number | null; workspace_id: string }[]>`
      SELECT active, extract(epoch from last_fired_at) * 1000 AS last_fired_ms, workspace_id
        FROM harness_shared.routines
       WHERE install_slug = ${installSlug} AND name = 'release-trigger'
       LIMIT 1`;
    if (rows.length === 0) return out; // no deploy target declared for this hive — nothing to guard

    const workspaceId = opts.workspaceId ?? rows[0].workspace_id;
    const { gitPipelineSnapshot } = await import('../git-pipeline-stats');
    const { computeDeployStatus } = await import('../release-deploy-launch');
    const snap = await gitPipelineSnapshot(installSlug);
    const status = computeDeployStatus(snap);
    const now = Date.now();
    const verdict = evaluateReleaseTriggerFireStale(
      {
        active: rows[0].active,
        lastFiredMs: rows[0].last_fired_ms != null ? Number(rows[0].last_fired_ms) : null,
        deployedBehindGreenPin: status.deploy.deployedBehindGreenPin,
      },
      now,
      opts,
    );

    const existing = await sql<{ escalation: unknown }[]>`
      SELECT escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${installSlug} AND phase = ${RELEASE_TRIGGER_FIRE_STALE_PHASE}`;
    const alreadyAlarmed = existing.length > 0 && existing[0].escalation != null;

    if (verdict.stale) {
      if (alreadyAlarmed) return out; // one-shot until recovery
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: 'Release pipeline STALLED — release-trigger has stopped firing on cadence',
          body: verdict.reason ?? '',
          importance: 'urgent',
          workspaceId,
          data: { deployedBehindGreenPin: status.deploy.deployedBehindGreenPin },
        });
      } catch (e) {
        console.warn(`[release-trigger-fire-stale-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
      }
      await broadcastSevereEvent({
        summary: `release-trigger has gone silent on ${installSlug} — ${status.deploy.deployedBehindGreenPin} green commit(s) stranded.`,
        body: verdict.reason ?? '',
        category: 'severe-event',
        conditionKey: `release-trigger-fire-stale:${installSlug}`,
        // WI-6228: one-shot until recovery (`alreadyAlarmed` below) — our silence
        // is deliberate, never evidence release-trigger started firing again.
        oneShot: true,
      });
      try {
        await sql`
          INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
          VALUES (${installSlug}, ${RELEASE_TRIGGER_FIRE_STALE_PHASE}, ${JSON.stringify({
            kind: RELEASE_TRIGGER_FIRE_STALE_PHASE,
            harness_slug: installSlug,
            deployedBehindGreenPin: status.deploy.deployedBehindGreenPin,
            detail: verdict.reason,
            emitted_at: now,
          })}, ${now}, ${workspaceId})
          ON CONFLICT (harness_slug, phase)
          DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
      } catch (e) {
        console.warn(`[release-trigger-fire-stale-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
      }
      out.alarmed = true;
      console.warn(`[release-trigger-fire-stale-watchdog] ALARM ${installSlug}: ${verdict.reason}`);
    } else if (alreadyAlarmed) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${now}
         WHERE harness_slug = ${installSlug} AND phase = ${RELEASE_TRIGGER_FIRE_STALE_PHASE} AND escalation IS NOT NULL`;
      await broadcastSevereEventResolved({
        conditionKey: `release-trigger-fire-stale:${installSlug}`,
        summary: `release-trigger RECOVERED on ${installSlug} — firing on cadence again (or nothing green is stranded); the earlier stall alarm is stale.`,
      });
      out.recovered = true;
    }
    return out;
  } catch (e) {
    passError = e;
    console.warn(`[release-trigger-fire-stale-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  } finally {
    await recordWatchdogPassOutcome(
      sql,
      'release-trigger-fire-stale',
      { routineName: 'release-trigger', installSlug: opts.installSlug ?? 'papercusp' },
      passError,
    );
  }
}

// ── WI-10002439: the frozen-repair-queue AGE alarm that P-010 promised and nothing fired ──
//
// P-010 (frozen-candidate-repair-queue.ts, `FROZEN_REPAIR_AGE_ESCALATION_INTERVAL_MS`) deleted
// the 8h age budget as "an automatic retirement in disguise" and replaced it with prose: "the
// gate escalates when the queue crosses 8h and again at every further 8h rung, clearing
// nothing". The rung is computed (`frozenRepairAgeEscalationRung`, surfaced on the diagnostic as
// `ageEscalationRung`) but NO production code read it — so a queue stranded at `awaiting-fixer`
// for ~40h (EI-23917645695738835) raised nothing and surfaced only because a human noticed.
//
// This pass IS that escalation. It reads the rung the queue module already computes — it does
// not re-derive age — and fires once per rung crossed, never clearing, blocking or retiring
// anything (P-010's contract: an alert cadence only). Fixer liveness comes from the canonical
// tri-state `releaseFixerSpawnAlive` (task-ledger keyed), NOT from a heartbeat: the fixer is a
// release-fixer spawn, and a stale-heartbeat-but-alive reading is exactly what that reader was
// built to avoid.
//
// DELIBERATELY NOT A TRIGGER: manifest `pathless` rows. `RepairManifestSummary.pathless` is
// documented as "a fixer must name the paths by hand" — admittable, not unreachable — so alarming
// on it would fire on healthy queues. Manifest counts are REPORTED in the alarm text only.
const STRANDED_REPAIR_QUEUE_PHASE = 'stranded-repair-queue-watchdog';

export interface StrandedRepairQueueSnapshot {
  candidate: string;
  phase: string;
  ageMs: number;
  /** `frozenRepairAgeEscalationRung` — 0 while under 8h, then +1 per further 8h. */
  ageEscalationRung: number;
  attempts: number;
  fixerSpawnId: string | null;
  /** true = live, false = definitively dead, null = unknown / no fixer recorded. */
  fixerAlive: boolean | null;
  /** Independent gate-owner oracle; null means ownership could not be measured. */
  gateOwnership: GateOwnershipAssessment | null;
  /** The queue policy's own current decision kind (e.g. 'wait-for-fixer', 'hold-exhausted'). */
  decision: string;
  manifest: { legs: number; red: number; admitted: number; green: number; pathless: number } | null;
}

export interface StrandedRepairQueueVerdict {
  alarm: boolean;
  /** The rung this verdict is about; the check re-alarms only when this INCREASES. */
  rung: number;
  /** awaiting-fixer with neither a live fixer nor a live gate owner. */
  stranded: boolean;
  reason: string | null;
}

/** PURE. Alarm on any open frozen queue that has crossed an 8h age rung (P-010's contract). */
export function evaluateStrandedRepairQueue(s: StrandedRepairQueueSnapshot | null): StrandedRepairQueueVerdict {
  if (!s || !Number.isFinite(s.ageEscalationRung) || s.ageEscalationRung < 1) {
    return { alarm: false, rung: 0, stranded: false, reason: null };
  }
  const ownerAbsent = s.gateOwnership === 'unowned' || s.gateOwnership === 'claimable' ||
    s.gateOwnership === 'lease-expired' || s.gateOwnership === 'held-by-ended-session';
  const fixerAbsent = !s.fixerSpawnId || s.fixerAlive === false;
  const stranded = s.phase === 'awaiting-fixer' && fixerAbsent && ownerAbsent;
  const hours = Math.round(s.ageMs / 3_600_000);
  const fixer = !s.fixerSpawnId
    ? 'NO fixer recorded'
    : s.fixerAlive === false
      ? `fixer ${s.fixerSpawnId} is DEAD`
      : s.fixerAlive === true
        ? `fixer ${s.fixerSpawnId} is live`
        : `fixer ${s.fixerSpawnId} liveness UNKNOWN`;
  const m = s.manifest
    ? ` Manifest: ${s.manifest.legs} leg(s) — ${s.manifest.red} red, ${s.manifest.admitted} admitted, ${s.manifest.green} green` +
      `${s.manifest.pathless ? `, ${s.manifest.pathless} pathless (paths must be named by hand)` : ''}.`
    : ' No repair manifest persisted.';
  return {
    alarm: true,
    rung: s.ageEscalationRung,
    stranded,
    reason:
      `Frozen candidate ${s.candidate.slice(0, 12)} has held main for ~${hours}h in phase '${s.phase}' ` +
      `(age rung ${s.ageEscalationRung}, ${s.attempts} fixer attempt(s); ${fixer}; ` +
      `gate ownership ${s.gateOwnership ?? 'UNKNOWN'}; queue decision '${s.decision}').` +
      m +
      (stranded
        ? ' STRANDED SHAPE: awaiting a fixer with none live — the queue cannot leave awaiting-fixer until one ' +
          'is dispatched or a fix is admitted. '
        : ' ') +
      `Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): ` +
      `land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented ` +
      `unreachable-green test.`,
  };
}

/**
 * One watchdog pass for the frozen-queue age escalation. Same shape as its siblings: own read,
 * own escalation row keyed by `STRANDED_REPAIR_QUEUE_PHASE`, one-shot per (candidate, rung) and
 * a resolved broadcast when the queue closes. Never throws.
 */
export async function checkStrandedRepairQueue(
  sql: Sql,
  opts: { installSlug?: string; workspaceId?: string; nowMs?: number } = {},
): Promise<{ alarmed: boolean; recovered: boolean }> {
  const out = { alarmed: false, recovered: false };
  const installSlug = opts.installSlug ?? 'papercusp';
  let passError: unknown;
  try {
    const rows = await sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.routines
       WHERE install_slug = ${installSlug} AND target_role = 'system:green-checkpoint'
       LIMIT 1`;
    if (rows.length === 0) return out;
    const workspaceId = opts.workspaceId ?? rows[0].workspace_id;
    const now = opts.nowMs ?? Date.now();

    const { readFrozenCandidateRepairQueueState } = await import('../harness/routines/release-actions');
    const { diagnoseFrozenCandidateRepairQueue } = await import('./frozen-candidate-repair-queue');
    const { releaseFixerSpawnAlive } = await import('./fixer-liveness');
    const { readGateOwnership } = await import('../coord/gate-ownership');
    const read = await readFrozenCandidateRepairQueueState({ workspaceId, installSlug });
    const queue = read.status === 'value' ? read.queue : null;
    const fixerAlive = queue?.fixerSpawnId
      ? await releaseFixerSpawnAlive(sql as never, queue.fixerSpawnId).catch(() => null)
      : null;
    const diag = diagnoseFrozenCandidateRepairQueue(queue, { nowMs: now, fixerAlive });
    const gateOwnership = diag
      ? await readGateOwnership({ harness: installSlug }).then((ownership) => ownership.assessment).catch(() => null)
      : null;
    const verdict = evaluateStrandedRepairQueue(
      diag
        ? {
            candidate: diag.candidate,
            phase: queue!.phase,
            ageMs: diag.ageMs,
            ageEscalationRung: diag.ageEscalationRung,
            attempts: diag.attempts,
            fixerSpawnId: diag.fixerSpawnId,
            fixerAlive: diag.fixerAlive,
            gateOwnership,
            decision: diag.decision,
            manifest: diag.manifestSummary,
          }
        : null,
    );

    const existing = await sql<{ escalation: { candidate?: string; rung?: number; stranded?: boolean } | null }[]>`
      SELECT escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${installSlug} AND phase = ${STRANDED_REPAIR_QUEUE_PHASE}`;
    const prior = existing[0]?.escalation ?? null;
    const conditionKey = `stranded-repair-queue:${installSlug}`;

    if (verdict.alarm && diag) {
      // One-shot per rung: re-alarm only when the rung climbs or a DIFFERENT candidate froze.
      if (prior && prior.candidate === diag.candidate && (prior.rung ?? 0) >= verdict.rung) {
        // A previous pass may have labelled this age alarm stranded before the gate owner was
        // measured. Correct the durable diagnosis without sending another age-rung alert.
        if (prior.stranded !== verdict.stranded) {
          await sql`
            UPDATE harness_shared.harness_escalations
               SET escalation = ${JSON.stringify({ ...prior, stranded: verdict.stranded, detail: verdict.reason, corrected_at: now })},
                   mtime_ms = ${now}
             WHERE harness_slug = ${installSlug} AND phase = ${STRANDED_REPAIR_QUEUE_PHASE}`;
        }
        return out;
      }
      const title = verdict.stranded
        ? `Frozen repair queue STRANDED ~${Math.round(diag.ageMs / 3_600_000)}h — awaiting a fixer, none live`
        : `Frozen repair queue has held main ~${Math.round(diag.ageMs / 3_600_000)}h`;
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title,
          body: verdict.reason ?? '',
          importance: verdict.stranded ? 'urgent' : 'normal',
          workspaceId,
          data: { candidate: diag.candidate, rung: verdict.rung, stranded: verdict.stranded },
        });
      } catch (e) {
        console.warn(`[stranded-repair-queue-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
      }
      await broadcastSevereEvent({
        summary: `${title} on ${installSlug}.`,
        body: verdict.reason ?? '',
        category: 'severe-event',
        conditionKey,
        oneShot: true,
      });
      try {
        await sql`
          INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
          VALUES (${installSlug}, ${STRANDED_REPAIR_QUEUE_PHASE}, ${JSON.stringify({
            kind: STRANDED_REPAIR_QUEUE_PHASE,
            harness_slug: installSlug,
            candidate: diag.candidate,
            rung: verdict.rung,
            stranded: verdict.stranded,
            detail: verdict.reason,
            emitted_at: now,
          })}, ${now}, ${workspaceId})
          ON CONFLICT (harness_slug, phase)
          DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
      } catch (e) {
        console.warn(`[stranded-repair-queue-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
      }
      out.alarmed = true;
      console.warn(`[stranded-repair-queue-watchdog] ALARM ${installSlug}: ${verdict.reason}`);
    } else if (prior && (!diag || diag.candidate !== prior.candidate)) {
      // Resolved only when that frozen candidate is GONE (green, promoted, or owner-retired) —
      // never merely because a rung has not been crossed yet on a newer queue.
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${now}
         WHERE harness_slug = ${installSlug} AND phase = ${STRANDED_REPAIR_QUEUE_PHASE} AND escalation IS NOT NULL`;
      await broadcastSevereEventResolved({
        conditionKey,
        summary: `Frozen candidate ${String(prior.candidate ?? '').slice(0, 12)} on ${installSlug} is no longer held — the age alarm is stale.`,
      });
      out.recovered = true;
    }
    return out;
  } catch (e) {
    passError = e;
    console.warn(`[stranded-repair-queue-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  } finally {
    await recordWatchdogPassOutcome(sql, 'stranded-repair-queue', { routineName: 'green-checkpoint', installSlug }, passError);
  }
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the watchdog: an immediate boot check + a recurring process-level sweep.
 * Idempotent (a second call replaces the timer). Kill-switch:
 * PAPERCUSP_GREEN_STALL_WATCHDOG='0'. The timer is unref'd so it never keeps the
 * process alive on shutdown.
 */
export function startGreenStallWatchdog(
  sql: Sql,
  opts: GreenStallThresholds & { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_GREEN_STALL_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;

  // D-003 (gate-verdict-liveness-and-repair-reliability-2026-08-31): the production watchdog
  // is where actuation gets its real dependencies. A bare checkGreenStall(sql) call (unit
  // tests, ad-hoc probes) stays advisory-only by default — see GreenStallThresholds.
  const wired: GreenStallThresholds & { intervalMs?: number } = {
    ...opts,
    readGateFireWall: opts.readGateFireWall ?? readGateFireOwnerWall,
    launchCheckpoint: opts.launchCheckpoint ?? (() => launchDetachedCheckpoint()),
  };

  const run = (): void => {
    void checkGreenStall(sql, wired).then((r) => {
      if (r.alarmed.length > 0) {
        console.warn(`[green-stall-watchdog] alarmed on: ${r.alarmed.join(', ')}`);
      }
    });
    // EI-9762: independent of the above — see checkMainBehindStaging's own doc
    // for why this can't share its DB-row loop. Failure here must never affect
    // the check above (each is wrapped/caught independently).
    void checkMainBehindStaging(sql);
    // WI-4322: release-trigger auto-disabling during a deploy incident and never
    // self-re-enabling has recurred twice (2026-06-18, 2026-07-12) with zero
    // detection either time — same independent-of-the-routine-engine rationale
    // as the two checks above (this is a process-level watcher, not a DBOS
    // routine, specifically so it can catch a routine going silently dark).
    void checkReleaseTriggerFreeze(sql);
    // EI-14003: release-trigger can go silent (stop firing on its <=15min cadence)
    // WITHOUT ever being paused (active stays true) — checkReleaseTriggerFreeze
    // above cannot see that case at all (it only looks at active:false). Same
    // independent-of-the-routine-engine rationale as the checks above.
    void checkReleaseTriggerFireStale(sql);
    // WI-10002439: P-010 promised an 8h-rung age escalation for a held frozen candidate and
    // nothing fired it — a queue sat awaiting-fixer ~40h silently. Independent for the same
    // reason as the checks above: a stranded queue produces no verdict for the gate to react to.
    void checkStrandedRepairQueue(sql);
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('green-stall-watchdog', intervalMs, run, { category: 'watchdog' });
}
