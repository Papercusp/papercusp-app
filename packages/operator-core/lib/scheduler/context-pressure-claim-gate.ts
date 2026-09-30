/**
 * context-pressure-claim-gate.ts — WI-5940: refuse to SERVE new self-selected work to a
 * caller whose context pressure is CRITICAL, with a compact-first verdict instead of an item.
 *
 * WHY (the filed reproduction): a leader told a critical-context member to pull now AND to
 * self-compact first in the same message. The ordering was ambiguous, the member pulled a hard
 * timing-sensitive item ~2 minutes later, and an ownership collision followed. An agent at
 * critical context cannot reliably drive a hard item to completion — it will compact mid-task,
 * and in-flight state is exactly what compaction carries worst. At the time of filing the same
 * fleet had critical_context 3-of-10 members with 4 unowned criticals: this is the steady state
 * of a long drain, not a rare corner.
 *
 * WHY THIS IS ONE SHARED MODULE rather than a check inlined at each tool. Both SELF-SELECT
 * surfaces (`scheduler:get_next` and its compatibility wrapper `work_items:claim_next`) must
 * answer identically. get_next.ts already carries the scar from letting exactly that drift:
 * `concurrencyBlockedRefusal`'s doc comment records how the cap-led refusal existed on the
 * non-fleet branch only, so the identical defect survived on `fleetScopedMiss` — the branch every
 * fleet member actually takes. Same anti-drift shape here: ONE verdict, two call sites.
 *
 * ⚠ THE CENTRAL HAZARD — a false 'critical' must never manufacture a false drain.
 * `contextPressure` is NOT a live reading. It is cached on `coord_presence` by the
 * compaction-compliance watchdog on a ~2-minute sweep, while a session's own ambient context
 * gauge is recomputed every turn. context-pressure.ts records the measured divergence: a fleet
 * member's `coord:orient` row read "critical" moments after its own live gauge read 12%. If that
 * stale reading silently refused work, this gate would recreate the very false-drain trap the
 * filing warns against (point 2: the refusal must be a VERDICT, not silence) — an agent idling
 * while believing its lane is drained, which is strictly worse than the collision it prevents.
 *
 * Three properties keep that from happening, and each is asserted by a test:
 *   1. FAIL-OPEN ON UNKNOWN. `deriveContextPressure` already degrades a reading older than
 *      CONTEXT_ESTIMATE_STALE_MS to `null`, and `fetchContextPressure` simply omits such owners.
 *      A `null`/absent bucket SERVES, and is never coerced to 'critical'. Unknown means unknown.
 *   2. ONLY 'critical' REFUSES. 'ok' and 'high' are served unchanged — 'high' means "wrap up
 *      soon", which is not a reason to withhold work (and the filing's acceptance says so).
 *   3. AN ESCAPE HATCH THE CALLER OWNS. A caller sees its live gauge every turn; the cache is a
 *      ≤2-minute-stale proxy for it. So on the one axis where they disagree, the CALLER is the
 *      better authority — `override` lets it proceed and is reported in the result rather than
 *      being silent. Without it, a falsely-cached 'critical' could withhold work for up to the
 *      full staleness ceiling with no recourse, which is the worse failure.
 *
 * The refusal itself leads with the CAUSE and states plainly that the lane was never consulted —
 * EI-19931420102632438's lesson, that a caller refused on its OWN state must never be handed a
 * sentence that reads as a claim about lane contents.
 *
 * PURE (no PG, no clock): the IO seam is the existing `fetchContextPressure` batch read, done by
 * the caller. That keeps this unit-testable and keeps the gate's semantics in one readable place.
 */

import type {
  ContextPressureBucket,
  ContextPressureRecoveryResolution,
} from '../agent-tools/coordination/context-pressure';
// VALUE import (not just types): the headroom predicate below re-derives the SAME bucket this
// gate refused on, against a different denominator. Reusing the real band thresholds is what
// keeps "raising the limit would clear it" from drifting away from the gauge it speaks about.
import { deriveContextPressure } from '../agent-tools/coordination/context-pressure';

/** Typed verdict code, named by the filing so a reader can grep the item from the wire. */
export const CONTEXT_CRITICAL_REFUSAL_CODE = 'claim_refused_context_critical';

