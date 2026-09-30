/**
 * {@link OfficialGrader} backend for **TheAgentCompany** (CMU, NeurIPS 2024; arXiv 2412.14161; MIT) —
 * plan `benchmark-suite-theagentcompany-2026-06-17`.
 *
 * UNLIKE the SWE-bench-family graders (apply a unified diff → run tests → boolean resolved), TheAgentCompany
 * is a CHECKPOINT / PARTIAL-CREDIT suite:
 *   - The agent works a simulated company (GitLab + Plane + RocketChat + ownCloud) over a multi-step task and
 *     produces a TRAJECTORY; the workspace END-STATE is what's graded.
 *   - Each task ships its own decoupled `evaluator.py` exposing `grade_checkpoints(trajectory) -> Result`, a
 *     list of `Checkpoint(total, result)` (`result` = points earned, `total` = max points). `eval.py` writes
 *     a `result.json`. The grader is independent of the agent framework — we plug ANY arm in, then grade.
 *
 * SCORE (the published TheAgentCompany metric):
 *   - `partial`  = Σresult / Σtotal              — the completion / partial-credit fraction in [0,1]
 *   - `full`     = (Σresult === Σtotal) ? 1 : 0  — full completion (every point earned)
 *   - `score`    = 0.5·partial + 0.5·full        — the combined headline score in [0,1]
 *   - `resolved` = full === 1                    — the all-or-nothing roll-up (FULLY completed the task)
 * The meaningful suite headline is the MEAN of `score` over scored tasks (NOT pass@1 = the near-zero full
 * rate). `score` rides {@link GradeResult.score}; `resolved` stays the strict full-completion boolean.
 *
 * MODALITY = `in-container`: there is no diff to apply — the env is mutated and graded in place. The grade
 * step runs each task's `eval.py` against the (still-live) task container the arm operated, then reads
 * `result.json`. The eval invocation + the result read are INJECTED (`buildEvalCommand` / `readResult`) —
 * exactly like the SWE-bench Verified grader injects its harness CLI — because the TheAgentCompany eval
 * harness + service stack are NOT installed on this host to hardcode the exact invocation against. The pure
 * scoring math ({@link parseTheAgentCompanyResult} / {@link computeTacScore}) is unit-tested with fixtures,
 * NO docker / NO services.
 */
import type { ArmSubmission, BenchTask, GradeResult, OfficialGrader } from '../types';
import type { GraderFs, ProcExec } from './swe-bench-pro';

const GRADER_FAMILY = 'the-agent-company';

/**
 * One checkpoint from a task's `result.json` — `result` points earned out of `total` possible. Extra fields
 * (the checkpoint's prose `description`, an `agent` note, etc.) are carried through verbatim into
 * `rawGraderOutput` for reproducibility but ignored by the scoring math.
 */
export interface TacCheckpoint {
  /** Max points this checkpoint is worth (> 0 for a real checkpoint). */
  total: number;
  /** Points earned (0..total). */
  result: number;
  [k: string]: unknown;
}

/**
 * A task's decoupled-evaluator output (`result.json`). TheAgentCompany's `eval.py` emits a `Result` = a list
 * of `Checkpoint`. We accept the list under `checkpoints` (canonical) or a bare top-level array, and tolerate
 * a few sibling key spellings seen across task versions (`result`, `checkpoint_results`).
 */
export interface TacResult {
  checkpoints?: TacCheckpoint[];
  /** Some task evaluators key the list as `result`/`checkpoint_results`; accepted as a fallback. */
  result?: TacCheckpoint[];
  checkpoint_results?: TacCheckpoint[];
  [k: string]: unknown;
}

/** The computed score breakdown for one task (all in [0,1] except the raw point sums). */
export interface TacScore {
  /** Σresult / Σtotal — partial-credit completion fraction. 0 when there are no positive-total checkpoints. */
  partial: number;
  /** 1 iff every point was earned (Σresult === Σtotal, Σtotal > 0); else 0. */
  full: 0 | 1;
  /** 0.5·partial + 0.5·full — the combined headline score. */
  score: number;
  /** Σresult across checkpoints. */
  earned: number;
  /** Σtotal across checkpoints. */
  possible: number;
  /** #checkpoints folded in (positive-total only). */
  checkpointCount: number;
}

/** Pull the checkpoint list out of a {@link TacResult} regardless of which key spelling the task used. */
export function extractTacCheckpoints(result: TacResult | TacCheckpoint[] | null | undefined): TacCheckpoint[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  return result.checkpoints ?? result.result ?? result.checkpoint_results ?? [];
}

/**
 * The pure scoring math (the piece most worth getting exactly right). Folds the checkpoint list into the
 * published TheAgentCompany metric. Only checkpoints with a positive `total` count (a 0-total checkpoint is a
 * no-op marker, never inflating the denominator); `result` is clamped to [0, total] defensively so a buggy
 * evaluator can't push the fraction past 1 or below 0.
 */
export function computeTacScore(checkpoints: TacCheckpoint[]): TacScore {
  let earned = 0;
  let possible = 0;
  let count = 0;
  for (const c of checkpoints) {
    const total = Number(c?.total);
    if (!Number.isFinite(total) || total <= 0) continue; // skip malformed / 0-total markers
    const raw = Number(c?.result);
    const result = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), total) : 0;
    earned += result;
    possible += total;
    count += 1;
  }
  const partial = possible > 0 ? earned / possible : 0;
  const full: 0 | 1 = possible > 0 && earned >= possible ? 1 : 0;
  return { partial, full, score: 0.5 * partial + 0.5 * full, earned, possible, checkpointCount: count };
}

