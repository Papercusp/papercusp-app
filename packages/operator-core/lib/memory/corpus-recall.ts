/**
 * corpus-recall — the PURE selection core for the second retrieval leg
 * (context-injection-audit-2026-07-28 P-008, built to D-037).
 *
 * The injector reads mem0 memories ONLY. Of the four places the motivating
 * answer was stored, exactly one was reachable by auto-injection: the mem0
 * memory. The work-item post that held the actual evidence, the source
 * docstring with the owner's words, and the plan were all structurally
 * unreachable. This leg makes `session_turns` + work-items reachable.
 *
 * THREE THINGS THIS IS NOT, each forced by evidence (D-037):
 *
 *   1. NOT a fourth pool in the mem0 ranked list. The memory store embeds with
 *      harrier-oss @ native 1024 (`memory_vec_harrier`, 100% of
 *      `memory_canonical`); every prose surface — session_turns, work_items,
 *      docs, plans — stays in gemma@768 (its NATIVE width, per migration 727 /
 *      `PROSE_VECTOR_DIMS`; see `proseSurfacePreference` in
 *      ./configure). One query vector cannot score both, so these hits can
 *      never join the single comparable ranking F-C/D-011 built. Merging them
 *      anyway could only be done by a fixed priority, which D-011 names "a
 *      quota under another name".
 *
 *   2. NOT a share of INJECTION_TOTAL_LIMIT. Measured 2026-08-02 over
 *      memory_recall_stats (surface='turn-start', 7d, n=557): the user pool
 *      ALONE fills all 12 slots on 64.3% of recalls. A fourth competitor there
 *      is dead on arrival, and when it did place it would evict a
 *      floor-passing memory. This leg carries its own small item cap and its
 *      own char budget, and takes nothing from the three pools.
 *
 *   3. NOT raw content. A bounded matched excerpt + source label, while the
 *      structured result retains a resolvable handle for programmatic users.
 *      Inlining whole transcript turns from a ~400k-turn corpus would consume
 *      the block to say less; the evidence-bearing match is the useful unit.
 *
 * WHY THERE IS NO ABSOLUTE SCORE FLOOR HERE — read before adding one. The
 * score arriving from the search engine in hybrid mode is a fused RRF value
 * (~1/(60+rank)), a function of RANK WITHIN ONE CALL. It is not on any
 * absolute scale, so a constant compared against it means nothing — precisely
 * the conflation P-036/D-036 was written to stop. Admission here is therefore
 * a RANK CUT plus a scale-free relevance guard (shared query terms), never a
 * magic constant. Note also that the precision asymmetry runs the other way
 * from the mem0 push path: an irrelevant FACT pollutes the turn's reasoning
 * (hence that path's 0.45 cosine floor), while an irrelevant bounded excerpt
 * costs ~200 chars and is ignored.
 *
 * PURE — no PG, no embedder, no clock. The live leg is ./corpus-recall-io.
 */

/** A ranked hit handed in by the live leg (structurally mirrors the search
 *  engine's `SearchHit` without importing its surface). */
export interface CorpusHit {
  /** Search source label: 'session_turn' | 'work_item'. */
  source: string;
  /** `<source_kind>:<session_id>:<turn_idx>` for a turn; the issue id for a work-item. */
  sourceId: string;
  /** work_item: 'harness:<slug>' | 'operator'. session_turn: the harness slug, usually absent. */
  scope?: string | null;
  /** The first ~200 chars of the body — the LEAD, not necessarily the match. */
  excerpt: string;
  /**
   * The ts_headline fragment around the actual match, `<mark>`-wrapped. Strongly
   * preferred over `excerpt` for the teaser: on a long work-item body the match
   * is routinely past the 200-char lead, so an excerpt teaser shows the agent a
   * pointer without showing it WHY the pointer is here — and the term-overlap
   * guard, reading that same lead, would then drop the hit as irrelevant when
   * it is not. Optional: a source that skipped highlighting falls back cleanly.
   */
  highlight?: string | null;
  /** Fused RRF (hybrid) — rank-derived, NOT an absolute similarity. See header. */
  score: number;
  ts?: string | number | Date | null;
  /** Which rankers contributed ('bm25' / 'embeddings'). Agreement breaks ties. */
  rankers?: readonly string[];
  /**
   * work_item only: the `lane` column off `harness_shared.engineer_issues` —
   * null/absent = the ordinary work/triage lane, `'observation'` = the pre-idea
   * reflection lane. See WORK_ITEM_LANE_NOTE in agent-tools/search/sources.ts.
   *
   * Absent for a hit built without it (an older caller, a test fixture, the
   * session_turn source), and `isObservationHit` treats absence as "not an
   * observation" deliberately: a lane that fails to project must degrade to
   * today's behaviour, never silently reclassify the whole corpus.
   */
  lane?: string | null;
}

/** The resolvable pointer — same concept as ambient-push's QueryHandle. Never
 *  carries content; `resolve` is the literal tool call that fetches it. */
