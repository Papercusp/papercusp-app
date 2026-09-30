/**
 * The Papercusp prose search surfaces, as `@papercusp/search`
 * `SearchSource`s. Each owns its own SQL (table, tsvector/embedding
 * columns, ts_headline, row→hit mapping); both `search:fulltext` (lexical)
 * and `search:semantic` (hybrid) consume this one registry, so the lexical
 * SQL lives in exactly one place.
 *
 * "lexical", not "BM25" (P-013): the ranking function here is Postgres
 * `ts_rank_cd`, which is COVER DENSITY — proximity of the query terms within
 * the document — not Okapi BM25's term-frequency/inverse-document-frequency
 * with length normalisation. They are different algorithms with different
 * failure modes, and calling this one BM25 set the wrong expectation about
 * why a short on-topic row loses to a long one.
 *
 * Extraction per papercusp-systems-abstraction-2026-05-29 (P-013/P-020).
 * session_turn + coord_message added per session-search-scope-2026-07-05
 * (D-001: new data source = new SearchSource here; a new WAY OF SCOPING =
 * a filter in the shared filter bag, never a new search verb).
 */

// P-017 (side-effect import): installs the engine-level ranking policy — the
// embedding floor every prose surface should inherit rather than hand-pass.
// Placed on the SOURCE REGISTRY, not on each caller, because a surface using
// these sources is exactly a surface the policy is calibrated for; that makes
// the coverage structural instead of another thing to remember.
import '../../search/configure-search-defaults';
import type { SearchSource, SearchSourceParams, Listing } from '@papercusp/search';
// WI-37603: every `embedding` leg below runs through this. Without it an HNSW
// scan stops at `hnsw.ef_search` (40) and silently returns fewer rows than the
// engine's `candidateLimit = limit * 3` asked for — measured 40 rows for a
// 600-row request on the live 302k-row corpus.
import { withIterativeScan, chunkAwareVectorLegSql, type ChunkAwareVectorLegOptions } from '@papercusp/search';
import { SESSION_TURN_CHUNK_SURFACE } from '../../search/turn-chunk-sync';
import { OPERATOR_TURNS_CHUNK_SURFACE, WORK_ITEMS_CHUNK_SURFACE } from '../../search/chunks/registry';

/**
 * The work_item source's chunk-leg parent: the engineer_issues VIEW, keyed by the
 * view's names for the base table's key (harness_slug, feature_id), so the
 * chunk join reaches work_items' primary key through the view.
 */
const ENGINEER_ISSUES_CHUNK_PARENT = {
  table: 'harness_shared.engineer_issues',
  key: ['base_harness_slug', 'issue_id'],
} as const;
import { OWNER_CANDIDATE_TURN_VERDICTS } from '../../turn-provenance/turn-ref';
import {
  proseProfilePredicateSql,
  resolveProseProfileIdSelection,
} from '../../search/prose-vector-dims';

/** Exact stored-space predicate for every vector source below. No extra read:
 * provenance comes from the query embedder through the engine policy. Unknown
 * or unaccepted identity becomes SQL FALSE, so the vector leg fails closed and
 * the engine can still return lexical results. */
function proseProfileSql(
  p: Pick<SearchSourceParams, 'sql' | 'embeddingProfile'>,
  profileColumn: string,
  modeColumn: string,
) {
  const selection = p.embeddingProfile
    ? resolveProseProfileIdSelection(
        p.embeddingProfile.profileId,
        p.embeddingProfile.legacyMode,
      )
    : null;
  return proseProfilePredicateSql(p.sql, selection, profileColumn, modeColumn);
}

/**
 * Standard ts_headline options for all four surfaces.
 *
 * EXPORTED so the RENDERERS can pin themselves to it instead of re-asserting
 * the delimiter from memory. `StartSel` overrides ts_headline's `<b>` default,
 * and a renderer that assumes the default silently stops highlighting: it looks
 * for a marker the engine never sends, finds none, and emits the whole headline
 * as plain text with the literal `<mark>` tags showing. Nothing throws, and a
 * renderer test written against the ASSUMED delimiter passes just as happily as
 * one written against the real one — which is exactly how
 * `GlobalSearchDialog.renderHighlight` sat splitting on `<b>` while every test
 * stayed green. Derive the marker from here; do not copy it.
 */
export const HEADLINE_OPTS =
  'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, FragmentDelimiter=" … ", MaxWords=18, MinWords=5, ShortWord=2';

const trunc = (s: string): string => s.slice(0, 200) + (s.length > 200 ? '…' : '');

/**
 * How many rows a per-lexeme document-frequency probe will count before it
 * stops. We only need the ARGMIN — which lexeme is rarest — so a lexeme that
 * exceeds the cap is simply "common", and capping makes the probe's cost
 * predictable instead of proportional to the table. Measured 2026-08-03 on
 * `session_turns` (421k rows, 5 lexemes): 121ms capped vs 159ms uncapped, same
 * anchor chosen, with the three common lexemes saturating at the cap exactly as
 * intended.
 */
const DF_PROBE_CAP = 2000;

/**
 * WI-9273 — how many candidate rows the anchor may admit, as a budget over the
 * summed document-frequency of the lexemes it anchors on.
 *
 * ⚠ THE ANCHOR USED TO BE A SINGLE `ORDER BY df ASC LIMIT 1`, AND THAT WAS A
 * RARITY SELECTOR WEARING A COST OPTIMISATION'S CLOTHES. Measured 2026-08-04 on
 * `session_turns` for `corpus recall pointer section clamp`: the single-argmin
 * anchor reached only **48 of the 95 four-of-five-coverage documents** — half of
 * the exact population coverage grading exists to rescue — because a document is
 * admitted ONLY if it contains the query's rarest term, however incidental that
 * term is. This is the same mechanism D-066 reverted at query construction
 * (BANDED, known-item 2/7 → 0/7), surviving one layer down in the search source.
 *
 * A budget over summed df bounds the COST DIRECTLY — which is the constraint the
 * anchor actually exists for — instead of using "the single rarest lexeme" as an
 * uncontrolled proxy for it. Same query, same corpus, budget 4000: **95 of 95**
 * four-of-five documents reachable, 3,567 candidates vs 1,696, and latency FLAT
 * (147ms vs 141ms — the df probe dominates and the GIN bitmap-OR is nearly free).
 * Still 6.6× under the 23,464-row unanchored disjunction that cost 745ms.
 *
 * ⛔ AND YET THE DEFAULT IS 0 — THE WIDENING IS MEASURED, BUILT, AND NOT SHIPPED.
 * The reachability defect above is real and reproducible. It is NOT evidence the
 * widening helps, and the WI-6512 known-item replay (paired arms, ONE process,
 * `--ceiling --anchor-arms`) says it does not:
 *
 *   CONTROL (budget 0)  reachable 2/7  not-retrieved 5/7  admitted 1/7  133 cand
 *   TREATMENT (4000)    reachable 2/7  not-retrieved 5/7  admitted 1/7  168 cand
 *
 * The treatment provably reached the engine — pools moved (t64 3→24, t67 10→24)
 * and slot-fill rose (t64 2/6→3/6, t67 4/6→6/6) — so this is a real null, not a
 * plumbing null. More context arrived; none of it was the answer. That is P-018's
 * shape exactly (+0.46 admitted lines while known-item retrieval fell to zero),
 * and the lesson there was that a volume/reach metric cannot validate a change
 * the relevance metric does not move.
 *
 * At DEPTH (maxItems 200 — diagnostic only, never production) it is worse than
 * neutral: the known item is DEMOTED rank 66 → 140 in t65 and t68, because the
 * newly-reachable documents outrank it. The one genuine advance is t67, where the
 * barrier MOVED FORWARD — `ABSENT (pool 10)` → `filtered [no-term-overlap] (pool
 * 800)`, i.e. retrieval now finds it and `selectCorpusLines`' overlap guard drops
 * it. That is a different, addressable barrier, and it is the reason to keep this
 * seam rather than delete it.
 *
 * So: `0` is the shipped default and reproduces the pre-WI-9273 anchor exactly.
 * Raise it only behind a known-item measurement that MOVES, never on the
 * reachability table above — that table is a story about candidates, not a
 * finding about answers.
 */
const ANCHOR_DF_BUDGET = 0;

