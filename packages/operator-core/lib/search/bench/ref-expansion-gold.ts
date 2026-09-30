/**
 * ref-expansion-gold.ts — the DERIVED ground-truth construction behind D-076,
 * lifted out of `ref-expansion-recall-cli.ts` so a second consumer can reuse it
 * instead of re-deriving it (plan semantic-search-fingerprint-coverage-2026-08-03,
 * D-077 §3 / WI-37638).
 *
 * WHAT THE GOLD IS, EXACTLY — read this before treating a label as truth:
 *
 *   For a query derived from referenced item R's title, the relevant documents
 *   are every pooled row whose text CITES R (a `WI-…`/`EI-…`/`F-…`/`D-…` token
 *   resolving to R in the same harness). The label is therefore **structural,
 *   known by construction, and free** — it needs no annotator and cannot rot.
 *
 * ⚠ STRUCTURAL ≠ SEMANTIC, and the gap is not noise — it is a property of the
 *   construction. A row that cites R because R is a sibling ticket, a
 *   supersession pointer, or a passing "see also" is gold-relevant while being
 *   topically about something else. Any consumer that compares a SEMANTIC
 *   judgement against these labels is measuring judge-vs-gold DISAGREEMENT,
 *   which is not the same quantity as judge ERROR: a disagreement on a positive
 *   pair is ambiguous between "the judge was wrong" and "the citation was not a
 *   topical relationship". Report the two possibilities, do not collapse them.
 *
 * READ-ONLY: this module only builds SQL text and reshapes rows. It opens no
 * connection, embeds nothing, and writes nowhere.
 */

/** The ref grammar the v2 bodySql uses — {2,20}, NOT ref-expand.ts's {2,5}. */
export const REF_TOKEN = /\b(?:WI|EI|F|D)-\d{2,20}\b/g;

const STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'into', 'when', 'then', 'than', 'they', 'them', 'their', 'have',
  'has', 'had', 'was', 'were', 'been', 'being', 'does', 'not', 'never', 'always', 'only', 'also',
  'because', 'which', 'what', 'while', 'would', 'could', 'should', 'about', 'after', 'before',
  'every', 'some', 'more', 'most', 'less', 'over', 'under', 'each', 'both', 'same', 'such', 'like',
]);

/** Deterministic 32-bit hash — makes the keyword subset reproducible across runs. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A DEGRADED query: roughly half the title's content words, in title order.
 *
 * The verbatim-title arm is a ceiling because the query IS the injected string.
 * This arm approximates a user who remembers only part of what they are after,
 * which breaks the exact-substring advantage while staying derived from real
 * text. It is NOT a paraphrase — no synonym substitution happens — so it
 * brackets the true effect from below-ish rather than estimating it exactly.
 */
export function degradedQuery(title: string, seed: string): string {
  const words = title.split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w.toLowerCase()));
  if (words.length < 4) return '';
  const keep = Math.max(3, Math.ceil(words.length / 2));
  // Rank words by a seeded hash, keep the top `keep`, then restore title order.
  const ranked = words
    .map((w, i) => ({ w, i, r: hash32(`${seed}:${w}:${i}`) }))
    .sort((a, b) => a.r - b.r)
    .slice(0, keep)
    .sort((a, b) => a.i - b.i);
  return ranked.map((x) => x.w).join(' ');
}

export interface PoolDoc {
  id: string;
  v1Text: string;
  v2Text: string;
  /** Refs this row resolves — the ground-truth edge. */
  refs: string[];
}

export interface SampledRow {
  feature_id: string;
  v1_text: string;
  refs_block: string;
  refs: Array<{ ref: string; title: string }>;
}

/** One derived query plus its construction-known relevant set. */
export interface GoldQuery {
  /** The referenced item id the query was derived FROM (also the seed). */
  ref: string;
  /** Verbatim arm: R's own title, ref tokens stripped. */
  text: string;
  /** Degraded arm: roughly half of `text`'s content words. */
  degraded: string;
  /** Every pooled doc id that cites `ref` — relevant BY CONSTRUCTION. */
  relevantIds: string[];
}

/**
 * Sample rows and resolve their [refs] appendix with the SAME self-join the
 * live bodySql uses (same regex, same DISTINCT ON, same cap 6, same
 * same-harness scoping) so `v1_text || refs_block` is byte-identical to what
 * the sweep embeds.
 */
