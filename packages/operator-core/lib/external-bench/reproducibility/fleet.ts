/**
 * L2 (Hive-layer) reproducibility (BRIEF 8 / P-010 EXTEND, Phase 5 / D-010). Where
 * emit.ts records the per-task L1 unit, this records:
 *   - the fleet run (one arm draining a whole BACKLOG — mirrors P-011's locked
 *     `FleetRunSummary`); the hive − queen-ablated delta is the Queen's value.
 *   - the coordination TRACE (`CoordEvent[]`) — the MAST-convertible input P-026
 *     scores: normal actions (spawn/handoff/claim/complete/…) the judge reads +
 *     the mechanical failure signals (duplicate_completion / orphaned_claim /
 *     stranded_item / claim_conflict / superseded_work / rework) that
 *     substrateSignalRates counts objectively into duplication/breakdown/
 *     misalignment rates.
 *
 * Same disciplines as L1: the prereg firewall (a fleet run must run under a
 * registered config), a DETERMINISTIC fleetRunId so re-emit is idempotent, and
 * the camelCase↔snake_case seam owned here (reads return P-011's FleetRunSummary).
 */
import { createHash } from 'node:crypto';
import { DEFAULT_PRICE_TABLE, type CoordEvent, type CoordTrace, type FleetRunSummary } from '@papercusp/bench-metrics';
import { notifySyncInvalidate } from '../../sync-sse';
import { resolveDb, type DbScope } from './db';

/** Deterministic fleet-run id = sha256(runId ∥ suite ∥ backlogId ∥ arm ∥ seed). */
export function fleetRunIdFor(
  runId: string,
  suite: string,
  backlogId: string,
  arm: string,
  seed: number,
): string {
  return createHash('sha256')
    .update([runId, suite, backlogId, arm, String(seed)].join(' '), 'utf8')
    .digest('hex');
}

export interface FleetRunInput {
  /** The locked FleetRunSummary (runId, suite, arm, tasks, resolved, wallClockMs, costUsd, tokensTotal, tasksZeroHumanGate, peakConcurrency?). */
  summary: FleetRunSummary;
  /** Must match a benchmark_prereg row (tune-to-test firewall). */
  preregHash: string;
  /** The task SET handed to the arm. */
  backlogId: string;
  /** Independent whole-backlog attempt ordinal (≥3 distinct per arm). Default 0. */
  seed?: number;
  modelId: string;
  harnessVersion: string;
  /** Price table version cost_usd was summed under (provenance). Default price-table-v1. */
  priceTableVersion?: string;
  /** L3 value-capture (optional). */
  value?: { valueCapturedUsd?: number | null; valueAvailableUsd?: number | null; budgetUsd?: number | null };
  /** Iso-budget cap for the whole run (null = uncapped). */
  budgetTokens?: number | null;
  provenance?: {
    configSnapshot?: Record<string, unknown> | null;
    envFingerprint?: Record<string, unknown> | null;
    armMeta?: Record<string, unknown> | null;
  };
  /**
   * The coordination trace. If provided, it REPLACES this fleet run's events
   * (idempotent whole-trace emit). Omit to leave events untouched (e.g. when they
   * were streamed live via emitCoordEvents during the run).
   */
  coordEvents?: readonly CoordEvent[];
}

const jb = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/**
 * Persist one fleet run (+ optionally its whole coordination trace) atomically.
 * Throws if no benchmark_prereg matches `preregHash` (firewall). UPSERTs on the
 * deterministic fleetRunId so re-emit is idempotent.
 */
