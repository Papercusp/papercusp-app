/**
 * REAL-QUEEN vs NO-QUEEN COMPARISON (impartial-benchmark-suite-2026-06-15 / P-033, Option B).
 *
 * Drives ONE arm (XBENCH_ARM=hive-realqueen|fifo-noqueen) over the SAME fixed SWE-bench Pro public set
 * through the REAL-Queen backlog driver ({@link ./hive-backlog-realqueen.ts}), collects per-task
 * diff/cost/tokens/turns + the coordEvents trace, and writes a per-arm result JSON in the SAME format
 * _xbench_grade.py + _xbench_report.ts already consume (so grading/reporting are unchanged).
 *
 *   - hive-realqueen → ONE hive over the WHOLE backlog, the REAL Queen persona agent wakes and
 *     places/evicts/re-places/briefs/adaptive-wakes. (The treatment.)
 *   - fifo-noqueen   → the SAME boot, the Queen NEVER wakes; scripted FIFO over the same fleet cap.
 *
 * CONTENTION: set the fleet cap (`maxSimultaneousAgents`) << backlog (~5 for ~13 tasks) BEFORE running,
 * via operator:rate_limit_config (or the launcher's RATE_LIMIT_MAX env probe). Both arms share it.
 *
 * OPUS (load-bearing): the bee floor is haiku, the queen floor is sonnet — so the driver process MUST
 * export AGENT_MODELS='{"bee":"opus:xhigh","queen":"opus:xhigh"}' AND use the `opus` CLI alias (claude
 * v2.1.177 runs opus-4-7 for `--model claude-opus-4-8`). VERIFY agent_usage_samples.model before spend.
 *
 * NOT a committed test (spends real model budget) — a throwaway launcher under lib/external-bench so the
 * workspace-relative imports resolve. Run with:
 *   PAPERCUSP_HONO_PORT=3170 PAPERCUSP_FLEET_SANDBOX=0 PAPERCUSP_SPAWN_BACKEND=claude-code \
 *   AGENT_CMD="claude -p" AGENT_MODELS='{"bee":"opus:xhigh","queen":"opus:xhigh"}' \
 *   XBENCH_ARM=hive-realqueen  npx tsx _xbench_realqueen_compare.ts
 */
import { readFileSync } from 'node:fs';
import { bindRealQueenBacklogDriver, dissolveBenchHive, HIVE_REALQUEEN_ARM, FIFO_NOQUEEN_ARM } from './hive-backlog-realqueen';
import { runHiveBacklog, registerFleetPlanner } from './hive-backlog';
import { planFifoPlacement } from './queen-ablation';
import { resolveBenchWorkspace } from './bench-workspace';
import type { BenchTask } from './types';

const WORKSPACE_ID = resolveBenchWorkspace(process.env.XBENCH_WORKSPACE_ID); // dedicated benchmark workspace, never production (plan benchmark-workspace-isolation)
const ARM = (process.env.XBENCH_ARM ?? HIVE_REALQUEEN_ARM) === FIFO_NOQUEEN_ARM ? FIFO_NOQUEEN_ARM : HIVE_REALQUEEN_ARM;
const SAMPLE = process.env.XBENCH_SAMPLE ?? '/tmp/xbench-sample.jsonl';
const REPOS_ROOT = process.env.XBENCH_REPOS_ROOT ?? '/tmp/xbench-repos';
const OUT_DIR = process.env.XBENCH_OUT_DIR ?? '/tmp/xbench-realqueen-out';
const MAX_USD_PER_TASK = Number(process.env.XBENCH_MAX_USD ?? 10);
const MAX_TOKENS_PER_TASK = Number(process.env.XBENCH_MAX_TOKENS ?? 4_000_000);
const MAX_TASKS = process.env.XBENCH_MAX_TASKS ? Number(process.env.XBENCH_MAX_TASKS) : undefined;

