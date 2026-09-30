/**
 * METR HCAST two-arm CLI (plan benchmark-suite-metr-hcast-2026-06-17 P-005). The runnable driver that ties
 * the corpus → the live docker+gateway runner (both arms) → the horizon report. Host-gated: needs Docker +
 * the pre-built task images (anon Docker Hub pull) + a reachable inference gateway routing opus-4.8.
 *
 *   npx tsx packages/operator-core/lib/external-bench/_xbench_metr_hcast.ts \
 *     --task-set metr-hcast-horizon --arms baseline-a-ablation,papercusp --samples 3 \
 *     --max-tasks 18 --budget-tokens 400000 --concurrency 2 --out ~/.papercusp/bench-results/metr-hcast/run.json
 *
 * SAFETY: this spends real tokens through the gateway and pulls ~4 GB images. Defaults are conservative
 * (1 sample, the pilot set). `--dry-run` lists what would run without spending. Pre-pull images for big runs.
 * The headline is the LIFT, not the absolute horizon — the report carries the mandatory caveats (D-002/D-003).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BenchTask } from './types';
import { loadBenchTaskSet } from './task-sets';
import { makeMetrHcastLiveOps, gatewayModelCall, metrGatewayBaseUrl } from './metr-hcast-live';
import { runMetrHcastSuite } from './metr-hcast-driver';
import { runMetrHcastSuiteViaFleet, METR_HCAST_SU_INDEPENDENT_ARM, METR_HCAST_HIVE_ARM } from './metr-hcast-backlog';
import type { FleetArmId } from '@papercusp/bench-metrics';
import { buildMetrHcastReport, formatMetrHcastReport } from './metr-hcast-report';
import { appendAccumResult, loadAccumulatedResults, accumCoverage } from './metr-hcast-accum';
import { dirname as pathDirname } from 'node:path';
import type { HorizonWeighting } from '@papercusp/bench-metrics';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const taskSet = arg('task-set', 'metr-hcast-pilot')!;
  const arms = (arg('arms', 'baseline-a-ablation,papercusp')!).split(',').map((s) => s.trim()).filter(Boolean);
  const samples = Number(arg('samples', '1'));
  const maxTasks = arg('max-tasks') ? Number(arg('max-tasks')) : undefined;
  const model = arg('model', 'claude-opus-4-8')!;
  const budgetTokens = arg('budget-tokens') ? Number(arg('budget-tokens')) : undefined;
  const concurrency = Number(arg('concurrency', '1'));
  const weighting = (arg('weighting', 'invsqrt') as HorizonWeighting);
  const bootstrap = Number(arg('bootstrap', '1000'));
  const out = arg('out');
  const account = arg('account');
  const effort = arg('effort', 'default')!; // 'xhigh' → extended thinking (the plan's opus-4.8 @ xhigh)
  const thinkingBudget = effort === 'xhigh' ? Number(arg('thinking-budget', '16000')) : 0;
  const dryRun = hasFlag('dry-run');
  const accumulate = hasFlag('accumulate');
  // --via-fleet: run each arm through the SHARED canonical HiveBacklogDriver contract (metrHcastBacklogDriver)
  // → emit BOTH the standard fleet summary AND the horizon report from one run (the dual-arm unification).
  const viaFleet = hasFlag('via-fleet');
  // Accumulation dir = alongside --out (default the metr-hcast results dir).
  const accumBase = out ? pathDirname(out) : `${process.env.HOME}/.papercusp/bench-results/metr-hcast`;
  const customIds = arg('task-ids')?.split(',').map((s) => s.trim()).filter(Boolean);

  let tasks: BenchTask[] = await loadBenchTaskSet(taskSet, customIds);
  if (maxTasks && tasks.length > maxTasks) tasks = tasks.slice(0, maxTasks);

  const baselined = tasks.filter((t) => t.graderMeta?.['horizonEligible'] === true).length;
  console.log(`METR HCAST run — task-set=${taskSet}  tasks=${tasks.length} (${baselined} horizon-eligible)  arms=${arms.join(',')}  samples=${samples}  model=${model}  effort=${effort}${thinkingBudget ? `(thinking ${thinkingBudget})` : ''}  gateway=${metrGatewayBaseUrl()}${account ? `  account=${account}` : ''}`);
  console.log(`Tasks: ${tasks.map((t) => t.instanceId).join(', ')}`);

  if (dryRun) {
    console.log(`\n[dry-run] would run ${arms.length} arm(s) × ${tasks.length} task(s) × ${samples} sample(s) = ${arms.length * tasks.length * samples} container runs. No spend.`);
    return;
  }

  const modelCall = gatewayModelCall({ model, ...(account ? { accountId: account } : {}), ...(thinkingBudget > 0 ? { thinkingBudget } : {}) });

  // ── --via-fleet: the shared-contract path (metr-hcast through the SAME HiveBacklogDriver as SWE-bench) ──
  if (viaFleet) {
    const fleetArms: FleetArmId[] = arms.map((a) => (a === 'papercusp' ? METR_HCAST_HIVE_ARM : METR_HCAST_SU_INDEPENDENT_ARM));
    console.log(`[via-fleet] running through the canonical HiveBacklogDriver contract — fleet arms: ${fleetArms.join(', ')}`);
    const fleetRun = await runMetrHcastSuiteViaFleet({
      tasks,
      arms: fleetArms,
      opsFor: (arm) =>
        makeMetrHcastLiveOps(arm === METR_HCAST_HIVE_ARM ? 'papercusp' : 'baseline-a-ablation', { modelCall, model, concurrencyCap: () => concurrency }),
      budget: budgetTokens ? { maxTokens: budgetTokens } : {},
      report: { weighting, bootstrap, runId: `metr-hcast-${taskSet}-fleet` },
      ...(accumulate ? { onTaskCollected: (arm, r) => appendAccumResult(accumBase, arm === METR_HCAST_HIVE_ARM ? 'papercusp' : 'baseline-a-ablation', r) } : {}),
      onArmDone: (a) => console.log(`  …${a.fleetArm}: ${a.summary.tasks} tasks, ${a.summary.resolved} resolved, peakConcurrency ${a.summary.peakConcurrency}, $${a.summary.costUsd.toFixed(3)}`),
    });
    console.log('\n=== FLEET SUMMARIES (the canonical cross-suite output) ===');
    for (const f of fleetRun.fleet) {
      console.log(`  ${f.fleetArm}: tasks=${f.summary.tasks} resolved=${f.summary.resolved} zeroHumanGate=${f.summary.tasksZeroHumanGate} tokens=${f.summary.tokensTotal} wallClock=${(f.summary.wallClockMs / 1000).toFixed(0)}s peakConc=${f.summary.peakConcurrency}`);
    }
    console.log('\n' + formatMetrHcastReport(fleetRun.report));
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ report: fleetRun.report, fleet: fleetRun.fleet, resultsByArm: fleetRun.resultsByArm }, null, 2), 'utf8');
      console.log(`\nWrote fleet run artifact → ${out}`);
    }
    return;
  }

  // In accumulate mode: fold in rows banked by earlier partial runs, and append each new row as it settles.
  const prior = accumulate ? loadAccumulatedResults(accumBase) : {};
  if (accumulate) {
    const cov = accumCoverage(prior);
    console.log(`[accumulate] prior banked rows: ${Object.entries(cov).map(([a, c]) => `${a}=${c.scoredTasks}/${c.baselinedTasks} scored`).join('  ') || '(none)'}`);
  }
  const { resultsByArm, report } = await runMetrHcastSuite({
    tasks,
    arms,
    samplesPerTask: samples,
    budget: budgetTokens ? { maxTokens: budgetTokens } : {},
    opsFor: (arm) =>
      makeMetrHcastLiveOps(arm as 'baseline-a-ablation' | 'papercusp', {
        modelCall,
        model,
        concurrencyCap: () => concurrency,
      }),
    report: { weighting, bootstrap, runId: `metr-hcast-${taskSet}-${samples}s` },
    ...(accumulate ? { priorResultsByArm: prior, onResult: (arm, r) => appendAccumResult(accumBase, arm, r) } : {}),
    onProgress: ({ arm, sample, done, total }) => console.log(`  …${arm} sample ${sample + 1}: ${done}/${total} rows`),
  });

  // The report from the driver already folds prior accum (priorResultsByArm); rebuild explicitly for clarity.
  const finalReport = accumulate ? buildMetrHcastReport(resultsByArm, { weighting, bootstrap, runId: `metr-hcast-${taskSet}-accum` }) : report;
  console.log('\n' + formatMetrHcastReport(finalReport));
  if (accumulate) {
    const cov = accumCoverage(resultsByArm);
    console.log(`[accumulate] cumulative scored coverage: ${Object.entries(cov).map(([a, c]) => `${a}=${c.scoredTasks}/${c.baselinedTasks}`).join('  ')}`);
  }

  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ report: finalReport, resultsByArm }, null, 2), 'utf8');
    console.log(`\nWrote run artifact → ${out}`);
  }
}

main().catch((e) => {
  console.error('metr-hcast run failed:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
