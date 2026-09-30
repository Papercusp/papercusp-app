/** validate-gen0-collect.ts — re-run JUST the metric collection on an already-completed bee spawn
 * (no new bee, no judge, no spend) to confirm the timestamptz-string→Date fix. Usage: tsx … <spawnId> <variant> */
import { makeLiveBeeTraceLoaders } from '../packages/operator-core/lib/iq-battery/bee-instance';
import { makeBeeCollectAndDistill } from '../packages/operator-core/lib/iq-battery/bee-trace';
import { createMetricsCollector } from '../packages/operator-core/lib/iq-battery/collectors';
import { getOrgPg } from '@papercusp/db-org';

async function main() {
  const spawnId = process.argv[2];
  const variant = process.argv[3] || 'fix-injected-bug';
  const { sql } = getOrgPg();
  const cd = makeBeeCollectAndDistill(makeLiveBeeTraceLoaders(sql));
  const r = await cd({
    handle: { instanceId: spawnId, instanceUrl: '', costUsd: 0 },
    case: { id: 'validate', variant } as never,
    maxChars: 5000,
  });
  console.log('signals:', JSON.stringify(r.signals, (k, v) => (v instanceof Date ? `Date(${v.toISOString()})` : v)));
  const collector = await createMetricsCollector(sql);
  const m = await collector.collectMetrics({ ...r.signals, runId: 'validate-collect', caseId: 'validate', variant });
  console.log('metrics:', JSON.stringify(m));
  console.log('✓ collection ran without error (date coercion works)');
}
main().then(() => process.exit(0)).catch((e) => { console.error('VALIDATE FAILED: ' + (e instanceof Error ? e.message : String(e))); process.exit(1); });