/**
 * EI-21924046411702156: the `work_item` / `session_turn` lexical legs run on a
 * BARE `getOrgPg()` admin pool handle (their host tools declare `crossWorkspace:
 * true`, which routes `ctx.tx` straight to `getOrgPg().sql` — see
 * `_mcp-handler.ts`'s `dispatchWithSynthesizedTx` — bypassing the
 * `withWorkspace`/`inWorkspaceTxn` wrappers that install a `statement_timeout`
 * for every OTHER tool). The `coverage-graded` shape's `df` CTE computes a
 * per-lexeme document-frequency probe for EVERY query lexeme, so a long,
 * multi-word query against a large table can cost materially more than the
 * single-lexeme case `DF_PROBE_CAP`/`ANCHOR_DF_BUDGET` were tuned against.
 * Measured live: 35.7s for one such query, entirely unbounded, on the SHARED
 * org-admin pool — and it was the single query setting the floor under the
 * fleet-wide `harness_admin` role-default `statement_timeout` decision
 * (WI-1194246), because every other heavy family already self-bounds via its
 * own `SET LOCAL` (see `readiness-reconcile.ts`, the pattern mirrored below).
 *
 * A search is interactive and user-facing, so a few seconds is generous: a
 * cancelled statement here degrades that ONE source's lexical leg to `null`
 * (see `hybrid.ts`'s `runLeg` catch — `callsFailed`, never a thrown 500) while
 * every other source/leg still returns normally, so bounding this is a
 * strict improvement with no failure-mode downside.
 */
const LEXICAL_COVERAGE_STATEMENT_TIMEOUT_MS = 8_000;

/**
 * EI-24045346484356708 — how many of the caller's NEWEST in-scope transcript
 * turns the literal-substring FILL may examine.
 *
 * The fill exists for EI-23237047797741772: a pasted compact token such as
 * `furnishedfinder` lives inside a hostname lexeme (`www.furnishedfinder.com`),
 * so no dictionary lookup can find it and only a raw substring match can. No
 * index serves a substring match (a trigram index would, but the migration
 * runner cannot build one CONCURRENTLY, and a blocking build on the 13 GB ingest
 * table is the same objection that keeps migration 1163 parked). Unbounded, the
 * match was a parallel seq scan of the whole table on EVERY call — 6.4s, 6
 * processes, 2.78M buffers — and it ran for every query, including the fleet's
 * per-turn memory recall, whose derived multi-term queries it could never help.
 *
 * Bounded to the newest N rows (served by `session_turns_ingested_idx`, run
 * serially) it measured 431ms at 20,000 rows and 806ms at 50,000 on the live
 * table. At ~33k turns/day this window is ~1.5 days workspace-wide; a caller
 * that narrows scope (session / owner / since) gets the window INSIDE that
 * narrower population, so a session-scoped search still covers that session's
 * history. Dictionary-matchable terms are unaffected — they never needed it.
 */
export const LITERAL_FALLBACK_WINDOW_ROWS = 50_000;

/** Shorter literals are substring noise over transcripts (`ok` ⊂ `token`). */
const LITERAL_FALLBACK_MIN_CHARS = 3;

/**
 * EI-24045346484356708 — the literal fill runs only for a SINGLE compact token
 * (no internal whitespace, ≥ 3 chars): the case EI-23237047797741772 was filed
 * for. A multi-word query already reaches every word through the AND tsquery,
 * so a whole-phrase substring could only re-find what the index found — and its
 * cost was the full-table scan above. Returns the trimmed token, or `null` when
 * the fill must not run.
 */
export function compactLiteralToken(query: string): string | null {
  const token = query.trim();
  if (token.length < LITERAL_FALLBACK_MIN_CHARS || /\s/.test(token)) return null;
  return token;
}

/**
 * P-017 / D-062 — the lexical leg's term-combination mode, as SQL fragments.
 *
 * Both modes share ONE query shape (`ORDER BY coverage DESC, rank DESC`), which
 * is what keeps the AND path byte-identical rather than merely similar: in
 * `'and'` mode `coverage` is the constant 1, so the ordering degenerates to
 * `rank DESC` — today's query, exactly.
 *
 * ⚠ THE ORDERING IS THE WHOLE POINT, AND THE OBVIOUS VERSION IS WRONG.
 * `ts_rank_cd` scores term frequency and cover density; it cannot express how
 * many DISTINCT query lexemes a document matched. Under AND that never
 * mattered — the filter guaranteed full coverage — so removing the filter
 * leaves NOTHING expressing coverage, and an 8,000-char document repeating one
 * common term outranks a short one containing every term. Measured live on
 * `session_turns` for `corpus recall pointer section clamp`: plain disjunction
 * scored by `ts_rank_cd` put all seven all-terms documents at positions
 * 36/41/64/153/213/277/427 while the corpus leg admits SIX. Coverage-first
 * ordering puts the same seven at 1-7 and a four-of-five document — one the AND
 * query discards outright — at 8.
 *
 * The RAREST-lexeme anchor is what makes it affordable. Grading every
 * disjunctive match is correct but cost 745ms on one source against the corpus
 * leg's 2s WHOLE-leg bound; anchoring first cuts the candidate set from 23,011
 * to 1,669 and the query to 105ms, and — because every AND row necessarily
 * matches the anchor — it cannot drop a row the AND query would have returned.
 *
 * Injection-safety: the disjunctive query is derived by rewriting
 * `plainto_tsquery`'s OWN output, so Postgres does all parsing, normalisation
 * and stop-word removal and we only swap the operator. No user text is ever
 * interpolated into tsquery grammar.
 */
