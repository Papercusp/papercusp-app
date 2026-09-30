/**
 * corpus-sweep-cli — run the corpus sweep against the live memory store.
 *
 *   npx tsx packages/operator-core/lib/memory/corpus-sweep-cli.ts
 *   npx tsx .../corpus-sweep-cli.ts --pool harness:papercusp --no-judge
 *   npx tsx .../corpus-sweep-cli.ts --pool harness:papercusp --apply
 *
 * Report mode is the default and changes nothing. `--apply` closes the
 * validity window of EXACT-duplicate rows only; the safety rules that decide
 * what may be touched live in `corpus-sweep.ts` (read its header).
 *
 * This exists because the tool (`memory:sweep`) is only reachable through a
 * deployed operator, and corpus hygiene is something you want to be able to
 * run and eyeball before it is wired into a routine.
 */
import { sweepCorpus, type CorpusSweepResult } from './corpus-sweep';
import { liveCorpusSweepDeps } from './corpus-sweep-io';

function parseArgs(argv: string[]) {
  const pools: string[] = [];
  let apply = false;
  let judgeConflicts = true;
  let maxPoolsJudged = 4;
  let verbose = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--no-judge') judgeConflicts = false;
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--pool') pools.push(argv[++i] ?? '');
    else if (a === '--max-pools-judged') maxPoolsJudged = Number(argv[++i] ?? 4);
  }
  return {
    mode: apply ? ('apply' as const) : ('report' as const),
    pools: pools.filter(Boolean).length ? pools.filter(Boolean) : undefined,
    judgeConflicts,
    maxPoolsJudged,
    verbose,
  };
}

function render(result: CorpusSweepResult, verbose: boolean): void {
  console.log(`\nmode: ${result.mode}`);
  if (result.judgeUnavailable) {
    console.log(
      '\n⚠ CONTRADICTION LAYER NOT RUN — no conflict judge is wired in this process\n' +
        '  (no ANTHROPIC_API_KEY resolves here). conflictPairs below means NOT MEASURED,\n' +
        '  not "clean". Run it through the memory:sweep tool on a keyed operator instead.',
    );
  }
  console.log(
    `totals: rows=${result.totals.rows} duplicateGroups=${result.totals.duplicateGroups} ` +
      `redundant=${result.totals.redundant} blocked=${result.totals.blocked} ` +
      `resolved=${result.totals.resolved} conflictPairs=${result.totals.conflictPairs}`,
  );
  console.log(`\npools swept (${result.pools.length}):`);
  for (const p of result.pools) {
    console.log(
      `  ${p.pool} [${p.kind}] rows=${p.rows} groups=${p.duplicateGroups} ` +
        `redundant=${p.redundant} blocked=${p.blocked} resolved=${p.resolved} ` +
        `resolveErrors=${p.resolveErrors} judged=${p.judged} conflicts=${p.conflictPairs}`,
    );
  }
  if (result.skippedPools.length) {
    console.log(`\npools SKIPPED by the allowlist (${result.skippedPools.length}):`);
    for (const s of result.skippedPools) console.log(`  ${s.pool} — ${s.reason}`);
  }
  const shown = verbose ? result.duplicates : result.duplicates.slice(0, 15);
  if (shown.length) {
    console.log(`\nduplicate groups (${shown.length} of ${result.duplicates.length}):`);
    for (const g of shown) {
      const body = g.sample.replace(/\s+/g, ' ').slice(0, 140);
      console.log(
        `  x${g.redundantIds.length + 1} ${g.pool} keep=${g.survivorId}` +
          (g.blocked.length ? ` blocked=${g.blocked.map((b) => b.reason).join(',')}` : ''),
      );
      console.log(`      ${body}`);
    }
  }
  if (result.conflicts.length) {
    console.log(`\ncontradiction pairs (${result.conflicts.length}) — FILED, never auto-resolved:`);
    for (const c of verbose ? result.conflicts : result.conflicts.slice(0, 15)) {
      console.log(`  ${c.pool}: ${c.pair.aId} vs ${c.pair.bId} — ${c.pair.summary}`);
      console.log(`      A: ${c.pair.aText.replace(/\s+/g, ' ').slice(0, 120)}`);
      console.log(`      B: ${c.pair.bText.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const wired = await liveCorpusSweepDeps();
  if (!wired) {
    console.error('memory store unavailable — no PG connection fields');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await sweepCorpus(opts, wired.deps);
    render(result, opts.verbose);
  } finally {
    await wired.close().catch(() => {});
  }
}

// The memory backend keeps handles (pool / embedder sidecar) that outlive our
// own client, so the event loop does NOT drain after main() resolves — the
// process hangs after printing a complete report and eventually dies to the
// caller's `timeout`, which reads as a FAILED run of a run that fully
// succeeded. Exit explicitly on the reported outcome instead.
void main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
