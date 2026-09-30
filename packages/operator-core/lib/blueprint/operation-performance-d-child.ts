/** P-013 workload D cold child: a fresh Node process runs exactly one sample on one arm.
 * Candidate children launch their own DBOS executor (unique DBOS__VMID) against the isolated
 * P013D system schema; control children never launch DBOS (foreground needs none). Setup is
 * outside the timed window; the marks start at the orchestrate:run call. */
import postgres from 'postgres';
import { runP013WorkloadD, type P013DArm } from './operation-performance-d-driver';
import { bootP013DRuntime } from './operation-performance-d-runtime';

const dsn = process.env.P013_COLD_DSN;
const arm = process.env.P013_COLD_ARM as P013DArm | undefined;
const runId = process.env.P013_COLD_RUN_ID;
if (!dsn || (arm !== 'control' && arm !== 'candidate') || !runId) {
  throw new Error('P-013 D cold child configuration is incomplete');
}
const sql = postgres(dsn, { max: 4, onnotice: () => {} });
let shutdown = async () => {};
try {
  process.send?.({ kind: 'p013-stage', stage: 'booting' });
  // Own DBOS system schema per candidate child (created at launch, dropped at shutdown — both
  // outside the timed window), so the parent's live executor cannot dequeue this child's run.
  const dbosSchema = `dbos_p013d_c_${runId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 63);
  const rt = await bootP013DRuntime({
    sql, systemDsn: dsn, executorId: `p013d-${runId}`, durable: arm === 'candidate',
    dbosSchema, dropDbosSchemaOnShutdown: true,
  });
  shutdown = rt.shutdown;
  process.send?.({ kind: 'p013-stage', stage: 'running-workload' });
  const sample = await runP013WorkloadD(rt, arm, runId);
  if (!process.send) throw new Error('P-013 D cold child requires an IPC channel');
  await new Promise<void>((resolve, reject) => process.send!({ kind: 'p013-sample', sample }, (error) =>
    error ? reject(error) : resolve()));
} catch (error) {
  console.error('P-013 D cold child failed:', error);
  process.exitCode = 1;
} finally {
  await shutdown().catch(() => {});
  await sql.end({ timeout: 5 });
  process.exit(process.exitCode ?? 0);
}
