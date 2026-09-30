/** Fresh process boundary for one P-013 cold sample. The parent owns the
 * migrated throwaway database; this process only opens and closes its client. */
import postgres from 'postgres';
import {
  PG_BIGINT_AS_NUMBER_TYPES, PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES,
  restoreRawDateSerializers, restoreRawJsonbSerializer,
} from '../../../../libs/papercusp/libs/db/src/raw-serializers';
import { runP013WorkloadA, type P013Arm } from './operation-performance-driver';

const dsn = process.env.P013_COLD_DSN;
const arm = process.env.P013_COLD_ARM;
const sequence = Number(process.env.P013_COLD_SEQUENCE);
if (!dsn || (arm !== 'control' && arm !== 'candidate') || !Number.isSafeInteger(sequence)) {
  throw new Error('P-013 cold child requires a DSN, arm and integer sequence');
}

const sql = postgres(dsn, {
  max: 1, prepare: false, onnotice: () => {},
  connection: { search_path: 'harness_shared, public' },
  types: { ...PG_BIGINT_AS_NUMBER_TYPES, ...PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES },
});
restoreRawDateSerializers(sql);
restoreRawJsonbSerializer(sql);

try {
  // D-022(a): the claim-time memory recall's embedder is a D-016 provider, so a
  // fixture arm swaps in the deterministic in-process embedder BEFORE the tool
  // graph loads (the helper wires the operator memory host first, so a later
  // lazy import cannot restore the real embedder).
  const fixtureEmbedder = process.env.P013_FIXTURE_EMBEDDER === '1'
    ? await (await import('../../test/_deterministic-embedder')).installDeterministicEmbedder()
    : undefined;
  process.send?.({ kind: 'p013-stage', stage: 'loading-tools' });
  const [create, claim, complete, get, submit, events, result] = await Promise.all([
    import('../agent-tools/work_items/create'),
    import('../agent-tools/work_items/claim'),
    import('../agent-tools/work_items/complete'),
    import('../agent-tools/work_items/get'),
    import('../agent-tools/blueprint/submit-operation'),
    import('../agent-tools/blueprint/events-operation'),
    import('../agent-tools/blueprint/result-operation'),
  ]);
  process.send?.({ kind: 'p013-stage', stage: 'running-workload' });
  // Attribution probe (WI-10002948): the child SIGKILLs itself, so `--cpu-prof`
  // never writes. P013_COLD_PROFILE_DIR records a sampling profile through the
  // inspector instead, stopped and written before the sample leaves the process.
  const profileDir = process.env.P013_COLD_PROFILE_DIR;
  const profiler = profileDir ? new (await import('node:inspector/promises')).Session() : undefined;
  let profileStartedAt = 0;
  if (profiler) {
    profiler.connect();
    await profiler.post('Profiler.enable');
    await profiler.post('Profiler.setSamplingInterval', { interval: 500 });
    profileStartedAt = performance.timeOrigin + performance.now();
    await profiler.post('Profiler.start');
  }
  const sample = await runP013WorkloadA(sql, {
    createWorkItemTool: create.default,
    claimWorkItemTool: claim.default,
    completeWorkItemTool: complete.default,
    getWorkItemTool: get.default,
    submitOperationTool: submit.default,
    operationEventsTool: events.default,
    operationResultTool: result.default,
  }, arm as P013Arm, sequence);
  if (profiler && profileDir) {
    const { profile } = await profiler.post('Profiler.stop');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(`${profileDir}/p013-${arm}-${sequence}.cpuprofile`, JSON.stringify(profile));
    writeFileSync(`${profileDir}/p013-${arm}-${sequence}.marks.json`,
      JSON.stringify({ profileStartedAt, marks: sample.marks, phasesMs: sample.phasesMs }));
    profiler.disconnect();
  }
  if (!process.send) throw new Error('P-013 cold child requires an IPC channel');
  // Sent BEFORE the sample: the parent resolves on the sample, so the call
  // count must already be recorded by then.
  if (fixtureEmbedder) process.send({ kind: 'p013-embedder', calls: fixtureEmbedder.calls() });
  await new Promise<void>((resolve, reject) => process.send!({ kind: 'p013-sample', sample }, (error) =>
    error ? reject(error) : resolve()));
  process.send?.({ kind: 'p013-stage', stage: 'sample-sent' });
} catch (error) {
  console.error('P-013 cold child failed:', error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
  // The sample (or the failure on stderr, synchronous for pipes on Linux) is
  // flushed and SQL is closed. Terminate WITHOUT Node's env teardown: the tool
  // graph maps onnxruntime-node / node-pty / sharp, and process.exit() lets an
  // in-flight native callback throw Napi::Error during teardown -> terminate ->
  // SIGABRT after a good sample (measured 2026-09-27, WI-10002948; same class
  // and fix as host-recycle hardExitOnRecycle, EI-10702). The parent accepts
  // SIGKILL only when a sample arrived, so a failed child still fails.
  process.kill(process.pid, 'SIGKILL');
}