export interface CorpusHandle {
  /**
   * `observation` is a work_item row on the `lane='observation'` reflection lane
   * — same relation, same id space, same `resolve` call as `work-item`, but NOT
   * a curated artifact. It is a distinct kind rather than a flag because every
   * consumer that renders or ranks a handle has to tell them apart (P-003/P-004).
   */
  kind: 'work-item' | 'observation' | 'session';
  /** The id to resolve: a WI-/EI- id, or `<source_kind>:<session_id>`. */
  ref: string;
  /** The matched query terms — the "why", and the re-pull query. */
  query: string[];
  /** The tool call that resolves this handle, rendered for the agent. */
  resolve: string;
}

export interface CorpusLine {
  line: string;
  handle: CorpusHandle;
  score: number;
}

export type CorpusDropReason =
  | 'ambient-excluded'
  | 'self-session'
  | 'out-of-scope'
  | 'no-term-overlap'
  | 'duplicate-ref'
  | 'not-novel'
  | 'cap-exhausted'
  | 'budget-exhausted';

export interface CorpusDrop {
  ref: string;
  reason: CorpusDropReason;
}

export interface SelectCorpusInput {
  hits: readonly CorpusHit[];
  /** The retrieval query — the term source for the overlap guard + the handle. */
  queryText: string;
  /**
   * Drop hits from the CALLER'S OWN sessions — the whole carry-respawn chain,
   * not just the live one. Resolved in `corpus-recall-io` from the caller's
   * coord ownerId (`session_turns.owner`); this core stays pure and is handed
   * the finished set.
   *
   * ⚠ A SET, and OWNER-WIDE, for two measured reasons (EI-19460887729945170):
   *
   * 1. THE SINGLE-ID FORM WAS INERT IN PRODUCTION. Both injection ports pass
   *    `session.sessionId`, which is documented as the per-agent coord ownerId
   *    `su-xxxx…` (claim-port.ts) — never a native transcript uuid, which is
   *    what `sessionIdOfHit` returns. The two identity spaces cannot compare
   *    equal, so this filter never fired on a real turn. Measured 2026-08-03:
   *    `self-session drops: 0`, with 3 of 6 admitted lines being the caller's
   *    own sessions.
   * 2. ONE SESSION IS THE WRONG UNIT ANYWAY. An agent's identity outlives a
   *    native session: after a compaction or carry-respawn its EARLIER turns
   *    carry different uuids, stop being "self", and — being the densest
   *    documents in the corpus for whatever it is working on — rank above the
   *    durable answer and consume the budget. Measured on the same query:
   *    excluding only the newest session freed a slot that went to ANOTHER of
   *    the caller's sessions, while `WI-6512` stayed dropped `cap-exhausted`.
   *
   * Dropping (not merely deprioritising) is right because the pointer would be
   * strictly redundant: every wake already delivers the OWNER-scoped
   * `sessions:search { session:'self' }` recall pointer, which covers this
   * session and every prior one — a superset of what a per-session corpus line
   * resolves to.
   */
  excludeSessionIds?: ReadonlySet<string>;
  /**
   * Harnesses in scope. Applied to WORK-ITEM hits only, in this pure core
   * rather than as a SQL `scopeFilter`, and that split is deliberate:
   * 396,798 of 396,826 session turns (99.993%) carry `harness_slug IS NULL`
   * (file-sourced claude/codex transcripts are stamped workspace 'default' by
   * design), so a harness-scoped SQL filter would leave the turn leg able to
   * match at most 28 rows — structurally empty while looking healthy. That is
   * the exact failure class injection.ts's per-pool telemetry (P-026) was
   * added to catch. Workspace scoping is the real boundary for turns; harness
   * scoping is meaningful only for work-items, whose `scope` column is
   * reliably populated. Omit/empty ⇒ no harness narrowing.
   */
  harnessSlugs?: readonly string[];
  /** Handle refs the agent already carries (dedup across injection moments). */
  knownRefs?: ReadonlySet<string>;
  /** The work-item the caller has declared as its current scope, when known. */
  declaredWorkItemId?: string | null;
  /** Explicit per-session refs that ambient retrieval must never inject. */
  ambientExcludedRefs?: ReadonlySet<string>;
  /** Render clock, injected for deterministic tests and paired stage labels. */
  now?: number | Date;
  /** Max lines admitted. */
  maxItems?: number;
  /** Char budget for the admitted lines. */
  budgetChars?: number;
}

export interface SelectCorpusResult {
  lines: CorpusLine[];
  /** Every candidate that did not ship, with why — auditable, like selectPushes. */
  dropped: CorpusDrop[];
}

/** Max lines this leg may contribute. Small on purpose: it is additive to a
 *  block whose mem0 half is already saturated 64.3% of the time (D-037).
 *
 *  RAISED 3 → 6 by D-060 (WI-6857). D-037 sized these two constants to bound an
 *  ADDITIVE section; nothing had yet measured what they cost in RECALL. The P-018
 *  acceptance replay did: at 3/900 the recorded answer (WI-6512) ranks 4th and is
 *  dropped `budget-exhausted` before it is ever rendered — the leg retrieved it
 *  correctly on every one of 7 batches and threw it away every time. Measured
 *  2026-08-03 against the live store over all 7 batches × 3 cap settings: 6/1800
 *  admits it; 8/3000 admits nothing further, so the wider setting is unjustified.
 *  ⚠ These are a RECALL/COST trade-off, not free parameters — re-measure before
 *  moving them, and see D-060 for what the extra chars buy and cost. */
