/**
 * BOUNDED HIVE-vs-QUEEN-ABLATED COMPARISON (impartial-benchmark-suite-2026-06-15 / P-032).
 * Drives ONE arm (XBENCH_ARM=hive|queen-ablated) over the SAME fixed ~11-task SWE-bench Pro
 * public set through the full runHiveBacklog driver, collects per-task diff/cost/tokens/turns
 * + the coordEvents trace, and writes a per-arm result JSON. Grading is a SEPARATE step
 * (_xbench_grade.py over the written diffs) so generation + grading are decoupled/resumable.
 *
 * NOT a committed test (spends real model budget) — a throwaway launcher under lib/external-bench
 * so the workspace-relative imports resolve. Removed after the run.
 *
 * Repos are extracted from the cached jefzda/sweap-images:<tag> (the repo @ base_commit lives at
 * /app) into a local git dir, and each BenchTask.repo points at that local path → git clone --local
 * (no GitHub dependency, exact base_commit guaranteed). Run with:
 *   PAPERCUSP_HONO_PORT=3170 PAPERCUSP_FLEET_SANDBOX=0 PAPERCUSP_SPAWN_BACKEND=claude-code \
 *   AGENT_CMD="claude -p" XBENCH_ARM=hive  npx tsx _xbench_compare.ts
 */
import { readFileSync } from 'node:fs';
import { bindLiveHiveBacklog } from './hive-backlog-live';
import { runHiveBacklog, HIVE_ARM, QUEEN_ABLATED_ARM } from './hive-backlog';
import { resolveBenchWorkspace } from './bench-workspace';
import type { BenchTask } from './types';

const WORKSPACE_ID = resolveBenchWorkspace(process.env.XBENCH_WORKSPACE_ID);
const ARM = (process.env.XBENCH_ARM ?? HIVE_ARM) === QUEEN_ABLATED_ARM ? QUEEN_ABLATED_ARM : HIVE_ARM;
const SAMPLE = process.env.XBENCH_SAMPLE ?? '/tmp/xbench-sample.jsonl';
const REPOS_ROOT = process.env.XBENCH_REPOS_ROOT ?? '/tmp/xbench-repos';
const OUT_DIR = process.env.XBENCH_OUT_DIR ?? '/tmp/xbench-compare-out';
const MAX_USD_PER_TASK = Number(process.env.XBENCH_MAX_USD ?? 6);
const MAX_TOKENS_PER_TASK = Number(process.env.XBENCH_MAX_TOKENS ?? 3_000_000);

interface Row {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  fail_to_pass: string; // str-encoded python list
  selected_test_files_to_run?: string; // str-encoded python list
  language?: string;
}

