/**
 * Worker execution-engine parity gate (own-tui-full-divorce-2026-08-24 P-011).
 *
 * The candidate is Papercusp's operator-owned loop; the baseline is the exact
 * same worker prompt through `omp -p`. Runs are paired by harness + SHA-256
 * task-prompt hash (the pre-runtime-tail inline canary prompt when supplied) and,
 * for repeated prompts, newest-to-newest. A pair is assessable
 * only when both paths were launched with the same requested model. The gate is deliberately
 * fail-closed: missing samples, missing prices, or an MCP-free corpus HOLD;
 * measured regressions RED; only a fully assessable cohort can turn GREEN.
 *
 * Inputs reuse three canonical ledgers rather than introducing another table:
 *   - harness_run_output: exit code + the bounded papercusp.run_meta stream summary
 *   - agent_usage_samples: one run-attributed USD cost/model sample
 *   - tool_invocations: run-attributed MCP calls and their settled status
 */
import type { OrchestratorPg } from '@papercusp/orchestrator';

export type WorkerParityEngine = 'omp' | 'loop';

export interface WorkerParityRun {
  runId: string;
  harnessSlug: string;
  promptHash: string;
  featureId: string | null;
  model: string | null;
  engine: WorkerParityEngine;
  exitCode: number;
  endedAt: number;
  streamOk: boolean;
  costUsd: number | null;
  costSampleCount: number;
  pricedSampleCount: number;
  mcpCalls: number;
  mcpFailures: number;
  mcpToolNames: string[];
}

export interface WorkerParityThresholds {
  minPairedTasks: number;
  minTaskSuccessRate: number;
  maxTaskSuccessRateDeficit: number;
  maxCostPerTaskRatio: number;
  minStreamFidelityRate: number;
  minMcpCallsPerPath: number;
  maxMcpFailureRateDelta: number;
}

export const DEFAULT_WORKER_PARITY_THRESHOLDS: WorkerParityThresholds = {
  minPairedTasks: 20,
  minTaskSuccessRate: 0.9,
  maxTaskSuccessRateDeficit: 0.02,
  maxCostPerTaskRatio: 1.1,
  minStreamFidelityRate: 0.99,
  minMcpCallsPerPath: 10,
  maxMcpFailureRateDelta: 0.02,
};

export interface WorkerParityPathMetrics {
  engine: WorkerParityEngine;
  tasks: number;
  taskSuccesses: number;
  /** exitCode=0 AND a valid terminal stream, divided by paired tasks. */
  taskSuccessRate: number | null;
  pricedTasks: number;
  /** Sum of real/estimated run-attributed USD divided by every paired task. */
  costPerTaskUsd: number | null;
  streamFaithfulTasks: number;
  streamFidelityRate: number | null;
  mcpCalls: number;
  mcpFailures: number;
  mcpFailureRate: number | null;
  mcpToolNames: string[];
}

export interface WorkerParityGateResult {
  schemaVersion: 'worker-parity-gate-v1';
  verdict: 'green' | 'hold' | 'red';
  workerFlipAllowed: boolean;
  pairedTasks: number;
  modelMismatchPairs: number;
  rawRuns: number;
  unpairedRuns: { omp: number; loop: number };
  thresholds: WorkerParityThresholds;
  byEngine: Record<WorkerParityEngine, WorkerParityPathMetrics>;
  deltas: {
    taskSuccessRate: number | null;
    costPerTaskRatio: number | null;
    streamFidelityRate: number | null;
    mcpFailureRate: number | null;
    missingBaselineTools: string[];
  };
  reasons: string[];
}

interface WorkerParityPair {
  omp: WorkerParityRun;
  loop: WorkerParityRun;
}

