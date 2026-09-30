/**
 * turn-chunk-sync — the session-turn chunk collection: per-chunk rows for LONG
 * session turns in harness_shared.session_turn_chunks (migration 749), so the
 * embed-backfill sweep can vectorize them for the transcript search semantic
 * leg (P-034, semantic-search-fingerprint-coverage-2026-08-03, decision D-016).
 *
 * THE DEFECT THIS CLOSES. `session_turns.text_embedding` is built from
 * `left(text, 2000)`. Everything past that cut has no vector and is
 * unretrievable by the semantic leg — measured 2026-08-03, 33,232 turns (8.1%)
 * carry ~90.5M invisible characters, and a probe drawn from past the cut ranks
 * its true parent turn at MRR ~0.25 / recall@1 ~14% against 59 distractors.
 * Chunking lifts the SAME corpus and SAME queries to MRR 0.73-0.84 / recall@1
 * 60-75% (+216% to +230%).
 *
 * SINCE generic-rag-chunking-2026-09-29 P-007 THIS MODULE IS A REGISTRY ENTRY.
 * The generic engine in @papercusp/search (run by ./chunks/tick.ts on the
 * embed-backfill tick) syncs session turns like every other chunked collection,
 * writing through a small adapter for the dedicated table
 * (./chunks/session-turn-store.ts: chunked_at detection, turn_sha as the parent
 * sha, FK-cascade prune). What was a hand-written sync loop here is now
 * SESSION_TURN_CHUNK_SURFACE below. Re-syncing the existing rows through the
 * engine changes no chunk row and re-embeds nothing
 * (chunks/session-turn-parity.integration.test.ts, R-21).
 *
 * ⚠ THE SPLITTER IS THE MEASURED ONE, NOT A REIMPLEMENTATION OF IT.
 * `splitWindows` (@papercusp/search, moved there verbatim and golden-pinned by
 * generic-rag-chunking-2026-09-29 P-002) at TURN_WINDOW is the exact algorithm
 * D-016's numbers came from, and the bench that produced them
 * (memory/bench/turn-truncation-width-cli.ts) IMPORTS these constants rather
 * than carrying its own copy. A benchmark that measures a private copy of the
 * algorithm stops being evidence about the shipped path the moment the two
 * drift, and the drift is silent.
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { pinModuleState } from '@papercusp/module-singleton';
import type { WindowSplitOptions } from '@papercusp/search';
import type { PapercuspChunkSurface } from './chunks/registry';
import { SESSION_TURN_CHUNKS_TABLE, SESSION_TURNS_TABLE, sessionTurnChunkStore } from './chunks/session-turn-store';

/**
 * Chunk width, in characters. 1500 is the measured arm from D-016 — not a
 * round number picked for looks.
 */
export const TURN_CHUNK_CHARS = 1500;

/**
 * Overlap between consecutive chunks. Keeps a probe that STRADDLES a chunk
 * boundary from being split across two vectors and diluted in both.
 */
export const TURN_CHUNK_OVERLAP = 250;

/**
 * Only turns LONGER than this are chunked. It is the parent's own
 * `left(text, 2000)` embed width: a turn at or below it is already fully
 * covered by its own `session_turns.text_embedding`, so chunking it would add
 * rows, vectors and sweep cost for zero recall. It is also the cut in the
 * detection index (session_turns_unchunked_idx), which the store enforces.
 */
export const TURN_CHUNK_MIN_TEXT_CHARS = 2000;

/**
 * Hard bound on chunks derived from ONE turn. Turns are capped at 8000
 * characters at ingest (measured 2026-08-03), which yields 7 chunks; 16 is
 * headroom so a pathological turn can never emit an unbounded INSERT.
 */
