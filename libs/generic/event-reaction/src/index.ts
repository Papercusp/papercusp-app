/**
 * @papercusp/event-reaction — a generic, durable ECA reaction engine.
 *
 * Layers over `@papercusp/rules` (the pure matcher: WHAT should fire) the parts a
 * real reaction system needs: reaction metadata, an inspectable registry, loop
 * protection, scheduling (durable vs in-process), idempotency, and a durable
 * executor. Host-agnostic — the dispatcher, the durable runner, and the dedup
 * store are injected as ports. The lib imports nothing but `@papercusp/rules`.
 *
 * Provenance: extracted from the Papercusp operator's `lib/events` system
 * (event-reaction-system-2026-06-04) per generalize-libs-to-generic-2026-06-05.
 */

export type { ReactionRule, ReactionCause, ReactionMode } from './types';

export { ReactionRegistry } from './registry';

export { guardReaction, MAX_REACTION_DEPTH, type GuardDecision } from './loop-guard';

export {
  runReactions,
  scheduleReaction,
  reactionContributor,
  type FireInProcess,
  type FireResult,
  type DurableSeam,
  type DurableReactionInput,
  type ReactionFailure,
  type ReactionFailureStage,
  type OnReactionFailure,
  type FireBudget,
  type FireBudgetRequest,
  type FireBudgetDecision,
} from './engine';

export {
  computeDedupId,
  type DedupIdInput,
  type ReactionClaim,
  type ReactionStore,
} from './dedup';

export {
  executeDurableReaction,
  type DurableReactionPayload,
  type ExecuteDurableReactionDeps,
} from './durable-exec';
