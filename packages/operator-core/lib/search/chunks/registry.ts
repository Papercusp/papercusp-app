/**
 * The chunked search collections (generic-rag-chunking-2026-09-29).
 *
 * Every entry here is kept in step with its parent table by the generic sync
 * engine in @papercusp/search (see ./tick.ts), stored in the shared
 * harness_shared.text_chunks table (migration 1242) unless the entry names
 * another store. Adding a collection is ONE entry: no migration, no sync code.
 *
 * The splitter, maxChunks and chunkMargin of each entry come from that
 * collection's P-001 bench decision (D-014..D-017); Phase 3 (P-009..P-013)
 * adds the entries.
 *
 * P-005: the host-side registrations every chunk TABLE needs outside the sync
 * engine (the embed sweep's target, the prose-width column list, the search
 * coverage gate, the retention map, the hot-backup exclusion) are DERIVED from
 * `CHUNK_STORES` below instead of being hand-listed in five places. The backup
 * package cannot import operator-core, so its list is pinned by
 * ./derived-registrations.test.ts instead.
 *
 * This module is a leaf on purpose (a type-only import): prose-vector-dims.ts,
 * which every embedding hot path imports, derives from it.
 */

import type { ChunkSurface } from '@papercusp/search';

/** The shared store every entry writes to unless it names another (migration 1242). */
export const TEXT_CHUNKS_TABLE = 'harness_shared.text_chunks';

/**
 * One physical chunk table and what the host must know about it beyond the
 * sync engine. A collection does not add one of these: it writes into the
 * shared store. Only a DEDICATED store (a table of its own, like
 * session_turn_chunks per D-002) is a new registration.
 */
export interface ChunkStoreRegistration {
  /** Schema-qualified chunk table. */
  table: string;
  /** Its vector column; it holds the shared prose width. */
  embedCol: string;
  /** The embed sweep's key columns (the table's primary key). */
  keyCols: readonly string[];
  /** The text the embed sweep embeds for one chunk row. */
  embeddedTextSql: string;
  /**
   * Why nothing needs to age-prune this table, with the deleting mechanism
   * named (storage-growth-alarm's RETENTION_COVERED_ELSEWHERE).
   */
  retention: string;
  /**
   * Search sources (coverage-gate SEARCH_SOURCE_SURFACES keys) that read this
   * table's vectors whatever collection wrote them. A dedicated store names
   * its reader here; the shared store's readers come from each entry's
   * `searchSource` instead.
   */
  searchSources: readonly string[];
}

/** A registry entry: the library's surface plus papercusp's own wiring. */
export interface PapercuspChunkSurface extends ChunkSurface {
  /**
   * The coverage-gate search source (a SEARCH_SOURCE_SURFACES key) whose
   * results this collection's chunks feed; omit when its search site is not
   * a search source (e.g. plans:search).
   */
  searchSource?: string;
}

// Order is the embed sweep's target order (session turns first, as before P-005).
export const CHUNK_STORES: readonly ChunkStoreRegistration[] = [
  {
    // P-034 (semantic-search-fingerprint-coverage-2026-08-03, D-016): per-chunk
    // vectors for LONG session turns — 1500-char windows, 250 overlap,
    // sha-keyed, derived by turn-chunk-sync.ts. A dedicated store (D-002):
    // 1.21M chunks stay where they are rather than being copied into the
    // shared table. No header: a chunk's neighbours are its context, and the
    // parent's speaker/owner metadata is joined at query time.
    table: 'harness_shared.session_turn_chunks',
    embedCol: 'embedding',
    keyCols: ['workspace_id', 'source_kind', 'session_id', 'turn_idx', 'chunk_idx'],
    // `content` is already capped at 1500 by the splitter; the left() is
    // belt-and-braces, matching doc_sections.
    embeddedTextSql: `left(COALESCE(content, ''), 2000)`,
    retention: 'derived cache — migration 749 ON DELETE CASCADE from session_turns; inherits parent retention',
    searchSources: ['session_turn'],
  },
  {
    table: TEXT_CHUNKS_TABLE,
    embedCol: 'embedding',
    keyCols: ['surface', 'parent_key', 'chunk_idx'],
    // The header (the parent's title line) is embedded with each chunk as
    // `header\ncontent`: ONE newline, exactly @papercusp/search's
    // embeddedChunkText (which chunk_sha hashes) and the P-001 bench's
    // embedding. nullif() makes an empty header embed content alone, as
    // embeddedChunkText does. A re-split copies vectors across by chunk_sha, so
    // the sweep only pays for chunks whose text actually changed.
    // shared-store.integration.test.ts evaluates this SQL against
    // embeddedChunkText, so the two cannot drift again (R-38).
    embeddedTextSql: `left(concat_ws(E'\\n', nullif(header, ''), content), 2000)`,
    retention:
      'derived cache — the chunk-sync prune pass (search/chunks/tick.ts -> @papercusp/search store.prune) deletes the chunks of deleted, ineligible or shrunk parents, per registered surface; a surface removed from the registry must have its rows deleted in the same change',
    searchSources: [],
  },
];

export const CHUNK_SURFACES: readonly PapercuspChunkSurface[] = [];

/** Bare table name (the storage-growth-alarm's key form). */
export function bareTableName(table: string): string {
  const dot = table.lastIndexOf('.');
  return dot === -1 ? table : table.slice(dot + 1);
}

/** The store a surface writes to: its own `store`, else the shared table. */
export function surfaceStoreTable(surface: ChunkSurface): string {
  return surface.store?.name ?? TEXT_CHUNKS_TABLE;
}

/** `{ table, column }` for every chunk store's vector column. */
export function chunkStoreVectorColumns(
  stores: readonly ChunkStoreRegistration[] = CHUNK_STORES,
): Array<{ table: string; column: string }> {
  return stores.map((s) => ({ table: s.table, column: s.embedCol }));
}

/**
 * Merge the chunk stores' vector columns into a search-source coverage map
 * (`source -> ['schema.table.column', …]`): a dedicated store's column goes to
 * each of its `searchSources`; the shared store's column goes to every source
 * a registered entry names. Order is preserved and duplicates are dropped.
 */
export function withChunkSearchColumns(
  base: Readonly<Record<string, readonly string[]>>,
  stores: readonly ChunkStoreRegistration[] = CHUNK_STORES,
  surfaces: readonly PapercuspChunkSurface[] = CHUNK_SURFACES,
): Record<string, readonly string[]> {
  const out: Record<string, string[]> = {};
  for (const [source, cols] of Object.entries(base)) out[source] = [...cols];
  const add = (source: string, col: string) => {
    const list = (out[source] ??= []);
    if (!list.includes(col)) list.push(col);
  };
  const byTable = new Map(stores.map((s) => [s.table, s]));
  for (const s of stores) for (const source of s.searchSources) add(source, `${s.table}.${s.embedCol}`);
  for (const surface of surfaces) {
    if (!surface.searchSource) continue;
    const store = byTable.get(surfaceStoreTable(surface));
    if (store) add(surface.searchSource, `${store.table}.${store.embedCol}`);
  }
  return out;
}

/**
 * The stores (by table) a registration list is missing. A registry entry whose
 * store is not in CHUNK_STORES is reported too, under its own table.
 */
export function missingChunkStores(
  listed: Iterable<string>,
  stores: readonly ChunkStoreRegistration[] = CHUNK_STORES,
  map: (table: string) => string = (t) => t,
): string[] {
  const have = new Set(listed);
  return stores.map((s) => s.table).filter((t) => !have.has(map(t)));
}