function lexicalSql(
  p: SearchSourceParams,
  /** The source's tsvector column, as a fragment: `p.sql\`text_tsv\``. */
  tsv: ReturnType<SearchSourceParams['sql']>,
  /** The source's table, as a fragment: `p.sql\`harness_shared.session_turns\``. */
  table: ReturnType<SearchSourceParams['sql']>,
  /** Optional exact-token vector used only for fallback-only transcript rows. */
  simpleTsv?: ReturnType<SearchSourceParams['sql']>,
) {
  const sql = p.sql;
  // `?? ` and not `||`: a caller passing 0 is asking for the argmin-only
  // control arm, not for the default.
  const anchorDfBudget = p.lexicalAnchorDfBudget ?? ANCHOR_DF_BUDGET;
  const orText = sql`replace(plainto_tsquery('english', ${p.query})::text, ' & ', ' | ')`;

  // EI-24045346484356708: there is deliberately NO literal-substring arm in
  // `match` here any more. It used to be `(tsv @@ q.andq OR position(...) > 0)`,
  // and an OR whose second arm no index can serve turns the whole predicate into
  // a PARALLEL SEQ SCAN of the table. Measured on the 1.4M-row session_turns:
  // a rare term took 1.0ms via the GIN index without the arm and 6,365ms with
  // it (2.78M buffers, 6 processes); a common term 769ms vs 4,850ms. That one
  // query shape was 146k CPU-seconds in pg_stat_statements. The literal fallback
  // now lives in `session_turn.lexical` as a separately-bounded FILL query
  // (see `compactLiteralToken` / `LITERAL_FALLBACK_WINDOW_ROWS`), so this
  // function only ever emits index-served predicates.
  if (p.lexicalMode !== 'coverage-graded') {
    return {
      with: sql`WITH q AS (
        SELECT plainto_tsquery('english', ${p.query}) AS andq
               ${simpleTsv ? sql`, plainto_tsquery('simple', ${p.query}) AS simpleq` : sql``}
      )`,
      join: sql`, q`,
      coverage: sql`1`,
      fallbackOnly: simpleTsv
        ? sql`NOT (${tsv} @@ q.andq) AND NOT (${simpleTsv} @@ q.simpleq)`
        : sql`FALSE`,
      rank: simpleTsv
        ? sql`CASE WHEN ${tsv} @@ q.andq
                   THEN ts_rank_cd(${tsv}, q.andq)
                   WHEN ${simpleTsv} @@ q.simpleq
                   THEN ts_rank_cd(${simpleTsv}, q.simpleq)
                   ELSE 0
               END`
        : sql`ts_rank_cd(${tsv}, q.andq)`,
      match: simpleTsv
        ? sql`(${tsv} @@ q.andq
               OR (${simpleTsv} @@ q.simpleq AND NOT (${tsv} @@ q.andq)))`
        : sql`${tsv} @@ q.andq`,
      headlineQuery: simpleTsv
        ? sql`CASE WHEN ${tsv} @@ q.andq THEN q.andq ELSE q.simpleq END`
        : sql`q.andq`,
      headlineConfig: simpleTsv
        ? sql`CASE WHEN ${tsv} @@ q.andq THEN 'english'::regconfig ELSE 'simple'::regconfig END`
        : sql`'english'::regconfig`,
    };
  }

  return {
    with: sql`
      WITH q AS (
        SELECT ${orText}::tsquery       AS orq,
               string_to_array(${orText}, ' | ') AS lexemes
               ${simpleTsv ? sql`, plainto_tsquery('simple', ${p.query}) AS simpleq` : sql``}
      ), df AS (
        SELECT l, (SELECT count(*) FROM (
                     SELECT 1 FROM ${table} d
                      WHERE d.${tsv} @@ l::tsquery
                      LIMIT ${DF_PROBE_CAP}
                   ) capped) AS n
          FROM q, unnest(q.lexemes) AS l
      ), ranked AS (
        SELECT l, n,
               row_number() OVER (ORDER BY n ASC, l ASC) AS rn,
               COALESCE(sum(n) OVER (ORDER BY n ASC, l ASC
                                     ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior
          FROM df
      ), anchor AS (
        -- The rarest lexeme ALWAYS anchors (rn = 1), so this can never admit
        -- fewer rows than the pre-WI-9273 argmin; every additional lexeme is
        -- taken in ascending-df order while the cumulative df stays inside the
        -- budget. A SATURATED lexeme (n = DF_PROBE_CAP) is excluded unless it is
        -- the argmin: its true df is unknown and may be 10× the cap, so
        -- anchoring on it would make the budget a fiction.
        SELECT string_agg(l, ' | ' ORDER BY n ASC, l ASC)::tsquery AS a
          FROM ranked
         WHERE rn = 1
            OR (n < ${DF_PROBE_CAP} AND prior + n <= ${anchorDfBudget})
      )`,
    join: sql`, q, anchor`,
    fallbackOnly: simpleTsv
      ? sql`NOT (${tsv} @@ anchor.a) AND NOT (${simpleTsv} @@ q.simpleq)`
      : sql`FALSE`,
    coverage: simpleTsv
      ? sql`CASE WHEN ${tsv} @@ anchor.a
                 THEN (SELECT count(*) FROM unnest(q.lexemes) AS cl WHERE ${tsv} @@ cl::tsquery)
                 ELSE 0
             END`
      : sql`(SELECT count(*) FROM unnest(q.lexemes) AS cl WHERE ${tsv} @@ cl::tsquery)`,
      rank: simpleTsv
        ? sql`CASE WHEN ${tsv} @@ anchor.a
                   THEN ts_rank_cd(${tsv}, q.orq)
                   WHEN ${simpleTsv} @@ q.simpleq
                   THEN ts_rank_cd(${simpleTsv}, q.simpleq)
                   ELSE 0
               END`
        : sql`ts_rank_cd(${tsv}, q.orq)`,
    // ⚠ NO `AND ${tsv} @@ q.orq` HERE, AND ITS ABSENCE IS NOT AN OVERSIGHT.
    // The anchor is a disjunction of a SUBSET of `q.lexemes`, so matching it
    // ALREADY implies matching `q.orq` — the clause was provably dead. Measured
    // 2026-08-04 against the shipped argmin form: `anchor` alone and
    // `anchor AND orq` both returned exactly 1,696 rows. Keeping it cost
    // nothing at runtime but read as though the stage retrieved the whole
    // disjunction (23,464 rows), which is how "coverage-graded" came to be
    // reasoned about as a disjunctive leg when it never was one.
    match: simpleTsv
      ? sql`(${tsv} @@ anchor.a
             OR (${simpleTsv} @@ q.simpleq AND NOT (${tsv} @@ anchor.a)))`
      : sql`${tsv} @@ anchor.a`,
    // Highlight against the DISJUNCTIVE query on purpose: a four-of-five
    // document has no fragment matching all five terms, and highlighting it
    // with the AND query would return the document's lead instead of the part
    // that actually matched.
    headlineQuery: simpleTsv
      ? sql`CASE WHEN ${tsv} @@ anchor.a THEN q.orq ELSE q.simpleq END`
      : sql`q.orq`,
    headlineConfig: simpleTsv
      ? sql`CASE WHEN ${tsv} @@ anchor.a THEN 'english'::regconfig ELSE 'simple'::regconfig END`
      : sql`'english'::regconfig`,
  };
}

const escalations: SearchSource = {
  name: 'escalations',
  async lexical({ sql, query, workspaceId, scopeFilter, limit }: SearchSourceParams): Promise<Listing> {
    const rows = (await sql`
      SELECT harness_slug, phase, escalation, supervisor_notes,
             ts_rank_cd(body_tsv, plainto_tsquery('english', ${query})) AS rank,
             ts_headline('english',
               COALESCE(escalation, '') || E'\n' || COALESCE(supervisor_notes, ''),
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}
             ) AS highlight
        FROM harness_shared.harness_escalations
       WHERE workspace_id = ${workspaceId}
         AND (${scopeFilter}::text IS NULL OR harness_slug = ${scopeFilter})
         AND body_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC LIMIT ${limit}
    `) as unknown as Array<{ harness_slug: string; phase: string; escalation: string | null; supervisor_notes: string | null; rank: number; highlight: string }>;
    return rows.map((r) => {
      const body = `${r.escalation ?? ''}\n${r.supervisor_notes ?? ''}`.trim();
      return {
        key: `escalations:${r.harness_slug}:${r.phase}`,
        score: r.rank,
        row: {
          source: 'escalations',
          source_id: `${r.harness_slug}:${r.phase}`,
          scope: r.harness_slug,
          excerpt: trunc(body),
          highlight: r.highlight,
          score: r.rank,
          rankers: ['lexical'],
        },
      };
    });
  },
  async embedding(p): Promise<Listing> {
    const { sql, query, workspaceId, scopeFilter, limit, qVec } = p;
    const rows = (await withIterativeScan(sql, (sql) => sql`
      SELECT harness_slug, phase, escalation, supervisor_notes,
             1 - (body_embedding <=> ${qVec}::vector) AS sim,
             ts_headline('english',
               COALESCE(escalation, '') || E'\n' || COALESCE(supervisor_notes, ''),
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.harness_escalations
       WHERE workspace_id = ${workspaceId}
         AND (${scopeFilter}::text IS NULL OR harness_slug = ${scopeFilter})
         AND body_embedding IS NOT NULL
         AND ${proseProfileSql(p, 'body_embedding_profile', 'body_embedding_mode')}
    ORDER BY body_embedding <=> ${qVec}::vector
       LIMIT ${limit}
    `)) as unknown as Array<{ harness_slug: string; phase: string; escalation: string | null; supervisor_notes: string | null; sim: number; highlight: string }>;
    return rows.map((r) => {
      const body = `${r.escalation ?? ''}\n${r.supervisor_notes ?? ''}`.trim();
      return {
        key: `escalations:${r.harness_slug}:${r.phase}`,
        score: r.sim,
        row: {
          source: 'escalations',
          source_id: `${r.harness_slug}:${r.phase}`,
          scope: r.harness_slug,
          excerpt: trunc(body),
          highlight: r.highlight,
          score: r.sim,
          rankers: ['embeddings'],
        },
      };
    });
  },
};

