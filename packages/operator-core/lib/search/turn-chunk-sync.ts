/**
 * turn-chunk-sync — derive per-chunk rows for LONG session turns into
 * harness_shared.session_turn_chunks (migration 749) so the embed-backfill
 * sweep can vectorize them for the transcript search semantic leg (P-034,
 * semantic-search-fingerprint-coverage-2026-08-03, decision D-016).
 *
 * THE DEFECT THIS CLOSES. `session_turns.text_embedding` is built from
 * `left(text, 2000)`. Everything past that cut has no vector and is
 * unretrievable by the semantic leg — measured 2026-08-03, 33,232 turns (8.1%)
 * carry ~90.5M invisible characters, and a probe drawn from past the cut ranks
 * its true parent turn at MRR ~0.25 / recall@1 ~14% against 59 distractors.
 * Chunking lifts the SAME corpus and SAME queries to MRR 0.73-0.84 / recall@1
 * 60-75% (+216% to +230%).
 *
 * Responsibility split mirrors doc-embed-sync.ts (and session-ingest.ts before
 * it): THIS module only derives chunk TEXT into PG (sha-keyed change detection,
 * no network, never blocks a writer) — embeddings are filled by the
 * embed-backfill sweep's session_turn_chunks TARGETS entry (bench admission
 * lane, space-aware re-embed on mode flips).
 *
 * ⚠ THE SPLITTER IS THE MEASURED ONE, NOT A REIMPLEMENTATION OF IT.
 * `splitWindows` (@papercusp/search, moved there verbatim and golden-pinned by
 * generic-rag-chunking-2026-09-29 P-002) at TURN_WINDOW is the exact algorithm
 * D-016's numbers came from, and the bench that produced them
 * (memory/bench/turn-truncation-width-cli.ts) IMPORTS it rather than carrying
 * its own copy. That is deliberate: a benchmark that measures a private copy of
 * the algorithm stops being evidence about the shipped path the moment the two
 * drift, and the drift is silent — both keep "working". Re-running the bench
 * re-measures production.
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';
import { splitWindows, type WindowSplitOptions } from '@papercusp/search';

/**
 * Chunk width, in characters. 1500 is the measured arm from D-016 — not a
 * round number picked for looks.
 */
export const TURN_CHUNK_CHARS = 1500;

/**
 * Overlap between consecutive chunks. Keeps a probe that STRADDLES a chunk
 * boundary from being split across two vectors and diluted in both — without
 * it, retrieval quality depends on where the boundary happens to fall relative
 * to the content, which is the same position-dependence that disqualified every
 * fixed truncation width.
 */
export const TURN_CHUNK_OVERLAP = 250;

/**
 * Only turns LONGER than this are chunked.
 *
 * This is the parent's own `left(text, 2000)` embed width, and the equality is
 * the whole point: a turn at or below it is ALREADY fully covered by its own
 * `session_turns.text_embedding`, so chunking it would add rows, vectors, and
 * sweep cost for exactly zero recall. Raising the parent's cut would require
 * raising this in lockstep — they are one number wearing two hats.
 */
export const TURN_CHUNK_MIN_TEXT_CHARS = 2000;

/**
 * Hard bound on chunks derived from ONE turn.
 *
 * Measured 2026-08-03: `max(length(text))` over the live 409,002-row
 * session_turns is exactly 8000 (turns are capped at ingest), which yields 7
 * chunks at the constants above. 16 is therefore pure headroom against that cap
 * being raised later — it exists so a pathological turn can never emit an
 * unbounded INSERT, not because it is expected to bind.
 */
export const MAX_CHUNKS_PER_TURN = 16;

/** How many parent turns one sync pass processes. */
const DEFAULT_BATCH = 200;

export interface TurnChunkSyncStats {
  /** Parent turns whose chunks were (re)written this pass. */
  turns: number;
  /** Chunk rows inserted this pass. */
  chunks: number;
  errors: number;
  /** True when the pass filled its batch — i.e. there is more work waiting. */
  more: boolean;
}

/**
 * The window a session turn is split with: D-016's measured arm. A turn is
 * scored at query time by the MAX over its chunk vectors, never the mean.
 */
export const TURN_WINDOW: WindowSplitOptions = {
  size: TURN_CHUNK_CHARS,
  overlap: TURN_CHUNK_OVERLAP,
  maxChunks: MAX_CHUNKS_PER_TURN,
};

