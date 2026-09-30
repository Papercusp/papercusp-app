/**
 * The contradiction leg: the ONE narrow question, asked of the few pairs that
 * earn it.
 *
 * Plan: guidance-overlap-contradiction-scan-2026-08-08 (P-004).
 *
 * The deterministic leg answers "do these two passages say the same thing".
 * That is not yet a finding — sibling verbs SHOULD read alike (D-004 kind 1).
 * The finding is when two passages that overlap instruct OPPOSITE actions in the
 * same situation, because an agent reading one and an agent reading the other
 * behave differently and neither can tell. So the judge is asked exactly that
 * and nothing else: not "are these redundant", not "which is better", not "how
 * should this be fixed". A narrow question is what keeps the call cheap, the
 * output parseable, and the verdict auditable.
 *
 * ## The failure this module is built around: an inert judge is INDISTINGUISHABLE from a clean corpus
 *
 * This repo has shipped the same bug twice, and both instances are filed:
 * `createAnthropicJudge()` returns a silent no-op when no key resolves, and that
 * no-op returns `{ conflicts: [] }` — byte-identical to a healthy "nothing
 * contradicts". `memory:remember`'s conflict-check was DEFAULT-ON and inert in
 * this operator indefinitely (EI-18746586784230719), and the same no-op judge is
 * wired into knowledge-packs, so pack-install classification and the hive
 * conflict sweep were equally inert (EI-18747066020546067). Nothing logged;
 * nothing surfaced. The result was not merely wrong, it was REASSURING.
 *
 * That is this plan's D-001 one level up — "an empty result is not evidence" —
 * so this module inherits D-001's contract rather than repeating the bug:
 *
 *   - the report carries `inconclusive: string | null`, and a caller may read
 *     `contradictions: []` as "nothing contradicts" ONLY when it is null;
 *   - an unavailable judge sets `inconclusive`. It is never swallowed into an
 *     empty verdict list;
 *   - the flag being OFF likewise sets `inconclusive`. "Disabled" and "ran and
 *     found nothing" are different states and must not render alike;
 *   - every pair the judge ERRORED on is counted, and an all-errors run is
 *     inconclusive rather than clean;
 *   - the census reports the denominator — how many pairs were eligible, how
 *     many were actually asked — so a verdict cannot be quoted without it.
 */

import type { OverlapPairKind } from './doc-section-pair-kind';

/** One side of a pair, as the judge sees it. */
export interface JudgeSection {
  id: string;
  title: string;
  content: string;
}

/** The judge's answer to the one question. `null` means the judge could not answer. */
export interface ContradictionVerdict {
  contradicts: boolean;
  /** One sentence naming the opposed instruction. Required when `contradicts`. */
  reason: string;
}

/**
 * The injected judge. Returning `null` (rather than a false verdict) is how an
 * implementation says "I could not answer this pair" — it is counted as an
 * error, never as "no contradiction".
 */
export type ContradictionJudgeFn = (input: {
  a: JudgeSection;
  b: JudgeSection;
}) => Promise<ContradictionVerdict | null>;

/** A pair eligible for judgement — the deterministic leg's output, plus its kind. */
export interface JudgeCandidate {
  a: string;
  b: string;
  similarity: number;
  kind: OverlapPairKind;
}

export interface ContradictionFinding extends JudgeCandidate {
  reason: string;
}

export interface ContradictionCensus {
  /** Pairs handed to this module by the deterministic leg. */
  candidatesIn: number;
  /** Candidates at or above `judgeThreshold` — the eligible population. */
  eligible: number;
  /** Eligible pairs actually sent to the judge (after `maxJudged`). */
  judged: number;
  /** Eligible pairs the `maxJudged` cap left unasked. Non-zero means the run is partial. */
  unjudgedOverCap: number;
  /** Pairs whose content could not be loaded, so they could not be asked. */
  contentMissing: number;
  /** Pairs the judge threw on or answered `null`. NOT the same as "no contradiction". */
  judgeErrors: number;
  /** Judged pairs the judge said do contradict. */
  contradictionsFound: number;
}