export const CORPUS_MAX_ITEMS = 6;

/** Char budget for this leg ALONE — not a share of the mem0 budget (D-037).
 *  RAISED 900 → 1800 by D-060; see CORPUS_MAX_ITEMS for the measurement. */
export const CORPUS_BUDGET_CHARS = 1800;

/** A teaser is one bounded line; a runaway teaser must never become content. */
export const CORPUS_TEASER_MAX_CHARS = 220;

/** Ordinary English + this codebase's own boilerplate. Terms are only used for
 *  the overlap guard and the handle's re-pull query, so a missed stopword costs
 *  a slightly noisier handle, never a wrong admission. */
const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'because', 'been', 'before', 'being',
  'between', 'both', 'came', 'come', 'could', 'does', 'doing', 'done', 'down',
  'during', 'each', 'else', 'even', 'ever', 'every', 'from', 'further', 'have',
  'having', 'here', 'how', 'into', 'itself', 'just', 'like', 'made', 'make',
  'many', 'more', 'most', 'much', 'must', 'need', 'next', 'once', 'only',
  'other', 'over', 'same', 'should', 'since', 'some', 'such', 'than', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'time', 'under', 'until', 'very', 'want', 'well', 'were', 'what', 'when',
  'where', 'which', 'while', 'will', 'with', 'without', 'would', 'your',
]);

/** An id-shaped token is ALWAYS a term regardless of length — WI-6512, EI-9748,
 *  P-008, D-037, migration numbers (bare 3+ digit runs, e.g. a standalone
 *  "374"). These are exactly the tokens that make pointer-retrieval work, and
 *  a plain length filter would drop them. Used only to KEEP a short token as a
 *  candidate term (`corpusTerms`) — see {@link ID_PREFIXED_TOKEN_RE} for the
 *  narrower set allowed to short-circuit query SELECTION. */
const ID_TOKEN_RE = /^(?:[a-z]{1,3}-\d{2,}|\d{3,})$/;

/** The subset of {@link ID_TOKEN_RE} that is an actual RESOLVABLE record
 *  handle — a letter prefix plus digits (WI-6512, EI-9748, P-008, D-037).
 *  Deliberately EXCLUDES a bare digit run: measured 2026-08-03 replaying real
 *  agent batches (WI-7237), a bare 3+ digit number is overwhelmingly a port
 *  ("127" of "127.0.0.1"), a byte/char count ("1500" of "left(text,1500)"),
 *  or similar incidental numeral scraped out of a command — never a resolvable
 *  id on its own. `corpusQueryText`'s id short-circuit must use THIS regex,
 *  not `ID_TOKEN_RE`: an unprefixed number short-circuiting the query discards
 *  every other term in the batch (id ⇒ used ALONE), which on 2 of 7 replayed
 *  batches threw away all the actual prose and searched the corpus for a bare
 *  number that is not a record handle at all. `corpusTerms` still treats a
 *  bare number as a valid short CANDIDATE term via `ID_TOKEN_RE` — it may
 *  legitimately help the overlap guard (e.g. a shared port number) — it is
 *  only barred from unilaterally deciding the whole query. */
const ID_PREFIXED_TOKEN_RE = /^[a-z]{1,3}-\d{2,}$/;

/**
 * The id-prefixed token this term pool short-circuits the query on, or `null`.
 *
 * Exported as a FUNCTION rather than exposing {@link ID_PREFIXED_TOKEN_RE},
 * because the short-circuit is a RULE ("the first id-prefixed term in pool
 * order wins outright"), not just a pattern — and a second caller that
 * re-implements the rule around a shared regex agrees with `corpusQueryText`
 * only by convention. `corpus-query-clarity.ts` needs exactly this question
 * answered (a keyed query is retrievable by construction and must never be
 * assessed as unfocused prose), so both read it here and cannot drift.
 *
 * That "identical by construction, not by agreement" property is the same
 * lesson `corpus-term-df.ts` records for its tokenizer: it folds DF with
 * `corpusTerms` itself precisely so a second tokenizer cannot silently disagree.
 *
 * Takes the POOL rather than the raw text so the caller that already ran
 * `corpusTerms` does not tokenize twice. PURE.
 */
export function corpusQueryIdToken(terms: readonly string[]): string | null {
  return terms.find((t) => ID_PREFIXED_TOKEN_RE.test(t)) ?? null;
}

/**
 * Extract the comparable terms from a piece of text. Lowercased, split on
 * non-alphanumeric-and-dash, stopwords removed, keeping tokens of ≥4 chars or
 * id-shaped tokens of any length. PURE.
 */
