/**
 * /api/harness/:slug/agent-chats — multi-turn conversational sessions
 * with role-scoped agents. Phase A2 (endpoint-hono-elimination-2026-05-21).
 * Ported off `_hono/agent-chats.ts` (mounted via `registerAgentChats`).
 * URLs unchanged.
 *
 *   GET    /api/harness/:slug/agent-chats
 *   POST   /api/harness/:slug/agent-chats
 *   GET    /api/harness/:slug/agent-chats/:chatId
 *   PUT    /api/harness/:slug/agent-chats/:chatId            → rename
 *   DELETE /api/harness/:slug/agent-chats/:chatId
 *   POST   /api/harness/:slug/agent-chats/:chatId/continue   → fresh linked chat
 *   POST   /api/harness/:slug/agent-chats/:chatId/messages   → SSE stream
 *
 * `auth: 'public'` — the legacy `harness` sub-app gated none of these.
 */
import { join } from 'node:path';
import { sseResponse } from '@papercusp/sse';
import type { ChatEvent } from '@papercusp/chat-protocol';
import { dispatchProjectedTool, dispatchProjectedToolStream, lookupByMcpName } from '@papercusp/agent-mcp';
import { harnessQuery, withWorkspace } from '@papercusp/db-org';
import { assembleRolePrompt as assembleHarnessRolePrompt } from '@papercusp/orchestrator/role-prompt';
import { assembleRolePrompt as assembleOperatorRolePrompt } from '../../../prompt-assembly';
import {
  buildPlanContextSection,
  buildWorkItemDossierSections,
  renderUiContextSection,
  withTimeoutBudget,
} from '../../../chat-context-sections';
import { getPromptOverride } from '../../../harness-prompt-overrides';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { buildMemoryContextBlock } from '../../../memory/injection';
import { projectDirForSlug } from '../../../operator-notes';
import { PROJECTED_DEPS } from '../../../projected-tool-deps';
import { readFeatureLockState, rowToChat, type ChatRow, type TranscriptTurn } from '../../../agent-chats-data';
import '../../../agent-tools/index';
import { acquireAgentChatLock, releaseAgentChatLock, type AgentChatLockHandle } from '../../../agent-chat-lock';
import {
  capabilityToolNames,
  capabilityToolset,
  OWNED_LOOP_TOOL_SELECTION,
  type DispatchResult,
  type ToolDispatcher,
} from '../../../agent-loop/capability-toolset';
import { resolveLoopChatModel, runLoopChatTurn } from '../../../agent-loop/chat-engine';
import { classifyLoopModelSpec } from '../../../agent-loop/model-selection';
import { pgLoopSessionStore } from '../../../agent-loop/session-store';
import type { LoopTool } from '../../../agent-loop/loop';
import { MODEL_EFFORT_LEVELS, SURFACE_KEYS, type SurfaceKey } from '../../../agent-config-constants';
import { listPendingLoopApprovals, resolveLoopApproval } from '../../../agent-loop/approval-store';
import { chatModelFailureFields, safeChatFailureTranscriptFields } from '../../../chat-model-failure';
import { taskOpsRoute } from './task-ops';
import { suSessionRoutes } from './su-session';
import externalTurnRoutes from './external-turns';

/**
 * P-008 (own-tui-full-divorce-2026-08-24): doors whose calls route through
 * the HITL approval round-trip when the chat runs on the OWNED loop engine
 * (`engine:'loop'`). Mutating/spawning doors are gated; read-side doors run
 * free — the doors are already confinement-armed, this is interactive
 * policy, not the security boundary.
 */
const LOOP_APPROVAL_GATED_DOORS = new Set([
  'capability:bash',
  'capability:edit',
  'capability:write',
  'capability:git',
  'capability:terminal',
  'capability:launch-agent',
]);

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Per-chat streaming lock — see agent-chat-lock.ts (WI-7139). PG-backed, not a
 * module-scoped Map: :3070 is a 16-worker `node:cluster` release cluster, so an
 * in-memory lock is only effective within ONE of the 16 workers and is
 * defeated by two POSTs for the same chat landing on different ones. A second
 * message POST while a prior one is streaming (on ANY worker) returns 409 —
 * prevents duplicate spawn-and-append races.
 */

/*
 * P-008 (work-item-chat-context-modernize-2026-07-18, D-003/D-004): every
 * best-effort context-injection read races a hard budget so a slow/wedged leg
 * degrades that ONE section, never the chat turn itself. The budget helper and
 * the section builders (UI context, work-item dossier + checkpoint, plan
 * context) now live in lib/chat-context-sections.ts, shared with converse's
 * prompt builder (papercup-chat-one-component-one-contract-2026-09-06 P-005).
 */

/**
 * work-item-chat-context-modernize P-003: resolve `chat.feature_id` to its OWN
 * harness BEFORE keying the dossier/checkpoint/plan-context/lock lookups below.
 * The route's `:slug` is the CHAT's harness — but a cross-harness queue/view
 * (an aggregated inbox spanning multiple harnesses) can open a chat for a work
 * item that actually lives in a DIFFERENT harness. Using `slug` directly for
 * those lookups silently keyed every one of them to the wrong harness for such
 * a chat, so the item's own context never resolved — and failed SILENTLY
 * (empty section, no notice), which is exactly what this fix + the loud-miss
 * notice below address together. `getWorkItem` (no harness arg) resolves an
 * id across every harness in the active workspace; falls back to `slug` when
 * the item can't be resolved (no feature_id, an id that doesn't exist yet, or
 * a lookup failure) so a miss here never blocks the chat.
 */
