/**
 * Scout-loop INVARIANTS (hive-creative-ideation-2026-06-08, P-009 / brief B11).
 *
 * Pure, framework-free predicates that encode the verification-lane contract
 * (su-b6c3f) for the Scout loop's output. The plan's P-009 bar — "the loop
 * yields GROUNDED, NON-DUPLICATE, BETTABLE proposals (each with a cheap
 * experiment); NO human prompt in the cycle" — reduces to the predicates below.
 *
 * Exported (not inlined in the .test.ts) on purpose: the step builders
 * (ideators / critics / recombine) self-check their output against them, the
 * P-009 suite (`scout-loop-invariants.test.ts`) asserts them over the loop
 * output, and P-014's E2E (su-b6c3f) reuses the SAME definitions — one notion
 * of "correct", three consumers.
 *
 * REUSE, don't reinvent (su-b6c3f contract #3): the NON-DUPLICATE check routes
 * through `corpusNovelty` (critique-core.ts), which itself reuses the shipped
 * self-improvement dedup matcher (`dedupSignature` + `titleSimilarity`,
 * lib/harness/improvements/digest) — so a re-worded re-encounter of an
 * already-decided idea still collides (self-learning-central D-004).
 */
import type { CorpusDigest, CreativeLens, Idea, Proposal, ScoutExperiment } from './types';
import { CREATIVE_LENSES } from './types';
import { corpusNovelty, type CorpusEntry, type CorpusNoveltyOptions } from './critique-core';
import { digestRefSet as lensesDigestRefSet } from './lenses';

/* ── #1 grounded (D-003) ──────────────────────────────────────────────────── */

/**
 * The flat set of every drill-back `ref` the digest carries — DELEGATES to the
 * canonical `digestRefSet` in lenses.ts (flattenDigest over ALL lanes), which
 * is what the live ideator grounding validates against. This used to be a
 * hand-rolled 4-lane copy that silently fell behind as lanes were added
 * (rubricRatings / standingFacts / nicheMap), so the invariants suite graded
 * grounded ideas as hallucinating refs the real loop accepts
 * (scorecard-blender-pipeline-fixes-2026-07-11 P-004). One definition, every
 * consumer.
 */
export function digestRefSet(digest: CorpusDigest): Set<string> {
  return lensesDigestRefSet(digest);
}

/** Anything carrying corpus drill-back refs — an {@link Idea}, or a recombined Proposal. */
export interface GroundedItem {
  addressesPatternRefs: readonly string[];
}

/** Refs the item claims that the digest does NOT contain — invented / hallucinated. */
export function ungroundedRefs(item: GroundedItem, digestRefs: ReadonlySet<string>): string[] {
  return item.addressesPatternRefs.filter((r) => !digestRefs.has(r));
}

/**
 * GROUNDED (#1 / D-003): the item targets ≥1 REAL corpus pattern and invents
 * none. An empty ref set counts as ungrounded — the loop must anchor its leaps
 * to actual Hive history, not emit free-floating cleverness.
 */
export function isGrounded(item: GroundedItem, digestRefs: ReadonlySet<string>): boolean {
  return item.addressesPatternRefs.length > 0 && ungroundedRefs(item, digestRefs).length === 0;
}

/* ── #2 forced diversity (D-004) ──────────────────────────────────────────── */

export function distinctLenses(ideas: readonly Pick<Idea, 'lens'>[]): Set<CreativeLens> {
  return new Set(ideas.map((i) => i.lens));
}

/**
 * FORCED DIVERSITY (#2 / D-004): N ideators must span distinct lenses, not
 * collapse to the median "be creative" idea. `minDistinct` defaults to 2 (a
 * batch of >1 idea must use at least 2 lenses); a single idea cannot collapse.
 * The full-roster expectation (every {@link CREATIVE_LENSES} present) is asserted
 * directly in the suite via {@link distinctLenses}.
 */
