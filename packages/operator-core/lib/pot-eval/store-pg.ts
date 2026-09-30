/**
 * PG store adapter for the Hive-evaluation battery (harness_shared, migration 264).
 *
 * Mirrors the beekeeper PG store, but keyed `(instance_id, scenario_id, repeat)` so every
 * repeat is kept (P-022 distribution) — unlike the beekeeper's `(instance_id, case_id)`.
 * All writes are idempotent (the run_id is deterministic per key) so a re-run / replay
 * RESETS the row to a fresh attempt rather than colliding. Scoring is HE-06's table.
 */
import postgres from 'postgres';
import { coerceJson } from '../pg-jsonb';
import type {
  HiveEvalStore,
  HiveEvalRunFinish,
  HiveEvalRunRow,
  HiveEvalScenarioRow,
  HiveEvalScoreRow,
  InstanceManifest,
} from './store';

export class HiveEvalStorePg implements HiveEvalStore {
  constructor(private sql: postgres.Sql) {}

  async upsertInstance(m: InstanceManifest): Promise<void> {
    // Deterministic instanceId → a re-run at the same code is a no-op, not a crash.
    await this.sql`
      INSERT INTO harness_shared.pot_eval_instances
        (instance_id, workspace_id, code_sha, genome_id, battery_slice_id)
      VALUES
        (${m.instanceId}, ${m.workspaceId}, ${m.codeSha}, ${m.genomeId || null}, ${m.batterySliceId || null})
      ON CONFLICT (instance_id) DO NOTHING
    `;
  }

  async upsertScenario(s: HiveEvalScenarioRow): Promise<void> {
    await this.sql`
      INSERT INTO harness_shared.pot_eval_scenarios
        (scenario_id, title, shape, ideal_wall_clock_units, ideal_cup_count, total_units,
         critical_path, work_item_count, planted_bug_location)
      VALUES
        (${s.scenarioId}, ${s.title}, ${s.shape}, ${s.idealWallClockUnits}, ${s.idealBeeCount},
         ${s.totalUnits}, ${s.criticalPath == null ? null : JSON.stringify(s.criticalPath)}::text::jsonb, ${s.workItemCount}, ${s.plantedBugLocation})
      ON CONFLICT (scenario_id) DO UPDATE SET
        title = EXCLUDED.title,
        shape = EXCLUDED.shape,
        ideal_wall_clock_units = EXCLUDED.ideal_wall_clock_units,
        ideal_cup_count = EXCLUDED.ideal_cup_count,
        total_units = EXCLUDED.total_units,
        critical_path = EXCLUDED.critical_path,
        work_item_count = EXCLUDED.work_item_count,
        planted_bug_location = EXCLUDED.planted_bug_location
    `;
  }

  async startRun(r: HiveEvalRunRow): Promise<void> {
    // run_id is deterministic per (instance, scenario, repeat). A re-run RESETS the row to a
    // fresh attempt (clear the terminal fields finishRun repopulates) rather than colliding.
    // NOTE: the org PG client rejects a raw JS Date param — bind timestamptz as an ISO string.
    await this.sql`
      INSERT INTO harness_shared.pot_eval_runs
        (run_id, instance_id, scenario_id, shape, repeat, seed, budget_usd_cap, cup_cap, started_at)
      VALUES
        (${r.runId}, ${r.instanceId}, ${r.scenarioId}, ${r.shape}, ${r.repeat}, ${r.seed},
         ${r.budgetUsdCap}, ${r.beeCap}, ${r.startedAt.toISOString()})
      ON CONFLICT (run_id) DO UPDATE SET
        instance_id = EXCLUDED.instance_id,
        scenario_id = EXCLUDED.scenario_id,
        shape = EXCLUDED.shape,
        repeat = EXCLUDED.repeat,
        seed = EXCLUDED.seed,
        budget_usd_cap = EXCLUDED.budget_usd_cap,
        cup_cap = EXCLUDED.cup_cap,
        started_at = EXCLUDED.started_at,
        finished_at = NULL,
        terminal_state = NULL,
        wall_clock_ms = NULL,
        frontier_drained = NULL,
        work_items_total = NULL,
        work_items_completed = NULL,
        cost_usd = NULL,
        observations = NULL,
        trace_ref = NULL
    `;
  }