async function resolveItemHarness(
  slug: string,
  featureId: string | null | undefined,
): Promise<{ harness: string; isLegacyBlueprint: boolean }> {
  let harness = slug;
  if (featureId) {
    try {
      const { getWorkItem } = await import('../../../work-items');
      const wi = await getWorkItem(featureId);
      if (wi?.harness) harness = wi.harness;
    } catch {
      /* best-effort — fall back to the chat's own harness */
    }
  }
  let isLegacyBlueprint = true;
  try {
    const { loadHarnessRegistry } = await import('../../../harness-registry');
    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === harness);
    // A `harness_kind:'hive'` harness runs the Mug/cup pot pipeline, never the
    // legacy per-feature `harness_features.taken_by` worktree-claim + the
    // `.papercusp/notes` mechanics (this is the SAME signal D-001 used to
    // characterize "NOT the legacy 3-phase coding blueprint").
    isLegacyBlueprint = project?.harness_kind !== 'hive';
  } catch {
    /* best-effort — default to legacy-safe (today's unconditional behavior) */
  }
  return { harness, isLegacyBlueprint };
}

/** Per-harness chat cost cap from the effective harness config (blueprint ⊕
 *  workspace-PG instance — `deprecate-harness-config-json-2026-06-06`). */
async function readChatCostCap(slug: string): Promise<{ perChatUsd?: number; aggregateUsd?: number }> {
  try {
    const { loadHarnessRegistry } = require('../../../harness-registry') as typeof import('../../../harness-registry');
    const { activeWorkspaceId } =
      require('../../../workspace-registry') as typeof import('../../../workspace-registry');
    const { readEffectiveHarnessConfig } =
      require('../../../harness-effective-config') as typeof import('../../../harness-effective-config');
    const projectDir = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
    if (!projectDir) return {};
    const cfg = await readEffectiveHarnessConfig(slug, activeWorkspaceId(), projectDir);
    const out: { perChatUsd?: number; aggregateUsd?: number } = {};
    if (typeof cfg.maxChatCostUsd === 'number' && cfg.maxChatCostUsd > 0) out.perChatUsd = cfg.maxChatCostUsd;
    if (typeof cfg.maxAggregateChatCostUsd === 'number' && cfg.maxAggregateChatCostUsd > 0) {
      out.aggregateUsd = cfg.maxAggregateChatCostUsd;
    }
    return out;
  } catch {
    return {};
  }
}

/** Strict-mode lock policy — default false (soft-warn). */
async function readChatLockPolicy(slug: string): Promise<boolean> {
  try {
    const { loadHarnessRegistry } = require('../../../harness-registry') as typeof import('../../../harness-registry');
    const { activeWorkspaceId } =
      require('../../../workspace-registry') as typeof import('../../../workspace-registry');
    const { readEffectiveHarnessConfig } =
      require('../../../harness-effective-config') as typeof import('../../../harness-effective-config');
    const projectDir = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
    if (!projectDir) return false;
    const cfg = await readEffectiveHarnessConfig(slug, activeWorkspaceId(), projectDir);
    const parallelChat = cfg.parallelChat as Record<string, unknown> | undefined;
    return parallelChat?.respectFeatureLocks === true;
  } catch {
    return false;
  }
}

/** Sum of cents across all non-archived chats in this harness. */
async function aggregateChatCostCents(slug: string): Promise<number> {
  try {
    const rows = (await harnessQuery(slug, (sql) =>
      sql.unsafe(
        'SELECT COALESCE(SUM(total_cost_usd_cents), 0)::bigint AS total FROM agent_chats WHERE archived_at IS NULL',
      ),
    )) as Array<{ total: number | bigint }>;
    const total = rows[0]?.total ?? 0;
    return typeof total === 'bigint' ? Number(total) : total;
  } catch {
    return 0;
  }
}

const listChatsRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats',
  auth: 'public',
  async handler(req, ctx) {
    const { listChats } = await import('../../../agent-chats-data');
    const sp = new URL(req.url).searchParams;
    const parseNum = (v: string | null): number | undefined => {
      if (v === null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const result = await listChats({
      slug: ctx.params.slug,
      includeArchived: sp.get('include') === 'archived',
      limit: parseNum(sp.get('limit')),
      offset: parseNum(sp.get('offset')),
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const createChatRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats',
  auth: 'loopback',
  async handler(req, ctx) {
    const { createChat } = await import('../../../agent-chats-data');
    let body: { role?: string; feature_id?: string; title?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    const result = await createChat({
      slug: ctx.params.slug,
      role: body.role ?? '',
      feature_id: body.feature_id,
      title: body.title,
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data, { status: 201 });
  },
});

const getChatRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats/:chatId',
  auth: 'public',
  async handler(_req, ctx) {
    const { getChat } = await import('../../../agent-chats-data');
    const result = await getChat({ slug: ctx.params.slug, chatId: ctx.params.chatId });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const archiveChatRoute = defineTool({
  method: 'DELETE',
  path: '/harness/:slug/agent-chats/:chatId',
  auth: 'loopback',
  async handler(_req, ctx) {
    const { archiveChat } = await import('../../../agent-chats-data');
    const result = await archiveChat({ slug: ctx.params.slug, chatId: ctx.params.chatId });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const renameChatRoute = defineTool({
  method: 'PUT',
  path: '/harness/:slug/agent-chats/:chatId',
  auth: 'loopback',
  async handler(req, ctx) {
    let body: { title?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    const { renameChat } = await import('../../../agent-chats-data');
    const result = await renameChat({
      slug: ctx.params.slug,
      chatId: ctx.params.chatId,
      title: body.title ?? '',
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const continueChatRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats/:chatId/continue',
  auth: 'loopback',
  async handler(req, ctx) {
    let body: { title?: string } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text) as { title?: string };
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    const { continueChat } = await import('../../../agent-chats-data');
    const result = await continueChat({
      slug: ctx.params.slug,
      sourceChatId: ctx.params.chatId,
      title: body.title,
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data, { status: 201 });
  },
});

const messagesRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats/:chatId/messages',
  auth: 'loopback',
  // Pure SSE transport — don't flood route_invocations per chat turn.
  sampleRate: 0,
  async handler(req, ctx) {
    const slug = ctx.params.slug;
    const chatId = ctx.params.chatId;
    let body: {
      content?: string;
      mode?: string;
      engine?: string;
      model?: string;
      effort?: string;
      account?: string;
      surface?: string;
      retryAfterCancel?: unknown;
      context?: unknown;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    const userContent = (body.content ?? '').trim();
    if (!userContent) return Response.json({ error: 'content is required' }, { status: 400 });
    if (body.context !== undefined && typeof body.context !== 'string') {
      return Response.json({ error: 'context must be a string' }, { status: 400 });
    }
    const uiContext = typeof body.context === 'string' ? body.context.trim() : '';
    if (uiContext.length > 4_000) {
      return Response.json({ error: 'context exceeds 4000 characters' }, { status: 400 });
    }
    const effort = body.effort?.trim().toLowerCase();
    if (effort && !(MODEL_EFFORT_LEVELS as readonly string[]).includes(effort)) {
      return Response.json(
        {
          error: `effort must be one of ${MODEL_EFFORT_LEVELS.join('|')}`,
        },
        { status: 400 },
      );
    }
    const account = body.account?.trim();
    if (account && !/^[A-Za-z0-9._-]{1,128}$/.test(account)) {
      return Response.json({ error: 'account contains unsupported characters' }, { status: 400 });
    }
    const requestedSurface = body.surface?.trim();
    if (requestedSurface && !(SURFACE_KEYS as readonly string[]).includes(requestedSurface)) {
      return Response.json({ error: 'surface is not registered' }, { status: 400 });
    }
    const chatSurface = requestedSurface as SurfaceKey | undefined;
    if (body.retryAfterCancel !== undefined && typeof body.retryAfterCancel !== 'boolean') {
      return Response.json({ error: 'retryAfterCancel must be a boolean' }, { status: 400 });
    }
    // P-008: `engine:'loop'` selects the OWNED in-process loop (native session
    // protocol lane); anything else keeps the legacy CLI-spawn engine.
    const useLoopEngine = body.engine === 'loop';
    // Tier menus are shared with the legacy OMP lane, so an explicit picker
    // value may be valid there but unavailable to the in-process loop. Reject
    // that mismatch before acquiring the lock or persisting the user turn.
    const resolvedLoopModel = useLoopEngine
      ? resolveLoopChatModel({
          ...(body.model ? { model: body.model } : {}),
          ...(effort ? { effort } : {}),
        })
      : undefined;
    if (resolvedLoopModel) {
      const capability = classifyLoopModelSpec(resolvedLoopModel);
      if (!capability.executable) {
        return Response.json(
          {
            error: `model ${JSON.stringify(resolvedLoopModel)} cannot run on engine=loop: ${capability.reason}`,
            engine: 'loop',
            model: resolvedLoopModel,
          },
          { status: 400 },
        );
      }
    }

    // Acquire the lock HERE (atomic, cross-worker) rather than only checking —
    // acquiring at the point of the check, not later right before spawn, also
    // closes the intra-process TOCTOU window the old check-then-set-much-later
    // pattern left open (everything between the old check and the old `set`
    // below is async and could interleave two requests on the SAME worker).
    const chatLock: AgentChatLockHandle | null = await acquireAgentChatLock(
      chatId,
      activeWorkspaceId(),
      body.engine === 'loop' && body.retryAfterCancel === true ? { waitMs: 5_000, retryMs: 50 } : {},
    );
    if (!chatLock) {
      return Response.json({ error: 'chat already has an in-flight assistant response' }, { status: 409 });
    }
    // From here on, every return path MUST release chatLock. The whole
    // pre-flight sequence below (load chat, cost caps, feature-lock, persist
    // user turn, assemble prompt) has many early-return branches; rather than
    // thread a release call through each one, it's wrapped in one IIFE that
    // either returns an early Response (caller releases + returns it) or the
    // data the spawn step below needs (caller keeps the lock and proceeds).
    type Preflight =
      | Response
      | {
          chat: ChatRow;
          itemHarness: Awaited<ReturnType<typeof resolveItemHarness>>;
          baseTranscript: TranscriptTurn[];
          projectDir: string;
          /** `text` = full one-shot prompt (legacy CLI-spawn lane); `systemText`
           *  = persona + context sections only — history and the user turn travel
           *  as structured messages on the loop lane (P-008). */
          assembled: { text: string; runId: string; systemText: string };
        };
    const preflight: Preflight = await (async (): Promise<Preflight> => {
      let chat: ChatRow;
      try {
        const rows = (await harnessQuery(slug, (sql) =>
          sql.unsafe('SELECT * FROM agent_chats WHERE id = $1', [chatId]),
        )) as any[];
        const row = rows[0];
        if (!row) return Response.json({ error: 'chat not found' }, { status: 404 });
        chat = rowToChat(row);
        if (chat.archived_at) return Response.json({ error: 'chat is archived' }, { status: 410 });
      } catch (e) {
        return Response.json({ error: `failed to load chat: ${(e as Error).message}` }, { status: 500 });
      }

      // Cost-cap checks — per-chat + aggregate.
      const cap = await readChatCostCap(slug);
      if (cap.perChatUsd !== undefined && chat.total_cost_usd_cents >= cap.perChatUsd * 100) {
        return Response.json(
          {
            error: 'per-chat cost cap reached',
            chat_cost_usd: chat.total_cost_usd_cents / 100,
            cap_usd: cap.perChatUsd,
            hint: 'increase config.json `maxChatCostUsd` or archive this chat',
          },
          { status: 402 },
        );
      }
      if (cap.aggregateUsd !== undefined) {
        const aggCents = await aggregateChatCostCents(slug);
        if (aggCents >= cap.aggregateUsd * 100) {
          return Response.json(
            {
              error: 'aggregate chat cost cap reached for this harness',
              aggregate_cost_usd: aggCents / 100,
              cap_usd: cap.aggregateUsd,
              hint: 'increase config.json `maxAggregateChatCostUsd` or archive other chats',
            },
            { status: 402 },
          );
        }
      }

      // P-003: resolve the item's OWN harness ONCE — `slug` is the chat's/queue-
      // view's harness, which a cross-harness view can differ from.
      const itemHarness = await resolveItemHarness(slug, chat.feature_id);

      // Concurrency awareness — feature-lock state for the prompt notice / strict gate.
      // Keyed to the ITEM's own harness (not `slug`): a legacy per-feature lock only
      // ever lives in ITS OWNING harness's `harness_features` table.
      const featureLock = chat.feature_id ? await readFeatureLockState(itemHarness.harness, chat.feature_id) : null;
      if (featureLock?.active) {
        const respectLocks = await readChatLockPolicy(itemHarness.harness);
        if (respectLocks) {
          const guidance = itemHarness.isLegacyBlueprint
            ? `drop a note via POST /api/harness/${itemHarness.harness}/features/${chat.feature_id}/notes if you want guidance picked up on the next worker tick`
            : `leave a comment on ${chat.feature_id} (\`work_items:comment\`) so whoever picks it up next sees it`;
          return Response.json(
            {
              error: 'feature_locked',
              feature_id: chat.feature_id,
              taken_by: featureLock.taken_by,
              taken_at: featureLock.taken_at,
              expires_at: featureLock.expires_at,
              hint: `Feature is currently being worked on autonomously by ${featureLock.taken_by}. Wait for the lock to release, or ${guidance}. Disable strict mode by removing parallelChat.respectFeatureLocks from .papercusp/config.json.`,
            },
            { status: 409 },
          );
        }
      }

      // A retry after a dropped/preflight-failed stream sees the already-persisted
      // trailing user turn. Reuse it instead of appending the same logical turn a
      // second time; once an assistant follows, identical text is a legitimate new
      // message and is appended normally.
      const trailing = chat.transcript.at(-1);
      const resumesPendingUser = trailing?.role === 'user' && trailing.content === userContent;
      const userTurn: TranscriptTurn = resumesPendingUser
        ? trailing
        : { role: 'user', content: userContent, ts: new Date().toISOString() };
      const baseTranscript = resumesPendingUser ? chat.transcript : [...chat.transcript, userTurn];
      if (!resumesPendingUser) {
        try {
          await harnessQuery(slug, (sql) =>
            sql.unsafe(`UPDATE agent_chats SET transcript = $1::jsonb, updated_at = $2 WHERE id = $3`, [
              JSON.stringify(baseTranscript),
              Date.now(),
              chatId,
            ]),
          );
        } catch (e) {
          return Response.json({ error: `failed to persist user turn: ${(e as Error).message}` }, { status: 500 });
        }
      }

      // Resolve the project dir IN-PROCESS (workspace-aware, live registry)
      // BEFORE assembly. Without it the assembler falls back to its
      // workspace-blind `lookupProjectDir`, which curls the operator base
      // (default :3055 — not an API port) mid-request and then the legacy
      // ~/.restart-harness-projects.json — so any harness that exists only in
      // the live registry fails to assemble (same class as role-launch-spec
      // step 0 / EI-220).
      const projectDir = await projectDirForSlug(slug);
      if (!projectDir) {
        return Response.json(
          {
            error: `harness "${slug}" is not registered in workspace "${activeWorkspaceId()}"`,
          },
          { status: 404 },
        );
      }

      // Assemble the role prompt + transcript history.
      let assembled: { text: string; runId: string; systemText: string };
      try {
        // Workspace-owned prompt override (D-7), best-effort (miss → default).
        let chatOverride: string | undefined;
        try {
          chatOverride = (await getPromptOverride(activeWorkspaceId(), slug, chat.role)) ?? undefined;
        } catch {
          /* fall back to config.json default */
        }
        // The persisted role registry spans TWO prompt stacks. Harness roles
        // (worker/reviewer/...) resolve through the blueprint chain; `operator`
        // is the workspace control-plane persona and canonically lives under
        // apps/operator/prompts. The pui native seam deliberately creates an
        // operator chat (D-016), so sending it through the blueprint-only
        // assembler fails before the stream opens: base has no operator.md.
        // Keep the role intact and select the owning assembler here. Advertise
        // the exact capability:* set the loop will construct below, derived from
        // the same selector rather than a second hard-coded list.
        const rolePrompt =
          chat.role === 'operator'
            ? useLoopEngine
              ? {
                  text: assembleOperatorRolePrompt({
                    role: 'operator',
                    profile: 'pui-loop',
                    projectDir,
                    toolNames: capabilityToolNames(OWNED_LOOP_TOOL_SELECTION),
                  }).text,
                  runId: `${Math.floor(Date.now() / 1000)}-pui-loop${chat.feature_id ? `-${chat.feature_id}` : ''}`,
                }
              : {
                  text: assembleOperatorRolePrompt({
                    role: 'operator',
                    toolNames: capabilityToolNames(OWNED_LOOP_TOOL_SELECTION),
                  }).text,
                  runId: `${Math.floor(Date.now() / 1000)}-operator${chat.feature_id ? `-${chat.feature_id}` : ''}`,
                }
            : (() => {
                const r = assembleHarnessRolePrompt({
                  slug,
                  role: chat.role,
                  projectDir,
                  featureId: chat.feature_id ?? undefined,
                  // 'discuss' (client sends it per message) reframes the worker to
                  // advise-first; anything else is the default interactive chat.
                  mode: body.mode === 'discuss' ? 'discuss' : 'chat',
                  promptOverrideText: chatOverride,
                });
                return { text: r.text, runId: r.meta.runId };
              })();
        const lockNoticeGuidance = itemHarness.isLegacyBlueprint
          ? `add a note (it lands in \`.papercusp/notes/${chat.feature_id}.md\`, which the next worker tick reads)`
          : `leave a comment on ${chat.feature_id} (\`work_items:comment\`) for whoever is working it`;
        const lockNotice = featureLock?.active
          ? `\n---\n\n## ⚠ Concurrent autonomous run\n\nFeature ${chat.feature_id} is currently being worked on autonomously (taken_by=${featureLock.taken_by}, taken_at=${featureLock.taken_at}). The autonomous loop holds the worktree lock; you do not. **Do not propose code changes**; the user is asking you for advice or context. If they want guidance the autonomous worker should pick up, tell them to ${lockNoticeGuidance}.\n`
          : '';
        const historyBlock =
          baseTranscript.length > 1
            ? '\n---\n\n## Conversation history\n\n' +
              baseTranscript
                .slice(0, -1)
                .map((t) => `${t.role === 'user' ? 'User' : 'You (assistant)'}: ${t.content}`)
                .join('\n\n') +
              '\n'
            : '';
        // P-008 (D-003 ground truth): buildMemoryContextBlock previously ran
        // with NO outer budget on this inline chat-reply path — its own
        // internal MEMORY_INJECT_TIMEOUT_MS (5s) bounds each of its 3
        // sequential legs (available/hive-resolve/search) individually, so a
        // cold operator (just-restarted mem0 client) could legitimately stack
        // up to ~15s of sequential waiting, measured live at ~6.7s. Race it
        // against the same 3s budget the dossier pull below uses so a slow
        // recall degrades to "no memory section" instead of stalling the reply.
        const memBlock = await withTimeoutBudget(
          buildMemoryContextBlock({
            userId: null,
            workspaceId: activeWorkspaceId(),
            queryContext: `${chat.role} agent: ${userContent}`,
            heading: 'Agent memory (relevant entries)',
          }),
          3_000,
        );
        const memorySection = memBlock ? `\n---\n\n${memBlock}\n` : '';

        // WI-41425: the hosting surface's UI context — orientation data from a
        // loopback client, never authority (see renderUiContextSection).
        const uiContextBody = renderUiContextSection(uiContext);
        const uiContextSection = uiContextBody ? `\n---\n\n${uiContextBody}\n` : '';

        // Plan context — inject for worker/validator/reviewer roles on
        // plan-derived features. Best-effort; empty on miss.
        const CHAT_PLAN_ROLES = new Set(['worker', 'validator', 'reviewer']);
        let planContextSection = '';
        if (CHAT_PLAN_ROLES.has(chat.role) && chat.feature_id) {
          const planCtx = await buildPlanContextSection({
            harness: itemHarness.harness,
            workItemId: chat.feature_id,
          });
          if (planCtx) planContextSection = `\n---\n\n${planCtx}\n`;
        }

        // Work-item dossier + carry-note (WI-5125) — the SAME precomputed
        // world-state the autonomous cup wakes on, plus the in-flight checkpoint,
        // or the loud-miss notice (P-003) when nothing loaded. Budgeted inside.
        let dossierSection = '';
        if (chat.feature_id) {
          const parts = await buildWorkItemDossierSections({
            workspaceId: activeWorkspaceId(),
            harness: itemHarness.harness,
            workItemId: chat.feature_id,
          });
          dossierSection = parts.map((p) => `\n---\n\n${p}\n`).join('');
        }

        // work-item-chat-context-modernize P-002: the work-item dossier LEADS the task
        // framing — it identifies WHAT this chat is even about — so it is placed
        // immediately after the persona, before the lock notice / plan context /
        // memory / history. Previously it sat last (after planContextSection),
        // effectively an appendix the model could reach only after wading through
        // lock/plan boilerplate for a feature it may not even recognize yet.
        const promptText = `${rolePrompt.text}${dossierSection}${uiContextSection}${lockNotice}${planContextSection}${memorySection}${historyBlock}\n---\n\n## User\n\n${userContent}\n`;
        const systemText = `${rolePrompt.text}${dossierSection}${uiContextSection}${lockNotice}${planContextSection}${memorySection}`;
        assembled = { text: promptText, runId: rolePrompt.runId, systemText };
      } catch (e) {
        return Response.json({ error: `failed to assemble prompt: ${(e as Error).message}` }, { status: 500 });
      }

      return { chat, itemHarness, baseTranscript, projectDir, assembled };
    })();

    if (preflight instanceof Response) {
      await releaseAgentChatLock(chatLock);
      return preflight;
    }
    const { chat, itemHarness, baseTranscript, projectDir, assembled } = preflight;

    // ── P-008: OWNED-loop engine lane (native session protocol) ──────────
    // Shares everything above (lock, cost caps, user-turn persist, prompt
    // assembly) with the legacy lane, then runs `runAgentLoop` IN-PROCESS
    // instead of spawning a CLI agent. Wire events are the LoopEvent
    // vocabulary verbatim (chat-engine.ts). No spawn-tracking here: nothing
    // is spawned — the invocation ledger for loop turns is P-009's sessions
    // store.
    if (useLoopEngine) {
      const workspaceId = activeWorkspaceId();
      const effectiveModel = resolvedLoopModel!;
      const accountRoute = account ?? 'auto';
      const ownedLoopSpawnId = `agent-loop-${chatId}`;
      // The principal-bound execution chokepoint (capability-toolset's seam):
      // every loop tool call rides the SAME dispatcher stack as tools:invoke —
      // role gate, quota, telemetry all apply. Bind the workspace transaction
      // per call (never across the model turn), and use the chat id for both
      // runId and the owned-loop spawn id so tasks:ops resolves this chat's
      // canonical task list.
      const principal = ctx.principal ?? {
        kind: 'loopback' as const,
        slug: 'pui:local',
        workspaceId,
        authMethod: 'host-loopback' as const,
        trust: 'unverified-loopback' as const,
        capabilities: new Set(['*']),
      };
      const dispatch: ToolDispatcher = async (name, args) => {
        const t = lookupByMcpName(name);
        if (!t) return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] };
        const runDispatch = async (tx?: unknown) => {
          const dispatchCtx = {
            workspaceId,
            harnessSlug: itemHarness.harness,
            role: chat.role,
            runId: chatId,
            interactiveCardCapability: true,
            spawnId: ownedLoopSpawnId,
            uiClientId: ctx.principal?.slug ?? 'pui:local',
            isSuperuser: false,
            profile: 'engineer' as const,
            transport: 'http' as const,
            principal,
            ...(tx !== undefined ? { tx } : {}),
            log: () => {
              /* */
            },
            progress: () => {
              /* */
            },
            emit: () => {
              /* */
            },
            signal: req.signal,
            spawn: async () => {
              throw new Error('spawn not available inside the loop engine');
            },
            secret: async () => null,
            projectDir: projectDir ?? '',
            stateDir: '',
          };
          const r = await dispatchProjectedTool(t, name, args, dispatchCtx as never, PROJECTED_DEPS);
          if (!r.ok || !r.result) {
            return {
              isError: true,
              content: [{ type: 'text', text: r.error?.message ?? `dispatch of ${name} failed` }],
            };
          }
          return r.result as DispatchResult;
        };
        return t.needsWorkspaceTx ? withWorkspace(workspaceId, runDispatch) : runDispatch();
      };
      let tools: LoopTool[] = [];
      try {
        tools = capabilityToolset({
          ...OWNED_LOOP_TOOL_SELECTION,
          dispatch,
          needsApproval: (toolName) => LOOP_APPROVAL_GATED_DOORS.has(toolName),
        });
      } catch {
        // An unprovisioned build (no capability doors registered) degrades to
        // a tool-less conversation — same posture as the legacy lane's
        // "silently runs with no attached MCP tools".
        tools = [];
      }

      return sseResponse({
        signal: req.signal,
        setup: async (sink) => {
          // Announce what will ACTUALLY run before the first model event. The
          // client attaches this to the in-flight bubble; the same values are
          // persisted below so a reconnect never rewrites history from today's
          // global picker selection.
          const provenance: Extract<ChatEvent, { type: 'provenance' }> = {
            type: 'provenance',
            engine: 'loop',
            model: effectiveModel,
            accountRoute,
          };
          sink.event('provenance', provenance);
          let result: Awaited<ReturnType<typeof runLoopChatTurn>>;
          try {
            result = await runLoopChatTurn({
              chatId,
              workspaceId,
              system: assembled.systemText,
              transcript: baseTranscript,
              sink,
              model: effectiveModel,
              ...(effort ? { effort } : {}),
              ...(account ? { account } : {}),
              ownerId: ownedLoopSpawnId,
              signal: req.signal,
              // This route is the interactive PUI chat surface. Untiered
              // inference is starved behind fleet work, so keep the admission
              // intent explicit at the route boundary.
              priority: 'interactive',
              tools,
              // P-009: resume from + persist the full ModelMessage session
              // (tool detail survives across turns; usage/cost totals live
              // on harness_shared.agent_loop_sessions).
              sessions: pgLoopSessionStore(),
              deferTerminalEvent: true,
            });
          } finally {
            await releaseAgentChatLock(chatLock);
          }

          const terminalError =
            result.errorMessage ?? (result.finalText.trim() ? null : 'agent loop completed without assistant content');
          if (terminalError) {
            // Persist a failure-marker turn — same contract as the legacy
            // lane: a reload / second viewer must not see a silent gap.
            const failureTurn: TranscriptTurn = {
              role: 'assistant',
              ...safeChatFailureTranscriptFields(terminalError),
              ts: new Date().toISOString(),
              engine: 'loop',
              model: effectiveModel,
              account_route: accountRoute,
              tokens_in: result.tokensIn,
              tokens_out: result.tokensOut,
              cost_cents: Math.round(result.costUsd * 100),
              ...(result.servedAccount ? { account_served: result.servedAccount } : {}),
            };
            try {
              await harnessQuery(slug, (sql) =>
                sql.unsafe(`UPDATE agent_chats SET transcript = $1::jsonb, updated_at = $2 WHERE id = $3`, [
                  JSON.stringify([...baseTranscript, failureTurn]),
                  Date.now(),
                  chatId,
                ]),
              );
            } catch {
              /* best-effort — still emit the terminal error below */
            }
            sink.event('error', { type: 'error', message: terminalError, ...chatModelFailureFields(terminalError) });
            sink.close();
            return;
          }

          const assistantTurn: TranscriptTurn = {
            role: 'assistant',
            content: result.finalText,
            ts: new Date().toISOString(),
            engine: 'loop',
            model: effectiveModel,
            account_route: accountRoute,
            tokens_in: result.tokensIn,
            tokens_out: result.tokensOut,
            cost_cents: Math.round(result.costUsd * 100),
            ...(result.servedAccount ? { account_served: result.servedAccount } : {}),
          };
          try {
            await harnessQuery(slug, (sql) =>
              sql.unsafe(
                `UPDATE agent_chats
                 SET transcript = $1::jsonb,
                     total_input_tokens = total_input_tokens + $2,
                     total_output_tokens = total_output_tokens + $3,
                     total_cost_usd_cents = total_cost_usd_cents + $4,
                     updated_at = $5
               WHERE id = $6`,
                [
                  JSON.stringify([...baseTranscript, assistantTurn]),
                  result.tokensIn,
                  result.tokensOut,
                  assistantTurn.cost_cents ?? 0,
                  Date.now(),
                  chatId,
                ],
              ),
            );
          } catch (e) {
            sink.event('error', {
              type: 'error',
              message: `failed to persist assistant turn: ${(e as Error).message}`,
            });
            sink.close();
            return;
          }
          // Terminal success is emitted only AFTER the assistant transcript is
          // durable. A reconnect on `done` can therefore read the same turn.
          sink.event('done', {
            type: 'done',
            stopReason: result.stopReason ?? 'complete',
            finalText: result.finalText,
            usage: {
              inputTokens: result.tokensIn,
              outputTokens: result.tokensOut,
              costUsd: result.costUsd,
            },
            stepCount: result.stepCount,
            ...(result.servedAccount ? { servedAccount: result.servedAccount } : {}),
          });
          sink.close();
        },
      });
    }
    // ── legacy CLI-spawn engine lane ─────────────────────────────────────

    const tool = lookupByMcpName('agent_chats:chat');
    if (!tool) {
      await releaseAgentChatLock(chatLock);
      return Response.json({ error: 'agent_chats:chat tool not registered' }, { status: 500 });
    }

    // EI-259: a chat turn is a real agent invocation — track it in the durable
    // nursery (harness_shared.spawned_agents) like every other spawn path, so
    // it shows in fleet:tree / intel:spawn_tree and counts a provider slot.
    // Best-effort: tracking failure never blocks the chat (null ⇒ untracked).
    const { beginChatSpawnTracking, resolveChatRunOutcome } = await import('../../../fleet/chat-spawn-tracking');
    const spawnTracking = await beginChatSpawnTracking({
      chatId,
      workspaceId: activeWorkspaceId(),
      harnessSlug: slug,
      childRole: chat.role,
      runId: assembled.runId,
      featureId: chat.feature_id ?? null,
      projectDir,
    });

    return sseResponse({
      signal: req.signal,
      setup: async (sink) => {
        let assistantText = '';
        let tokensIn = 0;
        let tokensOut = 0;
        let costUsd = 0;
        let unreportedFrames = 0;
        let lastErrorMessage: string | null = null;
        let lastErrorStderr: string | undefined;
        let toolError: { code: string; message: string } | null = null;
        let sawDone = false;
        let threwMessage: string | null = null;

        try {
          const dispatchCtx = {
            workspaceId: activeWorkspaceId(),
            harnessSlug: slug,
            role: 'operator' as const,
            runId: assembled.runId,
            interactiveCardCapability: true,
            spawnId: spawnTracking?.spawnId ?? `agent_chats-${chatId}`,
            log: () => {
              /* */
            },
            progress: () => {
              /* */
            },
            emit: () => {
              /* overridden by dispatcher */
            },
            signal: req.signal,
            spawn: async () => {
              throw new Error('spawn not available in agent_chats shim');
            },
            secret: async () => null,
            projectDir: projectDir ?? '',
            stateDir: '',
          };

          for await (const ev of dispatchProjectedToolStream(
            tool,
            'agent_chats:chat',
            // P-004: `harness` scopes + attaches the read-mostly agentmcp
            // surface (work_items:get/list, plans:get, docs:search,
            // memory:search — mcp-config.ts) to the item's OWN harness
            // (itemHarness.harness, per P-003 scoping — NOT the cross-harness
            // queue-view `slug`). Best-effort on the tool side: an
            // unprovisioned build silently runs with no attached MCP tools.
            {
              promptText: assembled.text,
              cwd: projectDir ?? undefined,
              harness: itemHarness.harness,
              ...(chatSurface ? { surface: chatSurface } : {}),
            },
            dispatchCtx as never,
            {},
          )) {
            if (ev.kind === 'event') {
              if (ev.name === 'delta') {
                const text = (ev.data as { text?: string })?.text ?? '';
                assistantText += text;
                sink.event('delta', { text });
              } else if (ev.name === 'tool_call') {
                const d = ev.data as { name?: string; input?: unknown };
                if (d.name) sink.event('tool_call', { name: d.name, input: d.input });
              } else if (ev.name === 'error') {
                const d = ev.data as { message?: string; stderr?: string };
                lastErrorMessage = d.message ?? 'unknown error';
                lastErrorStderr = d.stderr;
              }
            } else if (ev.kind === 'done') {
              sawDone = true;
              try {
                const blob = ev.result?.content?.[0];
                if (blob && 'text' in blob && typeof blob.text === 'string') {
                  const parsed = JSON.parse(blob.text) as {
                    finalText?: string;
                    tokensIn?: number;
                    tokensOut?: number;
                    costUsd?: number;
                    unreportedFrames?: number;
                  };
                  if (parsed.finalText && parsed.finalText.length > assistantText.length) {
                    assistantText = parsed.finalText;
                  }
                  if (typeof parsed.tokensIn === 'number' && Number.isFinite(parsed.tokensIn))
                    tokensIn = parsed.tokensIn;
                  if (typeof parsed.tokensOut === 'number' && Number.isFinite(parsed.tokensOut))
                    tokensOut = parsed.tokensOut;
                  if (typeof parsed.costUsd === 'number' && Number.isFinite(parsed.costUsd)) costUsd = parsed.costUsd;
                  if (
                    typeof parsed.unreportedFrames === 'number' &&
                    Number.isSafeInteger(parsed.unreportedFrames) &&
                    parsed.unreportedFrames > 0
                  ) {
                    unreportedFrames += parsed.unreportedFrames;
                  }
                }
              } catch {
                /* malformed tool result — keep what we accumulated */
              }
            } else if (ev.kind === 'error') {
              toolError = ev.error;
            }
          }
        } catch (e) {
          threwMessage = e instanceof Error ? e.message : String(e);
          throw e;
        } finally {
          await releaseAgentChatLock(chatLock);
          if (spawnTracking) {
            const outcome = resolveChatRunOutcome({
              sawDone,
              toolErrorMessage: toolError?.message ?? null,
              lastErrorMessage,
              threwMessage,
              aborted: req.signal.aborted,
            });
            await spawnTracking.finish({
              ...outcome,
              outputTail: assistantText ? assistantText.slice(-400) : null,
            });
          }
        }

        // A turn that failed (rate-limit, backend/dispatch error) persists a
        // failure-marker assistant turn — otherwise the transcript keeps only the
        // user turn and a reload / second viewer sees a silent gap. The live
        // sender ALSO gets the inline error event below. Best-effort: a persist
        // failure must not swallow the error signal itself.
        const failureMessage = toolError?.message ?? lastErrorMessage;
        if (failureMessage) {
          const failureTurn: TranscriptTurn = {
            role: 'assistant',
            ...safeChatFailureTranscriptFields(failureMessage),
            ts: new Date().toISOString(),
            tokens_in: 0,
            tokens_out: 0,
            cost_cents: 0,
          };
          try {
            await harnessQuery(slug, (sql) =>
              sql.unsafe(`UPDATE agent_chats SET transcript = $1::jsonb, updated_at = $2 WHERE id = $3`, [
                JSON.stringify([...baseTranscript, failureTurn]),
                Date.now(),
                chatId,
              ]),
            );
          } catch {
            /* best-effort — still emit the error event */
          }
          sink.event('error', {
            message: failureMessage,
            // WI-10003494: a stable code for an actionable model-account failure
            // (usage cap / sign-in / rate limit) so the portal can say WHY without
            // forwarding this prose.
            ...chatModelFailureFields(failureMessage),
            ...(lastErrorStderr ? { stderr: lastErrorStderr } : {}),
          });
          sink.close();
          return;
        }

        const finalAssistantTurn: TranscriptTurn = {
          role: 'assistant',
          content: assistantText,
          ts: new Date().toISOString(),
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_cents: Math.round(costUsd * 100),
          ...(unreportedFrames > 0 ? { unreportedFrames } : {}),
        };
        const finalTranscript = [...baseTranscript, finalAssistantTurn];

        try {
          await harnessQuery(slug, (sql) =>
            sql.unsafe(
              `UPDATE agent_chats
               SET transcript = $1::jsonb,
                   total_input_tokens = total_input_tokens + $2,
                   total_output_tokens = total_output_tokens + $3,
                   total_cost_usd_cents = total_cost_usd_cents + $4,
                   updated_at = $5
             WHERE id = $6`,
              [
                JSON.stringify(finalTranscript),
                tokensIn,
                tokensOut,
                finalAssistantTurn.cost_cents ?? 0,
                Date.now(),
                chatId,
              ],
            ),
          );
        } catch (e) {
          sink.event('error', { message: `failed to persist assistant turn: ${(e as Error).message}` });
          sink.close();
          return;
        }

        sink.event('done', {
          run_id: assembled.runId,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_cents: finalAssistantTurn.cost_cents,
          ...(unreportedFrames > 0 ? { unreportedFrames } : {}),
        });
        sink.close();
      },
    });
  },
});

/**
 * P-008: pending HITL approvals for a loop-engine chat — a (re)connecting
 * client re-hydrates its approval cards from this instead of relying on
 * having seen the `tool_call` SSE event live.
 */
const listApprovalsRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats/:chatId/approvals',
  auth: 'public',
  async handler(_req, ctx) {
    try {
      const approvals = await listPendingLoopApprovals({
        chatId: ctx.params.chatId,
        workspaceId: activeWorkspaceId(),
      });
      return Response.json({ approvals });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  },
});

/**
 * P-008: resolve one pending approval (the client's answer to a gated
 * `tool_call`). Cluster-correct by construction: the decision lands in PG
 * (approval-store), which the loop-holding worker is polling — this POST
 * may be served by ANY of the 16 workers.
 */
const resolveApprovalRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats/:chatId/approvals/:callId',
  auth: 'loopback',
  async handler(req, ctx) {
    let body: { approved?: boolean; reason?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    if (typeof body.approved !== 'boolean') {
      return Response.json({ error: '`approved` (boolean) is required' }, { status: 400 });
    }
    try {
      const resolved = await resolveLoopApproval({
        chatId: ctx.params.chatId,
        callId: ctx.params.callId,
        workspaceId: activeWorkspaceId(),
        approved: body.approved,
        ...(body.reason ? { reason: body.reason } : {}),
        resolvedBy: 'agent-chats:approvals-route',
      });
      if (!resolved) {
        return Response.json(
          { error: 'no pending approval for this call (already resolved, timed out, or unknown)' },
          { status: 404 },
        );
      }
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  },
});

export default [
  listChatsRoute,
  createChatRoute,
  getChatRoute,
  renameChatRoute,
  archiveChatRoute,
  continueChatRoute,
  taskOpsRoute,
  messagesRoute,
  listApprovalsRoute,
  resolveApprovalRoute,
  ...externalTurnRoutes,
  ...suSessionRoutes,
];
