/**
 * oracle:chat — global Oracle assistant turn.
 *
 * Single-turn streaming chat against the workspace-scoped Oracle persona.
 * Wraps runAgentChat with the ORACLE_ALLOWED_TOOLS surface (ui:* dispatch,
 * harness:*, agent_chats:*, etc.). Prompt assembly + MCP config build live
 * in ./prompts, but this tool is NOT safe for direct IPC endpoint dispatch
 * and therefore carries no `expose.ipc`: the Hono shim at /api/oracle/chat
 * resolves the session `userId` (getSessionUserOrDefault → mem0 user-scope)
 * before dispatching, and a direct `endpoint_invoke('oracle:chat')` would
 * silently drop it (workspace-scope memory only). Consumers reach it via
 * `fetch('/api/oracle/chat')`, which on desktop rides the desktop-ipc
 * `sys:http` bridge — i.e. the route runs over IPC, preserving the userId
 * resolution. See the `expose.ipc` footgun in plan
 * desktop-ipc-transport-completion-2026-05-20.
 *
 * Wire format (verified against OracleDock.tsx:840):
 *   event: delta       data: { text: string }                ← JSON
 *   event: tool_call   data: { name: string, input: unknown } ← JSON
 *   event: cost        data: { usd: number }                  ← JSON
 *   event: error       data: { message: string, stderr?: string } ← JSON
 *   event: tutorial_end data: {}                              ← JSON, sent once when final tutorial step reached
 *   event: done        data: <ToolResult.content as JSON>     ← terminal frame (shim dispatch loop / projected adapter emits + closes)
 *
 * Note: delta is z.object (JSON), NOT z.string raw — the consumer
 * does JSON.parse(data).text. Differs from architect:chat which uses
 * raw text for delta.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '../../agent-chat-stream';
import { surfaceBackend, surfaceModel } from '../../agent-config';
import {
  composeOraclePrompt,
  buildOracleMcpConfig,
  oracleToolEventFilter,
  ORACLE_ALLOWED_TOOLS,
  type OracleMessage,
} from './prompts';

const MessageSchema = z.object({
  role: z.union([z.literal('user'), z.literal('assistant')]),
  content: z.string(),
});

const ArgsSchema = z.object({
  messages: z.array(MessageSchema).min(1),
  currentPath: z.string().default(''),
  tutorialMode: z.boolean().default(false),
  uiClientId: z.string().optional(),
  /**
   * Session user id, populated by HTTP shims via getSessionUserOrDefault().
   * Optional because the tool can also be reached from MCP/IPC paths that
   * have no Next cookie context. When present, mem0 memory is fetched at
   * both user-scope AND workspace-scope; when absent, workspace-scope only.
   */
  userId: z.string().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const EVENTS = {
  // JSON wire (consumer at OracleDock.tsx:840 does JSON.parse(data).text).
  delta: z.object({ text: z.string() }),
  tool_call: z.object({ name: z.string(), input: z.unknown() }),
  cost: z.object({ usd: z.number() }),
  error: z.object({ message: z.string(), stderr: z.string().optional() }),
  // Fired once when the user reaches the final tutorial step (or stops).
  tutorial_end: z.object({}),
} as const;

interface ChatCtx {
  emit: (n: string, d: unknown) => void;
  signal?: AbortSignal;
}

async function oracleHandler(input: Args, ctx: ChatCtx) {
  const { promptText, tutorialIsFinalStep } = await composeOraclePrompt(
    input.messages as OracleMessage[],
    {
      currentPath: input.currentPath,
      tutorialMode: input.tutorialMode,
      userId: input.userId,
    },
  );

  if (tutorialIsFinalStep) ctx.emit('tutorial_end', {});

  const mcpConfig = await buildOracleMcpConfig({ uiClientId: input.uiClientId ?? null });
  if (!mcpConfig) {
    throw new Error(
      'Oracle not provisioned: missing system principal or superuser token. ' +
        'POST /api/agent-mcp/provision first and ensure ~/.papercusp/superuser-token exists.',
    );
  }

  let finalText = '';
  // per-surface backend override (/settings/agent); undefined → global
  const oracleBackend = await surfaceBackend('oracle');
  const oracleModel = await surfaceModel('oracle'); // OQ3: undefined → backend default
  try {
    for await (const ev of runAgentChat({
      promptText,
      ...(oracleModel ? { model: oracleModel } : {}),
      backend: oracleBackend,
      mcpConfig,
      allowedTools: [...ORACLE_ALLOWED_TOOLS],
      toolEventFilter: oracleToolEventFilter,
      permissionMode: 'bypassPermissions',
      // gateway-priority-tiers (WI-4542): the Oracle dock is a synchronous human-waiting chat
      // stream (OracleDock.tsx) — tag it 'interactive' so it rides the protected tier-1 admission
      // lane instead of falling to the untagged default band with batch/background traffic.
      priority: 'interactive',
      signal: ctx.signal,
    })) {
      if (ev.type === 'delta') {
        ctx.emit('delta', { text: ev.text });
        finalText += ev.text;
      } else if (ev.type === 'tool_call') {
        ctx.emit('tool_call', { name: ev.name, input: ev.input });
      } else if (ev.type === 'result') {
        ctx.emit('cost', { usd: ev.costUsd });
      } else if (ev.type === 'error') {
        ctx.emit('error', { message: ev.message, stderr: ev.stderr });
      }
    }
  } catch (err) {
    throw new Error(
      `oracle chat failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { content: [{ type: 'text' as const, text: finalText }] };
}

export const oracleChat = defineTool({
  name: 'oracle:chat',
  // No `expose.ipc` (was the footgun): route-dependent — the /api/oracle/chat
  // shim resolves the session userId before dispatch. Desktop reaches it via
  // fetch → sys:http (route runs over IPC), so closing the direct-dispatch
  // door changes nothing for real consumers. See the header comment.
  profile: 'engineer',
  description: 'Single-turn Oracle assistant chat. Streams delta/tool_call/cost events; returns final assistant text.',
  args: ArgsSchema,
  events: EVENTS,
  agentRoles: ['operator'],
  timeoutSec: 600,
  // WI-2142938: was 120. chat:ask_choice (in ORACLE_ALLOWED_TOOLS, above)
  // BLOCKS on ctx.askUser for up to its own 600s timeoutSec while a human
  // decides whether to click a card — see agent-tools/chat/ask_choice.ts's
  // EI-288 comment. While that nested MCP call is pending, runAgentChat's
  // underlying CLI subprocess streams NO delta/tool_call events (it is
  // waiting on the tool's result), so nothing resets dispatch-stack's idle
  // watchdog. A 120s idle cap therefore aborted this handler's own exec any
  // time a user took >120s to answer an ask_choice card — same root cause as
  // operator:converse's fix (see its idleTimeoutSec comment for the full
  // mechanism). Match timeoutSec so the idle cap can never fire before the
  // absolute one; a genuinely wedged subprocess is still caught by
  // timeoutSec regardless.
  idleTimeoutSec: 600,
  // Phase 4 T2.2 — same replay budget as architect:chat / operator:scan.
  replayBufferSize: 5000,
  capability: 'harness:read',
  requirePrincipal: false,
  handler: oracleHandler,
});

export default oracleChat;
