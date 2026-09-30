/**
 * Modality-1 (offline diff-batch) {@link OfficialGrader} backend for **SWE-bench Verified**
 * (benchmark-arms-su-vs-queen-expansion-2026-06-16 P-006).
 *
 * ⚠ SWE-bench Verified is a SEPARATE ecosystem from SWE-bench Pro — DO NOT reuse the Pro path:
 *   - harness: the ORIGINAL `swebench` pip package — `python -m swebench.harness.run_evaluation`
 *     (NOT `swe_bench_pro_eval.py`, which is the scaleapi Pro harness).
 *   - images:  `docker.io/swebench/sweb.eval.<arch>.<instance_id>:latest` pulled from the `swebench`
 *     DockerHub namespace (NOT `jefzda/sweap-images`). On ARM hosts the harness builds locally
 *     (`--namespace ''`); on x86_64 it pulls the published set.
 *   - predictions: JSONL `{ instance_id, model_name_or_path, model_patch }` (Pro uses
 *     `{ instance_id, patch, prefix }`) — note `model_patch`, not `patch`.
 *   - report: the harness writes `<model_name_or_path>.<run_id>.json` to its cwd, whose
 *     `resolved_ids` list is the verdict (NOT Pro's `eval_results.json` = { id: bool }).
 *
 * Pipeline (identical SHAPE to the Pro / SWE-Lancer M1 graders — that is the fairness invariant):
 *   collect {@link ArmSubmission} diffs → write predictions JSON → run the swebench harness → parse its
 *   report → {@link GradeResult}. `resolved` = the instance is in the harness's `resolved_ids`.
 *
 * Subprocess + fs are INJECTED so this is unit-testable with a fake harness (no Docker / no GB image pulls).
 *
 * HARNESS-NOT-INSTALLED: the `swebench` package is NOT on this host (the Pro venv only has `datasets` +
 * `litellm` + `mini-swe-agent`). Rather than hardcode a guessed CLI that would look authoritative, the eval
 * invocation is a REQUIRED `buildEvalCommand` config (same pattern as the SWE-Lancer grader). The live binding
 * ({@link makeSweBenchVerifiedGrader} via the registry) is real; what's owner-gated is *installing the harness
 * + pulling/building the ~500 images*. {@link assertVerifiedHarnessInstalled} gives callers a clear gate.
 */
import type { ArmSubmission, BenchTask, GradeResult, OfficialGrader } from '../types';
import type { GraderFs, ProcExec } from './swe-bench-pro';

const GRADER_FAMILY = 'swe-bench-verified';

/** The official swebench-harness report (`<model>.<run_id>.json`) — the fields we read for a verdict. */
export interface SweBenchVerifiedReport {
  /** Instance ids the harness judged RESOLVED (FAIL_TO_PASS ∪ PASS_TO_PASS all pass). */
  resolved_ids?: string[];
  /** Instance ids attempted but unresolved. */
  unresolved_ids?: string[];
  /** Instance ids whose grading errored (image pull / apply / timeout) — surfaced, not scored as fail. */
  error_ids?: string[];
  /** Instance ids the predictions file had no patch for. */
  empty_patch_ids?: string[];
  [k: string]: unknown;
}

