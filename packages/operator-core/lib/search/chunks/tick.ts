/**
 * The chunk sync tick: keeps every registered chunk surface (./registry.ts)
 * in step with its parent table, using the generic engine in @papercusp/search.
 *
 * Runs on the existing embed-backfill tick, right before the embedding sweep
 * (so newly written chunks are embedded the same tick) — no new scheduler.
 * Surfaces are visited round-robin under a time budget, so a slow collection
 * cannot starve the others. Failures are per surface and per parent,
 * fail-open, and always logged and counted (the engine never throws).
 *
 * VITEST-inert unless the caller injects a SQL handle: unrelated tests must
 * never pay a corpus pass.
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  sharedChunkStore,
  syncChunkSurfaces,
  type ChunkSurface,
  type ChunkSyncLogger,
  type ChunkSyncResult,
} from '@papercusp/search';
import { CHUNK_SURFACES } from './registry';

/** The shared store: harness_shared.text_chunks (migration 1242). */
export const TEXT_CHUNK_STORE = sharedChunkStore({ table: 'harness_shared.text_chunks' });

/** sha256 hex — the store's SQL parent-sha form requires exactly this. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const DEFAULT_BATCH_PER_SURFACE = 50;
const DEFAULT_PRUNE_BATCH = 500;
const DEFAULT_TIME_BUDGET_MS = 20_000;
/** Bound on the remembered zero-chunk parents; clearing only costs a re-check. */
const MAX_EMPTY_KEYS = 10_000;
const AVAILABILITY_TTL_MS = 60_000;

interface ChunkSyncState {
  running: boolean;
  nextIndex: number;
  emptyKeys: Set<string>;
  available: boolean;
  availableCheckedAt: number;
}
const state = pinModuleState<ChunkSyncState>('@papercusp/operator-core.chunkSyncState', () => ({
  running: false,
  nextIndex: 0,
  emptyKeys: new Set<string>(),
  available: false,
  availableCheckedAt: 0,
}));

async function textChunksAvailable(sql: Sql): Promise<boolean> {
  if (state.available) return true;
  const now = Date.now();
  if (now - state.availableCheckedAt < AVAILABILITY_TTL_MS) return false;
  state.availableCheckedAt = now;
  const rows = await sql.unsafe<{ ok: boolean }[]>(`SELECT to_regclass('harness_shared.text_chunks') IS NOT NULL AS ok`);
  state.available = rows[0]?.ok === true;
  return state.available;
}

export type ChunkSyncTickResult = ChunkSyncResult | { skipped: string };

export async function runChunkSyncTick(
  opts: {
    sql?: Sql;
    surfaces?: readonly ChunkSurface[];
    batchPerSurface?: number;
    pruneBatch?: number;
    timeBudgetMs?: number;
    /** Default: console, prefixed [chunk-sync]. */
    logger?: ChunkSyncLogger;
  } = {},
): Promise<ChunkSyncTickResult> {
  if (process.env.VITEST && !opts.sql) return { skipped: 'vitest' };
  const surfaces = opts.surfaces ?? CHUNK_SURFACES;
  if (surfaces.length === 0) return { skipped: 'no_surfaces' };
  if (state.running) return { skipped: 'already_running' };
  state.running = true;
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    if (!(await textChunksAvailable(sql))) return { skipped: 'migration_1242_absent' };
    const res = await syncChunkSurfaces(sql, surfaces, TEXT_CHUNK_STORE, {
      hash: sha256Hex,
      batchPerSurface: opts.batchPerSurface ?? DEFAULT_BATCH_PER_SURFACE,
      pruneBatch: opts.pruneBatch ?? DEFAULT_PRUNE_BATCH,
      timeBudgetMs: opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
      startIndex: state.nextIndex,
      emptyKeys: state.emptyKeys,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    state.nextIndex = res.nextIndex;
    if (state.emptyKeys.size > MAX_EMPTY_KEYS) state.emptyKeys.clear();
    for (const s of res.surfaces) {
      if (s.parentsSynced + s.parentsUnchanged + s.pruned + s.errors + s.parentsTruncatedByMaxChunks === 0) continue;
      console.log(
        `[chunk-sync] ${s.surface}: ${s.parentsSynced} parents -> ${s.chunksWritten} chunks ` +
          `(${s.embeddingsReused} embeddings reused), ${s.parentsUnchanged} unchanged, ${s.pruned} pruned` +
          `${s.parentsTruncatedByMaxChunks > 0 ? `, ${s.parentsTruncatedByMaxChunks} truncated by maxChunks` : ''}` +
          `${s.errors > 0 ? `, ${s.errors} ERRORS` : ''}${s.more ? ' (more pending)' : ''}`,
      );
    }
    if (res.skippedForBudget > 0) {
      console.warn(`[chunk-sync] time budget reached; ${res.skippedForBudget} surface(s) wait for the next tick`);
    }
    return res;
  } catch (err) {
    // Only the availability probe or the pool can throw here; the engine itself never does.
    console.error('[chunk-sync] tick failed:', (err as Error).message);
    return { skipped: 'error' };
  } finally {
    state.running = false;
  }
}