// TEARDOWN-ON-EXIT (P-033 Fix 4 — close the D-022 orphan-respin gap). Every hive this launcher creates is
// registered here the instant it exists (the driver's onHiveCreated hook). A SIGTERM/SIGINT (e.g. the
// Anthropic API rate-limit kill) or any process exit dissolves EVERY registered hive — full pot:dissolve
// (Queen wake cleared + every bee subtree cancelled + the gymAutoloop/scoutRoutine learning loops torn
// down), so no orphan re-spins opus after the launcher dies. The driver ALSO tears down on its normal/catch
// path; this is the belt for a SIGKILL-class exit that bypasses the driver entirely. Idempotent.
const createdHives = new Set<string>();
let tearingDown = false;
async function dissolveAllHives(reason: string): Promise<void> {
  if (createdHives.size === 0) return;
  console.warn(`[realqueen] teardown (${reason}): dissolving ${createdHives.size} bench hive(s): ${[...createdHives].join(', ')}`);
  for (const slug of [...createdHives]) {
    try {
      await dissolveBenchHive(slug, WORKSPACE_ID);
      createdHives.delete(slug);
      console.warn(`[realqueen] teardown: dissolved ${slug}`);
    } catch (e) {
      console.warn(`[realqueen] teardown: dissolve ${slug} FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
function installTeardownHandlers(): void {
  const onSignal = (sig: string) => {
    void (async () => {
      if (tearingDown) return;
      tearingDown = true;
      await dissolveAllHives(`signal ${sig}`);
      process.exit(sig === 'SIGINT' ? 130 : 143);
    })();
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  // A fatal uncaught error / rejection must also dissolve before the process dies.
  process.on('uncaughtException', (e) => {
    console.error('[realqueen] uncaughtException', e);
    void (async () => { if (!tearingDown) { tearingDown = true; await dissolveAllHives('uncaughtException'); } process.exit(1); })();
  });
  process.on('unhandledRejection', (e) => {
    console.error('[realqueen] unhandledRejection', e);
    void (async () => { if (!tearingDown) { tearingDown = true; await dissolveAllHives('unhandledRejection'); } process.exit(1); })();
  });
}

interface Row {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  fail_to_pass: string;
  selected_test_files_to_run?: string;
  language?: string;
}

function pyList(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s.replace(/'/g, '"'));
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function dockerhubTag(instanceId: string, repo: string): string {
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
  let tasks = lines.map((line) => {
    const r = JSON.parse(line) as Row;
    const localRepo = `${REPOS_ROOT}/${shortName(r.instance_id)}`;
    return {
      benchmark: 'swe-bench-pro',
      instanceId: r.instance_id,
      problemStatement: r.problem_statement,
      repo: localRepo,
      baseCommit: r.base_commit,
      language: r.language,
      graderMeta: {
        dockerhub_tag: dockerhubTag(r.instance_id, r.repo),
        FAIL_TO_PASS: pyList(r.fail_to_pass),
        PASS_TO_PASS: [],
        testFiles: pyList(r.selected_test_files_to_run),
      },
    } satisfies BenchTask;
  });
  if (MAX_TASKS != null) tasks = tasks.slice(0, MAX_TASKS);
  return tasks;
}

async function main() {
  installTeardownHandlers(); // P-033 Fix 4 — dissolve every created hive on signal/fatal exit.
  const tasks = loadTasks();
  console.log(`[realqueen] arm=${ARM} ws=${WORKSPACE_ID} tasks=${tasks.length} port=${process.env.PAPERCUSP_HONO_PORT ?? '(default)'}`);
  console.log(`[realqueen] AGENT_MODELS=${process.env.AGENT_MODELS ?? '(unset — bees/queen fall to role floor!)'} AGENT_CMD=${process.env.AGENT_CMD ?? '(unset)'}`);
  for (const t of tasks) console.log(`  - ${t.instanceId} (repo=${t.repo})`);

  // CONTENTION CAP (load-bearing — D-019/D-020 fix). The bee-concurrency limit is the global
  // `maxSimultaneousAgents` read via `spawnConcurrencyCeiling()` → `getCachedRateLimitConfig()`, a
  // MODULE-SCOPED per-process cache that propagates only over an IN-PROCESS bus (rate-limit-config.ts:
  // "the bus does NOT cross processes"). There is NO separate per-hive cap (confirmed: no maxBees / wave
  // width / swarm cap in hive/** or fleet/**) — this single number IS the hive's concurrency limit.
  //
  // THE BUG: the real Queen's `cup:spawn` runs in the LONG-RUNNING :3170 host (startHive →
  // fireLaunchBlueprint('hive') → loopback invoke to :3170), NOT in this launcher process. The prior code
  // set the cap only in the LAUNCHER's cache, so :3170's cache stayed at the default 16 — and with 11 bees
  // < 16, admitSpawn admitted them all at once (no contention; the Queen made no sequencing decision). The
  // launcher's writeRateLimitConfig persists to PG but :3170 only reads PG once at boot, and the in-process
  // bus publish doesn't cross to :3170 → the cap never bit.
  //
  // THE FIX: PUT the cap to :3170's own `operator:rate_limit_config` route (auth: loopback) — that handler
  // runs `writeRateLimitConfig` INSIDE the :3170 process, so its cache + governor honor the cap LIVE with no
  // restart (rate-limit-config.ts:8-9). That is the cache the Queen's spawns actually read. We ALSO set it
  // in this launcher's cache (initRateLimitConfig/writeRateLimitConfig) for the FIFO arm, whose executeBatch
  // spawns DO run in-process here. cap << backlog (e.g. 5 over 13+ tasks) → real saturation → the Queen must
  // sequence/evict (her measured value).
  {
    const { writeRateLimitConfig, initRateLimitConfig, getCachedRateLimitConfig } = await import('../rate-limit-config');
    const envMax = process.env.RATE_LIMIT_MAX ? Number(process.env.RATE_LIMIT_MAX) : undefined;
    if (envMax && Number.isFinite(envMax)) {
      await writeRateLimitConfig({ maxSimultaneousAgents: envMax }); // persist + apply to THIS (launcher) cache
    } else {
      await initRateLimitConfig(); // load the persisted operator_rate_limit_config into THIS cache
    }
    const launcherCap = getCachedRateLimitConfig().maxSimultaneousAgents;

    // Propagate the cap to the :3170 host where the Queen spawns bees (the cache that actually gates them).
    const port = process.env.PAPERCUSP_HONO_PORT ?? '3170';
    let hostCap: number | string = '(unchanged)';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/operator/rate-limit-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxSimultaneousAgents: launcherCap }),
      });
      if (res.ok) {
        const body = (await res.json()) as { config?: { maxSimultaneousAgents?: number } };
        hostCap = body.config?.maxSimultaneousAgents ?? '(ok)';
      } else {
        hostCap = `(PUT failed ${res.status})`;
      }
    } catch (e) {
      hostCap = `(PUT error: ${e instanceof Error ? e.message : String(e)})`;
    }
    console.log(
      `[realqueen] fleet cap — launcher cache = ${launcherCap}, :${port} host cache = ${hostCap} ` +
        `(RATE_LIMIT_MAX=${process.env.RATE_LIMIT_MAX ?? '(unset → persisted)'})`,
    );
    if (typeof hostCap === 'number' && hostCap !== launcherCap) {
      console.warn(`[realqueen] WARNING: :${port} host cap (${hostCap}) != intended (${launcherCap}) — contention may not bite`);
    }
  }

  // The FIFO arm needs its scripted planner registered; the real-Queen arm needs none (the Queen places).
  registerFleetPlanner(FIFO_NOQUEEN_ARM, planFifoPlacement);

  // DURABILITY (the rate-limit-kill fix). The Anthropic API intermittently throttles + KILLS the run
  // process; the prior launcher only wrote OUT_DIR after runHiveBacklog returned, so a mid-run kill lost
  // ALL diffs even though every bee's worktree survived on disk. We now persist INCREMENTALLY through the
  // driver's onEnrolled/onTaskCollected hooks: an enrollment manifest (instanceId→clonePath→base→member,
  // so a standalone recovery pass — _xbench_recover.ts — can re-extract from the surviving worktrees) and
  // each task's diff the moment it is collected. A kill now loses nothing recoverable.
  const { writeFileSync: wf, mkdirSync: mkd, appendFileSync: af } = await import('node:fs');
  mkd(OUT_DIR, { recursive: true });
  mkd(`${OUT_DIR}/diffs-${ARM}`, { recursive: true });
  const manifestPath = `${OUT_DIR}/${ARM}.manifest.jsonl`;
  wf(manifestPath, '', 'utf8'); // truncate any stale manifest for this arm

  bindRealQueenBacklogDriver({
    workspaceId: WORKSPACE_ID,
    fleetTimeoutMs: Number(process.env.XBENCH_FLEET_TIMEOUT_MS ?? 120 * 60 * 1000),
    pollIntervalMs: Number(process.env.XBENCH_POLL_MS ?? 20_000),
    onEnrolled: (e) => {
      const row = {
        arm: ARM,
        instanceId: e.task.instanceId,
        member: e.member,
        clonePath: e.clonePath,
        baseCommit: e.checkout.baseCommit,
        testFiles: (e.task.graderMeta?.['testFiles'] as string[] | undefined) ?? [],
      };
      af(manifestPath, JSON.stringify(row) + '\n', 'utf8');
      console.log(`[realqueen] enrolled ${e.task.instanceId} → ${e.clonePath} (base ${e.checkout.baseCommit.slice(0, 8)})`);
    },
    onTaskCollected: (tr) => {
      const a = tr.attempt;
      const diff = a.diff ?? '';
      wf(`${OUT_DIR}/diffs-${ARM}/${a.instanceId}.diff`, diff, 'utf8');
      console.log(`[realqueen] collected ${a.instanceId}: diffBytes=${Buffer.byteLength(diff, 'utf8')} cost=$${(a.costUsd || 0).toFixed(2)} stop=${a.stopReason}`);
    },
    // Register the hive the instant it is minted so the SIGTERM/SIGINT/exit handler can dissolve it even on a
    // rate-limit SIGKILL that bypasses the driver's own teardown (P-033 Fix 4, the D-022 orphan-respin gap).
    onHiveCreated: (hiveHome) => {
      createdHives.add(hiveHome);
      console.log(`[realqueen] hive created + registered for teardown: ${hiveHome}`);
    },
  });

  const budget = { maxUsd: MAX_USD_PER_TASK, maxTokens: MAX_TOKENS_PER_TASK };
  const runId = `xbench-rq-${ARM}-${Date.now()}`;
  const startedAt = Date.now();
  console.log(`[realqueen] runId=${runId} budget/task=${JSON.stringify(budget)} starting ${new Date().toISOString()}`);

  const result = await runHiveBacklog({ arm: ARM, suite: 'swe-bench-pro', runId, seed: 1, backlog: tasks, budget });
  const wallMs = Date.now() - startedAt;

  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(`${OUT_DIR}/diffs-${ARM}`, { recursive: true });

  const perTask = result.taskResults.map((tr) => {
    const a = tr.attempt;
    const diff = a.diff ?? '';
    writeFileSync(`${OUT_DIR}/diffs-${ARM}/${a.instanceId}.diff`, diff, 'utf8');
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
  // FAIRNESS (benchmark-fairness-fix, Priority 2): READ-MODIFY-WRITE the arm snapshot by instanceId so a
  // partial rerun MERGES into the existing perTask instead of clobbering siblings (mirrors the PG
  // upsertBenchRunTask idempotency + run_minisweagent.py:update_preds). taskCount/totals/nonEmptyDiffs are
  // recomputed from the merged set by writeArmSnapshotMerged.
  const { writeArmSnapshotMerged } = await import('./arm-snapshot');
  writeArmSnapshotMerged(`${OUT_DIR}/${ARM}.json`, out);

  console.log('\n===== ARM RUN SUMMARY =====');
  console.log(JSON.stringify({
    arm: ARM, runId, runError: out.runError, wallMs,
    peakConcurrentBees: out.peakConcurrentBees, taskCount: out.taskCount, nonEmptyDiffs,
    totals: out.totals, coordEventCount: result.coordEvents.length,
    coordKinds: tally(result.coordEvents.map((e) => e.kind)),
  }, null, 2));
  console.log(`\n[realqueen] wrote ${OUT_DIR}/${ARM}.json + ${perTask.length} diffs under diffs-${ARM}/`);
  // Belt-and-suspenders (P-033 Fix 4): the driver dissolves on its normal path, but dissolve any hive still
  // registered here (e.g. a teardown that partially failed) so the launcher NEVER exits leaving an orphan.
  await dissolveAllHives('normal-exit');
  process.exit(0);
}

function tally(xs: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}

main().catch((e) => {
  console.error('[realqueen] FATAL', e instanceof Error ? e.stack : e);
  // Dissolve any created hive before dying on a fatal error (P-033 Fix 4 — no orphan re-spin).
  void (async () => {
    if (!tearingDown) { tearingDown = true; await dissolveAllHives('fatal'); }
    process.exit(1);
  })();
});