export interface ContradictionReport {
  judgeThreshold: number;
  contradictions: ContradictionFinding[];
  census: ContradictionCensus;
  /**
   * `null` only when the judge actually ran over a population that COULD have
   * produced a finding. Otherwise a sentence naming why this result is not
   * evidence about the corpus.
   */
  inconclusive: string | null;
}

export interface JudgeContradictionsOptions {
  candidates: readonly JudgeCandidate[];
  /**
   * Only pairs at or above this similarity are asked. REQUIRED — no default.
   * The deterministic leg already ran at the calibrated overlap thresholds, and
   * this is a SECOND, stricter gate whose whole purpose is to keep the LLM leg
   * cheap by construction; a silently-defaulted value would decide the cost and
   * the recall of the expensive leg without anyone choosing it.
   */
  judgeThreshold: number;
  /** Hard cap on judge calls per run, so a degenerate corpus cannot run up a bill. */
  maxJudged: number;
  /** Whether the feature flag is on. OFF is reported as inconclusive, not as clean. */
  enabled: boolean;
  /**
   * Whether a REAL judge can be built. Kept separate from `judge` and checked
   * BEFORE any content is loaded: this is the cheap synchronous probe that
   * exists precisely so a caller never pays to feed an inert judge.
   */
  judgeAvailable: boolean;
  /** Fetch both sides' text. Missing ids are counted, never silently skipped. */
  loadSections: (ids: readonly string[]) => Promise<Map<string, JudgeSection>>;
  judge: ContradictionJudgeFn;
}

function emptyCensus(candidatesIn: number, eligible: number): ContradictionCensus {
  return {
    candidatesIn,
    eligible,
    judged: 0,
    unjudgedOverCap: 0,
    contentMissing: 0,
    judgeErrors: 0,
    contradictionsFound: 0,
  };
}

/**
 * Ask the one question of the pairs that earn it.
 *
 * Every early return sets `inconclusive`, because every one of them produces an
 * empty `contradictions` list for a reason that is NOT "the corpus is clean".
 */
export async function judgeContradictions(
  opts: JudgeContradictionsOptions,
): Promise<ContradictionReport> {
  const { judgeThreshold, maxJudged } = opts;
  if (typeof judgeThreshold !== 'number' || !Number.isFinite(judgeThreshold)) {
    throw new TypeError(
      'judgeContradictions: `judgeThreshold` must be a finite number — there is no default; it sets both the cost and the recall of the LLM leg',
    );
  }
  if (!Number.isInteger(maxJudged) || maxJudged < 1) {
    throw new TypeError('judgeContradictions: `maxJudged` must be a positive integer');
  }

  const candidatesIn = opts.candidates.length;
  const eligibleAll = opts.candidates
    .filter((c) => c.similarity >= judgeThreshold)
    .slice()
    .sort((x, y) => y.similarity - x.similarity);
  const eligible = eligibleAll.length;

  if (!opts.enabled) {
    return {
      judgeThreshold,
      contradictions: [],
      census: emptyCensus(candidatesIn, eligible),
      inconclusive: `the contradiction leg is DISABLED by its feature flag, so no pair was judged — this is not evidence that the corpus is free of contradictions (${eligible} pair(s) were eligible)`,
    };
  }

  if (!opts.judgeAvailable) {
    return {
      judgeThreshold,
      contradictions: [],
      census: emptyCensus(candidatesIn, eligible),
      inconclusive: `no contradiction judge could be built (no credential resolved), so no pair was judged — this is not evidence that the corpus is free of contradictions (${eligible} pair(s) were eligible)`,
    };
  }

  if (eligible === 0) {
    return {
      judgeThreshold,
      contradictions: [],
      census: emptyCensus(candidatesIn, 0),
      inconclusive:
        candidatesIn === 0
          ? 'the deterministic leg supplied no candidate pairs, so the judge measured nothing'
          : `no candidate pair reached the judge threshold ${judgeThreshold}, so the judge measured nothing — raise the threshold's justification or lower it, but do not read this as a clean corpus`,
    };
  }

  const toJudge = eligibleAll.slice(0, maxJudged);
  const census = emptyCensus(candidatesIn, eligible);
  census.unjudgedOverCap = eligible - toJudge.length;

  const ids = Array.from(new Set(toJudge.flatMap((c) => [c.a, c.b])));
  const sections = await opts.loadSections(ids);

  const contradictions: ContradictionFinding[] = [];
  for (const candidate of toJudge) {
    const a = sections.get(candidate.a);
    const b = sections.get(candidate.b);
    if (!a || !b) {
      census.contentMissing += 1;
      continue;
    }
    census.judged += 1;
    let verdict: ContradictionVerdict | null;
    try {
      verdict = await opts.judge({ a, b });
    } catch {
      verdict = null;
    }
    if (!verdict || typeof verdict.contradicts !== 'boolean') {
      census.judgeErrors += 1;
      continue;
    }
    if (verdict.contradicts) {
      census.contradictionsFound += 1;
      contradictions.push({
        ...candidate,
        reason: typeof verdict.reason === 'string' ? verdict.reason : '',
      });
    }
  }

  return {
    judgeThreshold,
    contradictions,
    census,
    inconclusive: judgeInconclusive(census),
  };
}

