/**
 * agent_chats:chat — single-turn streaming chat for a role-scoped agent
 * inside a harness (Phase B "Pair" primitive).
 *
 * Thin slice: the tool receives a pre-assembled promptText + cwd and
 * streams the LLM response back as delta/tool_call/error events. The Hono
 * shim at `_hono/agent-chats.ts` handles the substantial PG-scoped pre/post
 * work — cost-cap reads, feature-lock checks, transcript append, final-turn
 * persistence with token/cost rollup. Splitting it this way keeps the
 * tool transport-agnostic (no harness PG access required) while still
 * collapsing the LLM-stream emission onto the function-as-truth model.
 *
 * Sibling `apps/operator/lib/agent-tools/agent_chats/send_message.ts`
 * is unrelated: that's the fire-and-forget non-streaming message
 * append used by autonomous dispatches; this is the user-driven
 * interactive stream the chat surface drives.
 *
 * Wire format (verified against apps/operator/app/harness/ChatPanel.tsx:216):
 *   event: delta      data: { text: string }    ← JSON; consumer does JSON.parse(data).text
 *   event: tool_call  data: { name: string, input: unknown }  ← attached MCP surface only (mcp-config.ts)
 *   event: error      data: { message: string, stderr?: string }
 *   event: done       data: <ToolResult.content as JSON>  ← framework auto-emit
 *
 * The ToolResult.content carries the rollup the route needs to persist:
 *   [{ type: 'text', text: JSON.stringify({ finalText, tokensIn, tokensOut, costUsd,
 *      ...(unreportedFrames > 0 ? { unreportedFrames } : {}) }) }]
 *
 * work-item-chat-context-modernize P-004: a scoped, read-mostly MCP tool
 * surface (`work_items:get/list`, `plans:get`, `docs:search`,
 * `memory:search` — mcp-config.ts) is attached ON TOP of the agent's
 * existing native tools when `harness` is passed and a superuser token is
 * provisioned, so the agent answers item questions by tool instead of
 * psql/grep. Best-effort: an unprovisioned build (no token) silently keeps
 * the pre-P-004 no-MCP behavior — never fails the chat turn.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '../../agent-chat-stream';
import { surfaceBackend, surfaceModel } from '../../agent-config';
import {
  PUBLIC_PORTAL_AGENT_BASELINE,
  SURFACE_KEYS,
  type AgentBackend,
  type SurfaceKey,
} from '../../agent-config-constants';
import { AGENT_CHATS_ALLOWED_TOOLS, agentChatsToolEventFilter, buildAgentChatsMcpConfig } from './mcp-config';

const ArgsSchema = z.object({
  promptText: z.string().min(1),
  cwd: z.string().optional(),
  /**
   * Which existing agent-config surface owns this turn's model/backend pair.
   * Omitted keeps every pre-portal caller on the shared `agent_chats` key.
   * The public portal server supplies `portal`; the browser never does.
   */
  surface: z.enum(SURFACE_KEYS).optional(),
  /**
   * The harness this chat belongs to (P-004). When set AND the loopback
   * superuser token is provisioned, scopes + attaches the read-mostly
   * `agentmcp` MCP surface (mcp-config.ts) so `work_items:*`/`plans:get`/
   * `docs:search`/`memory:search` calls default to THIS harness with no
   * explicit `harness` arg needed. Optional — omitting it (or an
   * unprovisioned build) runs the turn with no attached MCP tools, exactly
   * pre-P-004 behavior.
   */
  harness: z.string().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const EVENTS = {
  // JSON wire (consumer at ChatPanel.tsx:216 does JSON.parse(data).text).
  delta: z.object({ text: z.string() }),
  // Only fires for the attached agentmcp surface (mcp-config.ts) — native
  // builtin tool calls (Bash/Read/Edit/…) are NOT surfaced here.
  tool_call: z.object({ name: z.string(), input: z.unknown() }),
  error: z.object({ message: z.string(), stderr: z.string().optional() }),
} as const;

interface ChatCtx {
  emit: (n: string, d: unknown) => void;
  signal?: AbortSignal;
}

