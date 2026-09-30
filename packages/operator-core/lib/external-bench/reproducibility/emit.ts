/**
 * emitRollout (BRIEF 8 / P-010) — THE single emission entry point every arm
 * runner (P-005 adapter, P-006 ablation, P-007 native, P-008 best-of-N, P-019
 * blueprint) calls. One call, in one transaction:
 *   1. enforces the firewall (the run's preregHash must exist) — refuses orphan rows;
 *   2. writes the Rollout Card (full repro content) + the run_result row (the
 *      scoreable+provenance unit that mirrors @papercusp/bench-metrics TaskRunResult);
 *   3. DERIVES cost_usd via P-011's priceRun() over the raw tokens + one published
 *      price table (never provider-reported $ — the fairness invariant, D-005);
 *   4. UPSERTs on the deterministic rolloutId so a re-emit of the same attempt is
 *      idempotent.
 * Then fires sync invalidation so the P-020 Evaluation UI refreshes.
 */
import { createHash } from 'node:crypto';
import {
  priceRun,
  DEFAULT_PRICE_TABLE,
  type PriceTable,
  type ArmId,
  type GenerationStatus,
  type GraderStatus,
} from '@papercusp/bench-metrics';
import { notifySyncInvalidate } from '../../sync-sse';
import { generationStatusForStopReason } from '../types';
import type { ArmAttempt, BenchTask, GradeResult } from '../types';
import type { EmitRolloutInput } from './schema';
import { resolveDb, type DbScope } from './db';

const jb = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/** Deterministic rollout id = sha256(runId ∥ suite ∥ taskId ∥ arm ∥ seed). */
export function rolloutIdFor(
  runId: string,
  suite: string,
  taskId: string,
  arm: string,
  seed: number,
): string {
  return createHash('sha256')
    .update([runId, suite, taskId, arm, String(seed)].join('\x00'), 'utf8')
    .digest('hex');
}

export interface EmitOptions extends DbScope {
  /** Override the published price table (default price-table-v1). */
  priceTable?: PriceTable;
}

/**
 * Persist one graded, costed task run as a (run_result + rollout) pair. Throws if
 * no benchmark_prereg row matches `preregHash` (the tune-to-test firewall) or if
 * the model has no price-table entry (a loud failure beats a silently-zero cost
 * that would corrupt the cost/accuracy comparison).
 */