export interface SweBenchVerifiedGraderConfig {
  /**
   * The SWE-bench checkout / install root where `python -m swebench.harness.run_evaluation` is runnable
   * (i.e. the `swebench` package is importable). cwd for the eval unless `buildEvalCommand` overrides it.
   */
  swebenchDir: string;
  /** The HF dataset name the harness loads (default `princeton-nlp/SWE-bench_Verified`). */
  datasetName?: string;
  /** Run id passed to the harness (`--run_id`); also part of the report filename. Default a timestamp. */
  runId?: string;
  /** The `model_name_or_path` stamped on each prediction + the report filename. Default 'papercusp'. */
  modelName?: string;
  /** Harness concurrency (`--max_workers`). Tune to the grading host. */
  maxWorkers?: number;
  /** Scratch root for the predictions JSON + report (default OS temp). */
  workRoot?: string;
  /**
   * The exact grader version to PIN on every row (pre-registration): the swebench harness commit + the
   * image-set tag. Required so a result is reproducible. e.g. "swebench@<sha> / sweb.eval images 2026-06".
   */
  version: string;
  /**
   * Build the harness invocation from the scratch paths. The swebench CLI is README-authoritative
   * (`python -m swebench.harness.run_evaluation --dataset_name … --predictions_path … --run_id …
   * --max_workers … [--instance_ids …]`) — REQUIRED, not guessed, because the package is not installed on
   * this host to confirm the exact flags/arch handling against. cwd defaults to `swebenchDir`.
   */
  buildEvalCommand: (ctx: {
    predsPath: string;
    runId: string;
    datasetName: string;
    modelName: string;
    maxWorkers: number;
    instanceIds: string[];
  }) => { cmd: string; args: string[]; cwd?: string };
  /**
   * Locate + read the harness report after the run (`<model_name_or_path>.<run_id>.json`, written to the
   * harness cwd by default). REQUIRED because the exact path/name is harness-version-specific. Returns the
   * parsed report (or throws → batch error). `fs.readFile` is available via the closure the grader builds.
   */
  readReport: (ctx: {
    runId: string;
    modelName: string;
    cwd: string;
    readFile: (path: string) => Promise<string>;
  }) => Promise<SweBenchVerifiedReport>;
}

export interface SweBenchVerifiedGraderDeps {
  exec: ProcExec;
  fs: GraderFs;
}

