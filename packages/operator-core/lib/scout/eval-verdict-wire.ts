/**
 * eval-verdict-wire.ts — the Scout wire for compare/select eval verdicts
 * (test-gym-apiary-framework-2026-06-09 P-004).
 *
 * The tests-tab eval substrate (D-001) produces a compare/select verdict per
 * scenario: baseline + candidate variants, ranked, with at most one `selected`
 * winner. This module projects that verdict into the change-feed vocabulary the
 * Scout meta-learning rail ALREADY reads (outcome-feedback's
 * `classifyIdeaOutcome` → lens weights), so an idea evaluated on the tab feeds
 * lens meta-learning exactly like a gym/instance-rail idea — no new event log,
 * no second attribution chain (self-learning-central D-005 holds).
 *
 * The chain: a Scout idea becomes a {@link ScenarioVariant} candidate (the
 * variant id carries the idea, e.g. 'scout-idea-42'); the router records the
 * idea's provenance with `routedRef = evalVerdictRef(scenarioId, variantId)`;
 * after the eval runs, {@link evalVerdictEntries} turns the verdict into
 * proposal-kind change-feed entries (`status: accepted` for the selected
 * winner, `status: rejected` for measured losers); `computeLensOutcomes`
 * consumes them unchanged. An ERRORED arm gets NO entry — the idea stays
 * `pending` (unknown ≠ lost), same as an undecided gym proposal.
 *
 * Promotion: the `selected` winner IS the promotion signal — the router's
 * promotion path reads {@link selectedCandidate} to apply the winning variant
 * (a prompt-overlay/config-delta candidate that beat baseline beyond minDelta).
 *
 * Structurally typed against @papercusp/testing-shell's `CompareSelectResult`
 * (operator-core deliberately carries no dependency on the testing-shell lib;
 * a real CompareSelectResult is assignable to {@link EvalVerdictLike} as-is —
 * the StateOfHiveDigest ⊃ CorpusDigest convergence pattern).
 */

import type { ChangeFeedEntry } from '../curation/change-feed';

/**
 * Structural mirror of testing-shell's `CompareSelectResult` — only the fields
 * this wire reads. A `CompareSelectResult` is directly assignable.
 */
export interface EvalVerdictLike {
  scenarioId: string;
  primaryScorer: string;
  /** Winning variantId — set only on a strict primary-metric improvement. */
  selected?: string;
  selectionReason: string;
  candidates: ReadonlyArray<{
    variantId: string;
    rank: number;
    errored: boolean;
    /** Direction-normalized primary improvement vs baseline (absent = unmeasured). */
    primaryImprovement?: number;
  }>;
}

/**
 * The provenance ref for one evaluated candidate — what the router records as
 * the routed idea's `routedRef` when it sends an idea to a tab eval, and what
 * the verdict entries carry back. Shape: `eval:<scenarioId>#<variantId>`.
 */
export function evalVerdictRef(scenarioId: string, variantId: string): string {
  return `eval:${scenarioId}#${variantId}`;
}

/**
 * Project a compare/select verdict into change-feed entries, one per DECIDED
 * candidate arm:
 *
 *   - the selected winner   → `status: accepted` (classifies `won`)
 *   - a measured loser      → `status: rejected` (classifies `lost`)
 *   - an errored/unmeasured arm → NO entry (idea stays `pending`)
 *
 * The entries ride the same `proposal` kind + `status:` detail convention the
 * gym rail uses, so `classifyIdeaOutcome` needs no changes to read them.
 */
export function evalVerdictEntries(verdict: EvalVerdictLike, decidedAt: Date): ChangeFeedEntry[] {
  const ts = decidedAt.toISOString();
  const entries: ChangeFeedEntry[] = [];
  for (const c of verdict.candidates) {
    if (c.errored || c.primaryImprovement === undefined) continue; // undecided, not lost
    const accepted = verdict.selected === c.variantId;
    const ref = evalVerdictRef(verdict.scenarioId, c.variantId);
    entries.push({
      id: ref,
      kind: 'proposal',
      title: `${accepted ? 'accepted' : 'rejected'}: eval '${verdict.scenarioId}' variant '${c.variantId}' (rank ${c.rank})`,
      detail: `status: ${accepted ? 'accepted' : 'rejected'} — primary '${verdict.primaryScorer}' improvement ${c.primaryImprovement}; ${verdict.selectionReason}`,
      ref,
      ts,
    });
  }
  return entries;
}

/**
 * The promotion read: the winning candidate, or undefined when the baseline
 * held. The router/promotion path applies this candidate's variant.
 */
export function selectedCandidate(verdict: EvalVerdictLike): EvalVerdictLike['candidates'][number] | undefined {
  if (verdict.selected === undefined) return undefined;
  return verdict.candidates.find((c) => c.variantId === verdict.selected);
}
