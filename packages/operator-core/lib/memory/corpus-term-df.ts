/**
 * corpus-term-df — the corpus document-frequency signal behind BANDED term
 * selection in `corpusQueryText` (P-018 / D-064).
 *
 * Three pieces, deliberately separated so the pure one is testable without a
 * database:
 *
 *   • `accumulateDf` / `foldDf`  — PURE. Turn documents into a DF map.
 *   • `refreshCorpusTermDf`      — IO. Sample the corpus, fold, persist.
 *   • `corpusTermDfLookup`       — IO + cache. The `df` function the leg injects.
 *
 * ⚠ DF IS BUILT WITH `corpusTerms`, NEVER `ts_stat`. `ts_stat` returns STEMMED
 * lexemes while selection runs over RAW tokens, so a raw lookup misses on every
 * inflection ("sessions"→"session", "queries"→"queri") — and a miss reads as
 * df 0, i.e. maximal rarity, i.e. SELECTED. That inverts the ranking so the
 * corpus's most common words sort rarest, and it does so silently: the output
 * still looks like a working ranker. Using `corpusTerms` itself makes the
 * tokenizers identical by construction rather than by agreement.
 *
 * ⚠ ONLY ATTESTED TERMS ARE PERSISTED. Absence from the table IS the banded
 * selector's verdict ("unattested ⇒ never worth a query slot"), so storing the
 * hapax tail would cost memory to represent a decision the lookup already makes
 * by default. It is also the bulk of the vocabulary.
 */
import type { Sql } from 'postgres';

import { corpusTerms, CORPUS_QUERY_MIN_DF } from './corpus-recall';

/** How many corpus documents the refresh folds. DF is a RANKING signal, so a
 *  sample suffices — relative frequencies of common terms stabilise long before
 *  absolute counts do, and only the ORDER reaches the query. */
export const CORPUS_TERM_DF_SAMPLE_DOCS = 40_000;

/** Rows pulled per cursor chunk while folding the sample.
 *
 *  This is a BYTE bound wearing a row count: `CORPUS_TERM_DF_SAMPLE_DOCS` caps
 *  how many documents are folded, but nothing caps their total size, so the
 *  only thing bounding resident text is how many are in memory AT ONCE.
 *  Measured 2026-09-08: 2.8 MB peak per chunk vs ~100 MB for the whole sample.
 *  Raising it scales that peak linearly and buys nothing — the fold is
 *  CPU-bound on tokenising, not on round-trips. */
export const CORPUS_TERM_DF_FETCH_ROWS = 1_000;

/** How long a loaded DF snapshot is served before a re-read. The corpus moves
 *  slowly relative to term RANK, so this is about bounding staleness, not
 *  freshness: a term's position among ~100 candidates does not turn over in an
 *  hour. */
export const CORPUS_TERM_DF_CACHE_TTL_MS = 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Pure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold one document into a DF accumulator. `corpusTerms` already de-duplicates
 * within a document, so each token seen here is exactly one DOCUMENT frequency
 * increment — never a term frequency. PURE.
 */
export function accumulateDf(acc: Map<string, number>, text: string): void {
  for (const term of corpusTerms(text)) acc.set(term, (acc.get(term) ?? 0) + 1);
}

/**
 * Fold documents into the DF map that will be persisted: only terms the corpus
 * attests at least `minDf` times, because absence is the selector's filter
 * verdict. PURE.
 */
/**
 * Drop the hapax tail and report. Shared by `foldDf` and `foldDfAsync` so the
 * sync and streaming folds cannot drift into producing different tables.
 */
function finishDf(
  acc: Map<string, number>,
  ndocs: number,
  minDf: number,
): { df: Map<string, number>; ndocs: number; distinctSeen: number } {
  const distinctSeen = acc.size;
  for (const [term, df] of acc) if (df < minDf) acc.delete(term);
  return { df: acc, ndocs, distinctSeen };
}

export function foldDf(
  texts: Iterable<string>,
  minDf = CORPUS_QUERY_MIN_DF,
): { df: Map<string, number>; ndocs: number; distinctSeen: number } {
  const acc = new Map<string, number>();
  let ndocs = 0;
  for (const text of texts) {
    accumulateDf(acc, text);
    ndocs += 1;
  }
  return finishDf(acc, ndocs, minDf);
}

