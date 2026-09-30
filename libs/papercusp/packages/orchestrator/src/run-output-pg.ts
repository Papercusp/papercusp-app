/**
 * Postgres-backed subprocess run output — Phase 4 of the orchestrator → PG arc.
 *
 * Live runs still stream to disk (<logDir>/<runId>.{jsonl,out,err}) for
 * `tail -f` debugging and the operator UI's live LogView. **At subprocess
 * exit**, when ctx.pg is set, the orchestrator reads all three files and
 * INSERTs a single row into `harness_shared.harness_run_output` — that row
 * is canonical for completed runs.
 *
 * The .jsonl/.out/.err files can then be retained or pruned per
 * config.logRetention without losing replayability — the operator's
 * post-hoc LogView reads from PG.
 *
 * Schema:
 *
 *   CREATE TABLE harness_shared.harness_run_output (
 *     workspace_id TEXT NOT NULL DEFAULT 'default',
 *     harness_slug TEXT NOT NULL,
 *     run_id       TEXT NOT NULL,
 *     role         TEXT,
 *     prompt_body  TEXT NOT NULL DEFAULT '',
 *     jsonl_body   TEXT NOT NULL DEFAULT '',
 *     out_body     TEXT NOT NULL DEFAULT '',
 *     err_body     TEXT NOT NULL DEFAULT '',
 *     exit_code    INT,
 *     duration_ms  INT,
 *     started_at   BIGINT NOT NULL,
 *     ended_at     BIGINT NOT NULL,
 *     PRIMARY KEY (workspace_id, harness_slug, run_id)
 *   );
 *
 * CHARS_LIMIT clamps each body to a sane maximum (10 MB chars). Anything
 * longer is truncated with a tail marker — pathological streams shouldn't
 * cap the table.
 */
import type { OrchestratorPg } from './invoke';

const CHARS_LIMIT = 10 * 1024 * 1024;

export interface RunOutputPgContext {
  pg: OrchestratorPg;
  workspaceId: string;
  harnessSlug: string;
}

export interface RunOutputRow {
  runId: string;
  role: string | null;
  promptBody: string;
  jsonlBody: string;
  outBody: string;
  errBody: string;
  exitCode: number;
  durationMs: number;
  startedAt: number;
  endedAt: number;
}

export const RUN_OUTPUT_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_run_output (
    workspace_id TEXT NOT NULL DEFAULT 'default',
    harness_slug TEXT NOT NULL,
    run_id       TEXT NOT NULL,
    role         TEXT,
    prompt_body  TEXT NOT NULL DEFAULT '',
    jsonl_body   TEXT NOT NULL DEFAULT '',
    out_body     TEXT NOT NULL DEFAULT '',
    err_body     TEXT NOT NULL DEFAULT '',
    exit_code    INT,
    duration_ms  INT,
    started_at   BIGINT NOT NULL,
    ended_at     BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, run_id)
  );
  -- Idempotent column add for tables created before Phase 5.
  ALTER TABLE harness_shared.harness_run_output
    ADD COLUMN IF NOT EXISTS prompt_body TEXT NOT NULL DEFAULT '';
  CREATE INDEX IF NOT EXISTS harness_run_output_recent_idx
    ON harness_shared.harness_run_output (workspace_id, harness_slug, ended_at DESC);
`;

function clamp(body: string): string {
  if (body.length <= CHARS_LIMIT) return body;
  return (
    body.slice(0, CHARS_LIMIT) +
    `\n\n... [truncated: original ${body.length} chars, kept ${CHARS_LIMIT}]\n`
  );
}

/**
 * UPSERT a single completed run row. ON CONFLICT update — same run_id
 * shouldn't repeat in practice but the upsert handles harness re-runs
 * with the same run id (e.g. test fixtures).
 */
export async function recordRunOutputPg(
  ctx: RunOutputPgContext,
  row: RunOutputRow,
): Promise<void> {
  await ctx.pg`
    INSERT INTO harness_shared.harness_run_output
      (workspace_id, harness_slug, run_id, role,
       prompt_body, jsonl_body, out_body, err_body,
       exit_code, duration_ms, started_at, ended_at)
    VALUES (
      ${ctx.workspaceId}, ${ctx.harnessSlug}, ${row.runId}, ${row.role},
      ${clamp(row.promptBody)}, ${clamp(row.jsonlBody)},
      ${clamp(row.outBody)}, ${clamp(row.errBody)},
      ${row.exitCode}, ${row.durationMs}, ${row.startedAt}, ${row.endedAt}
    )
    ON CONFLICT (workspace_id, harness_slug, run_id) DO UPDATE SET
      role        = EXCLUDED.role,
      prompt_body = EXCLUDED.prompt_body,
      jsonl_body  = EXCLUDED.jsonl_body,
      out_body    = EXCLUDED.out_body,
      err_body    = EXCLUDED.err_body,
      exit_code   = EXCLUDED.exit_code,
      duration_ms = EXCLUDED.duration_ms,
      ended_at    = EXCLUDED.ended_at
  `;
}

/** Fetch a single run's recorded output. Returns null when absent. */
export async function readRunOutputPg(
  ctx: RunOutputPgContext,
  runId: string,
): Promise<RunOutputRow | null> {
  const rows = await ctx.pg<{
    run_id: string;
    role: string | null;
    prompt_body: string;
    jsonl_body: string;
    out_body: string;
    err_body: string;
    exit_code: number | null;
    duration_ms: number | null;
    started_at: number | bigint;
    ended_at: number | bigint;
  }[]>`
    SELECT run_id, role, prompt_body, jsonl_body, out_body, err_body,
           exit_code, duration_ms, started_at, ended_at
      FROM harness_shared.harness_run_output
     WHERE workspace_id = ${ctx.workspaceId}
       AND harness_slug = ${ctx.harnessSlug}
       AND run_id       = ${runId}
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    runId: r.run_id,
    role: r.role,
    promptBody: r.prompt_body ?? '',
    jsonlBody: r.jsonl_body,
    outBody: r.out_body,
    errBody: r.err_body,
    exitCode: r.exit_code ?? 0,
    durationMs: r.duration_ms ?? 0,
    startedAt: typeof r.started_at === 'bigint' ? Number(r.started_at) : r.started_at,
    endedAt: typeof r.ended_at === 'bigint' ? Number(r.ended_at) : r.ended_at,
  };
}