export async function emitRollout(
  input: EmitRolloutInput,
  opts: EmitOptions = {},
): Promise<{ rolloutId: string; runId: string }> {
  const { sql, ws } = resolveDb(opts);
  const table = opts.priceTable ?? DEFAULT_PRICE_TABLE;
  const g = input.generation;
  const gr = input.grading;

  const rolloutId = rolloutIdFor(input.runId, input.suite, input.taskId, input.arm, input.seed);
  const costUsd = priceRun(
    {
      tokensIn: g.tokensIn,
      tokensOut: g.tokensOut,
      tokensCacheRead: g.tokensCacheRead ?? null,
      tokensCacheWrite: g.tokensCacheWrite ?? null,
    },
    g.modelId,
    table,
  );

  const prov = input.provenance ?? {};
  const rawGraderOutputRef = gr.rawOutput != null ? `rollout:${rolloutId}#grader` : null;
  const submissionRef = g.submission != null ? `rollout:${rolloutId}#submission` : null;
  const graderOutput =
    gr.structuredOutput !== undefined || gr.failToPass != null || gr.passToPass != null
      ? { failToPass: gr.failToPass ?? null, passToPass: gr.passToPass ?? null, report: gr.structuredOutput ?? null }
      : null;

  await sql.begin(async (tx) => {
    const pre = await tx`
      SELECT 1 FROM harness_shared.benchmark_prereg
       WHERE prereg_hash = ${input.preregHash} AND workspace_id = ${ws} LIMIT 1
    `;
    if (pre.length === 0) {
      throw new Error(
        `emitRollout: no benchmark_prereg for hash "${input.preregHash}" (workspace ${ws}); ` +
          `pre-register the run config before emitting (tune-to-test firewall)`,
      );
    }

    await tx`
      INSERT INTO harness_shared.benchmark_rollout
        (rollout_id, run_id, workspace_id, prereg_hash, suite, task_id, arm, seed,
         config_snapshot, model_id, model_version, harness_version, harness_git_sha, env_fingerprint,
         grader_family, grader_version, grader_output, raw_grader_output, submission,
         trajectory_ref, trajectory_kind)
      VALUES
        (${rolloutId}, ${input.runId}, ${ws}, ${input.preregHash}, ${input.suite}, ${input.taskId}, ${input.arm}, ${input.seed},
         ${jb(prov.configSnapshot)}::text::jsonb, ${g.modelId}, ${prov.modelVersion ?? null}, ${g.harnessVersion}, ${prov.harnessGitSha ?? null}, ${jb(prov.envFingerprint)}::text::jsonb,
         ${gr.family}, ${gr.version}, ${jb(graderOutput)}::text::jsonb, ${gr.rawOutput ?? null}, ${g.submission ?? null},
         ${g.trajectoryRef ?? null}, ${g.trajectoryKind ?? null})
      ON CONFLICT (rollout_id) DO UPDATE SET
        run_id = EXCLUDED.run_id, prereg_hash = EXCLUDED.prereg_hash, config_snapshot = EXCLUDED.config_snapshot,
        model_id = EXCLUDED.model_id, model_version = EXCLUDED.model_version, harness_version = EXCLUDED.harness_version,
        harness_git_sha = EXCLUDED.harness_git_sha, env_fingerprint = EXCLUDED.env_fingerprint,
        grader_family = EXCLUDED.grader_family, grader_version = EXCLUDED.grader_version, grader_output = EXCLUDED.grader_output,
        raw_grader_output = EXCLUDED.raw_grader_output, submission = EXCLUDED.submission,
        trajectory_ref = EXCLUDED.trajectory_ref, trajectory_kind = EXCLUDED.trajectory_kind
    `;

    await tx`
      INSERT INTO harness_shared.benchmark_run_result
        (rollout_id, run_id, workspace_id, suite, modality, task_id, arm, seed, fleet_run_id,
         resolved, score, grader_status, grader_family, grader_version, fail_to_pass, pass_to_pass,
         tokens_in, tokens_out, tokens_total, tokens_cache_read, tokens_cache_write,
         cost_usd, price_table_version, wall_clock_ms, turns, budget_tokens, capped,
         generation_status, generation_error, arm_meta,
         model_id, harness_version, prereg_hash, raw_grader_output_ref, submission_ref)
      VALUES
        (${rolloutId}, ${input.runId}, ${ws}, ${input.suite}, ${input.modality}, ${input.taskId}, ${input.arm}, ${input.seed}, ${input.fleetRunId ?? null},
         ${gr.resolved}, ${gr.score ?? null}, ${gr.status}, ${gr.family}, ${gr.version}, ${jb(gr.failToPass)}::text::jsonb, ${jb(gr.passToPass)}::text::jsonb,
         ${g.tokensIn}, ${g.tokensOut}, ${g.tokensTotal}, ${g.tokensCacheRead ?? null}, ${g.tokensCacheWrite ?? null},
         ${costUsd}, ${table.version}, ${g.wallClockMs}, ${g.turns ?? 0}, ${g.budgetTokens ?? null}, ${g.capped ?? false},
         ${g.status}, ${g.error ?? null}, ${jb(g.armMeta)}::text::jsonb,
         ${g.modelId}, ${g.harnessVersion}, ${input.preregHash}, ${rawGraderOutputRef}, ${submissionRef})
      ON CONFLICT (rollout_id) DO UPDATE SET
        run_id = EXCLUDED.run_id, suite = EXCLUDED.suite, modality = EXCLUDED.modality, task_id = EXCLUDED.task_id,
        fleet_run_id = EXCLUDED.fleet_run_id,
        arm = EXCLUDED.arm, seed = EXCLUDED.seed, resolved = EXCLUDED.resolved, score = EXCLUDED.score, grader_status = EXCLUDED.grader_status,
        grader_family = EXCLUDED.grader_family, grader_version = EXCLUDED.grader_version,
        fail_to_pass = EXCLUDED.fail_to_pass, pass_to_pass = EXCLUDED.pass_to_pass,
        tokens_in = EXCLUDED.tokens_in, tokens_out = EXCLUDED.tokens_out, tokens_total = EXCLUDED.tokens_total,
        tokens_cache_read = EXCLUDED.tokens_cache_read, tokens_cache_write = EXCLUDED.tokens_cache_write,
        cost_usd = EXCLUDED.cost_usd, price_table_version = EXCLUDED.price_table_version,
        wall_clock_ms = EXCLUDED.wall_clock_ms, turns = EXCLUDED.turns, budget_tokens = EXCLUDED.budget_tokens,
        capped = EXCLUDED.capped, generation_status = EXCLUDED.generation_status, generation_error = EXCLUDED.generation_error,
        arm_meta = EXCLUDED.arm_meta, model_id = EXCLUDED.model_id, harness_version = EXCLUDED.harness_version,
        prereg_hash = EXCLUDED.prereg_hash, raw_grader_output_ref = EXCLUDED.raw_grader_output_ref,
        submission_ref = EXCLUDED.submission_ref
    `;
  });

  await notifySyncInvalidate('evals.runs', { runId: input.runId });
  await notifySyncInvalidate('evals.report', { runId: input.runId });
  await notifySyncInvalidate('evals.suites', {});

  return { rolloutId, runId: input.runId };
}

