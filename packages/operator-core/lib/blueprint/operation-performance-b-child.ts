/** Fresh process boundary for one P-013 workload B cold sample (D-016 cold = a
 * fresh Node process, module graph and PG client). The parent owns the migrated
 * throwaway database; this process only opens and closes its client. */
import postgres from 'postgres';
import {
  PG_BIGINT_AS_NUMBER_TYPES, PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES,
  restoreRawDateSerializers, restoreRawJsonbSerializer,
} from '../../../../libs/papercusp/libs/db/src/raw-serializers';
import { runP013WorkloadB, type P013BArm } from './operation-performance-b-driver';

const dsn = process.env.P013_COLD_DSN;
const arm = process.env.P013_COLD_ARM;
const sequence = Number(process.env.P013_COLD_SEQUENCE);
if (!dsn || (arm !== 'control' && arm !== 'candidate') || !Number.isSafeInteger(sequence)) {
  throw new Error('P-013 B cold child requires a DSN, arm and integer sequence');
}

const sql = postgres(dsn, {
  max: 1, prepare: false, onnotice: () => {},
  connection: { search_path: 'harness_shared, public' },
  types: { ...PG_BIGINT_AS_NUMBER_TYPES, ...PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES },
});
restoreRawDateSerializers(sql);
restoreRawJsonbSerializer(sql);

try {
  // D-022(a): swap in the deterministic embedder BEFORE the tool graph loads.
  const fixtureEmbedder = process.env.P013_FIXTURE_EMBEDDER === '1'
    ? await (await import('../../test/_deterministic-embedder')).installDeterministicEmbedder()
    : undefined;
  process.send?.({ kind: 'p013-stage', stage: 'loading-tools' });
  // Completion's finish legs dispatch these two as reaction tools by MCP name;
  // register them here exactly as the in-process test file does, or the cold
  // arm fails with `unknown reaction tool "plans:set-status"`.
  await Promise.all([
    import('../agent-tools/plans/set-status'),
    import('../agent-tools/plan-items/release'),
  ]);
  const [runNow, submit, result, claim, complete, publish, reconcile, runs] = await Promise.all([
    import('../agent-tools/plans/run-now'),
    import('../agent-tools/blueprint/submit-operation'),
    import('../agent-tools/blueprint/result-operation'),
    import('../agent-tools/work_items/claim'),
    import('../agent-tools/work_items/complete'),
    import('../agent-tools/plans/publish-outputs'),
    import('../harness/routines/reconcile-plan-runs'),
    import('../agent-tools/plans/runs'),
  ]);
  process.send?.({ kind: 'p013-stage', stage: 'running-workload' });
  const sample = await runP013WorkloadB(sql, {
    runNowTool: runNow.default, submitOperationTool: submit.default, operationResultTool: result.default,
    claimWorkItemTool: claim.default, completeWorkItemTool: complete.default, publishOutputsTool: publish.default,
    settle: (db) => reconcile.reconcileScheduledPlanRuns({ sql: db, harnessSlug: 'p013-benchmark-b-fixture' }),
    getPlanRun: runs.getPlanRun,
  }, arm as P013BArm, sequence);
  if (!process.send) throw new Error('P-013 B cold child requires an IPC channel');
  if (fixtureEmbedder) process.send({ kind: 'p013-embedder', calls: fixtureEmbedder.calls() });
  await new Promise<void>((resolve, reject) => process.send!({ kind: 'p013-sample', sample }, (error) =>
    error ? reject(error) : resolve()));
} catch (error) {
  console.error('P-013 B cold child failed:', error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
  // Same native-teardown avoidance as workload A's child (EI-10702).
  process.kill(process.pid, 'SIGKILL');
}
