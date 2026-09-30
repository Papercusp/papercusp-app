/**
 * idempotentRegisterWorkflow — a globalThis-cached guard around DBOS.registerWorkflow
 * (WI-3830, 2026-07-10 critical incident).
 *
 * `DBOS.registerWorkflow` is called at MODULE TOP LEVEL across this codebase's dbos/
 * workflow files (`export const xWorkflow = DBOS.registerWorkflow(impl, { name, ... })`).
 * DBOS's own registry is a process-wide SINGLETON keyed by name: the SDK's decorators.js
 * throws `DBOSConflictingRegistrationError` ("Operation (Name: ...) is already
 * registered.") the second time the SAME name is registered from a DIFFERENT
 * registration object — which is exactly what happens if the module executes a SECOND
 * time within one process's lifetime (a require-cache hot-reload, a duplicate module
 * resolution path, or any other route to a second top-level evaluation of the same
 * file). Because the registration happens at module top level, that throw takes down
 * the WHOLE module load — and every unrelated consumer that imports it — with it. This is
 * exactly what WI-3830 hit: `featurePipelineWorkflow`'s registration failed on a (still
 * unconfirmed) second load, and because `startFeaturePipeline` (used by BOTH
 * `fleet:place_batch` and a plain `cup:spawn`) imports this same module, EVERY fresh
 * cup/bee spawn broke fleet-wide — not just the one workflow.
 *
 * Fix: cache the FIRST registration's result on `globalThis` — shared across every
 * module instance in one process/V8 realm regardless of how many times a given file
 * specifier gets re-evaluated (the standard Node idiom for a hot-reload-safe singleton,
 * e.g. the Prisma Client global-cache pattern). A second load in the SAME process
 * reuses the cached handle instead of calling `DBOS.registerWorkflow` again — so
 * `DBOS.registerWorkflow` runs AT MOST ONCE per name per process, and a double-load can
 * no longer hard-crash the registration path.
 *
 * Scope note: this is wired into `orchestrator-workflow.ts`'s `featurePipelineWorkflow`
 * (the reported call site) first. The SAME module-level-registration shape appears in
 * ~13 other dbos/*.ts files (periodic-workflows.ts alone has ~30 registrations) — each
 * is an instance of the SAME latent class, but migrating all of them is a larger,
 * separately-reviewed follow-up (filed WI-3831), not bundled into this incident fix.
 */
import type { WorkflowConfig, FunctionName, WorkflowQueue } from '@dbos-inc/dbos-sdk';

type GlobalRegistry = typeof globalThis & {
  __papercuspDbosWorkflowCache__?: Map<string, unknown>;
  __papercuspDbosQueueCache__?: Map<string, unknown>;
};

function registryCache(): Map<string, unknown> {
  const g = globalThis as GlobalRegistry;
  if (!g.__papercuspDbosWorkflowCache__) g.__papercuspDbosWorkflowCache__ = new Map();
  return g.__papercuspDbosWorkflowCache__;
}

function queueCache(): Map<string, unknown> {
  const g = globalThis as GlobalRegistry;
  if (!g.__papercuspDbosQueueCache__) g.__papercuspDbosQueueCache__ = new Map();
  return g.__papercuspDbosQueueCache__;
}

/**
 * Register a DBOS workflow at most once per process, per `key`. `key` should be the
 * workflow's registered `name` (or another value stable across re-loads of the same
 * source file) — NOT derived from anything that changes per load (e.g. a timestamp).
 *
 * Usage (replaces a bare `DBOS.registerWorkflow(impl, config)` call):
 *   export const fooWorkflow = idempotentRegisterWorkflow('foo', () =>
 *     DBOS.registerWorkflow(fooImpl, { name: 'foo', ...config }),
 *   );
 */
export function idempotentRegisterWorkflow<This, Args extends unknown[], Return>(
  key: string,
  register: () => (this: This, ...args: Args) => Promise<Return>,
): (this: This, ...args: Args) => Promise<Return> {
  const cache = registryCache();
  const cached = cache.get(key);
  if (cached) return cached as (this: This, ...args: Args) => Promise<Return>;
  const registered = register();
  cache.set(key, registered);
  return registered;
}

/**
 * idempotentWorkflowQueue — the SAME globalThis-cached-singleton guard as
 * idempotentRegisterWorkflow above, applied to `new WorkflowQueue(name, config)`
 * (WI-4015, 2026-07-11 critical incident: bg-host DBOS routines DOWN fleet-wide since
 * 20:39 EDT — git-sync, cross-hive-outbox-drain/federation replication, scout-cycle,
 * green-checkpoint, and every scheduled loop wake ALL stalled).
 *
 * `new WorkflowQueue(name, ...)` hits the EXACT SAME class of bug documented above for
 * `DBOS.registerWorkflow`: DBOS's queue registry is a process-wide singleton keyed by
 * name, and constructing a SECOND `WorkflowQueue` with the same name (from a second
 * top-level evaluation of the defining module within one process) throws
 * "Workflow Queue '<name>' defined multiple times" — but because this construction sits
 * at MODULE TOP LEVEL (`export const pipelineQueue = new WorkflowQueue('feature-pipeline', ...)`),
 * the throw happens DURING `startDbos()`'s import chain, which host-bootstrap.ts's
 * `startDbos()` caller catches as merely "[dbos] boot failed (non-fatal)" and swallows —
 * so DBOS.launch() never actually completes and NO scheduled workflow (routinesTick
 * included) ever arms, even though the process stays up. Confirmed live 2026-07-11:
 * this fired on 5/5 consecutive boots under the tsx-direct fallback entrypoint (never
 * seen under the bundled esbuild entry, which collapses every import of a module into
 * one instance) — same latent-class shape WI-3830 already fixed for `registerWorkflow`,
 * just not yet extended to `WorkflowQueue` construction. See WI-3831 (the WI-3830
 * follow-up) for the broader "migrate every module-top-level DBOS registration in dbos/*.ts"
 * effort this is also an instance of.
 *
 * Usage (replaces a bare `new WorkflowQueue(name, config)` call):
 *   export const pipelineQueue = idempotentWorkflowQueue('feature-pipeline', () =>
 *     new WorkflowQueue('feature-pipeline', { concurrency: queueConcurrency(4) }),
 *   );
 */
export function idempotentWorkflowQueue(key: string, construct: () => WorkflowQueue): WorkflowQueue {
  const cache = queueCache();
  const cached = cache.get(key);
  if (cached) return cached as WorkflowQueue;
  const queue = construct();
  cache.set(key, queue);
  return queue;
}

// Re-exported so a call site's `config` object type-checks against the real DBOS types
// without importing them separately (keeps the usage example above self-contained).
export type { WorkflowConfig, FunctionName };
