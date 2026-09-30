import type { GovernorStateSnapshot } from './state-snapshot';

/**
 * P-003 of plan `spawn-door-governor-migration-2026-08-31` — OBSERVE-ONLY.
 *
 * `spawnAgentInHarness` is a second agent-spawn door that never crosses the
 * governor admission seam (WI-590490). Before any caller is bound to that seam,
 * we record the decision the governor WOULD have made: bind nothing, reject
 * nothing. P-004 then derives the numbers that decide whether Phase 3 is safe —
 * spawn rate, burst shape, per-caller distribution, and above all the worst-case
 * wait a live admit would have imposed on a RECOVERY spawn (plan D-003).
 *
 * THIS MODULE IS PURE ON PURPOSE. Every signal is injected, there is no I/O, and
 * nothing here can throw into a spawn path — the counterfactual is the part worth
 * unit-testing, and it must be testable without a database or a live host. The
 * best-effort persistence lives in the writer beside it (D-009).
 */

export const SPAWN_GOVERNOR_OBSERVATION_VERSION = 1 as const;

/** The class an agent spawn would be admitted under. */
export const SPAWN_OBSERVATION_ADMISSION_CLASS = 'agent';

/** What `admitSpawn` ACTUALLY did — the door's own atomic ceiling, not the governor's. */
export type SpawnDoorOutcome = 'admitted' | 'over_cap' | 'duplicate' | 'unknown';

/**
 * What the governor WOULD have done. `unknown` is a first-class, branchable
 * answer — NOT a synonym for `admit`. A missing or stale snapshot means we have
 * no opinion, and recording that honestly is the whole point: P-004 must be able
 * to exclude no-opinion samples rather than silently counting them as admits and
 * concluding the governor would never have blocked anything.
 */
export type GovernorWouldAdmit = 'admit' | 'constrained' | 'paused' | 'unknown';

export type SpawnObservationCaveat =
  | 'governor-snapshot-absent'
  | 'governor-snapshot-stale'
  | 'governor-admission-state-unknown'
  | 'queue-drain-rate-unknown'
  | 'caller-attribution-unavailable';

export interface SpawnObservationInput {
  readonly nowMs: number;
  readonly doorOutcome: SpawnDoorOutcome;
  /** The door's global safety cap at decision time (`spawnConcurrencyCeiling()`). */
  readonly doorCap: number;
  /** The bee-only secondary cap, when one applied. */
  readonly doorRoleCap: number | null;
  readonly parentRole: string;
  readonly childRole: string;
  readonly fleetSlug: string | null;
  readonly planSlug: string | null;
  /**
   * DESCRIPTIVE callsite label (D-011). `null` when the caller did not identify
   * itself, which is recorded as `caller-attribution-unavailable` rather than
   * guessed at from `parentRole` (distinct callers share a role, so a role split
   * would merge them and be misread as a per-caller distribution).
   */
  readonly caller?: string | null;
  /** `null` when the published snapshot was unreadable or too old to trust. */
  readonly snapshot: GovernorStateSnapshot | null;
}

export interface SpawnGovernorObservation {
  readonly version: typeof SPAWN_GOVERNOR_OBSERVATION_VERSION;
  readonly observedAtMs: number;
  readonly door: {
    readonly outcome: SpawnDoorOutcome;
    readonly cap: number;
    readonly roleCap: number | null;
    readonly parentRole: string;
    readonly childRole: string;
    readonly fleetSlug: string | null;
    readonly planSlug: string | null;
    /** Descriptive callsite label (D-011); `null` when the caller did not say. */
    readonly caller: string | null;
  };
  readonly governor: {
    readonly wouldAdmit: GovernorWouldAdmit;
    readonly admissionState: string | null;
    readonly reason: string | null;
    readonly classConstrained: boolean | null;
    readonly snapshotAgeMs: number | null;
    readonly snapshotGeneration: number | null;
    /** Queue depth for the agent class, when the snapshot reports it. */
    readonly classQueueDepth: number | null;
    /**
     * Estimated wait a live admit would have imposed, derived as
     * depth / drainRate. `null` whenever either input is unknown — an unknown
     * wait must never render as 0, which would read as "no delay measured".
     */
    readonly estimatedWaitMs: number | null;
  };
  /**
   * The headline signal for P-004: did the door's real outcome AGREE with what
   * the governor would have done? `true` means this spawn went through a door
   * the governor would have held — i.e. an admission the seam would not have
   * made. `null` when we had no opinion.
   */
  readonly divergedFromGovernor: boolean | null;
  readonly caveats: readonly SpawnObservationCaveat[];
}

function agentClassQueue(snapshot: GovernorStateSnapshot) {
  return (
    snapshot.queue.byClass.find(
      (row) => row.admissionClass === SPAWN_OBSERVATION_ADMISSION_CLASS,
    ) ?? null
  );
}

