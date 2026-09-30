/**
 * fact-text-overlap.ts — the ONE keyword-overlap primitive for "does this carried
 * text restate something a standing fact already decided?"
 *
 * WHY IT LIVES HERE RATHER THAN IN ITS FIRST CALLER. WI-5682 introduced this
 * tokenizer + threshold inside `carry-doc.ts` for one surface: an open owner-ask that
 * re-litigates a decided fact. EI-21459285533379701 needs the identical judgement for
 * a SECOND surface — a frozen `loop:arm` goal that still echoes a claim a fact has
 * since corrected. Copying it would put two definitions of "these two texts are about
 * the same thing" in the tree, and the house rule for this family is explicit and
 * already stated twice: contested-fold.ts ("THE THRESHOLD IS NOT REDEFINED HERE ... A
 * second copy would drift, and then a key could warn on assert while reading clean on
 * orient") and loop-goal-staleness.ts ("ONE REGEX, shared ... rather than copied").
 * Two surfaces disagreeing about whether the same goal and the same fact overlap is
 * worse than either being absent, so there is one definition and both import it.
 *
 * DETERMINISTIC BY DESIGN — no LLM, no embeddings. The carry document is assembled
 * LLM-free, and this runs on the loop fire path; a model call in either place would be
 * a cost and a nondeterminism neither surface can carry.
 */

/** Lowercased words >=4 chars (hyphen/underscore kept, so `papercusp-workspace` stays
 *  one token) minus common filler. */
const STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'into', 'your', 'have', 'been', 'will', 'would',
  'should', 'could', 'than', 'then', 'them', 'some', 'more', 'most', 'only', 'just',
  'over', 'under', 'about', 'still', 'like', 'also', 'each', 'does', 'they', 'their',
  'what', 'when', 'which', 'were', 'where', 'here', 'there', 'these', 'those', 'being',
  'want', 'need', 'needs', 'make', 'made', 'used', 'using', 'onto', 'them', 'else',
]);

/**
 * The significant-token set of a text.
 *
 * ⚠ Behaviour is FROZEN by `carry-doc`'s existing ask↔fact tests: this was moved here
 * verbatim from that module, so a change to the regex or the stopword list retunes the
 * owner-ask detector too. Retune deliberately, with both surfaces measured.
 */
export function significantTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of String(s ?? '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? []) {
    if (!STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/**
 * Minimum distinct significant tokens two texts must share before they are called
 * "about the same thing" — conservative, to avoid crying wolf.
 *
 * ⚠ MEASURED, not guessed, and the measurement is what makes it safe to reuse on the
 * goal surface: applied to a loop goal against ALL of that owner's standing facts it
 * fires on 69% of live loops, dominated by the `launch-provenance` boilerplate every
 * agent holds — noise. Applied to the population the goal detector actually gates on
 * (facts CORRECTED since the loop was armed) it fires on 1 of 39 live loops. The
 * threshold is not the selectivity; the gating population is. A caller that widens the
 * population must re-measure rather than assume this number carries.
 */
export const MIN_FACT_TEXT_OVERLAP = 4;

/** One overlap hit: the fact key, and how many distinct significant tokens matched. */
export interface FactOverlapHit {
  key: string;
  shared: number;
}

/**
 * Which of `facts` overlap `text` at or above the threshold, strongest first.
 *
 * Empty when nothing reaches the threshold, when `text` carries no significant tokens,
 * or when there are no facts — every caller treats an empty result as "say nothing",
 * never as a verdict.
 */
export function overlappingFacts(
  text: string | null | undefined,
  facts: ReadonlyArray<{ key: string; body: string }>,
  minOverlap: number = MIN_FACT_TEXT_OVERLAP,
): FactOverlapHit[] {
  if (!facts.length) return [];
  const textToks = significantTokens(text ?? '');
  if (textToks.size === 0) return [];
  const hits: FactOverlapHit[] = [];
  for (const f of facts) {
    const factToks = significantTokens(f.body);
    let shared = 0;
    for (const t of textToks) if (factToks.has(t)) shared += 1;
    if (shared >= minOverlap) hits.push({ key: f.key, shared });
  }
  hits.sort((x, y) => y.shared - x.shared);
  return hits;
}
