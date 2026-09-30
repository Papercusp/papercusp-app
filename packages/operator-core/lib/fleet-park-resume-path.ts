/**
 * fleet-park-resume-path — the pure semantics of "does this park directive have a
 * way back?" (WI-2034563 / capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01
 * P-008).
 *
 * A fleet:wind-down is a PARK DIRECTIVE: it tells live members to checkpoint,
 * release, and stop pulling work. Until mig 1065 it said nothing about how they
 * come back, and the observed consequence was not subtle — 2026-09-01 03:30-03:47Z,
 * ~23 of 45 members of one fleet sat parked 2.5-6h with 37 wip claims held, heartbeats
 * 0-1min fresh and ZERO tool calls, each having ended its own loop on the directive's
 * instruction. The fleet read as under-strength while half its capacity was alive,
 * authorized, and simply had nothing left that could wake it.
 *
 * Three distinct holes produced that, and this module is the shared answer to the
 * first two:
 *
 *   (a) the directive carried no DECLARED gate, so a member had no key to await —
 *       latching was impossible and every member invented its own resume condition
 *       ("resuming only on new leader direction", which is not a wake source);
 *   (b) nothing distinguished a park that means "stand by" from one that means
 *       "we are done" — so `loop:end`'s wind-down exception authorized a wake-less
 *       stop for BOTH, and the stand-by case is exactly the one it strands.
 *
 * The rule this module encodes: **a park either offers a way back, or it is terminal.**
 * A park that offers a way back (a declared latching gate and/or a live deadline)
 * must be JOINED, not slept through — the member parks on the gate, and fleet:resume
 * firing that gate is what wakes it. A park that offers none is a shutdown, and a
 * wake-less stop is the correct compliance.
 *
 * Deliberately pure and dependency-free: the same predicate has to answer identically
 * inside loop:end's authorization, the wind-down cue text, and leader-brief's capacity
 * row, and those three live in different subsystems. A shared function is the only way
 * they cannot drift into disagreeing about whether a given fleet is stranding its members.
 *
 * LEGACY ROWS READ EXACTLY AS BEFORE. A pre-1065 wind-down carries no gate, no
 * deadline and no terminal flag, so it resolves to `kind:'none'` and keeps today's
 * behaviour. The tightening applies only to parks created with a resume path.
 */

/** Default gate NAME (pre-scoping) minted for a park directive that does not name one. */
export const FLEET_PARK_DEFAULT_RESUME_GATE = 'resume';

/** The subset of a fleet registry row this module reads. Structural, so both the
 *  store record and a raw row projection satisfy it without an import edge. */
export interface FleetParkDirectiveLike {
  /** mig 575 typed control state — only the literal 'winding-down' is a park. */
  controlState?: string | null;
  /** Invoker-stated reason for the park (advisory free text). */
  controlReason?: string | null;
  /** Coord owner-id that set the park (audit). */
  controlBy?: string | null;
  /** Epoch ms the park was set. */
  controlAt?: number | null;
  /** mig 1065: the declared, latching resume-gate event key. */
  controlResumeGate?: string | null;
  /** mig 1065: optional epoch-ms deadline for the park. */
  controlExpiresAt?: number | null;
  /** mig 1065: the park is deliberately terminal — nobody is coming back. */
  controlNoResumePath?: boolean | null;
}

/**
 * What kind of way back this park offers.
 * - `gate`      — a declared latching key to await; fleet:resume fires it.
 * - `deadline`  — bounded by a live deadline, but no key (await nothing, expect a lift).
 * - `both`      — a gate AND a live deadline: the strongest shape.
 * - `overdue`   — a deadline that has PASSED and no gate: the park outlived its own bound.
 * - `terminal`  — deliberately no way back (`controlNoResumePath`), a real shutdown.
 * - `none`      — no gate, no deadline, not declared terminal: a legacy or careless
 *                 indefinite park. Behaviourally treated as terminal (it is what
 *                 pre-1065 rows look like) but reported distinctly so leader-brief
 *                 can say "indefinite, nobody declared it terminal".
 */
export type FleetParkResumePathKind = 'gate' | 'deadline' | 'both' | 'overdue' | 'terminal' | 'none';

