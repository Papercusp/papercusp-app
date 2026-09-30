/**
 * HEADLINE REPORT — hive vs queen-ablated (impartial-benchmark-suite-2026-06-15 / P-032).
 * Reads both arms' run JSON (_xbench_compare.ts output) + the grader verdicts (resolved-<arm>.json
 * from _xbench_grade.py) and emits the per-arm headline numbers + the hive−ablated delta + MAST rates
 * (computed from each arm's coordEvents via the shipped substrateSignalRates). NO model calls — pure
 * aggregation of the already-graded data. Throwaway launcher.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { substrateSignalRates } from '@papercusp/bench-metrics';
import type { CoordEvent } from '@papercusp/bench-metrics';
import { isScoredStopReason } from './types';

const OUT_DIR = process.env.XBENCH_OUT_DIR ?? '/tmp/xbench-compare-out';
// The two arms to compare. Defaults to the P-033 real-Queen pair (hive-realqueen vs fifo-noqueen);
// override to the P-032 pair (hive vs queen-ablated) via XBENCH_POT_ARM/XBENCH_ABL_ARM. Same JSON
// shape either way (_xbench_realqueen_compare.ts / _xbench_recover.ts emit the identical format).
const HIVE_ARM = process.env.XBENCH_POT_ARM ?? process.env.XBENCH_HIVE_ARM /* legacy env name — dual-accept until callers migrate */ ?? 'hive-realqueen';
const ABL_ARM = process.env.XBENCH_ABL_ARM ?? 'fifo-noqueen';

interface ArmRun {
  arm: string;
  runId: string;
  runError: string | null;
  wallMs: number;
  peakConcurrentBees: number;
  taskCount: number;
  nonEmptyDiffs: number;
  totals: { costUsd: number; tokensIn: number; tokensOut: number };
  perTask: Array<{
    instanceId: string;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    turns: number;
    diffBytes: number;
    stopReason: string;
    generationError: string | null;
  }>;
  coordEvents: CoordEvent[];
}
interface Resolved {
  arm: string;
  resolved: number;
  total: number;
  perInstance: Record<string, boolean>;
}

function load(arm: string): { run: ArmRun; grade: Resolved | null } {
  const run = JSON.parse(readFileSync(`${OUT_DIR}/${arm}.json`, 'utf8')) as ArmRun;
  const gp = `${OUT_DIR}/resolved-${arm}.json`;
  const grade = existsSync(gp) ? (JSON.parse(readFileSync(gp, 'utf8')) as Resolved) : null;
  return { run, grade };
}

function requireCoordEvents(run: ArmRun, arm: string): CoordEvent[] {
  if (!Array.isArray(run.coordEvents)) {
    throw new Error(
      `[xbench-report] ${arm}.json is missing coordEvents; refusing to compute MAST from an absent coordination trace`,
    );
  }
  return run.coordEvents;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a';
}

