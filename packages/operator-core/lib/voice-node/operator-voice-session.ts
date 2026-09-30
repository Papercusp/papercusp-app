/**
 * Operator voice session host — ONE shared ElevenLabs/operator session, owned by
 * the voice service, that desktop + tui both attach to as full clients (plan
 * universal-voice-interface-2026-06-05, P-002/P-003/P-004/P-006/P-007).
 *
 * The host (this module, running in the operator sidecar) owns the single EL
 * WebSocket: it mints the signed URL, connects, and:
 *   • FAN-OUT (P-003): broadcasts input transcript + response audio/transcript/
 *     tags + session state to ALL attached clients over the voice-node bus.
 *   • CONTROL (P-004): any client may mute/PTT/start/stop/set-mode/force-host;
 *     the host applies it ONCE and broadcasts the new state.
 *   • ELECTION (P-006/P-007): the lease elects ONE player — only that client
 *     renders response audio AND captures the mic; others are receive+display
 *     clients. The connection itself is the liveness signal; if the player
 *     drops, the host re-elects another attached client so the session survives.
 *   • ONE-BRAIN RELAY (voice-unified-sentinel-pipeline-2026-07-01, D-001/D-002):
 *     the EL agent is a voice FRONT-END, not a brain. Every final user
 *     transcript is relayed to the Sentinel pane (the one brain of record) via
 *     the injected `relayToBrain` port; the EL `ask_operator` tool call returns
 *     only an instant ACK for EL to speak. The pane's answer arrives later
 *     through the sentinel-says pump (voice:say → synth → this same bus), so
 *     voice and typed text share one pipeline and one conversation state.
 *
 * Pure orchestration over injected ports (EL socket, relay, persistence, lease,
 * broadcast) so it unit-tests without a live EL endpoint or audio hardware.
 */
import {
  encodeInputTranscript,
  encodeResponseAudio,
  encodeResponseTranscript,
  encodeResponseTag,
  encodeSessionState,
  type SessionStateMsg,
  type VoiceClientKind,
  type VoiceControlOp,
  type VoiceSessionStatus,
} from './operator-voice-bus';
import {
  parseElServerEvent,
  elInitiationMessage,
  elUserAudioChunkMessage,
  elPongMessage,
  elClientToolResultMessage,
  pcmRateFromFormat,
  decodeAudioB64,
} from './el-convai-protocol';
import {
  createPapercupVoiceTurnAdapter,
  type PapercupVoiceTurnAdapter,
} from '../papercup-voice-turn-adapter';
import type { VoiceTurnEvent } from '@papercusp/chat-protocol';

export interface ElSessionConfig {
  signedUrl: string;
  overrides: unknown | null;
  dynamicVariables: unknown;
  /**
   * Which human-facing brain/persona the host runs behind `ask_operator`
   * Resolved from the `humanFacingRole` voice pref.
   * Optional + defaults to 'operator' so the existing live path is unchanged.
   */
  humanFacingRole?: 'operator' | 'papercup';
  /**
   * The "two voices" wrinkle (voice-convergence-additive-wins-2026-07-10
   * P-002): in full-agent mode the EL agent speaks the instant ack ("On it…")
   * in its premium provider voice, then the pane's real answer arrives in the
   * shared synthesize voice — two voices for one exchange, and the provider
   * ack costs TTS characters to say nothing. 'suppressed' returns an EMPTY
   * tool result on a successful relay so the agent stays silent (the persona
   * pins "empty result → say nothing"); relay FAILURE lines are always spoken
   * regardless — the user must hear a miss. Resolved from the
   * `fullAgentAckVoice` voice pref; optional + defaults to 'provider' so the
   * existing live path is byte-for-byte unchanged.
   */
  fullAgentAckVoice?: 'provider' | 'suppressed';
}

export interface ElSocket {
  send(text: string): void;
  close(): void;
}

export interface ElConnectHandlers {
  onText(text: string): void;
  onClose(reason: string): void;
  onError(err: unknown): void;
}