/**
 * Streaming twin of `foldDf` — identical result, bounded peak memory.
 *
 * WHY THIS EXISTS (WI-10000802): the refresh below samples 40,000 turns, so
 * `LIMIT` bounds ROWS but NOT BYTES — nothing caps the total text pulled into
 * memory at once. Measured 2026-09-08 against the live corpus: materialising
 * the sample held ~100 MB (52.4 M chars, UTF-16); streaming it holds ~2.8 MB,
 * a 35× reduction for an identical table. The fold never needed the texts (only
 * the term Map), so the fix is to stop holding them, NOT to shrink the sample:
 * a smaller `sampleDocs` would silently change the DF distribution the lexical
 * leg reads.
 *
 * ⚠ The ~100 MB figure is what the corpus HOLDS today at a ~1,310-char mean;
 * the column permits 20,000 chars, so the ceiling is ~16× higher and grows with
 * the corpus. Do NOT restate that ceiling as an observation — an earlier pass on
 * WI-10000801 did exactly that and mis-attributed a bg-host heap-OOM to this
 * read. This read is bounded on its own merits; it is NOT a known OOM cause.
 */
export async function foldDfAsync(
  texts: AsyncIterable<string>,
  minDf = CORPUS_QUERY_MIN_DF,
): Promise<{ df: Map<string, number>; ndocs: number; distinctSeen: number }> {
  const acc = new Map<string, number>();
  let ndocs = 0;
  for await (const text of texts) {
    accumulateDf(acc, text);
    ndocs += 1;
  }
  return finishDf(acc, ndocs, minDf);
}

// ─────────────────────────────────────────────────────────────────────────────
// IO — refresh
// ─────────────────────────────────────────────────────────────────────────────

export interface RefreshCorpusTermDfResult {
  workspaceId: string;
  ndocs: number;
  /** Terms persisted (df ≥ minDf). */
  stored: number;
  /** Distinct terms SEEN before the band dropped the hapax tail — the ratio of
   *  these two is how much of the vocabulary is unretrievable noise. */
  distinctSeen: number;
  minDf: number;
}

/**
 * Recompute the workspace's DF table from a corpus sample and REPLACE it.
 *
 * Replace rather than merge: a merged table accumulates terms that have fallen
 * out of the corpus and slowly drifts away from the distribution it is supposed
 * to describe, and df values from different sample sizes are not comparable.
 * The swap runs in one transaction so a reader never sees a half-built table.
 */
export async function refreshCorpusTermDf(
  sql: Sql,
  opts: { workspaceId: string; sampleDocs?: number; minDf?: number },
): Promise<RefreshCorpusTermDfResult> {
  const { workspaceId } = opts;
  const sampleDocs = opts.sampleDocs ?? CORPUS_TERM_DF_SAMPLE_DOCS;
  const minDf = opts.minDf ?? CORPUS_QUERY_MIN_DF;

  // The same corpus the leg retrieves from. Sampled deterministically per
  // workspace so two refreshes of an unchanged corpus agree.
  //
  // STREAMED, not materialised (WI-10000802). `LIMIT ${sampleDocs}` bounds ROWS;
  // it does NOT bound BYTES, so collecting the array first held ~100 MB of turn
  // text (measured 2026-09-08) inside the process that runs this routine. The
  // cursor holds one chunk at a time (~2.8 MB measured) while the fold keeps
  // only the term Map, so the query, the sample, the ordering seed and the
  // resulting table are all UNCHANGED.
  const query = sql`
    SELECT text
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
       AND length(text) BETWEEN 40 AND 20000
     ORDER BY md5(source_kind || session_id || turn_idx::text || ${workspaceId})
     LIMIT ${sampleDocs}
  `;

  async function* sampledTexts(): AsyncGenerator<string> {
    for await (const chunk of query.cursor(CORPUS_TERM_DF_FETCH_ROWS)) {
      for (const row of chunk as unknown as Array<{ text: string }>) yield row.text;
    }
  }

  const { df, ndocs, distinctSeen } = await foldDfAsync(sampledTexts(), minDf);

  if (ndocs === 0) {
    // An empty corpus must not wipe a good table — the leg would silently fall
    // back to length ordering everywhere with nothing to say why.
    return { workspaceId, ndocs: 0, stored: 0, distinctSeen, minDf };
  }

  const terms = [...df.keys()];
  const counts = terms.map((t) => df.get(t)!);

  await sql.begin(async (tx) => {
    await tx`DELETE FROM harness_shared.corpus_term_df WHERE workspace_id = ${workspaceId}`;
    // One statement, not a loop: the term list runs to tens of thousands.
    await tx`
      INSERT INTO harness_shared.corpus_term_df (workspace_id, term, df, ndocs)
      SELECT ${workspaceId}, t.term, t.df, ${ndocs}
        FROM unnest(${terms}::text[], ${counts}::int[]) AS t(term, df)
    `;
  });

  return { workspaceId, ndocs, stored: terms.length, distinctSeen, minDf };
}