const finiteNumber = (value: unknown): number | null => {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : null;
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * Bounded read of parity-qualified worker runs. Only the small run_meta summary
 * crosses the SQL boundary; raw prompt/output/JSONL bodies never leave PG.
 */
export async function readWorkerParityRuns(
  pg: OrchestratorPg,
  args: {
    workspaceId: string;
    sinceMs: number;
    harnessSlug?: string;
    limit?: number;
  },
): Promise<WorkerParityRun[]> {
  const harness = args.harnessSlug ?? null;
  const limit = Math.max(1, Math.min(args.limit ?? 500, 2_000));
  const rows = await pg<Array<{
    run_id: string;
    harness_slug: string;
    prompt_hash: string;
    feature_id: string | null;
    requested_model: string | null;
    engine: string;
    exit_code: number | null;
    ended_at: number | bigint;
    stream_ok: boolean;
    cost_usd: number | string | null;
    cost_sample_count: number | bigint;
    priced_sample_count: number | bigint;
    mcp_calls: number | bigint;
    mcp_failures: number | bigint;
    mcp_tool_names: string[] | null;
  }>>`
    WITH recent AS (
      SELECT run_id, harness_slug, exit_code, ended_at,
             -- finalizeInvocation deliberately newline-terminates every JSONL
             -- event, including papercusp.run_meta. PostgreSQL's one-argument
             -- rtrim removes spaces only, so it would leave that final newline
             -- and split_part(reverse(...), newline, 1) would select an empty
             -- segment. Trim the JSONL line-ending whitespace explicitly before
             -- taking the terminal event.
             reverse(split_part(
               reverse(rtrim(jsonl_body, chr(10) || chr(13) || chr(9) || ' ')),
               chr(10),
               1
             )) AS meta_line
        FROM harness_shared.harness_run_output
       WHERE workspace_id = ${args.workspaceId}
         AND role = 'worker'
         AND ended_at >= ${args.sinceMs}
         AND (${harness}::text IS NULL OR harness_slug = ${harness})
         AND (
           jsonl_body LIKE '%"backend":"owned-loop"%'
           OR jsonl_body LIKE '%"backend":"omp"%'
         )
    ), parsed AS (
      SELECT recent.*,
             CASE
               WHEN meta_line LIKE '{"type":"papercusp.run_meta"%'
                 THEN meta_line::jsonb
               ELSE '{}'::jsonb
             END AS meta
        FROM recent
    ), qualified_unbounded AS (
      SELECT run_id, harness_slug, exit_code, ended_at, meta,
             CASE
               WHEN meta->>'backend' = 'owned-loop' THEN 'loop'
               WHEN meta->>'backend' = 'omp' THEN 'omp'
               ELSE NULL
             END AS engine
        FROM parsed
       WHERE meta->>'schemaVersion' = 'worker-parity-v1'
         AND meta->'stream'->>'schemaVersion' = 'invocation-stream-summary-v1'
         AND nullif(meta->>'promptHash', '') IS NOT NULL
    ), qualified AS (
      SELECT *
        FROM qualified_unbounded
       WHERE engine IS NOT NULL
       ORDER BY ended_at DESC
       LIMIT ${limit}
    ), usage_by_run AS (
      SELECT u.harness_slug, u.run_id,
             count(*)::int AS cost_sample_count,
             count(u.cost_usd)::int AS priced_sample_count,
             max(u.cost_usd)::float8 AS cost_usd
        FROM harness_shared.agent_usage_samples u
        JOIN qualified q
          ON q.harness_slug = u.harness_slug AND q.run_id = u.run_id
       WHERE u.workspace_id = ${args.workspaceId}
         AND u.tool_name IS NULL
       GROUP BY u.harness_slug, u.run_id
    ), calls_by_run AS (
      SELECT t.harness_slug, t.run_id,
             count(t.id)::int AS mcp_calls,
             count(t.id) FILTER (WHERE t.status NOT IN ('ok', 'replayed'))::int AS mcp_failures,
             coalesce(
               array_agg(DISTINCT t.tool_name ORDER BY t.tool_name)
                 FILTER (WHERE t.tool_name IS NOT NULL AND t.status IN ('ok', 'replayed')),
               ARRAY[]::text[]
             ) AS mcp_tool_names
        FROM harness_shared.tool_invocations t
        JOIN qualified q
          ON q.harness_slug = t.harness_slug AND q.run_id = t.run_id
       WHERE t.workspace_id = ${args.workspaceId}
       GROUP BY t.harness_slug, t.run_id
    )
    SELECT q.run_id, q.harness_slug,
           q.meta->>'promptHash' AS prompt_hash,
           nullif(q.meta->>'featureId', '') AS feature_id,
           coalesce(
             nullif(q.meta->>'requestedModel', ''),
             nullif(q.meta->>'model', '')
           ) AS requested_model,
           q.engine,
           coalesce(q.exit_code, -1)::int AS exit_code,
           q.ended_at,
           coalesce((q.meta->'stream'->>'ok')::boolean, false) AS stream_ok,
           CASE WHEN u.cost_sample_count = 1 AND u.priced_sample_count = 1 THEN u.cost_usd ELSE NULL END AS cost_usd,
           coalesce(u.cost_sample_count, 0)::int AS cost_sample_count,
           coalesce(u.priced_sample_count, 0)::int AS priced_sample_count,
           coalesce(c.mcp_calls, 0)::int AS mcp_calls,
           coalesce(c.mcp_failures, 0)::int AS mcp_failures,
           coalesce(c.mcp_tool_names, ARRAY[]::text[]) AS mcp_tool_names
      FROM qualified q
      LEFT JOIN usage_by_run u
        ON u.harness_slug = q.harness_slug AND u.run_id = q.run_id
      LEFT JOIN calls_by_run c
        ON c.harness_slug = q.harness_slug AND c.run_id = q.run_id
     ORDER BY q.ended_at DESC
  `;

  const out: WorkerParityRun[] = [];
  for (const row of rows) {
    if (row.engine !== 'omp' && row.engine !== 'loop') continue;
    const endedAt = finiteNumber(row.ended_at);
    if (endedAt === null) continue;
    out.push({
      runId: row.run_id,
      harnessSlug: row.harness_slug,
      promptHash: row.prompt_hash,
      featureId: row.feature_id ?? null,
      // Pair on the requested model stamped by the shared invoke() selector.
      // OMP reports an expanded provider model while the owned port may only
      // know the configured alias; preferring usage_model would reject the
      // same launch choice merely because the two transports name it differently.
      model: row.requested_model ?? null,
      engine: row.engine,
      exitCode: finiteNumber(row.exit_code) ?? -1,
      endedAt,
      streamOk: row.stream_ok === true,
      costUsd: row.cost_usd === null ? null : finiteNumber(row.cost_usd),
      costSampleCount: finiteNumber(row.cost_sample_count) ?? 0,
      pricedSampleCount: finiteNumber(row.priced_sample_count) ?? 0,
      mcpCalls: finiteNumber(row.mcp_calls) ?? 0,
      mcpFailures: finiteNumber(row.mcp_failures) ?? 0,
      mcpToolNames: stringArray(row.mcp_tool_names),
    });
  }
  return out;
}

function pairRuns(rows: readonly WorkerParityRun[]): {
  pairs: WorkerParityPair[];
  modelMismatchPairs: number;
  unpairedRuns: { omp: number; loop: number };
} {
  const groups = new Map<string, Record<WorkerParityEngine, WorkerParityRun[]>>();
  for (const row of rows) {
    const key = `${row.harnessSlug}\u0000${row.promptHash}`;
    const group = groups.get(key) ?? { omp: [], loop: [] };
    group[row.engine].push(row);
    groups.set(key, group);
  }

  const pairs: WorkerParityPair[] = [];
  let modelMismatchPairs = 0;
  let unpairedOmp = 0;
  let unpairedLoop = 0;
  for (const group of groups.values()) {
    group.omp.sort((a, b) => b.endedAt - a.endedAt || b.runId.localeCompare(a.runId));
    group.loop.sort((a, b) => b.endedAt - a.endedAt || b.runId.localeCompare(a.runId));
    const n = Math.min(group.omp.length, group.loop.length);
    for (let i = 0; i < n; i += 1) {
      const omp = group.omp[i];
      const loop = group.loop[i];
      if (!omp.model || !loop.model || omp.model !== loop.model) {
        modelMismatchPairs += 1;
        continue;
      }
      pairs.push({ omp, loop });
    }
    unpairedOmp += group.omp.length - n;
    unpairedLoop += group.loop.length - n;
  }
  return { pairs, modelMismatchPairs, unpairedRuns: { omp: unpairedOmp, loop: unpairedLoop } };
}

function summarizePath(engine: WorkerParityEngine, rows: readonly WorkerParityRun[]): WorkerParityPathMetrics {
  const taskSuccesses = rows.filter((row) => row.exitCode === 0 && row.streamOk).length;
  const streamFaithfulTasks = rows.filter((row) => row.streamOk).length;
  const pricedTasks = rows.filter(
    (row) => row.costSampleCount === 1 && row.pricedSampleCount === 1 && row.costUsd !== null,
  ).length;
  const totalCost = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const mcpCalls = rows.reduce((sum, row) => sum + row.mcpCalls, 0);
  const mcpFailures = rows.reduce((sum, row) => sum + row.mcpFailures, 0);
  const toolNames = new Set(rows.flatMap((row) => row.mcpToolNames));
  return {
    engine,
    tasks: rows.length,
    taskSuccesses,
    taskSuccessRate: rows.length === 0 ? null : taskSuccesses / rows.length,
    pricedTasks,
    costPerTaskUsd: rows.length > 0 && pricedTasks === rows.length ? totalCost / rows.length : null,
    streamFaithfulTasks,
    streamFidelityRate: rows.length === 0 ? null : streamFaithfulTasks / rows.length,
    mcpCalls,
    mcpFailures,
    mcpFailureRate: mcpCalls === 0 ? null : mcpFailures / mcpCalls,
    mcpToolNames: [...toolNames].sort(),
  };
}

const delta = (candidate: number | null, baseline: number | null): number | null =>
  candidate === null || baseline === null ? null : candidate - baseline;

function costRatio(candidate: number | null, baseline: number | null): number | null {
  if (candidate === null || baseline === null) return null;
  if (baseline === 0) return candidate === 0 ? 1 : Number.POSITIVE_INFINITY;
  return candidate / baseline;
}

export function decideWorkerParityGate(
  rows: readonly WorkerParityRun[],
  thresholds: WorkerParityThresholds = DEFAULT_WORKER_PARITY_THRESHOLDS,
): WorkerParityGateResult {
  const { pairs, modelMismatchPairs, unpairedRuns } = pairRuns(rows);
  const ompRows = pairs.map((pair) => pair.omp);
  const loopRows = pairs.map((pair) => pair.loop);
  const omp = summarizePath('omp', ompRows);
  const loop = summarizePath('loop', loopRows);
  const missingBaselineTools = omp.mcpToolNames.filter((name) => !loop.mcpToolNames.includes(name));
  const deltas = {
    taskSuccessRate: delta(loop.taskSuccessRate, omp.taskSuccessRate),
    costPerTaskRatio: costRatio(loop.costPerTaskUsd, omp.costPerTaskUsd),
    streamFidelityRate: delta(loop.streamFidelityRate, omp.streamFidelityRate),
    mcpFailureRate: delta(loop.mcpFailureRate, omp.mcpFailureRate),
    missingBaselineTools,
  };
  const reasons: string[] = [];

  if (pairs.length < thresholds.minPairedTasks) {
    reasons.push(
      `insufficient same-prompt/same-model pairs: ${pairs.length}/${thresholds.minPairedTasks}`,
    );
    if (modelMismatchPairs > 0) reasons.push(`${modelMismatchPairs} prompt pair(s) excluded for model mismatch`);
    return {
      schemaVersion: 'worker-parity-gate-v1',
      verdict: 'hold',
      workerFlipAllowed: false,
      pairedTasks: pairs.length,
      modelMismatchPairs,
      rawRuns: rows.length,
      unpairedRuns,
      thresholds,
      byEngine: { omp, loop },
      deltas,
      reasons,
    };
  }

  if (omp.costPerTaskUsd === null || loop.costPerTaskUsd === null) {
    reasons.push(
      `cost attribution incomplete: omp ${omp.pricedTasks}/${omp.tasks}, loop ${loop.pricedTasks}/${loop.tasks}`,
    );
  }
  if (omp.mcpCalls < thresholds.minMcpCallsPerPath || loop.mcpCalls < thresholds.minMcpCallsPerPath) {
    reasons.push(
      `MCP corpus too small: omp ${omp.mcpCalls}/${thresholds.minMcpCallsPerPath}, loop ${loop.mcpCalls}/${thresholds.minMcpCallsPerPath}`,
    );
  }
  if (reasons.length > 0) {
    return {
      schemaVersion: 'worker-parity-gate-v1',
      verdict: 'hold',
      workerFlipAllowed: false,
      pairedTasks: pairs.length,
      modelMismatchPairs,
      rawRuns: rows.length,
      unpairedRuns,
      thresholds,
      byEngine: { omp, loop },
      deltas,
      reasons,
    };
  }

  if ((loop.taskSuccessRate ?? 0) < thresholds.minTaskSuccessRate) {
    reasons.push(
      `loop task-success ${(loop.taskSuccessRate ?? 0).toFixed(3)} is below absolute floor ${thresholds.minTaskSuccessRate}`,
    );
  }
  if ((deltas.taskSuccessRate ?? Number.NEGATIVE_INFINITY) < -thresholds.maxTaskSuccessRateDeficit) {
    reasons.push(
      `loop task-success deficit ${Math.abs(deltas.taskSuccessRate as number).toFixed(3)} exceeds ${thresholds.maxTaskSuccessRateDeficit}`,
    );
  }
  if ((deltas.costPerTaskRatio ?? Number.POSITIVE_INFINITY) > thresholds.maxCostPerTaskRatio) {
    reasons.push(
      `loop cost/task ratio ${(deltas.costPerTaskRatio as number).toFixed(3)} exceeds ${thresholds.maxCostPerTaskRatio}`,
    );
  }
  if ((loop.streamFidelityRate ?? 0) < thresholds.minStreamFidelityRate) {
    reasons.push(
      `loop stream-fidelity ${(loop.streamFidelityRate ?? 0).toFixed(3)} is below ${thresholds.minStreamFidelityRate}`,
    );
  }
  if ((deltas.mcpFailureRate ?? Number.POSITIVE_INFINITY) > thresholds.maxMcpFailureRateDelta) {
    reasons.push(
      `loop MCP failure-rate delta ${(deltas.mcpFailureRate as number).toFixed(3)} exceeds ${thresholds.maxMcpFailureRateDelta}`,
    );
  }
  if (missingBaselineTools.length > 0) {
    reasons.push(`loop never completed baseline MCP tool(s): ${missingBaselineTools.join(', ')}`);
  }

  const verdict = reasons.length === 0 ? 'green' : 'red';
  if (verdict === 'green') {
    reasons.push(
      `green across ${pairs.length} paired tasks: task success, cost/task, stream fidelity, and MCP compatibility all meet v1 thresholds`,
    );
  }
  return {
    schemaVersion: 'worker-parity-gate-v1',
    verdict,
    workerFlipAllowed: verdict === 'green',
    pairedTasks: pairs.length,
    modelMismatchPairs,
    rawRuns: rows.length,
    unpairedRuns,
    thresholds,
    byEngine: { omp, loop },
    deltas,
    reasons,
  };
}