/** Outcome of relaying one utterance to the papercup-fast pane (the one brain, P-008/D-007). */
export type BrainRelayResult =
  | { ok: true }
  | {
      ok: false;
      // Mirrors SentinelPaneWrite's failure classes (papercup-pane-input.ts) —
      // 'no-sentinel-pane' = no live registered pane (P-019 targeted-only writes).
      reason: 'no-dock' | 'no-sentinel-pane' | 'pane-exited' | 'write-failed';
      error: string;
    };

/** Everything the host needs from the outside world — real in prod, faked in tests. */
export interface OperatorVoiceSessionDeps {
  /** Resolve EL config (prefs/agentId/key → signed URL + overrides). */
  resolveConfig(): Promise<{ ok: true; config: ElSessionConfig } | { ok: false; error: string }>;
  /** Open the EL WebSocket and wire inbound text/close/error. */
  connect(signedUrl: string, handlers: ElConnectHandlers): Promise<ElSocket>;
  /**
   * Hand one final user utterance to the Sentinel pane — the ONE brain (D-001).
   * The pane's answer comes back asynchronously via the sentinel-says pump; the
   * host never waits on it.
   */
  relayToBrain(text: string): Promise<BrainRelayResult>;
  /** The shared operator conversation id (D-005) — voice turns persist into it. */
  loadConversationId(): Promise<string | null>;
  /** Persist one turn into the session-pinned shared thread (host is the SOLE writer → once). */
  persistTurn(
    conversationId: string | null,
    role: 'user' | 'assistant',
    text: string,
    elConvId: string | null,
  ): Promise<void>;
  /** Parse an agent utterance for spoken text + control tags. */
  parseUtterance(raw: string): { say: string | null; setMode: string | null };
  claimLease(playerId: string, kind: VoiceClientKind, force: boolean): Promise<boolean>;
  releaseLease(playerId: string): Promise<void>;
  /** Send a framed bus message to every attached client. */
  broadcast(frame: Uint8Array): void;
  /** Optional canonical contract sink; telemetry must never affect the bus. */
  emitCanonicalEvent?(event: VoiceTurnEvent): void;
  log?(msg: string, extra?: unknown): void;
}

const DEFAULT_MODE = 'always-on';

/**
 * The instant acknowledgment EL speaks while the pane thinks (D-002). The real
 * answer arrives later through the sentinel-says pump in the same Herald voice.
 */
export const VOICE_RELAY_ACK = "On it — I'll come back to you in a moment.";

/** Spoken failure lines per relay-failure class — the user must HEAR a miss.
 *  D-001 one-identity: the assistant the user knows is "Papercup" — internal
 *  names (Sentinel / fast / deep) never reach spoken copy. */
export function relayFailureLine(result: Extract<BrainRelayResult, { ok: false }>): string {
  switch (result.reason) {
    case 'no-dock':
      return "I can't reach Papercup right now — the agent dock isn't running.";
    case 'no-sentinel-pane':
      return "Papercup's pane isn't open in the dock right now — give it a moment and ask again.";
    case 'pane-exited':
      return 'Papercup is restarting — give it a moment and ask again.';
    default:
      return "I couldn't hand that to Papercup — check the agent dock.";
  }
}

/** How long the ack path waits for an in-flight relay before acking optimistically.
 *  The relay's warm-up gate can hold a write for up to ~8s after a dock relaunch;
 *  EL expects a tool result promptly, so we cap the wait and trust the write. */
const RELAY_ACK_WAIT_MS = 2_500;

interface AttachedClient {
  clientId: string;
  kind: VoiceClientKind;
}

