/**
 * chunks/session-turn-store — the ChunkStore for session turns' DEDICATED chunk
 * table, harness_shared.session_turn_chunks (migration 749; D-002 of
 * generic-rag-chunking-2026-09-29, P-007).
 *
 * The generic engine (@papercusp/search syncChunkSurface) writes session-turn
 * chunks through this adapter instead of turn-chunk-sync's own loop. The table
 * keeps its shape — typed key columns, the parent FK ON DELETE CASCADE, and
 * turn_sha as the parent sha — so its ~1.21M existing rows are read as they
 * are: no data migration, and re-syncing them re-embeds nothing (R-21).
 *
 * How the table's shape maps onto the ChunkStore contract:
 *
 *  - DETECTION is the session_turns.chunked_at marker (migration 1117), read
 *    through its partial index session_turns_unchunked_idx
 *    (`ingested_at DESC WHERE length(text) > 2000 AND chunked_at IS NULL`).
 *    Detection never reads turn text or hashes it: hashing every long turn per
 *    tick is what cost ~5.5s/tick before 1117. This is correct only because
 *    session_turns.text is INSERT-ONLY (session-turns-text-immutable.test.ts).
 *  - The MARKER is written in the same transaction as the chunk rewrite, after
 *    it: a failed rewrite rolls back and leaves the turn unmarked, so it is
 *    re-selected next tick instead of silently stranded. A turn that cuts to
 *    zero chunks is marked too, so it cannot hold the head of the scan forever.
 *  - chunk_sha is not stored. There is no header, so a chunk's embedded text is
 *    its content, and readExisting computes sha256(content) in SQL. The engine's
 *    `hash` must therefore be sha256 hex (the tick's sha256Hex), exactly as the
 *    shared store already requires for unversioned surfaces.
 *  - splitter_version is not stored. Every row was cut with ONE splitter, so the
 *    store PINS it (STORED_SPLITTER_VERSION) and refuses a surface whose
 *    splitter differs: changing it needs a re-cut of the table (a migration),
 *    not a registry edit that would silently mix two cuts in one table.
 *  - PRUNE is the foreign key. A deleted turn's chunks cascade away, and an
 *    insert-only turn never shrinks below the cut or changes eligibility, so
 *    prune has nothing to do. The store refuses an eligibleSql and a minChars
 *    other than the indexed 2000 for the same reason: either would need a real
 *    prune (and the second would forfeit the partial index).
 */

import type { Sql } from 'postgres';
import type { ChunkStore, ExistingChunk, ResolvedChunkSurface, StaleParent } from '@papercusp/search';

export const SESSION_TURN_CHUNKS_TABLE = 'harness_shared.session_turn_chunks';
export const SESSION_TURNS_TABLE = 'harness_shared.session_turns';

/**
 * The cut every stored row was made with: 1500-char windows, 250 overlap, at
 * most 16 per turn (D-016 of semantic-search-fingerprint-coverage-2026-08-03),
 * in @papercusp/search splitterVersionOf's form. A FACT ABOUT THE STORED DATA,
 * so it is a literal here and not derived from the registry entry: deriving it
 * would let an entry edit move the pin along with it.
 */
export const STORED_SPLITTER_VERSION = 'window-v1:1500/250@16';

/** The length cut in session_turns_unchunked_idx's predicate (migration 1117). */
export const INDEXED_MIN_CHARS = 2000;

/** The four parent key columns, in the chunk table's primary-key order. */
const KEY_COLUMNS = ['workspace_id', 'source_kind', 'session_id', 'turn_idx'] as const;

/** Why a surface cannot use this store, or null when it can. */
export function sessionTurnSurfaceProblem(surface: ResolvedChunkSurface): string | null {
  if (surface.parent.table !== SESSION_TURNS_TABLE) {
    return `parent.table must be ${SESSION_TURNS_TABLE}, not '${surface.parent.table}'`;
  }
  const cols = surface.keyColumns.map((k) => k.column);
  if (cols.join(',') !== KEY_COLUMNS.join(',')) {
    return `parent.key must be (${KEY_COLUMNS.join(', ')}), not (${cols.join(', ')})`;
  }
  if (surface.headerSql !== undefined) return 'the table has no header column, so headerSql is not supported';
  if (surface.eligibleSql !== undefined) {
    return 'eligibleSql is not supported: prune is the parent FK, which cannot drop chunks of an ineligible turn';
  }
  if (surface.minChars !== INDEXED_MIN_CHARS) {
    return `minChars must be ${INDEXED_MIN_CHARS}, the cut in session_turns_unchunked_idx; got ${surface.minChars}`;
  }
  if (surface.splitterVersion !== STORED_SPLITTER_VERSION) {
    return (
      `splitter ${surface.splitterVersion} differs from the one every stored row was cut with ` +
      `(${STORED_SPLITTER_VERSION}); the table has no splitter_version column, so a new splitter needs a re-cut migration`
    );
  }
  return null;
}

function assertSessionTurnSurface(surface: ResolvedChunkSurface): void {
  const problem = sessionTurnSurfaceProblem(surface);
  if (problem) throw new Error(`session turn chunk store (surface '${surface.surface}'): ${problem}`);
}

/**
 * The typed key parameters for one turn: (workspace_id, source_kind, session_id, turn_idx).
 * Typed as a concrete string | number array, not a tuple and not unknown[]:
 * postgres.js infers its parameter element type, and a tuple cannot be cast to
 * the resulting never[] (TS2352), so this is the one shape it accepts uncast.
 */
