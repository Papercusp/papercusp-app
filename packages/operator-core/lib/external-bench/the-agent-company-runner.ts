/**
 * TheAgentCompany RUNNER (plan benchmark-suite-theagentcompany-2026-06-17 Phase 2, P-004).
 *
 * The generation half for the in-container TheAgentCompany suite — the counterpart of the M1 diff-batch
 * runners (native-harness-runner / single-agent-attempt) but for a suite where the arm mutates a LIVE
 * workspace instead of producing a diff. Per task it: pull the task image → init.sh (reset the 4 services
 * + the NPC bots) → drive OUR opus arm (su-independent first, then hive) against the services +
 * /instruction/task.md → leave the env mutated for grading. It produces the SHARED {@link ArmAttempt}
 * (cost/stop accounting, identical across arms) PLUS an in-container {@link ArmSubmission} whose `envRef`
 * the {@link makeTheAgentCompanyGrader} runs `eval.py` against — so generation and grading stay decoupled
 * exactly like the diff arms (attempt → submission → official grader → run-result row).
 *
 * ARCHITECTURE / GATING. The IO seam ({@link TacRunnerOps}) is INJECTED (the hive-eval live-ports pattern):
 * the orchestration here — per-task lifecycle, the never-throw generation-failure contract, the
 * concurrency-bounded pool, the in-container submission shape — is unit-tested with fakes (NO docker, NO
 * services, NO live arm). The LIVE binding (`prepareTask` = docker pull + init.sh; `driveArm` = the opus arm
 * against the RocketChat/GitLab/Plane/ownCloud workspace tools, P-003; `teardownTask` = container stop) is
 * the host-gated wiring that lands WITH the service stack (D-003: build code now, host later). All NPC + judge
 * models are pointed at opus (owner: "rely on opus"); opus is the only brain in the loop.
 *
 * FAIRNESS / never-throw. A prepare/drive infra failure (image pull, init.sh, a 429 at the arm boundary)
 * → `stopReason:'error'|'infra-failed'` + `generationError`, NO submission (the grader excludes it,
 * resolved=null — METR: retry infra failures, never score them). A clean drive → an in-container submission
 * the grader scores. The env is ALWAYS torn down (finally), pass or fail.
 */
import type {
  ArmAttempt,
  ArmSubmission,
  BenchTask,
  GenerationBudget,
  GenerationStopReason,
  GenerationTelemetry,
} from './types';
import { isScoredStopReason } from './types';

/** The TheAgentCompany blueprint id stamped on the row (the in-container suite, distinct from M1 spines). */
export const TAC_BLUEPRINT_ID = 'the-agent-company';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A live task environment handle — the running task container the arm operates + the grader evaluates. */
export interface TacTaskEnv {
  /** Opaque ref the grader's `eval.py` runs against (container id / name). Becomes {@link ArmSubmission} `envRef`. */
  envRef: string;
  /** The task image that was pulled (provenance for the rollout card / arm_meta). */
  image: string;
}

/** What driving our arm over one task produced (the arm mutated the env in place + wrote a trajectory). */
export interface TacDriveResult {
  /** Cost/stop accounting — SUMMED across every agent + turn (coordination overhead counted, fairness #2). */
  telemetry: GenerationTelemetry;
}

/**
 * The injected IO seam. Every side effect is ONE method so the per-task ordering, the never-throw contract,
 * and the pool semantics all unit-test with fakes. The real binding (`theAgentCompanyRunnerOps`) wires docker
 * + init.sh + the opus arm + the workspace tools via lazy dynamic imports — host-gated.
 */
