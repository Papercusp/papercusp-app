/**
 * Persistence for the worker chunk loop.
 *
 * Stores the up-front plan + per-chunk progress in
 * `harness_shared.harness_chunk_plans` so:
 *   1. The harness UI can show "F-AUTH-001: chunk 3/12 (in_progress)"
 *      via Zero replication of the table.
 *   2. A restarted orchestrator can resume cleanly — features whose
 *      plan was committed but whose chunks were partially complete
 *      pick up at the first non-`committed` chunk.
 *
 * One row per chunk. Plan reconstructed by SELECT ordered by chunk_index.
 */

import { pgJson, type OrchestratorPg } from './invoke.js';
import type { Chunk, ChunkPlan } from './chunk-plan.js';

export type ChunkStatus =
  | 'pending'
  | 'in_progress'
  | 'committed'
  | 'failing'
  | 'escalated';

export interface ChunkPlanPgCtx {
  pg: OrchestratorPg;
  workspaceId: string;
  harnessSlug: string;
}

/**
 * Replace any existing plan for a feature with this one, atomically: the
 * DELETE and every chunk INSERT run in ONE transaction (audit P-020 — the
 * loop previously ran unwrapped, so a crash mid-persist left the old plan
 * deleted and the new one half-inserted, which resume-on-restart replayed
 * as if it were the complete plan).
 *
 * Transaction support is duck-typed like `pgJson`: a real postgres-js client
 * (every production caller) has `.begin`; test doubles (makeMockPg) don't and
 * fall back to sequential statements — unit mocks observe the same call
 * sequence, the real client gets atomicity.
 */
export async function persistPlan(
  ctx: ChunkPlanPgCtx,
  plan: ChunkPlan,
): Promise<void> {
  const write = async (pg: OrchestratorPg): Promise<void> => {
    // Note: postgres-js tagged-template syntax — the template strings
    // are joined and parameter substituted by the driver, so this is
    // not SQL injection vulnerable despite looking like string concat.
    await pg`
      DELETE FROM harness_shared.harness_chunk_plans
      WHERE workspace_id = ${ctx.workspaceId}
        AND harness_slug = ${ctx.harnessSlug}
        AND feature_id   = ${plan.featureId}
    `;
    for (let i = 0; i < plan.chunks.length; i++) {
      const c = plan.chunks[i];
      await pg`
        INSERT INTO harness_shared.harness_chunk_plans
          (workspace_id, harness_slug, feature_id, chunk_id, chunk_index,
           files, description, status)
        VALUES
          (${ctx.workspaceId}, ${ctx.harnessSlug}, ${plan.featureId},
           ${c.id}, ${i + 1},
           ${pgJson(pg, c.files)}::jsonb,
           ${c.description}, 'pending')
      `;
    }
  };
  const begin = (
    ctx.pg as { begin?: <T>(fn: (tx: OrchestratorPg) => Promise<T>) => Promise<T> }
  ).begin;
  if (typeof begin === 'function') {
    await begin.call(ctx.pg, write);
  } else {
    await write(ctx.pg);
  }
}

/**
 * Mark a chunk's status. Strikes / last_error / commit_sha are
 * optional and only updated when supplied.
 */
export async function setChunkStatus(
  ctx: ChunkPlanPgCtx,
  featureId: string,
  chunkId: string,
  status: ChunkStatus,
  extras: { strikes?: number; lastError?: string; commitSha?: string } = {},
): Promise<void> {
  const now = Date.now();
  await ctx.pg`
    UPDATE harness_shared.harness_chunk_plans
    SET status      = ${status},
        strikes     = COALESCE(${extras.strikes ?? null}, strikes),
        last_error  = COALESCE(${extras.lastError ?? null}, last_error),
        commit_sha  = COALESCE(${extras.commitSha ?? null}, commit_sha),
        updated_ts  = ${now}
    WHERE workspace_id = ${ctx.workspaceId}
      AND harness_slug = ${ctx.harnessSlug}
      AND feature_id   = ${featureId}
      AND chunk_id     = ${chunkId}
  `;
}

/**
 * Replace one chunk in the plan (the re-plan path). The chunk_id
 * stays the same; files + description + status (reset to 'pending')
 * + last_error get rewritten.
 */
export async function updateChunkPlan(
  ctx: ChunkPlanPgCtx,
  featureId: string,
  chunk: Chunk,
): Promise<void> {
  const now = Date.now();
  await ctx.pg`
    UPDATE harness_shared.harness_chunk_plans
    SET files        = ${pgJson(ctx.pg, chunk.files)}::jsonb,
        description  = ${chunk.description},
        status       = 'pending',
        last_error   = NULL,
        updated_ts   = ${now}
    WHERE workspace_id = ${ctx.workspaceId}
      AND harness_slug = ${ctx.harnessSlug}
      AND feature_id   = ${featureId}
      AND chunk_id     = ${chunk.id}
  `;
}

/**
 * Read back a feature's plan, ordered by chunk_index. Used by
 * resume-on-restart logic.
 */
export interface PersistedChunk {
  chunkId: string;
  index: number;
  files: readonly string[];
  description: string;
  status: ChunkStatus;
  strikes: number;
  lastError: string | null;
  commitSha: string | null;
}

/**
 * Coerce a stored `files` value to a string[]. Current writes store a proper
 * jsonb array (postgres-js returns it as a JS array). LEGACY rows (written before
 * the pgJson fix) double-encoded it — a JSON-stringified array landed in the jsonb
 * column as a STRING, which postgres-js returns as a JS string. Resuming such a
 * plan would then crash the chunk loop at `paths.map is not a function`; parse it
 * back to an array so resume tolerates legacy data. Junk → [].
 */
export function normalizeStoredFiles(value: unknown): readonly string[] {
  const asArray = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  const direct = asArray(value);
  if (direct) return direct;
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = asArray(JSON.parse(value));
      if (parsed) return parsed;
    } catch {
      /* not JSON — fall through */
    }
  }
  return [];
}

export async function readPlan(
  ctx: ChunkPlanPgCtx,
  featureId: string,
): Promise<readonly PersistedChunk[]> {
  const rows = await ctx.pg`
    SELECT chunk_id, chunk_index, files, description, status,
           strikes, last_error, commit_sha
    FROM harness_shared.harness_chunk_plans
    WHERE workspace_id = ${ctx.workspaceId}
      AND harness_slug = ${ctx.harnessSlug}
      AND feature_id   = ${featureId}
    ORDER BY chunk_index ASC
  `;
  return rows.map((r: Record<string, unknown>) => ({
    chunkId: r.chunk_id as string,
    index: r.chunk_index as number,
    files: normalizeStoredFiles(r.files),
    description: r.description as string,
    status: r.status as ChunkStatus,
    strikes: (r.strikes as number) ?? 0,
    lastError: (r.last_error as string | null) ?? null,
    commitSha: (r.commit_sha as string | null) ?? null,
  }));
}

/**
 * Drop a feature's plan entirely. Called when the feature is
 * abandoned (deleted, deprecated, etc.). Keeping stale plans around
 * just clutters the UI.
 */
export async function dropPlan(
  ctx: ChunkPlanPgCtx,
  featureId: string,
): Promise<void> {
  await ctx.pg`
    DELETE FROM harness_shared.harness_chunk_plans
    WHERE workspace_id = ${ctx.workspaceId}
      AND harness_slug = ${ctx.harnessSlug}
      AND feature_id   = ${featureId}
  `;
}
