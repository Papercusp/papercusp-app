/**
 * Live PG streaming of subprocess output — Phase 4b of the orchestrator → PG arc.
 *
 * Phase 4 inserted the *final* run output (jsonl/out/err bodies) into
 * harness_run_output AT subprocess exit. For live streaming (operator
 * UI showing agent thinking as it happens), Phase 4b inserts each
 * stdout chunk as a row + pg_notify on a per-run channel. Subscribers
 * LISTEN to the channel and SELECT new rows as notifications arrive —
 * direct replacement for fs.watch on a JSONL file.
 *
 * Schema:
 *
 *   CREATE TABLE harness_shared.harness_run_chunks (
 *     workspace_id  TEXT NOT NULL DEFAULT 'default',
 *     harness_slug  TEXT NOT NULL,
 *     run_id        TEXT NOT NULL,
 *     seq           INT NOT NULL,
 *     chunk_data    TEXT NOT NULL,      -- raw bytes from subprocess
 *     ts            BIGINT NOT NULL,
 *     PRIMARY KEY (workspace_id, harness_slug, run_id, seq)
 *   );
 *   CREATE INDEX harness_run_chunks_run_idx
 *     ON harness_shared.harness_run_chunks (workspace_id, harness_slug, run_id, seq);
 *
 * pg_notify channel: `run:<runId>` payload `<seq>`. Subscribers can
 * `SELECT chunk_data, seq FROM harness_run_chunks WHERE run_id = $1
 *  AND seq > $lastSeq ORDER BY seq` after each notify.
 *
 * Ordering: chunk seq is assigned synchronously at arrival (in
 * `child.stdout.on('data')`), then enqueued on a serial Promise chain
 * so INSERTs don't interleave even though they're async. Subscribers
 * see chunks in correct order.
 *
 * Retention: chunks are typically pruned after the corresponding
 * harness_run_output row is finalized (the row holds the full
 * concatenated body — chunks become redundant). Pruning is the
 * operator's responsibility; this module just appends.
 */
import type { OrchestratorPg } from './invoke';

export interface RunChunksPgContext {
  pg: OrchestratorPg;
  workspaceId: string;
  harnessSlug: string;
}

export const RUN_CHUNKS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_run_chunks (
    workspace_id  TEXT NOT NULL DEFAULT 'default',
    harness_slug  TEXT NOT NULL,
    run_id        TEXT NOT NULL,
    seq           INT NOT NULL,
    chunk_data    TEXT NOT NULL,
    ts            BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, run_id, seq)
  );
  CREATE INDEX IF NOT EXISTS harness_run_chunks_run_idx
    ON harness_shared.harness_run_chunks (workspace_id, harness_slug, run_id, seq);
`;

/**
 * Append one chunk to a run's chunk log + pg_notify the per-run channel.
 * The notify payload is the chunk's seq number — subscribers can
 * SELECT WHERE seq > lastSeen to fetch only new chunks.
 *
 * Best-effort: errors are swallowed so the orchestrator keeps running
 * even if PG hiccups mid-stream. Callers should serialize calls per
 * runId (assign seq monotonically + chain Promises) to guarantee insert
 * order matches stream order.
 */
export async function appendChunkPg(
  ctx: RunChunksPgContext,
  runId: string,
  seq: number,
  chunkData: string,
): Promise<void> {
  const now = Date.now();
  try {
    await ctx.pg`
      INSERT INTO harness_shared.harness_run_chunks
        (workspace_id, harness_slug, run_id, seq, chunk_data, ts)
      VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, ${runId}, ${seq},
              ${chunkData}, ${now})
      ON CONFLICT (workspace_id, harness_slug, run_id, seq) DO NOTHING
    `;
    // payload is just the seq; subscribers fetch by run_id + seq > N
    await ctx.pg`
      SELECT pg_notify(${'run:' + runId}, ${String(seq)})
    `;
  } catch {
    /* best-effort streaming; row state is canonical only after the
     * final harness_run_output INSERT (Phase 4 ingest-at-exit) */
  }
}

export interface RunChunkRow {
  seq: number;
  chunkData: string;
  ts: number;
}

/**
 * Read chunks for a run starting after `fromSeq`. Operator's SSE
 * endpoint calls this on every `LISTEN run:<runId>` notification.
 */
export async function readChunksAfterPg(
  ctx: RunChunksPgContext,
  runId: string,
  fromSeq: number,
): Promise<RunChunkRow[]> {
  const rows = await ctx.pg<{
    seq: number;
    chunk_data: string;
    ts: number | bigint;
  }[]>`
    SELECT seq, chunk_data, ts
      FROM harness_shared.harness_run_chunks
     WHERE workspace_id = ${ctx.workspaceId}
       AND harness_slug = ${ctx.harnessSlug}
       AND run_id       = ${runId}
       AND seq          > ${fromSeq}
     ORDER BY seq
  `;
  return rows.map((r) => ({
    seq: r.seq,
    chunkData: r.chunk_data,
    ts: typeof r.ts === 'bigint' ? Number(r.ts) : r.ts,
  }));
}

/**
 * Delete all chunks for a run. Called after harness_run_output is
 * finalized (the row holds the full body; chunks become redundant).
 * Operator-side cleanup; orchestrator just appends.
 */
export async function pruneChunksPg(
  ctx: RunChunksPgContext,
  runId: string,
): Promise<number> {
  const rows = await ctx.pg<{ seq: number }[]>`
    DELETE FROM harness_shared.harness_run_chunks
     WHERE workspace_id = ${ctx.workspaceId}
       AND harness_slug = ${ctx.harnessSlug}
       AND run_id       = ${runId}
    RETURNING seq
  `;
  return rows.length;
}
