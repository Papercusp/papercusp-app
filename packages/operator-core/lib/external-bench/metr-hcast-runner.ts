/**
 * METR HCAST RUNNER (plan benchmark-suite-metr-hcast-2026-06-17 Phase 2, P-003/P-004/P-005).
 *
 * The generation+scoring half for the in-container METR HCAST suite. Like TheAgentCompany's runner the arm
 * mutates a LIVE container, but METR is special: EACH task brings its OWN Task-Standard Docker image AND its
 * OWN `score()` (we author no verifier). So scoring is intrinsic to the container and runs HERE (in the same
 * container the arm mutated, before teardown) — exactly like the Harbor M2 arm where gen+grade come back
 * together — rather than in a separate diff-batch grader.
 *
 * Per task it: pull+run the image → `docker cp taskhelper.py` → `taskhelper start` (sets up the task +
 * chowns /home/agent) → `taskhelper setup` (the instructions) → drive OUR opus arm inside the container as
 * the unprivileged `agent` user, producing a submission string → `taskhelper score -s <submission>` (the
 * task's own score()) → teardown. It produces the SHARED {@link ArmAttempt} (cost/stop accounting, identical
 * across arms) PLUS a {@link GradeResult} carrying the task's score, and threads the task's `humanMinutes`
 * baseline through so the run-level HORIZON fit (the headline) can read it.
 *
 * TWO ARMS, ONE CONTRACT (D-002 causal isolation): the only thing that differs between the single-opus
 * baseline arm (`baseline-a-ablation`) and the hive arm (`papercusp`) is the {@link MetrHcastRunnerOps.driveArm}
 * implementation — identical image, identical taskhelper lifecycle, identical scoring — so any horizon
 * difference is attributable to the orchestration, not the harness.
 *
 * GATING / SEAM. The IO seam ({@link MetrHcastRunnerOps}) is INJECTED (the hive-eval live-ports pattern): the
 * orchestration here — per-task lifecycle, the never-throw generation-failure contract, the concurrency pool,
 * the score→resolved derivation — is unit-tested with fakes (NO docker, NO live arm). The LIVE binding
 * (`dockerTaskStandardOps` in ./metr-hcast-live.ts: docker pull/run + taskhelper; `driveArm` = the opus
 * in-container ReAct loop / the hive) is host-gated. The container is ALWAYS torn down (finally).
 */
import type {
  ArmAttempt,
  BenchTask,
  GenerationBudget,
  GenerationStopReason,
  GenerationTelemetry,
} from './types';
import { isScoredStopReason } from './types';

/** The METR HCAST blueprint id stamped on the row (the in-container suite). */
export const METR_HCAST_BLUEPRINT_ID = 'metr-hcast';

/** Default: a task is "resolved" when its score() value reaches this threshold (METR binarizes at ≥ 1.0 for
 *  most HCAST tasks; partial-credit tasks carry the raw score too). Override per-task via graderMeta.scoreThreshold. */
export const DEFAULT_SCORE_THRESHOLD = 1.0;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A live task environment handle — the running Task-Standard container the arm operates + scores in. */
export interface MetrHcastTaskEnv {
  /** Container id/name the arm + scorer exec into. */
  containerId: string;
  /** The task image that was pulled (provenance for the rollout card / arm_meta). */
  image: string;
  /** The taskhelper TASK_FAMILY_NAME (the importable module). */
  family: string;
  /** The taskhelper TASK_NAME (the variant). */
  task: string;
  /** The task instructions (from taskhelper setup) the arm was given. */
  instructions: string;
}

/** What driving our arm over one task produced — telemetry + the submission string scored by the task. */
export interface MetrHcastDriveResult {
  /** Cost/stop accounting — SUMMED across every agent + turn (coordination overhead counted, fairness #2). */
  telemetry: GenerationTelemetry;
  /** The arm's final submission string fed to `taskhelper score -s`. Empty/absent → scored as no-op. */
  submission: string;
}

/** The result of the task's own score() (via taskhelper). */
export interface MetrHcastScoreResult {
  /** The raw float score() returned (null when score() returned None / could not score). */
  score: number | null;
  /** Raw taskhelper stdout/JSON, stored verbatim for reproducibility. */
  raw: unknown;
}

/**
 * The injected IO seam. Every side effect is ONE method so the per-task ordering, the never-throw contract,
 * and the pool semantics all unit-test with fakes. The real binding (`dockerTaskStandardOps`) wires docker +
 * taskhelper + the opus/hive arm via lazy dynamic imports — host-gated.
 */