export interface TacRunnerOps {
  now(): number;
  /** The fleet concurrency cap (= the global `maxSimultaneousAgents`). Read ONCE at run start. */
  concurrencyCap(): number | Promise<number>;
  /** Pull the task image + run init.sh (reset the 4 services + the NPC bots). Returns the live env handle. */
  prepareTask(input: { task: BenchTask; workspaceId: string }): Promise<TacTaskEnv>;
  /**
   * Drive OUR opus arm against the services + `/instruction/task.md` under `budget`, leaving the env mutated.
   * MUST NOT throw a generation failure — return telemetry whose `stopReason` carries it (a genuine infra
   * throw is caught by the runner → an error attempt for this task).
   */
  driveArm(input: {
    task: BenchTask;
    env: TacTaskEnv;
    budget: GenerationBudget;
    seed: string;
    workspaceId: string;
  }): Promise<TacDriveResult>;
  /** Stop + remove the task container (best-effort — never masks the run's outcome). */
  teardownTask(input: { env: TacTaskEnv; workspaceId: string }): Promise<void>;
}

/** One task's generation output: the shared attempt + (when the drive produced a gradable env) its submission. */
export interface TacRunResult {
  attempt: ArmAttempt;
  /** in-container submission the grader runs eval.py against; NULL when generation infra-failed (excluded). */
  submission: ArmSubmission | null;
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
    blueprintId: TAC_BLUEPRINT_ID,
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
    armMeta: { inContainer: true },
  };
}

function attemptFromTelemetry(arm: string, task: BenchTask, seed: string, env: TacTaskEnv, t: GenerationTelemetry): ArmAttempt {
  return {
    arm,
    blueprintId: TAC_BLUEPRINT_ID,
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
    armMeta: { inContainer: true, image: env.image, envRef: env.envRef },
  };
}

/**
 * Run ONE TheAgentCompany task: prepare (pull + init.sh) → drive the arm → produce {attempt, submission}.
 * Never throws. A prepare failure → error attempt, no submission, nothing to tear down. A drive that returns
 * a NON-scored stopReason (error/timeout/infra-failed) → that telemetry's attempt, NO submission (the grader
 * excludes it). A scored drive (done/escalate/budget-exhausted/max-turns) → an in-container submission the
 * grader will eval.py. The env is torn down in `finally` regardless.
 */
export async function runOneTacTask(
  ops: TacRunnerOps,
  input: { task: BenchTask; arm: string; budget: GenerationBudget; seed: string; workspaceId: string },
): Promise<TacRunResult> {
  const { task, arm, budget, seed, workspaceId } = input;

  let env: TacTaskEnv;
  try {
    env = await ops.prepareTask({ task, workspaceId });
  } catch (e) {
    return {
      attempt: errorAttempt(arm, task, seed, 'error', `prepareTask failed: ${errMsg(e)}`),
      submission: null,
    };
  }

  try {
    let drive: TacDriveResult;
    try {
      drive = await ops.driveArm({ task, env, budget, seed, workspaceId });
    } catch (e) {
      // A genuine infra throw during the drive (not the documented telemetry path) → infra-failed, excluded.
      return {
        attempt: errorAttempt(arm, task, seed, 'infra-failed', `driveArm threw: ${errMsg(e)}`),
        submission: null,
      };
    }

    const attempt = attemptFromTelemetry(arm, task, seed, env, drive.telemetry);
    // Only a SCORED terminal yields a gradable submission; a non-scored (infra) terminal is excluded.
    const submission: ArmSubmission | null = isScoredStopReason(drive.telemetry.stopReason)
      ? { modality: 'in-container', instanceId: task.instanceId, envRef: env.envRef, prefix: seed }
      : null;
    return { attempt, submission };
  } finally {
    await ops.teardownTask({ env, workspaceId }).catch(() => {});
  }
}

// NB: the backlog/pool orchestration for TheAgentCompany now lives in `./tac-backlog-driver.ts`
// (`theAgentCompanyBacklogDriver` / `runTheAgentCompanySuiteViaFleet`), built on the SHARED
// `makePoolBacklogDriver` shell so the suite emits the canonical `HiveBacklogResult` and runs on BOTH the
// su-independent and hive arms — superseding the bespoke pool loop that used to live here. This file keeps
// only the per-task unit (`runOneTacTask`), which that driver's `perTask` calls.