const brainstorm: SearchSource = {
  name: 'brainstorm',
  async lexical({ sql, query, workspaceId, scopeFilter, limit }: SearchSourceParams): Promise<Listing> {
    const rows = (await sql`
      SELECT harness_slug, phase, content,
             ts_rank_cd(content_tsv, plainto_tsquery('english', ${query})) AS rank,
             ts_headline('english', content,
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.harness_brainstorm
       WHERE workspace_id = ${workspaceId}
         AND (${scopeFilter}::text IS NULL OR harness_slug = ${scopeFilter})
         AND content_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC LIMIT ${limit}
    `) as unknown as Array<{ harness_slug: string; phase: string; content: string; rank: number; highlight: string }>;
    return rows.map((r) => ({
      key: `brainstorm:${r.harness_slug}:${r.phase}`,
      score: r.rank,
      row: {
        source: 'brainstorm',
        source_id: `${r.harness_slug}:${r.phase}`,
        scope: r.harness_slug,
        excerpt: trunc(r.content),
        highlight: r.highlight,
        score: r.rank,
        rankers: ['lexical'],
      },
    }));
  },
  async embedding(p): Promise<Listing> {
    const { sql, query, workspaceId, scopeFilter, limit, qVec } = p;
    const rows = (await withIterativeScan(sql, (sql) => sql`
      SELECT harness_slug, phase, content,
             1 - (content_embedding <=> ${qVec}::vector) AS sim,
             ts_headline('english', content,
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.harness_brainstorm
       WHERE workspace_id = ${workspaceId}
         AND (${scopeFilter}::text IS NULL OR harness_slug = ${scopeFilter})
         AND content_embedding IS NOT NULL
         AND ${proseProfileSql(p, 'content_embedding_profile', 'content_embedding_mode')}
    ORDER BY content_embedding <=> ${qVec}::vector
       LIMIT ${limit}
    `)) as unknown as Array<{ harness_slug: string; phase: string; content: string; sim: number; highlight: string }>;
    return rows.map((r) => ({
      key: `brainstorm:${r.harness_slug}:${r.phase}`,
      score: r.sim,
      row: {
        source: 'brainstorm',
        source_id: `${r.harness_slug}:${r.phase}`,
        scope: r.harness_slug,
        excerpt: trunc(r.content),
        highlight: r.highlight,
        score: r.sim,
        rankers: ['embeddings'],
      },
    }));
  },
};

const turns: SearchSource = {
  // operator_turns has no workspace_id column — it joins through
  // operator_conversations.workspace_id via the conversation_id FK.
  name: 'turns',
  async lexical({ sql, query, workspaceId, limit }: SearchSourceParams): Promise<Listing> {
    const rows = (await sql`
      SELECT t.id, t.role, t.text,
             ts_rank_cd(t.text_tsv, plainto_tsquery('english', ${query})) AS rank,
             ts_headline('english', t.text,
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.operator_turns t
        JOIN harness_shared.operator_conversations c ON c.id = t.conversation_id
       WHERE c.workspace_id = ${workspaceId}
         AND t.text_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC LIMIT ${limit}
    `) as unknown as Array<{ id: string; role: string; text: string; rank: number; highlight: string }>;
    return rows.map((r) => ({
      key: `turns:${r.id}`,
      score: r.rank,
      row: {
        source: 'turns',
        source_id: r.id,
        excerpt: `[${r.role}] ${trunc(r.text)}`,
        highlight: `[${r.role}] ${r.highlight}`,
        score: r.rank,
        rankers: ['lexical'],
      },
    }));
  },
  async embedding(p): Promise<Listing> {
    const { query, workspaceId, limit, qVec } = p;
    // generic-rag-chunking P-010 (D-017): rank each turn by the nearer of its own
    // vector (first 2,000 characters) and its window chunks less the 0.06
    // margin, so a turn whose only match lies past the cut is still found. The
    // workspace comes from the CONVERSATION, as in the lexical leg: 861 turns
    // written May-June 2026 carry a turn workspace_id that differs from their
    // conversation's (measured 2026-09-30).
    const rows = (await withIterativeScan(p.sql, (sql) => sql`
      WITH best AS (${chunkAwareVectorLegSql(sql, {
        surface: OPERATOR_TURNS_CHUNK_SURFACE,
        parentAlias: 't',
        qVec,
        limit,
        mode: 'retrieve',
        parentFilter: p.sql`EXISTS (SELECT 1 FROM harness_shared.operator_conversations c
                                     WHERE c.id = t.conversation_id AND c.workspace_id = ${workspaceId})`,
        // D-011: the embedding-space rule stays here; the helper only names
        // the qualified columns. A missing column fails closed.
        spaceFilter: (cols) => (cols.profileColumn && cols.modeColumn
          ? proseProfileSql(p, cols.profileColumn, cols.modeColumn)
          : p.sql`FALSE`),
      })})
      SELECT t.id, t.role, t.text, 1 - b.distance AS sim,
             ts_headline('english', t.text,
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM best b
        JOIN harness_shared.operator_turns t ON t.id = b.id
    ORDER BY b.distance, b.id
       LIMIT ${limit}
    `)) as unknown as Array<{ id: string; role: string; text: string; sim: number; highlight: string }>;
    return rows.map((r) => ({
      key: `turns:${r.id}`,
      score: r.sim,
      row: {
        source: 'turns',
        source_id: r.id,
        excerpt: `[${r.role}] ${trunc(r.text)}`,
        highlight: `[${r.role}] ${r.highlight}`,
        score: r.sim,
        rankers: ['embeddings'],
      },
    }));
  },
};

const decisions: SearchSource = {
  name: 'decisions',
  async lexical({ sql, query, workspaceId, scopeFilter, limit }: SearchSourceParams): Promise<Listing> {
    const rows = (await sql`
      SELECT harness_slug, line_hash, verb, args, iso,
             ts_rank_cd(body_tsv, plainto_tsquery('english', ${query})) AS rank,
             ts_headline('english',
               coalesce(verb, '') || ' ' || coalesce(args, ''),
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.harness_decisions
       WHERE workspace_id = ${workspaceId}
         AND (${scopeFilter}::text IS NULL OR harness_slug = ${scopeFilter})
         AND body_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC LIMIT ${limit}
    `) as unknown as Array<{ harness_slug: string; line_hash: string; verb: string; args: string; iso: string; rank: number; highlight: string }>;
    return rows.map((r) => {
      const body = `${r.verb} ${r.args}`.trim();
      return {
        key: `decisions:${r.harness_slug}:${r.line_hash}`,
        score: r.rank,
        row: {
          source: 'decisions',
          source_id: `${r.harness_slug}:${r.line_hash}`,
          scope: r.harness_slug,
          excerpt: `[${r.iso}] ${trunc(body)}`,
          highlight: r.highlight,
          score: r.rank,
          rankers: ['lexical'],
        },
      };
    });
  },
  async embedding(p): Promise<Listing> {
    const { sql, query, workspaceId, scopeFilter, limit, qVec } = p;
    const rows = (await withIterativeScan(sql, (sql) => sql`
      SELECT harness_slug, line_hash, verb, args, iso,
             1 - (body_embedding <=> ${qVec}::vector) AS sim,
             ts_headline('english',
               coalesce(verb, '') || ' ' || coalesce(args, ''),
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.harness_decisions
       WHERE workspace_id = ${workspaceId}
         AND (${scopeFilter}::text IS NULL OR harness_slug = ${scopeFilter})
         AND body_embedding IS NOT NULL
         AND ${proseProfileSql(p, 'body_embedding_profile', 'body_embedding_mode')}
    ORDER BY body_embedding <=> ${qVec}::vector
       LIMIT ${limit}
    `)) as unknown as Array<{ harness_slug: string; line_hash: string; verb: string; args: string; iso: string; sim: number; highlight: string }>;
    return rows.map((r) => {
      const body = `${r.verb} ${r.args}`.trim();
      return {
        key: `decisions:${r.harness_slug}:${r.line_hash}`,
        score: r.sim,
        row: {
          source: 'decisions',
          source_id: `${r.harness_slug}:${r.line_hash}`,
          scope: r.harness_slug,
          excerpt: `[${r.iso}] ${trunc(body)}`,
          highlight: r.highlight,
          score: r.sim,
          rankers: ['embeddings'],
        },
      };
    });
  },
};