export function hasForcedDiversity(
  ideas: readonly Pick<Idea, 'lens'>[],
  minDistinct = 2,
): boolean {
  if (ideas.length <= 1) return true;
  return distinctLenses(ideas).size >= minDistinct;
}

/* ── #3 non-duplicate (D-005) ─────────────────────────────────────────────── */

export interface NonDuplicateOptions extends CorpusNoveltyOptions {
  /**
   * Below this blended novelty the proposal is "the obvious / already-tried"
   * idea. Mirrors critique-core's `verdictFor` reject floor (0.34) so the suite
   * and the live critic agree on the duplicate boundary.
   */
  noveltyFloor?: number;
}

/**
 * NON-DUPLICATE (#3 / D-005): a surviving proposal must not re-propose something
 * the Hive already considered. Routes through `corpusNovelty` (the shipped dedup
 * matcher) — a duplicate iff it collides with an already-decided prior
 * (`alreadyTried`) OR its novelty is below the reject floor.
 */
export function isNonDuplicate(
  text: string,
  corpus: readonly CorpusEntry[],
  opts: NonDuplicateOptions = {},
): boolean {
  const n = corpusNovelty(text, corpus, opts);
  return !n.alreadyTried && n.novelty >= (opts.noveltyFloor ?? 0.34);
}

/* ── #4 bettable (D-006) ──────────────────────────────────────────────────── */

/** Min trimmed length for each experiment sub-field (guards "", "tbd", "ok"). */
export const MIN_EXPERIMENT_FIELD_CHARS = 8;
const TRIVIAL_FIELD = /^(tbd|n\/?a|none|todo|\?+|-+|yes|no|ok)$/i;

function isSubstantiveField(s: string | undefined): boolean {
  const t = (s ?? '').trim();
  return t.length >= MIN_EXPERIMENT_FIELD_CHARS && !TRIVIAL_FIELD.test(t);
}

/**
 * BETTABLE (#4 / D-006): every proposal ships a cheap, falsifiable first
 * experiment — the gate that keeps ideas bettable, not merely clever, and the
 * hand-off to the gym. su-d1170's STRUCTURED {@link ScoutExperiment} makes this
 * machine-checkable: assert the hypothesis, the method, AND the falsifiable
 * signal are each present + substantive — a real experiment names the observable
 * that would prove it WRONG, not a vague "try it". Typed against the real
 * {@link Proposal.cheapExperiment} shape (works on any `{ cheapExperiment }`).
 */
export function isBettable(p: { cheapExperiment: ScoutExperiment }): boolean {
  const e = p.cheapExperiment;
  if (!e) return false;
  return isSubstantiveField(e.hypothesis) && isSubstantiveField(e.method) && isSubstantiveField(e.falsifiableSignal);
}

/**
 * The comparable text of a proposal for the search-first NON-DUPLICATE check —
 * its framing + mechanism (what it does), the surface a human would scan for
 * "haven't we tried this?". Feed into {@link isNonDuplicate}.
 */
export function proposalNoveltyText(p: Pick<Proposal, 'framing' | 'mechanism'>): string {
  return `${p.framing} ${p.mechanism}`.trim();
}

/* ── #6 no human prompt in the cycle (D-010) ──────────────────────────────── */

/**
 * NO HUMAN PROMPT (#6 / D-010): the whole cycle runs from the injected
 * `ScoutLlmCall` with no human gate (no `ctx.askUser`). At runtime that reduces
 * to: the cycle did generative work through the injected model (`llmCalls > 0`)
 * AND no human-input call happened (`humanPrompts === 0`). The Queen is the
 * autonomy gate, not a human prompt. (The structural half — that the cycle's
 * deps expose no human-input port at all — is enforced by the TYPE of
 * `runScoutCycle`'s deps, which the suite checks at compile time.)
 */
export function ranWithoutHumanPrompt(counts: { llmCalls: number; humanPrompts: number }): boolean {
  return counts.llmCalls > 0 && counts.humanPrompts === 0;
}
