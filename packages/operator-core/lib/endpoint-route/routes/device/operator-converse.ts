/**
 * Device bridge to the SHARED operator conversation —
 * mobile-apps-revival-redesign-2026-06-05 (D-002).
 *
 *   GET  /device/operator/conversation              device JWT
 *   GET  /device/operator/conversation/turns        device JWT
 *   POST /device/operator/converse                   device JWT  (SSE)
 *
 * The phone's Operator tab is a real chat thread on the SAME conversation
 * the desktop + TUI use — one `operator_conversations` row per workspace
 * (workspace-scoped, never per-harness). The converse route is the
 * server-side equivalent of what the desktop UI does by hand: load
 * history → persist the user turn → run operator:converse (streaming the
 * deltas + tool_calls to the phone) → persist the assembled assistant
 * turn. That keeps the three surfaces in lock-step: a turn typed on the
 * phone shows up on the desktop and vice-versa.
 *
 * The conversation is keyed to the ACTIVE workspace (getOrCreate uses
 * activeWorkspaceId) — that is the whole point of a *shared* thread. A
 * paired device's JWT carries the workspace it paired into; on the
 * single-active-workspace desktop these coincide. The device JWT gate is
 * the access control.
 */
import { sseResponse } from '@papercusp/sse';
import {
  dispatchProjectedToolStream,
  emitToSseSink,
  lookupByMcpName,
  defineTool,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import '../../../agent-tools/index';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  getOrCreateActiveConversation,
  appendTurn,
  listTurnsRecent,
  type TurnRole,
} from '../../../operator-conversations';
import { parseOperatorTurn } from '../../../operator-converse-tags';
import { notifySyncInvalidate } from '../../../sync-sse';

/** How many recent turns to feed the brain as context for a phone turn. */
const HISTORY_CONTEXT_TURNS = 24;

/**
 * GET /device/operator/conversation?limit=N — the active conversation +
 * its most-recent turns, for the phone's Operator tab on first load.
 */
const conversationRead = defineTool({
  method: 'GET',
  path: '/device/operator/conversation',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req) {
    const conversation = await getOrCreateActiveConversation();
    const limitRaw = new URL(req.url).searchParams.get('limit');
    const limit = Math.max(1, Math.min(Number(limitRaw) || 50, 500));
    const page = await listTurnsRecent({ conversationId: conversation.id, limit });
    return Response.json({
      conversation,
      turns: page.turns,
      hasMoreEarlier: page.hasMoreEarlier,
    });
  },
});

/**
 * GET /device/operator/conversation/turns?conversationId=&beforeSeq=&limit=
 * — cursor-paginated earlier turns for infinite scroll. The phone holds a
 * device JWT (no cookie), so it cannot use the cookie-auth
 * /operator/conversations/:id/turns route; this is its device-gated twin.
 */
const conversationTurns = defineTool({
  method: 'GET',
  path: '/device/operator/conversation/turns',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req) {
    const url = new URL(req.url);
    const conversationId = url.searchParams.get('conversationId');
    if (!conversationId) {
      return Response.json({ error: 'missing conversationId' }, { status: 400 });
    }
    const beforeRaw = url.searchParams.get('beforeSeq');
    const beforeSeq = beforeRaw === null || beforeRaw === '' ? null : Number(beforeRaw);
    if (beforeSeq !== null && (!Number.isFinite(beforeSeq) || beforeSeq < 0)) {
      return Response.json({ error: 'beforeSeq must be a non-negative integer' }, { status: 400 });
    }
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 500));
    const page = await listTurnsRecent({ conversationId, beforeSeq, limit });
    return Response.json(page);
  },
});

interface ConverseBody {
  text?: string;
  modality?: 'voice' | 'text';
  trigger?: 'user_message' | 'continue';
}

/**
 * POST /device/operator/converse — SSE stream of the operator's next turn
 * for a phone-typed (or phone-spoken) message. Self-contained: persists
 * the user turn, runs operator:converse, streams `delta`/`tool_call`
 * events to the phone, then persists the assembled assistant turn so the
 * shared thread stays consistent across surfaces.
 */
