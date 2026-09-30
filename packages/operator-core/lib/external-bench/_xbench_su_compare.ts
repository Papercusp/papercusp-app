/**
 * SU-INDEPENDENT ARM LAUNCHER (benchmark-arms-su-vs-queen-expansion-2026-06-16 / P-001).
 *
 * Drives the 'su-independent' arm — N INDEPENDENT su/worker agents, each solving EXACTLY ONE
 * SWE-bench-Pro task end-to-end with NO Queen and NO hive coordination — over the SAME fixed public
 * sample the hive arms use, through the {@link ./su-independent-backlog.ts} driver. Collects per-task
 * diff/cost/tokens/turns + the new {@link ConcurrencyTimeline}, and writes a per-arm result JSON in the
 * SAME format `_xbench_grade.py` (run as `… _xbench_grade.py su-independent`) consumes — perTask[] with
 * `instanceId` + `diffs-su-independent/<iid>.diff` — so grading/reporting are unchanged.
 *
 * This is the "honest, no-orchestration" pole of the three-arm comparison (su-independent vs
 * hive-realqueen vs mini-swe-agent): same clone/diff/grader/model as the hive arms, the ONLY delta is
 * that there is NO orchestration layer above the per-task spine-drive (see su-independent-backlog.ts).
 *
 * ── CONTENTION CAP (load-bearing) ─────────────────────────────────────────────────────────────────
 * The su-arm spawns its agents IN-PROCESS (each independent agent drives the `external-bench` spine via
 * `spawnInvokeOnce` inside THIS launcher process — su-independent-backlog.ts D-001/D-002). There is NO
 * Queen and NO :3170 host doing loopback `cup:spawn`, so — UNLIKE the realqueen launcher — we do NOT
 * PUT the cap to a :3170 host route. The driver reads `spawnConcurrencyCeiling()` →
 * `getCachedRateLimitConfig()` (this process's module-scoped cache) ONCE at run start, so setting the cap
 * in THIS launcher's cache via `writeRateLimitConfig`/`initRateLimitConfig` is sufficient and complete —
 * that is the exact cache the in-process pool gates against. (The realqueen :3170 PUT existed only because
 * the Queen's spawns ran in the long-running :3170 process, a different cache; that does not apply here.)
 * Cap from XBENCH_CAP (default 5) — << backlog (5 over 11 tasks) → real saturation in waves of ≤cap.
 *
 * ── FAIRNESS / OPUS PIN (load-bearing) ────────────────────────────────────────────────────────────
 * The `external-bench` spine drives the PIPELINE roles (director / scoper / architect / worker /
 * validator / reviewer / documenter) whose committed floors are sonnet/haiku — NOT just `bee`. So the
 * caller MUST export AGENT_MODELS pinning EVERY pipeline role to opus:xhigh; an incomplete pin = a
 * degenerate non-xhigh run. VERIFY `agent_usage_samples.model = claude-opus-4-8` on a 1-task probe before
 * any big spend (the same protocol as the hive arms).
 *
 * NOT a committed test (spends real model budget) — a throwaway launcher under lib/external-bench so the
 * workspace-relative imports resolve.
 *
 * REQUIRED ENV (read before running):
 *   PAPERCUSP_FLEET_SANDBOX=0           — the bench-harness drive waives the per-spawn fleet sandbox.
 *   PAPERCUSP_SPAWN_BACKEND=claude-code — the claude-code spawn backend.
 *   AGENT_CMD="claude -p"               — the print/non-interactive CLI invocation.
 *   AGENT_MODELS='{"director":"opus:xhigh","scoper":"opus:xhigh","architect":"opus:xhigh",
 *                  "worker":"opus:xhigh","validator":"opus:xhigh","reviewer":"opus:xhigh",
 *                  "documenter":"opus:xhigh","bee":"opus:xhigh"}'  — pin EVERY pipeline role (NOT just bee;
 *                  floors are haiku/sonnet, so an incomplete pin = a degenerate non-xhigh run).
 *
 * 1-task probe (cheap; verify model BEFORE big spend):
 *   PAPERCUSP_FLEET_SANDBOX=0 PAPERCUSP_SPAWN_BACKEND=claude-code AGENT_CMD="claude -p" \
 *   AGENT_MODELS='{"director":"opus:xhigh","scoper":"opus:xhigh","architect":"opus:xhigh","worker":"opus:xhigh","validator":"opus:xhigh","reviewer":"opus:xhigh","documenter":"opus:xhigh","bee":"opus:xhigh"}' \
 *   XBENCH_ONLY_IID=instance_ansible__ansible-39bd8b99ec8c6624207bf3556ac7f9626dad9173-v1055803c3a812189a1133297f7f5468579283f86 \
 *   npx tsx _xbench_su_compare.ts
 *
 * Full 11-task run:
 *   PAPERCUSP_FLEET_SANDBOX=0 PAPERCUSP_SPAWN_BACKEND=claude-code AGENT_CMD="claude -p" \
 *   AGENT_MODELS='{"director":"opus:xhigh","scoper":"opus:xhigh","architect":"opus:xhigh","worker":"opus:xhigh","validator":"opus:xhigh","reviewer":"opus:xhigh","documenter":"opus:xhigh","bee":"opus:xhigh"}' \
 *   npx tsx _xbench_su_compare.ts
 */
