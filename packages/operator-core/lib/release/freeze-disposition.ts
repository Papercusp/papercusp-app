/**
 * Pure projection of "what did the gate just do with freeze-and-converge, and WHY" into the
 * `gate_health.freezeAndConverge` blob every status surface reads.
 *
 * WHY THIS EXISTS (WI-2141736 P-004, measured 2026-09-02)
 * -------------------------------------------------------
 * Freeze-and-converge was effectively OFF fleet-wide for a full day — 20 frozen candidates
 * retired, 0 resumed — and the ONLY evidence of it was a grep across per-run checkpoint
 * logs. Nothing a reader could query said so. `release:deploy status` showed `repairQueue`,
 * which is null precisely when a candidate has just been retired, so the surface was
 * silent in exactly the state that mattered; and a run log is not a read.
 *
 * So the disposition is recorded as STATE, not narration. Two properties earn it a place
 * here rather than on `CheckpointResult`:
 *
 *  · It must survive the queue it describes. A retire CLEARS the queue row, so anything
 *    hanging off `repairQueue` disappears at the moment it becomes interesting — the same
 *    reasoning that put `fossilAbandonment` on the result (EI-21763163890991789), one level
 *    further out.
 *  · It must survive a run that goes on to render an ordinary verdict. A retire does not
 *    return early: the gate retires the queue and continues to judge a fresh tip, and that
 *    terminal return does not pass through the result wrapper the hold paths use.
 *
 * This module performs no git, filesystem, database, or process work.
 */

import {
  describeUnreadableFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueueRead,
  type FrozenRepairLatency,
  type FrozenRepairLatencySource,
  frozenRepairLatency,
} from './frozen-candidate-repair-queue';

/**
 * What the gate did with freeze-and-converge on this tick.
 *
 * ⚠ `off` and `none` are NOT synonyms and conflating them is the misread this whole item
 * exists to prevent: `off` means the owner switched the mechanism off (D-007's flag), while
 * `none` means the mechanism is on and simply had no frozen candidate to act on — a green
 * gate's normal state. Rendering both as "not freezing" is how a day of silent suppression
 * looked like an ordinary week.
 */
export type FreezeAndConvergeState =
  /** The owner-visible off switch is OFF; reds do not freeze a candidate at all. */
  | 'off'
  /** Enabled, but this tick had no frozen candidate — nothing to hold or retire. */
  | 'none'
  /** A frozen candidate is being HELD: no verdict, no queue mutation, re-measured next tick. */
  | 'held'
  /** A frozen candidate was RETIRED this tick; the gate falls through to a fresher candidate. */
  | 'retired'
  /** A frozen candidate is live and being repaired (fixer dispatched, or repairHead advancing). */
  | 'converging'
  /** A persisted queue exists, but this build cannot interpret it. Never equivalent to `none`. */
  | 'unreadable';

export interface FreezeAndConvergeDisposition {
  /** Is the mechanism switched on at all? False ONLY for state 'off'. */
  enabled: boolean;
  /** P-007 (R-7): the repair path's latencies, derived from the queue the tick ended holding. */
  repairLatency?: FrozenRepairLatency | null;
  state: FreezeAndConvergeState;
  /**
   * One line answering "why is it in that state". This is the sentence that previously
   * existed only inside a run log, and it is the entire point of the record — a state
   * without its reason still sends a reader back to the logs.
   */
  reason: string;
  /** The frozen candidate this disposition is about, when there is one. */
  candidate?: string | null;
  /** `held` only: the epoch ms at which the hold gives up and retires anyway. */
  holdUntilMs?: number | null;
  /** `held` only: when the measured provider wall is expected to lift. */
  capacityRetryAtMs?: number | null;
}

/** The shape merged into `gate_health` (a SHALLOW merge — never a replace). */
export interface FreezeAndConvergeGateHealth {
  freezeAndConverge: {
    enabled: boolean;
    state: FreezeAndConvergeState;
    reason: string;
    candidate: string | null;
    holdUntilMs: number | null;
    capacityRetryAtMs: number | null;
    /**
     * When this disposition was observed. Load-bearing, not decoration: without it a
     * reader cannot tell a CURRENT `retired` from one left behind by a run hours ago,
     * and a stale disposition read as live is worse than none — it is the false-green
     * class (WI-6228) applied to the freeze.
     */
    observedAtMs: number;
    /** P-007 (R-7): `gate_health.freezeAndConverge.repairLatency` — null when the tick held no readable queue. */
    repairLatency?: FrozenRepairLatency | null;
  };
}