function armReport(arm: string) {
  const { run, grade } = load(arm);
  const wallSec = run.wallMs / 1000;
  const cost = run.totals.costUsd;
  const coordEvents = requireCoordEvents(run, arm);
  const mast = substrateSignalRates(coordEvents, run.taskCount);

  // FAIRNESS (benchmark-fairness-fix): exclude EXTERNAL/transient/infra tasks from the resolved%
  // denominator. A task is NON-SCORED when its stopReason ∈ {error, timeout, infra-failed} (per
  // isScoredStopReason) or it carries a generationError — it never produced a fairly-given submission,
  // so it is resolved=null/excluded, NOT a capability fail. resolved% is then resolved / SCORED-tasks
  // (NOT resolved / grader-total). We re-derive the resolved count from the SCORED rows' per-instance
  // verdicts so a grader-manufactured `false` on an infra row can never sneak into the numerator either.
  const perInstance = grade?.perInstance ?? {};
  let scoredGraded = 0;
  let scoredResolved = 0;
  let infraExcluded = 0;
  for (const t of run.perTask) {
    const infra = !isScoredStopReason(t.stopReason) || (t.generationError != null && t.generationError !== '');
    if (infra) {
      infraExcluded += 1;
      continue;
    }
    // A scored task counts toward the denominator only once the grader returned a verdict for it.
    if (Object.prototype.hasOwnProperty.call(perInstance, t.instanceId)) {
      scoredGraded += 1;
      if (perInstance[t.instanceId] === true) scoredResolved += 1;
    }
  }
  const graded = scoredGraded;
  const resolved = scoredResolved;
  return {
    arm,
    runId: run.runId,
    runError: run.runError,
    tasks: run.taskCount,
    nonEmptyDiffs: run.nonEmptyDiffs,
    graded,
    resolved,
    infraExcluded,
    resolvedPct: graded > 0 ? resolved / graded : 0,
    totalCostUsd: cost,
    totalTokensIn: run.totals.tokensIn,
    totalTokensOut: run.totals.tokensOut,
    wallSec,
    peakConcurrentBees: run.peakConcurrentBees,
    tasksPerHour: wallSec > 0 ? run.taskCount / (wallSec / 3600) : 0,
    tasksPerDollar: cost > 0 ? run.taskCount / cost : 0,
    resolvedPerDollar: cost > 0 ? resolved / cost : 0,
    costPerResolved: resolved > 0 ? cost / resolved : null,
    coordEventCount: coordEvents.length,
    mast: {
      duplicationRate: mast.duplicationRate,
      coordinationBreakdownRate: mast.coordinationBreakdownRate,
      misalignmentRate: mast.misalignmentRate,
      redundantWorkRate: mast.redundantWorkRate,
      counts: mast.counts,
      coordinationActions: mast.coordinationActions,
    },
    perInstance: grade
      ? run.perTask.map((t) => ({
          instanceId: t.instanceId,
          resolved: grade.perInstance[t.instanceId] ?? false,
          costUsd: t.costUsd,
          turns: t.turns,
          diffBytes: t.diffBytes,
          stopReason: t.stopReason,
          generationError: t.generationError,
        }))
      : run.perTask,
  };
}

