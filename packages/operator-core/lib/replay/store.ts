/**
 * PG persistence for replay cells (P-020 / FB-06) — `harness_shared.replay_runs`
 * (migration 247). One row per eval-battery cell, lifecycle `started` →
 * `scored` | `rate_limited` | `errored`; every row is born
 * `signal_origin = 'replay'` (D-002). Spend LEDGERING stays on the governor's
 * `learning_spend_events` (governed.ts) — this table is the run record.
 */
import type { Sql } from 'postgres';
import { coerceJson } from '../pg-jsonb';
import { REPLAY_ORIGIN, replayCaseRef, type ReplayCase, type ReplayStore, type ReplayVariant } from './types';

export class PgReplayStore implements ReplayStore {
  constructor(
    private readonly sql: Sql,
    private readonly workspaceId: string,
  ) {}

  async startRun(r: {
    runId: string;
    batteryId: string;
    variant: ReplayVariant;
    replayCase: ReplayCase;
    repeat: number;
  }): Promise<void> {
    await this.sql`
      INSERT INTO harness_shared.replay_runs
        (workspace_id, run_id, battery_id, variant_id, variant_label, case_ref, turn_index, repeat, status, signal_origin)
      VALUES (
        ${this.workspaceId}, ${r.runId}, ${r.batteryId}, ${r.variant.variantId}, ${r.variant.label},
        ${replayCaseRef(r.replayCase)},
        ${r.replayCase.kind === 'historical' ? r.replayCase.turnIndex : null},
        ${r.repeat}, 'started', ${REPLAY_ORIGIN}
      )
      ON CONFLICT (workspace_id, run_id) DO UPDATE SET
        battery_id = EXCLUDED.battery_id,
        status     = 'started',
        updated_at = now()
    `;
  }

  async finishRun(runId: string, fields: { divergence: unknown; costUsd: number; elapsedMs: number }): Promise<void> {
    // jsonb via JSON.stringify(...)::jsonb, NOT sql.json(...): the prod org-pg
    // client throws 'The "string" argument ... Received an instance of Object' on
    // sql.json(object) (same class as the experiment-ledger fix, D-018) — every
    // replay cell's finish silently errored in prod while integration tests (a
    // different pg client that tolerates sql.json) stayed green. EI-607.
    await this.sql`
      UPDATE harness_shared.replay_runs SET
        divergence = ${fields.divergence == null ? null : JSON.stringify(fields.divergence)}::text::jsonb,
        cost_usd   = ${fields.costUsd},
        elapsed_ms = ${Math.round(fields.elapsedMs)},
        updated_at = now()
      WHERE workspace_id = ${this.workspaceId} AND run_id = ${runId}
    `;
  }

  async recordScore(
    runId: string,
    score: { d1: number; d2: number; d3: number; composite: number; rationale: string; rubricHash: string; costUsd: number },
  ): Promise<void> {
    await this.sql`
      UPDATE harness_shared.replay_runs SET
        status          = 'scored',
        d1              = ${score.d1},
        d2              = ${score.d2},
        d3              = ${score.d3},
        composite       = ${score.composite},
        judge_rationale = ${score.rationale},
        rubric_hash     = ${score.rubricHash},
        cost_usd        = cost_usd + ${score.costUsd},
        updated_at      = now()
      WHERE workspace_id = ${this.workspaceId} AND run_id = ${runId}
    `;
  }

  async markFailed(
    runId: string,
    fields: { status: 'rate_limited' | 'errored'; error: string; elapsedMs: number },
  ): Promise<void> {
    // Upsert (not bare UPDATE): a cell refused by the budget guard fails
    // BEFORE onStart ever ran, so no row exists yet.
    await this.sql`
      INSERT INTO harness_shared.replay_runs
        (workspace_id, run_id, battery_id, variant_id, case_ref, repeat, status, signal_origin, error, elapsed_ms)
      VALUES (${this.workspaceId}, ${runId}, '', '', '', 0, ${fields.status}, ${REPLAY_ORIGIN}, ${fields.error}, ${Math.round(fields.elapsedMs)})
      ON CONFLICT (workspace_id, run_id) DO UPDATE SET
        status     = EXCLUDED.status,
        error      = EXCLUDED.error,
        elapsed_ms = EXCLUDED.elapsed_ms,
        updated_at = now()
    `;
  }
}

export interface ReplayRunRow {
  runId: string;
  batteryId: string;
  variantId: string;
  variantLabel: string | null;
  caseRef: string;
  turnIndex: number | null;
  repeat: number;
  status: string;
  signalOrigin: string;
  d1: number | null;
  d2: number | null;
  d3: number | null;
  composite: number | null;
  judgeRationale: string | null;
  rubricHash: string | null;
  divergence: unknown;
  costUsd: number;
  error: string | null;
  elapsedMs: number | null;
  createdAt: Date;
}

export async function listReplayRuns(
  sql: Sql,
  q: { workspaceId: string; batteryId?: string; limit?: number },
): Promise<ReplayRunRow[]> {
  const limit = Math.min(q.limit ?? 200, 1000);
  const rows = await sql`
    SELECT run_id, battery_id, variant_id, variant_label, case_ref, turn_index, repeat, status,
           signal_origin, d1, d2, d3, composite, judge_rationale, rubric_hash, divergence,
           cost_usd, error, elapsed_ms, created_at
    FROM harness_shared.replay_runs
    WHERE workspace_id = ${q.workspaceId}
      ${q.batteryId !== undefined ? sql`AND battery_id = ${q.batteryId}` : sql``}
    ORDER BY created_at DESC, run_id
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    runId: r.run_id as string,
    batteryId: r.battery_id as string,
    variantId: r.variant_id as string,
    variantLabel: (r.variant_label as string) ?? null,
    caseRef: r.case_ref as string,
    turnIndex: r.turn_index === null ? null : Number(r.turn_index),
    repeat: Number(r.repeat),
    status: r.status as string,
    signalOrigin: r.signal_origin as string,
    d1: r.d1 === null ? null : Number(r.d1),
    d2: r.d2 === null ? null : Number(r.d2),
    d3: r.d3 === null ? null : Number(r.d3),
    composite: r.composite === null ? null : Number(r.composite),
    judgeRationale: (r.judge_rationale as string) ?? null,
    rubricHash: (r.rubric_hash as string) ?? null,
    divergence: coerceJson(r.divergence),
    costUsd: Number(r.cost_usd),
    error: (r.error as string) ?? null,
    elapsedMs: r.elapsed_ms === null ? null : Number(r.elapsed_ms),
    createdAt: r.created_at as Date,
  }));
}
