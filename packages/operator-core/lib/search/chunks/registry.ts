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
 * This module stays near-leaf on purpose: prose-vector-dims.ts, which every
 * embedding hot path imports, derives from it. Its one value import is the
 * session-turn entry, whose module loads nothing heavier than node:crypto,
 * @papercusp/module-singleton and its store adapter (P-007).
 */

import type { ChunkSurface } from '@papercusp/search';
import { SESSION_TURN_CHUNK_SURFACE } from '../turn-chunk-sync';

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
    // vectors for LONG session turns — 1500-char windows, 250 overlap. A
    // dedicated store (D-002): 1.21M chunks stay where they are rather than
    // being copied into the shared table. Written by the engine through
    // ./session-turn-store.ts for the SESSION_TURN_CHUNK_SURFACE entry (P-007).
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

/**
 * Plans (P-009, D-014): 1,500-character windows with 250 overlap, up to 32
 * windows (~41k characters), chunk margin 0 — the bench arm D-014 chose. The
 * markdown splitter had the best tail MRR but cost short plans too much, so
 * D-014 rejected it; window chunks carry no anchor, and plans:search derives the
 * matched section from the winning window's position instead
 * (agent-tools/plans/semantic-leg.ts). Plans past 32 windows (233 of 2,164,
 * measured 2026-09-30) lose their tail, counted in parentsTruncatedByMaxChunks.
 * The header is the title, which the parent vector also embeds
 * (title + left(content, 2000)). Templates are never searched, so never chunked.
 * Reader: plans:search, in retrieve mode. plans:new's duplicate guard and the
 * scout novelty and intent legs read the parent vector alone (D-005).
 */
export const PLANS_CHUNK_SURFACE: PapercuspChunkSurface = {
  surface: 'plans',
  parent: {
    table: 'harness_shared.harness_plans',
    key: ['workspace_id', 'harness_slug', 'plan_slug'],
  },
  textSql: 'p.content',
  headerSql: 'p.title',
  eligibleSql: 'p.template_slug IS NULL',
  versionSql: 'p.updated_at',
  splitter: { kind: 'window', size: 1500, overlap: 250 },
  maxChunks: 32,
  // D-029 (P-015): D-014 chose margin 0, but the live re-run lowered short-row
  // MRR by .0134 against R-2's .01 bound; 0.02 is the smallest margin that meets
  // it on live data (.0054) and keeps tail recall@1 at .890 (.898 at margin 0).
  chunkMargin: 0.02,
  parentVector: { column: 'embedding', profileColumn: 'embedding_profile', modeColumn: 'embedding_mode' },
};

/**
 * Operator (chat) turns (P-010, D-017): 1,500-character windows with 250
 * overlap, up to 8 windows (~11k characters), each chunk's similarity lowered
 * by 0.06 before best-match pooling — the bench arm D-017 chose (at margin 0
 * the collection would not be chunked at all). Turns past 8 windows (268 over
 * 80k characters at P-001) lose their tail, counted in
 * parentsTruncatedByMaxChunks.
 *
 * A turn's text never changes after its INSERT (operator-conversations.ts
 * appendTurn; turn-answer.ts updates `tools` only), so its creation time
 * (epoch milliseconds) is its version. No header: a turn has no title line.
 * Reader: the search:semantic 'turns' source, in retrieve mode.
 */
export const OPERATOR_TURNS_CHUNK_SURFACE: PapercuspChunkSurface = {
  surface: 'operator_turns',
  // id is uuid: declaring the type casts the chunk side, so the prune anti-join
  // and the vector leg's join keep the primary-key index.
  parent: { table: 'harness_shared.operator_turns', key: [{ column: 'id', type: 'uuid' }] },
  textSql: 'p.text',
  versionSql: 'to_timestamp(p.created_at / 1000.0)',
  splitter: { kind: 'window', size: 1500, overlap: 250 },
  maxChunks: 8,
  chunkMargin: 0.06,
  parentVector: { column: 'text_embedding', profileColumn: 'text_embedding_profile', modeColumn: 'text_embedding_mode' },
  searchSource: 'turns',
};