/** Why the gate let a pull through — reported so "served" is never an unexplained default. */
export type ContextPressureServeReason =
  /** Bucket resolved below the refusal threshold. */
  | 'pressure-ok'
  /** 'high' — wrap-up territory, deliberately still served (acceptance: ok/high unchanged). */
  | 'pressure-high'
  /** No bucket: untracked owner, or an estimate too stale to assert. Fail-open by contract. */
  | 'pressure-unknown'
  /** Caller asserted its live gauge disagrees with the cached bucket. */
  | 'caller-override'
  /** Kill-switch off. */
  | 'gate-disabled';

export type ContextPressureGateDecision =
  | { refuse: false; reason: ContextPressureServeReason; bucket: ContextPressureBucket | null }
  | {
      refuse: true;
      reason: 'pressure-critical';
      bucket: 'critical';
      code: typeof CONTEXT_CRITICAL_REFUSAL_CODE;
      error: string;
      diagnosis: {
        contextPressureBlocked: true;
        contextPressure: 'critical';
        /** The lane was never queried — say so, so this is not read as a drain verdict. */
        laneEvaluated: false;
        remedy: string;
        overrideArg: string;
        recoveryPath: ContextPressureRecoveryResolution['path'] | null;
        /**
         * Non-null ⇒ `config:set-compaction-limit { limit: suggestedLimit }` PROVABLY clears
         * this refusal, and the remedy above says so instead of naming a fresh-context path
         * that cannot. Machine-readable so a caller can act without parsing the prose.
         */
        suggestedLimit: number | null;
      };
    };

function remedyForRecoveryPath(
  recovery: ContextPressureRecoveryResolution | null | undefined,
): { label: string; text: string } {
  switch (recovery?.path) {
    case 'cold-loop':
      return {
        label: recovery.carryNoteVerified
          ? 'cold-loop settle'
          : 'checkpoint, then cold-loop settle',
        text:
          'write/refresh loop:checkpoint { did, left, insight, next }, then end this turn; the armed COLD loop ' +
          'is the fresh-context boundary on its next wake' +
          (recovery.carryNoteVerified
            ? ' from its verified carry-note.'
            : ' and the checkpoint creates the carry-note it needs. Do not call session:request-compaction.'),
      };
    case 'warm-loop':
      return {
        label: 'checkpoint, then warm-loop retune',
        text:
          'write/refresh loop:checkpoint { did, left, insight, next }, then call session:request-compaction; ' +
          'its no-PTY fallback retunes the active WARM loop to COLD before the next wake.',
      };
    case 'no-path':
      return {
        label: 'checkpoint, arm a fresh-context wake',
        text:
          'write/refresh durable checkpoints, arm a COLD loop (or another real fresh-context wake), then end this turn and re-pull; ' +
          'self-compaction is unavailable to this session.',
      };
    case 'unknown':
      return {
        label: 'verify a fresh-context recovery path',
        text:
          'write/refresh durable checkpoints and establish a verified fresh-context wake before ending this turn; ' +
          'recovery-path availability could not be read, so do not assume session:request-compaction can succeed.',
      };
    case 'self-compaction':
    default:
      return {
        label: 'self-compact, then re-pull',
        text:
          'self-compact (session:request-compaction { autoContinue: true }), then re-pull; the work is still there.',
      };
  }
}

/**
 * The session-shaped facts needed to answer ONE question the recovery-path switch above cannot:
 * would raising this session's soft limit clear the critical band outright?
 *
 * `selfSetCeiling` is the model-derived ceiling `config:set-compaction-limit` would ACCEPT for
 * this session (`selfSetCeilingForWindow` / `selfSetCeilingForSpec`), not the seeded default —
 * the two are deliberately different numbers, and it is the gap between them that this predicate
 * is about.
 */
export type ContextPressureHeadroom = {
  /** The caller's cached context estimate, in tokens — the numerator the bucket was derived from. */
  contextTokens: number | null | undefined;
  /** The soft compaction limit that bucket was derived AGAINST. */
  softLimit: number | null | undefined;
  /** The ceiling this session is permitted to self-set up to. */
  selfSetCeiling: number | null | undefined;
};

