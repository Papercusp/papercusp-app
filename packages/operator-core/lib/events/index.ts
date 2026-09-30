/**
 * The event-reaction system (event-reaction-system-2026-06-04).
 *
 * A declarative "when tool X settles, when <condition>, fire tool Y with
 * <derived args>" layer over the one `defineTool` dispatcher. The generic engine
 * lives in `@papercusp/event-reaction` (generalize-libs-to-generic-2026-06-05
 * D-003 #1); this module is the Papercusp adapter — it binds the engine to the
 * operator's tool events, dispatcher, durable runner, and PG dedup ledger.
 * Importing this module:
 *   1. registers the built-in Events-file rules (`./rules`);
 *   2. wires the dispatcher's post-invocation hook (`PROJECTED_DEPS.postInvoke`)
 *      to the reaction engine.
 *
 * Imported once at startup from the agent-tools bootstrap. Idempotent.
 */

import {
  installControlAnchorKernelResolver,
  setReactionPostInvoke,
  setPreconditionFire,
} from '../projected-tool-deps';
import { handleToolInvoked } from './engine';
import { fireReactionInProcess } from './dispatch-reaction';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import './rules';

// Wire the single observation point. The dispatcher now calls handleToolInvoked
// after every tool settles (best-effort, non-blocking).
setReactionPostInvoke(handleToolInvoked);

// identities-v1 / D-030: install the live control-anchor resolver at the same
// bootstrap seam that installs reactions. The generic dispatcher remains
// host-neutral; this operator adapter reads the existing session activation
// projection and applies explicit revocation/stale/ownership decisions at
// both shared dispatch seats.
installControlAnchorKernelResolver();

// Wire the precondition fire port (`requires:` auto-correct — autoloop-pot-
// operator-rebuild D-006). The corrective fire rides the SAME dispatch path as
// reactions: auth-gated, audited, cause-chained (so a correction that itself
// triggers reactions is loop-guarded). Unlike postInvoke this is AWAITED by the
// dispatcher's `preconditions` step — the trigger blocks on its own correction —
// and a failure throws so the trigger rejects fail-closed.
setPreconditionFire(async (req) => {
  const ruleId = `requires:${req.trigger}#${req.requireId}`;
  const result = await fireReactionInProcess({
    fire: req.fire,
    args: req.args,
    // The trigger's ctx IS a UnifiedToolContext at runtime; the request carries
    // it as tooldef's open structural shape to stay domain-free.
    parentCtx: req.ctx as unknown as UnifiedToolContext,
    cause: {
      depth: 1,
      chain: [ruleId],
      ruleId,
      rootRunId: typeof req.ctx.runId === 'string' ? req.ctx.runId : null,
    },
  });
  if (!result.ok) {
    throw new Error(result.error ?? `precondition fire "${req.fire}" failed`);
  }
});

export {
  registerReactionRule,
  unregisterReactionRule,
  listReactionRules,
  reactionRulesFor,
  matchReactions,
  reactionGraph,
  _resetReactionsForTests,
} from './registry';
export { handleToolInvoked, normalizeEvent } from './engine';
// The loop guard is the generic engine's (algorithm) — re-exported for back-compat.
export { guardReaction, MAX_REACTION_DEPTH } from '@papercusp/event-reaction';
export { formatHandoff, type HandoffArgs } from './format-handoff';
export { fireReactionInProcess, buildReactionCtx } from './dispatch-reaction';
export {
  isBuiltinReactionAction,
  fireBuiltinReactionAction,
  BUILTIN_ACTIONS,
  CACHE_BUMP_TAGS_ACTION,
} from './builtin-actions';
export {
  registerCacheTagEcaRule,
  cacheTagEcaEnabled,
  tableNameFromChangedEvent,
  tagsForTableChange,
  CACHE_TAG_ECA_RULE_ID,
} from './cache-eca-rule';
export { TABLE_CHANGED_KEY } from './registry';
export {
  durableReactionsEnabled,
  runDurableReaction,
  setDurableReactionRunner,
  type DurableReactionInput,
} from './durable';
export { executeDurableReaction, type DurableReactionPayload } from './durable-exec';
export { serializeParent, computeDedupId, type SerializableReactionParent } from './reaction-id';
export { claimReaction, releaseReaction, markReactionFailed, type ReactionClaim } from './reaction-dedup';
export type { ToolInvocationEvent, ReactionRule, ReactionCause, ReactionMode } from './types';
