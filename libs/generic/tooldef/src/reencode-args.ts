/**
 * reencode-args — the EXECUTE half of D-104 (coordination-spec-adoption-2026-08-03, P-016).
 *
 * `corrected-call.ts` is the REFUSAL half: it hands back a finished call and stops. This is
 * its narrower sibling — the corrections that may actually RUN. D-104, quoting the owner:
 *
 *   "if we know the corrected call why not actually run the corrected call and just return
 *    the result (we can also tell them how the system corrected it so they just call it
 *    right the next time)"
 *
 * THE BOUNDARY, and it is the whole of the design. Only a RE-ENCODING may auto-run: a total,
 * deterministic re-shape with exactly ONE candidate output, adding no information the caller
 * did not supply. A DISAMBIGUATION (we chose among candidates) or a MISSING VALUE (the caller
 * omitted something) must refuse, because "running a guess answers a question the caller did
 * not ask". Every correction reachable from `corrected-call.ts` is a disambiguation — a
 * near-name key rename, or a dropped key — which is exactly why that module never executes
 * and this one is a separate, opt-in surface rather than a flag on it.
 *
 * THE DISCLOSURE IS A SAFETY PROPERTY, NOT A NICETY. EI-10883 established that an undeclared
 * arg must be REJECTED rather than silently ignored, because `ok:true` while quietly doing
 * something else is indistinguishable from success. Auto-correction is compatible with that
 * rule ONLY because the correction is announced: structured (`corrected:[{path,sent,ran,rule}]`),
 * prominent in the result, and — see below — measurable afterwards. A rule that ran silently
 * would be the EI-10883 defect wearing a helpful face.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY `reencode` MUST BE PURE, AND WHY THAT IS NOT A STYLE PREFERENCE.
 *
 * D-104's endgame clause makes auto-correction a MIGRATION mechanism, not a permanent shim:
 * log the corrections, watch the per-verb rate, and if it does not decay, promote the shape
 * agents actually send to the DECLARED shape. That measurement needs a before/after series.
 *
 * The instrument already exists and is already populated: `tool_invocations.args_json` records
 * the arguments AS THE CALLER SENT THEM, captured by the dispatcher OUTSIDE this path. So the
 * "after" series is countable with the very same query that produced the "before" baseline
 * (D-107 classified `args_json->body[]->premises` to get its 99.8%-one-shape figure), across
 * the change boundary, from ONE consistent instrument.
 *
 * That property is worth more than a bespoke correction log, and it is bought entirely by
 * purity: re-encode into a NEW object and the ledger keeps the caller's original shape; mutate
 * the input in place and you destroy the only signal that can tell you whether the crutch is
 * working. A stamped-metadata log would additionally exist only from the day it shipped, so the
 * before/after comparison would cross instruments — the classic way a decay measurement lies.
 *
 * Hence: no new column, no new write on the hot path, nothing to drift. The rule is the code;
 * the log is `args_json`. (Derived-truth ladder, rung 1: DERIVE from the single source.)
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

/** What one applied re-encoding did, as disclosed to the caller. D-104's `{path,sent,ran,rule}`. */
export interface AppliedArgCorrection {
  /** Dotted path to the corrected value, e.g. `body.0.premises`. */
  readonly path: string;
  /** What the caller sent at that path (bounded — see `boundValue`). */
  readonly sent: unknown;
  /** What we ran instead (bounded). */
  readonly ran: unknown;
  /** Identifies the rule, so a reader can find the ruling that authorised it. */
  readonly rule: string;
  /**
   * Sibling keys present on the caller's value that the corrected form does not carry.
   *
   * D-107 ruling 1 makes naming these mandatory: dropping a field the caller supplied without
   * saying so is the EI-10883 hazard in miniature, and the disclosure is what makes the
   * correction admissible at all. A rule that discards data silently must not be registered.
   */
  readonly dropped?: readonly string[];
}

export interface ArgReencodingOutcome {
  /** A NEW args object. Never the input, never a mutation of it (see the purity note above). */
  readonly input: unknown;
  readonly corrections: readonly AppliedArgCorrection[];
}

