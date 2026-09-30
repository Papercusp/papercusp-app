/**
 * Loop / cascade protection (mandatory in any ECA reaction system).
 *
 * A reaction fires an action, which is itself an event, which can fire more
 * reactions — so cycles (A→B→A) and runaway cascades are possible. Every
 * reaction carries a cause-chain (`ReactionCause`): a depth counter + the ordered
 * list of rule ids already fired in this chain. Before firing, we:
 *   - cap depth at MAX_REACTION_DEPTH → drop on breach;
 *   - reject if this rule already appears in the chain (cycle) → drop.
 *
 * Pure + synchronous; the caller logs the drop reason.
 */

import type { ReactionCause } from './types';

/** The hard depth cap on a reaction cascade. */
export const MAX_REACTION_DEPTH = 8;

export type GuardDecision =
  | { allow: true; nextCause: ReactionCause }
  | { allow: false; reason: 'depth_exceeded' | 'cycle' };

/**
 * Decide whether a rule may fire given the triggering event's cause-chain, and
 * compute the cause-chain to stamp on the reaction it would fire.
 *
 * @param cause      the TRIGGER's cause (undefined when the trigger was an
 *                   ordinary call — i.e. the chain starts here).
 * @param ruleId     the rule about to fire.
 * @param rootRunId  the trigger's run id, used to root the chain when it starts here.
 */
export function guardReaction(opts: {
  cause: ReactionCause | undefined;
  ruleId: string;
  rootRunId: string | null;
}): GuardDecision {
  const depth = (opts.cause?.depth ?? 0) + 1;
  const chain = opts.cause?.chain ?? [];
  if (depth > MAX_REACTION_DEPTH) return { allow: false, reason: 'depth_exceeded' };
  if (chain.includes(opts.ruleId)) return { allow: false, reason: 'cycle' };
  return {
    allow: true,
    nextCause: {
      depth,
      chain: [...chain, opts.ruleId],
      ruleId: opts.ruleId,
      rootRunId: opts.cause?.rootRunId ?? opts.rootRunId,
    },
  };
}
