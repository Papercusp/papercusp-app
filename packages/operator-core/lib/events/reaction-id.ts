/**
 * Serializable reaction identity: the dedup id (D-007) + the serializable parent
 * ctx a durable reaction carries.
 *
 * A DBOS workflow input must be JSON-serializable, but a reaction's parent ctx
 * (`UnifiedToolContext`) carries functions (`log`, `emit`, `signal`, `tx`). So
 * the durable path extracts only the identity fields the reaction needs to
 * rebuild its scope, and computes a deterministic dedup id so a re-delivery
 * dedupes to one fire. The id computation is the generic
 * `@papercusp/event-reaction` `computeDedupId`; we supply the trigger's runId as
 * the fallback root.
 */

import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { computeDedupId as genericComputeDedupId } from '@papercusp/event-reaction';
import type { DurableReactionInput } from './durable';

/** The JSON-serializable subset of the trigger ctx a durable reaction needs. */
export interface SerializableReactionParent {
  workspaceId?: string;
  harnessSlug?: string;
  role?: string;
  featureId?: string | null;
  chunkId?: string | null;
  spawnId?: string;
  uiClientId?: string | null;
}

/** Extract the serializable identity fields from a trigger ctx. */
export function serializeParent(ctx: UnifiedToolContext): SerializableReactionParent {
  return {
    workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId,
    harnessSlug: ctx.harnessSlug,
    role: ctx.role,
    featureId: ctx.featureId ?? null,
    chunkId: ctx.chunkId ?? null,
    spawnId: ctx.spawnId,
    uiClientId: ctx.uiClientId ?? null,
  };
}

/**
 * The deterministic dedup id for a reaction:
 *   `reaction:<rootRunId>:<ruleId>[:<rule.dedupKey(event)>]`
 * Same trigger + rule (+ optional rule-supplied key) ⇒ same id ⇒ one fire. The
 * root falls back to the trigger's runId when the cause has none.
 */
export function computeDedupId(input: DurableReactionInput): string {
  return genericComputeDedupId({
    rule: input.rule,
    event: input.event,
    cause: input.cause,
    rootRunId: input.event.ctx.runId,
  });
}
