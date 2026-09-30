/**
 * field-reliability.ts — let a tool result say which of its OWN fields cannot bear weight.
 *
 * ## The bug class this exists to close (plan `agent-epistemics-2026-08-02` P-001)
 *
 * Every expensive mistake of the 2026-08-02 fleet morning traces to one shape: **a field that
 * looks like an observation but is a derivation, returned with no signal that it is unreliable.**
 * Cost: ~90 minutes, four careful agents, four contradictory verdicts, four-plus public
 * retractions across 16–17 recipients — and the dispute was action-irrelevant the whole time.
 *
 *   field                              looks like            actually is
 *   ─────────────────────────────────  ───────────────────   ────────────────────────────────────
 *   checkpoint `candidate`             the sha being judged  a re-read of a MOVING HEAD; the gate
 *                                                            auto-refires in-process, so pid and
 *                                                            started_at stay fixed while the
 *                                                            candidate advances past them
 *   `elapsed_sec`                      observed duration     `now − started_at`, recomputed
 *   `marker.present`                   "my change is in"     a substring COUNT with no attribution
 *   `reason: 'uncommitted'`            "it didn't make it"   a PEER's dirty edit in a shared file
 *   `reason: 'newer-commit'`           "it didn't make it"   near-permanently true on a hot file
 *
 * Individually those are filed bugs. Collectively they are ONE missing feature: there was no way
 * for a result to say *"this field is derived; it cannot answer X."* Everything arrived with equal
 * authority, so agents reasoned confidently from fields that could not support the conclusion.
 *
 * ## Why a shared vocabulary rather than another per-tool caveat string
 *
 * The codebase already carries `containment_warning`, `zeroHitCaveat`, `okFalseWarning`,
 * `fieldMissHelp`, `priorWorkWarning`, `stateWarning` — six ad-hoc spellings of the same idea,
 * each discovered separately by whoever got burned. They are prose, so nothing can enumerate
 * them, test them, or render them consistently, and a reader who has not been burned yet has no
 * cue that the sentence they are skimming is the load-bearing one.
 *
 * ## The two levers, and when to reach for each
 *
 * **`caveat()` — ANNOTATE.** The field is still worth returning; the caller just must not treat it
 * as an observation. Use when a reasonable caller can still act on it (a stale-but-indicative
 * timestamp, a best-effort count).
 *
 * **`refuseAnswer()` — REFUSE.** The honest answer is "not from this input", and returning a
 * plausible value would be WORSE than returning nothing, because a plausible value gets acted on.
 * Use when the derivation cannot support the question at all.
 *
 * The refusal is deliberately a **STRUCTURED OBJECT, never a string or a null**. That is the whole
 * point: `null`/`''`/`false` are all values a caller silently coerces (`?? 'unknown'`, `|| 0`) back
 * into a confident answer — the exact laundering this module exists to stop. An object with
 * `refused: true` cannot be mistaken for a sha, a count or a boolean, so a caller that ignores it
 * gets `undefined` on the field it wanted rather than a number it can misread. Failing LOUD beats
 * failing plausible.
 *
 * ⚠ A refusal is not a dead end and must never read as one: `insteadRead` is REQUIRED, so every
 * refusal names the surface that CAN answer the question. A refusal without a next move just
 * relocates the agent's confusion (see `release:checkpoint-run`'s own P-004 note — a refusal is
 * an answer only when it says what to do instead).
 */

/** How a field came to hold its value — the distinction callers keep losing. */
export type FieldReliability =
  /** Measured directly from the thing itself. Safe to reason from. */
  | 'observed'
  /** Computed from other fields (arithmetic, a re-read, a join). True at compute time, and only then. */
  | 'derived'
  /** A best-effort guess from an indirect signal. May be silently wrong and cannot be self-checked. */
  | 'inferred';

