/**
 * fleet-brief-delta — the wake-to-wake delta behind `fleet:leader-brief`
 * (fleet-lead-instrumentation-audit-2026-08-09 P-022, D-011).
 *
 * P-022, in the leader's own words: "Every wake I reconstructed 'what changed' by hand
 * from checkpoint prose: members gained/lost, items closed, spec revision, capacity
 * movement. Wanted: `since your last wake — members ±N, closes +N, spec rev X→Y, pool
 * factor A→B`. That is most of what a monitor-loop tick actually needs."
 *
 * WHAT WAS ACTUALLY MISSING WAS THE BOUNDARY, NOT THE DATA. Measured before building
 * (D-011): two of the four axes already had durable history and need no snapshot at all —
 * `fleet_membership_events` is a real join/leave log, and `work_items:burn_down { since }`
 * already returns a closes delta with a four-way attribution split. Only the account-pool
 * `factor` (computed live, never recorded) and the PRIOR claim-spec `revision`
 * (current-value-only tables) need one. `fleet:leader-brief` itself carried no delta of any
 * kind: every field is point-in-time and it took no `since`.
 *
 * TWO PROPERTIES THIS MODULE EXISTS TO GUARANTEE, both of them failure modes this very plan
 * was written to catalogue:
 *
 *  1. AN ABSENT MEASUREMENT IS NEVER RENDERED AS A ZERO. Every axis reports
 *     `{ current, previous, delta, available, reason }`, and an axis with no baseline
 *     reports `available:false` with a reason — never `delta: 0`. A "nothing changed" that
 *     actually means "I have no baseline" is indistinguishable from a real quiet window, and
 *     it is the same shape as WI-37381, where `burn_down` at `limit:5` reported
 *     `terminal.total 0` against a true 1693 and the fleet's own drain leader believed it.
 *
 *  2. THE SNAPSHOT ROTATES PER WAKE, NOT PER READ. Rotation is keyed on the caller's loop
 *     `fireCount`, so a second brief read inside one wake returns the SAME delta rather than
 *     a freshly-zeroed one. Rotating on every read would make the tool blind itself the
 *     moment anyone looked twice — the failure caught three times in P-006, where a repair
 *     wrote to the very record its own falsifier reads. With no armed loop there is no wake
 *     to key on, so the boundary is reported as `'read'` instead of implying one.
 *
 * PURE core, no PG / IO / clock (the fleet-transition-events.ts / fleet-drained-events.ts
 * discipline): the caller supplies the stored row, the observation and the derived counts,
 * so the whole module unit-tests without a database.
 */

/** One point-in-time reading of the axes that have no durable history elsewhere. */
export interface FleetBriefObservation {
  /** ISO timestamp this observation was taken. Becomes the `since` the delta reports. */
  at: string;
  /**
   * Roster size — every member presence records in the fleet, INCLUDING the stale-idle ones
   * `leader-brief` withholds from its shown list. The membership axis keys on this, not on
   * the shown count, so a member merely going stale-idle does not read as a departure.
   */
  rosterSize: number | null;
  /** The shown/counted member total, carried so visibility movement stays visible too. */
  countedMembers: number | null;
  /** The fleet claim spec's revision — the X in "rev X→Y", unrecoverable without this. */
  specRevision: number | null;
  /** Account-pool capacity factor. Computed live and recorded nowhere else. */
  poolFactor: number | null;
}

/** The persisted row: two slots, rotated when the wake advances. */
export interface FleetBriefSnapshotRow {
  /** Loop fire this row was last rotated at; null = the reader has no armed loop. */
  fireCount: number | null;
  /** The PREVIOUS wake's observation — what the delta is computed against. */
  baseline: FleetBriefObservation | null;
  /** THIS wake's observation; becomes `baseline` at the next rotation. */
  observation: FleetBriefObservation;
}

/** Why an axis could not be differenced. Absent when `available` is true. */
export type DeltaUnavailableReason =
  /** No baseline at all — the first brief read for this (fleet, leader). */
  | 'no-baseline'
  /** A baseline exists, but it did not record this axis (it was unreadable then). */
  | 'not-observed-previously'
  /** The axis is unreadable right now, so there is nothing to compare. */
  | 'not-observed-now';