/**
 * sha256 of a turn's full text — the change key.
 *
 * MUST agree with the SQL side's `encode(sha256(convert_to(text,'UTF8')),'hex')`,
 * which is what the staleness filter compares against.
 *
 * ⚠ `text::bytea` IS NOT THE ENCODER IT LOOKS LIKE — it was the first thing
 * written here and it is wrong. That cast does not encode a string to its
 * bytes; it PARSES the string as a bytea input literal (hex/escape format), so
 * any turn containing a backslash raises `invalid input syntax for type bytea`
 * and the whole sync pass dies. `convert_to(text,'UTF8')` is the actual
 * text→bytes encoder, and it matches Node's utf8-default `update(string)`.
 *
 * ⚠⚠ AND THE OBVIOUS VERIFICATION DOES NOT DISCRIMINATE. This docblock
 * previously claimed the two sides were "verified equal" on `'hello'` — which
 * is a valid bytea literal AND a plain string, so it produces the same digest
 * under BOTH readings and confirms nothing. The real check needs an input that
 * is only valid one way. Verified against the live database 2026-08-03 with
 * `a\x41b\nhéllo` (literal backslash + newline + non-ASCII): both sides give
 * 28675fb761f2675f240005800d831457fb9f6bc5351c4d8add5ca4ce7597439e.
 *
 * If the two sides ever diverge, every turn reads as permanently stale and the
 * sync rewrites the whole table on every pass — expensive, and silent.
 */
export function turnSha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface StaleTurnRow {
  workspace_id: string;
  source_kind: string;
  session_id: string;
  turn_idx: number;
  text: string;
  // No `sha` column: detection no longer hashes in SQL (migration 1117). The
  // turn_sha still STORED on each chunk row is computed in Node via turnSha()
  // for the rows we actually rewrite — a handful per tick, not all 203k.
}

/**
 * One sync pass: find chunkable turns whose chunks are missing or stale, and
 * replace them.
 *
 * FRESHEST-FIRST (P-005 discipline, matching the embed sweep): a newly-written
 * long turn is chunked — and therefore searchable — within one tick, while the
 * historical backlog drains underneath it. The alternative (unordered) samples
 * the backlog arbitrarily, which is what made new-row coverage read 7% while
 * the sweep was in fact keeping up: that number measured the ORDERING, not the
 * drain rate.
 *
 * Staleness is `no chunk row for this turn carries the current text sha`, so an
 * edited or re-ingested turn re-chunks wholesale and an unchanged one costs a
 * single PK probe. Per-turn fail-open: one bad turn is counted and skipped,
 * never poisoning the pass.
 */