/** How long a stored disposition may be trusted as describing the CURRENT tick. */
export const FREEZE_DISPOSITION_FRESH_MS = 3 * 60 * 60 * 1_000;

/**
 * The durable frozen-repair latency ledger kind (migration 1167) — R-7 /
 * EI-23420599799124840.
 *
 * ⚠ A SEPARATE kind, for the same reason migration 1054 gave the fire anchor: consumers
 * that treat "a `green_checkpoint` row exists" as "an outcome happened" (green-stall-
 * watchdog's last_verdict_ms clock, readLastGateRunEvidence, lost-wake reconciliation, the
 * /admin window summary) must not see these. Nor may they ride `green_checkpoint_fire`,
 * whose rows reconstructGateFireDays COUNTS AS FIRES — a per-disposition latency row there
 * would inflate the very count that reconstruction exists to make trustworthy.
 */
export const GATE_REPAIR_LATENCY_KIND = 'green_checkpoint_repair_latency' as const;

/** One durable ledger row: the repair latencies a single tick actually held. */
export interface GateRepairLatencyLedgerRow {
  status: FreezeAndConvergeState;
  detail: {
    candidate: string | null;
    reason: string;
    observedAtMs: number;
    repairLatency: FrozenRepairLatency;
  };
}

/**
 * PURE: project a disposition into the durable latency ledger row, or `null` when this tick
 * has nothing measurable to record.
 *
 * WHY THIS EXISTS. `buildFreezeAndConvergeGateHealth` publishes the same numbers into a
 * single MUTABLE slot (`gate_health.freezeAndConverge.repairLatency`) that the next tick
 * shallow-merges over and a retire legitimately nulls — so the figures R-7 requires to be
 * "measurable, not anecdotal" survive only until the queue closes, which is precisely when a
 * postmortem wants them. Measured 2026-09-16: zero rows in pipeline_events had ever carried
 * them (positive control passed), i.e. every repair cycle's latencies to date are gone.
 *
 * RETURNS NULL rather than an empty row when the tick held no readable queue: a ledger whose
 * rows can mean "nothing was measured" is one a reader must second-guess, and an hourly null
 * row would bury the ticks that did measure something under ~24 empty rows a day.
 */
export function buildGateRepairLatencyLedgerRow(
  disposition: FreezeAndConvergeDisposition,
  observedAtMs: number,
): GateRepairLatencyLedgerRow | null {
  const repairLatency = disposition.repairLatency;
  if (!repairLatency) return null;
  return {
    status: disposition.state,
    detail: {
      candidate: disposition.candidate ?? null,
      reason: disposition.reason,
      observedAtMs,
      repairLatency,
    },
  };
}

/**
 * PURE: project a disposition into the gate_health fragment.
 *
 * Every optional field is written EXPLICITLY as null rather than omitted. Under a shallow
 * `||` merge an omitted key leaves the PREVIOUS tick's value in place, so a hold that
 * cleared would keep advertising its old `holdUntilMs` — a stale bound presented as a live
 * deadline, which is precisely the archaeology this record was added to end.
 */
export function buildFreezeAndConvergeGateHealth(
  disposition: FreezeAndConvergeDisposition,
  nowMs: number,
): FreezeAndConvergeGateHealth {
  return {
    freezeAndConverge: {
      enabled: disposition.enabled,
      state: disposition.state,
      reason: disposition.reason,
      candidate: disposition.candidate ?? null,
      holdUntilMs: disposition.holdUntilMs ?? null,
      capacityRetryAtMs: disposition.capacityRetryAtMs ?? null,
      observedAtMs: nowMs,
      repairLatency: disposition.repairLatency ?? null,
    },
  };
}

/**
 * What a tick looked like from OUTSIDE the freeze decision tree — the minimum a terminal
 * handler already holds. Structural on purpose: this module must not import
 * `CheckpointResult` from `apps/operator`, and the backstop must keep working when a new
 * result field is added.
 */
export interface TickFreezeObservation {
  /** FLAGS.RELEASE_FREEZE_AND_CONVERGE_DEFAULT as the run actually read it. */
  flagEnabled: boolean;
  /** The frozen repair queue the tick ended holding, when there was one. */
  repairQueue?: ({ candidate?: string | null } & Partial<FrozenRepairLatencySource>) | null;
  /** P-025: typed queue-read health. `unreadable` outranks any absence-shaped fallback. */
  repairQueueRead?: FrozenCandidateRepairQueueRead;
  /** The run's own one-line summary — the honest reason when no branch recorded a richer one. */
  summary?: string | null;
  /** Did the tick reach a green verdict? */
  green?: boolean | null;
  /** P-007: the clock the latency projection reads; defaults to `Date.now()`. */
  nowMs?: number;
}

