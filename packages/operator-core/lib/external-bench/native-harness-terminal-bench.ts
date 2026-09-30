/**
 * Baseline B — native harness on Terminal-Bench (M2, online in-container), P-007 / BRIEF 5.
 *
 * The feasibility spike's gift (D-008 §3): Harbor SHIPS a first-class built-in `--agent claude-code`
 * adapter, so Baseline B on Terminal-Bench is nearly free — we don't build a custom agent, we just
 * drive Harbor with its own claude-code agent and read the result. Unlike M1 (we produce a diff, a
 * SEPARATE grader scores it), Harbor runs the agent AND the in-container verifier itself, so ONE
 * Harbor invocation yields BOTH the generation telemetry AND the grade.
 *
 * SCOPE (this file = a typed scaffold + a pure result parser, M2 is "build second"): the real
 * `runHarbor` (a `harbor run -d terminal-bench@2.0 --agent claude-code` subprocess) needs Harbor
 * (`uv`) + Docker, which the pilot's M2 phase wires on a dedicated grading host — that binding is
 * DEFERRED and injected as a port. Everything here is unit-tested with a fake `runHarbor`, and the
 * parser is exercised against Harbor's documented result shape. Confirm the exact Harbor result
 * field names against the live framework when wiring the real port (P-009 M2 phase).
 */
import type {
  ArmAttempt,
  ArmSubmission,
  BenchTask,
  GenerationBudget,
  GradeResult,
} from './types';
import { BASELINE_B_ARM } from './native-harness-config';

/** `blueprintId` for the Harbor-driven native arm — documents the harness, not a Papercusp spine. */
export const HARBOR_BLUEPRINT_ID = 'native-claude-code-harbor';

/** What `harbor run --agent claude-code` is invoked with for ONE Terminal-Bench task. */
export interface HarborRunSpec {
  /** Harbor dataset id, e.g. 'terminal-bench@2.0'. */
  datasetId: string;
  /** The task instance to run within the dataset. */
  taskId: string;
  /** Held-constant model id (same as the Papercusp arm). */
  model: string;
  /** Always Harbor's built-in adapter for Baseline B. */
  agent: 'claude-code';
  /** Reproducibility seed (Harbor run discriminator). */
  seed: string;
  /** Wall-clock ceiling (ms) — the only iso-budget lever on the native CLI (see M1 runner header). */
  maxWallClockMs?: number;
}

/** Normalized slice of Harbor's per-task result JSON (the fields we fold into the run-result row). */
export interface HarborResult {
  /** Harbor's pass/fail for the task → `GradeResult.resolved`. */
  resolved: boolean;
  /** True when Harbor itself reported an infra failure (image build, timeout) rather than a clean fail. */
  graderError?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  turns?: number;
  wallClockMs?: number;
  /** Harbor's trajectory artifact path / handle for this run, if any. */
  trajectoryRef?: string;
  /** e.g. 'terminal-bench@2.0' + harbor version — pinned for pre-registration. */
  harborVersion: string;
  /** The Harbor result JSON, stored VERBATIM (Rollout-Cards reproducibility). */
  raw: unknown;
}

/**
 * The injected Harbor seam. Production binds a `harbor run -d <dataset> --agent claude-code
 * --model <model> -t <taskId>` subprocess (DEFERRED — needs Harbor/uv + Docker; wired on the
 * grading host in the pilot's M2 phase). Tests pass a fake.
 */
export type RunHarbor = (spec: HarborRunSpec) => Promise<HarborResult>;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Parse a raw Harbor per-task result object into the normalized {@link HarborResult}. Tolerant of
 * the documented field aliases (`resolved`/`passed`/`is_resolved`; `usage.input_tokens`;
 * `total_cost_usd`; `num_turns`; `duration_ms`) so a minor Harbor schema drift doesn't break the
 * arm. Pure — unit-tested without Docker. NB: confirm the live field names when the real port lands.
 */
export function parseHarborResult(raw: unknown, harborVersion: string): HarborResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const usage = (r['usage'] ?? {}) as Record<string, unknown>;
  const resolvedRaw = r['resolved'] ?? r['passed'] ?? r['is_resolved'];
  const errStr = typeof r['error'] === 'string' ? (r['error'] as string) : undefined;
  return {
    resolved: resolvedRaw === true,
    ...(errStr ? { graderError: errStr } : {}),
    tokensIn: num(usage['input_tokens']) ?? num(r['tokens_in']),
    tokensOut: num(usage['output_tokens']) ?? num(r['tokens_out']),
    costUsd: num(r['total_cost_usd']) ?? num(r['cost_usd']),
    turns: num(r['num_turns']) ?? num(r['turns']),
    wallClockMs: num(r['duration_ms']) ?? num(r['wall_clock_ms']),
    trajectoryRef: typeof r['trajectory_path'] === 'string' ? (r['trajectory_path'] as string) : undefined,
    harborVersion,
    raw,
  };
}