/**
 * One differenced axis. `delta` is non-null ONLY when `available` is true — the invariant
 * that keeps an absent measurement from reading as a confident zero.
 */
export interface DeltaAxis {
  current: number | null;
  previous: number | null;
  delta: number | null;
  available: boolean;
  reason?: DeltaUnavailableReason;
}

/** Where the delta's `since` came from, reported so it is never implied. */
export type DeltaBoundary =
  /** Bounded by the caller's previous loop fire — the real "since your last wake". */
  | 'wake'
  /** The caller has no armed loop, so the boundary is the previous READ, not a wake. */
  | 'read'
  /** First read for this (fleet, leader): there is no prior boundary yet. */
  | 'first'
  /** The caller supplied an explicit `since`. */
  | 'explicit';

export interface FleetBriefDelta {
  /** ISO timestamp the delta is measured from; null on a first read. */
  since: string | null;
  boundary: DeltaBoundary;
  /**
   * Net roster movement. `joined`/`left` come from the durable membership event log and are
   * authoritative CHURN — they see a member who joined and left inside the window, which the
   * net roster difference cannot. When the two disagree, that is the reason.
   */
  members: DeltaAxis & {
    joined: number | null;
    left: number | null;
    /** Shown-count movement, which also moves when a member merely goes stale-idle. */
    counted: DeltaAxis;
  };
  /** Work items reaching a terminal state in the window. */
  closes: DeltaAxis & {
    /** True when the underlying count is a FLOOR (undated closes exist in the window). */
    isFloor: boolean;
  };
  /** Claim-spec revision movement — `previous` is the X in "rev X→Y". */
  specRevision: DeltaAxis;
  /** Account-pool capacity factor movement. */
  poolFactor: DeltaAxis;
}

/**
 * Decide this read's baseline and whether the stored row must be rewritten.
 *
 * The rotation rule, and why each branch exists:
 *  - no stored row       → first sighting. No baseline; nothing to difference yet.
 *  - `fireCount` null    → the caller has no armed loop, so there is no wake to key on.
 *                          Rotate every read and SAY the boundary is a read.
 *  - fireCount unchanged → a re-read inside the same wake. Return the SAME baseline and do
 *                          NOT rewrite, so looking twice cannot zero the delta.
 *  - fireCount moved     → a new wake. Last wake's observation becomes this wake's baseline.
 *
 * A fireCount that moved BACKWARD (a re-armed loop restarting its count) takes the same
 * branch as one that moved forward, which is correct: a re-arm is a genuine new boundary.
 */
export function rotateBriefSnapshot(
  stored: FleetBriefSnapshotRow | null,
  observation: FleetBriefObservation,
  fireCount: number | null,
): {
  baseline: FleetBriefObservation | null;
  next: FleetBriefSnapshotRow;
  /** False ⇒ the caller must NOT write; the stored row is already correct for this wake. */
  rotated: boolean;
  boundary: DeltaBoundary;
} {
  if (!stored) {
    return {
      baseline: null,
      next: { fireCount, baseline: null, observation },
      rotated: true,
      boundary: 'first',
    };
  }
  if (fireCount === null) {
    return {
      baseline: stored.observation,
      next: { fireCount: null, baseline: stored.observation, observation },
      rotated: true,
      boundary: 'read',
    };
  }
  if (stored.fireCount === fireCount) {
    // Same wake, second look. Reuse the baseline verbatim and leave the row alone.
    return {
      baseline: stored.baseline,
      next: stored,
      rotated: false,
      boundary: stored.baseline ? 'wake' : 'first',
    };
  }
  return {
    baseline: stored.observation,
    next: { fireCount, baseline: stored.observation, observation },
    rotated: true,
    boundary: 'wake',
  };
}

/**
 * Difference one axis. The whole point is the `available` gate: a missing reading on either
 * side yields `delta: null` plus the reason it is missing, never a zero that reads as "no
 * change".
 */
export function differenceAxis(
  previous: number | null | undefined,
  current: number | null | undefined,
  hasBaseline: boolean,
): DeltaAxis {
  const cur = current ?? null;
  const prev = previous ?? null;
  if (!hasBaseline) {
    return { current: cur, previous: null, delta: null, available: false, reason: 'no-baseline' };
  }
  if (prev === null) {
    return {
      current: cur,
      previous: null,
      delta: null,
      available: false,
      reason: 'not-observed-previously',
    };
  }
  if (cur === null) {
    return {
      current: null,
      previous: prev,
      delta: null,
      available: false,
      reason: 'not-observed-now',
    };
  }
  return { current: cur, previous: prev, delta: cur - prev, available: true };
}