export interface FleetParkResumePath {
  /** Is a park directive in force at all? False for every active fleet. */
  parked: boolean;
  kind: FleetParkResumePathKind;
  /** The declared latching gate key members should await; null when there is none. */
  gate: string | null;
  /** Epoch ms the park self-expires; null = indefinite. */
  expiresAt: number | null;
  /** True only when a deadline was set AND has passed. Never true without a deadline. */
  expired: boolean;
  /** How long the park has been in force, ms. Null when controlAt is unknown —
   *  an UNKNOWN duration, never a zero. */
  parkedForMs: number | null;
  /** True when the park was explicitly declared terminal. */
  terminal: boolean;
  /** Coord owner-id that set the park (audit) — carried so a caller reporting the
   *  park never has to re-read the row it already resolved. */
  by: string | null;
  /** The park's stated reason: the "<decision>" a leader recognises it by. */
  reason: string | null;
  /** True when a park is in force with neither a gate nor a live deadline AND was
   *  never declared terminal: capacity is parked indefinitely and nothing says when
   *  or whether it returns. This is the shape leader-brief reports as lost capacity. */
  indefinite: boolean;
}

const NOT_PARKED: FleetParkResumePath = {
  parked: false,
  kind: 'none',
  gate: null,
  expiresAt: null,
  expired: false,
  parkedForMs: null,
  terminal: false,
  by: null,
  reason: null,
  indefinite: false,
};

function trimmedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Resolve a fleet row's park directive into its resume path. Pure; `nowMs` is
 * injected so the deadline comparison is testable and so two readers in the same
 * request cannot disagree about whether a park had just expired.
 */
export function resolveFleetParkResumePath(
  record: FleetParkDirectiveLike | null | undefined,
  nowMs: number,
): FleetParkResumePath {
  if (!record || record.controlState !== 'winding-down') return NOT_PARKED;

  const gate = trimmedOrNull(record.controlResumeGate);
  const expiresAt = finiteOrNull(record.controlExpiresAt);
  const controlAt = finiteOrNull(record.controlAt);
  const expired = expiresAt !== null && expiresAt <= nowMs;
  const terminal = record.controlNoResumePath === true;
  // A negative age means the clocks disagree, not that the park is in the future;
  // report UNKNOWN rather than a nonsense duration a caller would render as "-2h".
  const parkedForMs = controlAt === null ? null : Math.max(0, nowMs - controlAt);

  let kind: FleetParkResumePathKind;
  if (terminal) kind = 'terminal';
  else if (gate && expiresAt !== null && !expired) kind = 'both';
  else if (gate) kind = 'gate';
  else if (expiresAt !== null && !expired) kind = 'deadline';
  else if (expiresAt !== null) kind = 'overdue';
  else kind = 'none';

  return {
    parked: true,
    kind,
    gate,
    expiresAt,
    expired,
    parkedForMs,
    terminal,
    by: trimmedOrNull(record.controlBy),
    reason: trimmedOrNull(record.controlReason),
    indefinite: !terminal && gate === null && (expiresAt === null || expired),
  };
}

/**
 * Does this park offer members a way back they must JOIN rather than sleep through?
 *
 * This is the predicate that narrows loop:end's fleet wind-down exception. A member
 * with an events:await registered never reaches that exception at all (the parked-await
 * read already clears the wake-less guard), so this answers only the remaining case:
 * a member about to stop with NO wake source whatsoever.
 *
 *   true  ⇒ the fleet expects this capacity back. Stopping wake-less strands it, and
 *           the member should events:await `path.gate` (or stay armed until the
 *           deadline) instead.
 *   false ⇒ terminal/indefinite shutdown — a wake-less stop is correct compliance,
 *           which is also exactly how every pre-mig-1065 row resolves.
 *
 * An OVERDUE deadline with no gate deliberately returns false: the park already
 * outlived its own bound, so there is no live path left to join — leader-brief
 * reports it, but loop:end must not wedge a member on a lapsed promise.
 */
export function fleetParkOffersResumePath(path: FleetParkResumePath): boolean {
  if (!path.parked || path.terminal) return false;
  return path.gate !== null || (path.expiresAt !== null && !path.expired);
}

