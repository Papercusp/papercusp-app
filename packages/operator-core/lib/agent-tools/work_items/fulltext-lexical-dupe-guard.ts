/**
 * fulltext-lexical-dupe-guard — EI-19298062354262754: reuse the unified work-item
 * search-first dedup (full-text search + title/summary-token Jaccard) as an ADVISORY
 * prescreen inside `work_items:create`.
 *
 * `work_items:create` already runs two dedup nets before this one: the EI-316
 * mirror-guard (title embeds an existing OPEN item id) and the P-008
 * semantic-dupe-guard (embedding cosine, hard-blocks >=0.93, soft-advises >=0.85).
 * Both have a real gap a paraphrased refile slips through: the embedding leg needs
 * the ASYNC backfill sweep to have already indexed the CANDIDATE row (a just-filed
 * item is structurally invisible to it — the exact gap EI-9940's
 * recent-lexical-dupe-guard exists to close, but only for a ~10-minute window), and
 * even once backfilled its 0.85 cosine floor is a much stricter bar than a
 * differently-worded-but-recognizably-the-same-bug refile clears days or weeks
 * later. `improvements:capture` never had this gap: its search-first pass is a
 * plain Postgres full-text search (`searchWorkItems(..., { semantic: false })` — no
 * embedding, no recency window, spans the WHOLE work-item corpus) scored by a lenient
 * 0.6 Jaccard title/summary-token threshold (`titleSimilarity` / `DUP_THRESHOLD`) — and DECLINES on a
 * hit. Measured cost of the gap: one bug (a fleet leader's `leaderBrief` dropped by
 * `coord:orient`) was filed FIVE times over two weeks — three of those priors were
 * OPEN, well-titled, and would have surfaced here.
 *
 * This guard runs the unified `searchWorkItems` lexical leg used by the work-item
 * search surface (never a second, divergent search implementation — the risk the
 * filing bug itself calls out) against every work-item family. STRICTLY ADVISORY,
 * like the semantic guard's soft band and
 * the recent-lexical guard: it never refuses a create (the two existing guards
 * already own blocking, and this repo's titles are jargon-dense enough that a
 * third blocking net would risk false-positive refusals) — a hit is merged into
 * the same candidate set, tagged `source: 'lexical-fulltext'`, so a near-duplicate is
 * still SEEN even when the embedding legs missed it (EI-19298062354262754's suggested
 * fix #2). ⚠ The tag is load-bearing: this leg scores title-token similarity, not
 * cosine, so the create-time edge writer excludes it from `dedup_edges` (D-010).
 *
 * FAIL-OPEN, same contract as its siblings: any search error, timeout, or the kill
 * switch (PAPERCUSP_WI_FULLTEXT_DUPE=off) returns null — the caller proceeds
 * silently. Only OPEN (non-terminal) candidates are surfaced.
 */
import { searchWorkItems } from '../../work-items';
import { DUP_THRESHOLD, titleSimilarity } from '../../harness/improvements/digest';
import { ALL_TERMINAL_STATUSES } from '../../work-item-blocking';
import type { SemanticDupeCandidate } from './semantic-dupe-guard';

/** Cheap single tsquery — generous but bounded, mirrors the sibling guards' budgets. */
const BUDGET_MS = 1500;
/** Surface at most this many advisory matches, same cap as the sibling guards. */
const TOP_K = 3;

export interface FulltextLexicalDupeRow {
  id: string;
  title: string;
  /** WorkItem.summary is the body/search text paired with the title. */
  summary?: string;
  state: string;
  /** WorkItem.harness is already normalized for both families. */
  harness: string | null;
}

/** Injectable seam (tests + any future non-issues space). */
export interface FulltextLexicalDupeDeps {
  searchWorkItems: (query: string) => Promise<FulltextLexicalDupeRow[]>;
}

const realDeps: FulltextLexicalDupeDeps = {
  searchWorkItems: async (query) => {
    const result = await searchWorkItems(query, { semantic: false });
    // A degraded lexical leg is not a clean no-match verdict. Throw into the
    // guard's existing fail-open boundary rather than admitting a duplicate
    // from a degraded empty page.
    if (result.legs.degraded) throw new Error('unified lexical work-item search degraded');
    return result.items.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      state: item.state,
      harness: item.harness,
    }));
  },
};

/** Resolve-null on timeout, never reject — the budget IS the fail-open (mirrors
 *  semantic-dupe-guard / recent-lexical-dupe-guard's withBudget). */
function withBudget<T>(ms: number, p: Promise<T | null>): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    (t as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(null); },
    );
  });
}

function searchableText(title: string, summary?: string): string {
  return `${title}\n${summary ?? ''}`;
}

async function classify(
  d: FulltextLexicalDupeDeps,
  input: { title: string; summary?: string; excludeId?: string },
): Promise<SemanticDupeCandidate[]> {
  const query = searchableText(input.title, input.summary);
  const rows = await d.searchWorkItems(query);
  const scored = rows
    .filter((r) => r.id !== input.excludeId && !ALL_TERMINAL_STATUSES.has(r.state))
    .map((r) => ({
      ...r,
      similarity: Math.round(titleSimilarity(query, searchableText(r.title, r.summary)) * 100) / 100,
    }))
    .filter((r) => r.similarity >= DUP_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOP_K);
  return scored.map((r) => ({
    id: r.id,
    title: r.title,
    state: r.state,
    harness: r.harness,
    similarity: r.similarity,
    source: 'lexical-fulltext' as const,
  }));
}

/**
 * Prescreen a new work-item's title+summary against ALL OPEN work-items via
 * the unified search-first mechanism (full-text search + title/summary-token
 * Jaccard, no embedding, no recency window). Returns [] for
 * "screened, no dupes" and null for "no verdict" (disabled, timed out, errored)
 * — the caller MUST treat null the same as [] (proceed; this is advisory-only and
 * NEVER blocks a create).
 */
export async function findFulltextLexicalDupes(
  input: { title: string; summary?: string; excludeId?: string },
  deps?: FulltextLexicalDupeDeps,
): Promise<SemanticDupeCandidate[] | null> {
  if (process.env.PAPERCUSP_WI_FULLTEXT_DUPE === 'off') return null;
  // Inert under vitest unless a test injects deps — mirrors the sibling guards so
  // unrelated tool tests never pay a real DB round-trip.
  if (process.env.VITEST && !deps) return null;
  try {
    return await withBudget(BUDGET_MS, classify(deps ?? realDeps, input));
  } catch {
    return null;
  }
}
