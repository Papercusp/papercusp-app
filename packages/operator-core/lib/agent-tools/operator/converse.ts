/**
 * operator:converse — Operator brain streaming-chat core.
 *
 * Self-contained as of the IPC-allowlist migration (2026-05-12). The
 * tool now owns the full lifecycle:
 *   - buildOperatorPrompt (role files, voice prefs, mem0 pre-turn
 *     injection, history budgeting, trigger/modality sections)
 *   - checkBudget gate
 *   - principal load + workspace check
 *   - mcpConfig assembly (agentmcp via mcp-remote bridge; reads
 *     ~/.papercusp/superuser-token directly)
 *   - LLM streaming via runAgentChat
 *   - post-stream side-effects: recordSpend, mem0 fact extraction
 *     (post-turn .add), and server-side <spawn>-tag dispatch
 *
 * The /api/agent-mcp/operator-converse route is now a thin shim that
 * resolves the session user from cookies (cookies aren't readable from
 * an IPC dispatch path) and forwards everything else through the tool.
 *
 * Wire format — `@papercusp/chat-protocol` `ChatEvent` frames (the SSE event
 * name is the discriminant; the data repeats it as `type`; D-008 of
 * papercup-chat-one-component-one-contract-2026-09-06):
 *   event: provenance data: { type, engine, model }      ← before the first
 *                                                          model event
 *   event: delta      data: { type, text }               ← object → JSON
 *                     (elevenlabs-conv consumer at :545 does
 *                      JSON.parse(line.slice(6)).text)
 *   event: tool_call  data: { type, name, input }
 *   event: done       data: <ToolResult.content as JSON>  ← framework auto-emit
 *                                                         (route also emits
 *                                                          sink.done with cost)
 *
 * On the IPC path the route's sink.done re-emit is bypassed; the
 * framework auto-emitted `done` is sufficient (consumer reads from
 * the tool's return value `{ totalCost, assembled }`).
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool, lookupByMcpName, resolveBearer } from '@papercusp/agent-mcp';
import { agentSpawnTransformConfigured } from '@papercusp/papercusp-shared/agent';
import { runAgentChat, resolveBackend } from '../../agent-chat-stream';
import { readAgentConfig, surfaceBackend, surfaceModel } from '../../agent-config';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  getChatBrainSession,
  hashSystemPrompt,
  invalidateChatBrainSession,
  recordChatBrainTurn,
  type ChatBrainSession,
} from './converse-session';
import { selfUrl } from '../../self-url';
import { checkBudget, recordSpend, shouldBypassOperatorBudget } from '../../operator-budget';
import { parseOperatorTurn } from '../../operator-converse-tags';
import { readSystemPrincipal } from '../../system-principal';
import { activeWorkspaceId } from '../../workspace-registry';
import { canonicalToolName } from '../../operator-mcp-tools';
import { PROMPT_ROLES } from '../../prompt-assembly';
import { UI_CONTEXT_MAX_CHARS } from '../../chat-context-sections';
import { capabilityToolNames, OWNED_LOOP_TOOL_SELECTION } from '../../agent-loop/capability-toolset';
import { assertSelectedInputSchemaBudget } from '../tool-guidance-budget';
import { papercupChatFailover, resolvePapercupChatModel } from '../../papercup/papercup-chat-model';
import { classifyChatModelFailure } from '../../chat-model-failure';
import type { AgentBackend } from '../../agent-config-constants';
import {
  buildConverseMcpMount,
  CONVERSE_HOST_TRUSTS,
  selectConverseTools,
  type ConverseHostTrust,
} from './converse-toolset';
import type { ChatEvent } from '@papercusp/chat-protocol';
import {
  buildOperatorPrompt,
  type ConverseSessionUser,
  type OperatorConverseInput,
} from './converse-prompt';
import { brainNoOutputMessage } from './converse-failure';

const MessageSchema = z.object({
  role: z.union([z.literal('user'), z.literal('assistant'), z.literal('system')]),
  content: z.string(),
});

const SessionUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  display_name: z.string(),
  has_password: z.boolean(),
});

/** Exported so the `papercup:converse` alias (sentinel-converse.ts) reuses the EXACT
 *  same strict arg surface — instead of a `.passthrough()` that drops the projected
 *  inputSchema's additionalProperties:false (the tool-input-schema-rejection guard). */
