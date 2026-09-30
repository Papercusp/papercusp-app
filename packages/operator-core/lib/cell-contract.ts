/**
 * cell-contract.ts — the shared vocabulary of the agent state-cell contract
 * (unified-agent-state-plane-2026-07-27 #D-038).
 *
 * THE CANONICAL HOME. A cell that needs one of these types imports it from here;
 * it does NOT re-declare its own copy. Re-declaring is precisely the defect this
 * module exists to fix — see below — and it is also what axis 5 (one derivation,
 * many lenses) forbids one level up, at the resolver.
 *
 * ── WHY AN ENUM AND NOT A STRING (D-038 axis 2, corollary) ───────────────────
 *
 * Axis 2 of the contract: a cell is three-valued, and `null` must never be read
 * as a positive verdict. The corollary is that the unknown must be reported IN
 * BAND — a bare `null` cannot distinguish "this question does not apply here"
 * from "I tried to measure and failed", and a caller will read the friendlier
 * one.
 *
 * Three surfaces, written independently by different authors for different
 * domains, reached that conclusion on their own AND THEN MADE THE SAME MISTAKE:
 * each reported the reason as FREE TEXT (`git-pipeline-position.ts`,
 * `candidate-contains.ts`, `scout/success-metrics.ts`). Prose cannot be branched
 * on, so the field preserved the distinction for a human reader and destroyed it
 * for a program — and the two main cases demand OPPOSITE caller behaviour:
 * `not-applicable` is a final answer, `resolver-failed` is retry-or-escalate.
 *
 * That convergence is the argument for putting this in the contract rather than
 * leaving it to resolver quality: left to individual judgement, three
 * independent teams got the same half right and the same half wrong. A contract
 * term has to be mechanically checkable — a registry can refuse a cell whose
 * nullable verdict carries no enumerated reason; it cannot check "the resolver
 * is good". As D-038 puts it: a rule whose breach is undetectable by the party
 * it protects is not a contract term, it is a hope.
 */

/**
 * WHY a cell's value is unknown. Four codes, chosen because each one implies a
 * DIFFERENT correct caller response — a distinction that is worthless unless the
 * caller can branch on it:
 *
 *  - `not-applicable`   — the question does not apply to this subject at all.
 *                         A FINAL answer: retrying changes nothing, and there is
 *                         no lever. (A path compiled into the desktop binary has
 *                         no server process, so "is the server current?" has no
 *                         meaning for it.)
 *  - `resolver-failed`  — the measurement was attempted and did not succeed.
 *                         RETRY-OR-ESCALATE: the value may well exist, and a
 *                         later read may get it.
 *  - `not-measured`     — the resolver deliberately did not look (an opt-in leg
 *                         that was not enabled, a probe skipped for cost). The
 *                         lever is to ask for it, not to retry the same call.
 *  - `insufficient-data`— the measurement partly succeeded but cannot support a
 *                         verdict (one of two operands read; a denominator too
 *                         small to divide by). More INPUT is the lever, not a
 *                         retry and not a different question.
 *
 * Deliberately NOT extensible by convention: adding a fifth code is a contract
 * change, because every caller's branch set changes with it.
 */
export type CellUnknownCode = 'not-applicable' | 'resolver-failed' | 'not-measured' | 'insufficient-data';

/**
 * The in-band unknown. `code` is the branchable fact; `detail` is the human
 * sentence — the prose these fields used to carry ON THEIR OWN, preserved rather
 * than discarded, because it is genuinely useful to an agent reading a report.
 *
 * `detail` is optional by the contract but strongly encouraged: `code` tells a
 * program what to do, `detail` tells a reader why. Supplying only `code` is
 * legal and lossy; supplying only prose is what this type exists to prevent.
 */
export interface CellUnknown {
  code: CellUnknownCode;
  detail?: string;
}

/**
 * Terse constructor — keeps a producing call site to one line so that reporting
 * the unknown properly is never the inconvenient option. (Every site that got
 * this wrong had prose sitting right there; make the correct form the cheap one.)
 */
export function cellUnknown(code: CellUnknownCode, detail?: string): CellUnknown {
  return detail === undefined ? { code } : { code, detail };
}

/**
 * Render an unknown for a prose surface (a report line, a tool `summary`). Falls
 * back to the code when no detail was supplied, so a human-facing surface never
 * renders `undefined` or silently drops the fact that the value is unknown.
 */
export function formatCellUnknown(u: CellUnknown): string {
  return u.detail ?? UNKNOWN_CODE_PROSE[u.code];
}

/** Last-resort prose per code, for a cell that supplied no `detail`. */
const UNKNOWN_CODE_PROSE: Record<CellUnknownCode, string> = {
  'not-applicable': 'This question does not apply to this subject.',
  'resolver-failed': 'The value could not be measured (the resolver failed).',
  'not-measured': 'The value was not measured on this read.',
  'insufficient-data': 'There was not enough data to reach a verdict.',
};

/**
 * Every `CellUnknownCode`, as a runtime value.
 *
 * DERIVED from the prose map rather than written out a second time, so the list and
 * the type cannot drift: `UNKNOWN_CODE_PROSE` is a `Record<CellUnknownCode, …>`, so
 * the compiler already forces it to be exhaustive, and reading its keys inherits that
 * guarantee for free. A hand-maintained sibling array is exactly the second copy of a
 * truth the code already owns that this repo's derived-truth rule exists to prevent.
 *
 * Consumer (D-008): the cell registry rejects an assessment enum that reuses one of
 * these. Read-health and domain meaning are different vocabularies — a cell answering
 * `resolver-failed` as though it were a domain verdict would let an apparatus failure
 * masquerade as a measured finding about the subject.
 */
export const CELL_UNKNOWN_CODES: readonly CellUnknownCode[] = Object.freeze(
  Object.keys(UNKNOWN_CODE_PROSE) as CellUnknownCode[],
);
