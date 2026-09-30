/**
 * Reaction idempotency: the deterministic dedup id + the store port.
 *
 * Under at-least-once delivery (a durable queue, a retried step) the same
 * reaction can be handed to the executor more than once. The dedup id is
 * deterministic in `(rootRunId, ruleId, [rule.dedupKey(event)])`, so a
 * re-delivery computes the SAME id and the store's atomic `claim` makes the
 * second one a no-op. The store itself (a table, a KV) is injected — this lib
 * only defines the contract.
 */

import type { ReactionRule, ReactionCause } from './types';

/** Inputs for computing a reaction's deterministic dedup id. */
export interface DedupIdInput<TEvent, TFire = string> {
  rule: ReactionRule<TEvent, TFire>;
  event: TEvent;
  cause: ReactionCause;
  /** Fallback root run id when `cause.rootRunId` is unset (e.g. the trigger's own run id). */
  rootRunId?: string | null;
}

/**
 * The deterministic dedup id for a reaction:
 *   `reaction:<rootRunId>:<ruleId>[:<rule.dedupKey(event)>]`
 * Same root + rule (+ optional rule-supplied key) ⇒ same id ⇒ one fire.
 */
export function computeDedupId<TEvent, TFire>(input: DedupIdInput<TEvent, TFire>): string {
  const root = input.cause.rootRunId ?? input.rootRunId ?? 'noroot';
  const extra = input.rule.dedupKey ? `:${input.rule.dedupKey(input.event)}` : '';
  return `reaction:${root}:${input.rule.id}${extra}`;
}

/** A claim row the durable executor records before dispatching. */
export interface ReactionClaim {
  dedupId: string;
  workspaceId: string;
  ruleId: string;
  fire: string;
  triggerTool?: string;
  causeRootRunId?: string | null;
  depth: number;
  /**
   * WHO contributed the rule that is firing — `rule.source`, made durable.
   * `ruleId` identifies the rule but not its contributor: an id is an opaque
   * string its contributor chose, so grouping fires by contributor via an id
   * prefix is a convention, not a key. A store that records this can answer
   * "what has contributor X fired" (uninstall completeness) and budget per
   * contributor. Undefined/null ⇒ a first-party rule with no recorded source.
   */
  contributor?: string | null;
}

/**
 * The idempotency ledger port. The durable executor CLAIMS a dedup id before
 * dispatching; a re-delivery finds the claim and skips. On dispatch failure the
 * claim is released so a retry can re-fire. The host provides the impl (PG, KV…).
 */
export interface ReactionStore {
  /**
   * Atomically claim a dedup id. Returns true if THIS call won the claim (proceed
   * to dispatch), false if it was already claimed (a re-delivery — skip).
   */
  claim(claim: ReactionClaim): Promise<boolean>;
  /** Release a claim so a retry can re-fire after a dispatch failure. */
  release(dedupId: string): Promise<void>;
  /** Mark a claimed reaction failed (kept for inspection — only when NOT retrying). */
  markFailed(dedupId: string, error: string): Promise<void>;
}
