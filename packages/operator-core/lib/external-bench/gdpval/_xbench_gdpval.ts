/**
 * GDPval benchmark CLI launcher (plan benchmark-suite-gdpval-2026-06-17). Runs the single-agent generation arm
 * over a GDPval task set + the pairwise autograder, writing predictions/report under
 * ~/.papercusp/bench-results/gdpval/runs/.
 *
 * Env:
 *   XBENCH_GDPVAL_TASKSET   gdpval-gold-220 | gdpval-pilot | gdpval-custom   (default gdpval-pilot)
 *   XBENCH_GDPVAL_IID       run EXACTLY this one task id (the cheap validation gate)
 *   XBENCH_GDPVAL_LIMIT     cap the number of tasks
 *   XBENCH_GDPVAL_CONC      concurrent tasks (default 3)
 *   XBENCH_GDPVAL_MAXTURNS  per-task agent turn cap (default 20)
 *   XBENCH_GDPVAL_MAXTOK    per-task agent token cap (default 400000)
 *   XBENCH_GDPVAL_ACCOUNT   pin a gateway account
 *   XBENCH_GDPVAL_OUTDIR    output dir
 *
 * Validation gate (run ONE task end-to-end before any batch):
 *   XBENCH_GDPVAL_IID=<task-id> npx tsx .../gdpval/_xbench_gdpval.ts
 * Full pilot (44 tasks, 1/occupation):
 *   XBENCH_GDPVAL_TASKSET=gdpval-pilot XBENCH_GDPVAL_CONC=4 npx tsx .../gdpval/_xbench_gdpval.ts
 */
import { runGdpval } from './run';

async function main(): Promise<void> {
  const iid = process.env.XBENCH_GDPVAL_IID || undefined;
  const report = await runGdpval({
    taskSet: process.env.XBENCH_GDPVAL_TASKSET ?? 'gdpval-pilot',
    taskIds: iid ? [iid] : undefined,
    limit: process.env.XBENCH_GDPVAL_LIMIT ? Number(process.env.XBENCH_GDPVAL_LIMIT) : undefined,
    concurrency: Number(process.env.XBENCH_GDPVAL_CONC ?? 3),
    account: process.env.XBENCH_GDPVAL_ACCOUNT || undefined,
    outDir: process.env.XBENCH_GDPVAL_OUTDIR || undefined,
    agentConfig: {
      maxTurns: Number(process.env.XBENCH_GDPVAL_MAXTURNS ?? 20),
      maxTotalTokens: Number(process.env.XBENCH_GDPVAL_MAXTOK ?? 400_000),
    },
    log: (m) => console.log(m),
  });
  console.log('\n=== GDPval per-occupation win-rate ===');
  for (const g of report.report.byOccupation) {
    console.log(`  ${g.group.padEnd(40)} win-rate ${(g.winRate * 100).toFixed(0)}% (W${g.wins}/T${g.ties}/L${g.losses})`);
  }
}

main().catch((e) => {
  console.error('GDPVAL RUN ERROR:', e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