  async finishRun(runId: string, fields: HiveEvalRunFinish): Promise<void> {
    const o = fields.observations;
    await this.sql`
      UPDATE harness_shared.pot_eval_runs
      SET
        finished_at = ${fields.finishedAt.toISOString()},
        terminal_state = ${o.terminalState},
        wall_clock_ms = ${o.wallClockMs},
        frontier_drained = ${o.frontierDrained},
        work_items_total = ${o.workItemsTotal},
        work_items_completed = ${o.workItemsCompleted},
        cost_usd = ${o.costUsd},
        observations = ${JSON.stringify(o)}::text::jsonb,
        trace_ref = ${fields.traceRef || null}
      WHERE run_id = ${runId}
    `;
  }

  async upsertScore(row: HiveEvalScoreRow): Promise<void> {
    // Idempotent (beekeeper pattern): the PK is (run_id, rubric_hash). Re-scoring the same run
    // under the same rubric OVERWRITES; a rubric change writes a distinct row, so scores under
    // different rubrics never mix (migration 267).
    await this.sql`
      INSERT INTO harness_shared.pot_eval_scores
        (run_id, rubric_hash, rubric_version, outcome_gate_passed, efficiency_score, speed_score,
         composite, judge_composite, regressions, planted_bug_caught, fabrication_detected,
         critical_path_ratio, floor_ceiling, detail)
      VALUES
        (${row.runId}, ${row.rubricHash}, ${row.rubricVersion}, ${row.outcomeGatePassed},
         ${row.efficiencyScore}, ${row.speedScore}, ${row.composite}, ${row.judgeComposite ?? null},
         ${row.regressions}, ${row.plantedBugCaught}, ${row.fabricationDetected},
         ${row.criticalPathRatio}, ${row.floorCeiling}, ${row.detail == null ? null : JSON.stringify(row.detail)}::text::jsonb)
      ON CONFLICT (run_id, rubric_hash) DO UPDATE SET
        rubric_version = EXCLUDED.rubric_version,
        outcome_gate_passed = EXCLUDED.outcome_gate_passed,
        efficiency_score = EXCLUDED.efficiency_score,
        speed_score = EXCLUDED.speed_score,
        composite = EXCLUDED.composite,
        judge_composite = EXCLUDED.judge_composite,
        regressions = EXCLUDED.regressions,
        planted_bug_caught = EXCLUDED.planted_bug_caught,
        fabrication_detected = EXCLUDED.fabrication_detected,
        critical_path_ratio = EXCLUDED.critical_path_ratio,
        floor_ceiling = EXCLUDED.floor_ceiling,
        detail = EXCLUDED.detail,
        scored_at = now()
    `;
  }

  async getScore(runId: string, rubricHash: string): Promise<HiveEvalScoreRow | null> {
    const rows = await this.sql<
      Array<{
        run_id: string;
        rubric_hash: string;
        rubric_version: string;
        outcome_gate_passed: boolean;
        efficiency_score: string;
        speed_score: string;
        composite: string;
        judge_composite: string | null;
        regressions: boolean;
        planted_bug_caught: boolean;
        fabrication_detected: boolean;
        critical_path_ratio: string;
        floor_ceiling: string;
        detail: unknown;
        scored_at: Date;
      }>
    >`
      SELECT run_id, rubric_hash, rubric_version, outcome_gate_passed, efficiency_score, speed_score,
             composite, judge_composite, regressions, planted_bug_caught, fabrication_detected,
             critical_path_ratio, floor_ceiling, detail, scored_at
      FROM harness_shared.pot_eval_scores
      WHERE run_id = ${runId} AND rubric_hash = ${rubricHash}
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      runId: r.run_id,
      rubricHash: r.rubric_hash,
      rubricVersion: r.rubric_version,
      outcomeGatePassed: r.outcome_gate_passed,
      efficiencyScore: Number(r.efficiency_score),
      speedScore: Number(r.speed_score),
      composite: Number(r.composite),
      judgeComposite: r.judge_composite == null ? undefined : Number(r.judge_composite),
      regressions: r.regressions,
      plantedBugCaught: r.planted_bug_caught,
      fabricationDetected: r.fabrication_detected,
      criticalPathRatio: Number(r.critical_path_ratio),
      floorCeiling: Number(r.floor_ceiling),
      detail: coerceJson(r.detail),
      scoredAt: r.scored_at,
    };
  }
}

export function createPgHiveEvalStore(sql: postgres.Sql): HiveEvalStore {
  return new HiveEvalStorePg(sql);
}