export async function syncTurnChunks(
  sql: Sql,
  opts: { batch?: number; minChars?: number } = {},
): Promise<TurnChunkSyncStats> {
  const batch = opts.batch ?? DEFAULT_BATCH;
  const minChars = opts.minChars ?? TURN_CHUNK_MIN_TEXT_CHARS;
  const stats: TurnChunkSyncStats = { turns: 0, chunks: 0, errors: 0, more: false };

  // ⚠ THIS QUERY MUST NEVER READ `text` TO DECIDE WHETHER THERE IS WORK.
  // Detection is a partial-index lookup on `chunked_at IS NULL` (migration 1117,
  // session_turns_unchunked_idx). Caught up — the state this lives in almost
  // always, since it then returns zero work — the index has ZERO entries, so the
  // tick touches no turn text at all.
  //
  // It used to ask `NOT EXISTS (... c.turn_sha = sha256(st.text))`, which hashed
  // every chunk-eligible turn on every tick just to discover nothing. Measured
  // live 2026-09-05, near-caught-up, before this change:
  //   shipped LATERAL-sha query 6859ms · same query with no sha 1338ms
  // i.e. ~5520ms/tick of pure hashing. Migration 753 measured that residual at
  // 528ms over 33,283 eligible turns (~157MB); it had grown to 203,492 turns
  // (~1157MB) — ~10.5x — exactly as 753 predicted, since the cost scales with
  // long-turn text volume. EI-19456024312507672 has the full before/after.
  //
  // ⚠ Two traps if you are tempted to reinstate a sha-based predicate:
  //   * The LATERAL "compute the sha once" trick DOES NOT HOLD at this scale —
  //     the planner inlines it straight back into the anti-join's inner filter
  //     and hashes once per probe (Index Searches: 203494).
  //   * Reading `text` also forfeits a PARALLEL, index-only plan: the executor
  //     must reach the heap, so the plan goes serial (buffers 839k -> 1.88M).
  //
  // CORRECTNESS RESTS ON `session_turns.text` BEING INSERT-ONLY, so a turn never
  // needs re-chunking once marked. session-ingest.ts inserts ON CONFLICT DO
  // NOTHING and the only UPDATEs against that table set `owner` and
  // `turn_origin*`; none touches `text`. Asserted by
  // session-turns-text-immutable.test.ts so a future writer breaks a test rather
  // than silently stranding turns unchunked.
  const stale = await sql.unsafe<StaleTurnRow[]>(
    `SELECT st.workspace_id, st.source_kind, st.session_id, st.turn_idx, st.text
       FROM harness_shared.session_turns st
      WHERE length(st.text) > $1
        AND st.chunked_at IS NULL
      ORDER BY st.ingested_at DESC
      LIMIT $2`,
    [minChars, batch],
  );
  stats.more = stale.length >= batch;

  for (const t of stale) {
    try {
      // Computed HERE, in Node, only for turns we are actually rewriting.
      // Hashing moved out of the detection predicate; it did not disappear,
      // because turn_sha remains the chunk row's change key.
      const sha = turnSha(t.text);
      const chunks = splitWindows(t.text, TURN_WINDOW);
      // Replace wholesale: a shorter re-ingested turn must not leave its old
      // tail chunks behind, and an ON CONFLICT upsert cannot delete them.
      await sql.unsafe(
        `DELETE FROM harness_shared.session_turn_chunks
          WHERE workspace_id = $1 AND source_kind = $2 AND session_id = $3 AND turn_idx = $4`,
        [t.workspace_id, t.source_kind, t.session_id, t.turn_idx],
      );
      if (chunks.length > 0) {
        // Typed concretely rather than `unknown[]`: postgres.js infers the
        // parameter element type, and `unknown[]` collapses it to
        // `ParameterOrJSON<never>[]`, which nothing is assignable to. (The
        // doc-embed-sync precedent this module mirrors uses `unknown[]` and
        // carries exactly that error in the operator-core tsc baseline — copied
        // shape, copied defect. Every value here is a string or a number.)
        const params: Array<string | number> = [];
        const values = chunks
          .map((content, i) => {
            params.push(t.workspace_id, t.source_kind, t.session_id, t.turn_idx, i, content, sha);
            const b = i * 7;
            return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
          })
          .join(', ');
        await sql.unsafe(
          `INSERT INTO harness_shared.session_turn_chunks
             (workspace_id, source_kind, session_id, turn_idx, chunk_idx, content, turn_sha)
           VALUES ${values}
           ON CONFLICT (workspace_id, source_kind, session_id, turn_idx, chunk_idx)
           DO UPDATE SET content = EXCLUDED.content,
                         turn_sha = EXCLUDED.turn_sha,
                         updated_at = now(),
                         embedding = NULL,
                         embedding_mode = NULL,
                         embedding_profile = NULL`,
          params,
        );
        stats.chunks += chunks.length;
      }
      // Retire the turn from the detection index.
      //
      // AFTER the rewrite, never before: a crash between the two leaves
      // chunked_at NULL, so the turn is simply re-selected next tick. Marking
      // first would strand it silently — the failure mode this whole item exists
      // to make cheap, not to make invisible.
      //
      // OUTSIDE the `chunks.length > 0` branch on purpose: a turn that splits
      // into zero chunks is finished work, and leaving it NULL would put it back
      // at the head of the freshest-first scan on every future tick forever.
      //
      // A throw here lands in the catch below and leaves chunked_at NULL, which
      // is the safe direction (retry, not strand).
      await sql.unsafe(
        `UPDATE harness_shared.session_turns
            SET chunked_at = now()
          WHERE workspace_id = $1 AND source_kind = $2
            AND session_id = $3 AND turn_idx = $4`,
        [t.workspace_id, t.source_kind, t.session_id, t.turn_idx],
      );
      stats.turns += 1;
    } catch {
      stats.errors += 1;
    }
  }
  return stats;
}