/**
 * Map one task's `result.json` → a {@link GradeResult}. `score` carries the combined partial-credit metric;
 * `resolved` is the strict full-completion boolean. A result with NO positive-total checkpoints is treated as
 * an infra/grading failure (the evaluator produced no verdict) — `graderError` set, `resolved:false`,
 * `score:null` — so it is surfaced + excluded from accuracy, NEVER silently scored 0 as if the agent failed.
 */
export function parseTheAgentCompanyResult(
  result: TacResult | TacCheckpoint[] | null | undefined,
  instanceId: string,
  prefix: string,
  version: string,
): GradeResult {
  const checkpoints = extractTacCheckpoints(result);
  const s = computeTacScore(checkpoints);

  if (s.checkpointCount === 0 || s.possible <= 0) {
    return {
      instanceId,
      prefix,
      resolved: false,
      score: null,
      rawGraderOutput: { raw: result, note: 'no positive-total checkpoints — evaluator produced no verdict' },
      graderFamily: GRADER_FAMILY,
      graderVersion: version,
      graderError: 'TheAgentCompany result.json had no gradable checkpoints (Σtotal = 0) — eval.py failed?',
    };
  }

  return {
    instanceId,
    prefix,
    resolved: s.full === 1,
    score: s.score,
    rawGraderOutput: {
      partial: s.partial,
      full: s.full,
      score: s.score,
      earned: s.earned,
      possible: s.possible,
      checkpointCount: s.checkpointCount,
      checkpoints,
    },
    graderFamily: GRADER_FAMILY,
    graderVersion: version,
  };
}

export interface TheAgentCompanyGraderConfig {
  /**
   * The exact grader version PINNED on every row (pre-registration): the TheAgentCompany commit + the task
   * image set tag, e.g. "theagentcompany@<sha> / task-images 2026-06". Required — a result must be reproducible.
   */
  version: string;
  /** Scratch root for any temp the eval needs (default OS temp). */
  workRoot?: string;
  /**
   * Build the per-task `eval.py` invocation. TheAgentCompany grades PER TASK (each task image ships its own
   * decoupled evaluator) against the (still-live) container the arm operated — `envRef` identifies it. REQUIRED
   * + injected because the eval harness + service stack are not installed on this host to hardcode the CLI
   * against. cwd defaults to the eval working dir the binding chooses.
   */
  buildEvalCommand: (ctx: {
    instanceId: string;
    /** The arm's mutated-env handle ({@link ArmSubmission} `envRef`) — the task container / trajectory dir. */
    envRef: string;
    /** Where the binding should have `eval.py` write `result.json`. */
    resultOutPath: string;
  }) => { cmd: string; args: string[]; cwd?: string };
  /**
   * Read + parse the `result.json` `eval.py` wrote for one task. REQUIRED because the exact path/format is
   * task-version-specific. Returns the parsed {@link TacResult} (or throws → that task's grade errors).
   */
  readResult: (ctx: {
    instanceId: string;
    resultOutPath: string;
    readFile: (path: string) => Promise<string>;
  }) => Promise<TacResult | TacCheckpoint[]>;
}

export interface TheAgentCompanyGraderDeps {
  exec: ProcExec;
  fs: GraderFs;
}

/**
 * Build the live TheAgentCompany grader. Arm-agnostic (the fairness invariant) — it cannot tell which arm
 * produced a run. For each `in-container` submission it runs that task's `eval.py` against the arm's `envRef`,
 * reads `result.json`, and folds the checkpoints into a {@link GradeResult}. A task whose eval errors (or whose
 * result has no verdict) → `graderError`, surfaced + excluded, never a silent fail. `diff` submissions are
 * ignored (TheAgentCompany is in-container only).
 */
export function makeTheAgentCompanyGrader(
  cfg: TheAgentCompanyGraderConfig,
  deps: TheAgentCompanyGraderDeps,
): OfficialGrader {
  const { exec, fs } = deps;
  const workRoot = cfg.workRoot ?? '/tmp';

  return {
    family: GRADER_FAMILY,
    modality: 'in-container',
    async grade(submissions: ArmSubmission[], _tasks: BenchTask[]): Promise<GradeResult[]> {
      const envSubs = submissions.filter(
        (s): s is Extract<ArmSubmission, { modality: 'in-container' }> => s.modality === 'in-container',
      );
      if (envSubs.length === 0) return [];

      const out: GradeResult[] = [];
      for (const sub of envSubs) {
        const scratch = await fs.mkdtemp(`${workRoot}/tac-grade-`);
        const resultOutPath = `${scratch}/result.json`;
        try {
          const { cmd, args, cwd } = cfg.buildEvalCommand({
            instanceId: sub.instanceId,
            envRef: sub.envRef,
            resultOutPath,
          });
          const { code, stderr } = await exec(cmd, args, { cwd });

          let parsed: TacResult | TacCheckpoint[];
          try {
            parsed = await cfg.readResult({ instanceId: sub.instanceId, resultOutPath, readFile: (p) => fs.readFile(p) });
          } catch (e) {
            const detail =
              `could not read TheAgentCompany result.json for ${sub.instanceId}: ` +
              `${e instanceof Error ? e.message : String(e)}` +
              (code !== 0 ? ` (eval.py exit ${code}: ${stderr.slice(0, 400)})` : '');
            out.push({
              instanceId: sub.instanceId,
              prefix: sub.prefix,
              resolved: false,
              score: null,
              rawGraderOutput: { batchError: detail },
              graderFamily: GRADER_FAMILY,
              graderVersion: cfg.version,
              graderError: detail,
            });
            continue;
          }
          out.push(parseTheAgentCompanyResult(parsed, sub.instanceId, sub.prefix, cfg.version));
        } finally {
          await fs.rm(scratch).catch(() => {});
        }
      }
      return out;
    },
  };
}