function main() {
  const hive = armReport(HIVE_ARM);
  const abl = armReport(ABL_ARM);

  const delta = {
    resolvedPct_pp: (hive.resolvedPct - abl.resolvedPct) * 100, // percentage points
    resolved_count: hive.resolved - abl.resolved,
    totalCostUsd: hive.totalCostUsd - abl.totalCostUsd,
    totalTokensOut: hive.totalTokensOut - abl.totalTokensOut,
    wallSec: hive.wallSec - abl.wallSec,
    tasksPerHour: hive.tasksPerHour - abl.tasksPerHour,
    resolvedPerDollar: hive.resolvedPerDollar - abl.resolvedPerDollar,
    mast: {
      duplicationRate: hive.mast.duplicationRate - abl.mast.duplicationRate,
      coordinationBreakdownRate: hive.mast.coordinationBreakdownRate - abl.mast.coordinationBreakdownRate,
      misalignmentRate: hive.mast.misalignmentRate - abl.mast.misalignmentRate,
      redundantWorkRate: hive.mast.redundantWorkRate - abl.mast.redundantWorkRate,
    },
  };

  const totalSpend = hive.totalCostUsd + abl.totalCostUsd;
  const report = { generatedAt: new Date().toISOString(), hiveArm: HIVE_ARM, ablArm: ABL_ARM, hive, queenAblated: abl, delta, totalSpendUsd: totalSpend };
  writeFileSync(`${OUT_DIR}/HEADLINE.json`, JSON.stringify(report, null, 2), 'utf8');

  // Human-readable table
  const L: string[] = [];
  L.push(`================ HEADLINE: ${HIVE_ARM} vs ${ABL_ARM} (SWE-bench Pro) ================`);
  L.push(`tasks: ${hive.tasks} (same fixed set, same grader, same iso-budget/task)`);
  L.push('');
  const row = (label: string, h: string, a: string, d: string) =>
    L.push(`${label.padEnd(26)} | ${HIVE_ARM} ${h.padEnd(16)} | ${ABL_ARM} ${a.padEnd(16)} | Δ ${d}`);
  row('RESOLVED %', pct(hive.resolved, hive.graded), pct(abl.resolved, abl.graded), `${delta.resolvedPct_pp >= 0 ? '+' : ''}${delta.resolvedPct_pp.toFixed(1)}pp`);
  row('RESOLVED count', `${hive.resolved}/${hive.graded}`, `${abl.resolved}/${abl.graded}`, `${delta.resolved_count >= 0 ? '+' : ''}${delta.resolved_count}`);
  // FAIRNESS: external/transient/infra tasks EXCLUDED from the resolved% denominator (never a fail).
  row('infra excluded', `${hive.infraExcluded}/${hive.tasks}`, `${abl.infraExcluded}/${abl.tasks}`, '');
  row('non-empty diffs', `${hive.nonEmptyDiffs}/${hive.tasks}`, `${abl.nonEmptyDiffs}/${abl.tasks}`, '');
  row('total cost $', `$${hive.totalCostUsd.toFixed(2)}`, `$${abl.totalCostUsd.toFixed(2)}`, `${delta.totalCostUsd >= 0 ? '+' : ''}$${delta.totalCostUsd.toFixed(2)}`);
  row('total tokens out', hive.totalTokensOut.toLocaleString(), abl.totalTokensOut.toLocaleString(), delta.totalTokensOut.toLocaleString());
  row('wall-clock (s)', hive.wallSec.toFixed(0), abl.wallSec.toFixed(0), delta.wallSec.toFixed(0));
  row('tasks / hour', hive.tasksPerHour.toFixed(2), abl.tasksPerHour.toFixed(2), delta.tasksPerHour.toFixed(2));
  row('tasks / $', hive.tasksPerDollar.toFixed(2), abl.tasksPerDollar.toFixed(2), '');
  row('resolved / $', hive.resolvedPerDollar.toFixed(3), abl.resolvedPerDollar.toFixed(3), `${delta.resolvedPerDollar >= 0 ? '+' : ''}${delta.resolvedPerDollar.toFixed(3)}`);
  row('$ / resolved', hive.costPerResolved != null ? `$${hive.costPerResolved.toFixed(2)}` : 'n/a', abl.costPerResolved != null ? `$${abl.costPerResolved.toFixed(2)}` : 'n/a', '');
  L.push('');
  L.push('--- MAST coordination rates (objective, from coordEvents) ---');
  row('duplication', hive.mast.duplicationRate.toFixed(3), abl.mast.duplicationRate.toFixed(3), delta.mast.duplicationRate.toFixed(3));
  row('coord breakdown', hive.mast.coordinationBreakdownRate.toFixed(3), abl.mast.coordinationBreakdownRate.toFixed(3), delta.mast.coordinationBreakdownRate.toFixed(3));
  row('misalignment', hive.mast.misalignmentRate.toFixed(3), abl.mast.misalignmentRate.toFixed(3), delta.mast.misalignmentRate.toFixed(3));
  row('redundant work', hive.mast.redundantWorkRate.toFixed(3), abl.mast.redundantWorkRate.toFixed(3), delta.mast.redundantWorkRate.toFixed(3));
  L.push('');
  L.push(`coord events: ${HIVE_ARM}=${hive.coordEventCount} ${ABL_ARM}=${abl.coordEventCount}`);
  L.push(`TOTAL SPEND (both arms): $${totalSpend.toFixed(2)}  (ceiling $10,000)`);
  if (hive.runError) L.push(`⚠ ${HIVE_ARM} runError: ${hive.runError}`);
  if (abl.runError) L.push(`⚠ ${ABL_ARM} runError: ${abl.runError}`);
  L.push('=================================================================================');
  const table = L.join('\n');
  writeFileSync(`${OUT_DIR}/HEADLINE.txt`, table, 'utf8');
  console.log(table);
  console.log('\n[report] wrote HEADLINE.json + HEADLINE.txt');
}

main();
