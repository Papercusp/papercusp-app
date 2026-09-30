/**
 * provision-workflow — Phase 1 (P-001) of `dbos-durable-flows-adoption-2026-06-02`.
 *
 * The `(harness, plugin)` setup/teardown/verify provision as a DBOS durable
 * workflow. The whole phase runs as ONE checkpointed step (a provision script is
 * idempotent at the phase level — re-running setup is the recovery path — so a
 * crash mid-flow re-runs the phase via DBOS recovery, never a half-checkpointed
 * sandbox).
 *
 * What DBOS REPLACES from the hand-rolled `provision/runner` machinery
 * (`operator-claims.ts`):
 *   - the PG `operator_claims` advisory-lock + TTL → the workflow's
 *     `deduplicationID` (the in-flight cross-request mutex; freed on completion
 *     so sequential re-provisions still run);
 *   - the 30s heartbeat `setInterval` → not needed; a PENDING DBOS workflow holds
 *     its dedup slot for its whole lifetime with no keepalive;
 *   - runtime DDL (`ensureClaimsTable`'s `CREATE TABLE IF NOT EXISTS`, which
 *     violated the no-runtime-DDL policy) → gone entirely on this path.
 *
 * A/B + instantly revertible: flag-gated by `dbosProvisionActive()` (now default-on
 * — D-002; disable with PAPERCUSP_DBOS_PROVISION=0). When OFF, `runner.runPhase`
 * does the legacy claim path unchanged and the route calls it directly; when ON
 * (the default), the runner skips the claim and the route routes through
 * `startProvisionWorkflow`. The verify-then-DELETE of the hand-rolled machinery is
 * the remaining P-002 cutover step (no shim — pre-alpha).
 *
 * Testability mirrors `orchestrator-workflow`: the phase executor is INJECTED
 * (`setProvisionExecutor`), defaulting to the real `runPhase` (lazily imported so
 * the heavy sandbox deps load only on this path). The integration test injects a
 * stub so the DBOS dedup/resume mechanics are proven without spawning sandboxes.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';
import type { ProvisionPhase, ProvisionRunInputs, ProvisionRunResult } from '../provision/runner';

/** The DBOS `dbosErrorCode` for "a workflow with this deduplicationID is already
 *  queued" (QueueDedupIDDuplicated = 28). Detected by code so we need not import
 *  the (non-index-exported) error class. */
const QUEUE_DEDUP_DUPLICATED_CODE = 28;

export function isDedupConflict(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { dbosErrorCode?: number }).dbosErrorCode === QUEUE_DEDUP_DUPLICATED_CODE
  );
}

export interface ProvisionKeyInput {
  workspaceId: string;
  harness: string;
  plugin: string;
  phase: ProvisionPhase;
  /** Per-request unique token → makes the workflowID unique so DBOS recovery
   *  resumes THIS request and a later re-provision is a fresh workflow. */
  nonce: string;
}

/**
 * Derive the DBOS keys for one provision request. Pure (unit-tested):
 *   - `deduplicationID` is the (workspace, harness, plugin, phase) target — the
 *     concurrent mutex replacing the operator-claims advisory lock. A second
 *     concurrent provision of the SAME target dedups (the loser throws); the slot
 *     frees on completion so a sequential re-provision runs.
 *   - `workflowID` is the target + a per-request nonce — unique per request, so a
 *     crash resumes exactly this run (DBOS recovery) and a later request is a new
 *     workflow.
 */
export function provisionWorkflowKeys(
  input: ProvisionKeyInput,
): { workflowID: string; deduplicationID: string } {
  const target = `provision:${input.workspaceId}:${input.harness}:${input.plugin}:${input.phase}`;
  return { deduplicationID: target, workflowID: `${target}:${input.nonce}` };
}

/** A provision result mirroring the legacy claim-conflict shape (runner.ts:213). */
export function conflictResult(phase: ProvisionPhase): ProvisionRunResult {
  return {
    ok: false,
    phase,
    decision: 'fresh',
    durationMs: 0,
    error: 'claim conflict: a provision for this plugin is already in progress',
  };
}

export interface ProvisionWorkflowInput {
  phase: ProvisionPhase;
  inputs: ProvisionRunInputs;
}

export type ProvisionExecutor = (
  phase: ProvisionPhase,
  inputs: ProvisionRunInputs,
) => Promise<ProvisionRunResult>;

// Default executor lazily imports the real runner so the sandbox/audit/state deps
// only load on the DBOS-provision path (and tests can inject a stub before use).
let _executor: ProvisionExecutor | null = null;
export function setProvisionExecutor(fn: ProvisionExecutor | null): void {
  _executor = fn;
}
async function execute(phase: ProvisionPhase, inputs: ProvisionRunInputs): Promise<ProvisionRunResult> {
  if (_executor) return _executor(phase, inputs);
  const { runPhase } = await import('../provision/runner');
  return runPhase(phase, inputs);
}

async function provisionWorkflowImpl(input: ProvisionWorkflowInput): Promise<ProvisionRunResult> {
  // ONE checkpointed step = the whole phase. A provision script is idempotent at
  // the phase level, so a crash re-runs the phase (no half-applied checkpoint).
  // Light step retry covers a transient infra hiccup; the script's own failure
  // surfaces as a non-ok result (not a step throw), so it is not retried.
  return await DBOS.runStep(() => execute(input.phase, input.inputs), {
    name: `provision-${input.phase}`,
    retriesAllowed: true,
    maxAttempts: 2,
    intervalSeconds: 10,
  });
}

export const provisionWorkflow = idempotentRegisterWorkflow('provision', () =>
  DBOS.registerWorkflow(provisionWorkflowImpl, {
    name: 'provision',
    maxRecoveryAttempts: 5,
  }),
);

// Provisions are interactive + infrequent; a small global concurrency cap is
// plenty. The per-target mutex is the deduplicationID, not the queue width.
// WI-4015: idempotentWorkflowQueue guards the module-top-level-DBOS-singleton class
// (see idempotent-register-workflow.ts's doc comment).
export const provisionQueue = idempotentWorkflowQueue('provision', () =>
  new WorkflowQueue('provision', { concurrency: queueConcurrency(4) }),
);

/**
 * Start (or, on a concurrent duplicate, decline) a provision as a durable
 * workflow, then await its result so the HTTP route keeps its synchronous
 * request→result contract. A concurrent provision of the same target is the
 * loser of the dedup and returns a claim-conflict result (legacy parity).
 */
export async function startProvisionWorkflow(
  workspaceId: string,
  phase: ProvisionPhase,
  inputs: ProvisionRunInputs,
  nonce: string,
): Promise<ProvisionRunResult> {
  const { workflowID, deduplicationID } = provisionWorkflowKeys({
    workspaceId,
    harness: inputs.harness,
    plugin: inputs.plugin,
    phase,
    nonce,
  });
  try {
    const handle = await DBOS.startWorkflow(provisionWorkflow, {
      workflowID,
      queueName: provisionQueue.name,
      enqueueOptions: { deduplicationID },
    })({ phase, inputs });
    return await handle.getResult();
  } catch (e) {
    if (isDedupConflict(e)) return conflictResult(phase);
    throw e;
  }
}