export interface MetrHcastRunnerOps {
  now(): number;
  /** The fleet concurrency cap (= the global `maxSimultaneousAgents`). Read ONCE at run start. */
  concurrencyCap(): number | Promise<number>;
  /** Pull+run the image, cp taskhelper, run `taskhelper start`, fetch instructions. Returns the live env. */
  prepareTask(input: { task: BenchTask; workspaceId: string }): Promise<MetrHcastTaskEnv>;
  /**
   * Drive OUR opus arm inside the container (as `agent`) under `budget`, leaving any container state the task
   * scores. MUST NOT throw a generation failure — return telemetry whose `stopReason` carries it (a genuine
   * infra throw is caught by the runner → an error attempt for this task).
   */
  driveArm(input: {
    task: BenchTask;
    env: MetrHcastTaskEnv;
    arm: string;
    budget: GenerationBudget;
    seed: string;
    workspaceId: string;
  }): Promise<MetrHcastDriveResult>;
  /** Run the task's own score() via `taskhelper score -s <submission>` against the live container. */
  score(input: { env: MetrHcastTaskEnv; submission: string; workspaceId: string }): Promise<MetrHcastScoreResult>;
  /** Stop + remove the container (best-effort — never masks the run's outcome). */
  teardownTask(input: { env: MetrHcastTaskEnv; workspaceId: string }): Promise<void>;
}

/** One graded HCAST task run for one arm: the shared attempt + the task's grade + the human-time baseline. */
export interface MetrHcastTaskResult {
  attempt: ArmAttempt;
  /** Task's score() outcome → resolved (score ≥ threshold). NULL resolved when generation/score infra-failed. */
  grade: {
    instanceId: string;
    prefix: string;
    /** score ≥ threshold; NULL when the run was never genuinely scored (infra failure) — excluded from accuracy. */
    resolved: boolean | null;
    /** Raw continuous score() value. */
    score: number | null;
    graderFamily: string;
    graderVersion: string;
    rawGraderOutput: unknown;
    graderError?: string;
  };
  /** The task's human-expert baseline (minutes), threaded from graderMeta for the horizon fit. null = no baseline. */
  humanMinutes: number | null;
}

function scoreThresholdFor(task: BenchTask): number {
  const v = task.graderMeta?.['scoreThreshold'];
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_SCORE_THRESHOLD;
}