export const MAX_CHUNKS_PER_TURN = 16;

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
 * sha256 of a turn's full text — the value stored as each chunk's turn_sha,
 * and what the engine computes as the parent sha (parentShaOf with no header),
 * so an existing turn re-read through the engine matches its stored chunks.
 *
 * ⚠ The SQL equivalent is `encode(sha256(convert_to(text,'UTF8')),'hex')`, NOT
 * `text::bytea`: that cast PARSES the string as a bytea literal, so a turn
 * containing a backslash raises `invalid input syntax for type bytea`. Verified
 * against the live database 2026-08-03 with `a\x41b\nhéllo` (a string only
 * valid one way): both sides give
 * 28675fb761f2675f240005800d831457fb9f6bc5351c4d8add5ca4ce7597439e.
 */
export function turnSha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The session-turn registry entry (./chunks/registry.ts CHUNK_SURFACES).
 * No header: a chunk's neighbours are its context, and the parent's
 * speaker/owner metadata is joined at query time. versionSql only orders the
 * scan freshest-first: detection is the chunked_at marker, and turn text is
 * insert-only (session-turns-text-immutable.test.ts). Its reader is the
 * transcript search's session_turn source, which builds its vector leg from
 * this entry (agent-tools/search/sources.ts); margin 0 keeps that pooling
 * identical to the pre-registry MAX-of-legs query.
 */
export const SESSION_TURN_CHUNK_SURFACE: PapercuspChunkSurface = {
  surface: 'session_turns',
  parent: {
    table: SESSION_TURNS_TABLE,
    key: ['workspace_id', 'source_kind', 'session_id', { column: 'turn_idx', type: 'integer' }],
  },
  textSql: 'p.text',
  versionSql: 'p.ingested_at',
  minChars: TURN_CHUNK_MIN_TEXT_CHARS,
  splitter: { kind: 'window', size: TURN_CHUNK_CHARS, overlap: TURN_CHUNK_OVERLAP },
  maxChunks: MAX_CHUNKS_PER_TURN,
  chunkMargin: 0,
  store: sessionTurnChunkStore(),
  parentVector: {
    column: 'text_embedding',
    profileColumn: 'text_embedding_profile',
    modeColumn: 'text_embedding_mode',
  },
};

// State pinned to globalThis (perf rule A18): tsx / dual-path imports can
// instantiate this module twice. Pinned through @papercusp/module-singleton so
// the pin stays visible to listModuleDuplications() (EI-19479108855357092).
interface TurnChunkReadState {
  /** Memoized migration-749 probe for the READ path — see below. */
  available: boolean;
  availableCheckedAt: number;
}
const __turnChunkState = pinModuleState<TurnChunkReadState>(
  '@papercusp/operator-core.turnChunkSyncState',
  () => ({ available: false, availableCheckedAt: 0 }),
);

/** How long a NEGATIVE availability probe is cached. */
const AVAILABILITY_TTL_MS = 60_000;

/**
 * Is migration 749 applied? — the READ path's fail-open guard.
 *
 * ⚠ THIS CANNOT BE DONE IN SQL. A `to_regclass('…') IS NOT NULL` guard inside
 * the query's WHERE clause reads like it would make the chunk leg conditional,
 * but Postgres resolves every relation at PARSE time — so a query merely
 * MENTIONING a missing table fails outright. The branch has to happen in JS, on
 * a query that was never built. Failing open matters: the chunk leg is an
 * ENHANCEMENT to a working semantic leg, so an unapplied migration must not take
 * the whole leg down.
 *
 * Cached asymmetrically on purpose: a TRUE is permanent (tables are not
 * dropped), a FALSE is re-probed on a TTL so a live-applied migration is picked
 * up without an operator restart.
 */
export async function turnChunksAvailable(sql: Sql): Promise<boolean> {
  if (__turnChunkState.available) return true;
  const now = Date.now();
  if (now - __turnChunkState.availableCheckedAt < AVAILABILITY_TTL_MS) return false;
  __turnChunkState.availableCheckedAt = now;
  try {
    const t = await sql.unsafe<Array<{ ok: boolean }>>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [
      SESSION_TURN_CHUNKS_TABLE,
    ]);
    __turnChunkState.available = t[0]?.ok === true;
  } catch {
    __turnChunkState.available = false;
  }
  return __turnChunkState.available;
}
