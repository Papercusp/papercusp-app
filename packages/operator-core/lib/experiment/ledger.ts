/**
 * The experiment ledger (`experiment-registry-invocation-api` P-050) —
 * `harness_shared.experiment_runs` (migration 287). One row per `experiment:run`
 * invocation: the run-level summary (arms+scores, winner, the compareArms verdict,
 * cost, decision) the self-learning system reads back to see how variations
 * performed. Per-cell detail stays in replay_runs (247); spend stays on the
 * governor's learning_spend_events — this is the experiment-level record.
 *
 * A winner is a PROPOSAL: rows are born `decision='proposed'`; only the apply path
 * (commit→reproject + graduation, D-006) advances the decision — never experiment:run.
 */
import type { Sql } from 'postgres';
import type { ExperimentArmResult } from './types';

/** Coerce a jsonb column read to an array. Some pg clients parse jsonb to a JS value,
 *  others (e.g. the testcontainer client) return the raw JSON string — be robust to both
 *  so the scoreboard read never breaks on the client's jsonb-parsing config. */
export function coerceJsonArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export interface ExperimentLedgerRow {
  workspaceId: string;
  batteryId: string;
  testId: string;
  tier: string;
  arms: ExperimentArmResult[];
  baselineId: string;
  winner: string | null;
  comparison: unknown;
  totalCostUsd: number;
  budgetExhausted: boolean;
}

/** The write seam — PG impl below; run-core/tests inject a fake or omit it. */
export interface ExperimentLedger {
  record(row: ExperimentLedgerRow): Promise<void>;
}

/** A read-back row of the ledger (the experiment:results / scoreboard shape). */
export interface ExperimentRunSummary {
  batteryId: string;
  testId: string;
  tier: string;
  winner: string | null;
  arms: ExperimentArmResult[];
  totalCostUsd: number;
  budgetExhausted: boolean;
  decision: string;
  createdAt: string;
}

/**
 * WI-6443. `created_at` is `timestamptz`, so `(r.created_at as Date)` LOOKS safe
 * — but a type ASSERTION is not a runtime guard, and on this read path the value
 * arrives as a string. `.toISOString` was therefore undefined and threw, taking
 * the whole `learning.experiments` read with it: the Experiments view rendered
 * "The experiment registry unavailable (r.created_at.toISOString is not a
 * function)" for every user, and had never once shown an experiment.
 *
 * The sibling read (learning-analyze-read.ts) already guards the SAME column at
 * runtime. Coerce, never assert, at a driver boundary.
 */
function isoAt(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v as string | number);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(v ?? '');
}

export class PgExperimentLedger implements ExperimentLedger {
  constructor(private readonly sql: Sql) {}

  /** Recent experiment runs for a workspace, newest-first, optionally one test. The
   *  read-back the API + the scoreboard render (closes the run→record→read loop). */
  async listRecent(workspaceId: string, opts: { testId?: string; limit?: number } = {}): Promise<ExperimentRunSummary[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const rows = opts.testId
      ? await this.sql`
          SELECT * FROM harness_shared.experiment_runs
          WHERE workspace_id = ${workspaceId} AND test_id = ${opts.testId}
          ORDER BY created_at DESC LIMIT ${limit}`
      : await this.sql`
          SELECT * FROM harness_shared.experiment_runs
          WHERE workspace_id = ${workspaceId}
          ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      batteryId: r.battery_id as string,
      testId: r.test_id as string,
      tier: r.tier as string,
      winner: (r.winner ?? null) as string | null,
      arms: coerceJsonArray<ExperimentArmResult>(r.arms),
      totalCostUsd: Number(r.total_cost_usd),
      budgetExhausted: Boolean(r.budget_exhausted),
      decision: r.decision as string,
      createdAt: isoAt(r.created_at),
    }));
  }

  async record(row: ExperimentLedgerRow): Promise<void> {
    await this.sql`
      INSERT INTO harness_shared.experiment_runs
        (workspace_id, battery_id, test_id, tier, arms, baseline_id, winner, comparison,
         total_cost_usd, budget_exhausted)
      VALUES (
        ${row.workspaceId}, ${row.batteryId}, ${row.testId}, ${row.tier},
        ${JSON.stringify(row.arms)}::text::jsonb, ${row.baselineId}, ${row.winner},
        ${row.comparison == null ? null : JSON.stringify(row.comparison)}::text::jsonb,
        ${row.totalCostUsd}, ${row.budgetExhausted}
      )
      ON CONFLICT (workspace_id, battery_id) DO UPDATE SET
        test_id          = EXCLUDED.test_id,
        tier             = EXCLUDED.tier,
        arms             = EXCLUDED.arms,
        baseline_id      = EXCLUDED.baseline_id,
        winner           = EXCLUDED.winner,
        comparison       = EXCLUDED.comparison,
        total_cost_usd   = EXCLUDED.total_cost_usd,
        budget_exhausted = EXCLUDED.budget_exhausted,
        updated_at       = now()
    `;
  }
}