/** Membership churn read off the durable event log, for the window the delta covers. */
export interface MembershipChurn {
  joined: number;
  left: number;
}

/** The closes half, supplied by the caller from the burn-down delta. */
export interface ClosesInput {
  /** Terminal transitions in the window; null when the window itself is unknown. */
  delta: number | null;
  /** True when undated closes exist in the window, making `delta` a floor rather than a total. */
  isFloor: boolean;
}

/**
 * Assemble the delta block. Pure: every input is supplied by the caller, so this whole
 * function is exercised without a database.
 */
export function computeFleetBriefDelta(input: {
  baseline: FleetBriefObservation | null;
  observation: FleetBriefObservation;
  boundary: DeltaBoundary;
  /** Null when no boundary is known yet (a first read), so the churn window is undefined. */
  churn: MembershipChurn | null;
  closes: ClosesInput;
  /** Overrides the baseline's timestamp when the caller passed an explicit `since`. */
  since?: string | null;
}): FleetBriefDelta {
  const { baseline, observation, boundary, churn, closes } = input;
  const hasBaseline = baseline !== null;
  const since = input.since ?? baseline?.at ?? null;

  const roster = differenceAxis(baseline?.rosterSize, observation.rosterSize, hasBaseline);
  const counted = differenceAxis(baseline?.countedMembers, observation.countedMembers, hasBaseline);

  const closesAxis: DeltaAxis = hasBaseline
    ? closes.delta === null
      ? { current: null, previous: null, delta: null, available: false, reason: 'not-observed-now' }
      : { current: closes.delta, previous: null, delta: closes.delta, available: true }
    : { current: null, previous: null, delta: null, available: false, reason: 'no-baseline' };

  return {
    since,
    boundary,
    members: {
      ...roster,
      joined: churn?.joined ?? null,
      left: churn?.left ?? null,
      counted,
    },
    closes: { ...closesAxis, isFloor: closes.isFloor },
    specRevision: differenceAxis(baseline?.specRevision, observation.specRevision, hasBaseline),
    poolFactor: differenceAxis(baseline?.poolFactor, observation.poolFactor, hasBaseline),
  };
}

/**
 * One-line human summary — the literal shape P-022 asked for. Axes that could not be
 * differenced say so in words rather than being dropped: a reader who sees four axes and
 * three numbers knows the fourth is unknown, where a reader who sees three axes assumes the
 * fourth was fine.
 */
export function describeFleetBriefDelta(delta: FleetBriefDelta): string {
  const parts: string[] = [];
  const sign = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

  if (delta.members.available && delta.members.delta !== null) {
    let m = `members ${sign(delta.members.delta)}`;
    if (delta.members.joined !== null && delta.members.left !== null) {
      const churned = delta.members.joined + delta.members.left;
      // Churn the net difference cannot show: a member who joined AND left inside the window.
      if (churned > Math.abs(delta.members.delta)) {
        m += ` (${delta.members.joined} joined / ${delta.members.left} left)`;
      }
    }
    parts.push(m);
  } else {
    parts.push('members ? (no baseline)');
  }

  parts.push(
    delta.closes.available && delta.closes.delta !== null
      ? `closes ${sign(delta.closes.delta)}${delta.closes.isFloor ? ' (floor)' : ''}`
      : 'closes ? (no baseline)',
  );

  parts.push(
    delta.specRevision.available && delta.specRevision.delta !== 0
      ? `spec rev ${delta.specRevision.previous}→${delta.specRevision.current}`
      : delta.specRevision.available
        ? `spec rev ${delta.specRevision.current} (unchanged)`
        : 'spec rev ? (no baseline)',
  );

  parts.push(
    delta.poolFactor.available
      ? `pool factor ${delta.poolFactor.previous}→${delta.poolFactor.current}`
      : 'pool factor ? (no baseline)',
  );

  const window = delta.since ? `since ${delta.since}` : 'no prior boundary';
  return `${window} (${delta.boundary}): ${parts.join(', ')}`;
}