export class OperatorVoiceSession {
  private status: VoiceSessionStatus = 'off';
  private muted = false;
  private mode = DEFAULT_MODE;
  private pttActive = false;
  private playerId: string | null = null;
  private opConversationId: string | null = null;
  private elConversationId: string | null = null;
  // Which human-facing brain/persona the voice host runs: 'operator' (default) or
  // 'sentinel'. Set from the `humanFacingRole` voice pref via the
  // resolved ElSessionConfig at start (P-011); defaults to 'operator' so the
  // existing live voice path is byte-for-byte unchanged when the pref is unset.
  private brainRole = 'operator';
  // P-002: whether the EL agent speaks the instant ack ('provider', default)
  // or stays silent on a successful relay ('suppressed'). Failure lines are
  // spoken either way. Set from the resolved ElSessionConfig at start.
  private ackVoice: 'provider' | 'suppressed' = 'provider';
  private audioFormat: 'pcm_s16le' | 'encoded' = 'pcm_s16le';
  private sampleRate = 16000;
  private socket: ElSocket | null = null;
  private starting = false;
  private readonly clients = new Map<string, AttachedClient>();
  // One-brain relay bookkeeping (D-001): the last utterance handed to the pane
  // (dedupes a tool-call fallback re-relay of the same turn) and its in-flight
  // promise (the ack path peeks at it to speak a failure instead of a false ack).
  private lastRelayedText: string | null = null;
  private lastRelay: Promise<BrainRelayResult> | null = null;
  /**
   * Papercup's EL/lease transport remains unchanged; this observer gives
   * callers one canonical event stream for transcript, sentence, interruption,
   * error, and latency evidence.
   */
  private readonly canonicalAdapter: PapercupVoiceTurnAdapter | null;

  constructor(private readonly deps: OperatorVoiceSessionDeps) {
    this.canonicalAdapter = deps.emitCanonicalEvent
      ? createPapercupVoiceTurnAdapter({ emit: deps.emitCanonicalEvent })
      : null;
  }

  // ── client lifecycle (called by the local-audio-socket) ──────────────────

  /** A client attached + identified itself. Re-syncs everyone's session state. */
  handleHello(clientId: string, kind: VoiceClientKind): void {
    this.clients.set(clientId, { clientId, kind });
    this.broadcastState();
  }

  /** A client's socket closed. If it was the player, re-elect or tear down. */
  handleClientGone(clientId: string): void {
    this.clients.delete(clientId);
    if (this.playerId !== clientId) {
      this.broadcastState();
      return;
    }
    // The player left. Re-elect another attached client so the session survives
    // (P-011), else tear the session down — nobody to capture/play.
    const next = this.clients.values().next().value as AttachedClient | undefined;
    if (next && this.status !== 'off') {
      // The old player is gone; force-elect the next client (its force claim
      // overwrites the departed owner's lease, so no orphan lease lingers).
      this.playerId = null;
      void this.electPlayer(next.clientId, next.kind, { force: true });
    } else {
      void this.teardown('all clients left');
    }
  }

  /** Mic chunk from a client — forwarded to EL only if it's the transmitting player. */
  handleMic(clientId: string, pcm16le: Uint8Array): void {
    if (clientId !== this.playerId) return; // single mic capture (P-007)
    if (!this.socket || this.status === 'off' || this.status === 'connecting') return;
    if (!this.canTransmit()) return;
    this.socket.send(elUserAudioChunkMessage(pcm16le));
  }

  /** A control from any client — applied once to the single session (P-004). */
  handleControl(clientId: string, control: VoiceControlOp): void {
    switch (control.op) {
      case 'start':
        void this.electPlayer(clientId, this.kindOf(clientId), { startIfIdle: true });
        return;
      case 'force-host':
        void this.electPlayer(clientId, this.kindOf(clientId), { startIfIdle: true, force: true });
        return;
      case 'stop':
        void this.teardown('voice off');
        return;
      case 'mute':
        this.muted = control.muted;
        this.broadcastState();
        return;
      case 'ptt':
        this.pttActive = control.down;
        this.broadcastState();
        return;
      case 'set-mode':
        if (control.mode) this.mode = control.mode;
        this.pttActive = false;
        this.broadcastState();
        return;
    }
  }

  /** Full teardown — public so the bootstrap can stop it on shutdown. */
  async stop(): Promise<void> {
    await this.teardown('voice off');
  }

  /** Re-claim the lease for the current player — call on a timer while running. */
  async heartbeat(): Promise<void> {
    if (this.status === 'off' || !this.playerId) return;
    await this.deps.claimLease(this.playerId, this.kindOf(this.playerId), false);
  }