function pyList(s: string | undefined): string[] {
  if (!s) return [];
  // The dataset encodes these as Python list literals. Parse defensively.
  try {
    const j = s.replace(/'/g, '"');
    const v = JSON.parse(j);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function dockerhubTag(instanceId: string, repo: string): string {
  // Mirror helper_code/image_uri.get_dockerhub_image_uri tag derivation (the part after the colon).
  const [repoBase, repoNameRaw] = repo.toLowerCase().split('/');
  let repoNameOnly = repoNameRaw;
  let hsh = instanceId.replace(/^instance_/, '');
  if (instanceId === 'instance_element-hq__element-web-ec0f940ef0e8e3b61078f145f34dc40d1938e6c5-vnan') {
    repoNameOnly = 'element-web';
  } else if (repo.toLowerCase().includes('element-hq') && repo.toLowerCase().includes('element-web')) {
    repoNameOnly = 'element';
    if (hsh.endsWith('-vnan')) hsh = hsh.slice(0, -5);
  } else if (hsh.endsWith('-vnan')) {
    hsh = hsh.slice(0, -5);
  }
  let tag = `${repoBase}.${repoNameOnly}-${hsh}`;
  if (tag.length > 128) tag = tag.slice(0, 128);
  return tag;
}

function shortName(instanceId: string): string {
  return instanceId.replace(/^instance_/, '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
}

function loadTasks(): BenchTask[] {
  const lines = readFileSync(SAMPLE, 'utf8').trim().split('\n');
  return lines.map((line) => {
    const r = JSON.parse(line) as Row;
    const localRepo = `${REPOS_ROOT}/${shortName(r.instance_id)}`;
    const testFiles = pyList(r.selected_test_files_to_run);
    return {
      benchmark: 'swe-bench-pro',
      instanceId: r.instance_id,
      problemStatement: r.problem_statement,
      repo: localRepo, // local git dir (extracted from the image) → git clone --local
      baseCommit: r.base_commit,
      language: r.language,
      graderMeta: {
        dockerhub_tag: dockerhubTag(r.instance_id, r.repo),
        FAIL_TO_PASS: pyList(r.fail_to_pass),
        PASS_TO_PASS: [],
        testFiles, // extractDiff excludes these so the arm can't slip the hidden tests into its patch
      },
    } satisfies BenchTask;
  });
}

async function main() {
  const tasks = loadTasks();
  console.log(`[compare] arm=${ARM} ws=${WORKSPACE_ID} tasks=${tasks.length} operatorPort=${process.env.PAPERCUSP_HONO_PORT ?? '(default :3070)'}`);
  console.log('[compare] instances:');
  for (const t of tasks) console.log(`  - ${t.instanceId} (repo=${t.repo})`);

  bindLiveHiveBacklog({
    workspaceId: WORKSPACE_ID,
    fleetTimeoutMs: Number(process.env.XBENCH_FLEET_TIMEOUT_MS ?? 90 * 60 * 1000),
    pollIntervalMs: Number(process.env.XBENCH_POLL_MS ?? 20_000),
  });

  const budget = { maxUsd: MAX_USD_PER_TASK, maxTokens: MAX_TOKENS_PER_TASK };
  const runId = `xbench-cmp-${ARM}-${Date.now()}`;
  const startedAt = Date.now();
  console.log(`[compare] runId=${runId} budget/task=${JSON.stringify(budget)} starting ${new Date().toISOString()}`);

  const result = await runHiveBacklog({ arm: ARM, suite: 'swe-bench-pro', runId, seed: 1, backlog: tasks, budget });
  const wallMs = Date.now() - startedAt;

  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(`${OUT_DIR}/diffs-${ARM}`, { recursive: true });

  // Per-task summary + dump each diff to a file for the grader step.
  const perTask = result.taskResults.map((tr) => {
    const a = tr.attempt;
    const diff = a.diff ?? '';
    const diffPath = `${OUT_DIR}/diffs-${ARM}/${a.instanceId}.diff`;
    writeFileSync(diffPath, diff, 'utf8');
    return {
      instanceId: a.instanceId,
      cupId: tr.cupId,
      disposition: tr.disposition,
      stopReason: a.stopReason,
      generationError: a.generationError ?? null,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      costUsd: a.costUsd,
      turns: a.turns,
      wallClockMs: a.wallClockMs,
      diffBytes: Buffer.byteLength(diff, 'utf8'),
      armMeta: a.armMeta ?? null,
    };
  });

  const totalCost = perTask.reduce((s, t) => s + (t.costUsd || 0), 0);
  const totalTokIn = perTask.reduce((s, t) => s + (t.tokensIn || 0), 0);
  const totalTokOut = perTask.reduce((s, t) => s + (t.tokensOut || 0), 0);
  const nonEmptyDiffs = perTask.filter((t) => t.diffBytes > 0).length;

  const out = {
    arm: ARM,
    runId,
    runError: result.runError ?? null,
    startedAt: new Date(startedAt).toISOString(),
    wallMs,
    peakConcurrentBees: result.peakConcurrentBees,
    taskCount: perTask.length,
    nonEmptyDiffs,
    totals: { costUsd: totalCost, tokensIn: totalTokIn, tokensOut: totalTokOut },
    perTask,
    coordEvents: result.coordEvents,
  };
  writeFileSync(`${OUT_DIR}/${ARM}.json`, JSON.stringify(out, null, 2), 'utf8');

  console.log('\n===== ARM RUN SUMMARY =====');
  console.log(JSON.stringify({ arm: ARM, runId, runError: out.runError, wallMs, peakConcurrentBees: out.peakConcurrentBees, taskCount: out.taskCount, nonEmptyDiffs, totals: out.totals, coordEventCount: result.coordEvents.length }, null, 2));
  console.log(`\n[compare] wrote ${OUT_DIR}/${ARM}.json + ${perTask.length} diffs under diffs-${ARM}/`);
  // NOT process.exit(): it does not drain an async pipe write, so piping this summary
  // would truncate the JSON above. See scripts/check-undrained-stdout-exit.mjs.
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('[compare] FATAL', e instanceof Error ? e.stack : e);
  process.exit(1);
});
