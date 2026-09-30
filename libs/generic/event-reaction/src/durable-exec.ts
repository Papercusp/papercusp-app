/**
 * `executeDurableReaction` — the body a durable reaction step runs.
 *
 * Serializable-friendly: it takes the JSON-shaped payload a durable runner
 * enqueued (the live event isn't serializable, so the host extracts a
 * serializable `parent` scope + a precomputed dedup id). It:
 *   1. claims the dedup id (idempotency) — already claimed ⇒ a re-delivery ⇒ no-op;
 *   2. dispatches via the injected `fire` port (the host rebuilds its call scope
 *      from `payload.parent`);
 *   3. on dispatch failure, releases the claim and rethrows, so the durable
 *      runner retries and the released claim lets the retry re-fire.
 *
 * Generic over the serializable parent shape; the only requirement is a
 * `workspaceId` to scope the claim.
 */

import type { ReactionCause } from './types';
import type { ReactionStore } from './dedup';

/** The JSON-serializable workflow payload for one durable reaction. */
export interface DurableReactionPayload<TParent extends { workspaceId?: string } = { workspaceId?: string }> {
  fire: string;
  args: Record<string, unknown>;
  /** The serializable scope the host rebuilds its call ctx from. */
  parent: TParent;
  cause: ReactionCause;
  ruleId: string;
  triggerTool: string;
  dedupId: string;
  /** Capability scope for a sandboxed rule. Unset ⇒ first-party trusted. */
  capability?: string;
  /** Who contributed the rule (`rule.source`) — the claim's attribution key. */
  contributor?: string | null;
}

export interface ExecuteDurableReactionDeps<TParent extends { workspaceId?: string }> {
  /** The idempotency ledger. */
  store: ReactionStore;
  /** Dispatch the reaction (host rebuilds its scope from `payload.parent`). */
  fire: (payload: DurableReactionPayload<TParent>) => Promise<{ ok: boolean; error?: string }>;
  /** Optional logger for the no-workspace skip. */
  log?: (msg: string) => void;
}

export async function executeDurableReaction<TParent extends { workspaceId?: string }>(
  payload: DurableReactionPayload<TParent>,
  deps: ExecuteDurableReactionDeps<TParent>,
): Promise<void> {
  const workspaceId = payload.parent.workspaceId;
  if (!workspaceId) {
    deps.log?.(`durable reaction ${payload.ruleId} has no workspace; skipping`);
    return;
  }

  // Idempotency claim. Already claimed ⇒ a re-delivery ⇒ no-op.
  const fresh = await deps.store.claim({
    dedupId: payload.dedupId,
    workspaceId,
    ruleId: payload.ruleId,
    fire: payload.fire,
    triggerTool: payload.triggerTool,
    causeRootRunId: payload.cause.rootRunId ?? null,
    depth: payload.cause.depth,
    contributor: payload.contributor ?? null,
  });
  if (!fresh) return;

  const r = await deps.fire(payload);
  if (!r.ok) {
    // Release the claim so a retry re-fires; rethrow so the durable runner records
    // the step failure and retries per its policy.
    await deps.store.release(payload.dedupId).catch(() => {});
    throw new Error(`reaction ${payload.ruleId} → ${payload.fire} failed: ${r.error}`);
  }
}