/**
 * PURE. Is "raise the soft limit" a move that PROVABLY clears this refusal?
 *
 * WHY THIS EXISTS (EI-23744538757758407). Every remedy in the switch above discards context to
 * get back under a FIXED limit: self-compaction, a cold-loop settle, a fresh-context wake. All of
 * them assume the limit is SATISFIABLE — that a fresh context boots below it. On a large-window
 * model whose fixed per-turn baseline (kernel + playbook + client overlay + spliced project guide
 * + wire schemas, re-injected every turn) already EXCEEDS a low seeded limit, that assumption is
 * false: a fresh context boots at the same baseline, is refused again, and the session livelocks
 * on a remedy that cannot possibly work. Observed instance: a brand-new Opus-5-1M fleet member
 * seeded at the 250k member cap booted at ~362k (145%) and was refused on its FIRST pull, having
 * made three read-only calls. Compaction was not merely unhelpful there, it was arithmetically
 * incapable — and the refusal named it anyway, because the remedy is selected purely by which
 * recovery PATH is available and never by whether that path can clear the breach.
 *
 * Raising the limit is the move that actually works, and unlike every other remedy it costs
 * nothing and preserves in-flight state. So it is asserted ONLY when arithmetically provable:
 * re-derive the same bucket against the ceiling, reusing the real band thresholds rather than
 * restating them, so this can never drift from the gauge it speaks about.
 */
export function raisingLimitWouldClear(headroom: ContextPressureHeadroom | null | undefined): {
  clears: boolean;
  suggestedLimit: number | null;
} {
  const miss = { clears: false, suggestedLimit: null } as const;
  const contextTokens = headroom?.contextTokens ?? null;
  const softLimit = headroom?.softLimit ?? null;
  const ceiling = headroom?.selfSetCeiling ?? null;
  // Absent facts are UNKNOWN, never an assertion: omitting headroom preserves legacy wording.
  if (contextTokens == null || softLimit == null || ceiling == null) return miss;
  if (!Number.isFinite(contextTokens) || !Number.isFinite(softLimit) || !Number.isFinite(ceiling)) {
    return miss;
  }
  // No headroom to raise INTO ⇒ the limit is not the thing standing in the way, and telling a
  // session at its ceiling to raise it would be exactly the same class of useless advice this
  // predicate exists to stop emitting.
  if (ceiling <= softLimit) return miss;
  // Deliberately NOT staleness-checked: the gate already refused on this very estimate, so asking
  // what it implies against a different denominator is strictly arithmetic. Passing no timestamp
  // is what keeps this from degrading a reading the caller has already accepted into `null`.
  if (deriveContextPressure(contextTokens, ceiling) === 'critical') return miss;
  return { clears: true, suggestedLimit: ceiling };
}

/**
 * The remedy, with the headroom check taking PRECEDENCE over every recovery path.
 *
 * That precedence is the whole fix and it is not an optimisation: each path in the switch buys a
 * FRESH CONTEXT, and none of them lowers the fixed baseline a fresh context boots at. When the
 * limit itself is what is breached, discarding the session's in-flight work cannot clear it — so
 * a cold-loop settle is just as incapable here as self-compaction, and must not be offered first.
 */
function contextPressureRemedy(
  recovery: ContextPressureRecoveryResolution | null | undefined,
  headroom?: ContextPressureHeadroom | null,
): { label: string; text: string; suggestedLimit: number | null } {
  const raise = raisingLimitWouldClear(headroom);
  if (raise.clears) {
    return {
      label: 'raise the soft compaction limit, then re-pull',
      suggestedLimit: raise.suggestedLimit,
      text:
        `raise your soft compaction limit — config:set-compaction-limit { limit: ${raise.suggestedLimit} } — ` +
        'then re-pull WITHOUT compacting. Your fixed per-turn baseline already exceeds your current ' +
        'limit, so compaction cannot clear this and neither can any other fresh-context wake: a fresh ' +
        'context boots at the same baseline and is refused again. Raising the limit is within your ' +
        'model-derived ceiling, costs nothing, and keeps your in-flight state.',
    };
  }
  return { ...remedyForRecoveryPath(recovery), suggestedLimit: null };
}

