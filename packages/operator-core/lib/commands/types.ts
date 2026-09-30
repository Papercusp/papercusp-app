/**
 * Agent Action Registry — type definitions.
 *
 * See /docs/agents/action-registry §2.1 for the full design rationale.
 *
 * The registry is the single typed source of truth for "what each agent
 * surface can do" — used by the keyboard-shortcut bus, ⌘K command palette,
 * Oracle's MCP server, Pi's MCP server, the OpenAI Realtime fallback shim,
 * and the ElevenLabs Conv AI primary shim.
 */

import type { ZodSchema } from 'zod';

export type AgentId = 'oracle' | 'operator' | 'pi' | 'palette' | 'shortcut';

/** How a command relates to a live browser session. */
export type BrowserRequirement =
  | 'required'   // panel.toggle — useless without a browser tab to mutate
  | 'optional'   // chat.dispatch — server writes the row, browser updates if present
  | 'none';      // harness.start — pure server-side, no browser involvement

/** Concurrency policy when multiple callers fire the same command id. */
export type Concurrency =
  | 'allow'      // panel.toggle — safe in parallel (idempotent)
  | 'queue'      // harness.start — serialize; second call waits for first
  | 'deny';      // harness.delete — second concurrent call returns conflict

/** Tier classification used by voice prompt builder + UI grouping. */
export type Tier =
  | 'reflexive'   // commands: panel.*, navigate, voice.set-mode
  | 'short'       // commands: short server-side actions
  | 'fast-query'  // queries: harness.status, chat.list
  | 'delegation'; // retired delegate tier retained for historical rows

/** Audit policy for queries. Commands always audit. */
export type QueryAuditPolicy = 'none' | 'sample' | 'full';

export interface CommandContext {
  agent: AgentId;
  workspace: string;        // every handler gets this; never an arg (§3.2)
  sessionId?: string;       // browser session for browser='required' commands
  requestId: string;        // for audit correlation
  /**
   * Origin surface — set when the call came from somewhere other than
   * the desktop browser. Populated by /api/elevenlabs/webhook from
   * the conversation's `dynamic_variables.surface` (set on session-
   * init by the phone). Used by the audit pipeline to distinguish
   * "user said this on the phone" from "user did this in a tab".
   * Optional; absent for desktop-originated commands.
   */
  surface?: 'browser' | 'mobile-android' | 'mobile-ios' | 'mobile-unknown';
  /**
   * Stable identifier for the originating device. For mobile this is
   * the deviceId from the JWT (matches /devices.device_id); for
   * desktop it's the tabId. Useful for audit + per-device rate limits.
   */
  deviceId?: string;
}

export interface CommandDef<Args = unknown, Result = unknown> {
  id: string;                          // 'panel.toggle'
  kind: 'command';
  description: string;                 // ≤200 chars, shown to LLMs + ⌘K
  promptDescription?: string;          // longer agent-facing description
  schema: ZodSchema<Args>;             // arg validation (see §2.4)
  agents: AgentId[];                   // who's allowed to invoke
  browser: BrowserRequirement;
  concurrent?: Concurrency;            // default 'allow'
  tier: 'reflexive' | 'short' | 'delegation';
  audit?: QueryAuditPolicy;            // commands still audit; retained as command metadata
  paletteEntry?: { section: string; title: string; icon?: string; keywords?: string };
  handler: (args: Args, ctx: CommandContext) => Promise<Result> | Result;
}

export interface QueryDef<Args = unknown, Result = unknown> {
  id: string;
  kind: 'query';
  description: string;
  promptDescription?: string;
  schema: ZodSchema<Args>;
  agents: AgentId[];
  audit?: QueryAuditPolicy;            // default 'sample'
  tier: 'fast-query';
  handler: (args: Args, ctx: CommandContext) => Promise<Result> | Result;
}

export type Definition = CommandDef<any, unknown> | QueryDef<any, unknown>;

/** Result shape returned to all callers. Errors are values, never thrown. */
export type CommandResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: CommandErrorPayload };

export interface CommandErrorPayload {
  code: string;                        // 'no-active-session', 'denied', 'conflict', 'invalid-args', 'internal', 'unknown'
  message: string;                     // human-readable, safe to show
  hint?: string;                       // actionable, agent-facing
  retryable: boolean;
}

/**
 * Handlers throw this; registry wraps anything else as code:'internal'.
 * Use this when you want a structured error to flow to the LLM consumer
 * instead of a generic "tool error".
 */
export class CommandError extends Error {
  constructor(public readonly payload: CommandErrorPayload) {
    super(payload.message);
    this.name = 'CommandError';
  }
}