/**
 * Work items (P-011, D-015): 1,500-character windows with 250 overlap, up to 4
 * windows (~5.3k characters), no chunk margin — the bench arm D-015 chose.
 * Every kind and lane shares the table, observations included, so every row
 * whose summary runs past the parent vector's 2,000 characters is chunked
 * (12,026 of 240,329 rows, measured 2026-09-30). The header is the title, which
 * the parent vector also embeds.
 *
 * Version: `updated_ts` (epoch milliseconds). Audited 2026-09-30: every
 * UPDATE that rewrites `summary` (or the engineer_issues view's `body`, whose
 * trigger sets `updated_ts` from `updated_at`) also advances it. A writer that
 * rewrites `summary` without touching it would leave that item's chunks stale
 * until its next edit.
 *
 * Readers in retrieve mode: search:semantic's work_item source (through the
 * engineer_issues view) and work_items:search's issue and feature legs
 * (work-items.ts). The duplicate guard, the admission promoter and census and
 * the scout novelty legs read the parent vector alone (D-005).
 */
export const WORK_ITEMS_CHUNK_SURFACE: PapercuspChunkSurface = {
  surface: 'work_items',
  parent: { table: 'harness_shared.work_items', key: ['harness_slug', 'feature_id'] },
  textSql: 'p.summary',
  headerSql: 'p.title',
  versionSql: 'to_timestamp(p.updated_ts / 1000.0)',
  splitter: { kind: 'window', size: 1500, overlap: 250 },
  maxChunks: 4,
  chunkMargin: 0,
  parentVector: { column: 'embedding', profileColumn: 'embedding_profile', modeColumn: 'embedding_mode' },
  searchSource: 'work_item',
};

/**
 * Consult questions (P-012, D-016): 1,500-character windows with 250 overlap, up
 * to 8 windows, chunk margin 0.04 — the bench arm D-016 chose. Escalations are not
 * registered (D-018: too few rows past the cut to measure).
 *
 * Version: `created_at`. A consult's question is written once when the consult
 * opens and never rewritten, while `updated_at` moves on every routing and state
 * change, which would only re-read unchanged text.
 *
 * Readers (D-027): coord:orient's peersKnow fold (consult/peers-know.ts) reads the
 * chunks in retrieve mode, so a declared intent that matches part of a long settled
 * question still surfaces it. consult:get_feedback's archive-first serve
 * (get-feedback-core.ts) stays on the parent vector: it answers a new question
 * with a past answer in place of a live consult, which is a duplicate decision
 * (D-005), not a search.
 *
 * Population (D-048): only settled questions are chunked (eligibleSql), the same
 * predicate the reader filters its slice with. Chunking every question indexed
 * ~9x more chunks than the reader can return: on 2026-10-02, 2,966 chunks of
 * which 332 belonged to settled questions. The ANN chunk leg then needed an
 * in-scan membership filter, an iterative scan and a transaction, and missed
 * its latency budget. A consult that later settles has no chunks yet, so the
 * sync engine selects it; one that leaves the set is pruned.
 */
export function consultSettledPredicate(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) {
    throw new Error(`consultSettledPredicate: alias '${alias}' is not a plain identifier`);
  }
  return `${alias}.state = 'closed_answered' AND (${alias}.outcome->>'source' IS DISTINCT FROM 'archive')`;
}

export const CONSULT_QUESTIONS_CHUNK_SURFACE: PapercuspChunkSurface = {
  surface: 'consult_questions',
  parent: { table: 'harness_shared.consult_state', key: ['workspace_id', 'conversation_id'] },
  textSql: 'p.question',
  eligibleSql: consultSettledPredicate('p'),
  versionSql: 'p.created_at',
  splitter: { kind: 'window', size: 1500, overlap: 250 },
  maxChunks: 8,
  chunkMargin: 0.04,
  parentVector: {
    column: 'query_embedding',
    profileColumn: 'query_embedding_profile',
    modeColumn: 'query_embedding_mode',
  },
};

export const CHUNK_SURFACES: readonly PapercuspChunkSurface[] = [
  // Session turns (P-007): the dedicated store above, not the shared table.
  SESSION_TURN_CHUNK_SURFACE,
  PLANS_CHUNK_SURFACE,
  OPERATOR_TURNS_CHUNK_SURFACE,
  WORK_ITEMS_CHUNK_SURFACE,
  CONSULT_QUESTIONS_CHUNK_SURFACE,
];

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