/**
 * Why a run could not have produced a trustworthy finding set — or `null`.
 *
 * Exported so the rule is testable on its own and so a consumer can re-apply it
 * to a persisted census without re-running the scan.
 */
export function judgeInconclusive(census: ContradictionCensus): string | null {
  const answered = census.judged - census.judgeErrors;
  if (census.judged === 0) {
    return `no pair reached the judge (${census.eligible} eligible, ${census.contentMissing} missing content) — an empty result here measured nothing`;
  }
  if (answered === 0) {
    return `every one of the ${census.judged} judged pair(s) failed to return a verdict — an empty result here is judge failure, not a clean corpus`;
  }
  // A partial run is still evidence for what it DID answer: the pairs it judged
  // were judged. It is only unsound as a claim about the whole candidate set, and
  // the census carries the numbers that make that visible, so it is not flagged
  // inconclusive here. Errors on SOME pairs are the same case.
  return null;
}

/**
 * Render the report so it cannot be quoted without its denominator.
 *
 * The sentence states D-001's rule inline rather than assuming the reader knows
 * it, because the whole point is that the empty case reads as good news.
 */
export function describeContradictionReport(report: ContradictionReport): string {
  const c = report.census;
  const head =
    `contradiction leg: ${c.contradictionsFound} contradiction(s) from ${c.judged} judged pair(s) ` +
    `(${c.eligible} eligible of ${c.candidatesIn} candidates at threshold ${report.judgeThreshold}` +
    `${c.unjudgedOverCap > 0 ? `, ${c.unjudgedOverCap} left unasked by the cap` : ''}` +
    `${c.contentMissing > 0 ? `, ${c.contentMissing} missing content` : ''}` +
    `${c.judgeErrors > 0 ? `, ${c.judgeErrors} judge error(s)` : ''})`;
  if (report.inconclusive) {
    return `${head}. INCONCLUSIVE — ${report.inconclusive}. An empty result here is NOT evidence that the corpus is free of contradictions.`;
  }
  return `${head}. Conclusive: the judge ran over a population that could have produced a finding, so an empty result means no contradiction was found among the pairs asked.`;
}

/**
 * The user-message body for the judge. One question, both passages, and an
 * explicit instruction to answer NO for mere overlap.
 *
 * Exported so the prompt is auditable and swappable without touching the
 * control flow above, and so a test can assert the narrow question survives.
 */
export function buildContradictionPrompt(a: JudgeSection, b: JudgeSection): string {
  return [
    'Two passages from an engineering documentation corpus overlap in wording.',
    '',
    'ONE QUESTION: do they instruct OPPOSITE actions in the same situation?',
    '',
    'Answer "yes" ONLY if an agent following passage A and an agent following passage B',
    'would do DIFFERENT, incompatible things in a situation both passages cover.',
    'Answer "no" if they merely say similar things, cover different situations,',
    'differ in emphasis or detail, or one is more specific than the other.',
    'Redundancy is NOT a contradiction.',
    '',
    `--- PASSAGE A (${a.title}) ---`,
    a.content,
    '',
    `--- PASSAGE B (${b.title}) ---`,
    b.content,
    '',
    'Reply with JSON only: {"contradicts": boolean, "reason": string}',
    'The reason must name the opposed instruction in one sentence, or be "" when contradicts is false.',
  ].join('\n');
}