import { readFileSync } from 'node:fs';
import { bindSuIndependentBacklogDriver, SU_INDEPENDENT_ARM } from './su-independent-backlog';
import { runHiveBacklog } from './hive-backlog';
import { retireBenchDebris, type DebrisSql } from './bench-teardown';
import { resolveBenchWorkspace } from './bench-workspace';
import type { BenchTask } from './types';

const WORKSPACE_ID = resolveBenchWorkspace(process.env.XBENCH_WORKSPACE_ID); // dedicated benchmark workspace, never production (plan benchmark-workspace-isolation)
const ARM = SU_INDEPENDENT_ARM; // 'su-independent' — this launcher serves exactly one arm.
const SAMPLE = process.env.XBENCH_SAMPLE ?? '/tmp/xbench-sample.jsonl';
const REPOS_ROOT = process.env.XBENCH_REPOS_ROOT ?? '/tmp/xbench-repos';
const OUT_DIR = process.env.XBENCH_OUT_DIR ?? '/tmp/xbench-su-out';
const MAX_USD_PER_TASK = Number(process.env.XBENCH_MAX_USD ?? 10);
const MAX_TOKENS_PER_TASK = Number(process.env.XBENCH_MAX_TOKENS ?? 4_000_000);
const MAX_TASKS = process.env.XBENCH_MAX_TASKS ? Number(process.env.XBENCH_MAX_TASKS) : undefined;
const ONLY_IID = process.env.XBENCH_ONLY_IID || undefined; // run EXACTLY one instance_id (cheap probe).
// XBENCH_ONLY_IIDS: comma-separated instance_ids — run EXACTLY this set (the targeted RESUME of
// infra-interrupted tasks). Merges into the existing snapshot by instanceId (like ONLY_IID), so a
// partial run can be completed in waves without clobbering already-done siblings (benchmark-robustness).
const ONLY_IIDS = process.env.XBENCH_ONLY_IIDS
  ? process.env.XBENCH_ONLY_IIDS.split(',').map((s) => s.trim()).filter(Boolean)
  : undefined;
const CAP = Number(process.env.XBENCH_CAP ?? 5); // contention cap (in-process pool size).

// The D-004-B su-arm loopback-fetches the operator host for fleet:place_batch (su-independent-backlog.ts
// placeFifoBatch) — the module header above is STALE on this point (it predates D-004-B's hive-routing).
// operatorApiBase() defaults to the GREEN release :3070, which LAGS staging; the benchmark must run against
// the STAGING operator (:3170) where the latest bench code + fixes live. Default it here (override-able).
process.env.PAPERCUSP_OPERATOR_BASE ??= 'http://localhost:3170';