/**
 * PURE. Build the observe-only receipt for one spawn.
 *
 * Deliberately does NOT consult the clock, the database, or the environment:
 * pass `nowMs` and `snapshot`. Callers that cannot obtain a snapshot pass
 * `null` and get an honest `unknown` rather than a fabricated verdict.
 */
export function buildSpawnGovernorObservation(
  input: SpawnObservationInput,
): SpawnGovernorObservation {
  const caveats: SpawnObservationCaveat[] = [];
  // D-011: the caller states its own identity via the descriptive `spawnCaller`
  // label. When it does not, say so — `parentRole` is NOT a fallback, because
  // several distinct callsites share the role 'operator' and splitting on it
  // would merge them into what P-004 would then read as a per-caller split.
  if (!input.caller) caveats.push('caller-attribution-unavailable');

  const snapshot = input.snapshot;
  if (!snapshot) {
    caveats.push('governor-snapshot-absent');
    return {
      version: SPAWN_GOVERNOR_OBSERVATION_VERSION,
      observedAtMs: input.nowMs,
      door: {
        outcome: input.doorOutcome,
        cap: input.doorCap,
        roleCap: input.doorRoleCap,
        parentRole: input.parentRole,
        childRole: input.childRole,
        fleetSlug: input.fleetSlug,
        planSlug: input.planSlug,
        // `||` not `??` on purpose: an empty label is a caller that failed to
        // identify itself, and must normalize to null so it cannot become a
        // distinct `""` bucket in P-004's per-caller distribution. Kept in step
        // with the falsy `!input.caller` caveat check above.
        caller: input.caller || null,
      },
      governor: {
        wouldAdmit: 'unknown',
        admissionState: null,
        reason: null,
        classConstrained: null,
        snapshotAgeMs: null,
        snapshotGeneration: null,
        classQueueDepth: null,
        estimatedWaitMs: null,
      },
      divergedFromGovernor: null,
      caveats,
    };
  }

  const snapshotAgeMs = input.nowMs - snapshot.observedAtMs;
  if (input.nowMs > snapshot.validUntilMs) caveats.push('governor-snapshot-stale');

  const state = snapshot.admission.state;
  const classConstrained =
    state === null
      ? null
      : snapshot.admission.constrainedClasses.includes(SPAWN_OBSERVATION_ADMISSION_CLASS);

  let wouldAdmit: GovernorWouldAdmit;
  if (state === null) {
    wouldAdmit = 'unknown';
    caveats.push('governor-admission-state-unknown');
  } else if (state === 'paused') {
    wouldAdmit = 'paused';
  } else if (state === 'constrained') {
    // `constrained` is per-class: the governor can be constraining a DIFFERENT
    // class while agent spawns still flow. Treating a global 'constrained' as an
    // agent hold would over-report divergence and make Phase 3 look far more
    // dangerous than it is.
    wouldAdmit = classConstrained ? 'constrained' : 'admit';
  } else {
    wouldAdmit = 'admit';
  }

  const classQueue = agentClassQueue(snapshot);
  const depth = classQueue?.depth ?? null;
  const drainRate = classQueue?.drainRatePerSec ?? null;
  let estimatedWaitMs: number | null = null;
  if (depth !== null && drainRate !== null && drainRate > 0) {
    estimatedWaitMs = Math.round((depth / drainRate) * 1000);
  } else if (depth !== null && depth > 0) {
    // Work is queued but we cannot say how fast it drains. A zero here would be
    // a lie in the most consequential direction, so stay null and say why.
    caveats.push('queue-drain-rate-unknown');
  }

  const divergedFromGovernor =
    wouldAdmit === 'unknown'
      ? null
      : input.doorOutcome === 'admitted' && wouldAdmit !== 'admit';

  return {
    version: SPAWN_GOVERNOR_OBSERVATION_VERSION,
    observedAtMs: input.nowMs,
    door: {
      outcome: input.doorOutcome,
      cap: input.doorCap,
      roleCap: input.doorRoleCap,
      parentRole: input.parentRole,
      childRole: input.childRole,
      fleetSlug: input.fleetSlug,
      planSlug: input.planSlug,
      // `||` not `??`: an empty label is a caller that failed to identify itself
      // and must normalize to null, never a distinct `""` bucket in P-004's
      // per-caller distribution. Kept in step with the `!input.caller` caveat.
      caller: input.caller || null,
    },
    governor: {
      wouldAdmit,
      admissionState: state,
      reason: snapshot.admission.reason,
      classConstrained,
      snapshotAgeMs,
      snapshotGeneration: snapshot.admission.generation ?? snapshot.generation,
      classQueueDepth: depth,
      estimatedWaitMs,
    },
    divergedFromGovernor,
    caveats,
  };
}