function keyParams(key: readonly string[]): Array<string | number> {
  if (key.length !== 4) throw new Error(`session turn key must have 4 parts, got ${key.length}`);
  const turnIdx = Number(key[3]);
  if (!Number.isInteger(turnIdx)) throw new Error(`session turn key turn_idx '${key[3]}' is not an integer`);
  return [key[0]!, key[1]!, key[2]!, turnIdx];
}

const KEY_MATCH = 'workspace_id = $1 AND source_kind = $2 AND session_id = $3 AND turn_idx = $4';

export function sessionTurnChunkStore(): ChunkStore {
  return {
    name: SESSION_TURN_CHUNKS_TABLE,
    queryTable: { table: SESSION_TURN_CHUNKS_TABLE, keying: 'typed', anchorColumn: null },

    async transaction(sql, fn) {
      return (await sql.begin((tx) => fn(tx as unknown as Sql))) as Awaited<ReturnType<typeof fn>>;
    },

    async selectStale(sql, surface, { limit, excludeKeys }): Promise<StaleParent[]> {
      assertSessionTurnSurface(surface);
      const text = `(${surface.textSql})`;
      const keyArr = `ARRAY[p.workspace_id, p.source_kind, p.session_id, p.turn_idx::text]`;
      const params: unknown[] = [surface.minChars, limit];
      let exclude = '';
      if (excludeKeys.length > 0) {
        params.push([...excludeKeys]);
        exclude = `AND array_to_string(${keyArr}, chr(31)) <> ALL($3::text[])`;
      }
      // ⚠ NEVER READ OR HASH `text` HERE TO DECIDE WHETHER THERE IS WORK beyond
      // the length cut the partial index already carries: caught up, the index
      // has zero entries and the tick touches no turn text at all.
      const rows = await sql.unsafe<{ parent_key: string[]; text: string }[]>(
        `SELECT ${keyArr} AS parent_key, ${text} AS text
           FROM ${SESSION_TURNS_TABLE} p
          WHERE length(${text}) > $1
            AND p.chunked_at IS NULL
            ${exclude}
          ORDER BY ${surface.versionSql ? `(${surface.versionSql})` : 'p.ingested_at'} DESC
          LIMIT $2`,
        params as never[],
      );
      // version stays null: detection is the chunked_at marker, not a stored version.
      return rows.map((r) => ({ key: r.parent_key, text: r.text, header: null, version: null }));
    },

    async readExisting(sql, _surface, key): Promise<ExistingChunk[]> {
      const rows = await sql.unsafe<
        {
          chunk_idx: number;
          chunk_sha: string;
          parent_sha: string;
          embedding: string | null;
          embedding_mode: string | null;
          embedding_profile: string | null;
        }[]
      >(
        `SELECT chunk_idx, encode(sha256(convert_to(content, 'UTF8')), 'hex') AS chunk_sha,
                turn_sha AS parent_sha, embedding::text AS embedding, embedding_mode, embedding_profile
           FROM ${SESSION_TURN_CHUNKS_TABLE}
          WHERE ${KEY_MATCH}
          ORDER BY chunk_idx
          FOR UPDATE`,
        keyParams(key),
      );
      return rows.map((r) => ({
        chunkIdx: r.chunk_idx,
        chunkSha: r.chunk_sha,
        parentSha: r.parent_sha,
        splitterVersion: STORED_SPLITTER_VERSION,
        embedding: r.embedding,
        embeddingMode: r.embedding_mode,
        embeddingProfile: r.embedding_profile,
      }));
    },

    async replace(sql, surface, key, rows, meta) {
      assertSessionTurnSurface(surface);
      for (const r of rows) {
        if (r.header !== null || r.anchor !== null) {
          throw new Error('session turn chunk store: a chunk carried a header or anchor, which the table cannot store');
        }
      }
      const k = keyParams(key);
      // Replace wholesale: a re-cut that yields fewer chunks must not leave the
      // old tail behind.
      await sql.unsafe(`DELETE FROM ${SESSION_TURN_CHUNKS_TABLE} WHERE ${KEY_MATCH}`, k);
      if (rows.length > 0) {
        await sql.unsafe(
          `INSERT INTO ${SESSION_TURN_CHUNKS_TABLE}
             (workspace_id, source_kind, session_id, turn_idx, chunk_idx, content, turn_sha,
              embedding, embedding_mode, embedding_profile)
           SELECT $1::text, $2::text, $3::text, $4::int, u.idx::int, u.content, $5::text,
                  u.embedding::vector, u.embedding_mode, u.embedding_profile
             FROM unnest($6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
                  AS u(idx, content, embedding, embedding_mode, embedding_profile)`,
          [
            ...k,
            meta.parentSha,
            rows.map((r) => String(r.chunkIdx)),
            rows.map((r) => r.content),
            rows.map((r) => r.embedding),
            rows.map((r) => r.embeddingMode),
            rows.map((r) => r.embeddingProfile),
          ] as never[],
        );
      }
      // Retire the turn from the detection index AFTER the rewrite, in the same
      // transaction, and whether or not it produced chunks (see the header).
      await sql.unsafe(`UPDATE ${SESSION_TURNS_TABLE} SET chunked_at = now() WHERE ${KEY_MATCH}`, k);
    },

    async touch(sql, _surface, key) {
      // The stored chunks already match the turn: only retire it from detection.
      await sql.unsafe(
        `UPDATE ${SESSION_TURNS_TABLE} SET chunked_at = now() WHERE ${KEY_MATCH} AND chunked_at IS NULL`,
        keyParams(key),
      );
    },

    async prune() {
      // The parent FK (ON DELETE CASCADE) removes a deleted turn's chunks, and
      // an insert-only turn never becomes shorter or ineligible.
      return { parents: 0, chunks: 0 };
    },
  };
}
