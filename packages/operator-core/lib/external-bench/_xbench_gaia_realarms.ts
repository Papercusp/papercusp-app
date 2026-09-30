/**
 * GAIA REAL-ORCHESTRATION ARM LAUNCHER (plan benchmark-suite-gaia-2026-06-17).
 *
 * Drives the 26 GAIA L3 questions through ONE of our two REAL orchestration methods — reusing the SAME
 * backlog drivers the SWE-bench Pro arms use, with the GAIA seam engaged (gaia:{enabled:true}):
 *
 *   XBENCH_GAIA_ARM=su-independent  → N INDEPENDENT su/worker agents, one question each, NO Queen
 *                                     orchestration ({@link ./su-independent-backlog.ts}).
 *   XBENCH_GAIA_ARM=hive-realqueen  → ONE hive over the whole backlog, the REAL Queen persona agent
 *                                     places/evicts/re-places/briefs/adaptive-wakes
 *                                     ({@link ./hive-backlog-realqueen.ts}).
 *
 * The GAIA seam (the THREE SWAPS, identical in both drivers): GAIA scratch-dir clone (no repo), member
 * blueprint `gaia-agent` + the question/answer.txt brief, and `answer.txt` extraction into
 * {@link ArmAttempt.answer} (diff:''). The bee researches with its native web_search/fetch/bash(python)/
 * file tools and writes its final answer to `answer.txt`; the driver reads it back as the qa submission.
 *
 * GRADING: the collected answers are graded inline by the FOUNDATION GAIA grader ({@link gradeGaia} —
 * quasi-exact-match vs the gold answer carried in graderMeta.finalAnswer). Writes predictions.jsonl +
 * report.json under ~/.papercusp/bench-results/gaia/runs/<arm>-l3-<ts>/ — the SAME format the gaia/cli.ts
 * runs write, so the L3 accuracy compares directly to the single-opus L3 baseline (69.2%, 18/26).
 *
 * MODEL PIN (load-bearing, D-004 fairness): the bee/queen role floors are haiku/sonnet, so the CALLER MUST
 * export AGENT_MODELS pinning the relevant roles to opus:xhigh + AGENT_CMD="claude -p". For su-independent
 * pin the pipeline roles (the gaia-agent extends single-agent → its decider is a worker/bee-class role) AND
 * bee; for hive-realqueen pin bee + queen. Belt-and-suspenders: pin them all.
 *   AGENT_MODELS='{"director":"opus:xhigh","scoper":"opus:xhigh","architect":"opus:xhigh","worker":"opus:xhigh","validator":"opus:xhigh","reviewer":"opus:xhigh","documenter":"opus:xhigh","bee":"opus:xhigh","queen":"opus:xhigh","gaia-worker":"opus:xhigh"}'
 * CRITICAL: for hive-realqueen the Queen's cup:spawn is serviced by the long-running :3170 host, so the
 * opus pin + AGENT_CMD MUST also be on :3170's env (apps/operator/.env.local). VERIFY agent_usage_samples.
 * model = claude-opus-4-8 on the 1-task probe before any big spend.
 *
 * CONTENTION CAP: su-independent reads the cap from THIS launcher's cache (writeRateLimitConfig) — the
 * in-process pool. hive-realqueen ALSO needs the cap PUT to :3170's rate_limit_config route (the Queen's
 * spawns run in :3170's cache). Cap from XBENCH_CAP (default 5).
 *
 * 1-task probe (gate the spend — verify a gradeable answer BEFORE the full 26):
 *   XBENCH_GAIA_ARM=su-independent XBENCH_ONLY_IID=<taskId> XBENCH_CAP=1 \
 *   PAPERCUSP_FLEET_SANDBOX=0 PAPERCUSP_SPAWN_BACKEND=claude-code AGENT_CMD="claude -p" \
 *   AGENT_MODELS='{...opus:xhigh all roles...}' \
 *   npx tsx _xbench_gaia_realarms.ts
 *
 * Full 26-task L3 run: drop XBENCH_ONLY_IID, set XBENCH_CAP=5.
 *
 * NOT a committed test (spends real model budget) — a throwaway launcher under lib/external-bench so the
 * workspace-relative imports resolve.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bindSuIndependentBacklogDriver, SU_INDEPENDENT_ARM } from './su-independent-backlog';
import { bindRealQueenBacklogDriver, dissolveBenchHive, HIVE_REALQUEEN_ARM } from './hive-backlog-realqueen';
import { runHiveBacklog } from './hive-backlog';
import { retireBenchDebris, type DebrisSql } from './bench-teardown';
import { loadBenchTaskSet } from './task-sets';
import { gradeGaia, coerceLevel, type GaiaPrediction, type GaiaLevel } from './grader/gaia';
import { resolveBenchWorkspace } from './bench-workspace';
import type { BenchTask } from './types';

type GaiaArm = typeof SU_INDEPENDENT_ARM | typeof HIVE_REALQUEEN_ARM;

const WORKSPACE_ID = resolveBenchWorkspace(process.env.XBENCH_WORKSPACE_ID);
const ARM: GaiaArm = (process.env.XBENCH_GAIA_ARM ?? SU_INDEPENDENT_ARM) === HIVE_REALQUEEN_ARM
  ? HIVE_REALQUEEN_ARM
  : SU_INDEPENDENT_ARM;
const MAX_USD_PER_TASK = Number(process.env.XBENCH_MAX_USD ?? 3);
const MAX_TOKENS_PER_TASK = Number(process.env.XBENCH_MAX_TOKENS ?? 150_000);
const ONLY_IID = process.env.XBENCH_ONLY_IID || undefined; // run EXACTLY one task (cheap probe).
const CAP = Number(process.env.XBENCH_CAP ?? 5);

// The drivers loopback-fetch the operator host for fleet:place_batch; default to STAGING (:3170) where the
// bench code + fixes live (the GREEN :3070 lags). Override-able.
process.env.PAPERCUSP_OPERATOR_BASE ??= 'http://localhost:3170';

// TEARDOWN-ON-EXIT. Both GAIA arms create a temporary shared hive: su-independent uses it for member
// registration/FIFO placement, while hive-realqueen also runs the Queen. Register the slug immediately so
// signal/fatal cleanup can dissolve the exact run's hive rather than leaving an orphan respinning opus.
const createdHives = new Set<string>();
let runPotSlug: string | null = null;
let debrisRetired = false;
let tearingDown = false;
async function dissolveAllHives(reason: string): Promise<void> {
  if (createdHives.size === 0) return;
  console.warn(`[gaia:${ARM}] teardown (${reason}): dissolving ${createdHives.size} hive(s): ${[...createdHives].join(', ')}`);
  for (const slug of [...createdHives]) {
    try {
      await dissolveBenchHive(slug, WORKSPACE_ID);
      createdHives.delete(slug);
    } catch (e) {
      console.warn(`[gaia:${ARM}] teardown: dissolve ${slug} FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Retire only this su-independent run's benchmark items if a signal bypasses driver finalization. */
