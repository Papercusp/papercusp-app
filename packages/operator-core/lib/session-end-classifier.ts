/**
 * session-end-classifier — the derived terminal-end contract for an ended or
 * inert session that may be HOLDING work (interrupted-member-recovery-hardening-2026-09-01
 * P-002 / WI-2140459, R3, D-003).
 *
 * THE QUESTION: when a sweep finds a session that stopped taking turns while
 * holding >=1 real work-item, did it stop ON PURPOSE (wind-down, park
 * compliance) or was it INTERRUPTED (crash, OOM, account wall, watchdog kill)?
 * The answer decides whether the rescue rung (P-003, silent-halt-reconcile)
 * attempts a wake/resume before paging the owner.
 *
 * NO NEW MARKER TABLE (D-003, derived-truth ladder rung 1): the deliberate-stop
 * signal already exists as derived first-class state, and this module only
 * COMPOSES it:
 *
 *   - engine-loop-standdown.isStoodDownOwner — `loop:end`'s natural residue in
 *     `harness_shared.routines` (owner HAS loop rows, all now inactive) reads
 *     as stood-down-on-purpose; NO row reads as never-armed (rescuable); an
 *     ACTIVE row is a live mission whose wake mechanism evidently failed.
 *   - fleet-park-resume-path.fleetParkOffersResumePath — mig 1065's park
 *     contract: "a park either offers a way back, or it is terminal." A member
 *     stopped under a park with a LIVE resume contract (gate / unexpired
 *     deadline) is parked-awaiting: its stop is deliberate compliance, and the
 *     gate firing — not this sweep — is what brings it back.
 *   - held work — a holder of zero real items is outside this contract's
 *     population entirely (unguarded-halt-rescue's domain, not P-003's).
 *
 * THE FORMULA (D-003): abnormal ⇔ holds work AND NOT deliberately stood down
 * AND no live resume contract. Everything else holding work is 'deliberate';
 * holding nothing is 'no-work'.
 *
 * Note the composition already handles the subtle park cases: a member that
 * COMPLIED with a terminal park called `loop:end` first, so it classifies
 * 'deliberate' via the standdown residue — a terminal-park member with NO
 * standdown residue still holding work died before complying, which is
 * exactly an interruption ('abnormal').
 *
 * FAIL-OPEN like its inputs: a null/undefined `engineLoopRows` (reader error)
 * degrades to "not stood down" and a null `parkPath` to "no live contract" —
 * both lean toward 'abnormal', i.e. toward attempting recovery. A missed
 * suppression costs one throttled wake; a wrong 'deliberate' strands held work.
 *
 * Deliberately PURE and read-free: the same verdict must be computable inside
 * the sweep, in tests, and in any future brief row without a DB round-trip.
 */
import {
  isStoodDownOwner,
  type EngineLoopRowsByOwner,
} from './harness/routines/engine-loop-standdown';
import {
  fleetParkOffersResumePath,
  type FleetParkResumePath,
} from './fleet-park-resume-path';

/**
 * The three-way verdict on an ended/inert holder.
 * - `deliberate` — stopped on purpose (loop:end residue, or parked under a live
 *   resume contract). Do not wake; do not page as an interruption.
 * - `abnormal`   — holds work, never stood down, no live way back: interrupted.
 *   The rescue rung should attempt ONE wake/resume before any page.
 * - `no-work`    — holds nothing real: outside this contract's population
 *   (whatever happened, no claim is stranded).
 */
export type SessionEndClassification = 'deliberate' | 'abnormal' | 'no-work';

export interface ClassifyEndedHolderInput {
  /** Engine-loop routine rows by owner (readEngineLoopRowsByOwner). Null/undefined
   *  = the read failed: fail-open to "not stood down", per the standdown contract. */
  engineLoopRows: EngineLoopRowsByOwner | null | undefined;
  /** The coord owner-id being classified. */
  ownerId: string;
  /** The owner's fleet's resolved park directive (resolveFleetParkResumePath), or
   *  null/undefined for a non-fleet session or a failed read — both mean no park
   *  contract speaks for this stop. */
  parkPath: FleetParkResumePath | null | undefined;
  /** Count of REAL (non-observation) work-items this owner currently holds.
   *  A non-finite or non-positive count classifies as 'no-work'. */
  heldWorkItems: number;
}

/**
 * PURE: classify an ended/inert holder as a deliberate stop, an abnormal
 * interruption, or out-of-population (no held work). See the module header for
 * the composed signals and the D-003 formula.
 */
export function classifyEndedHolder(input: ClassifyEndedHolderInput): SessionEndClassification {
  // Population gate first: a holder of nothing real is not this contract's
  // problem, however it stopped — the reclaim sweep has nothing to protect.
  if (!(input.heldWorkItems > 0)) return 'no-work';

  // loop:end's residue is the strongest deliberate signal: it survives process
  // death, and every compliant wind-down (fleet park included) leaves it.
  if (isStoodDownOwner(input.engineLoopRows, input.ownerId)) return 'deliberate';

  // A live park resume contract (declared gate, or an unexpired deadline) means
  // the fleet expects this capacity back through the gate/lift — the stop is
  // compliance, not interruption. Terminal / overdue / undeclared parks offer
  // no live way back, so they do NOT make a non-stood-down holder deliberate.
  if (input.parkPath && fleetParkOffersResumePath(input.parkPath)) return 'deliberate';

  return 'abnormal';
}

/**
 * The boolean form D-003 names: held work + not deliberately stood down + no
 * live resume contract. Exactly `classifyEndedHolder(input) === 'abnormal'`.
 */
export function abnormalEnd(input: ClassifyEndedHolderInput): boolean {
  return classifyEndedHolder(input) === 'abnormal';
}
