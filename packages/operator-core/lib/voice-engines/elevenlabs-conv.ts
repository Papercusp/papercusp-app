/**
 * ElevenLabs Conversational AI engine.
 *
 * Primary `fullAgentEngine` for v5+. Replaces the existing stub at
 * lib/voice-engines/elevenlabs-mse.ts (TTS-only) for the conversational path.
 *
 * Architecture (see /docs/agents/action-registry §0, §8):
 *   browser ── WebRTC ──> ElevenLabs Conv AI agent (Claude Haiku via BYO LLM)
 *      ▲                       │
 *      │ clientTools (in-page)  │ webhook tools (server-side)
 *      ▼                       ▼
 *   Action Registry         /api/elevenlabs/webhook/*
 *
 * Reflexive commands (browser:'required') are emitted as **client-side
 * tools** — when the agent calls them, the SDK invokes our handler in
 * the browser, we run runCommand() locally, return the result. Sub-100ms.
 *
 * Server-side webhook commands are configured at agent-creation time on the
 * EL dashboard. Those don't go through this client; the agent talks to our
 * server directly.
 *
 * This module only handles the in-page audio + clientTools loop.
 */

import { Conversation, type VoiceConversation } from '@elevenlabs/client';
import { wsLocalKey } from '../browser-workspace';
import { runCommand, runQuery, list } from '../commands/registry';
import type { CommandContext, Definition } from '../commands/types';
import { OPERATOR_PERSONA_PROMPT } from '../operator-persona';
import { OPERATOR_CONVERSE_PROMPT } from '../operator-converse-prompt';
import { readOperatorModeFromSession } from '../operator-converse-tags';
import { eligibleBeats } from '../op-backstory-bank';
import { backstoryEligibleNow, recentlyFiredIds } from '../op-backstory-state';
import '../commands/defs';