/**
 * M1 (diff) convenience: build an EmitRolloutInput from the shared-contract
 * `ArmAttempt` + `GradeResult` (external-bench/types.ts) and emit. Maps the
 * generation stop-reason → generationStatus/capped and applies METR exclusion
 * (an infra-failed generation or grader → resolved = null, not a fail). cost is
 * recomputed from tokens — `attempt.costUsd` is intentionally NOT trusted (one
 * price table applies to every arm).
 */
export interface EmitFromAttemptInput {
  runId: string;
  preregHash: string;
  /** Canonical arm id — NOT trusted from attempt.arm (that field predates the lock). */
  arm: ArmId;
  /** Numeric attempt ordinal — NOT attempt.seed (that is the string prefix). */
  seed: number;
  task: BenchTask;
  attempt: ArmAttempt;
  grade: GradeResult;
  modelId: string;
  harnessVersion: string;
  budgetTokens?: number | null;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
  /** The L2 fleet run that placed this task (Phase 5); null for standalone L1 arms. */
  fleetRunId?: string | null;
  /** Override the derived generation status (e.g. a wall-clock 'timeout'). */
  generationStatus?: GenerationStatus;
  provenance?: EmitRolloutInput['provenance'];
}

export async function emitFromAttempt(
  i: EmitFromAttemptInput,
  opts: EmitOptions = {},
): Promise<{ rolloutId: string; runId: string }> {
  const stop = i.attempt.stopReason;
  // FAIRNESS (benchmark-fairness-fix): derive generationStatus through the SINGLE canonical bridge so the
  // immutable run_result row excludes the SAME external/transient/infra terminals the live rollups do — a
  // wall-clock 'timeout' → 'timeout' and a 429/contention 'infra-failed' → 'error' (both infra ⇒ resolved=null,
  // never a capability fail). Previously only 'error' was excluded and 'timeout'/'infra-failed' wrongly
  // mapped to 'completed'-as-scored. A caller may still override via i.generationStatus.
  const genStatus: GenerationStatus = i.generationStatus ?? generationStatusForStopReason(stop);
  const capped = stop === 'budget-exhausted' || stop === 'max-turns';
  const infraGen = genStatus === 'error' || genStatus === 'timeout';

  let resolved: boolean | null;
  let graderStatus: GraderStatus;
  let graderError: string | null;
  if (infraGen) {
    resolved = null;
    graderStatus = 'error';
    graderError = `generation did not complete (${stop}): ${i.attempt.generationError ?? ''}`.trim();
  } else if (i.grade.graderError) {
    resolved = null;
    graderStatus = 'error';
    graderError = i.grade.graderError;
  } else {
    resolved = i.grade.resolved;
    graderStatus = i.grade.resolved ? 'passed' : 'failed';
    graderError = null;
  }

  const rawOutput =
    typeof i.grade.rawGraderOutput === 'string'
      ? i.grade.rawGraderOutput
      : JSON.stringify(i.grade.rawGraderOutput ?? null);

  return emitRollout(
    {
      runId: i.runId,
      preregHash: i.preregHash,
      suite: i.task.benchmark,
      taskId: i.attempt.instanceId,
      arm: i.arm,
      seed: i.seed,
      modality: 'diff',
      fleetRunId: i.fleetRunId ?? null,
      generation: {
        status: genStatus,
        error: i.attempt.generationError ?? null,
        tokensIn: i.attempt.tokensIn,
        tokensOut: i.attempt.tokensOut,
        tokensTotal: i.attempt.tokensIn + i.attempt.tokensOut,
        tokensCacheRead: i.tokensCacheRead ?? null,
        tokensCacheWrite: i.tokensCacheWrite ?? null,
        wallClockMs: i.attempt.wallClockMs,
        turns: i.attempt.turns,
        budgetTokens: i.budgetTokens ?? null,
        capped,
        modelId: i.modelId,
        harnessVersion: i.harnessVersion,
        submission: i.attempt.diff,
        trajectoryRef: i.attempt.trajectoryRef,
        trajectoryKind: 'pg:spawned_agents',
      },
      grading: {
        resolved,
        status: graderStatus,
        family: i.grade.graderFamily,
        version: i.grade.graderVersion,
        error: graderError,
        failToPass: i.grade.failToPass ?? null,
        passToPass: i.grade.passToPass ?? null,
        score: i.grade.score ?? null,
        structuredOutput: i.grade.rawGraderOutput,
        rawOutput,
      },
      provenance: i.provenance,
    },
    opts,
  );
}