async function retireSuRunDebris(reason: string): Promise<void> {
  if (ARM !== SU_INDEPENDENT_ARM || debrisRetired || !runPotSlug) return;
  debrisRetired = true;
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const retired = await retireBenchDebris(getOrgPg().sql as unknown as DebrisSql, Date.now(), {
      slugPrefix: runPotSlug,
    });
    console.warn(`[gaia:${ARM}] retired ${retired} work-item(s) for hive '${runPotSlug}' at ${reason}`);
  } catch (e) {
    console.warn(`[gaia:${ARM}] debris retire (${reason}) failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function installTeardownHandlers(): void {
  const onSignal = (sig: string) => {
    void (async () => {
      if (tearingDown) return;
      tearingDown = true;
      await retireSuRunDebris(`signal ${sig}`);
      await dissolveAllHives(`signal ${sig}`);
      process.exit(sig === 'SIGINT' ? 130 : 143);
    })();
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('uncaughtException', (e) => {
    console.error(`[gaia:${ARM}] uncaughtException`, e);
    void (async () => {
      if (!tearingDown) {
        tearingDown = true;
        await retireSuRunDebris('uncaughtException');
        await dissolveAllHives('uncaughtException');
      }
      process.exit(1);
    })();
  });
  process.on('unhandledRejection', (e) => {
    console.error(`[gaia:${ARM}] unhandledRejection`, e);
    void (async () => {
      if (!tearingDown) {
        tearingDown = true;
        await retireSuRunDebris('unhandledRejection');
        await dissolveAllHives('unhandledRejection');
      }
      process.exit(1);
    })();
  });
}

async function loadTasks(): Promise<BenchTask[]> {
  let tasks = await loadBenchTaskSet('gaia-l3');
  if (ONLY_IID) {
    const one = tasks.find((t) => t.instanceId === ONLY_IID);
    if (!one) throw new Error(`XBENCH_ONLY_IID=${ONLY_IID} not in gaia-l3 (${tasks.length} tasks loaded)`);
    tasks = [one];
  }
  return tasks;
}

/** Apply the fleet concurrency cap. su-independent: launcher cache only (in-process pool). hive-realqueen:
 *  launcher cache + PUT to the :3170 host (the cache the Queen's spawns actually gate against). */
async function applyCap(): Promise<void> {
  const { writeRateLimitConfig, getCachedRateLimitConfig } = await import('../rate-limit-config');
  await writeRateLimitConfig({ maxSimultaneousAgents: CAP });
  const launcherCap = getCachedRateLimitConfig().maxSimultaneousAgents;
  let hostCap: number | string = '(n/a — su-independent is in-process)';
  if (ARM === HIVE_REALQUEEN_ARM) {
    const port = process.env.PAPERCUSP_HONO_PORT ?? '3170';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/operator/rate-limit-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxSimultaneousAgents: launcherCap }),
      });
      hostCap = res.ok
        ? ((await res.json()) as { config?: { maxSimultaneousAgents?: number } }).config?.maxSimultaneousAgents ?? '(ok)'
        : `(PUT failed ${res.status})`;
    } catch (e) {
      hostCap = `(PUT error: ${e instanceof Error ? e.message : String(e)})`;
    }
  }
  console.log(`[gaia:${ARM}] fleet cap — launcher cache=${launcherCap}, :3170 host=${hostCap} (XBENCH_CAP=${CAP})`);
}

async function main() {
  installTeardownHandlers();
  const tasks = await loadTasks();
  console.log(`[gaia:${ARM}] ws=${WORKSPACE_ID} tasks=${tasks.length} cap=${CAP} budget/task={maxUsd:${MAX_USD_PER_TASK},maxTokens:${MAX_TOKENS_PER_TASK}}`);
  console.log(`[gaia:${ARM}] AGENT_MODELS=${process.env.AGENT_MODELS ?? '(UNSET — roles fall to haiku/sonnet floor!)'} AGENT_CMD=${process.env.AGENT_CMD ?? '(unset)'}`);
  for (const t of tasks) {
    const gold = String((t.graderMeta?.finalAnswer ?? '') as string);
    console.log(`  - ${t.instanceId} (L${t.graderMeta?.level}) gold="${gold.slice(0, 40)}"`);
  }

  await applyCap();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(homedir(), '.papercusp', 'bench-results', 'gaia', 'runs', `${ARM}-l3-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const partialPath = join(outDir, 'predictions.partial.jsonl');
  const answersPath = join(outDir, 'answers.partial.jsonl');
  const manifestPath = join(outDir, `${ARM}.manifest.jsonl`);
  writeFileSync(manifestPath, '', 'utf8');

  // DURABILITY: persist each answer the moment it is collected (a rate-limit kill keeps every gradeable
  // answer already gathered). The full predictions/report are (re)written from result.taskResults at the end.
  const collected = new Map<string, { answer: string; costUsd: number; stopReason: string; tokensIn: number; tokensOut: number; turns: number; generationError: string | null; cupId: string | null }>();
  const onTaskCollected = (tr: { attempt: { instanceId: string; answer?: string; costUsd: number; stopReason: string; tokensIn: number; tokensOut: number; turns: number; generationError?: string }; cupId?: string | null }) => {
    const a = tr.attempt;
    const rec = {
      answer: a.answer ?? '',
      costUsd: a.costUsd ?? 0,
      stopReason: a.stopReason,
      tokensIn: a.tokensIn ?? 0,
      tokensOut: a.tokensOut ?? 0,
      turns: a.turns ?? 0,
      generationError: a.generationError ?? null,
      cupId: tr.cupId ?? null,
    };
    collected.set(a.instanceId, rec);
    appendFileSync(answersPath, JSON.stringify({ taskId: a.instanceId, ...rec }) + '\n');
    console.log(`[gaia:${ARM}] collected ${a.instanceId}: answerLen=${rec.answer.length} cost=$${rec.costUsd.toFixed(2)} stop=${rec.stopReason} err=${rec.generationError ?? '-'}`);
  };

  // Bind the chosen driver with the GAIA seam engaged.
  if (ARM === SU_INDEPENDENT_ARM) {
    bindSuIndependentBacklogDriver({
      workspaceId: WORKSPACE_ID,
      fleetTimeoutMs: Number(process.env.XBENCH_FLEET_TIMEOUT_MS ?? 120 * 60 * 1000),
      sampleIntervalMs: Number(process.env.XBENCH_SAMPLE_MS ?? 5_000),
      gaia: { enabled: true },
      onHiveCreated: (hiveHome) => {
        runPotSlug = hiveHome;
        createdHives.add(hiveHome);
        console.log(`[gaia:${ARM}] hive created + registered for teardown: ${hiveHome}`);
      },
      onEnrolled: (e) => {
        appendFileSync(
          manifestPath,
          JSON.stringify({
            arm: ARM,
            instanceId: e.task.instanceId,
            clonePath: e.clonePath,
            baseCommit: e.checkout.baseCommit,
            testFiles: (e.task.graderMeta?.['testFiles'] as string[] | undefined) ?? [],
          }) + '\n',
        );
      },
      onTaskCollected,
    });
  } else {
    bindRealQueenBacklogDriver({
      workspaceId: WORKSPACE_ID,
      fleetTimeoutMs: Number(process.env.XBENCH_FLEET_TIMEOUT_MS ?? 120 * 60 * 1000),
      pollIntervalMs: Number(process.env.XBENCH_POLL_MS ?? 20_000),
      gaia: { enabled: true },
      onEnrolled: (e) => {
        appendFileSync(
          manifestPath,
          JSON.stringify({
            arm: ARM,
            instanceId: e.task.instanceId,
            member: e.member,
            clonePath: e.clonePath,
            baseCommit: e.checkout.baseCommit,
            testFiles: (e.task.graderMeta?.['testFiles'] as string[] | undefined) ?? [],
          }) + '\n',
        );
      },
      onTaskCollected,
      onHiveCreated: (hiveHome) => {
        runPotSlug = hiveHome;
        createdHives.add(hiveHome);
        console.log(`[gaia:${ARM}] hive created + registered for teardown: ${hiveHome}`);
      },
    });
  }

  const budget = { maxUsd: MAX_USD_PER_TASK, maxTokens: MAX_TOKENS_PER_TASK };
  const runId = `xbench-gaia-${ARM}-${Date.now()}`;
  const startedAt = Date.now();
  console.log(`[gaia:${ARM}] runId=${runId} starting ${new Date().toISOString()}`);

  const result = await runHiveBacklog({ arm: ARM, suite: 'gaia', runId, seed: 1, backlog: tasks, budget });
  const wallMs = Date.now() - startedAt;

  // Build predictions for the grader: rawOutput = the answer.txt body (gradeGaia extracts FINAL ANSWER:),
  // gold + level from graderMeta. Use the live taskResults; fall back to the durable `collected` map.
  const taskById = new Map(tasks.map((t) => [t.instanceId, t]));
  const predictions: GaiaPrediction[] = [];
  const predRecords: Record<string, unknown>[] = [];
  for (const tr of result.taskResults) {
    const a = tr.attempt;
    const task = taskById.get(a.instanceId);
    const gold = String((task?.graderMeta?.finalAnswer ?? '') as string).trim();
    const level = coerceLevel(task?.graderMeta?.level ?? 3) as GaiaLevel;
    const answer = a.answer ?? collected.get(a.instanceId)?.answer ?? '';
    predictions.push({ taskId: a.instanceId, rawOutput: answer, gold, level });
    predRecords.push({
      task_id: a.instanceId,
      model_answer: answer,
      gold,
      level: String(level),
      stopReason: a.stopReason,
      generationError: a.generationError ?? null,
      costUsd: a.costUsd,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      turns: a.turns,
      cupId: tr.cupId,
    });
  }

  const report = gradeGaia(predictions);

  // Write predictions.jsonl + report.json (same dir layout as gaia/cli.ts runs).
  writeFileSync(join(outDir, 'predictions.jsonl'), predRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const totalCost = predRecords.reduce((s, r) => s + (Number(r.costUsd) || 0), 0);
  const totalTokIn = predRecords.reduce((s, r) => s + (Number(r.tokensIn) || 0), 0);
  const totalTokOut = predRecords.reduce((s, r) => s + (Number(r.tokensOut) || 0), 0);
  const reportOut = {
    arm: ARM,
    suite: 'gaia',
    runId,
    runError: result.runError ?? null,
    startedAt: new Date(startedAt).toISOString(),
    wallMs,
    peakConcurrentBees: result.peakConcurrentBees,
    taskCount: predictions.length,
    totals: { costUsd: totalCost, tokensIn: totalTokIn, tokensOut: totalTokOut },
    report,
    coordEvents: result.coordEvents ?? [],
    concurrencyTimeline: result.concurrencyTimeline ?? null,
  };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(reportOut, null, 2));

  console.log('\n===== GAIA ARM RUN SUMMARY =====');
  console.log(JSON.stringify({
    arm: ARM, runId, runError: reportOut.runError, wallMs,
    L3accuracy: report.byLevel.find((b) => b.level === 3)?.accuracy ?? report.overallAccuracy,
    resolved: report.resolved, scored: report.scored, formatFails: report.formatFails,
    totals: reportOut.totals, peakConcurrentBees: result.peakConcurrentBees,
  }, null, 2));
  const l3 = report.byLevel.find((b) => b.level === 3);
  console.log(`\n[gaia:${ARM}] L3: ${((l3?.accuracy ?? 0) * 100).toFixed(1)}% (${l3?.resolved ?? 0}/${l3?.scored ?? 0}) · format-fail ${report.formatFails} · cost $${totalCost.toFixed(2)} → ${outDir}`);
  console.log(`[gaia:${ARM}] compare vs single-opus L3 baseline 69.2% (18/26).`);

  void partialPath; // (reserved — checkpoint path; answers.partial.jsonl is the live durable stream)
  await retireSuRunDebris('normal-exit');
  await dissolveAllHives('normal-exit');
  process.exit(0);
}

main().catch((e) => {
  console.error(`[gaia:${ARM}] FATAL`, e instanceof Error ? e.stack : e);
  void (async () => { if (!tearingDown) { tearingDown = true; await dissolveAllHives('fatal'); } process.exit(1); })();
});
