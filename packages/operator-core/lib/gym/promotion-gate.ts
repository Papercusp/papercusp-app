/**
 * P-002 / D-004(3) — the promotion gate for INSTALLING a gym challenger's prompt
 * where real agents read it.
 *
 * The owner ruling is worded about the consequence, not one table: "a challenger may
 * not be installed into harness_prompt_overrides unless it holds the real-anchor pool
 * (P-002)". `gates.ts` decides whether the loop ACCEPTS a candidate; this module is the
 * last check before that acceptance becomes a live prompt mutation, and it exists
 * because the loop is not the only route to one. Today there are two:
 *
 *   1. `decideProposal` (gym/control-plane.ts) → writes `harness_prompt_overrides`.
 *      Reached by the auto-decide path AND by the human `gym:accept` route for a
 *      legacy (non-blueprint) harness.
 *   2. `acceptProposalViaCommit` (blueprint/commit-reproject-real.ts) → commits the
 *      prompt to the harness's own git tree and re-projects it. Reached by the human
 *      `gym:accept` route for a blueprint harness. It post-dates D-004 and installs
 *      the same prompt by a different mechanism, so the ruling covers it too.
 *
 * The auto path was already fail-closed (`isPromotableCandidate` requires every gate to
 * be an affirmative pass, and `real-anchor-no-regress` is now one of them). The HUMAN
 * routes were not: they take a decision and write. That is the identical hole D-004 was
 * ruling on — a toy-earned winner reaching the live prompt every real agent spawn reads
 * — just with a click instead of a cycle. Hence a shared gate rather than a second copy
 * of the reasoning in each caller.
 *
 * NOT-MEASURED IS NOT A PASS, and the two refusals are kept distinct on purpose:
 * `real_anchor_regressed` means we measured the real-anchor pool and the challenger got
 * worse; `real_anchor_unproven` means we never established that it holds. Collapsing
 * them would hide which one you are looking at, and they call for opposite responses
 * (abandon the candidate vs. run the pool).
 */
import type { CandidateVersionVerdict } from './loop';

/** The gate id `evaluateGates` emits for the real-anchor non-regression check. */
export const REAL_ANCHOR_GATE = 'real-anchor-no-regress';

/** Why an install was refused. */
export type PromotionRefusal = 'real_anchor_regressed' | 'real_anchor_unproven';

export interface PromotionGateResult {
  /** True only on an affirmative, measured pass. */
  held: boolean;
  /** Null iff `held`. */
  reason: PromotionRefusal | null;
  /** Human-readable detail for the refusal (the gate's own detail when it has one). */
  detail: string | null;
}

const HELD: PromotionGateResult = { held: true, reason: null, detail: null };

/**
 * Does this candidate's persisted verdict AFFIRMATIVELY show it holds the real-anchor
 * pool? Fail-closed by construction: every path that is not a measured pass refuses.
 *
 * Deliberately reads `status`, with the derived `pass` only as the fallback for a row
 * persisted before the three-state change (P-003). A pre-P-002 verdict carries no
 * real-anchor gate at all and is therefore `unproven`, which is the correct reading of
 * D-004(3) — the ruling requires the challenger to HOLD the pool, and silence about a
 * pool that was never scored is not evidence that it held.
 */
export function realAnchorHeld(candidate: CandidateVersionVerdict | null | undefined): PromotionGateResult {
  if (!candidate || !Array.isArray(candidate.gateResults)) {
    return { held: false, reason: 'real_anchor_unproven', detail: 'no candidate-version verdict is recorded for this proposal' };
  }
  const gate = candidate.gateResults.find((g) => g?.gate === REAL_ANCHOR_GATE);
  if (!gate) {
    return {
      held: false,
      reason: 'real_anchor_unproven',
      detail: `the verdict carries no ${REAL_ANCHOR_GATE} gate (it predates P-002)`,
    };
  }
  // `status` is authoritative; `pass` is the pre-P-003 fallback and is DERIVED from it,
  // so the two can never disagree on a row that has both.
  const status = (gate as { status?: string }).status ?? (gate.pass ? 'pass' : 'fail');
  if (status === 'pass') return HELD;
  if (status === 'fail') {
    return { held: false, reason: 'real_anchor_regressed', detail: gate.detail || 'the challenger regressed the real-anchor pool' };
  }
  return {
    held: false,
    reason: 'real_anchor_unproven',
    detail: gate.detail || `the ${REAL_ANCHOR_GATE} gate is ${status}`,
  };
}
