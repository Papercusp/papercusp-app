/**
 * `eventReactionWorkflow` — the durable executor for one event-reaction
 * (event-reaction-system-2026-06-04, P1 / D-004 + D-007).
 *
 * A reaction's execution must never block its trigger, must survive a restart,
 * and must be idempotent under at-least-once delivery. So when the durable path
 * is enabled (`PAPERCUSP_DBOS_REACTIONS=1`), a matched reaction is ENQUEUED as a
 * DBOS workflow (concurrency-capped queue) instead of fired in-process. The
 * single checkpointed step claims the dedup id (idempotency) then dispatches the
 * reaction tool — a crash mid-fire resumes and the dedup claim makes a
 * re-delivery a no-op.
 *
 * Flag-gated like the other fresh DBOS capabilities: registered only when the
 * bootstrap imports it (opt-in). The enqueue runner is INJECTED into `lib/events`
 * via `wireDurableReactions()`, so the events engine pulls in no DBOS plumbing
 * and the workflow stays a thin durable wrapper over the (reusable, testable)
 * `executeDurableReaction`.
 */

import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';
import { executeDurableReaction, type DurableReactionPayload } from '../events/durable-exec';
import { setDurableReactionRunner, type DurableReactionInput } from '../events/durable';
import { serializeParent, computeDedupId } from '../events/reaction-id';

async function reactionImpl(payload: DurableReactionPayload): Promise<void> {
  // One checkpointed step: claim-dedup + dispatch. Retried by DBOS on failure;
  // the dedup claim (released on failure) keeps a successful fire from repeating.
  await DBOS.runStep(() => executeDurableReaction(payload), {
    name: `react:${payload.fire}`,
    retriesAllowed: true,
    maxAttempts: 3,
    intervalSeconds: 2,
    backoffRate: 2,
  });
}

export const eventReactionWorkflow = idempotentRegisterWorkflow('eventReaction', () =>
  DBOS.registerWorkflow(reactionImpl, {
    name: 'eventReaction',
    maxRecoveryAttempts: 5,
  }),
);

// WI-4015: idempotentWorkflowQueue guards the module-top-level-DBOS-singleton class
// (see idempotent-register-workflow.ts's doc comment).
export const reactionsQueue = idempotentWorkflowQueue('event-reactions', () =>
  new WorkflowQueue('event-reactions', { concurrency: queueConcurrency(4) }),
);

/**
 * Enqueue a reaction as a durable workflow. Fire-and-forget — does NOT await the
 * workflow result. The workflow id + dedup id are the deterministic reaction
 * dedup id, so a concurrent double-enqueue collapses to one run.
 */
export async function enqueueDurableReaction(input: DurableReactionInput): Promise<void> {
  const dedupId = computeDedupId(input);
  const payload: DurableReactionPayload = {
    fire: input.fire,
    args: input.args,
    parent: serializeParent(input.event.ctx),
    cause: input.cause,
    ruleId: input.rule.id,
    triggerTool: input.event.tool,
    dedupId,
    capability: input.rule.capability,
    // WHO contributed the rule, carried into the durable claim so the fire
    // ledger can be grouped by contributor (P-030 a/c). `source` is set by the
    // plugin path (`plugin:<name>`) and the standalone path (`standalone:<id>`);
    // a first-party built-in rule leaves it unset, which stores as NULL.
    contributor: input.rule.source ?? null,
  };
  await DBOS.startWorkflow(eventReactionWorkflow, {
    workflowID: `reaction:${dedupId}`,
    queueName: reactionsQueue.name,
    enqueueOptions: { deduplicationID: dedupId },
  })(payload);
}

/** Install the durable enqueue runner into lib/events (called by the DBOS bootstrap when enabled). */
export function wireDurableReactions(): void {
  setDurableReactionRunner(enqueueDurableReaction);
}