async function agentChatsHandler(input: Args, ctx: ChatCtx) {
  let assistantText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let unreportedFrames = 0;
  let lastErrorMessage: string | null = null;
  let lastErrorStderr: string | undefined;

  const surface: SurfaceKey = input.surface ?? 'agent_chats';
  const [configuredBackend, configuredModel] = await Promise.all([
    surfaceBackend(surface),
    surfaceModel(surface),
  ]);

  let agentChatsBackend: AgentBackend | undefined = configuredBackend;
  let agentChatsModel: string | undefined = configuredModel;
  if (surface === 'portal') {
    // D-004: a portal model and backend are one compatibility unit. A single
    // configured half is more dangerous than no override (for example a Luna
    // model with the inherited Claude CLI), so refuse it before spawning.
    if (Boolean(configuredBackend) !== Boolean(configuredModel)) {
      throw new Error(
        'portal agent config is incomplete: surfaceModels.portal and backends.portal must be set together',
      );
    }
    // A fresh hosted instance still gets a deterministic public model. The
    // deployment writes this same pair explicitly; this committed fallback is
    // the recurrence guard against a missing/stale settings row.
    agentChatsBackend = configuredBackend ?? PUBLIC_PORTAL_AGENT_BASELINE.backend;
    agentChatsModel = configuredModel ?? PUBLIC_PORTAL_AGENT_BASELINE.model;
  }

  // P-004: attach the read-mostly agentmcp surface when a harness is known
  // and the loopback superuser token is provisioned. `null` (unprovisioned
  // build, or no harness) → run exactly as before P-004 — no mcpConfig, no
  // allowedTools, no permissionMode change.
  const mcpConfig = buildAgentChatsMcpConfig({ harness: input.harness ?? null });

  try {
    for await (const ev of runAgentChat({
      promptText: input.promptText,
      cwd: input.cwd,
      ...(agentChatsModel ? { model: agentChatsModel } : {}),
      backend: agentChatsBackend,
      // gateway-priority-tiers (WI-4542): the ChatPanel stream is user-driven and synchronous — a
      // human is watching it render — so tag it 'interactive' rather than let it fall to the
      // untagged default band alongside batch/background traffic.
      priority: 'interactive',
      signal: ctx.signal,
      ...(mcpConfig
        ? {
            mcpConfig,
            allowedTools: [...AGENT_CHATS_ALLOWED_TOOLS],
            toolEventFilter: agentChatsToolEventFilter,
            // Required alongside mcpConfig: claude-code refuses tool calls
            // in -p mode without an explicit permission mode. Native
            // builtin-tool approval (Bash/Read/Edit/…) is unaffected — it
            // already runs against the inherited (non-isolated) host
            // Claude Code config, as before P-004.
            permissionMode: 'bypassPermissions' as const,
          }
        : {}),
    })) {
      if (ev.type === 'delta') {
        assistantText += ev.text;
        ctx.emit('delta', { text: ev.text });
      } else if (ev.type === 'tool_call') {
        // Only the attached agentmcp surface reaches here (see
        // toolEventFilter above) — a native builtin call never fires this.
        ctx.emit('tool_call', { name: ev.name, input: ev.input });
      } else if (ev.type === 'result') {
        tokensIn = ev.tokensIn;
        tokensOut = ev.tokensOut;
        costUsd = ev.costUsd;
        if (typeof ev.unreportedFrames === 'number' && Number.isSafeInteger(ev.unreportedFrames) && ev.unreportedFrames > 0) {
          unreportedFrames += ev.unreportedFrames;
        }
        if (ev.finalText && ev.finalText.length > assistantText.length) {
          assistantText = ev.finalText;
        }
      } else if (ev.type === 'error') {
        // Mirror legacy behavior: accumulate the last error and re-emit
        // after the stream ends. agent-chats consumers treat error as
        // terminal even though runAgentChat may continue.
        lastErrorMessage = ev.message;
        lastErrorStderr = ev.stderr;
      }
    }
  } catch (err) {
    throw new Error(
      `agent_chats chat failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (lastErrorMessage) {
    ctx.emit('error', { message: lastErrorMessage, stderr: lastErrorStderr });
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          finalText: assistantText,
          tokensIn,
          tokensOut,
          costUsd,
          ...(unreportedFrames > 0 ? { unreportedFrames } : {}),
        }),
      },
    ],
  };
}

export const agentChatsChat = defineTool({
  name: 'agent_chats:chat',
  // No `expose.ipc` (was the footgun): route-dependent. The Hono shim at
  // _hono/agent-chats.ts does the cost-cap / feature-lock / transcript-persist
  // / prompt-assembly work and passes a pre-assembled `promptText`; a direct
  // IPC `endpoint_invoke('agent_chats:chat')` would bypass all of it (no
  // cost caps, no persistence, raw prompt). Consumers reach it via
  // fetch('/api/…') → sys:http, which runs the route over IPC. See the
  // expose.ipc footgun note in oracle/chat.ts.
  description:
    'Single-turn streaming chat against an already-assembled role prompt. Returns final text + token/cost rollup; the caller is expected to persist the assistant turn.',
  args: ArgsSchema,
  events: EVENTS,
  agentRoles: ['operator'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  replayBufferSize: 5000,
  capability: 'harness:read',
  requirePrincipal: false,
  handler: agentChatsHandler,
});

export default agentChatsChat;
