/**
 * Grade trigger (benchmark-evaluation-ui-2026-06-16 P-010, D-024).
 *
 * Runs the OFFICIAL grader over a run's collected diffs and persists the per-instance
 * resolved map + resolvedCount/Pct into the operational store (applyGradeMap). Detached
 * + re-gradeable: the run goes status=grading → done. This is the impartial scoring leg.
 *
 * SUITE DISPATCH (P-006): the grader is chosen by the run's `suite`, NOT hardcoded —
 *   - 'swe-bench-pro' (+ unset, the legacy default) → the proven `_xbench_grade.py` path
 *     (`swe_bench_pro_eval.py --use_local_docker`, jefzda images). Proven on flipt (D-024)
 *     + the m3 arm (6/11).
 *   - 'swe-bench-verified' → the ORIGINAL `swebench` harness (`python -m
 *     swebench.harness.run_evaluation`, docker.io/swebench images). The harness is NOT
 *     installed on this host, so this throws a clear `verified_harness_not_installed` error
 *     with the install steps rather than silently grading a Verified run with the Pro
 *     harness (which would mis-resolve every instance). Wiring the real Verified grade is
 *     owner-gated (harness install + ~500 image pulls/builds + budget).
 *
 * The grader fn is injectable so the orchestration is unit-tested without docker.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDb, type DbScope } from './reproducibility/db';
import { applyGradeMap, setBenchRunStatus } from './run-store';
import { defaultBenchResultsDir } from './preserved-runs';

export interface GradeArgs {
  dir: string;
  arm: string;
  sampleJsonl: string;
  /** The run's benchmark suite — selects which official harness grades the diffs. */
  suite: string;
}

export interface GradeDeps {
  scope?: DbScope;
  /** Run the official grader → { instance_id: resolved }. Default: dispatch by suite (Pro python path). */
  grade?: (args: GradeArgs) => Promise<Record<string, boolean>>;
  baseDir?: string;
}

/** Kick a (re-)grade of a run. Sets status=grading, runs the grader DETACHED,
 *  applies the verdict map, then status=done. Returns { runId, done } or an error. */
export async function gradeBenchRun(
  runId: string,
  deps: GradeDeps = {},
): Promise<{ runId: string; done: Promise<void> } | { error: string }> {
  const scope = deps.scope ?? {};
  const { sql, ws } = resolveDb(scope);
  const rows = await sql<{ arm: string; suite: string }[]>`
    SELECT arm, suite FROM harness_shared.bench_runs WHERE id = ${runId} AND workspace_id = ${ws} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { error: 'run_not_found' };

  const baseDir = deps.baseDir ?? defaultBenchResultsDir();
  const dir = join(baseDir, runId);
  const sampleJsonl = join(dir, 'tasks-sample.jsonl');
  const grade = deps.grade ?? runGradeBySuite;
  const suite = row.suite ?? 'swe-bench-pro';

  await setBenchRunStatus(runId, 'grading', {}, scope);

  const done = (async () => {
    try {
      const gradeMap = await grade({ dir, arm: row.arm, sampleJsonl, suite });
      await applyGradeMap(runId, gradeMap, scope);
      await setBenchRunStatus(runId, 'done', {}, scope);
    } catch (e) {
      await setBenchRunStatus(
        runId,
        'error',
        { runError: `grade failed: ${e instanceof Error ? e.message : String(e)}` },
        scope,
      ).catch(() => {});
    }
  })();

  return { runId, done };
}

/**
 * Default grader dispatch — pick the official harness by suite. Pro grades via the proven
 * `_xbench_grade.py` path; Verified is a SEPARATE harness that is NOT installed here, so it throws an
 * actionable error instead of mis-grading a Verified run with the Pro harness (every instance would
 * mis-resolve — the Pro images / FAIL_TO_PASS format don't match Verified instances).
 */
async function runGradeBySuite(args: GradeArgs): Promise<Record<string, boolean>> {
  if (args.suite === 'swe-bench-verified') {
    throw new Error(
      'verified_harness_not_installed: SWE-bench Verified grading needs the ORIGINAL `swebench` harness ' +
        '(`python -m swebench.harness.run_evaluation`, docker.io/swebench/sweb.eval.* images) — NOT the ' +
        'scaleapi SWE-bench_Pro-os harness. To enable: (1) `pip install swebench` into a venv; ' +
        '(2) pull/build the ~500 docker.io/swebench/sweb.eval images (owner-gated: disk + budget); ' +
        '(3) wire the verified grade script (mirror _xbench_grade.py) or inject a `grade` dep that drives ' +
        'makeSweBenchVerifiedGrader. The Verified grader CODE is built (grader/swe-bench-verified.ts) — ' +
        'only the harness install + images + run are owner-gated.',
    );
  }
  return runProGradeScript(args);
}

/** The Pro grader: spawn _xbench_grade.py (official swe_bench_pro_eval +
 *  local docker) and read its eval_results.json verdict map. */
async function runProGradeScript(args: GradeArgs): Promise<Record<string, boolean>> {
  const { dir, arm, sampleJsonl } = args;
  const scriptPath = fileURLToPath(new URL('./_xbench_grade.py', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('python3', [scriptPath, arm], {
      env: { ...process.env, XBENCH_OUT_DIR: dir, XBENCH_SAMPLE: sampleJsonl },
      stdio: 'inherit',
    });
    proc.on('error', reject);
    // The script exits 2 when no verdict was produced; treat only 0 as success.
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`grade script exit ${code}`))));
  });
  const resultsPath = join(dir, `grade-${arm}`, 'out', 'eval_results.json');
  if (!existsSync(resultsPath)) throw new Error('grading produced no eval_results.json');
  const parsed = JSON.parse(readFileSync(resultsPath, 'utf8')) as Record<string, unknown>;
  const map: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(parsed)) map[k] = v === true;
  return map;
}