export function corpusTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9-]+/)) {
    const t = raw.replace(/^-+|-+$/g, '');
    if (!t) continue;
    if (STOPWORDS.has(t)) continue;
    if (t.length < 4 && !ID_TOKEN_RE.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Content terms kept when the text carries no id-shaped token. TWO, and the
 * number is forced rather than chosen — see {@link corpusQueryText}.
 */
export const CORPUS_QUERY_MAX_TERMS = 2;

/**
 * Content terms handed to the COVERAGE-GRADED cascade stage, which is a
 * different question from {@link CORPUS_QUERY_MAX_TERMS} and must not inherit
 * its answer.
 *
 * Stage 1 issues an AND, so its term count is a hard selectivity knob: every
 * added term can only shrink the match set, and at ~20 candidates an AND
 * matches nothing. TWO is forced there.
 *
 * Stage 2 GRADES BY COVERAGE — it prefers documents matching more of the query
 * and degrades gracefully rather than intersecting — so the same cap actively
 * defeats it: coverage over two terms is nearly binary, leaving the mechanism
 * almost nothing to rank with. Measured on the WI-6512 replay (WI-9273): the
 * graded stage demonstrably RUNS in turns 64 and 67 and still fails, while a
 * complete pair sweep shows 9 and 4 winning pairs exist that no scalar over
 * terms can pick (df/len/position all OVERLAP between winners and losers).
 *
 * ⚠ WIDENING THIS WAS MEASURED AND DOES NOT WORK — it is 2 on evidence, not by
 * oversight, and raising it again without changing the ANCHOR will reproduce a
 * null. Paired arms in one process over the WI-6512 replay (control 2 terms vs
 * treatment 24): 1/7 vs 1/7, delta 0, with per-batch candidate counts identical
 * (3/3, 10/10, 24/24).
 *
 * WHY, and it is structural rather than a tuning miss: the graded SQL is not a
 * disjunction. `search/sources.ts` lexicalSql() matches
 * `tsv @@ anchor.a AND tsv @@ q.orq`, where `anchor` is
 * `ORDER BY n ASC LIMIT 1` over per-lexeme document frequency — i.e. EVERY
 * candidate must contain the query's RAREST term, and coverage only ranks what
 * that anchor already admitted. Adding terms can only LOWER the minimum df, so
 * a wider query moves the anchor to a rarer, more incidental token and the
 * admitted set does not grow.
 *
 * That anchor is rarity-as-selector — the same mechanism D-066 measured as
 * WORSE (known-item 2/7 → 0/7) and reverted at the query-construction level. It
 * was never reverted here, so the corpus leg still selects by rarity, one layer
 * down, where the revert did not reach.
 *
 * So the lever for WI-9273 is the ANCHOR, not the term count.
 */
export const CORPUS_GRADED_QUERY_MAX_TERMS = 2;

/**
 * Minimum corpus document frequency for a term to be worth one of the
 * {@link CORPUS_QUERY_MAX_TERMS} slots. A term attested fewer than twice cannot
 * retrieve anything but itself, so spending a slot on it is strictly wasted —
 * see {@link corpusQueryText} and D-064 for the measurement.
 */
export const CORPUS_QUERY_MIN_DF = 2;

/**
 * The corpus-frequency signal {@link corpusQueryText} selects with. INJECTED so
 * the function stays pure and testable — the same seam `lexical-cursor.ts`,
 * `topic-matcher-io.ts` and `dead-end-matcher.ts` already use for BM25 idf.
 */
export interface CorpusQuerySelectionOptions {
  /** Corpus DOCUMENT frequency of a raw `corpusTerms` token — how many corpus
   *  documents contain it. MUST be built with `corpusTerms`, not `ts_stat`
   *  (stemming mismatch — see {@link corpusQueryText}). Omit to keep the
   *  original length ordering. */
  df?: (term: string) => number;
  /** Defaults to {@link CORPUS_QUERY_MIN_DF}. */
  minDf?: number;
}

/**
 * Build the COMPACT retrieval query for this leg from the injected text.
 *
 * This is not a nicety, it is the difference between the lexical leg working
 * and being structurally dead. Both corpora are searched through
 * `plainto_tsquery`, which **ANDs every term**, and the text arriving at the
 * injection port is the raw submitted prompt, envelope and all — measured over
 * `memory_recall_stats` (3d, 2026-08-02): turn-start is clamped at 1000 chars
 * with a MEDIAN of 1000, mid-turn ~196, claim/create 300. Handing that
 * straight to the engine produces an AND of ~150 lexemes, which matches
 * nothing, ever. Verified against live PG:
 *
 *   'why did the http2 sse transport change on the endpoint'
 *     → 'http2' & 'sse' & 'transport' & 'chang' & 'endpoint'  → 0 rows
 *   'http2 transport'                                          → 3 rows
 *   'WI-6512' → 'wi' & '-6512'                                 → 11 work-items, 58 turns
 *
 * So: an ID-PREFIXED token (a letter prefix plus digits — WI-6512, EI-9748,
 * P-008, D-037) wins outright and is used ALONE. A work-item id in the prompt
 * is a near-unique retrieval key — ANDing anything beside it can only cost
 * recall, and it cannot buy precision the id does not already have. That case
 * is also this item's entire motivating example (find WI-6512 and its post),
 * so it is the case worth optimizing.
 *
 * A BARE digit run (no letter prefix) does NOT short-circuit, even though
 * `corpusTerms` keeps it as a short candidate term — WI-7237, measured
 * 2026-08-03 replaying real agent batches: a bare 3+ digit number is
 * overwhelmingly incidental (a port, a byte count, a limit) rather than a
 * resolvable id, and letting it win outright discarded ALL the actual prose
 * on 2 of 7 replayed batches ("127" from `127.0.0.1`, "1500" from
 * `left(text,1500)`). It still falls through to ordinary length-based
 * selection below, where real prose terms usually outrank it.
 *
 * Failing an id, the terms are ranked and the top `maxTerms` kept. TWO rankings
 * exist, and which one runs depends on whether a corpus-frequency signal was
 * supplied (P-018 / D-064):
 *
 *   • `df` GIVEN — BANDED: discard terms the corpus attests fewer than
 *     `minDf` times, then keep the RAREST of what survives.
 *   • `df` ABSENT — LENGTH, the original crude distinctiveness proxy. Still the
 *     fallback, so a caller with no DF table behaves exactly as before.
 *
 * ⚠ THE BAND IS THE POINT, AND "KEEP THE RAREST TERMS" ALONE IS A BUG. P-018
 * originally prescribed pure rarity. Measured over 400 real turns (D-064), that
 * spends **53.3%** of its slots on terms with df<2 — hex digests, uuids,
 * session nonces — against 19.3% for the length proxy it was meant to replace.
 * A term the corpus attests fewer than twice CANNOT RETRIEVE: under
 * `plainto_tsquery`'s AND it empties the result set outright, and even in the
 * graded cascade it contributes no coverage. Maximal idf means hapax legomenon,
 * which means noise. IDF is a SCORING weight applied to documents that ALREADY
 * MATCHED — BM25 weights terms it did not choose; using it to CHOOSE the query
 * inverts it and selects exactly the terms guaranteed to match nothing. Banding
 * restores the constraint rarity dropped, and beats length on length's own
 * terms (0.0% unretrievable picks against its 19.3%).
 *
 * ⚠ `df` MUST be built with {@link corpusTerms} itself, NOT from `ts_stat`.
 * `ts_stat` returns STEMMED lexemes while selection runs over RAW tokens, so a
 * raw lookup misses on every inflection ("sessions"→"session",
 * "queries"→"queri") — and a miss reads as df 0, i.e. MAXIMAL rarity, i.e.
 * SELECTED. That silently reproduces the bug above with the most common words
 * in the corpus ranked rarest, while still looking like a working ranker.
 *
 * Selection is reachable on ~34% of real queries; the other ~66% short-circuit
 * on an id above and cannot move at any DF quality (D-064 R2).
 *
 * The same compact query also serves the EMBEDDING leg, and that is an
 * improvement rather than a compromise: a 1000-char envelope embeds mostly its
 * own boilerplate, which is precisely the effect P-041 was added to measure.
 * PURE — the DF signal is INJECTED, never fetched here.
 */
export function corpusQueryText(
  text: string,
  maxTerms = CORPUS_QUERY_MAX_TERMS,
  opts: CorpusQuerySelectionOptions = {},
): string {
  const terms = corpusTerms(text);
  if (terms.length === 0) return '';
  const id = corpusQueryIdToken(terms);
  if (id) return id;

  const k = Math.max(1, maxTerms);
  const byLength = (pool: string[]): string[] =>
    [...pool].sort((a, b) => b.length - a.length || pool.indexOf(a) - pool.indexOf(b)).slice(0, k);

  if (opts.df) {
    const minDf = opts.minDf ?? CORPUS_QUERY_MIN_DF;
    // Resolve df ONCE per term: the lookup is a Map read, but a comparator runs
    // it O(n log n) times and this pool routinely carries ~100 candidates.
    const scored = terms.map((term) => ({ term, df: opts.df!(term) })).filter((s) => s.df >= minDf);
    if (scored.length > 0) {
      return scored
        .sort((a, b) => a.df - b.df || terms.indexOf(a.term) - terms.indexOf(b.term))
        .slice(0, k)
        .map((s) => s.term)
        .join(' ');
    }
    // Every candidate is unattested. Fall through to length rather than query on
    // noise — behaviour is then exactly production's, never worse.
  }
  return byLength(terms).join(' ');
}

/** The session id a `session_turn` hit came from, or null for other sources.
 *  `sourceId` is `<source_kind>:<session_id>:<turn_idx>` and a session id may
 *  itself contain colons, so the turn index is stripped from the END. PURE. */
export function sessionIdOfHit(hit: CorpusHit): string | null {
  if (hit.source !== 'session_turn') return null;
  const parts = hit.sourceId.split(':');
  if (parts.length < 3) return null;
  return parts.slice(1, -1).join(':') || null;
}

/** The handle ref a hit collapses to: one line per WORK-ITEM, and one per
 *  SESSION (not per turn — three turns of one session is one pointer). PURE. */
export function handleRefOfHit(hit: CorpusHit): string | null {
  if (hit.source === 'work_item') return hit.sourceId || null;
  if (hit.source === 'session_turn') {
    const parts = hit.sourceId.split(':');
    if (parts.length < 3) return null;
    const kind = parts[0];
    const sid = parts.slice(1, -1).join(':');
    return kind && sid ? `${kind}:${sid}` : null;
  }
  return null;
}

/** Is a work-item hit inside the harnesses in scope? `operator`-scoped items are
 *  always in scope (workspace-wide by construction). Turn hits are never
 *  narrowed here — see SelectCorpusInput.harnessSlugs. PURE. */
function inHarnessScope(hit: CorpusHit, harnessSlugs: readonly string[]): boolean {
  if (hit.source !== 'work_item') return true;
  if (harnessSlugs.length === 0) return true;
  const scope = hit.scope ?? '';
  if (scope === 'operator' || scope === '') return true;
  return harnessSlugs.some((slug) => scope === `harness:${slug}`);
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Strip ts_headline's `<mark>` wrappers — the emphasis is markup for a web
 *  surface, noise in a prompt. PURE. */
const unmark = (s: string): string => s.replace(/<\/?mark>/g, '');

/** The text a hit is JUDGED and TEASED on: the highlighted match fragment when
 *  the source produced one, else the body lead. PURE. */
export function hitText(hit: CorpusHit): string {
  const h = unmark(hit.highlight ?? '').trim();
  return h || hit.excerpt || '';
}

/** Render the resolving tool call for a handle. This is the whole point of a
 *  handle: the agent does not have to know HOW to fetch it. PURE. */
function resolveCall(kind: CorpusHandle['kind'], ref: string, terms: string[]): string {
  // An observation resolves through the SAME call — it is a row of the same
  // relation with the same id space. Only what it IS differs, which is the label's
  // job, not the resolver's.
  if (kind === 'work-item' || kind === 'observation') return `work_items:get { id: '${ref}' }`;
  const sid = ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref;
  const q = terms.slice(0, 4).join(' ');
  return `sessions:search { session: '${sid}', query: '${q}' }`;
}

/** Resolve the timestamp representations SearchHit permits. PURE. */
function timestampMs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Render a relative age instead of a bare calendar date. A date-only label is
 * misleading around midnight: a turn from twelve hours ago can display as
 * "today" and read like current state. PURE when `now` is supplied; the
 * default is for production callers that do not need a deterministic clock.
 */
export function relativeAgeLabel(
  ts: CorpusHit['ts'],
  now: number | Date = Date.now(),
): string {
  const at = timestampMs(ts);
  const current = timestampMs(now);
  if (at === null || current === null) return '';

  const delta = current - at;
  const future = delta < 0;
  const age = Math.abs(delta);
  if (age < 60_000) return future ? 'in <1m' : 'just now';

  const units: ReadonlyArray<[number, string]> = [
    [365 * 24 * 60 * 60 * 1000, 'y'],
    [30 * 24 * 60 * 60 * 1000, 'mo'],
    [7 * 24 * 60 * 60 * 1000, 'w'],
    [24 * 60 * 60 * 1000, 'd'],
    [60 * 60 * 1000, 'h'],
    [60 * 1000, 'm'],
  ];
  const [unitMs, suffix] = units.find(([size]) => age >= size) ?? units.at(-1)!;
  const count = Math.max(1, Math.floor(age / unitMs));
  const label = `${count}${suffix}`;
  return future ? `in ${label}` : `${label} ago`;
}

/** A short relative-age label for the hit, when its timestamp is usable. */
function dateLabel(ts: CorpusHit['ts'], now: number): string {
  const age = relativeAgeLabel(ts, now);
  return age ? ` · ${age}` : '';
}

/** Mark a work-item pointer that is not about the caller's declared item. */
function workItemContextLabel(ref: string, declaredWorkItemId: string | null): string {
  const current = declaredWorkItemId?.trim();
  if (!current || ref.trim().toUpperCase() === current.toUpperCase()) return '';
  return ` · different work-item from current ${current}`;
}

/**
 * Rankers that are NOT independent evidence of relevance, and so must not count
 * toward multi-ranker agreement.
 *
 * The agreement key asks one question: "did two INDEPENDENT retrieval strategies
 * both find this?" Two names in the engine's vocabulary answer a different one and
 * would inflate it:
 *
 *  - `recency`      — appended by `applyRecencyRerank` to every hit that HAD A
 *                     USABLE TIMESTAMP. It is a property of the hit's metadata, not
 *                     a retrieval strategy that found it, so counting it would make
 *                     "carries a date" indistinguishable from "both legs agreed" —
 *                     and would rank a dated single-leg hit above an undated hit
 *                     that lexical AND embeddings both returned.
 *  - `lexical-fresh` — the same BM25 ranker as `lexical`, re-run over a time
 *                     window. Listed defensively: the corpus leg does not enable
 *                     `freshWindowMs` today (see the recency call in
 *                     corpus-recall-io.ts), so this cannot appear yet, but if it is
 *                     ever turned on it is one ranker counted twice, not two.
 */
const NON_RETRIEVAL_RANKERS: ReadonlySet<string> = new Set(['recency', 'lexical-fresh']);

/** How many INDEPENDENT retrieval strategies found this hit. PURE. */
function retrievalAgreement(hit: CorpusHit): number {
  const rankers = hit.rankers;
  if (!rankers || rankers.length === 0) return 1;
  const n = rankers.filter((r) => !NON_RETRIEVAL_RANKERS.has(r)).length;
  // A hit whose only labels were non-retrieval still came from somewhere; floor at
  // 1 so it ties with a plain single-leg hit rather than sorting below it.
  return n === 0 ? 1 : n;
}

/**
 * Kind-aware tiebreak (WI-9592 direction 2, built now that WI-9273 — the
 * upstream reach redesign this item's own D-069 measurement deferred to —
 * is done).
 *
 * D-069 measured the ceiling of this exact layer (filter → order → cut-at-six)
 * at 2/7 known-item batches: 5 of 7 are unreachable by ANY selection policy
 * (3 absent from the corpus at any depth, 2 sitting past the ~24-candidate
 * over-fetch pool), so a ranking change here can only ever move the 2
 * order-blocked batches — never the other 5. Within that narrow, bounded
 * scope it is a genuine, cheap win: a `work-item` is the durable, curated
 * artifact this leg exists to surface, while a `session` line is one agent's
 * restatement of it — on a fleet this size, restatements vastly outnumber
 * artifacts and, per D-069's own measurement, the SEMANTIC ranker actively
 * prefers them (a turn *discussing* a topic sits nearer a query about that
 * topic than the terse work-item record, while sharing fewer exact terms).
 * So at equal retrieval agreement, a work-item outranks a session — never
 * touching the score/fusion, only the final within-tier order. PURE.
 *
 * ─── P-004: THE BOOST IS RESTRICTED TO THE CURATED LANE ───────────────────────
 *
 * Read the justification above literally: the boost is earned by "the durable,
 * curated artifact this leg exists to surface". That premise is FALSE for the
 * observation lane, which shares this source's relation and id space. Measured
 * 2026-08-16: 56.7% of `harness_shared.engineer_issues` (37,089 of 65,426 rows in
 * papercusp-workspace) is `lane='observation'` — so the majority of what this
 * function was boosting is exactly the thing the rationale contrasts a work-item
 * AGAINST: one agent's unreviewed restatement, not a curated artifact.
 *
 * An observation therefore ranks WITH sessions (tier 1), not above them. It is not
 * excluded and not penalised below a session — plan D-003: a relevant past
 * observation is often genuinely useful context, and the defect was only ever the
 * unearned boost and the misleading label, never the presence of the row.
 *
 * `isObservationHit` fails toward tier 0 when the lane is absent, so a hit built
 * without the column keeps today's behaviour rather than silently demoting the
 * whole work-item population.
 */
function corpusHitKindRank(hit: CorpusHit): number {
  if (hit.source !== 'work_item') return 1;
  return isObservationHit(hit) ? 1 : 0;
}

/**
 * Is this hit an observation-lane row rather than a curated work-item? PURE.
 *
 * Deliberately asymmetric: ONLY the explicit `'observation'` lane counts. Absent,
 * null, or any other lane reads as a work-item, so a projection that silently
 * stops delivering `lane` degrades to the pre-P-003 behaviour (mislabelled
 * observations) instead of the far worse inverse — relabelling and demoting all
 * 28,335 genuine work-items at once.
 */
export function isObservationHit(hit: CorpusHit): boolean {
  return hit.source === 'work_item' && (hit.lane ?? '').trim().toLowerCase() === 'observation';
}

/**
 * Select which corpus hits reach the turn, in order:
 *   1. SELF-SESSION — drop the caller's OWN turns, across its whole owner
 *                     chain (see SelectCorpusInput.excludeSessionIds);
 *   2. SCOPE        — drop work-items outside the harnesses in scope;
 *   3. OVERLAP      — drop a hit sharing no query term with the query
 *                     (the scale-free relevance guard — see header);
 *   4. DEDUP        — one line per handle ref, best-ranked wins;
 *   5. NOVELTY      — drop refs the agent already carries;
 *   6. CAP + BUDGET — best-ranked first, up to maxItems and budgetChars.
 * Every drop is recorded with its reason. Input order is treated as relevance
 * order (the engine already fused + sorted); ties break first toward
 * multi-ranker agreement (the one scale-free quality signal available), then
 * toward kind — a CURATED work-item outranks a session at equal agreement, per
 * `corpusHitKindRank`'s D-069/WI-9592 rationale, while an observation-lane row
 * ranks WITH sessions because that rationale does not hold for it (P-004) —
 * then toward fused rank. PURE.
 */
export function selectCorpusLines(input: SelectCorpusInput): SelectCorpusResult {
  const maxItems = input.maxItems ?? CORPUS_MAX_ITEMS;
  const budget = input.budgetChars ?? CORPUS_BUDGET_CHARS;
  const harnessSlugs = input.harnessSlugs ?? [];
  const known = input.knownRefs ?? new Set<string>();
  const renderNow = timestampMs(input.now) ?? Date.now();
  const declaredWorkItemId = input.declaredWorkItemId?.trim() || null;
  const queryTerms = new Set(corpusTerms(input.queryText));
  const dropped: CorpusDrop[] = [];

  // 1-4: filter, then collapse to one candidate per handle ref (first wins —
  // input is already in fused-relevance order).
  const byRef = new Map<string, { hit: CorpusHit; terms: string[]; rank: number }>();
  input.hits.forEach((hit, rank) => {
    const ref = handleRefOfHit(hit);
    if (!ref) return;
    if (input.ambientExcludedRefs?.has(ref)) {
      dropped.push({ ref, reason: 'ambient-excluded' });
      return;
    }
    const sid = sessionIdOfHit(hit);
    if (sid && input.excludeSessionIds?.has(sid)) {
      dropped.push({ ref, reason: 'self-session' });
      return;
    }
    if (!inHarnessScope(hit, harnessSlugs)) {
      dropped.push({ ref, reason: 'out-of-scope' });
      return;
    }
    // Judged on the match fragment when there is one — see CorpusHit.highlight
    // for why the body lead alone would drop genuine deep matches.
    const shared = corpusTerms(hitText(hit)).filter((t) => queryTerms.has(t));
    if (queryTerms.size > 0 && shared.length === 0) {
      dropped.push({ ref, reason: 'no-term-overlap' });
      return;
    }
    if (byRef.has(ref)) {
      dropped.push({ ref, reason: 'duplicate-ref' });
      return;
    }
    if (known.has(ref)) {
      dropped.push({ ref, reason: 'not-novel' });
      return;
    }
    byRef.set(ref, { hit, terms: shared, rank });
  });

  // 5: order. Multi-ranker AGREEMENT leads (it is the one quality signal here
  // that does not depend on an absolute scale), and the engine's fused order —
  // which since P-009 is recency-blended — orders within each agreement tier.
  const ordered = [...byRef.entries()].sort((a, b) => {
    const agree = retrievalAgreement(b[1].hit) - retrievalAgreement(a[1].hit);
    if (agree !== 0) return agree;
    const kind = corpusHitKindRank(a[1].hit) - corpusHitKindRank(b[1].hit);
    if (kind !== 0) return kind;
    return a[1].rank - b[1].rank;
  });

  // 6: cap + budget.
  const lines: CorpusLine[] = [];
  let spent = 0;
  for (const [ref, { hit, terms }] of ordered) {
    if (lines.length >= maxItems) {
      dropped.push({ ref, reason: 'cap-exhausted' });
      continue;
    }
    const kind: CorpusHandle['kind'] =
      hit.source !== 'work_item' ? 'session' : isObservationHit(hit) ? 'observation' : 'work-item';
    const handle: CorpusHandle = {
      kind,
      ref,
      query: terms.slice(0, 6),
      resolve: resolveCall(kind, ref, terms),
    };
    // P-003: an observation is a SAMPLE, not a filed+triaged artifact, and the two
    // are indistinguishable by id (both EI-/WI- rows of the same relation). The
    // "different work-item from current X" context line is deliberately NOT applied
    // to one: it presumes the ref is a work-item, so on an observation it asserted a
    // comparison between two things that were never the same kind.
    const label =
      kind === 'work-item'
        ? `work-item ${ref}${workItemContextLabel(ref, declaredWorkItemId)}`
        : kind === 'observation'
        ? `observation ${ref} · one agent's turn-end reflection, not a filed work-item`
        : `session ${ref}`;
    const teaser = oneLine(hitText(hit)).slice(0, CORPUS_TEASER_MAX_CHARS);
    const line = `- [${label}${dateLabel(hit.ts, renderNow)}] ${teaser}`;
    // WI-6870: no first-entry exemption — the teaser already caps hitText, but the
    // label/date wrapper around it can still push a single line over budget
    // (measured 945 chars against a 900 budget); the exemption let that first entry
    // through unconditionally instead of being size-checked like every other one.
    // This already `continue`s (not `break`s), so later, smaller entries still get a
    // chance to fill the space this one couldn't use.
    if (spent + line.length > budget) {
      dropped.push({ ref, reason: 'budget-exhausted' });
      continue;
    }
    spent += line.length;
    lines.push({ line, handle, score: hit.score });
  }

  return { lines, dropped };
}

/** The section heading this leg renders under. Each line is the bounded matched
 *  excerpt itself; the structured handle remains available to programmatic consumers. */
export const CORPUS_BLOCK_HEADING = 'Related context (matched excerpts)';

/** Render the selected lines as a markdown section, or null when nothing was
 *  admitted. PURE. */
export function renderCorpusBlock(lines: readonly CorpusLine[]): string | null {
  if (lines.length === 0) return null;
  return `### ${CORPUS_BLOCK_HEADING}\n\n${lines.map((l) => l.line).join('\n')}`;
}
