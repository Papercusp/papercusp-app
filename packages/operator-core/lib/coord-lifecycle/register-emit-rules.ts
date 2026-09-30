/**
 * register-emit-rules.ts — wire the `emits` desugar to the LIVE event-reaction
 * engine (coord-lifecycle-automation-2026-06-04 D-002).
 *
 * This is the one place the generic, engine-free desugar (./emits-desugar) meets
 * the operator-core event-reaction registry (../events). Importing it at startup
 * iterates every tool's collected `emits` and registers each as a ReactionRule —
 * so `emits:` on a tool becomes a real rule in the SAME singleton registry the
 * dispatcher reads. Idempotent (registerReactionRule dedupes by rule id).
 *
 * MUST be imported AFTER all tools are registered (so getCollectedToolEmits() is
 * complete) and after `../events` (so the engine registry exists) — see the
 * import order in ../agent-tools/index.ts.
 */

import { registerReactionRule } from '../events';
import { registerEmitRules, type ReactionRule } from './emits-desugar';

/**
 * Desugar + register every tool's `emits`. Returns the number of rules
 * registered. Safe to call more than once.
 *
 * The single adapter cast lives here: the desugar's structural `ReactionRule`
 * (over `ToolEventLike`) is the engine's `ReactionRule` (over the richer
 * `ToolInvocationEvent`, which the engine passes at runtime and our renders read
 * structurally). Casting the register FN — not each rule — keeps the seam to one
 * line and the desugar fully engine-free + unit-testable.
 */
export function installEmitRules(): number {
  return registerEmitRules(
    registerReactionRule as unknown as (rule: ReactionRule) => void,
  );
}

// Self-install on import (the production path).
installEmitRules();
