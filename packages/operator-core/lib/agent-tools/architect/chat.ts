/**
 * architect:chat and brainstorm:chat — single-turn harness chat tools.
 *
 * Both stream a prompt through runAgentChat (backend-aware: `omp -p`
 * by default, `claude -p` when AGENT_BACKEND=claude-code). Phase 3
 * pilots of the typed-event channel migration.
 *
 * Self-contained as of the IPC-allowlist migration (2026-05-12): the
 * tool resolves the project + composes the role-specific prompt
 * (features list, issues, brainstorm scratchpad, etc.) inside the
 * handler. The Hono routes at /:slug/architect/chat and
 * /:slug/brainstorm/chat are thin shims that forward the raw chat
 * args + slug. This unblocks the IPC fast-path: the webview can call
 * either tool directly via the endpoint-ipc transport without first
 * hitting an HTTP endpoint to build the prompt.
 *
 * Wire format:
 *   event: delta    data: <raw text>            ← z.string() → raw on wire
 *   event: tool_call data: { name, input }      ← object → JSON
 *   event: cost     data: { usd, input, output } ← object → JSON
 *   event: error    data: <raw text>            ← z.string() → raw on wire
 *   event: done     data: <ToolResult.content as JSON>  ← framework auto-emit
 *
 * The submodule consumer at libs/agent-chat's useHarnessChatRuntime.ts
 * only handles `delta` (accum += data) and `error` (accum += data) —
 * it ignores `done` and `cost` and closes on stream-end. Raw-text wire
 * for delta + error preserves bit-exact compat with the pre-migration
 * sink.eventRaw shape.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '../../agent-chat-stream';
import { surfaceBackend, surfaceModel, type SurfaceKey } from '../../agent-config';
import {
  composeArchitectPrompt,
  composeBrainstormPrompt,
  resolveSlug,
  type ChatHistoryEntry,
} from './prompts';

const HistorySchema = z.array(
  z.object({
    role: z.union([z.literal('user'), z.literal('assistant')]),
    content: z.string(),
  }),
);

const ArchitectArgsSchema = z.object({
  harnessSlug: z.string(),
  phase: z.string().optional(),
  history: HistorySchema.default([]),
  message: z.string().min(1),
  reviewId: z.string().optional(),
});

const BrainstormArgsSchema = z.object({
  harnessSlug: z.string(),
  phase: z.string().optional(),
  history: HistorySchema.default([]),
  message: z.string().min(1),
});

type ArchitectArgs = z.infer<typeof ArchitectArgsSchema>;
type BrainstormArgs = z.infer<typeof BrainstormArgsSchema>;

const EVENTS = {
  // z.string() → raw text on the SSE wire (matches pre-migration
  // sink.eventRaw('delta', text); the submodule consumer does
  // accum += ev.data and expects no JSON wrapping).
  delta: z.string(),
  tool_call: z.object({ name: z.string(), input: z.unknown() }),
  cost: z.object({
    usd: z.number(),
    input: z.number().optional(),
    output: z.number().optional(),
  }),
  // Same wire-compat reason as delta: consumer does accum += ev.data
  // for error events.
  error: z.string(),
} as const;

type ChatCtx = {
  emit: (n: string, d: unknown) => void;
  signal?: AbortSignal;
};

async function streamPrompt(
  promptText: string,
  cwd: string,
  ctx: ChatCtx,
  label: string,
  surface: SurfaceKey,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let finalText = '';
  // per-surface backend override (/settings/agent); undefined → global
  const backend = await surfaceBackend(surface);
  const model = await surfaceModel(surface); // OQ3: undefined → backend default
  try {
    for await (const ev of runAgentChat({
      promptText,
      cwd,
      ...(model ? { model } : {}),
      backend,
      // gateway-priority-tiers (WI-4542): a human is synchronously waiting on this stream in the
      // operator UI's architect/brainstorm chat pane — tag it 'interactive' so it rides the
      // protected tier-1 admission lane instead of silently falling to the untagged default band
      // (tier 5) alongside batch/background traffic. No-op when the tier flag / gateway are off.
      priority: 'interactive',
      // Caller-side cancellation: dispatcher's wrapped signal fires on
      // client disconnect / wall-clock timeout / idle timeout. Forward
      // so runAgentChat shuts the subprocess down instead of letting
      // it burn tokens we'll never read.
      signal: ctx.signal,
    })) {
      if (ev.type === 'delta') {
        ctx.emit('delta', ev.text);
        finalText += ev.text;
      } else if (ev.type === 'tool_call') {
        ctx.emit('tool_call', { name: ev.name, input: ev.input });
      } else if (ev.type === 'result') {
        ctx.emit('cost', {
          usd: ev.costUsd,
          input: ev.tokensIn,
          output: ev.tokensOut,
        });
      } else if (ev.type === 'error') {
        // Non-fatal mid-stream error (runAgentChat may yield error
        // events that don't end the stream — e.g. tool-call errors
        // that the model retries).
        ctx.emit(
          'error',
          `${ev.message}${ev.stderr ? `: ${ev.stderr.slice(0, 500)}` : ''}`,
        );
      }
    }
  } catch (err) {
    throw new Error(
      `${label} chat failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { content: [{ type: 'text', text: finalText }] };
}

async function architectHandler(
  input: ArchitectArgs,
  ctx: ChatCtx,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const project = await resolveSlug(input.harnessSlug, input.phase);
  if (!project) {
    throw new Error(`unknown harness: ${input.harnessSlug}`);
  }
  const promptText = await composeArchitectPrompt(
    project,
    input.history as ChatHistoryEntry[],
    input.message,
    input.reviewId,
  );
  return streamPrompt(promptText, project.path, ctx, 'architect', 'architect');
}

async function brainstormHandler(
  input: BrainstormArgs,
  ctx: ChatCtx,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const project = await resolveSlug(input.harnessSlug, input.phase);
  if (!project) {
    throw new Error(`unknown harness: ${input.harnessSlug}`);
  }
  const promptText = await composeBrainstormPrompt(
    project,
    input.history as ChatHistoryEntry[],
    input.message,
  );
  return streamPrompt(promptText, project.path, ctx, 'brainstorm', 'brainstorm');
}

export const architectChat = defineTool({
  name: 'architect:chat',
  expose: { ipc: true },
  profile: 'engineer',
  description:
    'Architect-mode chat turn: clarify spec, propose patches. Streams deltas; returns the assembled final text.',
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: ['operator'],
  timeoutSec: 600,
  // WI-2142938: checked, NOT vulnerable to the idle-vs-chat:ask_choice
  // mismatch fixed on operator:converse/papercup:converse/oracle:chat.
  // streamPrompt() above calls runAgentChat with no `mcpConfig` and no
  // `allowedTools` — per RunAgentChatOptions' own doc comments, that means
  // the spawned subprocess gets NO MCP tools at all (mcpConfig undefined ⇒
  // "spawn without MCP"; allowedTools is "required when mcpConfig is set").
  // With no MCP surface, the model can't reach chat:ask_choice (or any
  // other MCP tool) from architect:chat/brainstorm:chat, so this handler's
  // exec can never block on ctx.askUser the way converse/oracle's did.
  // 120s idle / 600s absolute stays correct as-is.
  idleTimeoutSec: 120,
  // Phase 4 T2.2 — opt into replay buffer. 5000 events is a
  // generous soft cap; eviction warn-logs let us tune down once
  // migration 066's event_count column has p99 data.
  replayBufferSize: 5000,
  args: ArchitectArgsSchema,
  events: EVENTS,
  handler: architectHandler,
});

export const brainstormChat = defineTool({
  name: 'brainstorm:chat',
  expose: { ipc: true },
  profile: 'engineer',
  description:
    'Brainstorm partner chat turn: expand ideas, suggest analogues, challenge assumptions. Streams deltas; returns the assembled final text.',
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: ['operator'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  // Phase 4 T2.2 — opt into replay buffer. 5000 events is a
  // generous soft cap; eviction warn-logs let us tune down once
  // migration 066's event_count column has p99 data.
  replayBufferSize: 5000,
  args: BrainstormArgsSchema,
  events: EVENTS,
  handler: brainstormHandler,
});

export default architectChat;