// TEARDOWN-ON-EXIT. UNLIKE the realqueen launcher there is NO hive to dissolve — the su-arm is HIVE-LESS
// (su-independent-backlog.ts: "NO createHive, NO startRealQueen … NO collectCoordEvents"). The only thing
// the driver creates per task is a scratch clone, and the driver ALREADY tears each one down inside its
// `teardownTask` finally-block (on the success, generation-error, AND whole-run-error paths) — there is no
// orphan respin to guard, because nothing keeps running after the in-process spine-drive returns. So this
// handler is a thin belt: on a SIGTERM/SIGINT (e.g. an Anthropic rate-limit kill) we just log + exit with
// the conventional code; the OS reaps the scratch dirs under /tmp on the next boot, and no opus respins
// because there is no Queen/wake/autoloop to respin it. (Confirmed from the driver: no per-launcher cleanup
// surface beyond the checkout the driver owns.)
// This run's temporary hive slug (a random `xbench-su-<nanoid>`), captured via the driver's onHiveCreated
// hook so a signal-kill — which exits BEFORE the driver's finalize/dissolveHive runs — can still retire
// THIS run's work-items. The retire is SCOPED to the slug, so it can NEVER touch a concurrent peer run.
let runPotSlug: string | null = null;
let debrisRetired = false;

/**
 * Retire THIS run's benchmark work-items (→ `deprecated`, scoped to {@link runPotSlug}) so a kill or exit
 * never leaves frontier debris for the papercup-hive's workspace-wide survey to trip on (the ~13k-aging-
 * escalation-storm recurrence fix). Idempotent + best-effort; scoped → safe under concurrent peer runs.
 */
async function retireRunDebris(reason: string): Promise<void> {
  if (debrisRetired) return;
  if (!runPotSlug) {
    console.warn(`[su-independent] debris retire (${reason}): no hive created yet — nothing to retire.`);
    return;
  }
  debrisRetired = true;
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const n = await retireBenchDebris(getOrgPg().sql as unknown as DebrisSql, Date.now(), { slugPrefix: runPotSlug });
    console.warn(`[su-independent] retired ${n} work-item(s) for hive '${runPotSlug}' at ${reason} (scoped frontier-debris guard).`);
  } catch (e) {
    console.warn(`[su-independent] debris retire (${reason}) failed (best-effort): ${e instanceof Error ? e.message : e}`);
  }
}

