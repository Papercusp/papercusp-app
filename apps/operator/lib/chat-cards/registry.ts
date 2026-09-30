/**
 * Chat-card registry — Phase 4 T2.1.
 *
 * Schema-shaped lookup that lets the chat consumers (OperatorChat,
 * OracleDock) render tool calls as React components without each
 * consumer hardcoding `if (t.name === 'chat:ask_choice') return <X/>`.
 *
 * Pattern:
 *   - A card module (e.g. AskChoiceCardEntry.tsx) calls `registerCard`
 *     at import time.
 *   - `apps/operator/lib/chat-cards/index.ts` side-effect-imports every
 *     registered card so consumers see them all by importing once.
 *   - Consumers call `renderCard(toolName, props)` and either get a
 *     ReactNode or null. `null` falls through to the default tool-chip
 *     renderer.
 *
 * The on-answer logic STAYS PER CONSUMER — OperatorChat does live-tail
 * answerChoice; OracleDock mutates local tab state. Each consumer
 * supplies its own `onAnswer` callback through the props.
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.1.
 */

import type { ReactNode } from 'react';

/**
 * Render-time props handed to a card renderer. `args` is the tool's
 * input payload (the model's tool-call args); `answered` is the
 * persisted user response (null when unanswered); `onAnswer` is the
 * consumer-supplied commit callback.
 *
 * Generic over `TArgs` so each card can narrow to its specific
 * input shape, but the registry itself stores `unknown` because
 * each card knows its own shape internally.
 */
export interface CardRenderProps<TArgs = unknown> {
  args: TArgs;
  answered?: unknown;
  /**
   * Called when the user commits a response (clicks a button, submits
   * a text field, etc). The payload shape is card-specific; the
   * consumer's `onAnswer` knows how to interpret it for the matching
   * tool.
   */
  onAnswer: (payload: unknown) => void;
}

export type CardRenderer<TArgs = unknown> = (
  props: CardRenderProps<TArgs>,
) => ReactNode | null;

const REGISTRY = new Map<string, CardRenderer<unknown>>();

/**
 * Register a card renderer for a tool name. Re-registering replaces
 * the prior renderer (lets HMR work in dev). Same tool name across
 * multiple `defineTool` calls would be a registry-level collision
 * upstream; we don't double-check here.
 */
export function registerCard<TArgs>(
  toolName: string,
  renderer: CardRenderer<TArgs>,
): void {
  REGISTRY.set(toolName, renderer as CardRenderer<unknown>);
}

/**
 * MCP client tool-call ids are mangled (`mcp__<server>__<verb>`, every `:` in
 * the canonical `group:verb` name replaced with `_` — same convention the su
 * playbook documents for ToolSearch). Every card is registered under its
 * CANONICAL colon-form name (`chat:ask_choice`), which is what the operator's
 * OWN conversation turns already carry (server-side `defineTool` dispatch
 * records the real name) — but a LIVE su/interactive session's transcript
 * (SessionChatModal / session-timeline-parsers, gui-chat-session-controls-2026-07-25
 * P-008) is fed straight from the model's raw `tool_use` blocks, so an
 * MCP-routed `chat:ask_choice` call shows up there as
 * `mcp__papercusp-su__chat_ask_choice` and a plain registry `Map.get` misses —
 * the card silently falls through to the default chip (or renders nothing)
 * even though a renderer for it exists.
 */
const MCP_TOOL_PREFIX_RE = /^mcp__[a-zA-Z0-9-]+__/;

/**
 * Reverse the MCP client mangling for a raw transcript tool name, matching it
 * against the registry's own (small) key set — so this stays correct as cards
 * are added/removed without a hardcoded tool list. Returns the canonical
 * colon-form name when a registered card's mangled form matches, else `null`
 * (not an MCP-shaped name, or no registered card matches it).
 */
function unmangleMcpToolName(rawName: string): string | null {
  if (!MCP_TOOL_PREFIX_RE.test(rawName)) return null;
  const suffix = rawName.replace(MCP_TOOL_PREFIX_RE, '');
  for (const colonName of REGISTRY.keys()) {
    if (colonName.replace(':', '_') === suffix) return colonName;
  }
  return null;
}

/**
 * Render the card for `toolName`, or `null` if nothing is registered
 * (or the renderer itself returned null — e.g. payload validation
 * failed inside the card). Falls back to the un-mangled MCP form (see
 * `unmangleMcpToolName`) when the raw name isn't a direct hit, so callers
 * fed from a live agent-session transcript don't need to normalize first.
 */
export function renderCard(
  toolName: string,
  props: CardRenderProps<unknown>,
): ReactNode | null {
  const renderer = REGISTRY.get(toolName) ?? REGISTRY.get(unmangleMcpToolName(toolName) ?? '');
  if (!renderer) return null;
  return renderer(props);
}

/**
 * Test-only — flush the registry. Used by unit tests that want a
 * clean slate per `it()`.
 */
export function _resetCardRegistryForTests(): void {
  REGISTRY.clear();
}