/** P-007 (R-7): the tick's repair latencies, when it ended holding a readable queue row. */
function tickRepairLatency(observation: TickFreezeObservation): FrozenRepairLatency | null {
  const q = observation.repairQueue;
  if (!q || typeof q.openedAtMs !== 'number' || typeof q.phase !== 'string') return null;
  return frozenRepairLatency(q as FrozenRepairLatencySource, observation.nowMs ?? Date.now());
}

/** Read-side guard for `gate_health.freezeAndConverge.repairLatency`: every figure numeric-or-null. */
function readRepairLatency(value: unknown): FrozenRepairLatency | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const stamps = r['stamps'] && typeof r['stamps'] === 'object' ? (r['stamps'] as Record<string, unknown>) : null;
  if (!stamps || typeof stamps['openedAtMs'] !== 'number' || typeof stamps['lastRedAtMs'] !== 'number') return null;
  return {
    redToFixerSpawnMs: numOrNull(r['redToFixerSpawnMs']),
    fixToAdmitMs: numOrNull(r['fixToAdmitMs']),
    admitToResumeRunStartMs: numOrNull(r['admitToResumeRunStartMs']),
    admitToVerdictMs: numOrNull(r['admitToVerdictMs']),
    redAwaitingFixerMs: numOrNull(r['redAwaitingFixerMs']),
    admitAwaitingResumeRunStartMs: numOrNull(r['admitAwaitingResumeRunStartMs']),
    admitAwaitingVerdictMs: numOrNull(r['admitAwaitingVerdictMs']),
    stamps: {
      openedAtMs: stamps['openedAtMs'],
      lastRedAtMs: stamps['lastRedAtMs'],
      fixerSpawnedAtMs: numOrNull(stamps['fixerSpawnedAtMs']),
      lastAdmittedAtMs: numOrNull(stamps['lastAdmittedAtMs']),
      lastResumeRunStartedAtMs: numOrNull(stamps['lastResumeRunStartedAtMs']),
      lastVerdictAtMs: numOrNull(stamps['lastVerdictAtMs']),
    },
  };
}

/**
 * PURE: derive the disposition a tick would have recorded if no branch recorded one.
 *
 * WHY A BACKSTOP EXISTS (P-008, measured 2026-09-03)
 * --------------------------------------------------
 * The four explicit `recordFreezeDisposition` call sites cover `retired` (x2), `held` and
 * `off`. `converging` and `none` are recorded NOWHERE — and because the stored record is
 * SHALLOW-MERGED and never cleared, the last `held` stands unchanged while the freeze
 * converges or clears. A reader inside the freshness window then sees `state: 'held'`,
 * with the hold's reason and candidate, for a candidate that is no longer frozen: a stale
 * disposition presented as current, which is the exact false-green class the record was
 * added to end, one level up.
 *
 * Enumerating branches does not fix that — it is hand-maintained metadata about control
 * flow, and the NEXT branch added misses it again in the same silent way. So the tick's
 * terminal handler derives a disposition from what it already holds and writes it only if
 * nothing else did. Every tick then leaves exactly one record describing THAT tick.
 *
 * A branch-recorded disposition always wins: it carries the measured sentence (a capacity
 * wall, a retirement rationale) that this projection cannot reconstruct.
 */
export function deriveTickFreezeDisposition(
  observation: TickFreezeObservation,
): FreezeAndConvergeDisposition {
  // P-007 (R-7): the latency projection rides on WHATEVER disposition the tick derives —
  // it is a property of the queue row, not of the branch that described it.
  const repairLatency = tickRepairLatency(observation);
  const core = deriveTickFreezeDispositionCore(observation);
  return repairLatency ? { ...core, repairLatency } : core;
}