/** A swebench-harness prediction record (note `model_patch` + `model_name_or_path`, NOT Pro's `patch`). */
interface VerifiedPredictionRecord {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

/**
 * Map the harness report's `resolved_ids` onto the submissions. A submission whose id is in `error_ids`
 * (or absent from every list) → `graderError` (ran but no clean verdict = infra failure, NOT a silent fail).
 * RESOLVED = the id is in `resolved_ids`.
 */
export function parseSweBenchVerifiedReport(
  report: SweBenchVerifiedReport,
  submissions: ArmSubmission[],
  version: string,
): GradeResult[] {
  const resolved = new Set(report.resolved_ids ?? []);
  const unresolved = new Set(report.unresolved_ids ?? []);
  const errored = new Set(report.error_ids ?? []);
  const empty = new Set(report.empty_patch_ids ?? []);

  return submissions.map((sub): GradeResult => {
    if (resolved.has(sub.instanceId)) {
      return {
        instanceId: sub.instanceId,
        prefix: sub.prefix,
        resolved: true,
        rawGraderOutput: { resolved: true },
        graderFamily: GRADER_FAMILY,
        graderVersion: version,
      };
    }
    if (unresolved.has(sub.instanceId) || empty.has(sub.instanceId)) {
      return {
        instanceId: sub.instanceId,
        prefix: sub.prefix,
        resolved: false,
        rawGraderOutput: { resolved: false, empty: empty.has(sub.instanceId) },
        graderFamily: GRADER_FAMILY,
        graderVersion: version,
      };
    }
    // In error_ids, or in no list at all → infra failure (image pull / apply / timeout), surfaced not scored.
    const why = errored.has(sub.instanceId)
      ? 'instance in error_ids (image pull / patch apply / test timeout?)'
      : 'no resolved/unresolved/error entry for instance (harness produced no verdict)';
    return {
      instanceId: sub.instanceId,
      prefix: sub.prefix,
      resolved: false,
      rawGraderOutput: { missing: true },
      graderFamily: GRADER_FAMILY,
      graderVersion: version,
      graderError: why,
    };
  });
}

/**
 * Build the live SWE-bench Verified grader. STRUCTURALLY complete + arm-agnostic (the fairness invariant);
 * the eval invocation + report-read are injected via cfg because the `swebench` harness is not installed on
 * this host to confirm the exact CLI against. Throws nothing at build time — a run with no harness fails at
 * `exec` time with the harness's own error, surfaced per-instance as `graderError` (never a silent pass).
 */
export function makeSweBenchVerifiedGrader(
  cfg: SweBenchVerifiedGraderConfig,
  deps: SweBenchVerifiedGraderDeps,
): OfficialGrader {
  const { exec, fs } = deps;
  const datasetName = cfg.datasetName ?? 'princeton-nlp/SWE-bench_Verified';
  const modelName = cfg.modelName ?? 'papercusp';
  const maxWorkers = cfg.maxWorkers ?? 8;
  const workRoot = cfg.workRoot ?? '/tmp';

  return {
    family: GRADER_FAMILY,
    modality: 'diff',
    async grade(submissions: ArmSubmission[], _tasks: BenchTask[]): Promise<GradeResult[]> {
      const diffSubs = submissions.filter(
        (s): s is Extract<ArmSubmission, { modality: 'diff' }> => s.modality === 'diff',
      );
      if (diffSubs.length === 0) return [];

      const runId = cfg.runId ?? `verified-${Date.now()}`;
      const scratch = await fs.mkdtemp(`${workRoot}/swebv-grade-`);
      const predsPath = `${scratch}/predictions.json`;
      try {
        const predictions: VerifiedPredictionRecord[] = diffSubs.map((s) => ({
          instance_id: s.instanceId,
          model_name_or_path: modelName,
          model_patch: s.patch,
        }));
        await fs.writeFile(predsPath, JSON.stringify(predictions));

        const { cmd, args, cwd } = cfg.buildEvalCommand({
          predsPath,
          runId,
          datasetName,
          modelName,
          maxWorkers,
          instanceIds: diffSubs.map((s) => s.instanceId),
        });
        const runCwd = cwd ?? cfg.swebenchDir;
        const { code, stderr } = await exec(cmd, args, { cwd: runCwd });

        let report: SweBenchVerifiedReport = {};
        let readErr: string | undefined;
        try {
          report = await cfg.readReport({ runId, modelName, cwd: runCwd, readFile: (p) => fs.readFile(p) });
        } catch (e) {
          readErr = `could not read SWE-bench Verified report: ${e instanceof Error ? e.message : String(e)}`;
        }

        if (readErr) {
          const detail = code !== 0 ? `${readErr} (harness exit ${code}: ${stderr.slice(0, 500)})` : readErr;
          return diffSubs.map((s) => ({
            instanceId: s.instanceId,
            prefix: s.prefix,
            resolved: false,
            rawGraderOutput: { batchError: detail },
            graderFamily: GRADER_FAMILY,
            graderVersion: cfg.version,
            graderError: detail,
          }));
        }

        return parseSweBenchVerifiedReport(report, diffSubs, cfg.version);
      } finally {
        await fs.rm(scratch).catch(() => {});
      }
    },
  };
}

/**
 * Gate: assert the `swebench` harness is installed + runnable before launching a Verified grade. Callers
 * (the grade trigger / a preflight) invoke this to fail FAST with an actionable message instead of spending.
 * `probe` runs `python -m swebench --help`-style check; default uses the injected exec. NOT called at grader
 * build time (the grader is structurally valid without the harness) — it is the explicit RUN gate.
 */
export async function assertVerifiedHarnessInstalled(
  swebenchDir: string,
  deps: { exec: ProcExec; pythonBin?: string },
): Promise<void> {
  const python = deps.pythonBin ?? 'python3';
  const { code, stderr } = await deps.exec(
    python,
    ['-c', 'import swebench, importlib.util; assert importlib.util.find_spec("swebench.harness.run_evaluation")'],
    { cwd: swebenchDir },
  );
  if (code !== 0) {
    throw new Error(
      'SWE-bench Verified harness not installed — the original `swebench` package is required (NOT the ' +
        'scaleapi SWE-bench_Pro-os harness). Install it with: `pip install swebench` (or clone ' +
        'github.com/SWE-bench/SWE-bench && pip install -e .) into a venv, set its dir as `swebenchDir`, ' +
        `then pull/build the docker.io/swebench/sweb.eval.* images. (probe exit ${code}: ${stderr.slice(0, 200)})`,
    );
  }
}
