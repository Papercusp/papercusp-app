/**
 * POST /api/agent-mcp/operator-converse — SSE stream of operator's next turn.
 * Thin shim into the operator:converse tool; resolves session user from
 * cookies (the one HTTP-only step), budget pre-flight, forwards the rest.
 * Ported from app/api/agent-mcp/operator-converse/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { sseResponse } from '@papercusp/sse';
import {
  dispatchProjectedToolStream,
  emitToSseSink,
  lookupByMcpName,
  subscribeWorkspace,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import '../../../agent-tools/index';
import { activeWorkspaceId } from '../../../workspace-registry';
import { checkBudget, shouldBypassOperatorBudget } from '../../../operator-budget';
import { getConversationById } from '../../../operator-conversations';
import { UI_CONTEXT_MAX_CHARS } from '../../../chat-context-sections';
import { defineTool } from '@papercusp/agent-mcp';

interface ConverseRequestBody {
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  trigger?:
    | 'user_message'
    | 'quiet_wait_resume'
    | 'open_canvas'
    | 'user_says_ready'
    | 'user_welcomed'
    | 'continue'
    | 'sentinel_scan';
  welcomed_user?: { display_name?: string };
  mayAskActive?: boolean;
  modality?: 'voice' | 'text';
  /** Rendering surface: 'desktop' (default) vs 'tui' (the pui terminal
   *  workbench). Forwarded to operator:converse so it injects per-surface
   *  affordances (tui-operator-surface D-003). */
  surface?: 'desktop' | 'tui';
  uiClientId?: string;
  conversationId?: string;
  isAutoFire?: boolean;
  /** Which persona the brain assumes — the Sentinel-as-Herald re-home seam.
   *  Defaults to 'operator' (backward-compatible). 'sentinel' resolves the
   *  `papercup:converse` tool alias (same handler, loads the Herald persona). */
  role?: string;
  /** Host trust (papercup-chat-one-component-one-contract-2026-09-06 P-005,
   *  D-007 §2). This route is loopback-only, so the CALLER is a trusted host
   *  process: the desktop / TUI omit it (⇒ 'owner', byte-identical legacy);
   *  the portal host proxy asserts 'public' for a turn it forwards from
   *  behind its per-user boundary. Asserting 'public' only ever REMOVES
   *  privilege (no superuser mount, no workspace-internal prompt sections). */
  hostTrust?: 'owner' | 'public';
  /** The per-user boundary's bearer for a public turn — the ONLY credential
   *  a public brain's MCP mount may carry (never the disk superuser token).
   *  Without it a public turn runs tool-less. */
  principalToken?: string;
  /** The hosting surface's current UI context (orientation data, never
   *  authority) — the agent-chats seam's `body.context`. Capped at
   *  UI_CONTEXT_MAX_CHARS; longer is a 400. */
  uiContext?: string;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-converse',
  auth: 'loopback',
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  // The watchdog times only the handler's PRE-FLIGHT (json/budget/auth — the
  // SSE Response returns before streaming starts; route-stack clears the timer
  // in its `finally` the moment that Response comes back, so it never bounds
  // the stream itself), but under PG contention those awaits can queue past a
  // fixed budget and 408 a healthy voice turn (observed live 2026-06-07: brain
  // route died at $0.00 spend in an op-S13 run while the box was loaded).
  // EI-110's own residual note: bumping to a bigger fixed number (this was
  // `120`) just moves the same false-408 to a worse PG storm — it doesn't
  // remove it. `null` is the structural fix already used by every other
  // pre-flight-then-stream SSE route in this tree (zero-harness/sse.ts,
  // flags/stream.ts, coord/inbox-sse.ts, harness/clobber-stream.ts,
  // deploy/frame-view.ts, operator/state-snapshot.ts, the agent-tools/plugins
  // catchalls) — this route is exactly that shape and was the one left behind
  // on a magic number. The brain's own caps govern the stream.
  timeoutSec: null,
  async handler(req) {
    let body: ConverseRequestBody = {};
    try {
      body = (await req.json()) as ConverseRequestBody;
    } catch {
      return new Response('invalid JSON body', { status: 400 });
    }

    // P-005 (D-007 §2): host trust + the public boundary's bearer + the
    // surface's UI context. Validated here, applied by operator:converse
    // (toolset + MCP mount) and buildOperatorPrompt (which sections render).
    if (body.hostTrust !== undefined && body.hostTrust !== 'owner' && body.hostTrust !== 'public') {
      return Response.json({ error: "hostTrust must be 'owner' or 'public'" }, { status: 400 });
    }
    const hostTrust: 'owner' | 'public' = body.hostTrust === 'public' ? 'public' : 'owner';
    if (body.uiContext !== undefined && typeof body.uiContext !== 'string') {
      return Response.json({ error: 'uiContext must be a string' }, { status: 400 });
    }
    if (typeof body.uiContext === 'string' && body.uiContext.length > UI_CONTEXT_MAX_CHARS) {
      return Response.json(
        { error: `uiContext exceeds ${UI_CONTEXT_MAX_CHARS} chars` },
        { status: 400 },
      );
    }
    const principalToken =
      typeof body.principalToken === 'string' && body.principalToken.trim()
        ? body.principalToken.trim()
        : undefined;

    const budget = shouldBypassOperatorBudget(body.uiClientId) ? null : await checkBudget();
    if (budget?.state && budget.exceeded) {
      return new Response(
        `Papercup daily budget reached (${budget.todaySpendUsd.toFixed(2)} of ${budget.capUsd}). Raise the cap in /settings/operator or wait until tomorrow.`,
        { status: 402 },
      );
    }

    let sessionUser: { id: string; username: string; display_name: string; has_password: boolean } | null = null;
    try {
      const { getSessionUserOrDefault } = await import('../../../auth');
      sessionUser = await getSessionUserOrDefault(req.headers);
    } catch (err) {
      console.warn('[operator-converse] session user resolution failed:', (err as Error).message);
    }

    // Sentinel-as-Herald re-home seam: resolve `${role}:converse`. Default
    // 'operator' is byte-identical to before; 'sentinel' resolves the
    // papercup:converse alias (same handler, Herald persona). An unknown role
    // falls back to operator:converse so a stray value can't 500 a live turn.
    //
    // P-012 (text parity): an EXPLICIT body.role wins (P-006). When the caller
    // didn't set one, fall back to the `humanFacingRole` voice pref so the
    // Sentinel repoint is consistent with the voice + device paths. Default
    // remains 'operator' (pref unset/'operator' → byte-for-byte unchanged).
    let role = typeof body.role === 'string' && body.role.trim() ? body.role.trim() : '';
    if (!role) {
      try {
        const { loadVoicePrefs } = await import('../../../voice-prefs');
        const prefs = await loadVoicePrefs();
        // 'sentinel' is the pre-rename pref value (WI-2932) — accepted, resolves
        // to the canonical 'papercup' role id.
        role = prefs.humanFacingRole === 'papercup' ? 'papercup' : 'operator';
      } catch {
        role = 'operator';
      }
    }
    // The papercup persona brain is registered under `papercup:converse`
    // (sentinel-converse.ts); every other role resolves `${role}:converse`.
    // A stale explicit 'sentinel' still routes there during the expand phase.
    const converseToolName = role === 'papercup' ? 'papercup:converse' : `${role}:converse`;
    const operatorConverseTool = lookupByMcpName(converseToolName) ?? lookupByMcpName('operator:converse');
    if (!operatorConverseTool) {
      return new Response(`${converseToolName} tool not registered`, { status: 500 });
    }

    const ctrl = new AbortController();
    const workspaceId = activeWorkspaceId();

    // An explicit id is a fail-closed target, not a hint. Validate it inside
    // the request's workspace before starting an expensive stream; prompt
    // assembly then re-resolves its subject from this canonical row rather
    // than accepting work-item metadata from the browser.
    if (body.conversationId !== undefined) {
      const requestedId = body.conversationId.trim();
      if (!requestedId) {
        return Response.json({ error: 'conversationId must be non-empty' }, { status: 400 });
      }
      const conversation = await getConversationById(requestedId, workspaceId);
      if (!conversation) {
        return Response.json(
          { error: 'conversation not found in the active workspace' },
          { status: 404 },
        );
      }
      body.conversationId = conversation.id;
    }

    return sseResponse({
      signal: req.signal,
      setup: async (sink) => {
        sink.onClose(() => ctrl.abort());

        // WI-5023: expose this turn's own card-correlator runId up front, on
        // every modality. Purely additive (a new event name; nothing existing
        // changes) and scoped to THIS request's own id — it does not forward
        // any card/state data itself, so it cannot leak another conversation's
        // cards. It lets a caller that wants to observe cards in TEXT mode
        // (production text UI already does this over its own separate
        // GET /operator/state-snapshot subscription; the llm-testing harness
        // needs the same runId to scope that subscription to its own turn)
        // correlate without widening what THIS stream forwards.
        const runId = globalThis.crypto.randomUUID();
        sink.event('run-meta', { runId });

        let offStateChannel: (() => void) | null = null;
        // Owner text chat already consumes the workspace-wide
        // /operator/state-snapshot stream directly. Public text chat cannot:
        // its portal proxy owns one upstream converse SSE and projects the
        // safe card subset from that stream. Forward cards here for public
        // trust too, or a nested chat:ask_choice registers and blocks while
        // the portal has no channel on which to see or answer it.
        if (body.modality === 'voice' || body.hostTrust === 'public') {
          offStateChannel = subscribeWorkspace(workspaceId, (vs) => {
            if (sink.closed) return;
            const hasVoiceCard = vs.snapshot.openCards?.some(
              (c) => typeof c.fallbackText === 'string' && c.fallbackText.length > 0,
            );
            if (!hasVoiceCard) return;
            sink.event('state-snapshot', vs);
          });
          sink.onClose(offStateChannel);
        }

        if (body.conversationId && body.uiClientId) {
          const { recordChainEvent } = await import('../../../operator-continue-chains');
          if (body.trigger === 'continue') {
            void recordChainEvent({
              conversationId: body.conversationId,
              uiClientId: body.uiClientId,
              trigger: 'continue',
            });
          } else if (body.trigger === 'user_says_ready' && body.isAutoFire) {
            void recordChainEvent({
              conversationId: body.conversationId,
              uiClientId: body.uiClientId,
              trigger: 'auto_fire_terminal',
            });
          } else if (body.trigger === 'user_message') {
            void recordChainEvent({
              conversationId: body.conversationId,
              uiClientId: body.uiClientId,
              trigger: 'reset',
            });
          }
        }

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
          runId,
          interactiveCardCapability: true,
          spawnId: globalThis.crypto.randomUUID(),
          transport: 'in_process',
          uiClientId: body.uiClientId ?? null,
        };

        let totalCost = 0;
        let unreportedFrames = 0;
        try {
          for await (const ev of dispatchProjectedToolStream(
            operatorConverseTool,
            converseToolName,
            {
              messages: body.messages ?? [],
              trigger: body.trigger,
              welcomedUser: body.welcomed_user,
              mayAskActive: body.mayAskActive,
              modality: body.modality,
              surface: body.surface,
              uiClientId: body.uiClientId,
              // Enables rolling-summary context + the post-turn compaction
              // pass (operator-context-compaction-2026-06-05).
              conversationId: body.conversationId,
              // Sentinel-as-Herald re-home seam: forward the persona role so the
              // prompt builder loads the matching persona set ('operator' default).
              role,
              sessionUser,
              // P-005 (D-007 §2): trust-keyed toolset / mount / prompt sections.
              hostTrust,
              principalToken,
              uiContext: body.uiContext,
            },
            ctxBase,
            {},
          )) {
            if (ctrl.signal.aborted) break;
            if (ev.kind === 'event') {
              emitToSseSink(sink, operatorConverseTool, ev.name, ev.data);
            } else if (ev.kind === 'done') {
              try {
                const text = (ev.result.content[0] as { text?: string })?.text ?? '{}';
                const out = JSON.parse(text) as { totalCost?: number; assembled?: string; unreportedFrames?: number };
                if (typeof out.totalCost === 'number' && Number.isFinite(out.totalCost)) totalCost = out.totalCost;
                if (typeof out.unreportedFrames === 'number' && Number.isSafeInteger(out.unreportedFrames) && out.unreportedFrames > 0) {
                  unreportedFrames += out.unreportedFrames;
                }
              } catch (e) {
                console.warn('[operator-converse] tool result parse failed:', e);
              }
            } else if (ev.kind === 'error') {
              if (!ctrl.signal.aborted) sink.event('error', { message: ev.error.message });
              sink.close();
              return;
            }
          }
          sink.done({ costUsd: totalCost, ...(unreportedFrames > 0 ? { unreportedFrames } : {}) });
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
