/**
 * emits-desugar.ts — the `emits` defineTool field → event-reaction rule adapter
 * (coord-lifecycle-automation-2026-06-04 D-002).
 *
 * This is the WHOLE of "emits is sugar, never a parallel path": each intrinsic
 * `emits` entry a tool declares is converted, 1:1, into a `ReactionRule` that
 * the event-reaction engine (event-reaction-system-2026-06-04) runs through its
 * normal dispatch / durability / loop-protection. There is no second execution
 * path here — only a translation from the co-located authoring form to the
 * engine's rule shape.
 *
 * The engine's `registerReactionRule` is INJECTED (see `registerEmitRules`)
 * rather than imported, so this module compiles + unit-tests standalone while
 * the engine's registry lands. The operator-core bootstrap wires the real
 * `registerReactionRule` once it is live (a one-liner — see
 * ./register-emit-rules).
 */

import {
  getCollectedToolEmits,
  type ToolEmitSpec,
  type ToolEventLike,
} from '@papercusp/tooldef';

/**
 * A local, structural MIRROR of the event-reaction engine's `ReactionRule`
 * contract (event-reaction-system-2026-06-04, su-2a7b4's published interface).
 * Kept here so the desugar doesn't take a type dependency on the engine package
 * at check time; the engine's real `registerReactionRule` accepts this shape
 * (`ToolEventLike` is structurally assignable to the engine's
 * `ToolInvocationEvent`).
 */
export interface ReactionRule {
  /** Unique; re-registering by the same id replaces the prior rule. */
  id: string;
  /** Trigger MCP tool name(s). */
  on: string | string[];
  /** Condition over the event; a JS predicate or a serializable data-condition. Omitted ⇒ always. */
  when?: ((e: ToolEventLike) => boolean) | Record<string, unknown>;
  /** Reaction MCP tool name. */
  fire: string;
  /** Reaction args — static, or derived from the event. */
  args: Record<string, unknown> | ((e: ToolEventLike) => Record<string, unknown>);
  /** 'durable' (DBOS-queued, default) | 'sync' (in-process await). */
  mode?: 'durable' | 'sync';
  /** Default true — skip when the trigger errored. */
  onlyOnSuccess?: boolean;
  /** Provenance, surfaced in the reactive-graph view. */
  source?: string;
  /** Plugin/blueprint capability scoping (D-012). */
  capability?: string;
  /** Idempotency suffix. */
  dedupKey?: (e: ToolEventLike) => string;
}

/** The stable rule id for one tool's Nth emits entry. */
export function emitRuleId(toolName: string, spec: ToolEmitSpec, index: number): string {
  return `emits:${toolName}#${spec.id ?? index}`;
}

/**
 * Convert ONE `emits` entry into a `ReactionRule` (the D-002 desugar). A pure,
 * total mapping: `on` = the declaring tool, `when`/`args` carried verbatim
 * (the engine invokes `args` as the arg-template; `render` IS that template).
 */
export function emitsEntryToRule(
  toolName: string,
  spec: ToolEmitSpec,
  index: number,
): ReactionRule {
  return {
    id: emitRuleId(toolName, spec, index),
    on: toolName,
    ...(spec.when ? { when: spec.when } : {}),
    fire: spec.fire,
    args: spec.render,
    mode: spec.mode ?? 'durable',
    onlyOnSuccess: spec.onlyOnSuccess ?? true,
    source: `emits:${toolName}`,
  };
}

/**
 * Desugar EVERY collected tool's `emits` into rules (pure — returns them, fires
 * nothing). The collector is populated by `defineTool` at module-load, so call
 * this only after the tool catalog has been imported.
 */
export function collectEmitRules(): ReactionRule[] {
  const rules: ReactionRule[] = [];
  for (const { toolName, emits } of getCollectedToolEmits()) {
    emits.forEach((spec, i) => rules.push(emitsEntryToRule(toolName, spec, i)));
  }
  return rules;
}

/**
 * Register every emits-derived rule via the provided `register` fn. The
 * operator-core bootstrap injects the engine's real `registerReactionRule`
 * here once it is live — keeping this module free of an import on an
 * as-yet-unlanded engine package. Returns the number of rules registered.
 */
export function registerEmitRules(register: (rule: ReactionRule) => void): number {
  const rules = collectEmitRules();
  for (const rule of rules) register(rule);
  return rules.length;
}