/** Result of running the native harness on ONE Terminal-Bench task via Harbor (gen + grade together). */
export interface NativeTerminalBenchResult {
  /** The shared generation unit (in-container: no diff). */
  attempt: ArmAttempt;
  /** The in-container submission record (env handle = the Harbor run ref). */
  submission: ArmSubmission;
  /** Harbor IS the grader for M2 — the grade comes back with the generation. */
  grade: GradeResult;
  model: string;
  harnessVersion: string;
  armMeta: Record<string, unknown>;
}

/**
 * Run Baseline B on one Terminal-Bench task via Harbor's built-in claude-code agent. Returns the
 * generation {@link ArmAttempt} (in-container modality, empty diff) + the {@link GradeResult} Harbor
 * produced in-sandbox. Infra failures from Harbor surface as `stopReason:'error'` / `graderError`
 * (excluded from accuracy), never thrown.
 */
export async function runNativeHarnessTerminalBench(
  task: BenchTask,
  seed: string,
  budget: GenerationBudget,
  ports: { runHarbor: RunHarbor; harborVersion?: string; now?: () => number },
): Promise<NativeTerminalBenchResult> {
  const now = ports.now ?? Date.now;
  const startedAt = now();
  const harborVersion = ports.harborVersion ?? 'terminal-bench@2.0';
  const envRef = `harbor:${task.instanceId}:${seed}`;

  let result: HarborResult | undefined;
  let runError: string | undefined;
  try {
    result = await ports.runHarbor({
      datasetId: typeof task.graderMeta?.['datasetId'] === 'string'
        ? (task.graderMeta['datasetId'] as string)
        : 'terminal-bench@2.0',
      taskId: task.instanceId,
      model: DEFAULT_TB_MODEL,
      agent: 'claude-code',
      seed,
      ...(budget.maxWallClockMs ? { maxWallClockMs: budget.maxWallClockMs } : {}),
    });
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e);
  }

  const wallClockMs = result?.wallClockMs ?? now() - startedAt;
  const failedInfra = runError !== undefined || result === undefined || result.graderError !== undefined;

  const attempt: ArmAttempt = {
    arm: BASELINE_B_ARM,
    blueprintId: HARBOR_BLUEPRINT_ID,
    instanceId: task.instanceId,
    seed,
    diff: '', // M2 is in-container — there is no diff
    tokensIn: result?.tokensIn ?? 0,
    tokensOut: result?.tokensOut ?? 0,
    costUsd: result?.costUsd ?? 0,
    turns: result?.turns ?? 0,
    wallClockMs,
    trajectoryRef: result?.trajectoryRef ?? '',
    stopReason: failedInfra ? 'error' : 'done',
    ...(failedInfra ? { generationError: runError ?? result?.graderError ?? 'harbor run failed' } : {}),
  };

  const submission: ArmSubmission = { modality: 'in-container', instanceId: task.instanceId, envRef, prefix: seed };

  const grade: GradeResult = {
    instanceId: task.instanceId,
    prefix: seed,
    // Harbor grades in-sandbox; an infra failure → not a genuine fail (resolved stays false but
    // graderError flags it so the scoring lib excludes it from accuracy, per P-011/METR).
    resolved: result?.resolved ?? false,
    rawGraderOutput: result?.raw ?? null,
    graderFamily: 'terminal-bench',
    graderVersion: harborVersion,
    ...(failedInfra ? { graderError: runError ?? result?.graderError ?? 'harbor run failed' } : {}),
  };

  return {
    attempt,
    submission,
    grade,
    model: DEFAULT_TB_MODEL,
    harnessVersion: harborVersion,
    armMeta: {
      backend: 'claude-code',
      harness: 'native',
      via: 'harbor',
      modality: 'in-container',
      elicitation: 'native-best',
      ...(budget.maxWallClockMs ? { budgetMaxWallClockMs: budget.maxWallClockMs } : {}),
    },
  };
}

/** Default model for the TB scaffold; the pilot pins the same id as the Papercusp/M1 arms. */
const DEFAULT_TB_MODEL = 'claude-opus-4-8';
