/**
 * PG store adapter for Beekeeper runner results (harness_shared schema).
 * Persists instance manifests, battery runs, and scores.
 */

import postgres from 'postgres';
import type { BeekeeperStore } from './beekeeper-runner';
import type { GymScore } from '../gym/judge';
import type { IQBatteryMetrics } from './collectors';
import type { InstanceManifest } from './instance-manifest';
import type { CorpusCase } from './corpus';

export class BeekeeperStorePg implements BeekeeperStore {
  constructor(private sql: postgres.Sql) {}

  async upsertInstance(manifest: InstanceManifest): Promise<void> {
    // Idempotent re-run (D-005): instance_id is deterministic (`gen0-<sha>-<workspace>`),
    // so a re-run at the same commit MUST be a no-op, not a crash. Conflict on the PK
    // (instance_id) — NOT the UNIQUE (workspace_id, code_sha, genome_id), whose NULL
    // genome_id makes its rows distinct (NULLs never match in a UNIQUE constraint), so
    // that target never fired and the INSERT hit the instance_id PK instead.
    await this.sql`
      INSERT INTO harness_shared.cup_keeper_instances
        (instance_id, workspace_id, code_sha, genome_id, memory_snapshot_id, battery_slice_id)
      VALUES
        (${manifest.instanceId}, ${manifest.workspaceId}, ${manifest.codeSha},
         ${manifest.genomeId || null}, ${manifest.memorySnapshotId || null},
         ${manifest.batterySliceId || null})
      ON CONFLICT (instance_id) DO NOTHING
    `;
  }

  async upsertCorpusCase(c: CorpusCase): Promise<void> {
    // Store in a transient way; the corpus itself is external (P-001).
    // This is just for run-linking. In practice, cases are referenced by ID
    // and the full case data lives in the corpus store, not beekeeper.
    // Omitted for MVP — the case_id and case_variant on beekeeper_runs is sufficient.
  }

  async startRun(r: {
    runId: string;
    instanceId: string;
    caseId: string;
    caseVariant: string;
    caseTitle: string;
  }): Promise<void> {
    // Idempotent re-run (D-005): run_id is deterministic per (case, repeat). A re-run
    // RESETS the row to a fresh attempt — clear the terminal fields finishRun will repopulate —
    // rather than colliding on the run_id PK.
    await this.sql`
      INSERT INTO harness_shared.cup_keeper_runs
        (run_id, instance_id, case_id, case_variant, case_title)
      VALUES
        (${r.runId}, ${r.instanceId}, ${r.caseId}, ${r.caseVariant}, ${r.caseTitle})
      ON CONFLICT (run_id) DO UPDATE SET
        instance_id = EXCLUDED.instance_id,
        case_id = EXCLUDED.case_id,
        case_variant = EXCLUDED.case_variant,
        case_title = EXCLUDED.case_title,
        started_at = now(),
        finished_at = NULL,
        terminal_state = NULL,
        deterministic_signals = NULL,
        trace_ref = NULL,
        elapsed_ms = NULL
    `;
  }

  async finishRun(
    runId: string,
    fields: { terminalState: string; deterministicSignals: unknown; traceRef?: string; elapsedMs: number }
  ): Promise<void> {
    await this.sql`
      UPDATE harness_shared.cup_keeper_runs
      SET
        terminal_state = ${fields.terminalState},
        deterministic_signals = ${JSON.stringify(fields.deterministicSignals)},
        trace_ref = ${fields.traceRef || null},
        finished_at = now(),
        elapsed_ms = ${fields.elapsedMs}
      WHERE run_id = ${runId}
    `;
  }

  async recordScore(runId: string, score: GymScore, metrics: IQBatteryMetrics): Promise<void> {
    // Idempotent re-run (D-005): the score PK is (run_id, rubric_hash). Re-judging the same
    // run under the same rubric OVERWRITES the prior score rather than colliding on the PK.
    await this.sql`
      INSERT INTO harness_shared.cup_keeper_scores
        (run_id, judge_model, rubric_hash, judge_temp, weights,
         success, tokens_per_task, time_to_green_secs, first_attempt_pass,
         recurrence, escalation, recall_hit,
         d1, d2, d3, composite, rationale)
      VALUES
        (${runId}, ${score.judgeModel}, ${score.rubricHash}, ${score.judgeTemp},
         ${JSON.stringify(score.weights)},
         ${metrics.success}, ${metrics.tokensPerSolvedTask}, ${metrics.timeToGreenSecs},
         ${metrics.firstAttemptPass},
         ${metrics.recurrence}, ${metrics.escalation}, ${metrics.recallHit},
         ${score.d1}, ${score.d2}, ${score.d3}, ${score.composite}, ${score.rationale || null})
      ON CONFLICT (run_id, rubric_hash) DO UPDATE SET
        judge_model = EXCLUDED.judge_model,
        judge_temp = EXCLUDED.judge_temp,
        weights = EXCLUDED.weights,
        success = EXCLUDED.success,
        tokens_per_task = EXCLUDED.tokens_per_task,
        time_to_green_secs = EXCLUDED.time_to_green_secs,
        first_attempt_pass = EXCLUDED.first_attempt_pass,
        recurrence = EXCLUDED.recurrence,
        escalation = EXCLUDED.escalation,
        recall_hit = EXCLUDED.recall_hit,
        d1 = EXCLUDED.d1,
        d2 = EXCLUDED.d2,
        d3 = EXCLUDED.d3,
        composite = EXCLUDED.composite,
        rationale = EXCLUDED.rationale,
        scored_at = now()
    `;
  }
}

export async function createBeekeeperStore(sql: postgres.Sql): Promise<BeekeeperStore> {
  return new BeekeeperStorePg(sql);
}
