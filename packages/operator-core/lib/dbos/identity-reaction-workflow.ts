/**
 * `identityReaction` — the durable executor for one identity reaction
 * (portable-identity-packages-2026-09-26 P-018; D-027 §5, D-029 §5/§6).
 *
 * Its own workflow and queue, NOT the generic `eventReaction` one: that queue is
 * wired only under `PAPERCUSP_DBOS_REACTIONS=1`, which no unit sets, so generic
 * reactions run in-process in production. An identity reaction never does. This
 * workflow is registered whenever the DBOS orchestrator is (bootstrap.ts), and
 * the emit reaches it from any host: `DBOS.startWorkflow` where DBOS runs,
 * otherwise a `DBOSClient` enqueue onto the primary (the request workers never
 * launch DBOS). The workflow id and dedup id are both the receipt id, so a
 * replayed enqueue returns the existing run.
 *
 * One retried step runs `executeIdentityReaction`. A step that exhausts its
 * retries failed on a LIVE LOOKUP (the only thing it throws on), so the workflow
 * records the receipt `failed` / authorization-unavailable: nothing dispatched,
 * nothing granted.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';
import { dbosOrchestratorActive } from './dbos-flags';
import { dbosStarted } from './bootstrap';
import { getPrimaryDbosClient, primaryDbosAppVersion } from './primary-dbos-client';
import { getOrgPg } from '@papercusp/db-org';
import {
  executeIdentityReaction,
  settleIdentityReceipt,
  type IdentityReactionPayload,
} from '../events/identity-reaction';

export const IDENTITY_REACTION_WORKFLOW_NAME = 'identityReaction';

async function identityReactionImpl(payload: IdentityReactionPayload): Promise<void> {
  try {
    await DBOS.runStep(() => executeIdentityReaction(payload), {
      name: `identity-react:${payload.pinRef}`,
      retriesAllowed: true,
      maxAttempts: 3,
      intervalSeconds: 2,
      backoffRate: 2,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await DBOS.runStep(() => settleIdentityReceipt(getOrgPg().sql, payload.receiptId, {
      status: 'failed',
      error: `authorization-unavailable: ${message}`,
    }), { name: 'identity-react:authorization-unavailable' });
  }
}

export const identityReactionWorkflow = idempotentRegisterWorkflow(IDENTITY_REACTION_WORKFLOW_NAME, () =>
  DBOS.registerWorkflow(identityReactionImpl, {
    name: IDENTITY_REACTION_WORKFLOW_NAME,
    maxRecoveryAttempts: 5,
  }),
);

// WI-4015: idempotentWorkflowQueue guards the module-top-level-DBOS-singleton class
// (see idempotent-register-workflow.ts's doc comment).
export const identityReactionsQueue = idempotentWorkflowQueue('identity-reactions', () =>
  new WorkflowQueue('identity-reactions', { concurrency: queueConcurrency(4) }),
);

/** The slice of `DBOSClient` this enqueue uses (injectable for tests). */
export interface IdentityReactionRemoteClient {
  enqueue(options: {
    queueName: string;
    workflowName: string;
    workflowID: string;
    deduplicationID: string;
    duplicationPolicy: 'return-existing';
    appVersion: string;
  }, input: IdentityReactionPayload): Promise<unknown>;
  getWorkflow(workflowId: string): Promise<unknown | undefined>;
}

export class IdentityReactionEnqueueUncertainError extends Error {
  constructor(readonly workflowId: string, cause: unknown) {
    super(`identity reaction enqueue outcome unknown for ${workflowId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'IdentityReactionEnqueueUncertainError';
  }
}

function inStep(): boolean {
  try {
    return DBOS.isInStep();
  } catch {
    return false;
  }
}

/**
 * Enqueue one identity reaction. `unavailable` only when no enqueue was
 * attempted; an attempted enqueue with an unconfirmed outcome throws.
 */
export async function enqueueIdentityReaction(
  payload: IdentityReactionPayload,
  deps: {
    orchestratorActive?: () => boolean;
    started?: () => boolean;
    remoteClient?: () => Promise<IdentityReactionRemoteClient>;
  } = {},
): Promise<'enqueued' | 'unavailable'> {
  if (!(deps.orchestratorActive ?? dbosOrchestratorActive)()) return 'unavailable';
  const id = payload.receiptId;
  const remoteClient = deps.remoteClient
    ?? (getPrimaryDbosClient as unknown as () => Promise<IdentityReactionRemoteClient>);

  // Where DBOS runs and this is not already inside a step, start it directly. A
  // step cannot start a workflow, but a client enqueue is an ordinary write.
  if ((deps.started ?? dbosStarted)() && !inStep()) {
    try {
      await DBOS.startWorkflow(identityReactionWorkflow, {
        workflowID: id,
        queueName: identityReactionsQueue.name,
        enqueueOptions: { deduplicationID: id },
        duplicationPolicy: 'return-existing',
      })(payload);
      return 'enqueued';
    } catch (error) {
      const client = await remoteClient().catch(() => null);
      if (client && await client.getWorkflow(id).catch(() => undefined)) return 'enqueued';
      throw new IdentityReactionEnqueueUncertainError(id, error);
    }
  }

  let client: IdentityReactionRemoteClient;
  try {
    client = await remoteClient();
  } catch (error) {
    console.warn(`[identity-reaction] DBOS client unavailable (${id}): ${error instanceof Error ? error.message : error}`);
    return 'unavailable';
  }
  try {
    await client.enqueue({
      queueName: identityReactionsQueue.name,
      workflowName: IDENTITY_REACTION_WORKFLOW_NAME,
      workflowID: id,
      deduplicationID: id,
      duplicationPolicy: 'return-existing',
      appVersion: primaryDbosAppVersion(),
    }, payload);
    return 'enqueued';
  } catch (error) {
    if (await client.getWorkflow(id).catch(() => undefined)) return 'enqueued';
    throw new IdentityReactionEnqueueUncertainError(id, error);
  }
}