  /** Current state snapshot (used by tests + the bus to greet new clients). */
  snapshot(): Omit<SessionStateMsg, 'kind'> {
    return {
      status: this.status,
      muted: this.muted,
      mode: this.mode,
      playerId: this.playerId,
      conversationId: this.opConversationId,
      audioFormat: this.audioFormat,
      sampleRate: this.sampleRate,
    };
  }

  /**
   * The live state the server-side Sentinel proactive sweep needs to decide
   * whether it may fire. The host
   * reads this each sweep tick:
   *   - sessionLive    : status !== 'off' (a live EL voice session exists).
   *   - ownsVoiceLease : this host has an ELECTED player (playerId != null) — the
   *                      single-owner guard. The lease elects ONE player (D-003), so
   *                      only the elected host runs the sweep; it never double-fires
   *                      alongside a browser provider / a second host.
   *   - humanFacingRole: the live persona behind the brain ('operator' | 'sentinel').
   * Read-only; never mutates the session.
   */
  sweepState(): {
    sessionLive: boolean;
    ownsVoiceLease: boolean;
    humanFacingRole: 'operator' | 'papercup';
  } {
    return {
      sessionLive: this.status !== 'off',
      ownsVoiceLease: this.playerId !== null,
      humanFacingRole: this.brainRole === 'papercup' ? 'papercup' : 'operator',
    };
  }

  // ── election + session start ─────────────────────────────────────────────

  private kindOf(clientId: string): VoiceClientKind {
    return this.clients.get(clientId)?.kind ?? 'desktop';
  }

  private canTransmit(): boolean {
    if (this.muted) return false;
    return this.mode === 'always-on' || this.pttActive;
  }

  private async electPlayer(
    clientId: string,
    kind: VoiceClientKind,
    opts: { startIfIdle?: boolean; force?: boolean } = {},
  ): Promise<void> {
    // The lease elects the single host+player (D-003). A non-holder is never
    // refused as a *client* — and a plain (non-forcing) `start` while another
    // client is already hosting does NOT steal the player role: the caller just
    // stays an attached receive+control client (Model A). Only `force-host`
    // (force) or re-election after the player drops moves the role.
    const force = opts.force ?? false;
    const sessionLive = this.status !== 'off';
    const hasOtherPlayer = this.playerId !== null && this.playerId !== clientId;
    if (sessionLive && hasOtherPlayer && !force) {
      this.broadcastState();
      return;
    }
    // The session opener must win the role even past a stale/unexpired lease
    // from a crashed surface, so it force-claims; a non-opening claim is gentle.
    const granted = await this.deps.claimLease(clientId, kind, force || this.status === 'off');
    if (granted) this.playerId = clientId;
    if (opts.startIfIdle && this.status === 'off' && !this.starting) {
      await this.start();
    } else {
      this.broadcastState();
    }
  }

  private async start(): Promise<void> {
    if (this.starting || this.socket) return;
    this.starting = true;
    this.setStatus('connecting');
    try {
      this.opConversationId = await this.deps.loadConversationId();
      const resolved = await this.deps.resolveConfig();
      if (!resolved.ok) {
        this.starting = false;
        await this.teardown(`voice init: ${resolved.error}`, 'error');
        return;
      }
      // Repoint the live brain to the configured persona (P-011). Default
      // 'operator' keeps the existing voice path byte-for-byte unchanged.
      this.brainRole = resolved.config.humanFacingRole === 'papercup' ? 'papercup' : 'operator';
      // P-002: ack-voice policy for this session. Anything but the explicit
      // 'suppressed' opt-in keeps the spoken ack (default-preserving).
      this.ackVoice = resolved.config.fullAgentAckVoice === 'suppressed' ? 'suppressed' : 'provider';
      const socket = await this.deps.connect(resolved.config.signedUrl, {
        onText: (t) => this.onElText(t),
        onClose: (reason) => {
          this.canonicalAdapter?.interrupt('transport');
          void this.teardown(reason);
        },
        onError: (e) => {
          const message = (e as Error)?.message ?? String(e);
          this.emitCanonicalError('transport_error', message, true);
          void this.teardown(`voice link error: ${message}`, 'error');
        },
      });
      this.socket = socket;
      socket.send(elInitiationMessage(resolved.config.overrides, resolved.config.dynamicVariables));
      this.setStatus('idle');
    } catch (err) {
      this.starting = false;
      const message = (err as Error)?.message ?? String(err);
      this.emitCanonicalError('transport_error', message, true);
      await this.teardown(`voice connect: ${message}`, 'error');
      return;
    }
    this.starting = false;
  }

