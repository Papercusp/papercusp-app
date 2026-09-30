/**
 * 3rd-party export bundle (benchmark-evaluation-ui-2026-06-16 P-013).
 *
 * Assembles, from a run's on-disk snapshot, a self-contained bundle a third party
 * can use to REPRODUCE the resolved verdicts with the PUBLIC swe_bench_pro_eval +
 * public images, with zero access to our harness:
 *   - predictions.json  : [{ instance_id, patch, prefix }] (the graded submission)
 *   - taskIds           : the instance-id list
 *   - regradeCommand    : the EXACT official re-grade command
 *   - readme            : how to reproduce + the honest caveats
 * Also the shape needed for a SWE-bench Pro / SEAL leaderboard submission. Mirrors
 * the README written into the preserved m3 dir.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBenchResultsDir, resolveArmFile, type PreservedArmRun } from './preserved-runs';

export interface ExportPrediction {
  instance_id: string;
  patch: string;
  prefix: string;
}

export interface ExportBundle {
  runId: string;
  arm: string;
  taskCount: number;
  nonEmptyPatches: number;
  taskIds: string[];
  predictions: ExportPrediction[];
  regradeCommand: string;
  readme: string;
}

function regradeCommandFor(arm: string): string {
  return [
    '# Reproduce the resolved verdicts with the PUBLIC official grader + public images.',
    '# Unpack this bundle (predictions.json + tasks-sample.jsonl) into a directory, then:',
    'cd ~/.papercusp/bench-harnesses/SWE-bench_Pro-os   # the public SWE-bench_Pro-os checkout',
    '.venv/bin/python swe_bench_pro_eval.py \\',
    '  --raw_sample_path=<bundle>/tasks-sample.jsonl \\',
    '  --patch_path=<bundle>/predictions.json \\',
    '  --output_dir=/tmp/regrade --scripts_dir=run_scripts \\',
    '  --num_workers=4 --dockerhub_username=jefzda --use_local_docker',
    `# Verdicts → /tmp/regrade/eval_results.json (instance_id → resolved). Arm: ${arm}.`,
  ].join('\n');
}

function readmeFor(run: PreservedArmRun, arm: string, nonEmpty: number): string {
  const total = run.perTask?.length ?? 0;
  return [
    `# ${run.runId ?? arm} — SWE-bench Pro export bundle`,
    '',
    `Arm: **${arm}**. Tasks: ${total} (${nonEmpty} with a non-empty patch).`,
    run.startedAt ? `Run started: ${run.startedAt}.` : '',
    '',
    '## What this is',
    'A reproducibility bundle: the per-instance patches this arm produced + the exact',
    'public grader command. A third party can verify the resolved verdicts with zero',
    'access to our harness — only the public `swe_bench_pro_eval` + public docker images.',
    '',
    '## Files',
    '- `predictions.json` — `[{ instance_id, patch, prefix }]`, the graded submission.',
    '- `tasks-sample.jsonl` — the task set (the grader\'s `--raw_sample_path`).',
    '',
    '## Reproduce the grade',
    '```bash',
    regradeCommandFor(arm),
    '```',
    '',
    '## Caveats (integrity — see plan D-027)',
    '- Empty diffs (no patch) score as UNRESOLVED, never silently dropped.',
    '- Model: opus; verify no sonnet/haiku leak in the source run before trusting the number.',
    '- A subset is indicative, not the full ~731-task set; a single seed has uncaptured variance.',
    '- The number is only as honest as these caveats — do not present it cleaner than they are.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Build the export bundle from a run's on-disk snapshot. null if the snapshot is
 *  missing (a UI run writes it on completion; a preserved/imported run already has it). */
export function buildExportBundle(runId: string, opts: { baseDir?: string } = {}): ExportBundle | null {
  const baseDir = opts.baseDir ?? defaultBenchResultsDir();
  const dir = join(baseDir, runId);
  const arm = resolveArmFile(dir);
  if (!arm) return null;
  const armPath = join(dir, `${arm}.json`);
  if (!existsSync(armPath)) return null;

  let run: PreservedArmRun;
  try {
    run = JSON.parse(readFileSync(armPath, 'utf8')) as PreservedArmRun;
  } catch {
    return null;
  }
  const perTask = run.perTask ?? [];
  const diffsDir = join(dir, `diffs-${arm}`);
  const predictions: ExportPrediction[] = perTask.map((t) => {
    const dp = join(diffsDir, `${t.instanceId}.diff`);
    const patch = existsSync(dp) ? readFileSync(dp, 'utf8') : '';
    return { instance_id: t.instanceId, patch, prefix: `arm-${arm}` };
  });
  const nonEmptyPatches = predictions.filter((p) => p.patch.trim().length > 0).length;

  return {
    runId,
    arm,
    taskCount: perTask.length,
    nonEmptyPatches,
    taskIds: perTask.map((t) => t.instanceId),
    predictions,
    regradeCommand: regradeCommandFor(arm),
    readme: readmeFor(run, arm, nonEmptyPatches),
  };
}
