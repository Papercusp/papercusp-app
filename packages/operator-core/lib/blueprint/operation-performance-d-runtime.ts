/** P-013 workload D runtime boot, shared by the Vitest parent and the fresh cold child.
 *
 * Isolation (brief-d / D-019 tests): DBOS runs against its OWN system schema
 * (`P013D_DBOS_SCHEMA`) inside the throwaway org database, with an executor id unique to this
 * process (DBOS__VMID) so recovery only ever touches this process's own workflows — never the
 * shared `dbos` queue. Nested tools resolve through the real projected-tool registry and the real
 * role gate (the durable runtime seam is left at its default), so both arms pay the live
 * authorization path. */
import type { Sql } from 'postgres';
import {
  P013D_DBOS_SCHEMA, ensureP013DSchema, inspectCandidatePin, p013DFixtureTools, type P013DRuntime, type P013DTools,
} from './operation-performance-d-driver';

export interface BootedP013DRuntime extends P013DRuntime {
  durable: boolean;
  shutdown: () => Promise<void>;
  /** D-022(a) positive control: embed calls served by the deterministic fixture embedder. */
  embedderCalls: () => number;
}

let fixturesRegistered = false;
/** Names of production DBOS scheduled workflows whose registration this process suppressed. */
let suppressedScheduleNames: readonly string[] = [];
export const p013DSuppressedSchedules = (): readonly string[] => suppressedScheduleNames;

export async function bootP013DRuntime(opts: {
  sql: Sql;
  systemDsn: string;
  executorId: string;
  /** false: foreground-only process (control cold child) — DBOS is never launched. */
  durable: boolean;
  /** DBOS system schema for this executor (default: the shared P013D schema). A cold candidate
   * child passes a schema of its own and drops it on shutdown: executors that share a system
   * schema also share its queues, so the long-lived parent would otherwise dequeue and execute
   * the child's workflow, and the "cold" sample would silently measure the warm parent. */
  dbosSchema?: string;
  dropDbosSchemaOnShutdown?: boolean;
}): Promise<BootedP013DRuntime> {
  const dbosSchema = opts.dbosSchema ?? P013D_DBOS_SCHEMA;
  if (!/^[a-z_][a-z0-9_]*$/.test(dbosSchema)) throw new Error(`P-013 D: unsafe DBOS schema name ${dbosSchema}`);
  // D-022(a): no provider in the timed path. Any embed on either arm (e.g. a memory recall
  // reached through the tool catalog) is served by the deterministic in-process fixture;
  // installed before any tool module loads so no lazy import can capture the real embedder.
  // The memoryHost override does NOT reach the search-side QUERY embedder
  // (agent-tools/search/embedder buildQueryEmbedderResolved), which in a cold child
  // loaded real onnx embeddinggemma (CUDA OOM/SIGABRT, >120s cpu fallback — EI-24442961772316947).
  // Pin that leg off for both arms: search degrades to BM25, no model load in the timed path.
  process.env.PAPERCUSP_MEMORY_EMBEDDER = 'disabled';
  const embedder = await (await import('../../test/_deterministic-embedder')).installDeterministicEmbedder();
  const { registerProjectedTool } = await import('@papercusp/tooldef');
  await ensureP013DSchema(opts.sql);
  if (!fixturesRegistered) {
    for (const tool of p013DFixtureTools(() => opts.sql)) registerProjectedTool(tool);
    fixturesRegistered = true;
  }
  let shutdown = async () => {};
  let awaitDurable: P013DRuntime['awaitDurable'] = async () => {
    throw new Error('P-013 D: DBOS not launched in this process');
  };
  if (opts.durable) {
    const { DBOS } = await import('@dbos-inc/dbos-sdk');
    process.env.DBOS__VMID = opts.executorId;
    DBOS.setConfig({
      name: 'p013-workload-d',
      systemDatabaseUrl: opts.systemDsn,
      systemDatabaseSchemaName: dbosSchema,
      applicationVersion: 'p013-workload-d-v1',
      runAdminServer: false,
    });
    // Benchmark hygiene: the tool catalog imported below registers ~54 production DBOS scheduled
    // workflows (routinesTick every 30s, sweeps, GCs). In this executor they would fire inside
    // the timed window — timing noise, and routinesTick hardcodes the shared `dbos` schema, so it
    // also errors. Registration is suppressed (not the workflows themselves: they stay registered
    // so the catalog loads unchanged); the count is exposed as a positive control.
    const suppressedSchedules: string[] = [];
    const dbosStatics = DBOS as unknown as { registerScheduled: (fn: unknown, cfg?: { name?: string }) => void };
    dbosStatics.registerScheduled = (fn, cfg) => {
      suppressedSchedules.push(cfg?.name ?? (fn as { name?: string }).name ?? 'anonymous');
    };
    suppressedScheduleNames = suppressedSchedules;
    // Registers the durableOrchestration workflow before launch.
    await import('../dbos/durable-orchestration-workflow');
    // The durable runtime lazily loads the whole tool catalog, whose modules register DBOS
    // workflows (e.g. featurePipeline) at import. Production (dbos/bootstrap.ts) registers
    // them all before launch; mirror that so nothing registers after DBOS.launch().
    await import('../agent-tools/index');
    await DBOS.launch();
    (globalThis as { __papercuspDbosStarted?: boolean }).__papercuspDbosStarted = true;
    // DBOS.getResult by id re-reads workflow_status every 1000 ms by default, which quantized the
    // candidate's terminal mark to accepted + k*1000 ms (WI-10003560). Poll at 5 ms so the
    // instrument adds at most 5 ms, charged to the candidate.
    awaitDurable = (workflowId, timeoutSec) =>
      DBOS.getResult(workflowId, { timeoutSeconds: timeoutSec, pollingIntervalMs: 5 });
    shutdown = async () => {
      (globalThis as { __papercuspDbosStarted?: boolean }).__papercuspDbosStarted = false;
      await DBOS.shutdown();
      if (opts.dropDbosSchemaOnShutdown && dbosSchema !== P013D_DBOS_SCHEMA) {
        await opts.sql.unsafe(`DROP SCHEMA IF EXISTS "${dbosSchema}" CASCADE`);
      }
    };
  }
  const [{ default: runTool }, { default: inspectTool }] = await Promise.all([
    import('../agent-tools/orchestration/run'),
    import('../agent-tools/orchestration/inspect'),
  ]);
  const tools = { runTool, inspectTool } as unknown as P013DTools;
  const pin = opts.durable ? await inspectCandidatePin(tools) : { sourceSha256: '', bindingsSha256: '' };
  return { sql: opts.sql, tools, awaitDurable, pin, dbosSchema, durable: opts.durable, shutdown, embedderCalls: embedder.calls };
}