function deriveTickFreezeDispositionCore(
  observation: TickFreezeObservation,
): FreezeAndConvergeDisposition {
  const candidate = observation.repairQueue?.candidate ?? null;
  if (!observation.flagEnabled) {
    return {
      enabled: false,
      state: 'off',
      reason:
        'FLAGS.RELEASE_FREEZE_AND_CONVERGE_DEFAULT is OFF (owner-set): this tick did not ' +
        'freeze anything, and the next tick re-cuts at tip',
      candidate,
    };
  }
  if (observation.repairQueueRead?.status === 'unreadable') {
    const read = observation.repairQueueRead;
    return {
      enabled: true,
      state: 'unreadable',
      reason:
        `${describeUnreadableFrozenCandidateRepairQueue(read)}; ` +
        'refusing to conclude that no candidate is frozen or to cut a moving candidate',
      candidate: null,
    };
  }
  if (candidate) {
    return {
      enabled: true,
      state: 'converging',
      reason:
        observation.summary?.trim() ||
        `frozen candidate ${candidate.slice(0, 12)} is live and being repaired; the tick ` +
          `ended without a branch-recorded disposition`,
      candidate,
    };
  }
  return {
    enabled: true,
    state: 'none',
    reason:
      observation.green === true
        ? 'freeze-and-converge is on and had nothing to do: the gate went green, so no candidate is frozen'
        : observation.summary?.trim() ||
          'freeze-and-converge is on and no candidate is frozen this tick',
    candidate: null,
  };
}

/**
 * PURE: the one-line answer to "is the freeze currently on, and if not why not" — the
 * literal question P-004 exists to make a read.
 *
 * Returns null for an ABSENT record, deliberately, so a caller renders "not measured"
 * rather than inventing a healthy-sounding default. An unmeasured freeze and a working one
 * must never look the same; that equivalence is what hid the original outage.
 */
export function summarizeFreezeAndConverge(
  gateHealth: unknown,
  nowMs: number,
): string | null {
  const record = readFreezeAndConverge(gateHealth);
  if (!record) return null;
  const ageMs = nowMs - record.observedAtMs;
  const stale = ageMs > FREEZE_DISPOSITION_FRESH_MS;
  const staleNote = stale
    ? ` ⚠ last observed ${Math.round(ageMs / 60_000)}m ago — the gate has not reported since, so treat this as history, not current state.`
    : '';
  const subject = record.candidate
    ? ` (candidate ${record.candidate.slice(0, 12)})`
    : '';
  if (record.state === 'unreadable') {
    return `freeze-and-converge queue is UNREADABLE: ${record.reason}${staleNote}`;
  }
  const head = record.enabled
    ? `freeze-and-converge is ON, ${record.state}${subject}`
    : `freeze-and-converge is OFF${subject}`;
  return `${head}: ${record.reason}${staleNote}`;
}

/**
 * PURE: read the stored record back, or null when it is absent or malformed.
 *
 * Fails CLOSED to null on every shape it does not recognise. A partially-written blob
 * coerced into a plausible-looking record is a confident wrong answer about whether the
 * release gate is freezing, which is strictly worse than "not measured".
 */
export function readFreezeAndConverge(
  gateHealth: unknown,
): FreezeAndConvergeGateHealth['freezeAndConverge'] | null {
  if (!gateHealth || typeof gateHealth !== 'object') return null;
  const raw = (gateHealth as Record<string, unknown>)['freezeAndConverge'];
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const state = r['state'];
  const validState =
    state === 'off' ||
    state === 'none' ||
    state === 'held' ||
    state === 'retired' ||
    state === 'converging' ||
    state === 'unreadable';
  if (!validState) return null;
  if (typeof r['enabled'] !== 'boolean') return null;
  if (typeof r['reason'] !== 'string' || r['reason'] === '') return null;
  if (typeof r['observedAtMs'] !== 'number' || !Number.isFinite(r['observedAtMs'])) {
    return null;
  }
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    enabled: r['enabled'],
    state,
    reason: r['reason'],
    candidate: typeof r['candidate'] === 'string' ? r['candidate'] : null,
    holdUntilMs: num(r['holdUntilMs']),
    repairLatency: readRepairLatency(r['repairLatency']),
    capacityRetryAtMs: num(r['capacityRetryAtMs']),
    observedAtMs: r['observedAtMs'],
  };
}

/**
 * The branchable reading of a freeze disposition — main-green-status-visible-2026-09-03 P-004.
 *
 * Distinct from {@link FreezeAndConvergeState} on purpose. The stored `state` is what the
 * gate DID; this is what a reader should CONCLUDE, and the two differ in exactly the two
 * places that have burned us:
 *
 *   • `not-measured` — there is no readable record. The stored union has no such member, so
 *     a reader branching on `state` alone must invent a default for it, and both available
 *     defaults (`none`, `off`) are WRONG and both sound calm.
 *   • `stale` — a record exists but predates {@link FREEZE_DISPOSITION_FRESH_MS}. A
 *     `retired` left behind by a run hours ago is history; read as current it is the
 *     false-green class (WI-6228) applied to the freeze.
 */
