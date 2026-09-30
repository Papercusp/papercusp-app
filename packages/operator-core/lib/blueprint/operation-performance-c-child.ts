/** Fresh process boundary for one P-013 workload C cold sample: a new Node
 * process, module graph, PG client AND DBOS executor. The parent owns the
 * migrated throwaway database and its isolated `dbos` system schema.
 *
 * Isolation: this executor gets its own executor id (DBOS__VMID) and its own
 * application version, so it can neither recover nor dequeue a workflow a
 * sibling child or the parent enqueued — each sample runs only its own program. */
import postgres from 'postgres';
import {
  PG_BIGINT_AS_NUMBER_TYPES, PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES,
  restoreRawDateSerializers, restoreRawJsonbSerializer,
} from '../../../../libs/papercusp/libs/db/src/raw-serializers';
import { runP013WorkloadC, type P013CArm } from './operation-performance-c-driver';

const dsn = process.env.P013_COLD_DSN;
const arm = process.env.P013_COLD_ARM;
const sequence = Number(process.env.P013_COLD_SEQUENCE);
if (!dsn || (arm !== 'control' && arm !== 'candidate') || !Number.isSafeInteger(sequence)) {
  throw new Error('P-013 C cold child requires a DSN, arm and integer sequence');
}

const sql = postgres(dsn, {
  max: 1, prepare: false, onnotice: () => {},
  connection: { search_path: 'harness_shared, public' },
  types: { ...PG_BIGINT_AS_NUMBER_TYPES, ...PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES },
});
restoreRawDateSerializers(sql);
restoreRawJsonbSerializer(sql);

let dbosLaunched = false;
try {
  process.send?.({ kind: 'p013-stage', stage: 'loading-tools' });
  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  DBOS.setConfig({
    name: 'p013-workload-c', systemDatabaseUrl: dsn, systemDatabaseSchemaName: 'dbos',
    applicationVersion: `p013c-${arm}-${sequence}`, runAdminServer: false,
  });
  const [submit, result, workflow, { BlueprintSchema }] = await Promise.all([
    import('../agent-tools/blueprint/submit-operation'),
    import('../agent-tools/blueprint/result-operation'),
    import('../dbos/coord-program-workflow'),
    import('@papercusp/orchestrator/blueprint'),
  ]);
  const { P013C_SOURCE } = await import('./operation-performance-c-driver');
  const blueprint = BlueprintSchema.parse(P013C_SOURCE);
  workflow.setCoordProgramBlueprintResolver(async () => blueprint);
  await DBOS.launch();
  dbosLaunched = true;
  process.send?.({ kind: 'p013-stage', stage: 'running-workload' });
  const sample = await runP013WorkloadC(sql, {
    submitOperationTool: submit.default,
    operationResultTool: result.default,
    workflow,
  }, arm as P013CArm, sequence);
  if (!process.send) throw new Error('P-013 C cold child requires an IPC channel');
  await new Promise<void>((resolve, reject) => process.send!({ kind: 'p013-sample', sample }, (error) =>
    error ? reject(error) : resolve()));
  process.send?.({ kind: 'p013-stage', stage: 'sample-sent' });
} catch (error) {
  console.error('P-013 C cold child failed:', error);
  process.exitCode = 1;
} finally {
  if (dbosLaunched) {
    const { DBOS } = await import('@dbos-inc/dbos-sdk');
    await DBOS.shutdown().catch(() => {});
  }
  await sql.end({ timeout: 5 });
  // Same terminate-without-teardown as workload A's child (EI-10702): the parent
  // accepts SIGKILL only when a sample arrived, so a failed child still fails.
  process.kill(process.pid, 'SIGKILL');
}