  private async teardown(reason: string, finalStatus: VoiceSessionStatus = 'ended'): Promise<void> {
    const wasPlayer = this.playerId;
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
    this.socket = null;
    this.elConversationId = null;
    this.pttActive = false;
    // No player on a torn-down session — null it BEFORE the terminal broadcast
    // so the 'ended' state every client sees reports playerId=null, not a ghost.
    this.playerId = null;
    this.setStatus(finalStatus, reason);
    if (wasPlayer) await this.deps.releaseLease(wasPlayer).catch(() => {});
    // Settle back to 'off' so a later start is clean; the terminal reason was
    // broadcast above so clients can surface it.
    this.status = 'off';
  }

  // ── EL event handling → bus fan-out (P-003) ──────────────────────────────

  private onElText(text: string): void {
    const ev = parseElServerEvent(text);
    switch (ev.type) {
      case 'init': {
        this.elConversationId = ev.conversationId || null;
        const rate = pcmRateFromFormat(ev.agentOutputAudioFormat);
        this.audioFormat = rate == null ? 'encoded' : 'pcm_s16le';
        this.sampleRate = rate ?? 0;
        this.setStatus('idle');
        return;
      }
      case 'audio': {
        const audio = decodeAudioB64(ev.audioB64);
        this.deps.broadcast(encodeResponseAudio({ format: this.audioFormat, sampleRate: this.sampleRate, audio }));
        if (this.status !== 'speaking') this.setStatus('speaking');
        return;
      }
      case 'ping':
        this.socket?.send(elPongMessage(ev.eventId));
        return;
      case 'user_transcript': {
        const t = ev.text.trim();
        if (!t) return;
        this.canonicalAdapter?.finalTranscript({
          text: t,
          transport: 'papercup-hosted',
          latencyClass: 'interactive',
          executor: 'papercup-hosted',
        });
        this.deps.broadcast(encodeInputTranscript({ text: t, final: true }));
        void this.deps.persistTurn(this.opConversationId, 'user', t, this.elConversationId);
        // ONE-BRAIN RELAY (D-001): hand the utterance to the Sentinel pane
        // deterministically, in OUR code — never dependent on whether the EL
        // agent's LLM decides to call its tool. Fire-and-forget; the ack path
        // (ask_operator) peeks at the promise to voice a failure.
        this.relay(t);
        this.setStatus('listening');
        return;
      }
      case 'agent_response': {
        const raw = ev.text.trim();
        if (!raw) return;
        // Raw utterance (tags intact) for display; clients strip for the bubble.
        this.deps.broadcast(encodeResponseTranscript({ text: raw }));
        const parsed = this.deps.parseUtterance(raw);
        if (parsed.setMode) this.deps.broadcast(encodeResponseTag({ tag: 'set_mode', value: parsed.setMode }));
        const spoken = (parsed.say ?? raw).trim();
        if (spoken) {
          // In relay mode this is the provider's instant ACK, not Papercup's
          // answer. The substantive assistant sentence arrives later through
          // the says-pump; do not close the canonical turn at the ACK boundary.
          if (spoken !== VOICE_RELAY_ACK) {
            this.canonicalAdapter?.assistantSentence(spoken);
            this.canonicalAdapter?.complete();
          }
          void this.deps.persistTurn(this.opConversationId, 'assistant', spoken, this.elConversationId);
        }
        return;
      }
      case 'interruption':
        // Barge-in: EL's VAD heard the user — clients cut playout on this state.
        this.canonicalAdapter?.interrupt('user');
        this.setStatus('listening');
        return;
      case 'client_tool_call': {
        void this.onToolCall(ev.toolName, ev.toolCallId, ev.parameters);
        return;
      }
      case 'unknown':
        return;
    }
  }