function humanMinutesFor(task: BenchTask): number | null {
  const v = task.graderMeta?.['humanMinutes'];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function errorAttempt(
  arm: string,
  task: BenchTask,
  seed: string,
  stopReason: GenerationStopReason,
  generationError: string,
): ArmAttempt {
  return {
    arm,
    blueprintId: METR_HCAST_BLUEPRINT_ID,
    instanceId: task.instanceId,
    seed,
    diff: '', // in-container suite: there is no diff
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    turns: 0,
    wallClockMs: 0,
    trajectoryRef: '',
    stopReason,
    generationError,
    armMeta: { inContainer: true, suite: 'metr-hcast' },
  };
}

function attemptFromTelemetry(
  arm: string,
  task: BenchTask,
  seed: string,
  env: MetrHcastTaskEnv,
  t: GenerationTelemetry,
): ArmAttempt {
  return {
    arm,
    blueprintId: METR_HCAST_BLUEPRINT_ID,
    instanceId: task.instanceId,
    seed,
    diff: '',
    tokensIn: t.tokensIn,
    tokensOut: t.tokensOut,
    costUsd: t.costUsd,
    turns: t.turns,
    wallClockMs: t.wallClockMs,
    trajectoryRef: t.trajectoryRef,
    stopReason: t.stopReason,
    ...(t.generationError ? { generationError: t.generationError } : {}),
    armMeta: { inContainer: true, suite: 'metr-hcast', image: env.image, family: env.family, task: env.task },
  };
}

/** A grade row for a generation/score infra failure (resolved=null, excluded from accuracy — METR discipline). */
function infraGrade(task: BenchTask, seed: string, version: string, graderError: string): MetrHcastTaskResult['grade'] {
  return {
    instanceId: task.instanceId,
    prefix: seed,
    resolved: null,
    score: null,
    graderFamily: 'metr-hcast',
    graderVersion: version,
    rawGraderOutput: null,
    graderError,
  };
}

/**
 * Run ONE METR HCAST task for one arm: prepare → drive → (if scored terminal) score → {attempt, grade,
 * humanMinutes}. Never throws. A prepare failure → error attempt, no grade-by-score (resolved=null). A drive
 * returning a NON-scored stopReason (error/timeout/infra-failed) → that telemetry's attempt + a resolved=null
 * grade (excluded). A scored drive (done/escalate/budget-exhausted/max-turns) → the task's score() runs and
 * resolved = score ≥ threshold. The container is torn down in `finally` regardless.
 */
export async function runOneMetrHcastTask(
  ops: MetrHcastRunnerOps,
  input: { task: BenchTask; arm: string; budget: GenerationBudget; seed: string; workspaceId: string },
): Promise<MetrHcastTaskResult> {
  const { task, arm, budget, seed, workspaceId } = input;
  const version = typeof task.graderMeta?.['version'] === 'string' ? (task.graderMeta['version'] as string) : 'task-standard';
  const humanMinutes = humanMinutesFor(task);

  let env: MetrHcastTaskEnv;
  try {
    env = await ops.prepareTask({ task, workspaceId });
  } catch (e) {
    return {
      attempt: errorAttempt(arm, task, seed, 'error', `prepareTask failed: ${errMsg(e)}`),
      grade: infraGrade(task, seed, version, `prepareTask failed: ${errMsg(e)}`),
      humanMinutes,
    };
  }

  try {
    let drive: MetrHcastDriveResult;
    try {
      drive = await ops.driveArm({ task, env, arm, budget, seed, workspaceId });
    } catch (e) {
      return {
        attempt: errorAttempt(arm, task, seed, 'infra-failed', `driveArm threw: ${errMsg(e)}`),
        grade: infraGrade(task, seed, version, `driveArm threw: ${errMsg(e)}`),
        humanMinutes,
      };
    }

    const attempt = attemptFromTelemetry(arm, task, seed, env, drive.telemetry);

    // Only a SCORED terminal is graded; a non-scored (infra) terminal is excluded (resolved=null).
    if (!isScoredStopReason(drive.telemetry.stopReason)) {
      return {
        attempt,
        grade: infraGrade(task, seed, version, drive.telemetry.generationError ?? `non-scored stop: ${drive.telemetry.stopReason}`),
        humanMinutes,
      };
    }

    let scoreRes: MetrHcastScoreResult;
    try {
      scoreRes = await ops.score({ env, submission: drive.submission, workspaceId });
    } catch (e) {
      // Scoring infra failure (image/score crash) → resolved=null, excluded (NOT a capability fail).
      return { attempt, grade: infraGrade(task, seed, version, `score failed: ${errMsg(e)}`), humanMinutes };
    }

    const threshold = scoreThresholdFor(task);
    const resolved = scoreRes.score === null ? null : scoreRes.score >= threshold;
    return {
      attempt,
      grade: {
        instanceId: task.instanceId,
        prefix: seed,
        resolved,
        score: scoreRes.score,
        graderFamily: 'metr-hcast',
        graderVersion: version,
        rawGraderOutput: scoreRes.raw,
        ...(scoreRes.score === null ? { graderError: 'score() returned null/None' } : {}),
      },
      humanMinutes,
    };
  } finally {
    await ops.teardownTask({ env, workspaceId }).catch(() => {});
  }
}

/**
 * Run a backlog of METR HCAST tasks for ONE arm through a bounded concurrency POOL (size = the fleet cap),
 * never throwing — each task yields a {@link MetrHcastTaskResult} (an error attempt on failure). Mirrors the
 * su-independent / TheAgentCompany pool. Returns results in completion order; the caller folds them into the
 * horizon fit (per arm) + the run-result rows.
 */
export async function runMetrHcastBacklog(
  ops: MetrHcastRunnerOps,
  input: {
    backlog: BenchTask[];
    arm: string;
    budget: GenerationBudget;
    seed: string;
    workspaceId: string;
    /** Fired the instant each task settles — so a partial/killed run still BANKS its completed rows (P-005:
     *  opus only opens in brief windows; incremental persistence lets every window accumulate toward the fit). */
    onResult?: (r: MetrHcastTaskResult) => void | Promise<void>;
  },
): Promise<MetrHcastTaskResult[]> {
  const { backlog, arm, budget, seed, workspaceId, onResult } = input;
  const cap = Math.max(1, Math.floor(await ops.concurrencyCap()) || 1);
  const results: MetrHcastTaskResult[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      if (i >= backlog.length) return;
      next += 1;
      const r = await runOneMetrHcastTask(ops, { task: backlog[i], arm, budget, seed, workspaceId });
      results.push(r);
      if (onResult) await onResult(r);
    }
  };

  const poolSize = Math.max(1, Math.min(cap, backlog.length || 1));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}