const converse = defineTool({
  method: 'POST',
  path: '/device/operator/converse',
  auth: DEVICE_AUTH,
  cors: true,
  // SSE — one route-stack run per long-lived connection (see the
  // /agent-mcp/operator-converse rationale). Don't sample telemetry.
  sampleRate: 0,
  async handler(req, ctx) {
    const principal = devicePrincipal(ctx);
    let body: ConverseBody = {};
    try {
      body = (await req.json()) as ConverseBody;
    } catch {
      return new Response('invalid JSON body', { status: 400 });
    }
    const text = (body.text ?? '').toString();
    if (!text.trim() && body.trigger !== 'continue') {
      return new Response('text required', { status: 400 });
    }
    const modality = body.modality === 'voice' ? 'voice' : 'text';

    // P-012 (device/mobile parity): repoint the brain to the Papercup persona
    // when the `humanFacingRole` voice pref says so — same toggle the voice +
    // text paths read. Default 'operator' keeps the live mobile path unchanged.
    // 'sentinel' is the pre-rename pref value (WI-2932) — accepted, resolves to
    // the canonical 'papercup' role id.
    let role = 'operator';
    try {
      const { loadVoicePrefs } = await import('../../../voice-prefs');
      const prefs = await loadVoicePrefs();
      if (prefs.humanFacingRole === 'papercup') role = 'papercup';
    } catch {
      /* best-effort; fall back to operator */
    }
    // The papercup persona brain is registered under `papercup:converse`
    // (sentinel-converse.ts); every other role resolves `${role}:converse`.
    // A stale explicit 'sentinel' still routes there during the expand phase.
    const converseToolName = role === 'papercup' ? 'papercup:converse' : `${role}:converse`;
    const operatorConverseTool = lookupByMcpName(converseToolName) ?? lookupByMcpName('operator:converse');
    if (!operatorConverseTool) {
      return new Response(`${converseToolName} tool not registered`, { status: 500 });
    }

    const conversation = await getOrCreateActiveConversation();
    const workspaceId = activeWorkspaceId();

    // Build the brain's context from the shared thread's recent turns,
    // then persist this phone turn so it is part of that same history.
    const recent = await listTurnsRecent({
      conversationId: conversation.id,
      limit: HISTORY_CONTEXT_TURNS,
    });
    const messages = recent.turns
      .filter((t) => t.text.trim().length > 0)
      .map((t) => ({ role: t.role as TurnRole, content: t.text }));

    if (text.trim()) {
      try {
        const userTurn = await appendTurn({
          conversationId: conversation.id,
          role: 'user',
          text,
          source: modality === 'voice' ? 'voice_stt' : 'text_typed',
        });
        messages.push({ role: 'user', content: text });
        void notifySyncInvalidate('operatorTurns.page', {
          conversationId: conversation.id,
        }).catch(() => {});
        void userTurn;
      } catch (e) {
        console.warn('[device/converse] user turn persist failed:', (e as Error)?.message ?? e);
      }
    }

    const sessionUser = principal.label
      ? {
          id: principal.slug,
          username: principal.label,
          display_name: principal.label,
          has_password: false,
        }
      : null;

    const ctrl = new AbortController();
    return sseResponse({
      signal: req.signal,
      setup: async (sink) => {
        sink.onClose(() => ctrl.abort());

        const ctxBase: UnifiedToolContext = {
          log: (msg) => {
            console.log(`[${converseToolName}][tool] ${msg}`);
          },
          signal: ctrl.signal,
          progress: () => {},
          emit: () => {
            /* installed by dispatchProjectedToolStream */
          },
          workspaceId,
          role,
          runId: globalThis.crypto.randomUUID(),
          spawnId: globalThis.crypto.randomUUID(),
          transport: 'in_process',
          uiClientId: null,
        };

        let assembled = '';
        let totalCost = 0;
        let unreportedFrames = 0;
        try {
          for await (const ev of dispatchProjectedToolStream(
            operatorConverseTool,
            converseToolName,
            {
              messages,
              trigger: body.trigger ?? 'user_message',
              modality,
              sessionUser,
              // P-012: forward the persona role so the prompt builder loads the
              // matching persona set ('operator' default).
              role,
              // Rolling-summary context + post-turn compaction
              // (operator-context-compaction-2026-06-05).
              conversationId: conversation.id,
            },
            ctxBase,
            {},
          )) {
            if (ctrl.signal.aborted) break;
            if (ev.kind === 'event') {
              emitToSseSink(sink, operatorConverseTool, ev.name, ev.data);
            } else if (ev.kind === 'done') {
              try {
                const t = (ev.result.content[0] as { text?: string })?.text ?? '{}';
                const out = JSON.parse(t) as { totalCost?: number; assembled?: string; unreportedFrames?: number };
                if (typeof out.totalCost === 'number' && Number.isFinite(out.totalCost)) totalCost = out.totalCost;
                if (typeof out.assembled === 'string') assembled = out.assembled;
                if (typeof out.unreportedFrames === 'number' && Number.isSafeInteger(out.unreportedFrames) && out.unreportedFrames > 0) {
                  unreportedFrames += out.unreportedFrames;
                }
              } catch (e) {
                console.warn('[device/converse] tool result parse failed:', e);
              }
            } else if (ev.kind === 'error') {
              if (!ctrl.signal.aborted) sink.event('error', { message: ev.error.message });
              sink.close();
              return;
            }
          }

          // Persist the assistant turn into the shared thread so the
          // desktop + TUI see the phone's exchange too. Parse the tag
          // protocol first — the desktop persists `parsed.say` (clean
          // prose) + `parsed.report`, never the raw assembled turn, and
          // every reader of the shared thread renders `text` verbatim.
          // Persisting `assembled` here leaked literal `<say>…</say>`
          // markup into the desktop transcript.
          const parsed = parseOperatorTurn(assembled);
          if (parsed.say || parsed.report) {
            try {
              await appendTurn({
                conversationId: conversation.id,
                role: 'assistant',
                text: parsed.say ?? '',
                source: modality === 'voice' ? 'voice_tts' : 'text_typed',
                report: parsed.report,
              });
              void notifySyncInvalidate('operatorTurns.page', {
                conversationId: conversation.id,
              }).catch(() => {});
            } catch (e) {
              console.warn('[device/converse] assistant turn persist failed:', (e as Error)?.message ?? e);
            }
          }

          sink.done({ costUsd: totalCost, conversationId: conversation.id, ...(unreportedFrames > 0 ? { unreportedFrames } : {}) });
        } catch (err) {
          if (!ctrl.signal.aborted) {
            sink.event('error', { message: err instanceof Error ? err.message : String(err) });
          }
          sink.close();
        }
      },
    });
  },
});

export default [conversationRead, conversationTurns, converse];
