/**
 * drill-cli.ts — SUPERVISED Red Queen drill runner
 * (self-learning-frontier-2026-06-12 P-031 / FB-20; mirrors
 * lib/fleet-ekg/backtest-cli.ts as the committed live-proof entry point).
 *
 * Runs drill cycles directly against the live DB — sandbox workspace only,
 * SQL-only, $0. This is the SUPERVISED path (a human at the keyboard): it
 * deliberately skips the flag + governor gates, which exist to stop the
 * UNATTENDED cadence (the system action) until the P-001 arming acts. The
 * brief's "first drill class round-trips in the sandbox" proof runs here.
 *
 *   tsx lib/red-queen/drill-cli.ts                      # one cycle, rotation pick
 *   tsx lib/red-queen/drill-cli.ts --class smoke-fail   # one cycle, named class
 *   tsx lib/red-queen/drill-cli.ts --all                # every registered class once
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { DRILL_CLASSES, drillClassById } from './drill-classes';
import { defaultDrillCycleDeps, runDrillCycle, runRedQueenTick } from './sandbox';
import type { DrillCycleResult } from './sandbox';

function show(r: DrillCycleResult): void {
  const m = r.mttsh;
  const lc = r.leakCheck;
  console.log(
    `  ${r.drillClass}: ${r.status}${r.reason ? ` (${r.reason})` : ''}` +
      (m ? ` — detect ${m.detectMs}ms → triage ${m.triageMs}ms → fix ${m.fixMs}ms (total ${m.totalMs}ms)` : '') +
      (lc
        ? ` — leak check ${lc.passed ? 'CLEAN' : 'FAILED'} (organicRead=${lc.organicReadClean}, liveCollectors=${lc.liveCollectorClean}, origin=${lc.capturedOriginIsDrill})`
        : '') +
      (r.issueId ? ` — issue ${r.issueId}` : ''),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const classArg = args.includes('--class') ? args[args.indexOf('--class') + 1] : undefined;
  const all = args.includes('--all');
  const { sql } = getOrgPg();
  const deps = defaultDrillCycleDeps(sql, activeWorkspaceId());

  let failures = 0;
  if (all) {
    console.log(`[drill-cli] running every drill class once (${DRILL_CLASSES.length} classes, sandbox workspace)`);
    for (const cls of DRILL_CLASSES) {
      const r = await runDrillCycle(cls, deps);
      show(r);
      if (!r.ok) failures += 1;
    }
  } else if (classArg) {
    const cls = drillClassById(classArg);
    if (!cls) {
      console.error(`[drill-cli] unknown class "${classArg}" — registered: ${DRILL_CLASSES.map((c) => c.id).join(', ')}`);
      process.exit(2);
    }
    const r = await runDrillCycle(cls, deps);
    show(r);
    if (!r.ok) failures += 1;
  } else {
    const tick = await runRedQueenTick(deps);
    console.log(`[drill-cli] tick status ${tick.status} (expired ${tick.expired})`);
    if (tick.cycle) {
      show(tick.cycle);
      if (!tick.cycle.ok) failures += 1;
    }
  }
  await sql.end({ timeout: 5 });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[drill-cli] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