/**
 * EI-6984: `search:fulltext` had no work-item scope at all, so an agent filing a new
 * tracker (EI-*) had no cheap existence check before creating a likely duplicate —
 * `work_items:list` doesn't scale past ~500 rows and has no text search. Reuses the
 * relation's EXISTING generated `_search` tsvector (title weight A / body weight B)
 * + its GIN index.
 *
 * P-005 (context-injection-retrieval-reach-and-visibility-2026-08-03) / P-012
 * (semantic-search-fingerprint-coverage-2026-08-03) — THE EMBEDDING LEG. This
 * source was lexical-only, which is the whole of D-078: "injection's semantic reach
 * is ONE SOURCE WIDE". The reason recorded here used to be "engineer_issues has no
 * embedding column yet", and that sentence was true of the VIEW and false of the
 * data. Measured 2026-08-09: `harness_shared.work_items` carries
 * `embedding vector(768)` on 36,302 of 36,304 rows (99.99%, mode 'gemma') behind
 * `work_items_embedding_hnsw_idx`. The vectors, the index and the backfill were all
 * already there — the view just did not SELECT the column, and the view is what this
 * source queries. Migration 776 appends `embedding` / `embedding_mode` to it.
 *
 * Both legs deliberately query the SAME relation (the view) rather than the leg
 * reaching past it to `work_items`: the scope derivation, the `severity` COALESCE
 * and the `item_kind IN (bug,change,task)` row set are defined exactly once there.
 * A leg on the base table would have to restate all three, which is how the
 * documented `payload->'_ei'` severity trap happened in the first place.
 *
 * ⚠ Never `SELECT *` from `harness_shared.engineer_issues` — since 776 that ships a
 * 768-dim vector per row, on what is the single largest DB consumer here (WI-6993).
 * Name your columns, as both legs below do.
 *
 * ─── WORK_ITEM_RECENCY_NOTE (P-009) ───────────────────────────────────────────
 *
 * Both legs project `ts` from `updated_at`. This is a PRECONDITION for the corpus
 * leg's recency re-rank, not an optimisation, because "no timestamp" and "old" are
 * the SAME value downstream: `applyRecencyRerank` scores a hit with no time as
 * `decay = 0` — i.e. maximally old — by documented design, never as "unknown".
 *
 * Measured 2026-08-09: work-items are 36.6% of all corpus refs surfaced in 24h, and
 * every one of them arrived with `ts: null`. Turning recency on while this leg stayed
 * blind would therefore have demoted better than a third of the section for being
 * UNMEASURABLE — and demoted exactly the population D-078/P-005 had just finished
 * making retrievable. Worse, it would have looked like recency working correctly
 * (work-items sinking) rather than like a bug.
 *
 * `updated_at` is 100% populated (33,346/33,346 rows in scope, spanning 2026-06-18
 * → now), so this closes the gap rather than narrowing it. It is read from the VIEW,
 * like every other column here — the base table's `updated_ts` is the same fact in
 * epoch-ms, and reaching past the view for it would restate the scope/severity
 * derivation the view exists to hold exactly once.
 *
 * It nonetheless falls back to `created_at`, because both columns are NULLABLE
 * (checked 2026-08-09) and full population today is an observation, not a
 * constraint. Given the decay-0 semantics above, one null row would not degrade
 * gracefully — it would be ranked as the oldest document in the corpus. A row with
 * neither timestamp still lands there, which is the engine's documented behaviour
 * and the honest floor once there is genuinely no time to read.
 *
 * ─── WORK_ITEM_LANE_NOTE (observation-and-recall-surface-honesty P-003/P-004) ──
 *
 * Both legs project `lane` into the engine-opaque `meta` bag. THIS SOURCE RETURNS
 * TWO DIFFERENT POPULATIONS THAT SHARE A RELATION, AN ID SPACE AND — until this
 * projection existed — A LABEL. `harness_shared.engineer_issues` holds both the
 * curated work/triage lane and the `lane='observation'` reflection lane, and
 * downstream `source: 'work_item'` was the only thing either could be identified by.
 *
 * Measured 2026-08-16 (workspace papercusp-workspace): 37,089 rows are
 * lane='observation' against 28,335 work-items — **56.7% of everything this source
 * can return is an observation**, and 37,088 of those 37,089 carry an embedding, so
 * they are fully reachable by the semantic leg rather than a lexical long tail.
 *
 * Two things downstream were wrong without this column, both silently:
 *   • corpus recall LABELLED an observation `[work-item EI-…]`, so a single agent's
 *     unreviewed turn-end reflection read as a filed, triaged artifact; and
 *   • `corpusHitKindRank` gave every `work_item` hit a tiebreak BOOST justified by
 *     work-items being "the durable, curated artifact this leg exists to surface" —
 *     a premise that is simply false for the 56.7%.
 * Neither is a ranking bug the engine could have caught: both are the host reading
 * a population distinction the source never projected.
 *
 * `lane` is NULLABLE and null means the ordinary work/triage lane, so downstream
 * must treat absent-or-null as "work-item" and only the explicit 'observation'
 * value as the sample lane — never the reverse, or a lane column that fails to
 * project would silently reclassify the whole corpus.
 */
