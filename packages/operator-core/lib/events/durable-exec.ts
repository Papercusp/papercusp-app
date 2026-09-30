/**
 * `executeDurableReaction` — the body a DBOS reaction step runs (D-004 / D-007).
 *
 * The generic claim → dispatch → release-on-failure control flow lives in
 * `@papercusp/event-reaction`; this is the Papercusp binding that injects the
 * idempotency store (the PG dedup ledger) and the dispatcher (rebuilding the
 * reaction's scope from the serializable parent, then firing in-process). Kept
 * here (not in the DBOS module) so it is unit-testable with PG + the dispatcher
 * mocked, and so the DBOS module stays a thin durable wrapper.
 */

import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import {
  executeDurableReaction as genericExecuteDurableReaction,
  type DurableReactionPayload as GenericDurableReactionPayload,
} from '@papercusp/event-reaction';
import { fireReactionInProcess } from './dispatch-reaction';
import { claimReaction, releaseReaction, markReactionFailed } from './reaction-dedup';
import type { SerializableReactionParent } from './reaction-id';

/** The JSON-serializable workflow payload for one durable reaction. */
export type DurableReactionPayload = GenericDurableReactionPayload<SerializableReactionParent>;

export async function executeDurableReaction(payload: DurableReactionPayload): Promise<void> {
  await genericExecuteDurableReaction(payload, {
    // The PG idempotency ledger (migration 153) — `harness_shared.event_reactions`.
    store: { claim: claimReaction, release: releaseReaction, markFailed: markReactionFailed },
    // Rebuild the reaction's scope from the serializable parent and dispatch.
    fire: (p) =>
      fireReactionInProcess({
        fire: p.fire,
        args: p.args,
        parentCtx: { ...p.parent } as UnifiedToolContext,
        cause: p.cause,
        capability: p.capability,
      }),
    log: (msg) => console.warn(`[events] ${msg}`),
  });
}
