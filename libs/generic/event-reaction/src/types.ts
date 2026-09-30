/**
 * Reaction types — the generic ECA reaction rule + cause chain.
 *
 * The engine builds on `@papercusp/rules`' pure `Rule<E, Fire>`: a reaction rule
 * IS a rule (`{ id, on, when, fire, args }`) plus the reaction-EXECUTION metadata
 * the pure matcher never reads — durability mode, success-gating, provenance,
 * capability scope, and an idempotency key (rules-engine D-002: dispatch /
 * durability / loop-protection are the consumer's concern). Generic over the
 * event type `TEvent` and the fire descriptor `TFire` (defaults to a tool name).
 */

import type { Rule } from '@papercusp/rules';

/**
 * The cause-chain carried by a reaction so the loop guard can cap depth + detect
 * cycles, and telemetry can answer "why did this fire?". A host typically stamps
 * this onto the ctx of the call a reaction makes, so the NEXT event carries it.
 */
export interface ReactionCause {
  /** Depth in the cascade. The original (non-reaction) trigger = 0; its direct reactions = 1; … */
  depth: number;
  /** Rule ids fired so far in this chain (cycle detection). */
  chain: string[];
  /** The rule that fired THIS call. */
  ruleId: string;
  /** The id of the original trigger that rooted the chain (for dedup + correlation). */
  rootRunId?: string | null;
}

/** How a reaction is executed. */
export type ReactionMode =
  /** Enqueued as a durable workflow — survives restart, retried, deduped. The default. */
  | 'durable'
  /** Run in-process, fire-and-forget — no durability. For lightweight side effects. */
  | 'sync';

/**
 * A reaction rule — a `@papercusp/rules` `Rule` plus the reaction-execution
 * metadata. The pure matcher passes the whole rule through on `MatchedAction.rule`
 * and never reads these fields; the engine here does.
 */
export interface ReactionRule<TEvent, TFire = string> extends Rule<TEvent, TFire> {
  /** Execution mode. Default `'durable'` (routed to the durable seam when one is installed; else in-process). */
  mode?: ReactionMode;
  /** Skip the reaction when the trigger errored. Default `true`. */
  onlyOnSuccess?: boolean;
  /** Provenance for the reactive-graph view — e.g. `'events-file'`, `'emits:coord:handoff'`, `'plugin:foo'`. */
  source?: string;
  /**
   * Capability scope for a sandboxed (plugin/blueprint-contributed) rule. When
   * set, the host should restrict the reaction to what this capability permits.
   * Unset ⇒ a first-party (trusted) rule. Opaque to the engine — passed through
   * to the host's `fireInProcess` port.
   */
  capability?: string;
  /**
   * An idempotency-key suffix. With it, a reaction dedupes to ONE fire per
   * `(rootRunId, ruleId, dedupKey(event))` even under at-least-once retry. Unset
   * ⇒ keyed on the root run id + ruleId.
   */
  dedupKey?: (event: TEvent) => string;
}