export function sampleSql(
  candidates: number,
  docs: number,
  harness: string | undefined,
  /**
   * Optional REPRODUCIBLE sample. Omitted ⇒ `ORDER BY random()`, a fresh draw
   * each run (what the D-076 recall measurement uses). Supplied ⇒ the draw is
   * a stable hash of the row id, so a re-run judges the SAME rows.
   *
   * That matters wherever a run is COMPARED to an earlier one: a frozen judging
   * contract freezes model, rubric AND sample, and a number that moved because
   * the sample moved is not a measurement of anything the contract froze.
   */
  seed?: string,
): string {
  if (harness !== undefined && !/^[a-z0-9][a-z0-9-]{0,79}$/i.test(harness)) {
    // Interpolated, not bound — so constrain it to the slug grammar rather
    // than trusting quoting.
    throw new Error(`--harness must be a slug ([A-Za-z0-9-]), got ${JSON.stringify(harness)}`);
  }
  if (seed !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(seed)) {
    // Interpolated, same reasoning as `harness` above.
    throw new Error(`seed must be [A-Za-z0-9._-]{1,64}, got ${JSON.stringify(seed)}`);
  }
  const harnessPred = harness ? `AND wi.harness_slug = '${harness}'` : '';
  const sampleOrder = seed ? `md5(wi.feature_id || '${seed}')` : 'random()';
  return (
    `WITH cand AS (` +
    ` SELECT wi.harness_slug, wi.title, wi.summary, wi.feature_id` +
    ` FROM harness_shared.work_items wi` +
    ` WHERE length(COALESCE(wi.title, '') || E'\\n' || left(COALESCE(wi.summary, ''), 2000)) > 0` +
    ` ${harnessPred}` +
    ` ORDER BY ${sampleOrder} LIMIT ${candidates}` +
    `)` +
    ` SELECT c.feature_id,` +
    ` COALESCE(c.title, '') || E'\\n' || left(COALESCE(c.summary, ''), 2000) AS v1_text,` +
    ` r.refs_block, r.refs` +
    ` FROM cand c` +
    ` JOIN LATERAL (` +
    ` SELECT E'\\n\\n[refs] ' || string_agg(t.ref || ': ' || left(COALESCE(t.rtitle, ''), 200), '; ' ORDER BY t.ord) AS refs_block,` +
    ` jsonb_agg(jsonb_build_object('ref', t.ref, 'title', left(COALESCE(t.rtitle, ''), 200)) ORDER BY t.ord) AS refs` +
    ` FROM (SELECT d.ref, d.ord, w2.title AS rtitle` +
    ` FROM (SELECT DISTINCT ON (mm.ref) mm.ref, mm.ord` +
    ` FROM (SELECT m.match[1] AS ref, m.ord` +
    ` FROM regexp_matches(COALESCE(c.title, '') || ' ' || COALESCE(c.summary, ''),` +
    ` '\\y((?:WI|EI|F|D)-[0-9]{2,20})\\y', 'g') WITH ORDINALITY AS m(match, ord)) mm` +
    ` ORDER BY mm.ref, mm.ord) d` +
    ` JOIN harness_shared.work_items w2` +
    ` ON w2.harness_slug = c.harness_slug AND w2.feature_id = d.ref` +
    ` ORDER BY d.ord LIMIT 6) t` +
    `) r ON TRUE` +
    ` WHERE r.refs_block IS NOT NULL` +
    ` LIMIT ${docs}`
  );
}

/** Reshape sampled rows into the retrieval pool (both arms of the A/B). */
export function buildPool(rows: readonly SampledRow[]): PoolDoc[] {
  return rows.map((r) => ({
    id: r.feature_id,
    v1Text: r.v1_text,
    v2Text: r.v1_text + r.refs_block,
    refs: (r.refs ?? []).map((x) => x.ref),
  }));
}

/**
 * Derive the query set + its construction-known gold from the sampled rows.
 *
 * Ground truth: for a query derived from item X's title, EVERY pooled row that
 * resolves a ref to X is relevant — not merely the row we sampled X from.
 *
 * A query is the referenced item's own title with ref TOKENS stripped: the id
 * string already occurs in the referencing row under BOTH recipes, so leaving
 * it in would hand v1 a lexical channel the treatment never added.
 */
export function buildGoldQueries(rows: readonly SampledRow[], queriesWanted: number): GoldQuery[] {
  const refTitle = new Map<string, string>();
  const referencedBy = new Map<string, string[]>();
  for (const r of rows) {
    for (const { ref, title } of r.refs ?? []) {
      if (title && !refTitle.has(ref)) refTitle.set(ref, title);
      const list = referencedBy.get(ref);
      if (list) list.push(r.feature_id);
      else referencedBy.set(ref, [r.feature_id]);
    }
  }

  return [...referencedBy.entries()]
    .map(([ref, docIds]) => {
      const text = (refTitle.get(ref) ?? '').replace(REF_TOKEN, ' ').replace(/\s+/g, ' ').trim();
      return { ref, text, degraded: degradedQuery(text, ref), relevantIds: [...new Set(docIds)] };
    })
    .filter((q) => q.text.length >= 20 && q.degraded.length > 0)
    .sort((a, b) => b.relevantIds.length - a.relevantIds.length)
    .slice(0, queriesWanted);
}