/**
 * The refusal text. Shaped like `concurrencyBlockedRefusal`: cause first, explicit
 * "the lane was NOT evaluated" disclaimer, then the remedy — and it names the override so a
 * caller holding a contradicting live gauge is never left without a move.
 */
function contextCriticalRefusalMessage(
  overrideArg: string,
  recovery: ContextPressureRecoveryResolution | null | undefined,
  headroom?: ContextPressureHeadroom | null,
): string {
  const remedy = contextPressureRemedy(recovery, headroom);
  return (
    'context pressure CRITICAL: your cached context estimate is at/above the critical band, and an ' +
    'agent that compacts mid-task carries in-flight state worst — so no item was served. ' +
    `REMEDY: ${remedy.text} ` +
    'work is still there. (The claim lane itself was NOT evaluated — this is not a statement about ' +
    'lane contents, and NOT a drain verdict.) ' +
    `If your OWN live context gauge disagrees, it is the better authority — the cached bucket lags it ` +
    `by up to a ~2-minute watchdog sweep: re-call with ${overrideArg}: true to proceed.`
  );
}

/**
 * PURE decision. `bucket` is the caller's own cached context-pressure bucket (null ⇒ unknown).
 *
 * Ordering is deliberate: the kill-switch and the caller's override are consulted BEFORE the
 * bucket, so neither can be defeated by a stale reading.
 */
export function decideContextPressureGate(input: {
  bucket: ContextPressureBucket | null | undefined;
  /** Caller asserts its live gauge contradicts the cached bucket. */
  override?: boolean;
  /** Kill-switch (flag). Default true — finished work does not ship dark. */
  enabled?: boolean;
  /** Name of the override argument, for the remedy text. */
  overrideArg?: string;
  /** Optional async-derived remedy facts; omitted preserves the legacy wording. */
  recovery?: ContextPressureRecoveryResolution | null;
  /**
   * Optional session headroom (estimate / soft limit / self-set ceiling). Omitted preserves the
   * legacy wording exactly; supplied, it lets the remedy name the ONE move that can clear a
   * breach caused by an unsatisfiable limit rather than an over-full session.
   */
  headroom?: ContextPressureHeadroom | null;
}): ContextPressureGateDecision {
  const bucket = input.bucket ?? null;
  const overrideArg = input.overrideArg ?? 'ignoreContextPressure';
  if (input.enabled === false) return { refuse: false, reason: 'gate-disabled', bucket };
  if (input.override === true) return { refuse: false, reason: 'caller-override', bucket };
  // Fail-open on unknown: an absent/stale bucket is never coerced into a refusal.
  if (bucket == null) return { refuse: false, reason: 'pressure-unknown', bucket: null };
  if (bucket === 'ok') return { refuse: false, reason: 'pressure-ok', bucket };
  if (bucket === 'high') return { refuse: false, reason: 'pressure-high', bucket };
  // Computed ONCE: the prose remedy and the machine-readable diagnosis must never disagree about
  // which move is being prescribed — deriving them from two separate calls is how they drift.
  const remedy = contextPressureRemedy(input.recovery, input.headroom);
  return {
    refuse: true,
    reason: 'pressure-critical',
    bucket: 'critical',
    code: CONTEXT_CRITICAL_REFUSAL_CODE,
    error: contextCriticalRefusalMessage(overrideArg, input.recovery, input.headroom),
    diagnosis: {
      contextPressureBlocked: true,
      contextPressure: 'critical',
      laneEvaluated: false,
      remedy: remedy.label,
      overrideArg,
      recoveryPath: input.recovery?.path ?? null,
      suggestedLimit: remedy.suggestedLimit,
    },
  };
}

/** The full wire body for a refusing tool result — shared so both surfaces emit one shape. */
export function contextCriticalRefusalResult(decision: Extract<ContextPressureGateDecision, { refuse: true }>): {
  ok: false;
  error: string;
  code: string;
  diagnosis: Record<string, unknown>;
} {
  return {
    ok: false,
    error: decision.error,
    code: decision.code,
    diagnosis: decision.diagnosis,
  };
}
