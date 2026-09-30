/**
 * The Papercusp binding of the generic `@papercusp/event-reaction` engine.
 *
 * The engine is generic over the event type; here we bind it to the operator's
 * post-invocation tool event. `ToolInvocationEvent` flattens the dispatcher's
 * result for the data-matcher and carries the trigger's `UnifiedToolContext` —
 * the one Papercusp-specific field (reactions inherit workspace / harness /
 * identity from it). `ReactionRule` is the generic rule specialized to this
 * event; the reaction-execution metadata (mode / onlyOnSuccess / source /
 * capability / dedupKey) lives on the generic type in `@papercusp/event-reaction`.
 */

import type { ReactionRule as GenericReactionRule, ReactionCause, ReactionMode } from '@papercusp/event-reaction';

export type { ReactionCause, ReactionMode };

/**
 * The normalized event a rule matches against — the post-invocation event with
 * the dispatcher result flattened so `result.ok` / `result.data` match.
 */
export interface ToolInvocationEvent {
  /** The trigger tool's MCP name (e.g. `coord:handoff`). The rule index key. */
  tool: string;
  /** The validated (post-zod) args the trigger ran with. */
  args: unknown;
  /** The trigger's settled result, flattened so `result.ok` / `result.data` match. */
  result: {
    ok: boolean;
    /** The tool's return value — JSON-parsed from `content[0].text` when possible. */
    data?: unknown;
    /** The error, on failure. */
    error?: { code: string; message: string };
  };
  /**
   * The trigger's dispatch ctx. The reaction inherits workspace / harness /
   * identity from it. Rules read `e.ctx.uiClientId`, `e.ctx.harnessSlug`, etc.
   */
  ctx: import('@papercusp/agent-mcp').UnifiedToolContext;
  /** The cause-chain, present iff the trigger was ITSELF a reaction (loop guard). */
  cause?: ReactionCause;
}

/**
 * A reaction rule specialized to tool-events: the generic
 * `@papercusp/event-reaction` `ReactionRule` over `ToolInvocationEvent` with a
 * tool-name fire descriptor. Carries the full reaction-execution metadata
 * (`mode`, `onlyOnSuccess`, `source`, `capability`, `dedupKey`).
 */
export type ReactionRule = GenericReactionRule<ToolInvocationEvent, string>;