export type FreezeDispositionCode =
  /**
   * ⚠ Deliberately NOT the word `not-measured`: that belongs to the read-health vocabulary
   * (`CellUnknownCode`), which the cell registry refuses to see reused as a domain verdict.
   * Read-health for this cell is carried separately, by the `unmeasured` hoist.
   */
  | 'no-disposition-recorded'
  | 'stale'
  | 'off'
  | 'none'
  | 'held'
  | 'retired'
  | 'converging'
  | 'unreadable';

/**
 * PURE: what should a reader conclude from this disposition, right now?
 *
 * Staleness OUTRANKS the state it qualifies. Not a stylistic ordering — a confident reading
 * of the wrong vintage is the failure it prevents: a `retired` observed hours ago reads as
 * "the gate just retired a candidate" when the truth is "the gate has not reported since".
 */
export function assessFreezeDisposition(
  record: FreezeAndConvergeGateHealth['freezeAndConverge'] | null,
  nowMs: number,
): FreezeDispositionCode {
  if (!record) return 'no-disposition-recorded';
  if (nowMs - record.observedAtMs > FREEZE_DISPOSITION_FRESH_MS) return 'stale';
  return record.state;
}

/** The celled projection: the record, its vintage, and the branchable reading. */
export interface FreezeDispositionCellProjection {
  code: FreezeDispositionCode;
  /**
   * Axis-2 HOIST: true when there is no readable disposition at all. Result-level and
   * boolean so a caller who reads nothing else still cannot mistake "the gate never told
   * us" for "the freeze is fine" — every other field is null in that case, and a null
   * `state` is exactly what a hurried reader renders as "nothing frozen, all is well".
   */
  unmeasured: boolean;
  /** The stored state, or null when there is no readable record. NEVER defaulted. */
  state: FreezeAndConvergeState | null;
  /** Why it is in that state — the sentence that used to exist only in a per-run log. */
  reason: string | null;
  /** False ONLY for a measured `off`; null when unmeasured. Never coerced to a boolean. */
  enabled: boolean | null;
  candidate: string | null;
  holdUntilMs: number | null;
  capacityRetryAtMs: number | null;
  observedAtMs: number | null;
  ageMs: number | null;
  /** True when the record is older than the freshness window; null when unmeasured. */
  stale: boolean | null;
  /** One line, ready to quote. Null when there is nothing measured to summarize. */
  summary: string | null;
}

/**
 * PURE: project the stored disposition into the shape `gate.greenCheckpoint.freezeDisposition`
 * publishes.
 *
 * Emitted UNCONDITIONALLY — an absent record yields a projection whose every field is null
 * and whose `code` is `not-measured`, never a bare `null` in place of the object. Two
 * reasons, and the second is the load-bearing one:
 *   1. The cell contract requires the declared assessment path to be PRESENT in every live
 *      payload; a null object makes the cell silently stop answering.
 *   2. "I could not measure the freeze" is itself an answer a reader must be able to branch
 *      on. Collapsing it into absence is the exact ambiguity P-008 and this item exist to
 *      end — and it is why every field here is null rather than defaulted.
 */
export function projectFreezeDispositionCell(
  record: FreezeAndConvergeGateHealth['freezeAndConverge'] | null,
  nowMs: number,
): FreezeDispositionCellProjection {
  const code = assessFreezeDisposition(record, nowMs);
  if (!record) {
    return {
      code,
      unmeasured: true,
      state: null,
      reason: null,
      enabled: null,
      candidate: null,
      holdUntilMs: null,
      capacityRetryAtMs: null,
      observedAtMs: null,
      ageMs: null,
      stale: null,
      summary: null,
    };
  }
  const ageMs = Math.max(0, nowMs - record.observedAtMs);
  return {
    code,
    unmeasured: false,
    state: record.state,
    reason: record.reason,
    enabled: record.enabled,
    candidate: record.candidate,
    holdUntilMs: record.holdUntilMs,
    capacityRetryAtMs: record.capacityRetryAtMs,
    observedAtMs: record.observedAtMs,
    ageMs,
    stale: ageMs > FREEZE_DISPOSITION_FRESH_MS,
    summary: summarizeFreezeAndConverge({ freezeAndConverge: record }, nowMs),
  };
}