// ─────────────────────────────────────────────────────────────────────────────
// IO — the lookup the leg injects
// ─────────────────────────────────────────────────────────────────────────────

interface Snapshot {
  df: Map<string, number>;
  loadedAtMs: number;
  ndocs: number;
}

const snapshots = new Map<string, Snapshot>();
const inFlight = new Map<string, Promise<Snapshot | null>>();

async function loadSnapshot(
  sql: Sql,
  workspaceId: string,
  // Stamped from the CALLER's clock, not `Date.now()`. Sharing one clock is
  // what makes the TTL exercisable at all: a snapshot stamped with wall-clock
  // time while the reader compares against an injected `nowMs` is permanently
  // "fresh" (the difference goes negative), so the re-read path would never run
  // in a test and the expiry would ship unverified.
  loadedAtMs: number,
): Promise<Snapshot | null> {
  const rows = (await sql`
    SELECT term, df, ndocs
      FROM harness_shared.corpus_term_df
     WHERE workspace_id = ${workspaceId}
  `) as unknown as Array<{ term: string; df: number; ndocs: number }>;
  if (rows.length === 0) return null;
  const df = new Map<string, number>();
  for (const r of rows) df.set(r.term, r.df);
  return { df, loadedAtMs, ndocs: rows[0]!.ndocs };
}

/**
 * The `df` function `corpusQueryText` selects with, or `null` when no DF table
 * has been built yet for this workspace.
 *
 * `null` is a real answer, not a failure: the caller then passes no `df` and
 * `corpusQueryText` keeps its original length ordering. That is the whole
 * degrade path — never an empty query, never a query on unattested noise.
 *
 * Never throws. A DF read failing must not take the injection leg down with it;
 * the leg is best-effort by construction and silently keeps the old ordering.
 */
export async function corpusTermDfLookup(
  sql: Sql,
  workspaceId: string,
  nowMs = Date.now(),
): Promise<((term: string) => number) | null> {
  const cached = snapshots.get(workspaceId);
  if (cached && nowMs - cached.loadedAtMs < CORPUS_TERM_DF_CACHE_TTL_MS) {
    return (term: string) => cached.df.get(term) ?? 0;
  }

  // Collapse a stampede: several concurrent injections must not each run the
  // bulk read on a cold cache.
  let pending = inFlight.get(workspaceId);
  if (!pending) {
    pending = loadSnapshot(sql, workspaceId, nowMs)
      .catch(() => null)
      .finally(() => inFlight.delete(workspaceId));
    inFlight.set(workspaceId, pending);
  }
  const snap = await pending;
  if (!snap) {
    // Keep serving a stale snapshot over nothing — stale RANKS are still better
    // than falling back to length, which D-064 measured as strictly worse.
    if (cached) return (term: string) => cached.df.get(term) ?? 0;
    return null;
  }
  snapshots.set(workspaceId, snap);
  return (term: string) => snap.df.get(term) ?? 0;
}

/** Test seam: drop cached snapshots. */
export function resetCorpusTermDfCache(): void {
  snapshots.clear();
  inFlight.clear();
}