export async function emitFleetRun(
  input: FleetRunInput,
  opts: DbScope = {},
): Promise<{ fleetRunId: string; runId: string }> {
  const { sql, ws } = resolveDb(opts);
  const s = input.summary;
  const seed = input.seed ?? 0;
  const priceTableVersion = input.priceTableVersion ?? DEFAULT_PRICE_TABLE.version;
  const fleetRunId = fleetRunIdFor(s.runId, s.suite, input.backlogId, s.arm, seed);
  const prov = input.provenance ?? {};
  const val = input.value ?? {};

  await sql.begin(async (tx) => {
    const pre = await tx`
      SELECT 1 FROM harness_shared.benchmark_prereg
       WHERE prereg_hash = ${input.preregHash} AND workspace_id = ${ws} LIMIT 1
    `;
    if (pre.length === 0) {
      throw new Error(
        `emitFleetRun: no benchmark_prereg for hash "${input.preregHash}" (workspace ${ws}); ` +
          `pre-register the run config before emitting (tune-to-test firewall)`,
      );
    }

    await tx`
      INSERT INTO harness_shared.benchmark_fleet_run
        (fleet_run_id, run_id, workspace_id, prereg_hash, suite, arm, backlog_id, seed,
         tasks, resolved, tasks_zero_human_gate, wall_clock_ms, tokens_total, cost_usd, price_table_version,
         peak_concurrency, value_captured_usd, value_available_usd, budget_usd, budget_tokens,
         model_id, harness_version, config_snapshot, env_fingerprint, arm_meta)
      VALUES
        (${fleetRunId}, ${s.runId}, ${ws}, ${input.preregHash}, ${s.suite}, ${s.arm}, ${input.backlogId}, ${seed},
         ${s.tasks}, ${s.resolved}, ${s.tasksZeroHumanGate}, ${s.wallClockMs}, ${s.tokensTotal}, ${s.costUsd}, ${priceTableVersion},
         ${s.peakConcurrency ?? null}, ${val.valueCapturedUsd ?? null}, ${val.valueAvailableUsd ?? null}, ${val.budgetUsd ?? null}, ${input.budgetTokens ?? null},
         ${input.modelId}, ${input.harnessVersion}, ${jb(prov.configSnapshot)}::text::jsonb, ${jb(prov.envFingerprint)}::text::jsonb, ${jb(prov.armMeta)}::text::jsonb)
      ON CONFLICT (fleet_run_id) DO UPDATE SET
        run_id = EXCLUDED.run_id, prereg_hash = EXCLUDED.prereg_hash, suite = EXCLUDED.suite, arm = EXCLUDED.arm,
        backlog_id = EXCLUDED.backlog_id, seed = EXCLUDED.seed, tasks = EXCLUDED.tasks, resolved = EXCLUDED.resolved,
        tasks_zero_human_gate = EXCLUDED.tasks_zero_human_gate, wall_clock_ms = EXCLUDED.wall_clock_ms,
        tokens_total = EXCLUDED.tokens_total, cost_usd = EXCLUDED.cost_usd, price_table_version = EXCLUDED.price_table_version,
        peak_concurrency = EXCLUDED.peak_concurrency, value_captured_usd = EXCLUDED.value_captured_usd,
        value_available_usd = EXCLUDED.value_available_usd, budget_usd = EXCLUDED.budget_usd, budget_tokens = EXCLUDED.budget_tokens,
        model_id = EXCLUDED.model_id, harness_version = EXCLUDED.harness_version, config_snapshot = EXCLUDED.config_snapshot,
        env_fingerprint = EXCLUDED.env_fingerprint, arm_meta = EXCLUDED.arm_meta
    `;

    if (input.coordEvents !== undefined) {
      await tx`DELETE FROM harness_shared.benchmark_coord_event WHERE fleet_run_id = ${fleetRunId} AND workspace_id = ${ws}`;
      if (input.coordEvents.length > 0) {
        const rows = input.coordEvents.map((e, i) => ({
          fleet_run_id: fleetRunId,
          run_id: s.runId,
          workspace_id: ws,
          seq: i,
          ts: e.ts ?? null,
          kind: e.kind,
          agent: e.agent ?? null,
          task_id: e.taskId ?? null,
          detail: e.detail ?? null,
        }));
        await tx`INSERT INTO harness_shared.benchmark_coord_event ${tx(rows, 'fleet_run_id', 'run_id', 'workspace_id', 'seq', 'ts', 'kind', 'agent', 'task_id', 'detail')}`;
      }
    }
  });

  await notifySyncInvalidate('evals.fleet', { runId: s.runId });
  await notifySyncInvalidate('evals.suites', {});
  if (input.coordEvents !== undefined) await notifySyncInvalidate('evals.coordTrace', { fleetRunId });
  return { fleetRunId, runId: s.runId };
}

/**
 * Append coordination events to a fleet run's trace (live streaming during a run).
 * Seq continues after the current max. Use this OR emitFleetRun({coordEvents}) —
 * not both for the same events.
 */