  /** Relay one utterance to the pane, deduping an identical re-relay of the same turn. */
  private relay(text: string): Promise<BrainRelayResult> {
    if (this.lastRelayedText === text && this.lastRelay) return this.lastRelay;
    this.lastRelayedText = text;
    const p = this.deps
      .relayToBrain(text)
      .catch(
        (err): BrainRelayResult => ({
          ok: false,
          reason: 'write-failed',
          error: (err as Error)?.message ?? String(err),
        }),
      );
    this.lastRelay = p;
    void p.then((r) => {
      if (!r.ok) this.deps.log?.(`brain relay failed (${r.reason}): ${r.error}`);
    });
    return p;
  }

  private emitCanonicalError(code: string, message: string, retryable: boolean): void {
    this.canonicalAdapter?.error({ code, message, retryable });
  }

  /**
   * Complete the active hosted Papercup turn when the one-brain says-pump
   * delivers its substantive answer. The pump is intentionally outside this
   * class; this tiny port keeps the lease/session lifecycle decoupled from the
   * shared FIFO consumer.
   */
  emitCanonicalAssistantSentence(text: string): void {
    this.canonicalAdapter?.assistantSentence(text);
    this.canonicalAdapter?.complete();
  }

  /**
   * EL client-tool calls. `ask_operator` no longer runs a brain (D-001): the
   * pane is the brain and the transcript relay already delivered the utterance.
   * The tool result is only what EL should SPEAK NOW — the instant ack (D-002),
   * or a spoken failure when the relay is known to have missed. The pane's real
   * answer arrives later via the sentinel-says pump on this same bus.
   */
  private async onToolCall(toolName: string, toolCallId: string, parameters: Record<string, unknown>): Promise<void> {
    if (toolName !== 'ask_operator') {
      this.socket?.send(
        elClientToolResultMessage(toolCallId, `tool '${toolName}' is not available on the voice host`, true),
      );
      return;
    }
    // Fallback relay: if EL called the tool without a preceding user_transcript
    // (or with a different question), make sure the pane still gets the turn.
    // relay() dedupes the common path where the transcript already went out.
    const question = String(parameters.question ?? parameters.message ?? parameters.text ?? '').trim();
    const inFlight = question ? this.relay(question) : this.lastRelay;

    let result: BrainRelayResult | null = null;
    if (inFlight) {
      // The relay's warm-up gate can hold a write for seconds; don't make EL
      // wait it out — ack optimistically past the cap and trust the write.
      result = await Promise.race([inFlight, new Promise<null>((r) => setTimeout(() => r(null), RELAY_ACK_WAIT_MS))]);
    }
    // P-002 (fullAgentAckVoice): failures are ALWAYS spoken — the user must
    // hear a miss. On success, 'suppressed' returns an EMPTY result: the relay
    // persona pins "empty tool result → say nothing at all", so the agent
    // neither speaks nor spends provider-TTS characters on the ack; the pane's
    // real answer still arrives via the sentinel-says pump as usual.
    const speak =
      result && !result.ok
        ? relayFailureLine(result)
        : this.ackVoice === 'suppressed'
          ? ''
          : VOICE_RELAY_ACK;
    this.socket?.send(elClientToolResultMessage(toolCallId, speak, false));
  }

  // ── state broadcast ──────────────────────────────────────────────────────

  private setStatus(status: VoiceSessionStatus, reason?: string): void {
    this.status = status;
    this.broadcastState(reason);
  }

  private broadcastState(reason?: string): void {
    this.deps.broadcast(
      encodeSessionState({
        status: this.status,
        muted: this.muted,
        mode: this.mode,
        playerId: this.playerId,
        conversationId: this.opConversationId,
        audioFormat: this.audioFormat,
        sampleRate: this.sampleRate,
        reason,
      }),
    );
  }
}