/**
 * One registered re-encoding, declared on the tool that owns the shape.
 *
 * The rule is declared BESIDE the schema it repairs (the arg's own module) rather than in a
 * central registry, for the same reason `argRedirects` is: a rule that outlives the field it
 * corrects is worse than no rule, and adjacency is what makes that visible in review.
 */
export interface ArgReencoding {
  /** Stable identifier, e.g. `premises.unwrap-ref-objects`. Appears in the disclosure. */
  readonly rule: string;
  /**
   * Pure. Returns null when the rule does not apply.
   *
   * CONTRACT: must not mutate `input`, and must only match values that CANNOT validate against
   * the declared schema. Both halves are load-bearing — the first preserves the decay
   * instrument, the second means a valid call can never be silently re-shaped. This surface is
   * consulted only after validation has already failed, so the second is belt-and-braces, but
   * a rule that could rewrite a VALID call would be a silent behaviour change, not a repair.
   */
  readonly reencode: (input: unknown) => ArgReencodingOutcome | null;
}

/** Longest scalar echoed back in a disclosure before it becomes a placeholder. */
const DISCLOSED_VALUE_MAX = 200;

/**
 * Bound a disclosed value so a large arg cannot turn a helpful line into the bulk of the
 * result. Mirrors `corrected-call.ts`'s `renderValue` in intent: say what was elided rather
 * than clipping silently, because a clipped value reads as the real one.
 */
export function boundValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= DISCLOSED_VALUE_MAX ? value : `<your original ${value.length}-char string>`;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    return '<unserializable>';
  }
  if (serialized.length <= DISCLOSED_VALUE_MAX) return value;
  if (Array.isArray(value)) return `<your original ${value.length}-item array>`;
  return '<your original value>';
}

/**
 * Apply every registered re-encoding in order, threading each rule's output into the next.
 *
 * Returns null when no rule applied, so the caller falls through to the ordinary refusal and
 * appends nothing. A rule that throws is skipped rather than allowed to convert a clean
 * `invalid_args` refusal into an opaque handler crash — the caller is already on the failure
 * path, and a broken repair must never be worse than no repair.
 */
export function applyArgReencodings(
  reencodings: readonly ArgReencoding[] | undefined,
  input: unknown,
): ArgReencodingOutcome | null {
  if (!reencodings || reencodings.length === 0) return null;
  let current = input;
  const corrections: AppliedArgCorrection[] = [];
  for (const rule of reencodings) {
    let outcome: ArgReencodingOutcome | null = null;
    try {
      outcome = rule.reencode(current);
    } catch {
      continue;
    }
    if (!outcome || outcome.corrections.length === 0) continue;
    current = outcome.input;
    corrections.push(...outcome.corrections);
  }
  if (corrections.length === 0) return null;
  return { input: current, corrections };
}

/**
 * The line prepended to a corrected result.
 *
 * Ordered finished-form FIRST, then what changed — the same ordering `correctedCallHint` uses,
 * for the same measured reason (D-105: "an advisory emitted after that wall is one the reader
 * has already scrolled past"). It says the call RAN, because the failure mode to avoid is a
 * caller who reads a correction notice as a refusal and retries a call that already succeeded.
 */
export function correctedDisclosure(corrections: readonly AppliedArgCorrection[]): string {
  if (corrections.length === 0) return '';
  const parts = corrections.map((c) => {
    const dropped =
      c.dropped && c.dropped.length > 0
        ? ` — DROPPED the sibling key(s) ${c.dropped.map((k) => `\`${k}\``).join(', ')}, which the declared shape does not carry`
        : '';
    return `\`${c.path}\`: ran ${JSON.stringify(c.ran)} instead of ${JSON.stringify(c.sent)} [${c.rule}]${dropped}`;
  });
  return (
    `AUTO-CORRECTED AND RAN — this call SUCCEEDED; do not retry it. ${parts.join('; ')}. ` +
    'The result below is the corrected call\'s. Send the corrected shape next time: the ' +
    'correction is a migration aid, not part of the contract, and it is measured — if callers ' +
    'keep sending the old shape it gets promoted or removed, never left as a silent crutch.'
  );
}