interface StartArgs {
  agentId: string;
  conversationToken: string;
  workspace: string;
  tabId: string;
  onTranscript?: (text: string) => void;
  onAssistantText?: (text: string) => void;
  onError?: (err: Error) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export interface ElevenLabsHandle {
  endSession(): Promise<void>;
  getStatus(): 'connecting' | 'connected' | 'disconnected' | 'unknown';
  getConversationId(): string | null;
  sendSystem(text: string): void;
}

export async function startElevenLabsConv(args: StartArgs): Promise<ElevenLabsHandle> {
  if (typeof window === 'undefined') throw new Error('elevenlabs-conv must run in browser');

  // Resume any suspended AudioContexts before opening the session.
  // Chrome suspends contexts created without a user-gesture handler;
  // EL's WebRTC pipeline plays the first_message via an audio element
  // that inherits the suspended state and stays silent. The user
  // *did* gesture (they clicked the voice button to get here), so
  // resume succeeds. Idempotent — running on already-running contexts
  // is a no-op.
  await resumeAllAudioContexts().catch(() => { /* best-effort */ });

  // Pre-warm the microphone so Chrome has the device open + permission
  // re-confirmed BEFORE EL's SDK calls setMicrophoneEnabled(true). When
  // the operator's React tree is heavy, Chrome's first getUserMedia call
  // can take >1s; by then LiveKit's internal LocalTrackSubscribed
  // timeout has fired ("could not find local track publication after
  // timeout") and the negotiation enters a reconnect loop. Pre-warming
  // makes EL's subsequent getUserMedia near-instant since the device is
  // already opened.
  //
  // We hold the stream until EL takes over, then close it so EL's track
  // is the sole publisher. Chrome reuses the underlying device handle
  // when EL re-acquires it within the same gesture window.
  // Throw the prewarm error directly — EL's downstream error tends to be
  // less specific ("Requested device not found" even when the real cause
  // is "permission denied/dismissed"), and continuing past a known-bad
  // mic state guarantees the user waits through ICE timeouts only to
  // see a misleading toast.
  let prewarmStream: MediaStream | null = null;
  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
    try {
      prewarmStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (e) {
      const m = (e as Error)?.message ?? String(e);
      const name = (e as Error)?.name ?? '';
      console.warn('[elevenlabs-conv] mic prewarm failed:', name, m);
      if (/NotAllowed|Permission|denied|dismiss/i.test(name + ' ' + m)) {
        throw new Error(
          `Microphone permission required. Click the voice button again and choose "Allow" in the browser prompt, ` +
          `or if you previously dismissed it: click the lock/site-info icon in the address bar → Microphone → Allow → reload.`,
        );
      }
      if (/NotFound|device/i.test(name + ' ' + m)) {
        throw new Error(
          `Microphone unavailable: ${m}. No working audio input is visible to the browser. ` +
          `Check OS sound settings; on Linux verify pipewire/pulse is running and the device is unmuted.`,
        );
      }
      throw new Error(`Microphone setup failed: ${m}`);
    }
  }

  // Build the clientTools map from registry. Only browser:'required' commands
  // and queries are eligible — server-side commands are wired as webhook tools
  // on the EL dashboard.
  //
  // `endSession` is set after conv is created (forward-declared) so the
  // end_conversation tool can call it. We accept the indirection because
  // end_conversation is rare and the closure cost is one var lookup.
   
  let convRef: { endSession: () => Promise<void> } | null = null;
  const clientTools = buildClientTools({
    workspace: args.workspace,
    tabId: args.tabId,
    endSession: async () => {
      // Defer 500ms so the EL receives our tool ack before disconnect.
      await new Promise((r) => setTimeout(r, 500));
      try { await convRef?.endSession(); } catch { /* tearing down anyway */ }
    },
  });

  // Build the session-start prompt — but skip the three preflight
  // fetches entirely if we're in bareMode (their output gets discarded
  // below) or if a full-agent engine isn't going to consume them.
  // In dev mode each Next route compiles cold (~5-10s), so saving
  // three sequential fetches drops connect time from ~25s to ~5s.
  // Run the three in parallel — they share no dependencies.
  const url = typeof window !== 'undefined' ? new URL(window.location.href) : null;
  const bareMode = url?.searchParams.get('elBare') === '1';
  // Shell mode: EL is the voice transport, the local omp brain answers via
  // ask_operator. The dashboard prompt is operator.shell.md (set by
  // el-agent-sync.mjs) and we deliberately do NOT inject persona/converse —
  // those live in the local brain's prompt. To run EL with its own LLM,
  // set localStorage.harnessElShellMode = '0'.
  const shellMode =
    typeof window !== 'undefined'
      ? window.localStorage.getItem(wsLocalKey('harnessElShellMode')) !== '0'
      : true;
  let sessionsContext = '';
  if (!bareMode && !shellMode) {
    const [delegatesBlock, personaName, backstoryBlock] = await Promise.all([
      fetchDelegatesBlock(args.workspace),
      fetchUserName().catch(() => null),
      buildBackstoryBlock(),
    ]);
    const namedPersona = personaName
      ? OPERATOR_PERSONA_PROMPT.replace(/\{name\}/g, personaName)
      : OPERATOR_PERSONA_PROMPT;
    // When in active mode, also inject the converse prompt so the
    // voice agent runs the continuous turn-taking loop with the same
    // <say>/<set_mode>/<sleep> tag contract the text path uses.
    // Passive mode keeps the existing persona-only prompt — operator
    // only responds when spoken to, no proactive utterances.
    const operatorMode = readOperatorModeFromSession() ?? 'active';
    const conversePrompt = operatorMode === 'active' ? OPERATOR_CONVERSE_PROMPT : '';
    sessionsContext = [namedPersona, conversePrompt, delegatesBlock, backstoryBlock]
      .filter((s) => s && s.trim().length)
      .join('\n\n---\n\n');
  }

  // Try once with overrides; retry without if signaling fails. Agents
  // that haven't enabled "Override prompt" in their dashboard Security
  // settings reject the override at LiveKit signaling time, surfacing
  // as "could not establish signal connection: <reason>". Retrying
  // without overrides keeps voice working at the cost of skipping the
  // dynamic delegates context until the user enables overrides.
  // LiveKit reports immediate-disconnect-after-connect on negotiation
  // failure WITHOUT calling onError — we have to detect it from the
  // disconnect timing and reason. Track when connect fired so we can
  // tell a real disconnect from a 2ms-later "fake" connect that
  // immediately failed.
  let connectedAt = 0;
  const baseSessionOpts = {
    conversationToken: args.conversationToken,
    connectionType: 'webrtc' as const,
    textOnly: false,
    clientTools,
    onConnect: () => {
      // Only record the FIRST connect — the EL SDK fires onConnect again
      // on reconnection during the lifecycle. Without this, a normal
      // close-after-30s gets reported as "disconnected 7ms after connect"
      // because the most recent reconnect event is the one we measured
      // against. Real negotiation failures fail fast and never reconnect.
      if (connectedAt === 0) connectedAt = Date.now();
      // Force-play any audio elements EL appended to document.body —
      // Chrome's autoplay policy can block them if the resume-on-gesture
      // window already lapsed by the time the remote track arrives.
      // .play() returns a promise that may reject (e.g. when already
      // playing); swallow it. Re-runs every connect, idempotent.
      const tryPlay = () => {
        document.querySelectorAll<HTMLAudioElement>('audio').forEach((a) => {
          if (a.paused) { void a.play().catch(() => { /* fine */ }); }
        });
      };
      tryPlay();
      // EL attaches the agent track AFTER onConnect on some networks —
      // retry once after the next macrotask + once more shortly after.
      setTimeout(tryPlay, 200);
      setTimeout(tryPlay, 1500);
      args.onConnect?.();
    },
    onDisconnect: (details?: any) => {
      const aliveMs = connectedAt > 0 ? Date.now() - connectedAt : 0;
      const reason = details?.reason ?? details?.context?.reason ?? '(no reason)';
      // If we disconnect within 5s of connecting, that's the LiveKit
      // negotiation-failure pattern: brief flicker of "connected" then
      // ICE deadline expires. Surface this through onError so the
      // existing NegotiationError handler in voice-mode fires the
      // network-issue toast + tears down the session.
      if (connectedAt > 0 && aliveMs < 5000) {
        args.onError?.(new Error(
          `negotiation timed out — disconnect ${aliveMs}ms after connect (reason: ${reason})`,
        ));
      }
      args.onDisconnect?.();
    },
    onMessage: ({ message, source }: { message: string; source: 'user' | 'ai' }) => {
      if (source === 'user') args.onTranscript?.(message);
      else if (source === 'ai') args.onAssistantText?.(message);
    },
    onError: (msg: string) => { args.onError?.(new Error(msg)); },
  };

  // Read the agent-language pin from voice prefs. Default 'en' stops
  // EL's STT auto-detect from flipping when background music or
  // ambient noise has speech-like spectral features (the user-reported
  // "operator switched to Spanish while music was playing" failure).
  // Users who want auto-detect can clear the pref via /settings/voice.
  let agentLanguage = '';
  try {
    const prefsRes = await fetch('/api/agent-mcp/operator-voice-prefs');
    if (prefsRes.ok) {
      const prefs = await prefsRes.json() as { agentLanguage?: string };
      if (typeof prefs?.agentLanguage === 'string') {
        agentLanguage = prefs.agentLanguage.trim();
      }
    }
  } catch { /* default to empty → no pin */ }

  // Build the overrides payload. Prompt + language merge into one
  // `agent` object; null branches stay absent so EL doesn't see
  // unintended overrides.
  let overridePayload: { agent: Record<string, unknown> } | undefined;
  const agentOverride: Record<string, unknown> = {};
  if (sessionsContext.length) {
    agentOverride.prompt = { prompt: sessionsContext };
  }
  if (agentLanguage) {
    agentOverride.language = agentLanguage;
  }
  if (Object.keys(agentOverride).length > 0) {
    overridePayload = { agent: agentOverride };
  }

  let conv: VoiceConversation;
  // Diagnostic toggle: ?elBare=1 in the URL strips clientTools + overrides
  // (and the persona-build fetches above) to isolate whether they're
  // causing the agent to hang up at connect.
  if (bareMode) {
    console.log('[el-conv] BARE MODE — skipping clientTools + overrides for diagnostic');
  }

  const tryStart = async (withOverrides: boolean): Promise<VoiceConversation> => {
    const opts: any = { ...baseSessionOpts };
    if (bareMode) {
      // Strip everything optional. Just enough to open a session.
      opts.clientTools = {};
    }
    if (withOverrides && overridePayload && !bareMode) {
      opts.overrides = overridePayload;
    }
    return (await Conversation.startSession(opts)) as VoiceConversation;
  };

  // Release the prewarm stream RIGHT BEFORE EL's startSession runs so
  // Chrome sees the device as immediately available. Holding it during
  // EL's getUserMedia would force Chrome to clone the track and slow
  // things down; releasing it leaves the device "warm" without a
  // competing consumer.
  const releasePrewarm = () => {
    if (prewarmStream) {
      try { prewarmStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      prewarmStream = null;
    }
  };

  try {
    releasePrewarm();
    conv = await tryStart(true);
  } catch (err: unknown) {
    releasePrewarm();
    const msg = (err as Error)?.message ?? String(err);
    const looksLikeSignalingFailure = /signal connection|signaling|server unreachable|override/i.test(msg);
    const looksLikeDeviceError = /requested device not found|notfounderror|notallowederror|permission denied|no audio|microphone|getUserMedia/i.test(msg);
    // \bice\b prevents "device" from matching the "ice" alternation.
    const looksLikeNegotiation = !looksLikeDeviceError && /negotiation|negotiate|\bice\b|peerconnection|pc connection/i.test(msg);

    // Override-rejection: retry without overrides (agent dashboard
    // hasn't enabled "Override prompt"). Lose the dynamic context,
    // keep the session.
    if (overridePayload && looksLikeSignalingFailure) {
      console.warn('[elevenlabs-conv] signaling failed with overrides; retrying without:', msg);
      try {
        conv = await tryStart(false);
        args.onError?.(new Error(
          'Connected without prompt context. Enable "Override prompt" in your ElevenLabs agent Security settings to restore the delegates context.',
        ));
      } catch (err2: unknown) {
        throw new Error(`signaling failed (after retry without overrides): ${(err2 as Error)?.message ?? String(err2)}`);
      }
    }
    // Microphone error: no device, permission denied, or stale deviceId.
    // Don't retry — getUserMedia errors won't fix themselves and the
    // misleading "negotiation timed out twice" message used to fire here
    // because "device" contains the substring "ice".
    if (looksLikeDeviceError) {
      // Enumerate what the browser actually sees so the toast can pin
      // down whether it's "no devices at all" vs "permission" vs
      // "specific deviceId stale". Permission state is the most useful
      // single signal.
      let perm: string | undefined;
      let inputCount = -1;
      let labels = '';
      try {
        const p = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        perm = p.state;
      } catch { /* Firefox lacks permissions.query for mic */ }
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const inputs = devs.filter(d => d.kind === 'audioinput');
        inputCount = inputs.length;
        // Labels are empty strings until permission is granted — that
        // alone diagnoses "permission never granted" vs "no devices".
        labels = inputs.map(d => d.label || '(unlabelled)').join(', ').slice(0, 200);
      } catch { /* enumerate can fail in obscure contexts */ }
      const ctx = `[perm=${perm ?? 'unknown'} inputs=${inputCount}${inputCount > 0 ? ` (${labels})` : ''}]`;
      console.warn('[elevenlabs-conv] device-error context:', ctx, msg);
      throw new Error(
        `Microphone unavailable: ${msg}. ${ctx} ` +
        (perm === 'denied' ? 'Mic permission is DENIED — click the lock icon → Site settings → Microphone → Allow, then reload.'
          : inputCount === 0 ? 'No audio input devices visible to the browser. Check OS sound settings; on Linux verify pipewire/pulse is running.'
          : !labels.trim() || /^\(unlabelled\)/.test(labels) ? 'Devices exist but labels are blank — permission was never granted in this site. Click the lock icon → Microphone → Allow, then reload.'
          : 'Devices exist and permission looks granted — try reloading the page; if it persists, the EL/LiveKit cache may reference a removed device.'),
      );
    }
    // WebRTC negotiation timeout: usually a network/firewall blocking
    // UDP egress to LiveKit. A fresh session sometimes picks different
    // ICE candidates and succeeds — retry once with a short delay
    // before giving up.
    else if (looksLikeNegotiation) {
      console.warn('[elevenlabs-conv] WebRTC negotiation timed out; one retry after 1.5s:', msg);
      await new Promise((r) => setTimeout(r, 1500));
      try {
        conv = await tryStart(true);
      } catch (err2: unknown) {
        const inner = (err2 as Error)?.message ?? String(err2);
        throw new Error(
          `WebRTC negotiation timed out twice. This is almost always a network/firewall blocking UDP egress to LiveKit (the EL media transport). ` +
          `Check: VPN, corporate firewall, or try a different network. Inner: ${inner}`,
        );
      }
    }
    else {
      throw new Error(`signaling failed: ${msg}`);
    }
  }

  // Link the live session into the end_conversation tool closure so the
  // agent can tear down via tools.end_conversation. Forward-declared
  // up top because buildClientTools runs before conv exists.
  convRef = { endSession: async () => { await conv.endSession(); } };

  return {
    async endSession() { await conv.endSession(); },
    getStatus() {
      try {
        return (conv as any).getStatus?.() ?? 'unknown';
      } catch { return 'unknown'; }
    },
    getConversationId() {
      try {
        return (conv as any).getId?.() ?? null;
      } catch { return null; }
    },
    /**
     * Send a system-style contextual update into the live conversation.
     * The EL SDK queues this until end-of-turn, so it never interrupts
     * the user mid-sentence. Used by the async delegate path: when a
     * long delegate finishes, we surface the result this way so the
     * agent can speak about it on its next turn instead of having
     * already returned an empty "looking into that" hours ago.
     */
    sendSystem(text: string) {
      try {
        (conv as any).sendContextualUpdate?.(text);
      } catch (e) {
        console.warn('[el-conv] sendContextualUpdate failed:', e);
      }
    },
  };
}

/**
 * Build the registry-derived clientTools map. EL Conv AI clientTools are
 * in-page: { [name]: (params) => result }. Each entry runs the matching
 * registry command/query and returns the result as a string (EL accepts
 * string | number | void).
 *
 * We expose only browser:'required' commands as client-side tools — the
 * rest were configured as webhook tools on the EL dashboard during agent
 * setup, and the agent calls our server directly for those.
 */
// Exported for unit-test coverage (plan voice-production-test-coverage P-004:
// reflexive client-tool dispatch). The sole production caller is
// startElevenLabsConv above.
export function buildClientTools(opts: {
  workspace: string;
  tabId: string;
  endSession: () => Promise<void>;
}): Record<string, (parameters: any) => Promise<string>> {
  const tools: Record<string, (parameters: any) => Promise<string>> = {};

  // end_conversation — agent ends session after a definitive answer in
  // hybrid / single-utterance mode. The agent prompt branches on the
  // dynamic_variable voice_mode and decides when to call us. We ack
  // EL with "ok" and tear down the session 500ms later so the result
  // lands before the LiveKit connection closes.
  tools.end_conversation = async () => {
    void opts.endSession();
    return JSON.stringify({ ok: true });
  };
  const ctx = (): CommandContext => ({
    agent: 'operator',
    workspace: opts.workspace,
    sessionId: opts.tabId,
    requestId: `el-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  });

  // Reflexive commands: browser:'required' tier-reflexive
  const commands = list({ kind: 'command', agent: 'operator', browser: ['required'] });
  for (const def of commands) {
    tools[normalizeToolName(def.id)] = async (params: any) => {
      const result = await runCommand(def.id, params, ctx());
      return JSON.stringify(result);
    };
  }

  // Queries — voice's fast-query surface. Always client-side for speed.
  const queries = list({ kind: 'query', agent: 'operator' });
  for (const def of queries) {
    tools[normalizeToolName(def.id)] = async (params: any) => {
      const result = await runQuery(def.id, params, ctx());
      return JSON.stringify(result);
    };
  }

  // The brain delegate. EL's own LLM is the transport shell; the actual
  // operator reply is generated by our local omp + Claude Max stack via
  // /api/agent-mcp/operator-converse. EL is told (in its system prompt)
  // to call this for every user turn and speak the returned text verbatim.
  tools.ask_operator = async (params: any) => askOperatorViaSse(params);

  return tools;
}

/**
 * Calls the local /api/agent-mcp/operator-converse SSE route, drains the
 * stream, parses tags, and returns the `<say>` body. EL receives this
 * string and speaks it via TTS.
 *
 * Errors return a fallback line — never throw, because EL would surface
 * the failure as a verbatim error to the user. A graceful "I had trouble
 * just then" is far better.
 */
// Exported for unit-test coverage (plan §4.9 / §6.5 voice path).
// Voice clients reach this via clientTools.ask_operator — that thin
// wrapper at line ~465 is the only production caller.
export async function askOperatorViaSse(params: { text?: string; trigger?: string }): Promise<string> {
  const userText = (params?.text ?? '').toString().trim();
  const trigger = typeof params?.trigger === 'string' ? params.trigger : null;
  // No user text + no explicit trigger = nothing to do.
  if (!userText && !trigger) return '';
  // EL agent forwards { trigger: 'open_canvas' | 'user_says_ready' |
  // 'quiet_wait_resume' } per the shell prompt. After the 2026-05-14
  // silence-redesign, the silence nudge is emitted directly by the
  // provider via /silence-nudge — no voice path generates a silence
  // trigger anymore. Stale EL agent configs that still emit
  // silence_* collapse to user_message.
  const VALID_TRIGGERS = new Set([
    'user_message',
    'quiet_wait_resume',
    'open_canvas',
    'user_says_ready',
  ]);
  // Legacy mapping: silence_* triggers retired; collapse to
  // user_message so a stale EL config doesn't 500.
  let effectiveTrigger: string =
    trigger === 'silence_nudge' || trigger === 'silence_check' || trigger === 'silence_after_question'
      ? 'user_message'
      : (trigger ?? 'user_message');
  if (!VALID_TRIGGERS.has(effectiveTrigger)) effectiveTrigger = 'user_message';
  // Voice/text unification: pre-fetch the recent PG history so the
  // operator brain has the same context whether the user is typing
  // or speaking. Without this, voice turns get a stateless brain
  // (each ask_operator looks like a fresh conversation) while text
  // turns get the full local-state history. Both paths now hit PG
  // for the same conversation row.
  //
  // HISTORY_LIMIT mirrors the route's HISTORY_KEEP (30) — fetching
  // more is wasted because the route slices it anyway. One loopback
  // round-trip, ~5-10ms; negligible vs the LLM call.
  const HISTORY_LIMIT = 30;
  const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
  try {
    const hRes = await fetch(`/api/operator/conversations?limit=${HISTORY_LIMIT}`);
    if (hRes.ok) {
      const h = await hRes.json() as {
        turns: Array<{ role: 'user' | 'assistant' | 'system'; text: string }>;
      };
      for (const t of h.turns) {
        if (t.role !== 'user' && t.role !== 'assistant' && t.role !== 'system') continue;
        if (typeof t.text !== 'string' || !t.text.trim()) continue;
        messages.push({ role: t.role, content: t.text });
      }
    }
  } catch { /* fall through to single-turn behavior */ }
  // Append the current user turn last UNLESS the history already
  // includes it (the parallel persistOperatorVoiceTurn write might
  // have landed before our GET). Tail-only check — sufficient for
  // the realistic race window.
  if (userText) {
    const tail = messages[messages.length - 1];
    const alreadyThere =
      tail && tail.role === 'user' && tail.content.trim() === userText;
    if (!alreadyThere) {
      messages.push({ role: 'user', content: userText });
    }
  }
  try {
    const res = await fetch('/api/agent-mcp/operator-converse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        trigger: effectiveTrigger,
        mayAskActive: false,
        // EL is the voice surface — declare the voice modality so the route
        // forwards voice-card state-snapshots on this SSE stream (its
        // `body.modality === 'voice'` gate) and the brain gets the voice
        // modality. Without this the card-forward described below never fires.
        modality: 'voice',
      }),
    });
    if (!res.ok || !res.body) {
      console.warn('[el-conv:ask_operator] SSE init failed', res.status);
      return 'I had trouble just then — say that again?';
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let assembled = '';
    // Voice cards (plan §6.3): when a tool calls ctx.askUser during this
    // voice turn, the state-channel forwards a state-snapshot event on
    // the same SSE stream (operator-converse route subscribes the sink
    // to subscribeWorkspace). We collect fallbackText per card so we
    // can append it to the spoken response — the user still has to
    // submit via the chat surface (voice can't yet send a card-response
    // payload structured enough to validate against dataSchema). Today
    // chat:ask_choice is modality:['text'] so it's filtered out before
    // reaching voice; this path is for future voice-capable card tools.
    const voiceCards: Array<{ correlationId: string; fallbackText: string; prompt: string }> = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const evt = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        // Parse the event name (typed-events lines: 'event: <name>')
        // so we can branch on state-snapshot vs delta.
        let eventName: string | null = null;
        let dataLine: string | null = null;
        for (const line of evt.split('\n')) {
          if (line.startsWith('event: ')) eventName = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataLine = line.slice(6);
        }
        if (!dataLine) continue;
        try {
          const payload = JSON.parse(dataLine);
          if (eventName === 'state-snapshot') {
            // Snapshot shape: { runId, version, snapshot: { openCards, toolState? } }
            const openCards = payload?.snapshot?.openCards;
            if (Array.isArray(openCards)) {
              for (const c of openCards) {
                if (!c || typeof c.correlationId !== 'string') continue;
                if (voiceCards.some((seen) => seen.correlationId === c.correlationId)) continue;
                const fallback = typeof c.fallbackText === 'string' ? c.fallbackText : '';
                const prompt = typeof c.prompt === 'string' ? c.prompt : '';
                if (!fallback && !prompt) continue;
                voiceCards.push({
                  correlationId: c.correlationId,
                  fallbackText: fallback,
                  prompt,
                });
              }
            }
          } else if (typeof payload?.text === 'string') {
            // delta path (text-streaming).
            assembled += payload.text;
          }
        } catch { /* ignore non-JSON */ }
      }
    }
    const sayMatch = assembled.match(/<say(?:\s[^>]*)?>([\s\S]*?)<\/say>/i);
    // Phase 4 T3.1 sanitizer: when the brain returns a non-empty
    // assembled but NO `<say>` tag, the consumer's TTS speaks the
    // raw text including any `<set_mode>` / `<spawn>` / `<sleep>`
    // tags literally. Warn-log so this regression class doesn't
    // ship silently — the brain's voice-mode prompt should ALWAYS
    // wrap voice turns in `<say>…</say>` per the persona contract.
    if (!sayMatch && assembled.trim().length > 0) {
      console.warn(
        '[el-conv:ask_operator] voice turn returned without <say> tag; the raw body will be spoken via TTS:',
        assembled.trim().slice(0, 200),
      );
    }
    let out = (sayMatch ? sayMatch[1] : assembled).trim();
    // If any voice-visible card appeared this turn, append its fallbackText
    // (or prompt) to the spoken response so the TTS reads it. Appended
    // AFTER the <say> extraction so the card prompt isn't stripped along
    // with stray non-say content. The user still has to click through on
    // the chat surface — voice acknowledgement is just "here's what was
    // asked." Idempotent across cards (deduped at collection time).
    if (voiceCards.length > 0) {
      const cardLines = voiceCards
        .map((c) => c.fallbackText || c.prompt)
        .filter((s) => s.length > 0);
      if (cardLines.length > 0) {
        out += (out.length > 0 ? ' ' : '') + cardLines.join(' ');
      }
    }
    return out || '...';
  } catch (err) {
    console.warn('[el-conv:ask_operator]', err);
    return 'I had trouble just then — say that again?';
  }
}

/**
 * EL Conv AI tool names must match the agent's configured tools exactly.
 * Our registry IDs use dotted notation (`panel.toggle`); EL is case
 * sensitive but tolerant of dots. We pass through unchanged for now;
 * if EL refuses dots we'll rewrite to underscores here.
 */
/**
 * EL agent tool names are simple identifiers (no dots). Registry ids
 * use dotted namespacing ("panel.toggle"). Normalize to match what the
 * agent dashboard expects — el-agent-sync.mjs uses the same mapping.
 */
function normalizeToolName(id: string): string {
  return id.replace(/[.-]/g, '_');
}

/**
 * Build the JSON catalog of clientTools we want to sync to the EL agent.
 * Used by an admin endpoint that PUTs the tool list to the agent platform
 * during PR 1's setup phase. Each entry is the agent-config shape EL expects.
 */
export function buildClientToolCatalog(): Array<{
  name: string;
  description: string;
  parameters: unknown;
  expects_response: boolean;
}> {
  const out: Array<{ name: string; description: string; parameters: unknown; expects_response: boolean }> = [];
  const eligible: Definition[] = [
    ...list({ kind: 'command', agent: 'operator', browser: ['required'] }),
    ...list({ kind: 'query', agent: 'operator' }),
  ];
  for (const def of eligible) {
    out.push({
      name: normalizeToolName(def.id),
      description: def.promptDescription ?? def.description,
      parameters: zodToJsonSchemaFor(def.schema),
      expects_response: true,
    });
  }
  return out;
}

// Lazy import to avoid pulling zod-to-json-schema on the hot voice path.
function zodToJsonSchemaFor(_schema: unknown): unknown {
  // Plumbed via the elevenlabs-shim sync endpoint, not at session start.
  return {};
}

/** Build the voice routing context. Delegate launch was retired 2026-06-21. */
async function fetchDelegatesBlock(_workspace: string): Promise<string | null> {
  return [
    'You are the Operator — the low-latency voice front-end.',
    'Your reflexive tools (panel toggle, navigate, scan, approve, across-workspaces) execute UI actions instantly.',
    'The old delegate_to_claude/delegate_to_agent tools are retired. Do not ask for or start delegate sessions.',
    'For work beyond your reflexive tools, use ask_operator when available or tell the user the request needs the operator panel/full agent session.',
  ].join('\n');
}

/**
 * Pull the user's display name from /api/profile so the persona can
 * substitute {name}. Best-effort — null on any error.
 */
async function fetchUserName(): Promise<string | null> {
  try {
    const r = await fetch('/api/profile');
    if (!r.ok) return null;
    const profile = (await r.json()) as { display_name?: string; email?: string };
    const dn = profile.display_name?.trim();
    if (dn) return dn;
    // Fall back to the local-part of the email if no display name.
    const email = profile.email?.trim();
    if (email && email.includes('@')) return email.split('@')[0];
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the eligible-backstory-beats block for the EL session-start
 * prompt. Per /docs/agents/operator-persona §7c:
 *   - Returns null if user disabled backstory in voice prefs
 *   - Returns null if rate-limit (3/session, 30min cooldown) is tripped
 *   - Otherwise returns up to 3 eligible beats with the "you may
 *     reference one if it fits naturally" framing
 *
 * Trigger context here is intentionally weak — at session start we
 * don't know what op is about to happen. We include beats whose
 * triggers are session-state based (firstSession, sessionAgeMin) and
 * a small stable subset; runtime-triggered beats aren't reachable
 * from this seam, but session-bounded ones are exactly the right
 * shape for "may reference at most once or twice this session".
 */
async function buildBackstoryBlock(): Promise<string | null> {
  try {
    const r = await fetch('/api/agent-mcp/operator-voice-prefs');
    if (!r.ok) return null;
    const prefs = (await r.json()) as { operatorBackstoryEnabled?: boolean };
    if (prefs.operatorBackstoryEnabled === false) return null;
  } catch {
    /* default-on */
  }

  if (!backstoryEligibleNow()) return null;

  const recent = recentlyFiredIds();
  const ctx = { firstSession: false, sessionAgeMin: 0 };
  const eligible = eligibleBeats(ctx, ['default', 'sober'], recent).slice(0, 3);
  if (!eligible.length) return null;

  const lines = eligible.map((b) => `  [${b.id}] "${b.story}"`);
  return [
    'Optional past experiences. You may reference at most one of these',
    "this session if it fits naturally — never force it. Most utterances",
    'should skip them. No "this reminds me of" preamble; just say it.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Resume any AudioContext that the browser has suspended for autoplay
 * policy. We can't enumerate them globally — there's no API for that —
 * but we can:
 *   1. Create a fresh probe context. If it's suspended, the browser
 *      requires a gesture to unlock. If we got here via voice-button
 *      click, the gesture is present and resume() succeeds.
 *   2. Play a silent buffer on it to fully unblock subsequent contexts.
 *
 * This unblocks the EL SDK's internal context too — Chrome unlocks
 * audio at the document level once any context resumes after a gesture.
 */
async function resumeAllAudioContexts(): Promise<void> {
  if (typeof window === 'undefined') return;
  const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return;
  const probe = new Ctx();
  try {
    if (probe.state === 'suspended') await probe.resume();
    // Play an empty buffer to clinch the unlock — some Chrome versions
    // need actual playback to flip from "running" to fully unblocked.
    const buf = probe.createBuffer(1, 1, 22050);
    const src = probe.createBufferSource();
    src.buffer = buf;
    src.connect(probe.destination);
    src.start(0);
  } finally {
    // Close on a microtask; immediate close interrupts the start().
    setTimeout(() => { try { void probe.close(); } catch { /* ignore */ } }, 100);
  }
}