async function turnChunksTableExists(sql: Sql): Promise<boolean> {
  const t = await sql.unsafe<Array<{ c: number }>>(
    `SELECT 1 AS c FROM information_schema.tables
      WHERE table_schema = 'harness_shared' AND table_name = 'session_turn_chunks'`,
  );
  return t.length > 0;
}

// State pinned to globalThis (perf rule A18, mirrors embed-backfill's and
// doc-embed-sync's sweep state): tsx / dual-path imports can instantiate this
// module twice.
interface TurnChunkSyncState {
  running: boolean;
  fails: number;
  /** Memoized migration-749 probe for the READ path — see below. */
  available: boolean;
  availableCheckedAt: number;
}
// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair — same sharing, but the pin stays visible
// to listModuleDuplications() (EI-19479108855357092).
const __turnChunkState = pinModuleState<TurnChunkSyncState>(
  '@papercusp/operator-core.turnChunkSyncState',
  () => ({ running: false, fails: 0, available: false, availableCheckedAt: 0 }),
);

/** How long a NEGATIVE availability probe is cached. */
const AVAILABILITY_TTL_MS = 60_000;

/**
 * Is migration 749 applied? — the READ path's fail-open guard.
 *
 * ⚠ THIS CANNOT BE DONE IN SQL, AND THE OBVIOUS ATTEMPT SILENTLY DOESN'T WORK.
 * A `to_regclass('…') IS NOT NULL` guard inside the query's WHERE clause reads
 * like it would make the chunk leg conditional, but Postgres resolves every
 * relation at PARSE time — so a query merely MENTIONING a missing table fails
 * outright, before any predicate is evaluated. The branch has to happen in JS,
 * on a query that was never built.
 *
 * Failing open matters here specifically: the chunk leg is an ENHANCEMENT to a
 * working semantic leg. If an unapplied migration took down the whole leg, this
 * change would be a regression on every deployment that hasn't migrated yet —
 * strictly worse than the truncation it fixes.
 *
 * Cached asymmetrically on purpose: a TRUE is permanent (tables are not
 * dropped), a FALSE is re-probed on a TTL so a live-applied migration is picked
 * up without an operator restart — which on this box is the normal way
 * migrations land.
 */
export async function turnChunksAvailable(sql: Sql): Promise<boolean> {
  if (__turnChunkState.available) return true;
  const now = Date.now();
  if (now - __turnChunkState.availableCheckedAt < AVAILABILITY_TTL_MS) return false;
  __turnChunkState.availableCheckedAt = now;
  try {
    __turnChunkState.available = await turnChunksTableExists(sql);
  } catch {
    __turnChunkState.available = false;
  }
  return __turnChunkState.available;
}

/** Persistent-failure bound — stops re-paying a failing pass every tick. */
const MAX_SYNC_FAILURES = 5;

/**
 * One sync pass per sweep tick, called from the periodic embed-backfill tick.
 *
 * Unlike doc-embed-sync's ONCE-per-process contract, this runs EVERY tick: its
 * source is a table that grows continuously, not a filesystem corpus frozen
 * behind a process-lifetime memoized adapter. Re-probes migration 749 each tick
 * until it exists, so a live-applied migration is picked up without a restart.
 * VITEST-inert — unrelated tests must never pay a corpus pass (the WI-3792
 * load-scar class).
 */
export async function runTurnChunkSyncTick(
  opts: { batch?: number } = {},
): Promise<TurnChunkSyncStats | { skipped: string }> {
  if (process.env.VITEST) return { skipped: 'vitest' };
  if (__turnChunkState.running) return { skipped: 'already_running' };
  if (__turnChunkState.fails >= MAX_SYNC_FAILURES) return { skipped: 'too_many_failures' };
  __turnChunkState.running = true;
  try {
    const { sql } = getOrgPg();
    if (!(await turnChunksTableExists(sql))) return { skipped: 'migration_749_absent' };
    const stats = await syncTurnChunks(sql, opts);
    if (stats.turns > 0) {
      console.log(
        `[turn-chunk-sync] ${stats.turns} turns -> ${stats.chunks} chunks` +
          `${stats.errors > 0 ? `, ${stats.errors} errors` : ''}${stats.more ? ' (more pending)' : ''}`,
      );
    }
    return stats;
  } catch (err) {
    __turnChunkState.fails += 1;
    console.warn('[turn-chunk-sync] sync failed:', (err as Error).message);
    return { skipped: 'error' };
  } finally {
    __turnChunkState.running = false;
  }
}