const workItem: SearchSource = {
  name: 'work_item',
  async lexical(p: SearchSourceParams): Promise<Listing> {
    const { sql, workspaceId, scopeFilter, limit } = p;
    // P-017 / D-062 — see lexicalSql. Byte-identical without `lexicalMode`.
    const lex = lexicalSql(p, sql`_search`, sql`harness_shared.engineer_issues`);
    // EI-21924046411702156: see LEXICAL_COVERAGE_STATEMENT_TIMEOUT_MS. This tool
    // runs `ctx.tx` = a bare `getOrgPg()` handle with no ambient bound, so the
    // bound must be installed HERE, per the readiness-reconcile.ts pattern
    // (`SET LOCAL`, never a session-level `SET` — this is a shared pool
    // checkout, and `SET LOCAL` reverts at COMMIT instead of leaking onto
    // whatever runs next on the same connection).
    const rows = (await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${LEXICAL_COVERAGE_STATEMENT_TIMEOUT_MS}`);
      return tx`
      ${lex.with}
      SELECT issue_id, scope, title, body, kind, state, severity, lane,
             coalesce(updated_at, created_at) AS updated_at,
             ${lex.coverage} AS coverage,
             ${lex.rank} AS rank,
             ts_headline('english', coalesce(title, '') || E'\n' || coalesce(body, ''),
               ${lex.headlineQuery},
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.engineer_issues ${lex.join}
       WHERE workspace_id = ${workspaceId}
         -- the scope column stores 'operator' | 'harness:<slug>' — a bare harness_slug
         -- filter (as the other sources take it) maps to the 'harness:<slug>' form.
         AND (${scopeFilter}::text IS NULL OR scope = 'harness:' || ${scopeFilter}::text)
         AND ${lex.match}
    ORDER BY coverage DESC, rank DESC LIMIT ${limit}
    `;
    })) as unknown as Array<{
      issue_id: string;
      scope: string;
      title: string;
      body: string;
      kind: string;
      state: string;
      severity: string;
      lane: string | null;
      updated_at: string | Date | null;
      rank: number;
      highlight: string;
    }>;
    return rows.map((r) => {
      const body = `${r.title}\n${r.body}`.trim();
      return {
        key: `work_item:${r.issue_id}`,
        score: r.rank,
        row: {
          source: 'work_item',
          source_id: r.issue_id,
          scope: r.scope,
          excerpt: `[${r.kind}/${r.state}/${r.severity}] ${trunc(body)}`,
          highlight: r.highlight,
          score: r.rank,
          // See WORK_ITEM_RECENCY_NOTE — without this a work-item reaches the
          // recency re-rank with no timestamp, which scores as decay 0 (OLDEST),
          // not as "unknown".
          ts: r.updated_at,
          rankers: ['lexical'],
          // See WORK_ITEM_LANE_NOTE.
          meta: { lane: r.lane },
        },
      };
    });
  },
  /**
   * Mirrors `lexical` above column-for-column so a hit fuses on the same identity
   * (`key`) whichever leg produced it — that is what lets RRF see one document with
   * two rankers instead of two documents.
   *
   * No `embedding_mode` predicate, matching every other source here: the mode is a
   * property of the embedder that WROTE the row, and `SearchSourceParams` carries no
   * mode for the leg to compare against, so a filter would have to hardcode one.
   * Today the column is single-valued ('gemma' on 100% of embedded rows). If a
   * second mode is ever written into this table, every source in this file needs the
   * predicate, not just this one — it is a registry-wide decision, not a local one.
   */
  async embedding(p): Promise<Listing> {
    const { sql, query, workspaceId, scopeFilter, limit, qVec } = p;
    // generic-rag-chunking P-011 (D-015): rank each item by the nearer of its own
    // vector (title + first 2,000 characters) and its window chunks, so an item
    // whose only match lies past the cut is still found. The leg reads the VIEW
    // as its parent, like the lexical leg, so the scope derivation and the
    // bug/change/task row set stay defined once; the view's base_harness_slug
    // and issue_id are the base table's chunk key (harness_slug, feature_id).
    const rows = (await withIterativeScan(sql, (sql) => sql`
      WITH best AS (${chunkAwareVectorLegSql(sql, {
        surface: { ...WORK_ITEMS_CHUNK_SURFACE, parent: ENGINEER_ISSUES_CHUNK_PARENT },
        parentAlias: 'ei',
        qVec,
        limit,
        mode: 'retrieve',
        // Same scope semantics as the lexical leg: the column stores
        // 'operator' | 'harness:<slug>', so a bare slug maps to the latter.
        parentFilter: p.sql`ei.workspace_id = ${workspaceId}
          AND (${scopeFilter}::text IS NULL OR ei.scope = 'harness:' || ${scopeFilter}::text)`,
        // D-011: the embedding-space rule stays here; the helper only names
        // the qualified columns. A missing column fails closed.
        spaceFilter: (cols) => (cols.profileColumn && cols.modeColumn
          ? proseProfileSql(p, cols.profileColumn, cols.modeColumn)
          : p.sql`FALSE`),
      })})
      SELECT e.issue_id, e.scope, e.title, e.body, e.kind, e.state, e.severity, e.lane,
             coalesce(e.updated_at, e.created_at) AS updated_at,
             1 - b.distance AS sim,
             ts_headline('english', coalesce(e.title, '') || E'\n' || coalesce(e.body, ''),
               plainto_tsquery('english', ${query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM best b
        JOIN harness_shared.engineer_issues e
          ON e.base_harness_slug = b.base_harness_slug AND e.issue_id = b.issue_id
    ORDER BY b.distance, e.issue_id
       LIMIT ${limit}
    `)) as unknown as Array<{
      issue_id: string;
      scope: string;
      title: string;
      body: string;
      kind: string;
      state: string;
      severity: string;
      lane: string | null;
      updated_at: string | Date | null;
      sim: number;
      highlight: string;
    }>;
    return rows.map((r) => {
      const body = `${r.title}\n${r.body}`.trim();
      return {
        key: `work_item:${r.issue_id}`,
        score: r.sim,
        row: {
          source: 'work_item',
          source_id: r.issue_id,
          scope: r.scope,
          excerpt: `[${r.kind}/${r.state}/${r.severity}] ${trunc(body)}`,
          highlight: r.highlight,
          score: r.sim,
          // Mirrors the lexical leg — see WORK_ITEM_RECENCY_NOTE.
          ts: r.updated_at,
          rankers: ['embeddings'],
          // Mirrors the lexical leg — see WORK_ITEM_LANE_NOTE.
          meta: { lane: r.lane },
        },
      };
    });
  },
};

/**
 * session_turn — the episodic verbatim transcript index (session-search-scope-
 * 2026-07-05 P-004 / D-003): claude/omp/codex JSONL + agent_chat transcripts,
 * ingested by search/session-ingest.ts into harness_shared.session_turns.
 *
 * Notes:
 *   * workspace predicate is (workspace_id = $ws OR workspace_id = 'default'):
 *     local transcript files carry no workspace identity and are stamped
 *     'default' (the agent_chats_consolidated convention) — host-global data,
 *     visible from any workspace-scoped search on this box.
 *   * FULL filter-bag support (P-002): owners / speaker / sessionId /
 *     sourceKind / since / until — each null-guarded so an absent filter
 *     never narrows.
 *   * scopeFilter (harness_slug) narrows agent_chat rows; file-sourced rows
 *     have NULL harness_slug and are excluded by a harness-scoped search —
 *     intentional: "search this harness" should not surface unrelated
 *     desktop-session chatter.
 */
const sessionTurnFilterSql = (p: SearchSourceParams) => {
  const f = p.filters ?? {};
  return {
    owners: f.owners && f.owners.length ? f.owners : null,
    speaker: f.speaker ?? null,
    turnOrigin: f.turnOrigin ?? null,
    ownerOnly: f.ownerOnly ?? null,
    ownerCandidates: f.ownerCandidates ?? null,
    ownerCandidateVerdicts: OWNER_CANDIDATE_TURN_VERDICTS as string[],
    sessionId: f.sessionId ?? null,
    sourceKind: f.sourceKind ?? null,
    since: f.since ?? null,
    until: f.until ?? null,
  };
};

/**
 * generic-rag-chunking P-006: the session-turn vector leg runs through the
 * shared chunkAwareVectorLeg. Since P-007 it reads the session-turn registry
 * entry itself (search/turn-chunk-sync.ts SESSION_TURN_CHUNK_SURFACE): its
 * parent vector columns, margin 0 (pooling identical to the pre-move
 * MAX-of-legs query, pinned by session-turn-leg-parity.integration.test.ts),
 * and its store's chunk table (the per-surface session_turn_chunks, keyed by
 * the parent's four columns, no anchor column).
 */
const SESSION_TURN_VECTOR_LEG: Pick<ChunkAwareVectorLegOptions, 'surface' | 'parentAlias'> = {
  surface: SESSION_TURN_CHUNK_SURFACE,
  parentAlias: 'st',
};

const sessionTurn: SearchSource = {
  name: 'session_turn',
  async lexical(p: SearchSourceParams): Promise<Listing> {
    const f = sessionTurnFilterSql(p);
    // WI-4734: under the engine's highlight-deferral (wantHighlight === false)
    // skip ts_headline entirely — it costs ~1.4ms/row and the engine hydrates
    // the final top-N via hydrateHighlights below instead of paying it for the
    // whole limit*3 over-fetch pool.
    // P-017 / D-062: `lex` supplies the term-combination fragments. Without
    // `lexicalMode: 'coverage-graded'` this is byte-identical to the pre-P-017
    // query — `coverage` is the constant 1, so the ordering is `rank DESC`.
    // EI-23737056070911495: `text_simple_tsv` is added ONLY by migration 1163,
    // which is deliberately parked as `.DRAFT` and therefore NEVER applied — the
    // live DB has no such column (verified: 42703 `column "text_simple_tsv" does
    // not exist`). Naming it here reds `lint:migration-forward-compat`, which is
    // gate-blocking, and would fault any query that reached the column.
    //
    // It stays decoupled rather than armed because migration 1163 adds a
    // `GENERATED ALWAYS ... STORED` tsvector to harness_shared.session_turns
    // (13 GB / ~1.37M rows). A stored generated column forces a FULL TABLE
    // REWRITE under ACCESS EXCLUSIVE on the hot session-ingest table, and the
    // migration runner wraps every file in BEGIN/COMMIT, so the GIN index cannot
    // be built with CREATE INDEX CONCURRENTLY either.
    //
    // `simpleTsv` is optional by construction (see lexicalSql) and the
    // engineer_issues source at ~line 670 already runs without it, so passing
    // `undefined` is the supported degradation: literal-token recall falls back
    // to the bounded substring FILL below. RE-ARM ORDER if this is ever
    // revisited: apply migration 1163 FIRST, then restore this argument.
    const lex = lexicalSql(
      p,
      p.sql`text_tsv`,
      p.sql`harness_shared.session_turns`,
      undefined,
    );
    // The caller's scope + filter bag as ONE predicate, shared by the primary
    // query and the literal fill so the two can never disagree about scope —
    // workspace isolation above all. A function, so each query embeds a fresh
    // fragment.
    const scoped = () => p.sql`
          (workspace_id = ${p.workspaceId} OR workspace_id = 'default')
      AND (${p.scopeFilter}::text IS NULL OR harness_slug = ${p.scopeFilter})
      AND (${f.owners}::text[] IS NULL OR owner = ANY(${f.owners}::text[]))
      AND (${f.speaker}::text IS NULL OR speaker = ${f.speaker})
      AND (${f.turnOrigin}::text IS NULL OR turn_origin_verdict = ${f.turnOrigin})
      AND (${f.ownerOnly}::boolean IS NULL OR NOT ${f.ownerOnly} OR turn_origin_verdict IN ('owner-typed', 'owner-dialog'))
      AND (${f.ownerCandidates}::boolean IS NULL OR NOT ${f.ownerCandidates} OR turn_origin_verdict = ANY(${f.ownerCandidateVerdicts}::text[]))
      AND (${f.sessionId}::text IS NULL OR session_id = ${f.sessionId})
      AND (${f.sourceKind}::text IS NULL OR source_kind = ${f.sourceKind})
      AND (${f.since}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${f.since}::timestamptz)
      AND (${f.until}::timestamptz IS NULL OR COALESCE(ts, ingested_at) < ${f.until}::timestamptz)`;
    // EI-24045346484356708: the coverage-graded branch never admitted literal
    // rows (its match is the anchor alone), so the fill stays 'and'-mode only.
    const literalToken =
      p.lexicalMode === 'coverage-graded' ? null : compactLiteralToken(p.query);
    type SessionTurnLexicalRow = { source_kind: string; session_id: string; turn_idx: number; speaker: string; owner: string | null; harness_slug: string | null; ts: string | null; text: string; rank: number; highlight: string };
    // EI-21924046411702156: see LEXICAL_COVERAGE_STATEMENT_TIMEOUT_MS. Same
    // bare-`getOrgPg()`-pool exposure as `workItem.lexical` above — this tool's
    // `ctx.tx` also bypasses `withWorkspace`'s ambient bound (`crossWorkspace:
    // true`), so the bound is installed HERE, per the readiness-reconcile.ts
    // `SET LOCAL` pattern.
    const rows = (await p.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${LEXICAL_COVERAGE_STATEMENT_TIMEOUT_MS}`);
      // PRIMARY — index-served only (`lex.match` carries no substring arm).
      const primary = (await tx`
      ${lex.with}
      SELECT source_kind, session_id, turn_idx, speaker, owner, harness_slug, ts, text,
             ${lex.coverage} AS coverage,
             ${lex.rank} AS rank,
             ${p.wantHighlight === false
               ? p.sql`''`
               : p.sql`CASE WHEN ${lex.fallbackOnly}
                       THEN left(text, 4000)
                       ELSE ts_headline(${lex.headlineConfig}, left(text, 4000),
                         ${lex.headlineQuery},
                         ${HEADLINE_OPTS})
                   END`} AS highlight
        FROM harness_shared.session_turns ${lex.join}
       WHERE ${scoped()}
         AND ${lex.match}
    ORDER BY coverage DESC, rank DESC LIMIT ${p.limit}
    `) as unknown as SessionTurnLexicalRow[];

      // FILL — EI-24045346484356708. A literal-only row scores ts_rank_cd = 0,
      // so under the old single OR query it could only ever occupy slots the
      // dictionary match left empty. Running it ONLY for those slots, only for
      // a compact token, and only over the newest LITERAL_FALLBACK_WINDOW_ROWS
      // in-scope turns keeps that recall while removing the full-table scan
      // from every other call. Newest-first among the fill rows.
      const need = p.limit - primary.length;
      if (literalToken === null || need <= 0) return primary;
      // Fail-soft: the fill is a recall supplement, so if it errors (its own
      // statement bound, a cancel) the SAVEPOINT rolls back just the fill and
      // the index-served rows are still returned rather than the whole leg.
      const fill = await tx
        .savepoint(async (sp) => {
          await sp.unsafe('SET LOCAL max_parallel_workers_per_gather = 0');
          return (await sp`
      SELECT source_kind, session_id, turn_idx, speaker, owner, harness_slug, ts, text,
             0 AS rank,
             ${p.wantHighlight === false ? p.sql`''` : p.sql`left(text, 4000)`} AS highlight
        FROM (SELECT source_kind, session_id, turn_idx, speaker, owner, harness_slug,
                     ts, text, text_tsv, ingested_at
                FROM harness_shared.session_turns
               WHERE ${scoped()}
            ORDER BY ingested_at DESC
               LIMIT ${LITERAL_FALLBACK_WINDOW_ROWS}) w
       WHERE NOT COALESCE(text_tsv @@ plainto_tsquery('english', ${p.query}), false)
         AND position(lower(${literalToken}) in lower(left(text, 20000))) > 0
    ORDER BY ingested_at DESC
       LIMIT ${need}
    `) as unknown as SessionTurnLexicalRow[];
        })
        .catch(() => [] as SessionTurnLexicalRow[]);
      return [...primary, ...fill];
    })) as unknown as SessionTurnLexicalRow[];
    return rows.map((r) => ({
      key: `session_turn:${r.source_kind}:${r.session_id}:${r.turn_idx}`,
      score: r.rank,
      row: {
        source: 'session_turn',
        source_id: `${r.source_kind}:${r.session_id}:${r.turn_idx}`,
        ...(r.harness_slug ? { scope: r.harness_slug } : {}),
        excerpt: `[${r.speaker}${r.owner ? ` ${r.owner}` : ''}${r.ts ? ` ${r.ts}` : ''}] ${trunc(r.text)}`,
        highlight: r.highlight,
        score: r.rank,
        // Expose the turn timestamp so the engine's optional recency re-rank
        // (RecencyRank.getTime defaults to hit.ts) can bias by freshness.
        ts: r.ts,
        rankers: ['lexical'],
      },
    }));
  },
  /**
   * P-034 / D-016 — scores a turn by the BEST of (its own vector, its chunk
   * vectors), not by its own vector alone.
   *
   * WHY THERE IS A SECOND LEG AT ALL. `text_embedding` is built from
   * `left(text, 2000)`, so content past that cut has no vector and is
   * unretrievable here. Measured over the 33,232 turns (8.1%) longer than the
   * cut — ~90.5M invisible characters — a probe drawn from past it ranked its
   * true parent at MRR ~0.25 / recall@1 ~14% out of 60. Unioning per-chunk
   * vectors (migration 749, 1500-char windows / 250 overlap) lifts the SAME
   * corpus and queries to MRR 0.73-0.84 / recall@1 60-75%.
   *
   * ⚠ MAX, NEVER MEAN. A turn is relevant if ANY part of it is, which is how a
   * chunked index is queried. Averaging a turn's chunk scores would reintroduce
   * precisely the dilution chunking exists to remove — a long turn with one
   * dead-on paragraph would score below a short mediocre one.
   *
   * ⚠ AND NOT A WIDER left(). That is the obvious cheaper fix and it was
   * measured and rejected: one 768-dim vector dilutes as its text grows, so
   * width PEAKS then DECLINES (at probe 3000, width 8000 scored WORSE than
   * 4000), and any apparent optimum is just the narrowest width containing the
   * probe — moving the probe collapsed width 4000 by 49%. See D-016.
   *
   * Both legs are separately top-K'd before the merge so each uses its own HNSW
   * index; deduping afterwards can only ever COLLAPSE rows, never invent them,
   * so the parent-only behaviour is preserved exactly when a turn has no chunks
   * (every turn ≤2000 chars, i.e. ~92% of them).
   */
  async embedding(p): Promise<Listing> {
    const f = sessionTurnFilterSql(p);
    // Fail-open: an unapplied migration 749 must degrade to the parent-only
    // leg, never take the semantic leg down. Cannot be a SQL-side guard —
    // Postgres resolves relations at parse time, so naming a missing table
    // fails the whole query before any predicate runs.
    const { turnChunksAvailable } = await import('../../search/turn-chunk-sync');
    const withChunks = await turnChunksAvailable(p.sql);
    // The caller's predicates, bound to the parent alias `st`. The helper applies
    // them inside BOTH legs before each leg's LIMIT, exactly as the two
    // hand-written legs did.
    const parentFilter = p.sql`
          (st.workspace_id = ${p.workspaceId} OR st.workspace_id = 'default')
      AND (${p.scopeFilter}::text IS NULL OR st.harness_slug = ${p.scopeFilter})
      AND (${f.owners}::text[] IS NULL OR st.owner = ANY(${f.owners}::text[]))
      AND (${f.speaker}::text IS NULL OR st.speaker = ${f.speaker})
      AND (${f.turnOrigin}::text IS NULL OR st.turn_origin_verdict = ${f.turnOrigin})
      AND (${f.ownerOnly}::boolean IS NULL OR NOT ${f.ownerOnly} OR st.turn_origin_verdict IN ('owner-typed', 'owner-dialog'))
      AND (${f.ownerCandidates}::boolean IS NULL OR NOT ${f.ownerCandidates} OR st.turn_origin_verdict = ANY(${f.ownerCandidateVerdicts}::text[]))
      AND (${f.sessionId}::text IS NULL OR st.session_id = ${f.sessionId})
      AND (${f.sourceKind}::text IS NULL OR st.source_kind = ${f.sourceKind})
      AND (${f.since}::timestamptz IS NULL OR COALESCE(st.ts, st.ingested_at) >= ${f.since}::timestamptz)
      AND (${f.until}::timestamptz IS NULL OR COALESCE(st.ts, st.ingested_at) < ${f.until}::timestamptz)`;
    // WI-37603. The outer tag is the TRANSACTION handle (iterative scan on);
    // the nested `p.sql` fragments stay on the outer handle, which is safe
    // because a postgres.js fragment is a lazy builder — only the outer query
    // executes. The parity and cascade-quality integration tests exercise this
    // exact leg end-to-end, so a fragment-provenance problem fails loudly there.
    const rows = (await withIterativeScan(p.sql, (sql) => sql`
      WITH best AS (${chunkAwareVectorLegSql(sql, {
        ...SESSION_TURN_VECTOR_LEG,
        qVec: p.qVec,
        limit: p.limit,
        mode: withChunks ? 'retrieve' : 'gist',
        parentFilter,
        // D-011: the embedding-space rule stays here; the helper only names
        // the qualified columns. A missing column fails closed.
        spaceFilter: (cols) => (cols.profileColumn && cols.modeColumn
          ? proseProfileSql(p, cols.profileColumn, cols.modeColumn)
          : p.sql`FALSE`),
      })})
      SELECT st.source_kind, st.session_id, st.turn_idx, st.speaker, st.owner,
             st.harness_slug, st.ts, st.text, 1 - b.distance AS sim,
             ${p.wantHighlight === false
               ? p.sql`''`
               : p.sql`ts_headline('english', left(st.text, 4000),
                   plainto_tsquery('english', ${p.query}),
                   ${HEADLINE_OPTS})`} AS highlight
        FROM best b
        JOIN harness_shared.session_turns st
          ON st.workspace_id = b.workspace_id
         AND st.source_kind  = b.source_kind
         AND st.session_id   = b.session_id
         AND st.turn_idx     = b.turn_idx
    ORDER BY b.distance, b.workspace_id, b.source_kind, b.session_id, b.turn_idx
       LIMIT ${p.limit}
    `)) as unknown as Array<{ source_kind: string; session_id: string; turn_idx: number; speaker: string; owner: string | null; harness_slug: string | null; ts: string | null; text: string; sim: number; highlight: string }>;
    return rows.map((r) => ({
      key: `session_turn:${r.source_kind}:${r.session_id}:${r.turn_idx}`,
      score: r.sim,
      row: {
        source: 'session_turn',
        source_id: `${r.source_kind}:${r.session_id}:${r.turn_idx}`,
        ...(r.harness_slug ? { scope: r.harness_slug } : {}),
        excerpt: `[${r.speaker}${r.owner ? ` ${r.owner}` : ''}${r.ts ? ` ${r.ts}` : ''}] ${trunc(r.text)}`,
        highlight: r.highlight,
        score: r.sim,
        // Expose the turn timestamp for the engine's optional recency re-rank.
        ts: r.ts,
        rankers: ['embeddings'],
      },
    }));
  },
  /** WI-4734: batched ts_headline for the FINAL fused top-N only (the engine
   *  calls this under deferHighlight after passing wantHighlight:false to the
   *  rankers above). source_id shape: `<sourceKind>:<sessionId>:<turnIdx>` —
   *  parsed first-colon/last-colon so a sessionId containing ':' survives
   *  (same rule as sessions/_shared parseTurnRef). One unnest join, never
   *  per-hit queries. */
  async hydrateHighlights(p: SearchSourceParams, sourceIds: string[]): Promise<Map<string, string>> {
    const kinds: string[] = [];
    const sids: string[] = [];
    const idxs: number[] = [];
    for (const id of sourceIds) {
      const first = id.indexOf(':');
      const last = id.lastIndexOf(':');
      if (first < 0 || last <= first) continue;
      const turnIdx = Number(id.slice(last + 1));
      if (!Number.isInteger(turnIdx)) continue;
      kinds.push(id.slice(0, first));
      sids.push(id.slice(first + 1, last));
      idxs.push(turnIdx);
    }
    if (kinds.length === 0) return new Map();
    const rows = (await p.sql`
      SELECT st.source_kind, st.session_id, st.turn_idx,
             CASE
               WHEN st.text_tsv @@ plainto_tsquery('english', ${p.query})
               THEN ts_headline('english', left(st.text, 4000),
                 plainto_tsquery('english', ${p.query}), ${HEADLINE_OPTS})
               ELSE left(st.text, 4000)
             END AS highlight
        FROM harness_shared.session_turns st
        JOIN unnest(${kinds}::text[], ${sids}::text[], ${idxs}::int[]) AS t(k, s, i)
          ON st.source_kind = t.k AND st.session_id = t.s AND st.turn_idx = t.i
    `) as unknown as Array<{ source_kind: string; session_id: string; turn_idx: number; highlight: string }>;
    return new Map(rows.map((r) => [`${r.source_kind}:${r.session_id}:${r.turn_idx}`, r.highlight]));
  },
};

/**
 * coord_message — ranked recall over the coord message stream (P-009): the
 * `messages` surface of harness_shared.coord_event_log. LEXICAL-ONLY by design —
 * 120k+ envelope rows are not worth embedding; the expression GIN index
 * (migration 501) matches the EXACT to_tsvector expression below. With the
 * fleet→owners filter this answers "find where fleet X discussed Y" across
 * what members SAID TO EACH OTHER (this source) + what they said in their
 * sessions (session_turn) in one call.
 */
const coordMessage: SearchSource = {
  name: 'coord_message',
  async lexical(p: SearchSourceParams): Promise<Listing> {
    const f = sessionTurnFilterSql(p);
    // coord_event_log messages have no transcript session identity. An explicit
    // session filter therefore cannot be applied to this source: running the
    // query anyway silently widens a targeted sessions:search into the entire
    // coordination corpus (492k rows measured 2026-09-14) and can spend >30s
    // computing headlines for unrelated messages. session:'self' deliberately
    // remains eligible because it resolves to owner filters, not sessionId.
    if (f.sessionId) return [];
    const rows = (await p.sql`
      SELECT msg_id, ts, harness_slug,
             body->>'from' AS from_owner,
             body->>'kind' AS kind,
             left(coalesce(body->>'summary','') || ' ' || coalesce(body->>'body',''), 4000) AS msgtext,
             ts_rank_cd(
               to_tsvector('english', left(coalesce(body->>'summary','') || ' ' || coalesce(body->>'body',''), 20000)),
               plainto_tsquery('english', ${p.query})) AS rank,
             ts_headline('english',
               left(coalesce(body->>'summary','') || ' ' || coalesce(body->>'body',''), 4000),
               plainto_tsquery('english', ${p.query}),
               ${HEADLINE_OPTS}) AS highlight
        FROM harness_shared.coord_event_log
       WHERE surface = 'messages'
         AND (workspace_id = ${p.workspaceId} OR workspace_id = 'default')
         AND (${p.scopeFilter}::text IS NULL OR harness_slug = ${p.scopeFilter})
         AND (${f.owners}::text[] IS NULL OR body->>'from' = ANY(${f.owners}::text[]))
         AND (${f.since}::timestamptz IS NULL OR ts >= ${f.since}::timestamptz)
         AND (${f.until}::timestamptz IS NULL OR ts < ${f.until}::timestamptz)
         AND to_tsvector('english', left(coalesce(body->>'summary','') || ' ' || coalesce(body->>'body',''), 20000))
             @@ plainto_tsquery('english', ${p.query})
    ORDER BY rank DESC LIMIT ${p.limit}
    `) as unknown as Array<{ msg_id: string; ts: string; harness_slug: string | null; from_owner: string | null; kind: string | null; msgtext: string; rank: number; highlight: string }>;
    return rows.map((r) => ({
      key: `coord_message:${r.msg_id}`,
      score: r.rank,
      row: {
        source: 'coord_message',
        source_id: r.msg_id,
        ...(r.harness_slug ? { scope: r.harness_slug } : {}),
        excerpt: `[${r.kind ?? 'message'}${r.from_owner ? ` from ${r.from_owner}` : ''} ${r.ts}] ${trunc(r.msgtext)}`,
        highlight: r.highlight,
        score: r.rank,
        rankers: ['lexical'],
      },
    }));
  },
};

/** The seven prose surfaces, keyed by `scope` name. */
export const SEARCH_SOURCES: SearchSource[] = [
  escalations, brainstorm, turns, decisions, workItem, sessionTurn, coordMessage,
];