export const ArgsSchema = z.object({
  messages: z.array(MessageSchema).default([]),
  trigger: z
    .union([
      z.literal('user_message'),
      z.literal('quiet_wait_resume'),
      z.literal('open_canvas'),
      z.literal('user_says_ready'),
      z.literal('user_welcomed'),
      z.literal('continue'),
      // PROACTIVE Sentinel sweep turn — the server-side voice-host "decide to speak" tick fires this so a
      // proactive sentinel turn is distinguishable from a user-driven one (the
      // prompt surfaces FLEET-STATUS instead of a reply to the human). Gated:
      // only the server-side sweep (FLAGS.PAPERCUP_PROACTIVE, default OFF) emits it.
      z.literal('sentinel_scan'),
    ])
    .optional(),
  welcomedUser: z.object({ display_name: z.string().optional() }).optional(),
  mayAskActive: z.boolean().optional(),
  modality: z.union([z.literal('voice'), z.literal('text')]).optional(),
  audienceMode: z.union([z.literal('engineer'), z.literal('novice')]).optional(),
  /** Which persona the brain assumes — the Sentinel re-home seam.
   *  Defaults to 'operator' (fully backward-compatible). 'sentinel' loads the
   *  always-on, voice-first Sentinel persona set (same brain, different persona).
   *  Constrained to the persona roles that ship a prompt set under
   *  apps/operator/prompts/ (PROMPT_ROLES); an unknown value would throw in the
   *  persona loader, so the schema pins it to the known set. */
  role: z.enum(PROMPT_ROLES).optional(),
  /** Rendering surface: 'desktop' (web/Tauri UI, default) vs 'tui' (the pui
   *  terminal workbench). Same persona either way; only per-surface affordances
   *  differ (tui-operator-surface D-001/D-003). */
  surface: z.union([z.literal('desktop'), z.literal('tui')]).optional(),
  uiClientId: z.string().optional(),
  /** The shared PG conversation this turn belongs to. Enables the rolling-
   *  summary context (compaction mode) + the post-turn compaction pass
   *  (operator-context-compaction-2026-06-05). Optional: callers without a
   *  conversation (llm-testing, legacy voice paths) get window-only context. */
  conversationId: z.string().optional(),
  /** Session user resolved from cookies by the HTTP route; null
   *  acceptable on the IPC path or unauthenticated calls. */
  sessionUser: SessionUserSchema.nullable().optional(),
  /** Who is on the other end (papercup-chat-one-component-one-contract-2026-09-06
   *  P-005, D-007 §2). 'owner' (default) = the workspace owner's desktop / TUI /
   *  device: the curated working set over the `superuser=1` MCP mount and every
   *  prompt context section. 'public' = the portal behind its per-user boundary:
   *  the capability doors + the card tool over a mount that NEVER carries
   *  superuser=1 or the disk token, and only the boundary-allowed sections. */
  hostTrust: z.enum(CONVERSE_HOST_TRUSTS).optional(),
  /** The hosting surface's current UI context (the agent-chats seam's
   *  `body.context`) — orientation data, never authority. */
  uiContext: z.string().max(UI_CONTEXT_MAX_CHARS).optional(),
  /** Public trust only: the per-user boundary's bearer for the brain's MCP
   *  mount. Absent ⇒ the public brain runs TOOL-LESS (fail-closed, never on the
   *  owner's credential). Ignored on owner trust. */
  principalToken: z.string().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

/**
 * The operator brain's model. Resolution chain (highest wins):
 *   1. `OPERATOR_BRAIN_MODEL` env — CI / ad-hoc override.
 *   2. agent-config `models['operator']` — set per-workspace via
 *      /settings/agent, same surface as every other agent role.
 *   3. `OPERATOR_BRAIN_MODEL_DEFAULT` — the pinned fallback below.
 *
 * The DEFAULT is pinned to Anthropic, NOT inherited from the user's
 * omp `modelRoles.default` (their coding-agent default). As of
 * 2026-05-21 that default was `openai-codex/gpt-5.5:xhigh`, which
 * reliably returns `server_error` from OpenAI Codex on the operator's
 * large (~50KB) converse prompt — every live turn came back empty.
 * The Anthropic provider handles the same prompt reliably. The brain
 * is a product feature; it must not break because the user retuned
 * their coding agent.
 *
 * A model set explicitly via env or settings is the user's INFORMED
 * choice and overrides the pin — including non-Anthropic models that
 * may choke on the big prompt. omp's `--model` needs the explicit
 * `provider/model` form — a bare id fuzzy-resolves to amazon-bedrock,
 * which has no key configured here.
 */
const OPERATOR_BRAIN_MODEL_DEFAULT = 'anthropic/claude-opus-4-7';

async function resolveBrainModel(): Promise<string> {
  const env = process.env.OPERATOR_BRAIN_MODEL;
  if (env && env.trim()) return env.trim();
  try {
    const cfg = await readAgentConfig();
    const v = cfg.models['operator'];
    if (v && v.trim()) return v.trim();
  } catch {
    /* PG unreachable — fall through to the pinned default */
  }
  return OPERATOR_BRAIN_MODEL_DEFAULT;
}

/**
 * The model + backend this turn's ROLE runs on. The operator brain keeps its
 * chain (resolveBrainModel: env > agent-config models['operator'] > pinned
 * default, with the per-surface override on top). The chat `papercup` role is
 * the QUICK model pinned in PAPERCUP_CHAT_MODEL_PIN (D-007 §3): its own env >
 * agent-config > pin ladder lives in papercup-chat-model.ts, and the backend
 * travels WITH the pin (a bare luna id on a claude-CLI backend hard-downs the
 * role — WI-4623). Exported for the handler tests.
 */
export async function resolveConverseBrain(
  role: string,
): Promise<{ model: string; backend: AgentBackend | undefined }> {
  const surfaceBe = await surfaceBackend('operator');
  if (role === 'papercup') {
    let config: Awaited<ReturnType<typeof readAgentConfig>> | null = null;
    try {
      config = await readAgentConfig();
    } catch {
      /* PG unreachable — the pin still resolves */
    }
    const r = resolvePapercupChatModel({ env: process.env, config, fallbackBackend: surfaceBe });
    return { model: r.model, backend: r.backend };
  }
  const brainModel = await resolveBrainModel();
  return { model: (await surfaceModel('operator')) ?? brainModel, backend: surfaceBe };
}

/**
 * Emit one `@papercusp/chat-protocol` frame: the SSE event name IS the
 * discriminant and the data carries it too, so `parseChatEvent(name, data)` on
 * either host round-trips it. Every frame this tool streams goes through here
 * so the wire cannot drift from the protocol type.
 */
function emitChatEvent(ctx: { emit: (event: string, data: unknown) => void }, ev: ChatEvent): void {
  ctx.emit(ev.type, ev);
}

function readSuperuserToken(): string {
  try {
    const token = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
    return token.length >= 16 ? token : '';
  } catch {
    return '';
  }
}

export default defineTool({
  name: 'operator:converse',
  expose: { ipc: true },
  profile: 'engineer',
  description:
    'Operator brain conversation turn. Self-contained: builds the prompt (role+memory+history+trigger), gates on budget, runs the LLM with agentmcp tools, records spend, post-turn mem0.add, dispatches <spawn> tags. Streams deltas + tool_calls.',
  capability: 'operator:converse',
  requirePrincipal: false,
  // Sentinel: the sentinel is re-homed onto the always-on voice-first
  // persona, which IS this converse brain loaded with role='sentinel' (the
  // operator-converse route resolves `${role}:converse` and the prompt builder
  // loads the sentinel persona set). So the sentinel role must be allowlisted
  // here too — paired with its operator:converse capability grant
  // (BLUEPRINT_ROLE_CAPS.sentinel). The papercup:converse tool alias registers
  // the same handler under the sentinel name; both resolve this allowlist.
  agentRoles: ['operator', 'papercup'],
  timeoutSec: 600,
  // WI-2142938: was 120. chat:ask_choice (available in this brain's own tool
  // surface, ALL_AGENT_MCP_TOOLS) BLOCKS on ctx.askUser for up to its own
  // 600s timeoutSec while a human decides whether to click a card — see
  // agent-tools/chat/ask_choice.ts's EI-288 comment. While that nested call
  // is pending, runAgentChat's underlying CLI subprocess streams NO
  // delta/tool_call events (it is waiting on the tool's MCP result), so
  // nothing resets dispatch-stack's idle watchdog (ctx-bindings' wrappedEmit
  // only bumps lastEmitMs on emit). A 120s idle cap therefore aborted this
  // handler's own exec (idleWatchdogStep) any time a user took >120s to
  // answer an ask_choice card — the abort makes runAgentChat's loop `break`
  // silently (ctx.signal.aborted, no throw), so the SSE stream just ends
  // with nothing persisted, while the card itself stayed open/clickable
  // (state-snapshot driven, decoupled from this turn — see ask_choice.ts's
  // docstring). Root cause of the "assistant turn never persisted to
  // operator_turns" defect. Match timeoutSec so the idle cap can never fire
  // before the absolute one — a genuinely wedged subprocess is still caught
  // by timeoutSec regardless.
  idleTimeoutSec: 600,
  // Phase 4 T2.2 — opt into replay buffer. 5000 events is a
  // generous soft cap; eviction warn-logs let us tune down once
  // migration 066's event_count column has p99 data.
  replayBufferSize: 5000,
  // Phase 4 T3.1 — operator:converse is the brain for BOTH text
  // chat AND voice (the EL Conv AI integration POSTs to this same
  // tool's HTTP shim). Declaring both modalities means it shows up
  // in both surface catalogs.
  modality: ['text', 'voice'],
  args: ArgsSchema,
  events: {
    delta: z.object({ text: z.string() }),
    tool_call: z.object({ name: z.string(), input: z.unknown() }),
  },
  handler: async (input: Args, ctx) => {
    const sessionUser: ConverseSessionUser | null = input.sessionUser ?? null;
    // Per-turn phase timing (reply-latency instrumentation, grade-loop
    // 2026-07-16): the IPC converse path never lands in tool_invocations, so
    // this structured log line is the only latency split we have. Grep for
    // `turn-timings` in the operator log.
    const tTurnStart = Date.now();
    const turnModality: 'voice' | 'text' = input.modality === 'voice' ? 'voice' : 'text';

    // WI-5071 brain-session reuse eligibility — resolved BEFORE the prompt
    // build because it changes the prompt layout (memoryInUser moves the
    // per-turn-varying recall out of the system prompt so the system stays
    // byte-stable across a session's turns). claude-code only: the other
    // backends either have no on-disk session store (anthropic-direct) or
    // are not wired for it (omp/codex). The per-surface backend override is
    // resolved here (and reused below) instead of after the build.
    const role = input.role ?? 'operator';
    const hostTrust: ConverseHostTrust = input.hostTrust === 'public' ? 'public' : 'owner';
    // The role's model + backend, resolved ONCE up front: the backend gates
    // session reuse below (claude-code only), and the papercup pin carries its
    // backend with it (D-007 §3).
    const { model: operatorModel, backend: operatorBackend } = await resolveConverseBrain(role);
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    const ownerPrincipal = hostTrust === 'owner'
      ? await readSystemPrincipal('operator', workspaceId)
      : null;
    let publicPrincipal: Awaited<ReturnType<typeof resolveBearer>> = null;
    if (hostTrust === 'public' && input.principalToken?.trim()) {
      try {
        publicPrincipal = await resolveBearer(input.principalToken.trim());
      } catch {
        // Fail closed to a tool-less public brain; never borrow the owner token.
      }
    }
    const principalOk = hostTrust === 'owner'
      ? ownerPrincipal !== null && ownerPrincipal.workspaceId === workspaceId
      : publicPrincipal?.kind === 'pi' && publicPrincipal.workspaceId === workspaceId;
    // D-421 (WI-10003195): with the hosted customer-identity spawn transform installed, the
    // brain's agent CLI runs as the customer workspace account. The owner mount's bearer is the
    // operator superuser token — a credential that account must never hold (it reaches tools
    // that execute as the service identity, undoing D-417), and the transform refuses any spawn
    // carrying it. So the owner brain runs tool-less there rather than failing every turn, until
    // a customer-scoped bearer exists.
    const hostedCustomerIdentity = hostTrust === 'owner' && agentSpawnTransformConfigured();
    // The brain's tool surface for this turn — host-TRUST-keyed (D-007 §2), and
    // resolved BEFORE the prompt build so the catalog advertises exactly the set
    // the mount serves (listed == callable on both trusts).
    const selectedOperatorTools: readonly string[] = selectConverseTools({
      role,
      hostTrust,
      publicDoorNames: () => capabilityToolNames(OWNED_LOOP_TOOL_SELECTION),
    });
    const operatorTools: readonly string[] = !principalOk || hostedCustomerIdentity
      ? []
      : hostTrust === 'public' && publicPrincipal
        ? selectedOperatorTools.filter((fullName) => {
            const canonicalName = fullName.replace(/^mcp__agentmcp__/, '');
            const projected = lookupByMcpName(canonicalName);
            return projected !== undefined
              && projected.capabilities.every((capability) => publicPrincipal.capabilities.has(capability));
          })
          : selectedOperatorTools;
    // The `?tools=` MCP mount loads exactly these selected schemas non-deferred.
    // Account for the selected set at that runtime seam; promptWeight() remains
    // the description/guidance-only metric for the assembled prompt catalog.
    assertSelectedInputSchemaBudget(
      operatorTools.flatMap((fullName) => {
        const canonicalName = fullName.replace(/^mcp__agentmcp__/, '');
        const projected = lookupByMcpName(canonicalName);
        return projected ? [{ name: canonicalName, inputSchema: projected.inputSchema }] : [];
      }),
      { label: `operator:converse ${hostTrust} tool set` },
    );
    const convId =
      typeof input.conversationId === 'string' && input.conversationId.trim()
        ? input.conversationId
        : null;
    let sessionReuseOn = false;
    if (convId && resolveBackend({ promptText: '', backend: operatorBackend }) === 'claude-code') {
      try {
        // NOTE: getFlag is async — await it (EI-13014: a bare truthy check on
        // the returned Promise reads as permanently-enabled).
        sessionReuseOn = (await getFlag(FLAGS.OPERATOR_CHAT_SESSION_REUSE, 'operator-converse')) === true;
      } catch {
        sessionReuseOn = false;
      }
    }

    // Build the prompt up-front. This dominates wall-clock when mem0
    // is healthy (search hits one or two times). Failures inside
    // buildOperatorPrompt are swallowed best-effort already; an
    // outer throw here would be a real config error worth surfacing.
    //
    // Returns BOTH a system prompt (persona + tools + memory — the
    // stable spec) AND a user prompt (history + trigger + modality —
    // this turn's context). The agent backend (omp) is invoked with
    // `--system-prompt @file` for the system part so the brain
    // assumes the Operator identity instead of meta-commenting on
    // the persona as a document handed to it (2026-05-21 root cause).
    const { systemPromptText, userPromptText, userPromptTextDelta } = await buildOperatorPrompt(
      {
        messages: input.messages,
        trigger: input.trigger,
        welcomed_user: input.welcomedUser,
        mayAskActive: input.mayAskActive,
        modality: input.modality,
        audienceMode: input.audienceMode,
        surface: input.surface,
        uiClientId: input.uiClientId,
        conversationId: input.conversationId,
        // Sentinel re-home seam: 'operator' (default) is unchanged;
        // 'sentinel' loads the Sentinel persona set.
        role: input.role,
        // WI-5071: keep the system prompt byte-stable for session reuse.
        memoryInUser: sessionReuseOn,
        // P-005 (D-007 §2): host trust keys the context sections; the surface's
        // UI context rides along; the catalog advertises THIS turn's toolset.
        hostTrust,
        uiContext: input.uiContext,
        toolNames: operatorTools,
      } satisfies OperatorConverseInput,
      sessionUser,
    );
    const buildPromptMs = Date.now() - tTurnStart;

    // WI-5071: resolve (or mint) this conversation's claude session. A hash
    // drift (persona/catalog/prefs change), age/turn-cap expiry, or a prior
    // invalidation all come back `resumed: false` ⇒ this turn sends the FULL
    // prompt into a fresh session; `resumed: true` ⇒ the DELTA prompt only.
    let brainSession: ChatBrainSession | null =
      sessionReuseOn && convId
        ? getChatBrainSession(convId, hashSystemPrompt(systemPromptText))
        : null;
    let turnSessionMode: 'cold' | 'fresh-session' | 'resumed' = 'cold';

    // Budget gate. operator-converse fires on every user turn AND
    // self-fired silence-ladder triggers AND through ask_operator
    // from voice — without a cap this burns through the daily budget.
    const budget = shouldBypassOperatorBudget(input.uiClientId)
      ? null
      : await checkBudget();
    if (budget?.state && budget.exceeded) {
      throw new Error(
        `Papercup daily budget reached (${budget.todaySpendUsd.toFixed(2)} of ${budget.capUsd}). Raise the cap in /settings/operator or wait until tomorrow.`,
      );
    }

    // Principal + workspace check: transport-agnostic gate via
    // readSystemPrincipal. Missing principal falls through to a lean
    // tool-less path so conversation still works.
    // The workspace this turn runs in. Prefer the DISPATCH context's
    // workspace — the route/IPC layer resolved it INSIDE the request scope
    // (x-papercusp-workspace header / window stamp). Re-resolving
    // activeWorkspaceId() here runs outside the request ALS (the SSE setup
    // dispatches after the route handler has returned its Response), so it
    // silently falls back to the process-global workspace. That mis-keys the
    // state channel: chat_ask_choice cards register under the global
    // workspace while the voice SSE subscribed the request's workspace — no
    // overlap, so EVERY voice disambiguation card silently died and the
    // brain's askUser timed out to a prose fallback (root cause of the S16
    // cardUsage failures; voice-persona-production-readiness P-003, found
    // live 2026-06-07). '*' is the superuser wildcard, not a real workspace.
    // mcpConfig with agentmcp HTTP via mcp-remote bridge (same pattern
    // as the old route). Reads superuser token from disk.
    // Accept hex/dash UUIDs (the browser tab's client id) AND the
    // llm-testing framework's `llm-testing/<uuid>` form. Both are
    // URL-safe after encodeURIComponent. The framework's prefix is
    // what the brain-subprocess MCP transport needs to see for the
    // dispatcher's overrideTool hook to fire — without preserving it
    // here, nested tool calls would lose the tag and the override
    // would never apply.
    const uiClientId =
      typeof input.uiClientId === 'string'
        && /^(?:llm-testing\/)?[0-9a-fA-F-]{16,128}$/.test(input.uiClientId)
        ? input.uiClientId
        : null;
    // The agentmcp HTTP MCP mount (converse-toolset.ts) — one set feeds BOTH the
    // `?tools=` allowlist and `--allowed-tools`, so the listed surface and the
    // callable surface stay identical by construction. chat:ask_choice is on
    // the TUI surface too: the pui renders inline terminal cards from the
    // state-channel `openCards` snapshot (Phase 2a). `?tools=` shrinks the
    // /api/mcp surface to the selected set, loaded NON-deferred, so Claude Code
    // stops ToolSearch-flailing over a giant deferred catalog (P-009).
    //   owner trust  → `superuser=1` + the on-disk superuser token (unchanged).
    //   public trust → NO superuser param, NO disk token — ever (D-007 §2): the
    //                  per-user boundary's own bearer (input.principalToken) or
    //                  no mount at all, so a public brain never borrows the
    //                  owner's credential; it runs tool-less instead.
    // workspace= is REQUIRED for state-channel scoping: chat:ask_choice
    // sub-tool calls (via the brain → MCP HTTP) need ctx.workspaceId to match
    // what the chat surface subscribed to (subscribeWorkspace). Without it the
    // superuser path defaults to workspaceId='*' and cards never reach the
    // PendingCardsBar (registers under '*', surface subscribed to the real
    // workspaceId — no overlap). Plan ref: bespoke-card-improvements-2026-05-13
    // §4.4 wire shape.
    const mount = buildConverseMcpMount({
      hostTrust,
      baseUrl: selfUrl(),
      workspaceId,
      tools: operatorTools,
      uiClientId,
      superuserToken: hostTrust === 'owner' && !hostedCustomerIdentity ? readSuperuserToken() : '',
      agentRunsAsCustomer: hostedCustomerIdentity,
      principalToken: hostTrust === 'public' ? (input.principalToken ?? null) : null,
    });
    const mcpConfig =
      principalOk && mount
        ? {
            mcpServers: {
              // Direct HTTP MCP — the brain connects to the host's /api/mcp
              // natively, the same shape the user's papercusp-su server uses.
              // The old `npx mcp-remote@latest` stdio bridge added a cold
              // npm-resolve + a proxy subprocess on every turn and was the
              // flaky empty-turn culprit (2026-05-21).
              agentmcp: {
                type: 'http',
                url: mount.url,
                headers: { Authorization: `Bearer ${mount.bearer}` },
              },
            },
          }
        : undefined;
    // The callable surface mirrors the listed (`?tools=`) surface exactly —
    // listed == callable by construction; no mount ⇒ no callable tools.
    const allowedTools: readonly string[] = mcpConfig ? operatorTools : [];

    let totalCost = 0;
    let assembled = '';
    let unreportedFrames = 0;
    let emittedToolCall = false;
    let firstEventAt: number | null = null;

    // `operatorModel` / `operatorBackend` were resolved ONCE at the top of the
    // handler (resolveConverseBrain): the operator brain's env > agent-config >
    // pinned default with the per-surface override (OQ3) on top; the papercup
    // role's quick-model pin WITH its backend (D-007 §3). An undefined backend
    // inherits the global $AGENT_BACKEND that applyToProcessEnv mirrors from
    // agent-config.
    // Announce what will ACTUALLY run before the first model event — the same
    // chat-protocol `provenance` frame the agent-chats route emits, so the
    // shared PapercupChat shows one provenance line on both hosts (D-008).
    //
    // WI-10003608: these are the model/backend the CURRENT attempt runs on. They start
    // as the resolved role brain; a papercup turn whose backend reports a usage cap or a
    // dead credential moves its retry to the paired alternate (papercupChatFailover),
    // because re-running the same account cannot succeed against either.
    let brainModel = operatorModel;
    let brainBackend = operatorBackend;
    let brainEngine = resolveBackend({ promptText: '', backend: brainBackend });
    let failedOver = false;
    emitChatEvent(ctx, {
      type: 'provenance',
      engine: brainEngine,
      model: brainModel,
    });
    // WI-10003188: the backend's own reason for a failed attempt, so a turn that ends
    // with no output can say WHY instead of a fixed "agent backend failure".
    let lastBackendError: string | null = null;

    // The agent backend (omp → codex/anthropic) intermittently produces
    // an empty turn: a transient upstream model error, or omp exiting 0
    // with no assistant text. Retry ONCE when an attempt produced
    // nothing at all — but never after any delta/tool_call has already
    // streamed to the user, since that output is committed on the wire.
    // (2026-05-21: operator returned blank turns under codex flakiness.)
    const MAX_BRAIN_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_BRAIN_ATTEMPTS; attempt++) {
      // WI-5071: a blank attempt on a session (resumed OR fresh) must not eat
      // the retry too — drop the session and run the retry fully cold with
      // the full prompt, exactly the pre-session behavior.
      if (attempt > 1 && brainSession && convId) {
        invalidateChatBrainSession(convId, `blank turn on attempt ${attempt - 1}`);
        brainSession = null;
      }
      const resumedTurn = !!brainSession?.resumed;
      turnSessionMode = brainSession ? (resumedTurn ? 'resumed' : 'fresh-session') : 'cold';
      // This attempt's own backend error only — the failover decision must never act
      // on a previous attempt's reason.
      let attemptBackendError: string | null = null;
      try {
        for await (const ev of runAgentChat({
          // Resumed session ⇒ delta prompt (the session carries the history
          // verbatim); fresh/cold ⇒ the full prompt.
          promptText: resumedTurn ? userPromptTextDelta : userPromptText,
          // First turn of a session: 'force' (`--session-id <uuid>`) CREATES
          // it — create-ONLY: claude-code exits 1 "Session ID … is already in
          // use" if the id exists (verified live 2026-07-16; the old
          // "create-or-resume" doc was wrong). Later turns: 'resume' (`-r`).
          // isolateDir pins the stable config dir the session store lives in.
          ...(brainSession
            ? {
                sessionId: brainSession.sessionId,
                sessionMode: resumedTurn ? ('resume' as const) : ('force' as const),
                isolateDir: brainSession.dir,
              }
            : {}),
          systemPromptText,
          model: brainModel,
          backend: brainBackend,
          // Gateway admission tier: this brain IS the owner-interactive chat/voice
          // reply (loopback-only route; operator:converse + the papercup:converse
          // voice alias share this handler). Tag it `interactive` so its LLM calls
          // land in the gateway's reserved tier-1 (HUMAN_PRIORITY_LABELS → fail-fast
          // + reserved floor) instead of the untiered default band, where under an
          // account-pool crunch the owner's voice queued behind the background fleet
          // and hung ("processing forever" — EI-10795). Threads to every backend:
          // anthropic-direct via priorityTierHeaders, claude/codex via the spawn's
          // ANTHROPIC_CUSTOM_HEADERS / gateway config.
          priority: 'interactive',
          mcpConfig,
          allowedTools: [...allowedTools],
          permissionMode: 'bypassPermissions',
          // Isolate the claude-code brain spawn from the host ~/.claude so
          // it loads ONLY its agentmcp tools + persona — not the dev box's
          // MCP servers (coord_*/harness_*/papercusp-su) + SessionStart
          // skills hook, which under bypassPermissions make the brain go
          // agentic and emit no clean turn (turns=0). No-op for non-claude
          // backends. See plan operator-brain-test-isolation-2026-06-02.
          isolateConfig: true,
          // The operator reaches its world ONLY through agentmcp tools and
          // emits <say>/<spawn> as control-tag text — it needs no Claude
          // Code built-ins, and when present it misuses them (no-op Bash
          // "comments", ToolSearch-ing already-loaded tools, occasional
          // 600s loops). Deny them all. See voice-persona-production-readiness.
          disallowBuiltins: true,
          // Load the ~50-tool `?tools=`-filtered surface DIRECTLY (no ToolSearch
          // deferral). Empirically the proven non-deferral lever on claude-code
          // 2.1.x — per-tool `_meta.alwaysLoad` is not honored over HTTP MCP.
          // Safe only because the mcpUrl above pins `&tools=` to the small set.
          // (voice-persona-production-readiness P-009.)
          disableToolSearch: true,
          signal: ctx.signal,
        })) {
          if (firstEventAt === null) firstEventAt = Date.now();
          if (ctx.signal.aborted) break;
          if (ev.type === 'delta') {
            emitChatEvent(ctx, { type: 'delta', text: ev.text });
            assembled += ev.text;
          } else if (ev.type === 'tool_call') {
            emittedToolCall = true;
            // Claude Code strips the colon before the model sees the name, so
            // this arrives sanitized (`chat_ask_choice`). Restore the canonical
            // `chat:ask_choice` — the key the chat-cards registry and the
            // ask_choice gates match on; without it the card silently never
            // renders and the user sees a "pick one" with nothing to pick.
            const name = canonicalToolName(ev.name);
            emitChatEvent(ctx, { type: 'tool_call', name, input: ev.input });
          } else if (ev.type === 'result') {
            totalCost += ev.costUsd ?? 0;
            if (typeof ev.unreportedFrames === 'number' && Number.isSafeInteger(ev.unreportedFrames) && ev.unreportedFrames > 0) {
              unreportedFrames += ev.unreportedFrames;
            }
          } else if (ev.type === 'error') {
            // runAgentChat yields exactly one terminal `error` event
            // when the agent backend itself failed. Log it (stderr
            // included) for host-log visibility; fall through to the
            // empty-output retry check below rather than throwing, so a
            // transient backend error still gets a second attempt.
            lastBackendError = ev.message;
            attemptBackendError = ev.message;
            const detail = ev.stderr
              ? `${ev.message}\n--- stderr ---\n${ev.stderr}`
              : ev.message;
            console.error(
              '[operator:converse] agent backend error ' +
                `(attempt ${attempt}/${MAX_BRAIN_ATTEMPTS}): ${detail}`,
            );
          }
        }
      } catch (err) {
        throw new Error(
          `operator converse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Stop once this attempt committed any output, or on abort.
      if (assembled.trim() || emittedToolCall || ctx.signal.aborted) break;
      if (attempt < MAX_BRAIN_ATTEMPTS) {
        const failover =
          role === 'papercup' && !failedOver
            ? papercupChatFailover({ engine: brainEngine, failure: classifyChatModelFailure(attemptBackendError) })
            : null;
        if (failover) {
          console.error(
            `[operator:converse] ${brainEngine} (${brainModel}) failed with ${failover.cause} on attempt ` +
              `${attempt} — failing over to ${failover.backend} (${failover.model}).`,
          );
          failedOver = true;
          brainModel = failover.model;
          brainBackend = failover.backend;
          brainEngine = resolveBackend({ promptText: '', backend: brainBackend });
          // Re-announce what actually runs now; the chat reducer keeps the latest frame.
          emitChatEvent(ctx, { type: 'provenance', engine: brainEngine, model: brainModel });
        } else {
          console.error(
            `[operator:converse] brain produced no output on attempt ${attempt} — retrying.`,
          );
        }
      }
    }

    // Definitive failure: nothing produced across all attempts. Surface
    // it as an error rather than masquerading a dead brain as an empty
    // `done` — the route turns a thrown error into `event: error`.
    if (!assembled.trim() && !emittedToolCall && !ctx.signal.aborted) {
      console.error(
        `[operator:converse] agent backend produced no output after ${MAX_BRAIN_ATTEMPTS} attempts.`,
      );
      throw new Error(brainNoOutputMessage({ engine: brainEngine, model: brainModel, lastBackendError }));
    }

    // WI-5071: output committed on a session-backed turn — bump the marker so
    // the NEXT turn resumes (turnCount 0 → 1 is what flips `resumed` on).
    if (brainSession && convId && (assembled.trim() || emittedToolCall)) {
      recordChatBrainTurn(convId);
    }

    // Per-turn latency split (reply-latency instrumentation, grade-loop
    // 2026-07-16). buildPromptMs = prompt assembly (mem0 + role files);
    // firstEventMs = agent-backend spawn + connect + LLM time-to-first-event;
    // totalMs = the whole turn as the user experiences it.
    console.log(
      `[operator:converse] turn-timings buildPromptMs=${buildPromptMs} ` +
        `firstEventMs=${firstEventAt !== null ? firstEventAt - tTurnStart : -1} ` +
        `totalMs=${Date.now() - tTurnStart} model=${brainModel} failedOver=${failedOver} ` +
        `modality=${turnModality} emittedToolCall=${emittedToolCall} ` +
        `assembledChars=${assembled.length} session=${turnSessionMode} ` +
        `role=${role} trust=${hostTrust} tools=${allowedTools.length}`,
    );

    // WI-4950 class observability: a turn that enumerated options in prose
    // and asked the user to pick, without any tool call, is a conversational
    // dead-end the prompt contract failed to prevent — in BOTH modalities
    // (the chat sidebar sends modality=voice for TYPED messages whenever
    // voice mode is on, and prose enumeration is neither clickable nor
    // voice-answerable either way). Log it so the grade loop can measure the
    // miss rate live. Detector is deliberately conservative; failures here
    // must never fail the turn.
    if (!emittedToolCall && assembled.trim()) {
      try {
        const { detectProsePickOne } = await import('../../operator-prose-pick-one');
        const hit = detectProsePickOne(assembled);
        if (hit.detected) {
          console.warn(
            `[operator:converse] prose-pick-one detected (${hit.reason}; WI-4950 class; ` +
              `modality=${turnModality}): reply="${assembled.slice(0, 140).replace(/\n/g, ' ')}"`,
          );
        }
      } catch {
        /* observability only */
      }
    }

    // Post-stream side-effects. All fire-and-forget so transient
    // failures don't fail the user-visible response.
    void recordSpend(totalCost);

    // Rolling-summary compaction pass (operator-context-compaction-2026-06-05):
    // fold turns that aged out of the verbatim window into the conversation's
    // PG summary so the NEXT turn still remembers them. Single-flighted +
    // threshold-gated inside; no-op without a conversationId.
    if (input.conversationId) {
      void (async () => {
        const { maybeCompactConversation } = await import(
          '../../operator-conversation-compaction'
        );
        await maybeCompactConversation(input.conversationId!);
      })().catch((err) => {
        console.warn(
          '[operator-converse] compaction pass failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    // llm-testing turns may resolve the live default session user through the
    // HTTP route, but their scenario memory is isolated/explicitly cleaned up.
    // Keep those benchmark turns out of the operator's normal post-turn
    // conversation extractor; prompt-time recall and ordinary user capture are
    // intentionally unchanged.
    if (sessionUser && !input.uiClientId?.startsWith('llm-testing/')) {
      void (async () => {
        try {
          // EI-2032: kill switch for per-turn conversation capture — the largest
          // source of low-signal / zero-anchor memories (the auto-extraction path
          // that bypasses the explicit-write conflict-check/boundary gates).
          // Default ON (behavior unchanged); PAPERCUSP_MEM0_CONVERSATION_CAPTURE=off
          // disables it (e.g. if conversational capture is adding recall noise).
          if (process.env.PAPERCUSP_MEM0_CONVERSATION_CAPTURE === 'off') return;
          // Conversation-window fact extraction is an OPTIONAL backend
          // capability (generalize-memory-backend-swappable D-003) —
          // mem0 has it; plain stores skip the post-turn capture.
          const { getMemoryBackend } = await import('../../memory/backend');
          const backend = getMemoryBackend();
          if (!backend.rememberConversation) return;
          if (!(await backend.available()).ok) return;
          const recentWindow = input.messages
            ? [...input.messages.slice(-5), { role: 'assistant' as const, content: assembled }]
            : [{ role: 'assistant' as const, content: assembled }];
          await backend.rememberConversation(recentWindow, {
            scope: sessionUser.id,
            metadata: {
              workspace_id: workspaceId,
              display_name: sessionUser.display_name,
              turn_at: Date.now(),
            },
          });
        } catch (err) {
          console.warn('[operator-converse] post-turn memory capture failed:', (err as Error).message);
        }
      })();
    }

    // Server-side <spawn> tag dispatch. Parsing the assembled turn
    // server-side ensures voice and text surfaces both trigger spawns.
    // (EL's ask_operator handler doesn't run the client-side parser.)
    //
    // Dispatches through the durable nursery spawn engine
    // (fleet/operator-spawn) — NOT the retired POST
    // /api/plugins/orchestrator/spawn, which 404'd silently (the plugin
    // is not installed) and targeted harness='system' (not a registered
    // project). The engine resolves the tag's harness attr (or the
    // workspace's single registered harness), records the row in
    // harness_shared.spawned_agents (visible in fleet:tree), launches the
    // child in the harness's real project dir, and records resolution
    // failures as failed nursery rows instead of dropping them.
    try {
      const parsed = parseOperatorTurn(assembled);
      // Sentinel control tags: the SENTINEL never places work itself. It can
      // emit `<handoff>` for buildable work (file-and-nudge to the Mug). Honored
      // ONLY for role==='papercup'; the operator path below ignores it (and the
      // sentinel ignores spawns — the two can't cross). The Sentinel must NOT
      // cup:spawn. The `<delegate_deep>` TAG path is RETIRED (D-007 §3, PARITY
      // op-delegate-deep): hard thinking is the `voice:delegate_deep` TOOL in
      // the papercup toolset (converse-toolset.ts), called with wait:true so the
      // answer lands in the SAME turn — a stray tag is inert here.
      const isSentinel = role === 'papercup';
      if (isSentinel && parsed.handoffs.length > 0) {
        const [{ dispatchSentinelHandoff }, { defaultSentinelHandoffDeps }] = await Promise.all([
          import('../../operator-sentinel-handoff'),
          import('../../operator-sentinel-handoff-deps'),
        ]);
        const deps = defaultSentinelHandoffDeps();
        for (const h of parsed.handoffs) {
          void dispatchSentinelHandoff(h, workspaceId, deps)
            .then((r) => {
              if (r.status === 'error') {
                console.warn(`[sentinel-converse] handoff dispatch failed: ${r.error}`);
              }
            })
            .catch((err) => {
              console.warn('[sentinel-converse] handoff dispatch error', err);
            });
        }
      }
      if (isSentinel && parsed.deepDelegations.length > 0) {
        // Observability only: the prompt no longer teaches the tag, so a hit
        // here means a stale persona/prompt override is still emitting it.
        console.warn(
          `[sentinel-converse] ignoring ${parsed.deepDelegations.length} <delegate_deep> tag(s) — ` +
            'the tag path is retired; the papercup toolset carries voice:delegate_deep (D-007 §3).',
        );
      }
      // The OPERATOR spawns directly; the SENTINEL never does (its envelope denies
      // cup:spawn). Guard the spawn dispatch on NOT-sentinel so a stray `<spawn>`
      // from the Sentinel persona is a no-op rather than a placement.
      if (!isSentinel && parsed.spawns.length > 0) {
        const { spawnAgentInHarness } = await import('../../fleet/operator-spawn');
        for (const sp of parsed.spawns) {
          // The operator conversation turn is NOT itself a nursery node, so each
          // spawned agent is a ROOT in the spawn tree (parent_spawn_id = null) —
          // inspect it with fleet:tree { spawn_id: <returned id> }. (A synthetic
          // parent id would be an orphan: getSubtree anchors on a real row, so a
          // tree rooted at a non-existent parent comes back empty.)
          void spawnAgentInHarness({
            // Descriptive attribution for the observe-only governor receipt (D-011).
            spawnCaller: 'agent-tools/operator/converse',
            workspaceId,
            harness: sp.harness,
            role: sp.role,
            featureId: sp.featureId,
            chunkId: sp.chunkId,
            extras: sp.extras,
            parentSpawnId: null,
            parentRole: 'operator',
          })
            .then((r) => {
              if (!r.ok) console.warn(`[operator-converse] spawn dispatch rejected: ${r.error}`);
            })
            .catch((err) => {
              console.warn('[operator-converse] spawn dispatch failed', err);
            });
        }
      }
    } catch (err) {
      console.warn('[operator-converse] spawn parse/dispatch error', err);
    }

    return {
      data: {
        totalCost,
        assembled,
        ...(unreportedFrames > 0 ? { unreportedFrames } : {}),
      },
    };
  },
});
