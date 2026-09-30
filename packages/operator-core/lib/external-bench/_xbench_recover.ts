/**
 * RESUMABLE DIFF RECOVERY (impartial-benchmark-suite-2026-06-15 / P-033, Option B).
 *
 * The rate-limit-kill-resilience companion to _xbench_realqueen_compare.ts. The Anthropic API
 * intermittently throttles + KILLS the long-running generation process; when that happens the bees'
 * worktrees survive on disk but the launcher never reached its final OUT_DIR write — so the per-arm
 * <arm>.json the grader (_xbench_grade.py) + report (_xbench_report.ts) consume is missing.
 *
 * This tool reconstructs that <arm>.json + per-task diffs from the surviving worktrees, DECOUPLED from
 * generation — run it any time after a (possibly killed) generation pass to materialize a gradeable arm:
 *
 *   XBENCH_ARM=hive-realqueen XBENCH_OUT_DIR=/tmp/xbench-realqueen-out \
 *     npx tsx _xbench_recover.ts
 *
 * It collects EACH enrolled task's diff UNCONDITIONALLY (mirroring the live driver's collectTask →
 * extractDiff), regardless of any work_items/'failed' bookkeeping — the bee's worktree IS the source of
 * truth. The worktree→task→base mapping comes from the enrollment manifest the launcher writes
 * (<arm>.manifest.jsonl); cost/turns are summed from agent_usage_samples per member harness (PG).
 *
 * IMPORTANT (the git-sync-committed-bee-work case): a placed bee's edits are frequently COMMITTED on top
 * of the clone by the background git-sync routine ([skip ci] auto-commit), so `git diff HEAD` shows
 * nothing — but `extractDiff` diffs against the PINNED BASE COMMIT (checkout.baseCommit), which captures
 * committed AND uncommitted work alike, minus .papercusp/ scaffolding + the grader's own test files.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { extractDiff } from './clone';
import { readMemberUsage, readMemberBeeSpawns } from './hive-backlog-live';
import { resolveBenchWorkspace } from './bench-workspace';
import type { BenchTask, TaskCheckout } from './types';

const WORKSPACE_ID = resolveBenchWorkspace(process.env.XBENCH_WORKSPACE_ID);
const ARM = process.env.XBENCH_ARM ?? 'hive-realqueen';
const OUT_DIR = process.env.XBENCH_OUT_DIR ?? '/tmp/xbench-realqueen-out';

interface ManifestRow {
  arm: string;
  instanceId: string;
  member: string;
  clonePath: string;
  baseCommit: string;
  testFiles?: string[];
}

function loadManifest(): ManifestRow[] {
  const path = `${OUT_DIR}/${ARM}.manifest.jsonl`;
  if (!existsSync(path)) {
    throw new Error(
      `no enrollment manifest at ${path} — run the generation launcher (_xbench_realqueen_compare.ts) ` +
        `at least to enrollment, or pass an explicit manifest. (Recovery keys off the worktree→task mapping it writes.)`,
    );
  }
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ManifestRow);
}

async function main() {
  const rows = loadManifest();
  console.log(`[recover] arm=${ARM} ws=${WORKSPACE_ID} manifest rows=${rows.length} out=${OUT_DIR}`);
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(`${OUT_DIR}/diffs-${ARM}`, { recursive: true });

  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql;

  const perTask: Array<Record<string, unknown>> = [];
  let totalCost = 0;
  let totalTokIn = 0;
  let totalTokOut = 0;
  let nonEmptyDiffs = 0;

  for (const r of rows) {
    // Rebuild the minimal task + checkout extractDiff needs (base + grader test-file exclusion).
    const task = {
      benchmark: 'swe-bench-pro',
      instanceId: r.instanceId,
      problemStatement: '',
      repo: r.clonePath,
      baseCommit: r.baseCommit,
      graderMeta: { testFiles: r.testFiles ?? [] },
    } as unknown as BenchTask;
    const checkout: TaskCheckout = {
      dir: r.clonePath,
      repo: r.clonePath,
      baseCommit: r.baseCommit,
      cleanup: async () => {},
    };

    let diff = '';
    let generationError: string | null = null;
    if (!existsSync(r.clonePath)) {
      generationError = `clone worktree gone: ${r.clonePath}`;
    } else {
      try {
        diff = await extractDiff(checkout, task); // UNCONDITIONAL — diffs vs PINNED BASE, captures committed work
      } catch (e) {
        generationError = `extractDiff failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    writeFileSync(`${OUT_DIR}/diffs-${ARM}/${r.instanceId}.diff`, diff, 'utf8');

    const [cost, spawnRows] = await Promise.all([
      readMemberUsage(sql, r.member, WORKSPACE_ID).catch(() => ({ tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 })),
      readMemberBeeSpawns(sql, r.member, WORKSPACE_ID).catch(() => [] as Array<{ spawnId: string; startedAtMs: number; finishedAtMs: number; status: string }>),
    ]);
    const diffBytes = Buffer.byteLength(diff, 'utf8');
    if (diffBytes > 0) nonEmptyDiffs++;
    totalCost += cost.costUsd || 0;
    totalTokIn += cost.tokensIn || 0;
    totalTokOut += cost.tokensOut || 0;

    perTask.push({
      instanceId: r.instanceId,
      cupId: spawnRows[0]?.spawnId ?? r.member,
      disposition: 'spawn',
      stopReason: diffBytes > 0 ? 'done' : generationError ? 'error' : 'no-diff',
      generationError,
      tokensIn: cost.tokensIn,
      tokensOut: cost.tokensOut,
      costUsd: cost.costUsd,
      turns: cost.turns,
      wallClockMs: 0,
      diffBytes,
      armMeta: { member: r.member, hiveArm: ARM },
    });
    console.log(`[recover] ${r.instanceId}: diffBytes=${diffBytes} cost=$${(cost.costUsd || 0).toFixed(2)}${generationError ? ` (${generationError})` : ''}`);
  }

  // Reconstruct the REAL-Queen coordination trace from pot_placements if the install_slug is recoverable
  // (the homePrefix is the member slug's leading `xbq…` segment before the first `m`).
  let coordEvents: unknown[] = [];
  try {
    const { buildRealQueenCoordEvents } = await import('./hive-backlog-realqueen');
    const installSlug = rows[0]?.member.match(/^(xbq[a-z0-9]+?)m/)?.[1] ?? null;
    if (ARM === 'hive-realqueen' && installSlug) {
      const featureToInstance = new Map<string, string>();
      // The manifest doesn't carry the feature id; placements are keyed by work_item_id (feature). We map
      // via the harness_slug → instanceId instead (each member has exactly one feature), so resolve both.
      const placements = await sql<{
        work_item_id: string;
        harness_slug: string | null;
        cup_spawn_id: string | null;
        status: string;
        fail_count: number;
        last_disposition: string | null;
        placed_at: string | Date;
      }[]>`
        SELECT work_item_id, harness_slug, cup_spawn_id, status, fail_count, last_disposition, placed_at
          FROM harness_shared.pot_placements
         WHERE workspace_id = ${WORKSPACE_ID} AND install_slug = ${installSlug}
         ORDER BY placed_at ASC`;
      for (const p of placements) {
        const inst = rows.find((r) => r.member === p.harness_slug)?.instanceId;
        if (inst) featureToInstance.set(p.work_item_id, inst);
      }
      coordEvents = buildRealQueenCoordEvents(placements, featureToInstance);
      console.log(`[recover] reconstructed ${coordEvents.length} coordEvents from pot_placements (install_slug=${installSlug}, rows=${placements.length})`);
    }
  } catch (e) {
    console.warn(`[recover] coordEvents reconstruction skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  const out = {
    arm: ARM,
    runId: `xbench-recover-${ARM}-${Date.now()}`,
    runError: null,
    startedAt: new Date().toISOString(),
    wallMs: 0,
    peakConcurrentBees: 0,
    taskCount: perTask.length,
    nonEmptyDiffs,
    totals: { costUsd: totalCost, tokensIn: totalTokIn, tokensOut: totalTokOut },
    perTask,
    coordEvents,
    recovered: true,
  };
  writeFileSync(`${OUT_DIR}/${ARM}.json`, JSON.stringify(out, null, 2), 'utf8');
  console.log(
    `\n[recover] wrote ${OUT_DIR}/${ARM}.json — tasks=${perTask.length} nonEmptyDiffs=${nonEmptyDiffs} ` +
      `cost=$${totalCost.toFixed(2)} coordEvents=${coordEvents.length}`,
  );
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error('[recover] FATAL', e instanceof Error ? e.stack : e);
  process.exit(1);
});