/** Human duration for cue/brief text: compact, never fake precision. */
export function formatParkDuration(ms: number | null): string {
  if (ms === null) return 'an unknown duration';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h${rem}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

/**
 * The member-facing sentence a park directive owes its members: what to await, or
 * that nothing is coming. Used verbatim in the wind-down cue and in loop:end's
 * refusal so the key a member awaits is COPIED from the declaration rather than
 * re-typed from prose — a hand-typed key never rendezvouses.
 */
export function describeParkResumePath(path: FleetParkResumePath): string {
  if (!path.parked) return 'This fleet is not parked.';
  if (path.terminal) {
    return 'This park is TERMINAL — no resume is expected. Ending your loop is correct compliance.';
  }
  const deadline =
    path.expiresAt !== null && !path.expired
      ? ` The park is bounded: it is due to lift by ${new Date(path.expiresAt).toISOString()}.`
      : path.expired
        ? ` ⚠ The park's own deadline (${new Date(path.expiresAt as number).toISOString()}) has PASSED without a lift.`
        : '';
  if (path.gate) {
    return (
      `Do NOT end your loop wake-less — you would have no way back. Register the declared resume gate first: ` +
      `events:await { event: '${path.gate}' } (copy the key verbatim; it LATCHES, so registering after the ` +
      `lift still resolves immediately), THEN loop:end. fleet:resume fires that exact key.${deadline}`
    );
  }
  return (
    `This park declares no resume gate.${deadline || ' It is INDEFINITE — no deadline and no gate, so nothing will bring this capacity back on its own.'}`
  );
}

/** One member-count row for leader-brief: policy-parked capacity, and why it is lost. */
export interface PolicyParkedCapacity {
  /** Live members currently under the park directive. */
  members: number;
  kind: FleetParkResumePathKind;
  /** Coord owner-id that set the park. */
  by: string | null;
  /** The park's stated reason — the "<decision>" a leader recognises it by. */
  reason: string | null;
  gate: string | null;
  expiresAt: number | null;
  expired: boolean;
  parkedForMs: number | null;
  /** True when this capacity is parked with no declared way back. */
  indefinite: boolean;
  message: string;
}

/** Excerpt a park reason for a one-line brief row without losing its identity. */
function reasonExcerpt(reason: string | null, cap = 120): string | null {
  const r = trimmedOrNull(reason);
  if (r === null) return null;
  return r.length <= cap ? r : `${r.slice(0, cap - 1)}…`;
}

/**
 * Build leader-brief's policy-parked capacity row (P-008 leg (c)).
 *
 * The third hole behind the incident: headcount and leader-brief had no row naming
 * policy-parked members, so a leader reading "under-strength" could not tell parked
 * capacity from missing capacity — and the natural response to missing capacity is to
 * RELAUNCH, which is exactly the wrong move for members that are alive and waiting.
 * Returns undefined when the fleet is not parked or has no live members to park.
 */
export function buildPolicyParkedCapacity(input: {
  fleet: string;
  liveMembers: number;
  path: FleetParkResumePath;
}): PolicyParkedCapacity | undefined {
  const { path, liveMembers } = input;
  if (!path.parked || liveMembers <= 0) return undefined;
  const reason = reasonExcerpt(path.reason);
  const who = path.by ?? 'an unrecorded invoker';
  const forDuration = formatParkDuration(path.parkedForMs);
  const noun = liveMembers === 1 ? 'member' : 'members';

  // The verdict half — what a leader must NOT do about it. Relaunching parked
  // members is the specific wrong move this row exists to prevent: they are alive
  // and authorized, so a replacement seat adds cost without adding capacity.
  let verdict: string;
  if (path.terminal) {
    verdict =
      'The park is TERMINAL (no resume expected), so this is retired capacity, not recoverable capacity — ' +
      'do not count it against the headcount target.';
  } else if (path.gate) {
    verdict =
      `LOST CAPACITY, recoverable: fire the declared resume gate '${path.gate}' (fleet:resume does this) ` +
      'to wake every member parked on it. Do NOT relaunch them — they are alive and waiting.';
  } else if (path.expired) {
    verdict =
      `LOST CAPACITY, OVERDUE: the park's own deadline (${new Date(path.expiresAt as number).toISOString()}) ` +
      'has passed with no lift and no resume gate was declared, so nothing will bring these members back. ' +
      'fleet:resume them or record the park as terminal.';
  } else if (path.expiresAt !== null) {
    verdict =
      `LOST CAPACITY, bounded: the park is due to lift by ${new Date(path.expiresAt).toISOString()}. ` +
      'Do NOT relaunch these members before then.';
  } else {
    verdict =
      'LOST CAPACITY, INDEFINITE: this park declared neither a resume gate nor a deadline, so nothing will ' +
      'bring these members back on its own. Either fleet:resume them or re-issue the park with a resume gate.';
  }

  return {
    members: liveMembers,
    kind: path.kind,
    by: path.by,
    reason: path.reason,
    gate: path.gate,
    expiresAt: path.expiresAt,
    expired: path.expired,
    parkedForMs: path.parkedForMs,
    indefinite: path.indefinite,
    message:
      `${liveMembers} ${noun} of ${input.fleet} policy-parked by ${who}` +
      `${reason ? ` (${reason})` : ''} for ${forDuration}. ${verdict}`,
  };
}