export async function emitCoordEvents(
  fleetRunId: string,
  runId: string,
  events: readonly CoordEvent[],
  opts: DbScope = {},
): Promise<{ inserted: number }> {
  if (events.length === 0) return { inserted: 0 };
  const { sql, ws } = resolveDb(opts);
  const max = await sql<{ next: number }[]>`
    SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM harness_shared.benchmark_coord_event
     WHERE fleet_run_id = ${fleetRunId} AND workspace_id = ${ws}
  `;
  const start = Number(max[0]?.next ?? 0);
  const rows = events.map((e, i) => ({
    fleet_run_id: fleetRunId,
    run_id: runId,
    workspace_id: ws,
    seq: start + i,
    ts: e.ts ?? null,
    kind: e.kind,
    agent: e.agent ?? null,
    task_id: e.taskId ?? null,
    detail: e.detail ?? null,
  }));
  await sql`INSERT INTO harness_shared.benchmark_coord_event ${sql(rows, 'fleet_run_id', 'run_id', 'workspace_id', 'seq', 'ts', 'kind', 'agent', 'task_id', 'detail')}`;
  await notifySyncInvalidate('evals.coordTrace', { fleetRunId });
  return { inserted: rows.length };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToFleetSummary(r: any): FleetRunSummary {
  return {
    runId: r.run_id,
    suite: r.suite,
    arm: r.arm,
    tasks: Number(r.tasks),
    resolved: Number(r.resolved),
    wallClockMs: Number(r.wall_clock_ms),
    costUsd: Number(r.cost_usd),
    tokensTotal: Number(r.tokens_total),
    tasksZeroHumanGate: Number(r.tasks_zero_human_gate),
    peakConcurrency: r.peak_concurrency == null ? null : Number(r.peak_concurrency),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Fleet-run summaries for a run (all arms × seeds) as P-011's FleetRunSummary[]. */
export async function listFleetRuns(opts: { runId?: string } & DbScope = {}): Promise<FleetRunSummary[]> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql`
    SELECT * FROM harness_shared.benchmark_fleet_run
     WHERE workspace_id = ${ws} ${opts.runId ? sql`AND run_id = ${opts.runId}` : sql``}
     ORDER BY suite, arm, seed
  `;
  return rows.map(rowToFleetSummary);
}

/** The full fleet-run record (summary + identity + L3 value + provenance) — for the publication export. */
export interface FleetRunRecord extends FleetRunSummary {
  fleetRunId: string;
  preregHash: string;
  backlogId: string;
  seed: number;
  priceTableVersion: string;
  valueCapturedUsd: number | null;
  valueAvailableUsd: number | null;
  budgetUsd: number | null;
  budgetTokens: number | null;
  modelId: string;
  harnessVersion: string;
  configSnapshot: Record<string, unknown> | null;
  envFingerprint: Record<string, unknown> | null;
  armMeta: Record<string, unknown> | null;
  createdAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function asJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function rowToFleetRecord(r: any): FleetRunRecord {
  return {
    ...rowToFleetSummary(r),
    fleetRunId: r.fleet_run_id,
    preregHash: r.prereg_hash,
    backlogId: r.backlog_id,
    seed: Number(r.seed),
    priceTableVersion: r.price_table_version,
    valueCapturedUsd: r.value_captured_usd == null ? null : Number(r.value_captured_usd),
    valueAvailableUsd: r.value_available_usd == null ? null : Number(r.value_available_usd),
    budgetUsd: r.budget_usd == null ? null : Number(r.budget_usd),
    budgetTokens: r.budget_tokens == null ? null : Number(r.budget_tokens),
    modelId: r.model_id,
    harnessVersion: r.harness_version,
    configSnapshot: asJson<Record<string, unknown>>(r.config_snapshot),
    envFingerprint: asJson<Record<string, unknown>>(r.env_fingerprint),
    armMeta: asJson<Record<string, unknown>>(r.arm_meta),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Full fleet-run records for a run — the publication export reads these + getCoordTrace. */
export async function listFleetRunsFull(opts: { runId?: string } & DbScope = {}): Promise<FleetRunRecord[]> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql`
    SELECT * FROM harness_shared.benchmark_fleet_run
     WHERE workspace_id = ${ws} ${opts.runId ? sql`AND run_id = ${opts.runId}` : sql``}
     ORDER BY suite, arm, seed
  `;
  return rows.map(rowToFleetRecord);
}

/** One fleet run's coordination trace, ordered by seq — the MAST-judge / counter input. */
export async function getCoordTrace(fleetRunId: string, opts: DbScope = {}): Promise<CoordTrace | null> {
  const { sql, ws } = resolveDb(opts);
  const fr = await sql<{ arm: string }[]>`
    SELECT arm FROM harness_shared.benchmark_fleet_run
     WHERE fleet_run_id = ${fleetRunId} AND workspace_id = ${ws} LIMIT 1
  `;
  if (fr.length === 0) return null;
  const rows = await sql<{ ts: string | null; kind: string; agent: string | null; task_id: string | null; detail: string | null }[]>`
    SELECT ts, kind, agent, task_id, detail FROM harness_shared.benchmark_coord_event
     WHERE fleet_run_id = ${fleetRunId} AND workspace_id = ${ws}
     ORDER BY seq
  `;
  const agents = new Set<string>();
  const events: CoordEvent[] = rows.map((r) => {
    if (r.agent) agents.add(r.agent);
    const e: CoordEvent = { kind: r.kind };
    if (r.ts != null) e.ts = Number(r.ts);
    if (r.agent != null) e.agent = r.agent;
    if (r.task_id != null) e.taskId = r.task_id;
    if (r.detail != null) e.detail = r.detail;
    return e;
  });
  return { arm: fr[0].arm, agents: [...agents], events };
}