let tearingDown = false;
function installTeardownHandlers(): void {
  // A signal-kill (e.g. an Anthropic rate-limit kill) exits BEFORE the driver's finalize/dissolveHive —
  // so we retire this run's work-items here (scoped), with a 5s belt so a slow PG never blocks the exit.
  const onSignal = (sig: string) => {
    if (tearingDown) return;
    tearingDown = true;
    const code = sig === 'SIGINT' ? 130 : 143;
    console.warn(`[su-independent] teardown (signal ${sig}): retiring this run's work-items (scoped) then exiting.`);
    const belt = setTimeout(() => process.exit(code), 5_000);
    void retireRunDebris(`signal ${sig}`).finally(() => { clearTimeout(belt); process.exit(code); });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('uncaughtException', (e) => {
    console.error('[su-independent] uncaughtException', e);
    const belt = setTimeout(() => process.exit(1), 5_000);
    void retireRunDebris('uncaughtException').finally(() => { clearTimeout(belt); process.exit(1); });
  });
  process.on('unhandledRejection', (e) => {
    console.error('[su-independent] unhandledRejection', e);
    const belt = setTimeout(() => process.exit(1), 5_000);
    void retireRunDebris('unhandledRejection').finally(() => { clearTimeout(belt); process.exit(1); });
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
  // XBENCH_ONLY_IID wins (a cheap 1-task probe); else XBENCH_MAX_TASKS caps the head of the backlog.
  if (ONLY_IID) {
    const one = tasks.find((t) => t.instanceId === ONLY_IID);
    if (!one) {
      throw new Error(`XBENCH_ONLY_IID=${ONLY_IID} not found in ${SAMPLE} (${tasks.length} tasks loaded)`);
    }
    tasks = [one];
  } else if (ONLY_IIDS) {
    const want = new Set(ONLY_IIDS);
    const found = tasks.filter((t) => want.has(t.instanceId));
    const missing = ONLY_IIDS.filter((id) => !tasks.some((t) => t.instanceId === id));
    if (missing.length) {
      throw new Error(`XBENCH_ONLY_IIDS: ${missing.length} not in ${SAMPLE} (${tasks.length} loaded): ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
    }
    tasks = found;
  } else if (MAX_TASKS != null) {
    tasks = tasks.slice(0, MAX_TASKS);
  }
  return tasks;
}

async function main() {
  installTeardownHandlers();
  const tasks = loadTasks();
  console.log(`[su-independent] arm=${ARM} ws=${WORKSPACE_ID} tasks=${tasks.length} cap=${CAP}`);
  console.log(`[su-independent] AGENT_MODELS=${process.env.AGENT_MODELS ?? '(unset — pipeline roles fall to haiku/sonnet floor!)'} AGENT_CMD=${process.env.AGENT_CMD ?? '(unset)'}`);
  for (const t of tasks) console.log(`  - ${t.instanceId} (repo=${t.repo})`);

  // CONTENTION CAP (load-bearing). The driver reads `spawnConcurrencyCeiling()` → `getCachedRateLimitConfig()`
  // — THIS process's module-scoped cache — ONCE at run start to size its in-process pool. So setting the cap
  // in THIS launcher's cache is necessary AND sufficient: the independent agents spawn in THIS process via
  // `spawnInvokeOnce`, NOT via a Queen's loopback `cup:spawn` to :3170, so there is NO foreign cache to
  // propagate to. We DROP the realqueen launcher's :3170 host PUT entirely (it only mattered because the
  // Queen's spawns ran in the :3170 process — a different cache; that scenario does not exist for this arm).
  {
    const { writeRateLimitConfig, getCachedRateLimitConfig } = await import('../rate-limit-config');
    await writeRateLimitConfig({ maxSimultaneousAgents: CAP }); // persist + apply to THIS (launcher) cache
    const launcherCap = getCachedRateLimitConfig().maxSimultaneousAgents;
    console.log(`[su-independent] fleet cap — launcher cache = ${launcherCap} (XBENCH_CAP=${CAP})`);
    if (launcherCap !== CAP) {
      console.warn(`[su-independent] WARNING: launcher cap (${launcherCap}) != intended (${CAP}) — clamped by RATE_LIMIT_MAX_CEILING?`);
    }
  }

  // DURABILITY (the rate-limit-kill fix — mirror the realqueen launcher). The Anthropic API intermittently
  // throttles + KILLS the run process; we persist INCREMENTALLY through the driver's onEnrolled/onTaskCollected
  // hooks: an enrollment manifest (instanceId→clonePath→base, so a recovery pass could re-extract from a
  // surviving worktree) and each task's diff the moment it is collected. NOTE: the su-arm tears each clone down
  // immediately after the task finishes (driver `teardownTask` finally), so the surviving-worktree recovery
  // window is narrower than the realqueen arm's — but the per-task diff is written here BEFORE teardown via
  // onTaskCollected, so a kill keeps every diff already collected regardless. A kill loses only un-started tasks.
  const { writeFileSync: wf, mkdirSync: mkd, appendFileSync: af } = await import('node:fs');
  mkd(OUT_DIR, { recursive: true });
  mkd(`${OUT_DIR}/diffs-${ARM}`, { recursive: true });
  const manifestPath = `${OUT_DIR}/${ARM}.manifest.jsonl`;
  wf(manifestPath, '', 'utf8'); // truncate any stale manifest for this arm
  // ROBUSTNESS (benchmark-resumability): append each task's STRUCTURED result here the moment it is collected.
  // The full ${ARM}.json snapshot is only written at finalize() — a mid-run kill (e.g. a peer restarting :3170)
  // otherwise loses every stopReason/cost not yet in the snapshot. With this incremental log the missing set is
  // recomputable + re-runnable in waves (XBENCH_ONLY_IIDS) and the snapshot rebuildable, WITHOUT re-running
  // already-done tasks. NOT truncated: it accumulates across resume waves (deduped by instanceId downstream).
  const resultsPath = `${OUT_DIR}/${ARM}.results.jsonl`;

  bindSuIndependentBacklogDriver({
    workspaceId: WORKSPACE_ID,
    fleetTimeoutMs: Number(process.env.XBENCH_FLEET_TIMEOUT_MS ?? 120 * 60 * 1000),
    sampleIntervalMs: Number(process.env.XBENCH_SAMPLE_MS ?? 5_000),
    // Capture the run's hive slug so a signal-kill can scope its debris retire to THIS run (never a peer's).
    onHiveCreated: (slug) => { runPotSlug = slug; },
    onEnrolled: (e) => {
      const row = {
        arm: ARM,
        instanceId: e.task.instanceId,
        clonePath: e.clonePath,
        baseCommit: e.checkout.baseCommit,
        testFiles: (e.task.graderMeta?.['testFiles'] as string[] | undefined) ?? [],
      };
      af(manifestPath, JSON.stringify(row) + '\n', 'utf8');
      console.log(`[su-independent] enrolled ${e.task.instanceId} → ${e.clonePath} (base ${e.checkout.baseCommit.slice(0, 8)})`);
    },
    onTaskCollected: (tr) => {
      const a = tr.attempt;
      const diff = a.diff ?? '';
      const diffBytes = Buffer.byteLength(diff, 'utf8');
      wf(`${OUT_DIR}/diffs-${ARM}/${a.instanceId}.diff`, diff, 'utf8');
      af(resultsPath, JSON.stringify({ instanceId: a.instanceId, stopReason: a.stopReason, diffBytes, costUsd: a.costUsd ?? 0, ts: Date.now() }) + '\n', 'utf8');
      console.log(`[su-independent] collected ${a.instanceId}: diffBytes=${diffBytes} cost=$${(a.costUsd || 0).toFixed(2)} stop=${a.stopReason}`);
    },
  });

  const budget = { maxUsd: MAX_USD_PER_TASK, maxTokens: MAX_TOKENS_PER_TASK };
  const runId = `xbench-su-${ARM}-${Date.now()}`;
  const startedAt = Date.now();
  console.log(`[su-independent] runId=${runId} budget/task=${JSON.stringify(budget)} starting ${new Date().toISOString()}`);

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
    // The su-arm's distinctive signal (P-003): the sampled live-concurrency curve over the run — its avg
    // (not just peak) answers "how many independent agents actually ran at once". The hive arms leave this
    // undefined; `_xbench_report.ts` reads it when present.
    concurrencyTimeline: result.concurrencyTimeline ?? null,
    taskCount: perTask.length,
    nonEmptyDiffs,
    totals: { costUsd: totalCost, tokensIn: totalTokIn, tokensOut: totalTokOut },
    perTask,
    coordEvents: result.coordEvents, // [] by design — an independent-agent arm has NO coordination trace.
  };
  // FAIRNESS (benchmark-fairness-fix, Priority 2): READ-MODIFY-WRITE the arm snapshot by instanceId so an
  // `XBENCH_ONLY_IID` rerun MERGES into the existing perTask instead of clobbering every sibling (mirrors
  // run_minisweagent.py:update_preds + the PG upsertBenchRunTask idempotency). taskCount/totals/nonEmptyDiffs
  // are recomputed from the merged set by writeArmSnapshotMerged.
  const { writeArmSnapshotMerged } = await import('./arm-snapshot');
  writeArmSnapshotMerged(`${OUT_DIR}/${ARM}.json`, out);

  console.log('\n===== ARM RUN SUMMARY =====');
  console.log(JSON.stringify({
    arm: ARM, runId, runError: out.runError, wallMs,
    peakConcurrentBees: out.peakConcurrentBees, taskCount: out.taskCount, nonEmptyDiffs,
    totals: out.totals,
    concurrency: result.concurrencyTimeline
      ? { avg: result.concurrencyTimeline.avgConcurrent, peak: result.concurrencyTimeline.peakConcurrent, samples: result.concurrencyTimeline.samples.length }
      : null,
  }, null, 2));
  console.log(`\n[su-independent] wrote ${OUT_DIR}/${ARM}.json + ${perTask.length} diffs under diffs-${ARM}/`);
  console.log(`[su-independent] grade with:  XBENCH_OUT_DIR=${OUT_DIR} XBENCH_SAMPLE=${SAMPLE} python3 _xbench_grade.py ${ARM}`);
  // The driver already dissolved its hive at finalize; this scoped retire is the idempotent belt that
  // guarantees this run's work-items are deprecated (never debris) even if dissolveHive left them.
  await retireRunDebris('run-end');
  process.exit(0);
}

main().catch((e) => {
  console.error('[su-independent] FATAL', e instanceof Error ? e.stack : e);
  process.exit(1);
});