/** An annotation attached to a field that a caller would otherwise read as an observation. */
export interface FieldCaveat {
  /** The field's key as it appears in the result (dotted for nesting, e.g. `gate.candidate`). */
  field: string;
  reliability: Exclude<FieldReliability, 'observed'>;
  /** ONE line naming the question this field CANNOT answer. Phrase it as the question, not as advice. */
  cannotAnswer: string;
  /** The surface that CAN answer it. Required — an unreliable field with no alternative is a dead end. */
  insteadRead: string;
  /** Optional evidence/provenance (an EI id, a measurement, a file:line). */
  because?: string;
}

/**
 * A question the tool declined to answer because its only available input could not support one.
 *
 * Structurally unmistakable ON PURPOSE — see the module note. `refused: true` is a literal type so
 * `isRefusedAnswer` narrows, and no consumer can confuse this with the value it replaced.
 */
export interface RefusedAnswer {
  refused: true;
  /** The question that was asked and NOT answered. */
  question: string;
  /** Why this input cannot answer it. */
  because: string;
  /** What to read instead. Required — a refusal that strands the caller is not an answer. */
  insteadRead: string;
}

/** True when `value` is a {@link RefusedAnswer} — narrows so callers handle it before reading fields. */
export function isRefusedAnswer(value: unknown): value is RefusedAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { refused?: unknown }).refused === true &&
    typeof (value as { question?: unknown }).question === 'string'
  );
}

/**
 * Decline to answer, and say what to read instead.
 *
 * Prefer this over returning `null` whenever the caller could mistake absence for a real negative:
 * `null` is indistinguishable from "the answer is no", which is precisely how a derived
 * `candidate` produced confident wrong containment verdicts.
 */
export function refuseAnswer(args: { question: string; because: string; insteadRead: string }): RefusedAnswer {
  return { refused: true, question: args.question, because: args.because, insteadRead: args.insteadRead };
}

/** Build a {@link FieldCaveat}. A thin constructor, but it keeps the field names uniform across tools. */
export function caveat(args: {
  field: string;
  reliability: Exclude<FieldReliability, 'observed'>;
  cannotAnswer: string;
  insteadRead: string;
  because?: string;
}): FieldCaveat {
  return {
    field: args.field,
    reliability: args.reliability,
    cannotAnswer: args.cannotAnswer,
    insteadRead: args.insteadRead,
    ...(args.because ? { because: args.because } : {}),
  };
}

/** Render one caveat as the single line an agent actually reads. */
export function describeCaveat(c: FieldCaveat): string {
  return (
    `\`${c.field}\` is ${c.reliability.toUpperCase()}, not observed — it cannot answer: ${c.cannotAnswer} ` +
    `Read instead: ${c.insteadRead}.${c.because ? ` (${c.because})` : ''}`
  );
}

/** Render a refusal as the single line an agent actually reads. */
export function describeRefusal(r: RefusedAnswer): string {
  return `REFUSED — ${r.question} ${r.because} Read instead: ${r.insteadRead}.`;
}

/** The block {@link withFieldReliability} attaches to a result. */
export interface FieldReliabilityBlock {
  _fieldReliability: FieldCaveat[];
  /** Pre-rendered so a caller that only skims prose still sees it. */
  _fieldReliabilityWarning: string;
}

/**
 * Attach field-reliability caveats to a result object.
 *
 * Returns the result UNCHANGED when there are no caveats — so a caller can always call this
 * without a conditional, and a clean result never grows an empty, noise-adding block.
 */
export function withFieldReliability<T extends object>(result: T, caveats: FieldCaveat[]): T | (T & FieldReliabilityBlock) {
  if (caveats.length === 0) return result;
  const lead =
    caveats.length === 1
      ? '⚠ 1 field in this result is DERIVED/INFERRED, not observed — do not reason from it:'
      : `⚠ ${caveats.length} fields in this result are DERIVED/INFERRED, not observed — do not reason from them:`;
  return {
    ...result,
    _fieldReliability: caveats,
    _fieldReliabilityWarning: `${lead}\n  • ${caveats.map(describeCaveat).join('\n  • ')}`,
  };
}
