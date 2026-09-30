/**
 * Modality-1 (offline diff-batch) {@link OfficialGrader} backend for SWE-bench Pro (feasibility doc §2).
 * GENERATION is arm-specific; GRADING is this arm-agnostic Docker batch — the fairness invariant.
 *
 * Pipeline: collect {@link ArmSubmission} diffs → write the predictions JSON `[{instance_id, patch, prefix}]`
 * → run the official `swe_bench_pro_eval.py` (it pulls `jefzda/sweap-images:{dockerhub_tag}` per instance,
 * applies the patch, runs the repo tests via `run_scripts/`) → parse its report → {@link GradeResult}.
 * `resolved` = all FAIL_TO_PASS pass AND all PASS_TO_PASS still pass (inherited SWE-bench rule).
 *
 * Subprocess + fs are INJECTED so this is unit-testable with a fake eval (no Docker / no GB image pulls).
 * ⚠ The exact report layout written by `swe_bench_pro_eval.py` is parsed defensively in
 * {@link parseSweBenchProReport}; confirm the keys against a first real run (BRIEF 1 / P-001's images).
 */
import type { ArmSubmission, BenchTask, GradeResult, OfficialGrader } from '../types';

/** Run a subprocess; resolve with its captured streams + exit code (never reject on a non-zero exit). */
export type ProcExec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Minimal fs the grader needs (injected for tests). */
export interface GraderFs {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  rm(path: string): Promise<void>;
}

export interface SweBenchProGraderConfig {
  /** Dir holding `swe_bench_pro_eval.py` + `run_scripts/` (the `scaleapi/SWE-bench_Pro-os` checkout). */
  evalRepoDir: string;
  /** The raw sample CSV the eval reads (`swe_bench_pro_full.csv`). */
  rawSamplePath: string;
  /** Docker Hub user that hosts the per-instance images (`jefzda`). */
  dockerhubUsername?: string;
  /** Grader concurrency (`--num_workers`). Tune to the grading host. */
  numWorkers?: number;
  /** Grade on LOCAL Docker (`--use_local_docker`); the eval otherwise targets Modal cloud. Default true. */
  useLocalDocker?: boolean;
  /** Python interpreter (default `python3`). */
  pythonBin?: string;
  /** Scratch root for predictions JSON + output_dir (default OS temp). */
  workRoot?: string;
  /**
   * The exact grader version to PIN on every row (pre-registration, P-010): the image-set tag / eval-repo
   * commit. Required so a result is reproducible. e.g. "sweap-images@2026-05 / SWE-bench_Pro-os@<sha>".
   */
  version: string;
}

export interface SweBenchProGraderDeps {
  exec: ProcExec;
  fs: GraderFs;
}

const GRADER_FAMILY = 'swe-bench-pro';

interface PredictionRecord {
  instance_id: string;
  patch: string;
  prefix: string;
}

/**
 * The eval's aggregate verdict file `eval_results.json` = { instance_id: resolvedBool } — CONFIRMED against
 * the real harness (`swe_bench_pro_eval.py` writes it once at output_dir; `resolved` = (FAIL_TO_PASS ∪
 * PASS_TO_PASS) ⊆ passed tests, read from the CSV). Keyed by instance_id ONLY → a multi-seed batch must run
 * ONE eval per prefix (separate output_dir) or the last prefix overwrites. Per-test detail lives in the
 * per-instance `<uid>/<prefix>_output.json` (optional rollout enrichment — not needed for `resolved`).
 */
export type SweBenchProEvalResults = Record<string, boolean>;

/** Map eval_results.json onto the submissions. A missing instance → graderError (ran but produced no verdict). */
export function parseSweBenchProReport(
  report: SweBenchProEvalResults,
  submissions: ArmSubmission[],
  version: string,
): GradeResult[] {
  return submissions.map((sub): GradeResult => {
    const v = report[sub.instanceId];
    if (typeof v !== 'boolean') {
      return {
        instanceId: sub.instanceId,
        prefix: sub.prefix,
        resolved: false,
        rawGraderOutput: { missing: true },
        graderFamily: GRADER_FAMILY,
        graderVersion: version,
        graderError: 'no eval_results.json entry for instance (image pull / eval failure?)',
      };
    }
    return {
      instanceId: sub.instanceId,
      prefix: sub.prefix,
      resolved: v,
      rawGraderOutput: { resolved: v },
      graderFamily: GRADER_FAMILY,
      graderVersion: version,
    };
  });
}

export function makeSweBenchProGrader(cfg: SweBenchProGraderConfig, deps: SweBenchProGraderDeps): OfficialGrader {
  const { exec, fs } = deps;
  const pythonBin = cfg.pythonBin ?? 'python3';
  const dockerhubUsername = cfg.dockerhubUsername ?? 'jefzda';
  const numWorkers = cfg.numWorkers ?? 16;
  const workRoot = cfg.workRoot ?? '/tmp';

  return {
    family: GRADER_FAMILY,
    modality: 'diff',
    async grade(submissions: ArmSubmission[], _tasks: BenchTask[]): Promise<GradeResult[]> {
      const diffSubs = submissions.filter((s): s is Extract<ArmSubmission, { modality: 'diff' }> => s.modality === 'diff');
      if (diffSubs.length === 0) return [];

      const scratch = await fs.mkdtemp(`${workRoot}/swebp-grade-`);
      const predsPath = `${scratch}/predictions.json`;
      const outDir = `${scratch}/out`;
      try {
        const predictions: PredictionRecord[] = diffSubs.map((s) => ({
          instance_id: s.instanceId,
          patch: s.patch,
          prefix: s.prefix,
        }));
        await fs.writeFile(predsPath, JSON.stringify(predictions));

        // Drive grading ONLY through swe_bench_pro_eval.py — never `docker exec bash` (the §2 image note).
        // Default to LOCAL Docker (`--use_local_docker`); the eval otherwise targets Modal cloud.
        const args = [
          'swe_bench_pro_eval.py',
          `--raw_sample_path=${cfg.rawSamplePath}`,
          `--patch_path=${predsPath}`,
          `--output_dir=${outDir}`,
          '--scripts_dir=run_scripts',
          `--num_workers=${numWorkers}`,
          `--dockerhub_username=${dockerhubUsername}`,
        ];
        if (cfg.useLocalDocker !== false) args.push('--use_local_docker');
        const { code, stderr } = await exec(pythonBin, args, { cwd: cfg.evalRepoDir });

        // The eval writes ONE aggregate `eval_results.json` = { instance_id: bool } at output_dir.
        let report: SweBenchProEvalResults = {};
        let readErr: string | undefined;
        try {
          report = JSON.parse(await fs.readFile(`${outDir}/eval_results.json`)) as SweBenchProEvalResults;
        } catch (e) {
          readErr = `could not read grader eval_results.json: ${e instanceof Error ? e.message : String(e)}`;
        }

        if (readErr) {
          // The whole batch failed to produce a report — every instance is an infra failure (not "unresolved").
          const detail = code !== 0 ? `${readErr} (eval exit ${code}: ${stderr.slice(0, 500)})` : readErr;
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

        return parseSweBenchProReport(report, diffSubs, cfg.version);
      } finally {
        await fs.rm(scratch).catch(() => {});
      }
    },
  };
}
