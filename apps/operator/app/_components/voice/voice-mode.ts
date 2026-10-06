/**
 * Browser-side voice mode runtime.
 *
 * Uses the Web Speech API (SpeechRecognition + SpeechSynthesis) — no
 * server roundtrip, no external dependencies.
 *
 * Capabilities:
 *   - STT (push-to-talk + always-on with wake word)
 *   - TTS with per-role voice assignment (consistent across harnesses)
 *   - Single-utterance-at-a-time queue (only the in-focus speaker plays)
 *   - Barge-in: user starting to speak interrupts current utterance
 *   - Wake-word detection ("hey papercup") for always-on mode
 *
 * The voice runtime is a singleton initialized once in the operator
 * shell. Components subscribe via `subscribeVoiceState()` and dispatch
 * via the public methods.
 */

import { matchWakePhrase } from '@papercusp/operator-core/lib/wake-word';
import { getBrowserWorkspaceId, wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { createOperatorVoiceTagObserver } from '@papercusp/operator-core/lib/operator-converse-voice';
import { persistOperatorVoiceTurn } from '@papercusp/operator-core/lib/operator-conversation-client';
import { startDesktopOperatorVoice, type OperatorVoiceRuntime } from './operator-voice-runtime';
// Statically imported — neither sibling imports voice-mode, so there is no
// cycle. (Were CJS require()s, which are undefined in the Vite browser bundle.)
import { loadVoicePrefsClient } from './voice-prefs-client';
import { requestVoiceLead, getVoiceLeaderState } from './voice-leader';
// Static-imported (not dynamic): these are small, dependency-light modules,
// and dynamic import() of them was intermittently HANGING in the operator-vite
// build — which left PTT capture never starting → "No audio detected". The
// heavy/optional engines (stt-voicemode's MicVAD, deepgram) stay dynamic below.
import {
  startPttRawCapture,
  classifyPttResult,
  resampleLinearTo16k,
  isBlankTranscript,
  type PttRawCapture,
  type PttRawCaptureResult,
} from './ptt-capture';
import { f32ToWav } from './f32-to-wav';
import { transcribeChunk } from '@papercusp/operator-core/lib/voice-engines/whisper';
import {
  isFullAgentEngineUnavailable,
  isWakeEngineUnavailable,
  releaseUnavailableMessage,
} from '@papercusp/operator-core/lib/voice-release-availability';
import { startEnergyVadCapture } from './energy-vad-capture';
import { PlayoutLedger, type CaptureWindow } from './capture-window';
import {
  createPapercupVoiceTurnAdapter,
  type PapercupVoiceTransport,
} from '@papercusp/operator-core/lib/papercup-voice-turn-adapter';
import type { VoiceTurnEvent } from '@papercusp/chat-protocol';

/**
 * Canonical event observer for the local/browser Papercup path. The hosted
 * lease session emits its events server-side; local Whisper + converse uses
 * this adapter while retaining the existing DOM/provider transport.
 */
const localCanonicalAdapter = createPapercupVoiceTurnAdapter({
  emit: (event: VoiceTurnEvent) => {
    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(new CustomEvent('papercusp:voiceTurnEvent', { detail: event }));
    } catch {
      /* telemetry must never break voice */
    }
  },
});

function canonicalTransportForSource(source: TranscriptSource): PapercupVoiceTransport | null {
  return source === 'localWhisper' ? 'papercup-local' : null;
}

/**
 * Emit the voice-engagement signal the OperatorConversationProvider
 * listens for. Provider lives in the React tree; voice-mode is the
 * imperative singleton outside it. Window event is the right seam.
 *
 * Plan's "engagement detection in passive: user voice utterance with
 * address=operator → engagement" — wired here, end-to-end. The voice
 * engines (EL Conv AI, OpenAI Realtime) all gate STT behind either
 * wake-word (always-on mode) or PTT (user-initiated), so every
 * transcript that lands here is implicitly addressed to the operator;
 * no further address filtering is required. C3 of the audit.
 *
 * Timestamp is captured at emit time (the moment STT finalizes the
 * transcript), not at provider receive time, so a slow React queue
 * doesn't shift the engagement window. C1 of the audit.
 */
/**
 * Who produced a user transcript. The transport layer stays split (local
 * Whisper STT vs. a full-agent provider's own STT), but both flow into the
 * pane through one uniform, source-tagged seam so the origin is observable
 * (voice-convergence-additive-wins-2026-07-10 P-001). `source: 'voice_stt'`
 * on the event is the coarse turn-kind (vs. text); `transcriptSource` is the
 * finer producer discriminator.
 */
export type TranscriptSource = 'localWhisper' | 'providerSTT';

function emitOperatorUserTurn(text: string, transcriptSource: TranscriptSource): void {
  if (typeof window === 'undefined') return;
  const trimmed = text?.trim();
  if (!trimmed) return;
  const tsMs = Date.now();
  try {
    window.dispatchEvent(
      new CustomEvent('papercusp:operatorUserTurn', {
        detail: { text: trimmed, source: 'voice_stt', transcriptSource, tsMs },
      }),
    );
  } catch { /* ignore */ }
}

export type VoiceModeStatus =
  | 'off'                    // Voice mode disabled
  | 'connecting'             // Bringing up full-agent session (EL/Realtime negotiating)
  | 'idle'                   // Listening for wake word (or idle in PTT)
  | 'listening'              // Actively recording user speech
  | 'speaking'               // Reading agent text
  | 'paused';                // User-paused

export type VoiceMode = 'off' | 'push-to-talk' | 'always-on';

export interface VoiceState {
  mode: VoiceMode;
  status: VoiceModeStatus;
  /** True if voice mode can run at all (any engine path is viable). */
  supported: boolean;
  /** True if the browser provides Web Speech STT (used by wake-word + PTT). */
  hasWebSpeechSTT: boolean;
  /** True if the browser provides Web Speech TTS (otherwise route via engine adapters). */
  hasWebSpeechTTS: boolean;
  /** Last transcript text (latest user utterance). */
  lastTranscript: string;
  /** Currently-speaking role (e.g. 'orchestrator', 'operator', 'system:oracle'). */
  speakingRole: string | null;
  /** Pulses true for ~2.5s when a wake word is detected (any engine —
   *  Porcupine, openWakeWord, or string-match in transcript). UI uses
   *  this to flash an amber visual indicator on the voice button. */
  wakeDetected: boolean;
  /** Pulses true for ~2s when the user just finished an utterance the
   *  voice engine accepted (EL Conv AI transcript, Whisper finalized,
   *  Realtime turn end). Distinct from wakeDetected — flashes cyan, not
   *  amber, so the user can tell "wake word fired" from "agent heard
   *  the full utterance". */
  userSpoke: boolean;
  /** True while a full-agent engine (EL Conv AI / OpenAI Realtime) owns
   *  the microphone. Suppresses our local useMicLevel analyser so two
   *  concurrent getUserMedia consumers don't fight for the device —
   *  some browsers serialize this and the second-acquired track
   *  delivers no media, breaking WebRTC negotiation downstream. */
  micOwnedByFullAgent: boolean;
  /** True when the mic is currently picking up audio above the
   *  silence threshold. Drives "Hearing you" visual feedback during
   *  PTT so users can tell apart "button pressed but mic dead" from
   *  "button pressed AND voice being captured". Set by the active
   *  capture engine or by the local useMicLevel analyser. */
  audioReceiving: boolean;
  /** True between stopPushToTalk and the next onUtteranceFinal —
   *  i.e. "you released the button, we're transcribing your audio." */
  processingTranscript: boolean;
  /** True between onUtteranceFinal and status='speaking' (or timeout)
   *  — i.e. "transcript was captured, the agent is preparing a reply." */
  awaitingResponse: boolean;
  /** P-003 (voice-public-release-readiness): true while a wake-capable
   *  capture loop is ACTUALLY running — Silero/energy-VAD whisper always-on,
   *  a porcupine/openWakeWord gate, or the Web Speech wake recognizer.
   *  Set/cleared at the exact capture start/stop sites (derived-correct,
   *  never inferred after the fact). The UI must not advertise
   *  "say <wake word>" unless this — or a mic-owning full agent — is true:
   *  on runtimes where no detector can fire (e.g. WebKitGTK without local
   *  whisper AND without Web Speech), always-on otherwise LOOKS armed while
   *  nothing is listening. */
  wakeListening: boolean;
}

interface VoiceConfig {
  /** Wake word for always-on mode. Default: "hey papercup". */
  wakeWord: string;
  /** Voice assignments by role. Falls back to default voice if missing. */
  roleVoices: Record<string, string>;
  /** Default voice name (browser-specific). */
  defaultVoice: string | null;
  /** Speech rate (0.1 to 10). Default 1.0. */
  rate: number;
  /** Persisted last mode so navigation preserves user's choice. */
  lastMode: VoiceMode;
}

const DEFAULT_CONFIG: VoiceConfig = {
  wakeWord: 'hey papercup',
  roleVoices: {},
  defaultVoice: null,
  rate: 1.0,
  lastMode: 'off',
};

const STORAGE_KEY = 'papercusp.voice.config.v1';

/**
 * The headless Tauri verifier owns a throwaway WebView profile, but keep the
 * safety boundary explicit in the client too. If a future launch regression
 * exposes ambient localStorage again, a verifier must still start with voice
 * mode off rather than re-opening a persisted microphone session.
 */
function isIsolatedTauriVerification(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if ((window as Window & { __PAPERCUSP_TAURI_ISOLATED__?: boolean }).__PAPERCUSP_TAURI_ISOLATED__ === true) {
      return true;
    }
    return new URL(window.location.href).searchParams.get('verify-tauri-isolated') === '1';
  } catch {
    return false;
  }
}

// ── Voice OUTPUT (TTS) mute — the speaker toggle in the voice bar (owner ask
// 2026-06-23: "a button next to the mic to enable/disable text-to-speech for
// the Sentinel responses"). A per-workspace UI preference (localStorage): when
// muted, non-forced speak() emits nothing, so the Sentinel's spoken replies are
// silenced WITHOUT leaving voice mode (PTT/STT still work). `force:true`
// (the /settings/voice test buttons) bypasses it. Default = NOT muted
// (responses are spoken — the finished voice-out path ships enabled).
const OUTPUT_MUTED_KEY = 'papercusp.voice.outputMuted.v1';

/** True when the user has muted spoken (TTS) responses via the voice-bar toggle. */
export function isVoiceOutputMuted(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(wsLocalKey(OUTPUT_MUTED_KEY)) === '1';
  } catch {
    return false;
  }
}

/** Mute/unmute spoken (TTS) responses; broadcasts so the toggle UI re-syncs. */
export function setVoiceOutputMuted(muted: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(wsLocalKey(OUTPUT_MUTED_KEY), muted ? '1' : '0');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('papercusp:voiceOutputMutedChanged', { detail: { muted } }),
      );
    }
  } catch {
    /* ignore */
  }
}

let state: VoiceState = {
  mode: 'off',
  status: 'off',
  supported: false,
  hasWebSpeechSTT: false,
  hasWebSpeechTTS: false,
  lastTranscript: '',
  speakingRole: null,
  wakeDetected: false,
  userSpoke: false,
  micOwnedByFullAgent: false,
  audioReceiving: false,
  processingTranscript: false,
  awaitingResponse: false,
  wakeListening: false,
};

/**
 * Set whether the mic is currently picking up audio above the silence
 * threshold. Called by useMicLevel (the visualization analyser) and
 * any engine that exposes input-VAD callbacks. Cheap idempotent write
 * — guarded against redundant setState noise.
 */
export function setAudioReceiving(receiving: boolean): void {
  if (state.audioReceiving === receiving) return;
  setState({ audioReceiving: receiving });
}

/**
 * Last error thrown by the visualization getUserMedia in useMicLevel.
 * Previously swallowed silently, so every capture failure — permission
 * denied, device busy, no device — collapsed into the same opaque "No
 * audio detected" toast. Recording it here lets stopPushToTalk's no-audio
 * branch say something the user can actually act on. A nullish value
 * clears it (called on each successful acquire so stale errors don't leak).
 */
let lastMicError: { name: string; message: string } | null = null;
export function setMicCaptureError(err: unknown): void {
  if (!err) { lastMicError = null; return; }
  const e = err as { name?: string; message?: string };
  lastMicError = { name: e?.name ?? '', message: e?.message ?? String(err) };
}

// Timeouts for the two "stuck" phases. Each phase has a soft warning
// at the end of its timer — clears the phase flag, fires a toast, so
// the user understands "this should have happened by now and didn't"
// rather than staring at a spinning indicator forever.
let processingTranscriptTimer: ReturnType<typeof setTimeout> | null = null;
let awaitingResponseTimer: ReturnType<typeof setTimeout> | null = null;
// Safety net for the optimistic always-on 'connecting' status: if no
// full-agent session (or fallback capture) has materialized shortly after a
// mode change, resolve to a usable state instead of a permanent "Connecting…".
let connectingWatchdog: ReturnType<typeof setTimeout> | null = null;

/**
 * Mark "the user just released PTT — we're transcribing whatever was
 * captured." Auto-clears on transcript final OR after 8s with a toast
 * warning that STT didn't return in time.
 */
function beginProcessingTranscript(): void {
  if (processingTranscriptTimer) clearTimeout(processingTranscriptTimer);
  setState({ processingTranscript: true });
  processingTranscriptTimer = setTimeout(() => {
    processingTranscriptTimer = null;
    if (!state.processingTranscript) return;
    setState({ processingTranscript: false });
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(
          new CustomEvent('papercusp:voiceTimeout', {
            detail: { phase: 'transcript', message: 'No transcript received — try speaking again.' },
          }),
        );
      } catch { /* ignore */ }
    }
  }, 8000);
}

function endProcessingTranscript(): void {
  if (processingTranscriptTimer) {
    clearTimeout(processingTranscriptTimer);
    processingTranscriptTimer = null;
  }
  if (state.processingTranscript) setState({ processingTranscript: false });
}

/**
 * How long to wait for the agent's reply before firing the "Agent did not
 * respond" toast. Sized to a REAL fast-pane turn, not an HTTP round-trip
 * (voice-public-release-readiness-2026-07-12 P-019/D-007): the primary voice
 * brain is the dock's Papercup pane (a psu Claude session on a fast model) whose
 * honest turn latency is ~5–30s — the old 15s window fired the timeout on turns
 * that were still legitimately composing. The pane route also speaks an instant
 * local ack (VoiceAppBridge), so the user is never staring at silence while
 * this window runs.
 */
export const RESPONSE_WINDOW_MS = 45_000;
export const RESPONSE_TIMEOUT_SPOKEN_NOTICE =
  "Sorry, I didn't get a response. Please try again.";

/**
 * Mark "transcript captured — the agent is composing a response."
 * Cleared when status becomes 'speaking' (TTS started) OR after
 * RESPONSE_WINDOW_MS with a toast warning.
 */
function beginAwaitingResponse(): void {
  if (awaitingResponseTimer) clearTimeout(awaitingResponseTimer);
  setState({ awaitingResponse: true });
  awaitingResponseTimer = setTimeout(() => {
    awaitingResponseTimer = null;
    if (!state.awaitingResponse) return;
    setState({ awaitingResponse: false });
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(
          new CustomEvent('papercusp:voiceTimeout', {
            // EI-10795: the old copy ("check connection") misdiagnosed the common cause.
            // This window expires far more often because the brain couldn't get an LLM slot
            // (account-pool crunch) than because the socket is down — and it sent the owner
            // hunting a network fault that wasn't there. Say what's actually true: no reply
            // arrived in time, and retrying is the useful action.
            detail: { phase: 'response', message: "Papercup didn't reply in time — it may be busy. Try again." },
          }),
        );
      } catch { /* ignore */ }
    }
    // The executor failed to produce a substantive response inside the local
    // turn deadline. Emit the canonical failure before speaking the fallback
    // notice; the notice is UX, not a successful assistant answer.
    localCanonicalAdapter.error({
      code: 'response_timeout',
      message: "Papercup didn't reply before the local response deadline.",
      retryable: true,
    });
    // A visual toast is invisible to the eyes-off-screen user who initiated
    // this turn by voice. Route the failure through the same local TTS queue
    // as normal replies. `allowDuringRealtime` is intentionally narrower than
    // `force`: it still respects voice-off, output mute, and leader election,
    // but lets the fallback speak when an attached full-agent session is the
    // thing that failed to answer.
    speak(RESPONSE_TIMEOUT_SPOKEN_NOTICE, 'system:operator', 'assertive', {
      allowDuringRealtime: true,
    });
  }, RESPONSE_WINDOW_MS);
}

function endAwaitingResponse(): void {
  if (awaitingResponseTimer) {
    clearTimeout(awaitingResponseTimer);
    awaitingResponseTimer = null;
  }
  if (state.awaitingResponse) setState({ awaitingResponse: false });
}

// Pulse the wake-detected flag for ~1.2s. Auto-clears so the visual
// indicator is a flash, not a stuck highlight. Idempotent — re-firing
// while the pulse is active resets the timer (back-to-back wakes still
// produce one continuous flash rather than two flickers).
let wakeDetectedTimer: ReturnType<typeof setTimeout> | null = null;
export function signalWakeDetected(): void {
  if (wakeDetectedTimer) {
    clearTimeout(wakeDetectedTimer);
    wakeDetectedTimer = null;
  }
  setState({ wakeDetected: true });
  wakeDetectedTimer = setTimeout(() => {
    wakeDetectedTimer = null;
    setState({ wakeDetected: false });
  }, 2500);
}

// Pulse the "user-spoke" flag for ~2s. Different state + different
// color from wakeDetected so the user can tell "wake word fired" apart
// from "agent received my full utterance". Used by EL Conv AI's
// onTranscript callback and the legacy Whisper finalized-result path.
let userSpokeTimer: ReturnType<typeof setTimeout> | null = null;
export function pulseUserSpoken(): void {
  if (userSpokeTimer) {
    clearTimeout(userSpokeTimer);
    userSpokeTimer = null;
  }
  setState({ userSpoke: true });
  userSpokeTimer = setTimeout(() => {
    userSpokeTimer = null;
    setState({ userSpoke: false });
  }, 2000);
}

let config: VoiceConfig = { ...DEFAULT_CONFIG };

type Listener = (s: VoiceState) => void;
const listeners = new Set<Listener>();

let recognition: any = null;
// Voice playback queue (defensive limit to prevent runaway accumulation
// from a stuck TTS engine + a chatty caller — e.g. background scanner
// fires while playback is hung). Hard cap drops oldest items beyond MAX.
const SYNTH_QUEUE_MAX = 8;
let synthQueue: Array<{
  text: string;
  role: string;
  /** A short local acknowledgement is not the agent's substantive reply.
   * Keep the response deadline armed until the real reply starts. */
  preserveAwaitingResponse: boolean;
}> = [];
let isSynthSpeaking = false;

function notify() {
  for (const l of listeners) l(state);
}

function setState(patch: Partial<VoiceState>) {
  state = { ...state, ...patch };
  notify();
}

function loadConfig(): VoiceConfig {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_CONFIG };
  try {
    const raw = localStorage.getItem(wsLocalKey(STORAGE_KEY));
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(wsLocalKey(STORAGE_KEY), JSON.stringify(config));
  } catch {
    /* storage full / disabled */
  }
}

export function subscribeVoiceState(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

export function getVoiceState(): VoiceState {
  return state;
}

export function getVoiceConfig(): VoiceConfig {
  return { ...config };
}

export function updateVoiceConfig(patch: Partial<VoiceConfig>): void {
  config = { ...config, ...patch };
  saveConfig();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event('pc-voice-config-changed'));
  }
}

/**
 * Initialize voice runtime. Call once on app load. Idempotent.
 *
 * Restores the user's last mode (persisted in config) so voice mode
 * survives navigation between pages.
 */
export function initVoiceMode(): void {
  if (typeof window === 'undefined') return;
  config = loadConfig();

  // Release the EL/Realtime session immediately on tab close or refresh.
  // Without this, the EL workspace concurrency slot stays held for ~30s
  // server-side, blocking the next page load (and any other tab) from
  // minting a new session. pagehide fires for both close and refresh
  // (beforeunload doesn't fire reliably on mobile / on hidden tabs).
  // .stop() is fire-and-forget — the page is going away.
  const releaseOnUnload = () => {
    if (realtimeSession) {
      try { void realtimeSession.stop(); } catch { /* page is gone, swallow */ }
      realtimeSession = null;
    }
  };
  window.addEventListener('pagehide', releaseOnUnload);
  window.addEventListener('beforeunload', releaseOnUnload);

  // Silence-nudge teardown handoff (plan: silence-nudge-reliability-2026-05-14
  // §C.2). The conversation provider's grace timer fires this when the
  // Ready card has been open unanswered for `silenceNudgeGraceSecs`.
  // Tear down the active EL session + arm wake-word listening (if
  // configured) so the user can resume hands-free. No-op when no
  // session is active.
  window.addEventListener('papercusp:voiceSilenceTeardown', (e) => {
    if (!realtimeSession) return;
    const detail = (e as CustomEvent<{ wakeword?: string | null }>).detail;
    const wakeword = detail?.wakeword || null;
    stopRealtimeSession();
    setState({ status: state.mode === 'off' ? 'off' : 'idle' });
    // Restart wake-word listener for hands-free resume. Reuses the
    // same path the generic idle timer takes.
    if (wakeGated && state.mode !== 'off') {
      void startWakeWordGate(wakeGatedPrefsCache).catch(() => {});
    }
    // Handoff cue — gated by pref. Spoken via the standard speak()
    // queue so it lands cleanly even mid-TTS.
    try {
      const prefs = loadVoicePrefsClient();
      // P-003 honest wake copy: only advertise "say <wake word>" when a wake
      // gate is actually re-arming here (wakeGated). Otherwise nothing will
      // be listening for the phrase and the spoken promise would be a lie.
      if (prefs.speakSessionHandoff !== false && wakeword && wakeGated) {
        const msg = `Going to wake-word listening. Say ${wakeword} when you're ready.`;
        speak(msg, 'system:operator', 'polite');
      }
    } catch { /* prefs unreachable → skip handoff */ }
  });
  // Voice mode is "supported" as long as the runtime can plausibly speak
  // OR transcribe via *some* engine. Web Speech is sufficient but not
  // required — Tauri/WebKitGTK lacks it but Voicemode (local Kokoro +
  // Whisper) covers the same surface, and the cloud engines (ElevenLabs,
  // OpenAI, Cartesia, Deepgram) work via fetch+Audio. So we default to
  // supported in any browser context and let individual code paths gate
  // on the specific API they need.
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const hasWebSpeechSTT = !!SR;
  const hasWebSpeechTTS = !!window.speechSynthesis;
  setState({ supported: true, hasWebSpeechSTT, hasWebSpeechTTS });

  // Defer the network-touching + heavy-import parts of init until the
  // browser has done first paint and is otherwise idle. Without this,
  // mounting the global VoiceButton synchronously triggers:
  //   - fetch /api/agent-mcp/operator-voice-prefs (~tens of ms)
  //   - fetch /api/agent-mcp/operator-elevenlabs-bootstrap (2.4s cold)
  //   - dynamic import of @elevenlabs/client (~3 MB chunk parse)
  //   - WebRTC handshake to the EL workspace
  // …on every page load even for users who don't use voice. Pushing this
  // to requestIdleCallback gets it off the critical path; the visible
  // VoiceButton renders immediately, and the user-perceived "Connecting…"
  // status appears within ~100ms of paint instead of blocking it.
  const runDeferred = () => {
    // Prime the TTS engine cache so the first speak() routes through
    // the user's chosen engine instead of defaulting to Browser TTS.
    void fetchPreferredEngine();

    // Restore last mode from config so navigation preserves user choice.
    // Skip if state.mode is already non-off (init may run again on hot reload).
    // An isolated verifier must never re-open a persisted microphone mode,
    // even if a stale/shared WebView profile slips past the launch guard.
    if (state.mode === 'off' && config.lastMode !== 'off' && !isIsolatedTauriVerification()) {
      setVoiceMode(config.lastMode);
    }
  };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(runDeferred, { timeout: 1500 });
  } else {
    setTimeout(runDeferred, 50);
  }

  // Pre-populate available voices once they're loaded by the browser.
  // Skip on runtimes without the Web Speech API (Tauri/WebKitGTK has no
  // SpeechSynthesis) — `hasWebSpeechTTS` is set above; cloud engines and
  // local Voicemode handle the speak path on those runtimes.
  if (hasWebSpeechTTS) {
    const populateVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length && !config.defaultVoice) {
        // Prefer en-US voices; fallback to first available.
        const preferred = voices.find((v) => v.lang.startsWith('en-US'));
        config.defaultVoice = (preferred ?? voices[0]).name;
        saveConfig();
      }
    };
    populateVoices();
    if (typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
      window.speechSynthesis.onvoiceschanged = populateVoices;
    }
  }
}

/**
 * Pick a stable voice for a given role. Same role → same voice across
 * harnesses, sessions, and browser restarts (config persisted to
 * localStorage).
 */
// Per-engine role-voice pools. Hashing the role name into one of these
// gives every role a distinct, stable voice when speaking through a
// cloud / Kokoro engine.
const KOKORO_VOICE_POOL = [
  'af_bella', 'af_nova', 'af_sarah', 'af_sky', 'af_nicole',
  'am_michael', 'am_adam', 'am_echo', 'am_liam', 'am_onyx',
  'bf_alice', 'bf_emma', 'bm_daniel', 'bm_george',
];
const OPENAI_VOICE_POOL = ['nova', 'alloy', 'echo', 'fable', 'onyx', 'shimmer'];
const ELEVEN_VOICE_POOL = [
  '21m00Tcm4TlvDq8ikWAM', // Rachel
  'AZnzlk1XvdvUeBnXmlld', // Domi
  'EXAVITQu4vr4xnSDxMaL', // Bella
  'TxGEqnHWrfWFTfGW9XjX', // Josh
  'VR6AewLTigWG4xSOukaG', // Arnold
  'pNInz6obpgDQGcFmaJgB', // Adam
];
const CARTESIA_VOICE_POOL = [
  'a0e99841-438c-4a64-b679-ae501e7d6091', // Barbershop Man
  '79a125e8-cd45-4c13-8a67-188112f4dd22', // British Reading Lady
  '2ee87190-8f84-4925-97da-e52547f9462c', // Child
  'fb26447f-308b-471e-8b00-8e9f04284eb5', // Doctor Mischief
  '156fb8d2-335b-4950-9cb3-a2d33befec77', // Help Desk Man
  '95856005-0332-41b0-935f-352e296aa0df', // Classy British Man
];

function hashRole(role: string): number {
  let h = 0;
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function voiceForEngineRole(engine: string, role: string): string | null {
  // Per-slug override may exist in voice config (Web Speech style names).
  // For cloud engines we treat the override as opaque and pass it through.
  let baseRole = role;
  const at = role.indexOf('@');
  if (at > 0) baseRole = role.slice(0, at);
  if (config.roleVoices[role]) return config.roleVoices[role];
  if (config.roleVoices[baseRole]) return config.roleVoices[baseRole];

  const h = hashRole(baseRole);
  switch (engine) {
    case 'kokoro':     return KOKORO_VOICE_POOL[h % KOKORO_VOICE_POOL.length];
    case 'openai':     return OPENAI_VOICE_POOL[h % OPENAI_VOICE_POOL.length];
    case 'elevenlabs': return ELEVEN_VOICE_POOL[h % ELEVEN_VOICE_POOL.length];
    case 'cartesia':   return CARTESIA_VOICE_POOL[h % CARTESIA_VOICE_POOL.length];
    default:           return null;
  }
}

function voiceForRole(roleOrComposite: string): string | null {
  // Per-slug override (v4 §2h v1.5): callers may pass `role@slug` to
  // request a slug-specific assignment. Lookup chain:
  //   1. exact `role@slug`     (specific)
  //   2. base `role`           (shared across instances)
  //   3. auto-assign (hashed)
  let role = roleOrComposite;
  let slugKey: string | null = null;
  const at = roleOrComposite.indexOf('@');
  if (at > 0) {
    slugKey = roleOrComposite;
    role = roleOrComposite.slice(0, at);
    if (config.roleVoices[slugKey]) return config.roleVoices[slugKey];
  }
  if (config.roleVoices[role]) return config.roleVoices[role];

  // Auto-assign a voice for this role if not configured. We hash the
  // role name to a stable index into the available voices list.
  // Tauri/WebKitGTK lacks SpeechSynthesis — fall back to defaultVoice
  // (cloud / Voicemode engines have their own role-pool logic elsewhere).
  if (typeof window === 'undefined') return null;
  if (!window.speechSynthesis) return config.defaultVoice;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return config.defaultVoice;
  const enVoices = voices.filter((v) => v.lang.startsWith('en'));
  const pool = enVoices.length ? enVoices : voices;
  let h = 0;
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) | 0;
  const picked = pool[Math.abs(h) % pool.length];
  // Persist so it stays consistent.
  config.roleVoices[role] = picked.name;
  saveConfig();
  return picked.name;
}

/**
 * Set voice mode. 'off' fully disables; 'push-to-talk' arms STT on
 * explicit invocation; 'always-on' listens for the wake word.
 */
function clearConnectingWatchdog(): void {
  if (connectingWatchdog) {
    clearTimeout(connectingWatchdog);
    connectingWatchdog = null;
  }
}

/**
 * Arm a watchdog that resolves a stuck optimistic 'connecting' status. Fires
 * only if we're still 'connecting' with no realtime session attached and no
 * full-agent start in flight — i.e. nothing is actually going to come up, so
 * the spinner would otherwise hang forever (the cross-window / no-engine bug).
 */
function armConnectingWatchdog(): void {
  clearConnectingWatchdog();
  if (typeof window === 'undefined') return;
  connectingWatchdog = setTimeout(() => {
    connectingWatchdog = null;
    if (state.status === 'connecting' && !realtimeSession && !fullAgentStarting) {
      setState({
        status: state.mode === 'off' ? 'off' : 'idle',
        micOwnedByFullAgent: false,
      });
    }
  }, 4000);
}

export function setVoiceMode(mode: VoiceMode): void {
  if (mode === state.mode) return;
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* not running */
    }
    recognition = null;
  }
  // Persist the chosen mode so navigation preserves it.
  config.lastMode = mode;
  saveConfig();
  if (mode === 'off') {
    cancelAllSpeech();
    stopWhisperCaptureIfRunning();
    clearConnectingWatchdog();
    setState({ mode, status: 'off', micOwnedByFullAgent: false });
    return;
  }
  if (mode === 'push-to-talk') {
    // Push-to-talk is button-driven — there is no persistent session to
    // "connect" to, so it must NOT enter the optimistic 'connecting' state
    // (which only makes sense for the full-agent EL/Realtime engines and
    // otherwise sticks as a permanent "Connecting…"). Go straight to 'idle'
    // (ready); capture happens on hold via startPushToTalk.
    // Tear down any always-on continuous capture (e.g. energy-VAD) so it
    // doesn't keep the mic open and block per-hold PTT capture.
    clearConnectingWatchdog();
    stopWhisperCaptureIfRunning();
    setState({ mode, status: 'idle', micOwnedByFullAgent: false });
  } else {
    // always-on: claim mic ownership SYNCHRONOUSLY in the same setState that
    // flips the mode. Without this, React renders once with mode='always-on'
    // but micOwnedByFullAgent=false → useMicLevel opens getUserMedia → a
    // microtask later maybeStartFullAgent flips the flag → useMicLevel tears
    // down its stream — and EL has now also opened getUserMedia in parallel
    // on top of the cleanup, getting a silent track. Setting both flags in
    // one render eliminates the window. A watchdog guarantees this optimistic
    // 'connecting' always resolves even if no full-agent engine materializes.
    setState({ mode, status: 'connecting', micOwnedByFullAgent: true });
    armConnectingWatchdog();
  }
  // User-clicked-voice-on is also a "take voice over here" gesture.
  // Request the lead so any other tab currently running EL/STT yields.
  // No-op if we're already leader, or if BroadcastChannel is unavailable
  // (Safari private windows / WebViews — single-tab fallback handles it).
  try {
    const ls = getVoiceLeaderState();
    if (ls.available && !ls.isLeader) {
      requestVoiceLead(`user-set-mode-${mode}`);
    }
  } catch { /* leader module not yet loaded — initial subscriber boot will handle */ }
  // STT capture is leader-gated: only one tab in the BroadcastChannel
  // group opens the mic + transcribes. Followers stay silent so we don't
  // run N parallel getUserMedia + N transcription pipelines + dispatch
  // the same intent N times. We re-evaluate when leader changes (see
  // syncSttToLeader below).
  syncSttToLeader();
}

function maybeIsLeader(): boolean {
  try {
    const ls = getVoiceLeaderState();
    // If leader-election hasn't booted yet, treat us as leader so a
    // single-tab user isn't blocked from STT during initial load.
    if (!ls.available) return true;
    return ls.isLeader;
  } catch {
    return true;
  }
}

function syncSttToLeader(): void {
  if (state.mode === 'off') {
    stopWhisperCaptureIfRunning();
    stopRealtimeSession();
    stopWakeWordGate();
    // Clear the WebRTC-blocked gate so the user can retry the full
    // EL stack after switching networks / disabling VPN / etc.
    return;
  }
  if (!maybeIsLeader()) {
    stopWhisperCaptureIfRunning();
    stopRealtimeSession();
    stopWakeWordGate();
    if (recognition) {
      try { recognition.stop(); } catch { /* ignore */ }
      recognition = null;
    }
    // Another tab owns voice — clear the optimistic 'connecting' so this tab
    // doesn't sit on a permanent spinner (the original bug: a follower window
    // toggled voice on, bailed here, and never reset the status).
    if (state.status === 'connecting') {
      clearConnectingWatchdog();
      setState({ status: 'idle', micOwnedByFullAgent: false });
    }
    return;
  }
  // Push-to-talk captures on demand (button hold), so there is nothing to
  // start here — and no full-agent session (those engines are conversational
  // / always-listening). Just make sure no leftover realtime session lingers.
  if (state.mode === 'push-to-talk') {
    stopRealtimeSession();
    return;
  }
  // Always-on: full-agent mode (EL Conv / OpenAI Realtime) takes precedence
  // over the STT pipeline — it bundles STT + LLM + TTS + intent dispatch.
  void maybeStartFullAgent().then((started) => {
    if (started) return;
    void maybeStartWhisperCapture(state.mode).catch(() => {
      if (state.mode === 'always-on') startWakeWordListening();
    });
  });
}

let realtimeSession: { stop(): Promise<void>; sendSystem?: (text: string) => void } | null = null;
/** Timestamp of last EL onConnect; reset to 0 in onDisconnect. Used to
 *  differentiate immediate-disconnect (negotiation failure) vs. mid-session
 *  drops vs. natural session-end so the toast wording matches reality. */
let elConnectedAt = 0;

// One-shot gate: set when EL fails with a WebRTC negotiation error so
// subsequent toggles in the same session skip EL and go straight to
// Whisper. Cleared on voice-mode 'off' or on prefs change.

// Idle-disconnect timer for EL Conv AI / Realtime sessions. Mic streams
// continuously while connected; silence still bills minutes. The timer
// is reset by every USER transcript (agent transcripts intentionally
// don't reset — see voice-mode onAssistantText). Default timeout from
// voice-prefs (2 min); 0 = disabled.
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimeoutMs = 2 * 60_000;

// Hard session-max timer. Regardless of activity, the session
// auto-disconnects after this many ms. Backstop for stuck-session
// edge cases (idle-detection failure, abandoned tabs, etc.).
// Set from voice-prefs.fullAgentSessionMaxMin; 0 = no max.
let sessionMaxTimer: ReturnType<typeof setTimeout> | null = null;
let sessionMaxMs = 30 * 60_000;

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function clearSessionMaxTimer(): void {
  if (sessionMaxTimer) {
    clearTimeout(sessionMaxTimer);
    sessionMaxTimer = null;
  }
}

/**
 * Arm the hard session-max timer at session-start. Runs ONCE — does
 * NOT reset on activity. The whole point is to bound worst-case
 * billable duration regardless of how active the session is.
 */
function armSessionMaxTimer(): void {
  clearSessionMaxTimer();
  if (sessionMaxMs <= 0) return;
  if (!realtimeSession) return;
  sessionMaxTimer = setTimeout(() => {
    sessionMaxTimer = null;
    if (!realtimeSession) return;
    const labelMin = Math.round(sessionMaxMs / 60_000);
    void emitVoiceToast(
      'info',
      `Voice session hit ${labelMin}m max — disconnecting. Tap the button to start another.`,
    );
    stopRealtimeSession();
    setState({ status: state.mode === 'off' ? 'off' : 'idle' });
  }, sessionMaxMs);
}

function armIdleTimer(): void {
  clearIdleTimer();
  if (idleTimeoutMs <= 0) return;
  if (!realtimeSession) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!realtimeSession) return;
    const labelMin = Math.round(idleTimeoutMs / 60_000);
    const labelSec = Math.round(idleTimeoutMs / 1000);
    const label = labelMin >= 1 ? `${labelMin}m` : `${labelSec}s`;
    void emitVoiceToast('info', wakeGated
      ? `Voice idle ${label} — going back to wake-word listening.`
      : `Voice idle ${label} — disconnecting to save minutes. Tap the button to resume.`);
    stopRealtimeSession();
    setState({ status: state.mode === 'off' ? 'off' : 'idle' });
    // Wake-word-gated mode: restart the local listener so the next
    // wake utterance brings the session back. Always-on mode just
    // sits idle until the user taps the button again.
    if (wakeGated && state.mode !== 'off') {
      void startWakeWordGate(wakeGatedPrefsCache).catch(() => {});
    }
  }, idleTimeoutMs);
}

/** Public hook so other modules can reset the idle clock. */
/**
 * Push a system-style note into the live EL session so the agent
 * sees it on its next turn. Used by the async delegate path: when
 * a long delegate finishes, the OperatorDelegationListener calls
 * this with the result headline so the agent can speak about it
 * naturally instead of having said "looking into that" minutes ago
 * and never followed up.
 *
 * No-op when there's no active full-agent session (the user might
 * be on the Whisper-only path, or have voice off entirely). Result
 * still lands in the panel via the parallel
 * operator:delegation-complete event.
 */
export function sendSystemToActiveSession(text: string): boolean {
  if (!realtimeSession?.sendSystem) return false;
  try {
    realtimeSession.sendSystem(text);
    return true;
  } catch (e) {
    console.warn('[voice-mode] sendSystem failed:', e);
    return false;
  }
}

export function nudgeFullAgentIdle(): void {
  if (realtimeSession) armIdleTimer();
}

/**
 * Drain the operator's coord-inbox hindsight channel into the live EL session
 * (collapse-delegate D-003 — replaced the bespoke delegate-inbox poll). Folds all
 * pending notifications into a single contextual update so the agent gets one
 * compact briefing, not a flood. No-op if nothing pending or no session.
 */
async function drainHindsightOnConnect(): Promise<void> {
  if (!realtimeSession?.sendSystem) return;
  try {
    const r = await fetch('/api/agent-mcp/operator-hindsight?drain=1');
    if (!r.ok) return;
    const data = await r.json();
    const items: Array<{ headline: string }> = data?.items ?? [];
    if (items.length === 0) return;
    const header = items.length === 1
      ? '[While you were away, 1 update]'
      : `[While you were away, ${items.length} updates]`;
    const body = items.map((it, i) => `${i + 1}. ${it.headline}`).join(' ');
    realtimeSession.sendSystem(`${header} ${body}`);
  } catch (e) {
    console.warn('[voice-mode] inbox drain failed:', e);
  }
}

// Tracks the in-flight stop so a re-entry (rapid off→on, focus-follows-
// tab swap, syncSttToLeader cascade) waits for the previous session's
// mic track to fully release before getUserMedia retries. Without this
// gate, Chrome throws NotReadableError → 'Could not start audio source'
// because the device looks busy mid-teardown.
let stopInFlight: Promise<void> | null = null;
function stopRealtimeSession(): Promise<void> {
  clearIdleTimer();
  clearSessionMaxTimer();
  if (!realtimeSession) return stopInFlight ?? Promise.resolve();
  const session = realtimeSession;
  realtimeSession = null;
  setState({ micOwnedByFullAgent: false });
  stopInFlight = (async () => {
    try { await session.stop(); }
    catch { /* swallow — best effort */ }
    // Belt-and-suspenders: a tiny grace window for Chrome to flush the
    // device handle. The SDK's endSession resolves before the underlying
    // MediaStreamTrack.stop() has propagated to the OS-level audio
    // session, so a follow-up getUserMedia on the same tick can still
    // see the device busy. 150ms is below user-perceptible delay and
    // empirically enough on macOS/Linux/Windows.
    await new Promise<void>((res) => setTimeout(res, 150));
  })();
  stopInFlight.finally(() => { stopInFlight = null; });
  return stopInFlight;
}

/** Public wait-for-stop used by maybeStartFullAgent before re-acquiring. */
export function waitForRealtimeSessionStop(): Promise<void> {
  return stopInFlight ?? Promise.resolve();
}

// ── Wake-word-gated EL session ──────────────────────────────────────
// When voicePrivacyMode='wake-word-gated', the local wake-word engine
// (Porcupine / openWakeWord) listens on-device. mic-to-EL streaming
// only happens between wake-fire and idle-disconnect.

let wakeGated = false;
let wakeGatedPrefsCache: any = null;
let wakeGateHandle: { stop(): Promise<void> } | null = null;
// In-flight-build memo (WI-37484): four independent call sites fire
// `startWakeWordGate` fire-and-forget from different triggers (the
// silence-teardown handoff, an idle-timeout re-arm, the EL-connect-failure
// retry, and the initial mode-start) — realistically concurrent, e.g. the
// silence-teardown listener and an idle-timeout re-arm landing in the same
// tick. The old code was a bare check-then-act: `if (wakeGateHandle) return
// true;` followed by a `fetch`/dynamic-import/engine-start await chain
// before the assignment. Two overlapping callers each passed the guard,
// each started its OWN wake-word engine capture (mic handle), and only the
// last assignment survived — the other listener was never stopped and leaked
// the mic-capture handle. Mirrors the reentrancy-guard already used
// correctly by `maybeStartFullAgent`'s `fullAgentStarting` memo above.
let wakeGateStarting: Promise<boolean> | null = null;

async function startWakeWordGate(prefs: any): Promise<boolean> {
  if (wakeGateHandle) return true;
  if (wakeGateStarting) return wakeGateStarting;
  wakeGateStarting = startWakeWordGateInner(prefs).finally(() => {
    wakeGateStarting = null;
  });
  return wakeGateStarting;
}

async function startWakeWordGateInner(prefs: any): Promise<boolean> {
  // Pick the engine: prefs.wakeWordEngine ('porcupine' | 'openwakeword').
  // 'off' is invalid here — the gated path requires a real engine.
  const engine = prefs?.wakeWordEngine ?? 'off';
  if (engine === 'off') {
    void emitVoiceToast(
      'error',
      'Wake-word-gated privacy mode needs a wake-word engine. Set wakeWordEngine to porcupine or openwakeword in /settings/voice.',
    );
    return false;
  }
  if (isWakeEngineUnavailable(engine)) {
    void emitVoiceToast('error', releaseUnavailableMessage(engine));
    return false;
  }
  try {
    if (engine === 'porcupine') {
      const bootR = await fetch('/api/agent-mcp/operator-picovoice-bootstrap').catch(() => null);
      if (!bootR?.ok) {
        void emitVoiceToast('error', 'Wake-word gate: missing Picovoice key. Add it in /settings/api-keys.');
        return false;
      }
      const apiKey: string | null = (await bootR.json())?.apiKey ?? null;
      if (!apiKey) return false;
      const { startWakeWordDetection } = await import('@papercusp/operator-core/lib/voice-engines/porcupine');
      wakeGateHandle = await startWakeWordDetection({
        accessKey: apiKey,
        keyword: prefs.porcupineKeyword ?? 'Computer',
        onWake: () => { signalWakeDetected(); void onWakeFireGated(prefs); },
        onError: (err) => console.warn('[wake-gate]', err),
      });
    } else if (engine === 'openwakeword') {
      const { startOpenWakeWordDetection } = await import('@papercusp/operator-core/lib/voice-engines/openwakeword');
      wakeGateHandle = await startOpenWakeWordDetection({
        keyword: prefs.openwakewordKeyword ?? 'hey_jarvis',
        threshold: 0.5,
        onWake: () => { signalWakeDetected(); void onWakeFireGated(prefs); },
        onError: (err) => console.warn('[wake-gate]', err),
      });
    } else {
      return false;
    }
    setState({ status: 'idle' });
    setWakeListening(true);
    void emitVoiceToast('info', `Listening for "${prefs.porcupineKeyword ?? prefs.openwakewordKeyword ?? 'wake word'}". Mic stays on-device until you say it.`);
    return true;
  } catch (err) {
    console.warn('[wake-gate] start failed:', err);
    return false;
  }
}

function stopWakeWordGate(): void {
  if (!wakeGateHandle) return;
  void wakeGateHandle.stop().catch(() => {});
  wakeGateHandle = null;
  setWakeListening(false);
}

async function onWakeFireGated(prefs: any): Promise<void> {
  // Tear down the local listener before bringing up EL — they share
  // the mic and Porcupine's stream is in the way of EL's WebRTC capture.
  stopWakeWordGate();
  // Honor the per-gated idle budget rather than the always-on default.
  const gatedSec = Math.max(5, Math.min(300, Number(prefs?.wakeGatedIdleTimeoutSec ?? 20)));
  idleTimeoutMs = gatedSec * 1000;
  const ok = await startElevenLabsConvAgent(prefs);
  if (!ok) {
    // Failed to bring up EL — go back to listening so the user can retry.
    void startWakeWordGate(prefs).catch(() => {});
  }
}

let fullAgentStarting: Promise<boolean> | null = null;

async function maybeStartFullAgent(): Promise<boolean> {
  if (realtimeSession) return true;
  // Reentrancy guard: syncSttToLeader can fire from multiple sources
  // (tab focus, leader-change, mode-change) within the same tick. Without
  // this, two concurrent startElevenLabsConv calls each call
  // getUserMedia — Chrome arbitrates by giving one a working track and
  // the other a silent one, and EL ends up with the silent one (zero
  // audio in/out for the entire session).
  if (fullAgentStarting) return fullAgentStarting;
  fullAgentStarting = (async () => {
    try {
      // Wait for any in-flight stop from a previous session to fully
      // release the device before we acquire it again. Without this,
      // a quick off→on toggle (or a focus-follows-tab handover) calls
      // getUserMedia while Chrome's still tearing down the previous
      // track, which throws NotReadableError → "Could not start audio
      // source" → fallback to Whisper. The wait is bounded inside
      // stopRealtimeSession (~150ms) so it's invisible if there's no
      // prior session.
      await waitForRealtimeSessionStop();
      return await maybeStartFullAgentInner();
    } finally { fullAgentStarting = null; }
  })();
  return fullAgentStarting;
}

async function maybeStartFullAgentInner(): Promise<boolean> {
  // Optimistically show "Connecting…" + claim the mic so useMicLevel
  // does NOT spin up its own getUserMedia in the gap between the
  // mode-change and the EL SDK's mic acquisition. Two consumers in
  // close succession on Chrome can leave EL's published track silent
  // (60s ICE timeout, no audio reaches the agent — exact field bug).
  // Reset both below if no full-agent engine ends up applying.
  if (state.mode !== 'off' && state.status !== 'connecting') {
    setState({ status: 'connecting', micOwnedByFullAgent: true });
  }
  const resetIfNotStarted = () => {
    if (!realtimeSession && state.status === 'connecting') {
      setState({
        status: state.mode === 'off' ? 'off' : 'idle',
        micOwnedByFullAgent: false,
      });
    }
  };
  // Track which "stage" we reached so the failure toast can point at the
  // exact thing that broke (prefs / bootstrap / SDK connect / runtime err).
  let stage: 'prefs' | 'bootstrap' | 'connect' | 'runtime' = 'prefs';
  try {
    // 30s timeout: Next.js dev cold-compile of this route can take 7-15s
    // on first hit, and voice-mode auto-restores on every page load when the
    // user previously enabled it. 10s was right at the boundary and we'd
    // see a startup "[voice] realtime start failed at stage=prefs" warning
    // on a cold tab; 30s leaves headroom without affecting a real hang.
    const prefs = loadVoicePrefsClient();
    // Preserve legacy preferences, but never silently route a selected
    // unsupported full-agent provider through local microphone capture.
    // Release scope (voice-final-public-release-2026-10-01#D-005) covers every
    // engine in the shared release list, Gemini included.
    if (isFullAgentEngineUnavailable(prefs.fullAgentEngine)) {
      setVoiceMode('off');
      void emitVoiceToast('error', releaseUnavailableMessage(String(prefs.fullAgentEngine)));
      return true; // Handled: suppress the caller's local-STT fallback.
    }
    // Pull idle-timeout pref so both EL and Realtime paths can use it.
    if (typeof prefs.fullAgentIdleTimeoutMin === 'number') {
      idleTimeoutMs = Math.max(0, prefs.fullAgentIdleTimeoutMin) * 60_000;
    }
    // Pull session-max pref. Hard ceiling regardless of activity.
    if (typeof prefs.fullAgentSessionMaxMin === 'number') {
      sessionMaxMs = Math.max(0, prefs.fullAgentSessionMaxMin) * 60_000;
    }
    // Wake-word-gated mode: don't open EL/Realtime yet — start the local
    // wake-word engine instead. The onWake callback brings up EL only
    // when the wake word fires.
    wakeGated = prefs.voicePrivacyMode === 'wake-word-gated';
    wakeGatedPrefsCache = prefs;
    if (wakeGated && (prefs.fullAgentEngine === 'elevenlabs-conv' || prefs.fullAgentEngine === 'elevenlabs-conversational' || prefs.fullAgentEngine === 'openai-realtime')) {
      const started = await startWakeWordGate(prefs);
      // Even if the gate failed to start, return true so we don't fall
      // through to Whisper-always-on; surfacing the error toast is enough.
      return started;
    }
    // WebRTC is required by both ElevenLabs Conv (LiveKit) and OpenAI
    // Realtime (RTCPeerConnection). WebKitGTK (Tauri's webview on
    // Linux) ships without WebRTC, so any attempt produces a noisy
    // toast every page load. Silently fall through to Whisper on
    // engines that need WebRTC when the API isn't available.
    const engineNeedsWebRTC =
      prefs.fullAgentEngine === 'elevenlabs-conv' ||
      prefs.fullAgentEngine === 'elevenlabs-conversational' ||
      prefs.fullAgentEngine === 'openai-realtime';
    if (engineNeedsWebRTC && typeof RTCPeerConnection === 'undefined') {
      debugLog('full-agent:webrtc-unsupported', { engine: prefs.fullAgentEngine });
      return false;
    }
    // ElevenLabs Conv AI — primary path in v5+
    if (prefs.fullAgentEngine === 'elevenlabs-conv' || prefs.fullAgentEngine === 'elevenlabs-conversational') {
      // Spend-cap check. Skip silently if the endpoint isn't reachable
      // (degraded mode); refuse only on a hard "over_cap: true". Warn
      // (toast, don't refuse) at 80% so the user has time to react.
      try {
        const sr = await fetch('/api/agent-mcp/operator-el-spend', { signal: AbortSignal.timeout(5000) });
        if (sr.ok) {
          const spend = await sr.json() as {
            over_cap?: boolean; minutes_used?: number; minutes_cap?: number | null; pct_used?: number | null;
          };
          if (spend.over_cap) {
            void emitVoiceToast(
              'error',
              `EL monthly cap hit (${spend.minutes_used}/${spend.minutes_cap} min). Raise the cap in /settings/voice or wait for next month.`,
            );
            return false;
          }
          if (spend.pct_used != null && spend.pct_used >= 0.8 && spend.minutes_cap) {
            void emitVoiceToast(
              'info',
              `EL usage ${Math.round((spend.pct_used) * 100)}% of monthly cap (${spend.minutes_used}/${spend.minutes_cap} min). Auto-disconnect after idle keeps the meter down.`,
            );
          }
        }
      } catch { /* fail-open if check is broken — the user explicitly toggled voice on */ }
      return await startElevenLabsConvAgent(prefs);
    }
    if (prefs.fullAgentEngine !== 'openai-realtime') return false;
    stage = 'bootstrap';
    const bootR = await fetch('/api/agent-mcp/operator-realtime-bootstrap');
    if (!bootR.ok) {
      void emitVoiceToast('error', `Realtime: bootstrap returned ${bootR.status}. Check OpenAI key in /settings/api-keys.`);
      return false;
    }
    const { apiKey } = await bootR.json();
    if (!apiKey) {
      void emitVoiceToast('error', 'Realtime: no OpenAI key. Add one in /settings/api-keys.');
      return false;
    }
    stage = 'connect';
    const { startRealtimeSession } = await import('@papercusp/operator-core/lib/voice-engines/openai-realtime');
    // Same tag observer as the EL Conv AI path — operator can flip
    // mode / set sleep timer via tags emitted in either voice engine.
    const realtimeTagObserver = createOperatorVoiceTagObserver();
    realtimeSession = await startRealtimeSession(apiKey, {
      onTranscript: (text) => {
        setState({ lastTranscript: text });
        void persistOperatorVoiceTurn({ role: 'user', text, source: 'voice_stt' });
        emitOperatorUserTurn(text, 'providerSTT');
        // Idle = USER idle. Resetting on agent transcripts too lets a
        // chatty agent keep the session alive indefinitely, defeating
        // the timeout. EL credit-burn audit, fix #2.
        nudgeFullAgentIdle();
      },
      onAssistantText: (text) => {
        realtimeTagObserver.push(text);
        void persistOperatorVoiceTurn({ role: 'assistant', text, source: 'voice_tts' });
        // Intentionally NOT calling nudgeFullAgentIdle() here. See above.
      },
      onError: (err) => {
        console.error('[realtime]', err);
        try { realtimeTagObserver.flush(); realtimeTagObserver.dispose(); } catch { /* ignore */ }
        void emitVoiceToast('error', `Realtime runtime error: ${err?.message ?? String(err)}`);
      },
    });
    setState({ status: 'listening', micOwnedByFullAgent: true });
    void emitVoiceToast('info', 'Realtime connected — speak to talk to the operator.');
    armIdleTimer();
    armSessionMaxTimer();
    return true;
  } catch (err: any) {
    const errName = err?.name ?? '';
    const errMsg = err?.message ?? String(err);
    const msg = errName ? `${errName}: ${errMsg}` : errMsg;
    debugLog('realtime:start-failed', { stage, msg });
    // Suppress the user-facing toast for fetch-cancellation / network
    // teardown errors — voice auto-restores on every page load and the
    // in-flight fetch from the previous mount gets cancelled, which
    // WebKit reports as "AbortError" / "TimeoutError" / "Load failed"
    // depending on the platform/timing. Whisper fallback still happens
    // via the return false; only debugLog records it.
    const isTransient =
      errName === 'AbortError' ||
      errName === 'TimeoutError' ||
      /aborted|abort\b|Load failed|Fetch is aborted|signal timed out/i.test(errMsg);
    if (!isTransient) {
      void emitVoiceToast('error', `Realtime failed at ${stage}: ${err?.message ?? String(err)}. Falling back to Whisper.`);
    }
    return false;
  } finally {
    // Always clear the optimistic 'connecting' if no session ended up
    // attached — covers every early-return path inside the try block.
    resetIfNotStarted();
  }
}

// ── ElevenLabs Conv AI ──────────────────────────────────────────────────

function debugLog(event: string, detail?: unknown): void {
  if (typeof window === 'undefined') return;
  console.log(`[voice-debug] ${event}`, detail ?? '');
  void fetch('/api/agent-mcp/voice-debug', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event, detail, ts: Date.now() }),
  }).catch(() => { /* best-effort */ });
}

// ── Shared-session control surface (discord-shortcuts 2026-06-06) ──────────
// The active bus runtime, exposed module-level so global shortcut handlers
// (Mod+Shift+M mute / Mod+Shift+D deafen — GlobalVoiceShortcuts) can drive
// the ONE shared session without reaching into the closure below.
// `operatorVoiceMuted` mirrors the host's authoritative session_state
// broadcasts (with an optimistic flip on toggle so rapid presses behave).
let operatorVoiceRuntime: OperatorVoiceRuntime | null = null;
let operatorVoiceMuted = false;
let operatorVoiceMode: VoiceMode = 'off';

export interface OperatorVoiceSessionUiState {
  active: boolean;
  muted: boolean;
  deafened: boolean;
  mode: VoiceMode;
  elected: boolean;
}

function emitOperatorVoiceSessionStateChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('papercusp:operatorVoiceSessionStateChanged', {
      detail: getOperatorVoiceSessionUiState(),
    }),
  );
}

export function getOperatorVoiceRuntime(): OperatorVoiceRuntime | null {
  return operatorVoiceRuntime;
}

export function getOperatorVoiceSessionUiState(): OperatorVoiceSessionUiState {
  return {
    active: operatorVoiceRuntime !== null,
    muted: operatorVoiceMuted,
    deafened: operatorVoiceRuntime?.isDeafened() ?? false,
    mode: operatorVoiceMode,
    elected: operatorVoiceRuntime?.isElected() ?? false,
  };
}

/**
 * Toggle the shared session's mic mute. Returns false when no bus session is
 * active (caller may toast a hint). Mute is a BUS control — it applies once
 * at the session host and the authoritative state echoes back to every
 * attached surface (universal-voice-interface P-004).
 */
export function toggleOperatorVoiceMute(): boolean {
  if (!operatorVoiceRuntime) return false;
  operatorVoiceRuntime.control({ op: 'mute', muted: !operatorVoiceMuted });
  operatorVoiceMuted = !operatorVoiceMuted; // host broadcast reconciles
  emitOperatorVoiceSessionStateChanged();
  return true;
}

/**
 * Toggle LOCAL deafen — this surface keeps showing transcripts but silences
 * its own playout. Returns false when no bus session is active.
 */
export function toggleOperatorVoiceDeafen(): boolean {
  if (!operatorVoiceRuntime) return false;
  operatorVoiceRuntime.setDeafened(!operatorVoiceRuntime.isDeafened());
  emitOperatorVoiceSessionStateChanged();
  return true;
}

export function setOperatorVoiceBusMode(mode: Exclude<VoiceMode, 'off'>): boolean {
  if (!operatorVoiceRuntime) return false;
  operatorVoiceMode = mode;
  operatorVoiceRuntime.control({ op: 'set-mode', mode });
  emitOperatorVoiceSessionStateChanged();
  return true;
}

export function toggleOperatorVoiceBusMode(): boolean {
  const nextMode = operatorVoiceMode === 'push-to-talk' ? 'always-on' : 'push-to-talk';
  return setOperatorVoiceBusMode(nextMode);
}

export function forceOperatorVoiceHost(): boolean {
  if (!operatorVoiceRuntime) return false;
  operatorVoiceRuntime.control({ op: 'force-host' });
  return true;
}

export function setOperatorVoicePtt(down: boolean): boolean {
  if (!operatorVoiceRuntime) return false;
  operatorVoiceRuntime.control({ op: 'ptt', down });
  if (!down && operatorVoiceMode != 'push-to-talk') {
    return true;
  }
  emitOperatorVoiceSessionStateChanged();
  return true;
}

async function startElevenLabsConvAgent(_prefs: unknown): Promise<boolean> {
  debugLog('el-conv:start-attempt', { mode: state.mode });
  // Claim the mic so useMicLevel's analyzer doesn't also open getUserMedia —
  // the runtime captures it for the shared session below.
  setState({ micOwnedByFullAgent: true });
  // Universal voice (universal-voice-interface-2026-06-05, P-008): the desktop
  // no longer starts its OWN ElevenLabs WebRTC session. It attaches to the ONE
  // shared EL/operator session hosted by the voice service, over the
  // desktop-voice-ws bus. The host mints the EL URL, runs the brain, persists
  // the turns once (P-010), and streams input + response to every attached
  // client; only the lease-elected client plays audio + captures the mic
  // (Model A). voice-mode here is a thin client of that session.
  let activeRuntime: OperatorVoiceRuntime | null = null;
  // The agent's turn may carry <set_mode>/<sleep> tags that flip the navbar
  // toggle — the same dispatcher the text path uses. <say> is NOT re-rendered
  // (the host's TTS already spoke it).
  const tagObserver = createOperatorVoiceTagObserver();
  const disposeObserver = () => {
    try {
      tagObserver.flush();
      tagObserver.dispose();
    } catch {
      /* ignore */
    }
  };
  try {
    const tabId = getOrAssignTabId();
    const runtime = await startDesktopOperatorVoice({
      clientId: tabId,
      label: 'Desktop',
      onInputTranscript: (text, final) => {
        setState({ lastTranscript: text });
        if (!final) return;
        debugLog('el-conv:user-transcript', { text });
        pulseUserSpoken();
        if (text && text.trim().length > 1) onUtteranceFinal(text, 'providerSTT');
        emitOperatorUserTurn(text, 'providerSTT');
        nudgeFullAgentIdle();
        // The HOST persists this user turn once to the shared operator
        // conversation (P-010) — the desktop no longer double-writes it.
      },
      onResponseTranscript: (text) => {
        debugLog('el-conv:agent-text', { text: String(text).slice(0, 200) });
        tagObserver.push(text);
        // Host persists the assistant turn once (P-010) — no desktop write.
      },
      onState: (s) => {
        // Mirror the host's authoritative mute flag for the toggle shortcut.
        operatorVoiceMuted = !!s.muted;
        operatorVoiceMode = s.mode === 'push-to-talk' ? 'push-to-talk' : 'always-on';
        emitOperatorVoiceSessionStateChanged();
        switch (s.status) {
          case 'connecting':
            setState({ status: 'connecting' });
            return;
          case 'idle':
          case 'listening':
          case 'speaking':
            setState({ status: s.status, micOwnedByFullAgent: true });
            return;
          case 'off':
            // pre-start / settling echo — not terminal, ignore.
            return;
          case 'ended':
          case 'error': {
            disposeObserver();
            void activeRuntime?.stop();
            activeRuntime = null;
            operatorVoiceRuntime = null;
            operatorVoiceMode = 'off';
            emitOperatorVoiceSessionStateChanged();
            realtimeSession = null;
            setState({ status: state.mode === 'off' ? 'off' : 'idle', micOwnedByFullAgent: false });
            if (s.reason) {
              void emitVoiceToast(s.status === 'error' ? 'error' : 'info', `Voice: ${s.reason}`);
            }
            return;
          }
        }
      },
      onError: (err) => {
        const m = (err as { message?: string })?.message ?? String(err);
        debugLog('el-conv:error', { m });
        void emitVoiceToast('error', `Voice runtime error: ${m}`);
      },
    });
    activeRuntime = runtime;
    operatorVoiceRuntime = runtime;
    emitOperatorVoiceSessionStateChanged();
    realtimeSession = {
      async stop() {
        disposeObserver();
        await activeRuntime?.stop();
        activeRuntime = null;
        operatorVoiceRuntime = null;
        operatorVoiceMode = 'off';
        emitOperatorVoiceSessionStateChanged();
      },
    };
    setState({ status: 'connecting', micOwnedByFullAgent: true });
    armIdleTimer();
    armSessionMaxTimer();
    // Hindsight inbox: deliver async-delegate completions that arrived while no
    // session was live, once the session is up.
    setTimeout(() => {
      void drainHindsightOnConnect();
    }, 1500);
    void emitVoiceToast('info', 'Voice connected — talking to the shared operator session.');
    return true;
  } catch (err: any) {
    disposeObserver();
    void activeRuntime?.stop();
    activeRuntime = null;
    operatorVoiceRuntime = null;
    operatorVoiceMode = 'off';
    emitOperatorVoiceSessionStateChanged();
    const errName = err?.name ?? '';
    const errMsg = err?.message ?? String(err);
    debugLog('el-conv:start-failed', { msg: errMsg });
    // Suppress the toast for fetch-cancellation / network-teardown errors —
    // voice auto-restores on every page load and an in-flight connect from the
    // previous mount gets cancelled. Whisper fallback still happens via the
    // return false; debugLog records the detail. Real failures still toast.
    const isTransient =
      errName === 'AbortError' ||
      errName === 'TimeoutError' ||
      /aborted|abort\b|Load failed|Fetch is aborted|signal timed out|signaling failed/i.test(errMsg);
    if (!isTransient) {
      void emitVoiceToast('error', `Voice failed to attach: ${errMsg}. Falling back to Whisper.`);
    }
    setState({ status: state.mode === 'off' ? 'off' : 'idle', micOwnedByFullAgent: false });
    return false;
  }
}

function getOrAssignTabId(): string {
  if (typeof window === 'undefined') return 'srv';
  const KEY = 'pc-voice-tab-id';
  let id = window.sessionStorage.getItem(KEY);
  if (!id) {
    id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(KEY, id);
  }
  return id;
}

// getBrowserWorkspaceId now lives in @/lib/browser-workspace (imported above)
// — it additionally prefers the host-injected window.__PAPERCUSP_WS__ global.

// Best-effort sonner toast — sonner only ships in the browser bundle, so
// a dynamic import keeps the SSR build clean.
async function emitVoiceToast(
  level: 'info' | 'error',
  text: string,
  opts?: { actionLabel?: string; onAction?: () => void },
): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const { toast } = await import('sonner');
    const action = opts?.actionLabel && opts?.onAction
      ? { label: opts.actionLabel, onClick: opts.onAction }
      : undefined;
    if (level === 'error') toast.error(text, { duration: 8000, action });
    else toast(text, { action });
  } catch { /* sonner not in bundle on this page; drop */ }
}

// React to leader-election changes: when we're newly elected leader,
// start STT; when we lose leadership, stop. Subscribed once at module
// load. Also opens the cross-process SSE bridge (so cross-process callers
// like Oracle / EL webhook can deliver browser:'required' commands here).
if (typeof window !== 'undefined') {
  void (async () => {
    try {
      const { subscribeVoiceLeader, bootVoiceLeader, getVoiceLeaderState, requestVoiceLead } =
        await import('./voice-leader');
      await bootVoiceLeader();
      // Track previous leadership so we only toast on actual transitions.
      let prevIsLeader = getVoiceLeaderState().isLeader;
      subscribeVoiceLeader((ls) => {
        // Toast only when voice is on (mode !== 'off'); silent otherwise so
        // dormant tabs don't flash unrelated notifications.
        if (state.mode !== 'off' && ls.available && ls.isLeader !== prevIsLeader) {
          if (ls.isLeader) {
            void emitVoiceToast('info', 'Listening here now');
          } else {
            void emitVoiceToast('info', 'Listening moved to another tab — click to bring back', {
              actionLabel: 'Bring back',
              onAction: () => requestVoiceLead('toast-action'),
            });
          }
        }
        prevIsLeader = ls.isLeader;
        if (state.mode !== 'off') syncSttToLeader();
      });

      // Focus-follows-tab leadership: when this tab is visible+focused
      // for FOCUS_TAKEOVER_DELAY_MS continuously, take the lead. The
      // delay prevents a quick alt-tab from thrashing the EL session
      // (each handover tears down the WebRTC PC + frees a workspace
      // concurrency slot, which the new leader's connect must re-claim
      // — flapping at 1Hz would be expensive).
      //
      // Cancellation: any visibility loss before the timer fires
      // discards the pending takeover. Only sustained focus claims it.
      const FOCUS_TAKEOVER_DELAY_MS = 4_000;
      let focusTakeoverTimer: ReturnType<typeof setTimeout> | null = null;
      const cancelFocusTakeover = () => {
        if (focusTakeoverTimer) {
          clearTimeout(focusTakeoverTimer);
          focusTakeoverTimer = null;
        }
      };
      const scheduleFocusTakeover = () => {
        cancelFocusTakeover();
        // Skip when there's nothing to take: voice off, or we're
        // already leader, or we're in single-tab fallback mode.
        if (state.mode === 'off') return;
        const ls = getVoiceLeaderState();
        if (!ls.available || ls.isLeader) return;
        focusTakeoverTimer = setTimeout(() => {
          focusTakeoverTimer = null;
          // Re-check at fire time — state may have flipped.
          if (state.mode === 'off') return;
          const cur = getVoiceLeaderState();
          if (!cur.available || cur.isLeader) return;
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
          requestVoiceLead('focus-follows-tab');
        }, FOCUS_TAKEOVER_DELAY_MS);
      };
      const onVisibility = () => {
        if (document.visibilityState === 'visible') scheduleFocusTakeover();
        else cancelFocusTakeover();
      };
      window.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('focus', scheduleFocusTakeover);
      window.addEventListener('blur', cancelFocusTakeover);
      // If the page is already visible at boot (likely), arm the timer
      // so a tab that loads while focused earns the lead after the
      // delay. Without this, a freshly-opened-already-focused tab
      // would only take over after the user blur+focuses it.
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        scheduleFocusTakeover();
      }

      // Leader-bridge wiring: subscribe to the SSE channel when we're
      // the elected leader for the workspace. Cross-process callers
      // (Oracle MCP, EL webhook, Pi) deliver 'browser:required' commands
      // through this bridge. See plan §3.3.
      const { startLeaderBridge } = await import('@papercusp/operator-core/lib/commands/leader-bridge');
      // NOTE: '/index' is load-bearing — operator-core's exports map is
      // `"./lib/*": "./lib/*.ts"`, so a bare directory subpath resolves to
      // a nonexistent `defs.ts` and 500s the whole Vite module graph.
      await import('@papercusp/operator-core/lib/commands/defs/index');
      let teardown: (() => void) | null = null;
      const leaderListeners = new Set<() => void>();
      const bridgeOpts = {
        getWorkspace: () => getBrowserWorkspaceId(),
        isLeader: () => getVoiceLeaderState().isLeader,
        onLeaderChange: (cb: () => void) => {
          leaderListeners.add(cb);
          return () => leaderListeners.delete(cb);
        },
        tabId: getOrAssignTabId(),
      };
      teardown = startLeaderBridge(bridgeOpts);
      subscribeVoiceLeader(() => {
        for (const cb of leaderListeners) cb();
      });
      // Re-bridge on workspace change (URL nav).
      window.addEventListener('popstate', () => {
        teardown?.();
        teardown = startLeaderBridge(bridgeOpts);
      });
    } catch { /* leader module missing — STT runs ungated, prior behavior */ }
  })();
}

let whisperCapture: { stop(): void } | null = null;
let porcupineHandle: { stop(): Promise<void> } | null = null;
// Raw push-to-talk capture (voicemode whisper engine). Unlike the streaming
// `whisperCapture` above (Silero VAD, which can't load on WebKitGTK), this
// records the whole hold and transcribes on release — see ./ptt-capture.
let pttRawCapture: PttRawCapture | null = null;
// True between startPushToTalk and stopPushToTalk. Lets the async capture
// startup tear itself down if the user already released (prevents an orphaned
// mic stream when the hold ends before getUserMedia resolves).
let pttActive = false;

const VOICEMODE_WHISPER_URL = 'http://localhost:2022';

async function maybeStartWakeWordGate(prefs: any): Promise<boolean> {
  // Returns true if a wake-word engine took over (Whisper should NOT
  // also run continuously). The wake-word engine fires onWake → we spin
  // up Whisper once for the command utterance, then return to gating.
  const engine = prefs.wakeWordEngine ?? 'off';
  if (engine === 'off') return false;
  if (isWakeEngineUnavailable(engine)) {
    // Visible refusal; the caller keeps its non-gated path, as it already does
    // when a Picovoice key is missing.
    void emitVoiceToast('error', releaseUnavailableMessage(engine));
    return false;
  }

  if (engine === 'porcupine') {
    // Porcupine needs a Picovoice access key.
    const bootR = await fetch('/api/agent-mcp/operator-picovoice-bootstrap').catch(() => null);
    if (!bootR?.ok) return false;
    const apiKey: string | null = (await bootR.json())?.apiKey ?? null;
    if (!apiKey) return false;
    try {
      const { startWakeWordDetection } = await import('@papercusp/operator-core/lib/voice-engines/porcupine');
      porcupineHandle = await startWakeWordDetection({
        accessKey: apiKey,
        keyword: prefs.porcupineKeyword ?? 'Computer',
        onWake: () => {
          signalWakeDetected();
          void runOneShotWhisperAfterWake().catch(() => {});
        },
        onError: (err) => console.warn('[porcupine]', err),
      });
      setWakeListening(true);
      return true;
    } catch (err) {
      console.warn('[voice] porcupine start failed; falling back:', err);
      return false;
    }
  }

  if (engine === 'openwakeword') {
    // No key required — Apache 2.0, models downloaded from upstream release.
    try {
      const { startOpenWakeWordDetection } = await import('@papercusp/operator-core/lib/voice-engines/openwakeword');
      porcupineHandle = await startOpenWakeWordDetection({
        keyword: prefs.openwakewordKeyword ?? 'hey_jarvis',
        threshold: 0.5,
        onWake: () => {
          signalWakeDetected();
          void runOneShotWhisperAfterWake().catch(() => {});
        },
        onError: (err) => console.warn('[openwakeword]', err),
      });
      setWakeListening(true);
      return true;
    } catch (err) {
      console.warn('[voice] openwakeword start failed; falling back:', err);
      return false;
    }
  }

  return false;
}

// In-flight-build memo (WI-37484): both wake-engine `onWake` callbacks funnel
// here fire-and-forget, and a single engine CAN fire `onWake` twice in quick
// succession (a fast repeated utterance / an engine-level double-trigger).
// The old code was a bare check-then-act — `if (whisperCapture) return;`
// followed by a `fetch` health-probe + dynamic-import + capture-start await
// chain before the assignment — so a second `onWake` landing inside that
// window passed the guard too, started its OWN whisper capture against the
// same local server, and only the last assignment survived: the first
// capture's audio session was never stopped and leaked.
let whisperCaptureStarting: Promise<void> | null = null;

async function runOneShotWhisperAfterWake(): Promise<void> {
  if (whisperCapture) return; // already running
  if (whisperCaptureStarting) return whisperCaptureStarting;
  whisperCaptureStarting = runOneShotWhisperAfterWakeInner().finally(() => {
    whisperCaptureStarting = null;
  });
  return whisperCaptureStarting;
}

async function runOneShotWhisperAfterWakeInner(): Promise<void> {
  // Use whatever STT engine is configured (Voicemode whisper / Deepgram).
  // The Whisper capture's first onFinal handler ships the transcript; we
  // then tear it down and resume Porcupine gating.
  const probe = await fetch('http://localhost:2022/health', { signal: AbortSignal.timeout(2000) }).catch(() => null);
  if (!probe?.ok) return;
  if (whisperCapture) return; // a concurrent onWake already won the race
  const { startWhisperCapture } = await import('../../../app/_components/voice/stt-voicemode');
  let fired = false;
  whisperCapture = await startWhisperCapture('http://localhost:2022', {
    onFinal: (text, capture) => {
      if (fired) return;
      // SAME GUARD ON THE WAKE-GATE PATH (WI-954890). This one-shot capture ran
      // outside dispatchAlwaysOnUtterance and so had NO self-audio protection at
      // all: papercup's own reply could be transcribed and dispatched as if the
      // user had spoken it. The capture window makes the check one line, so close
      // the hole here rather than leave it armed for the next reader.
      if (isSelfEchoCapture(capture)) return;
      fired = true;
      setState({ lastTranscript: text });
      // Synthesize "operator <text>" so the wake-word strip doesn't drop it.
      onUtteranceFinal(`operator ${text}`);
      stopWhisperCaptureIfRunning();
    },
  });
  // Auto-tear-down after 8s in case no transcript ever fires.
  window.setTimeout(() => {
    if (!fired) stopWhisperCaptureIfRunning();
  }, 8000);
}


// Exported for unit testing the runtime-gating truth table. Returns true when
// the Silero-VAD always-on path can't run, so capture falls through to the
// energy-gated path (or, on catch, wake-word listening).
//
// Silero runs on onnxruntime-web's THREADED wasm, which requires SharedArrayBuffer.
// Detect the REAL capability, not a proxy. The old `isTauri && isWebKit &&
// !crossOriginIsolated` heuristic was proven WRONG on WebKitGTK (WI-4498): the
// desktop webview exposes SharedArrayBuffer via the JSC_useSharedArrayBuffer runtime
// flag (set in src-tauri/main.rs) even though crossOriginIsolated stays false, so the
// proxy forced the crude energy-VAD fallback on builds that could actually run Silero.
// `typeof SharedArrayBuffer === 'undefined'` is correct everywhere: a flagless desktop
// build or a browser without cross-origin isolation lacks SAB → skip Silero → energy-VAD;
// a flagged build or an isolated browser has SAB → Silero. If SAB is present but threaded
// ort still fails to load, maybeStartWhisperCapture's try/catch falls back safely.
export function shouldSkipVoicemodeWhisperOnThisRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof SharedArrayBuffer === 'undefined';
}

async function maybeStartWhisperCapture(mode: VoiceMode): Promise<void> {
  // Only initialize whisper for always-on. PTT continues to use Web
  // Speech for now (synchronous start/stop semantics are awkward to
  // replicate over MediaRecorder VAD).
  if (mode !== 'always-on') {
    if (mode !== 'off' && mode === 'push-to-talk') {
      // PTT keeps the existing Web Speech recognizer.
      return;
    }
    return;
  }
  try {
    const prefs = loadVoicePrefsClient();
    // Porcupine gate: when enabled, run wake-word detection only.
    // Whisper spins up only on wake — big idle-CPU win.
    if (await maybeStartWakeWordGate(prefs)) return;
    if (prefs.sttEngine === 'deepgram') {
      // Deepgram streaming STT was REMOVED from operator-core (voice-engine
      // slim-down, 2026-07-09 — lib/voice-engines/deepgram.ts deleted). A
      // stored 'deepgram' preference degrades to the free wake-word path
      // instead of crashing the build/runtime on a dead dynamic import
      // (desktop-auto-update-operational-2026-07-09 release-gate fix).
      console.warn('[voice-mode] sttEngine=deepgram is no longer supported — falling back to wake-word listening');
      startWakeWordListening();
      return;
    }
    if (prefs.sttEngine !== 'voicemode') {
      startWakeWordListening();
      return;
    }
    // Detect whisper endpoint.
    const probe = await fetch(`${VOICEMODE_WHISPER_URL}/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (!probe?.ok) {
      startWakeWordListening();
      return;
    }
    if (shouldSkipVoicemodeWhisperOnThisRuntime()) {
      // Silero VAD (onnxruntime-web threaded WASM → SharedArrayBuffer) can't
      // run on the WebKitGTK desktop webview. Use energy-gated raw capture
      // instead so always-on actually listens here, transcribing each speech
      // segment via the same local whisper server.
      await startEnergyVadAlwaysOn();
      return;
    }
    const { startWhisperCapture } = await import('./stt-voicemode');
    whisperCapture = await startWhisperCapture(VOICEMODE_WHISPER_URL, {
      // P-004: always-on transcripts pass the wake-phrase gate — ambient room
      // speech is dropped; "hey papercup …" (or a follow-up inside the open
      // conversation window) dispatches to the brain.
      onFinal: (text, capture) => dispatchAlwaysOnUtterance(text, capture),
    });
    setWakeListening(true);
  } catch {
    startWakeWordListening();
  }
}

// ─── Always-on wake-phrase gate (voice-public-release-readiness P-004) ─────
//
// The always-on local loop (Silero / energy-VAD → whisper) hears EVERYTHING,
// so it must not forward ambient room speech to the brain. The gate forwards
// an utterance only when it starts with the wake phrase ("hey papercup",
// fuzzy — see matchWakePhrase) OR lands inside the follow-up conversation
// window a wake opened (so natural back-and-forth doesn't require re-waking).
// PTT is NEVER gated — pressing the button IS the user's intent.
const WAKE_CONVERSATION_WINDOW_MS = 25_000;
let wakeConversationUntil = 0;

// ── Half-duplex + hallucination guards for always-on capture (WI-4500) ──────
// The always-on energy-VAD mic runs while papercup's OWN kokoro TTS plays out the
// speakers. On the Tauri WebKitGTK webview, browser AEC (echoCancellation:true) is
// weak/absent (same platform reality as the crossOriginIsolated/SharedArrayBuffer
// gap, WI-4498), so the mic HEARS the reply. whisper.cpp then transcribes that
// self-audio — or hallucinates a stable token on the near-silent tail — and because
// the follow-up conversation window is open, the garbage dispatches AND refreshes the
// window, so papercup talks to its own echo forever. Owner saw this as papercup
// "picking up its own mic, keeps saying omid".
//
// COOLDOWN after playout ends: the speaker doesn't fall silent the instant the synth
// queue drains (buffer + room decay), so gate for a short tail too. Set by the synth
// lifecycle (processSynthQueue / barge-in cancel).
const SELF_AUDIO_COOLDOWN_MS = 700;
let synthQuietSince = 0; // wall-clock ms when TTS playout last ENDED; 0 = never spoke

/**
 * WHY THIS IS NO LONGER THE PRIMARY GUARD (WI-954890).
 *
 * This asks "is playout happening NOW?" at DISPATCH time, but it is guarding
 * audio captured much earlier, and the gap dwarfs the window: end-of-speech
 * detection alone costs 683ms on the shipped energy-VAD path, and whisper on the
 * local server adds 588ms even in the fastest run measured (≈2-3.8s for a normal
 * reply). The 700ms cooldown had therefore always expired by the time an echo
 * transcript arrived — the only branch below that ever fired on a real echo was
 * `isSynthSpeaking`, which catches mid-reply segments but never the final one.
 *
 * The real guard is now the capture-window overlap test (`isSelfEchoCapture`).
 * This is kept as the FAIL-CLOSED fallback for any caller that dispatches
 * without a capture window, where the weak answer still beats none.
 */
export function isSelfAudioLikely(nowMs: number = Date.now()): boolean {
  if (isSynthSpeaking) return true;
  if (synthQuietSince > 0 && nowMs - synthQuietSince < SELF_AUDIO_COOLDOWN_MS) return true;
  return false;
}

/**
 * When our own TTS was audible. Every playout start/stop is recorded here so a
 * captured utterance can be tested for OVERLAP instead of against a clock.
 */
const playoutLedger = new PlayoutLedger();

/**
 * Was this audio recorded while papercup's own playout was audible?
 *
 * Note what is absent: a `now` argument. That is the fix — the verdict is a
 * property of the recording, so it is the same whether the transcript arrives
 * in 200ms or 20 seconds, and no future STT latency can outrun it. Exported for
 * tests.
 */
export function isSelfEchoCapture(capture: CaptureWindow): boolean {
  return playoutLedger.overlaps(capture);
}

// Web Speech recognition does not expose a CaptureWindow, so its self-audio
// guard cannot use the capture-time PlayoutLedger without muting legitimate
// barge-in. Keep a short, bounded history of the text that actually entered
// the TTS playout queue instead, and reject only transcripts that substantially
// reproduce one of those recent utterances.
export const RECENT_SPOKEN_TTS_TTL_MS = 15_000;
export const RECENT_SPOKEN_TTS_MAX_ENTRIES = 8;
export const RECENT_SPOKEN_TTS_MIN_TOKENS = 3;
export const RECENT_SPOKEN_TTS_OVERLAP_THRESHOLD = 0.75;

function normalizeSpokenTokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function orderedTokenMatchLength(left: readonly string[], right: readonly string[]): number {
  if (!left.length || !right.length) return 0;
  // Longest common subsequence: punctuation/casing differences are removed by
  // normalizeSpokenTokens, while token order still distinguishes a real
  // barge-in from a transcript that merely shares the brand or one verb.
  const row = new Array<number>(right.length + 1).fill(0);
  for (const leftToken of left) {
    let diagonal = 0;
    for (let j = 1; j <= right.length; j++) {
      const above = row[j];
      row[j] = leftToken === right[j - 1]
        ? diagonal + 1
        : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[right.length];
}

/**
 * Return the fraction of the longer normalized token sequence that is shared
 * in order. A max-length denominator is intentional: a short user barge-in
 * must not be rejected merely because it shares two common words with a much
 * longer reply.
 */
export function orderedTokenOverlap(left: string, right: string): number {
  const leftTokens = normalizeSpokenTokens(left);
  const rightTokens = normalizeSpokenTokens(right);
  if (!leftTokens.length || !rightTokens.length) return 0;
  return orderedTokenMatchLength(leftTokens, rightTokens) /
    Math.max(leftTokens.length, rightTokens.length);
}

interface RecentSpokenTtsEntry {
  spokenAtMs: number;
  tokens: string[];
}

class RecentSpokenTtsLedger {
  private entries: RecentSpokenTtsEntry[] = [];

  record(text: string, spokenAtMs: number = Date.now()): void {
    const tokens = normalizeSpokenTokens(text);
    if (!tokens.length) return;
    this.prune(spokenAtMs);
    this.entries.push({ spokenAtMs, tokens });
    if (this.entries.length > RECENT_SPOKEN_TTS_MAX_ENTRIES) {
      this.entries = this.entries.slice(-RECENT_SPOKEN_TTS_MAX_ENTRIES);
    }
  }

  matches(text: string, nowMs: number = Date.now()): boolean {
    const tokens = normalizeSpokenTokens(text);
    if (tokens.length < RECENT_SPOKEN_TTS_MIN_TOKENS) return false;
    this.prune(nowMs);
    return this.entries.some((entry) => {
      if (entry.tokens.length < RECENT_SPOKEN_TTS_MIN_TOKENS) return false;
      return orderedTokenMatchLength(tokens, entry.tokens) /
        Math.max(tokens.length, entry.tokens.length) >= RECENT_SPOKEN_TTS_OVERLAP_THRESHOLD;
    });
  }

  reset(): void {
    this.entries = [];
  }

  private prune(nowMs: number): void {
    this.entries = this.entries.filter(
      (entry) => nowMs - entry.spokenAtMs < RECENT_SPOKEN_TTS_TTL_MS,
    );
  }
}

const recentSpokenTtsLedger = new RecentSpokenTtsLedger();

/** True when a transcript substantially repeats a recent TTS utterance. */
export function isRecentSpokenTtsEcho(
  text: string,
  nowMs: number = Date.now(),
): boolean {
  return recentSpokenTtsLedger.matches(text, nowMs);
}

/** Test seam for seeding the recent-spoken ledger with deterministic times. */
export function __recordSpokenTts(
  text: string,
  spokenAtMs: number = Date.now(),
): void {
  recentSpokenTtsLedger.record(text, spokenAtMs);
}

/** Test seam: mark playout as just-ended (drives the cooldown branch). */
export function __markSynthPlayoutEnded(atMs: number = Date.now()): void {
  synthQuietSince = atMs;
}

/** Test seams for the playout ledger. */
export function __markPlayoutStarted(atMs: number = Date.now()): void {
  playoutLedger.open(atMs);
}
export function __markPlayoutEnded(atMs: number = Date.now()): void {
  playoutLedger.close(atMs);
}

// whisper.cpp on non-speech audio (silence, room tone, a TTS tail) does not only emit
// bracketed [BLANK_AUDIO] markers — isBlankTranscript already catches those. It also
// emits STABLE REAL WORDS/phrases with no speech behind them. These are the well-known
// ones plus the token the owner hit ("omid"). Matched only in ALWAYS-ON (a hands-free
// utterance is low-intent); PTT is never filtered — the button press IS the intent.
// Kept conservative: single-token / short stock phrases only, so a real one-word reply
// ("yes", "stop", "no") is NOT in here and still gets through.
const WHISPER_HALLUCINATION_TOKENS = new Set<string>([
  'omid',
  'you',
  'thank you',
  'thank you.',
  'thanks for watching',
  'thanks for watching!',
  'thank you for watching',
  'please subscribe',
  'bye',
  'bye.',
  'you.',
  '.',
]);

/** True when an always-on transcript is a known whisper non-speech hallucination. */
export function isLikelyWhisperHallucination(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return WHISPER_HALLUCINATION_TOKENS.has(t);
}

/** Exported for tests. */
export function gateAlwaysOnTranscript(
  text: string,
  nowMs: number = Date.now(),
): { dispatch: string | null; bareWake: boolean } {
  const wake = matchWakePhrase(text);
  if (wake.matched) {
    wakeConversationUntil = nowMs + WAKE_CONVERSATION_WINDOW_MS;
    if (!wake.trailing) return { dispatch: null, bareWake: true };
    return { dispatch: wake.trailing, bareWake: false };
  }
  if (nowMs <= wakeConversationUntil) {
    // Follow-up inside an open conversation window; each one refreshes it.
    wakeConversationUntil = nowMs + WAKE_CONVERSATION_WINDOW_MS;
    return { dispatch: text, bareWake: false };
  }
  return { dispatch: null, bareWake: false };
}

/** Test seam: reset the conversation window between tests. */
export function resetWakeConversationWindow(): void {
  wakeConversationUntil = 0;
  synthQuietSince = 0;
  playoutLedger.reset();
  recentSpokenTtsLedger.reset();
}

type AlwaysOnDispatchOptions = {
  /**
   * Web Speech already performed an anchored wake match and supplies the
   * normalized dispatch text. Other engines should leave this false so the
   * shared P-004 conversation-window gate runs here.
   */
  preGated?: boolean;
  /**
   * Original Web Speech transcript used for recent-TTS comparison. The
   * normalized dispatch text may have an added "operator" prefix.
   */
  sourceText?: string;
  /**
   * Capture-window paths use the audio-span ledger. The Web Speech path has no
   * span, so it uses recent spoken text and keeps barge-in available.
   */
  selfAudioGuard?: 'capture-or-clock' | 'recent-spoken-tts';
  /** Cancel current playout only after this utterance passes all guards. */
  cancelSpeechOnAccept?: boolean;
  /** Pulse the wake indicator after this utterance passes self-audio guards. */
  signalWake?: boolean;
};

function dispatchAlwaysOnUtterance(
  text: string,
  capture?: CaptureWindow,
  options: AlwaysOnDispatchOptions = {},
): boolean {
  // HALF-DUPLEX GATE (WI-4500, repaired WI-954890): never act on the mic while
  // papercup's own voice is in the recording. Otherwise a spoken reply is re-heard,
  // re-dispatched, and refreshes the conversation window — an unbreakable self-talk
  // loop. This is the one chokepoint every always-on utterance passes through, and it
  // must reject BEFORE gateAlwaysOnTranscript so the echo can't even refresh the window.
  //
  // The test is on the AUDIO's own span, not on the clock at dispatch: the transcript
  // arrives 1.5-3.8s after the audio it describes, so a dispatch-time cooldown was
  // structurally unable to see the overlap it existed to catch. A caller with no
  // capture window falls back to the old check — weaker, but fail-closed.
  const selfAudioText = options.sourceText ?? text;
  const selfAudioDetected = capture
    ? isSelfEchoCapture(capture)
    : options.selfAudioGuard === 'recent-spoken-tts'
      ? isRecentSpokenTtsEcho(selfAudioText)
      : isSelfAudioLikely();
  if (selfAudioDetected) return false;
  // HALLUCINATION GUARD (WI-4500): whisper emits stable real-word hallucinations on
  // non-speech audio ("omid", "you", "thank you", …) that sail past isBlankTranscript
  // (it only catches bracketed markers). Drop them in always-on; PTT stays unfiltered.
  if (isLikelyWhisperHallucination(text)) return false;
  const gated = options.preGated
    ? { dispatch: text, bareWake: false }
    : gateAlwaysOnTranscript(text);
  if (gated.bareWake) {
    // Bare "hey papercup" — acknowledge audibly; the follow-up window is open.
    signalWakeDetected();
    speak('Yes?', 'system:operator', 'polite', { force: true });
    return true;
  }
  if (gated.dispatch == null) return false; // ambient speech outside a wake window — dropped
  if (options.signalWake || gated.dispatch !== text) signalWakeDetected();
  if (options.cancelSpeechOnAccept) cancelAllSpeech();
  setState({ lastTranscript: gated.dispatch });
  onUtteranceFinal(gated.dispatch);
  return true;
}

/**
 * Always-on capture via energy-gated VAD (the WebKitGTK-safe path). Segments
 * speech by RMS energy, then resamples → WAV-encodes → POSTs each utterance to
 * the local whisper server, dispatching transcripts the same way the Silero
 * path does. The handle is stored in `whisperCapture` so stopWhisperCaptureIfRunning
 * tears it down on mode change.
 */
async function startEnergyVadAlwaysOn(): Promise<void> {
  whisperCapture = await startEnergyVadCapture({
    onSpeechStart: () => setAudioReceiving(true),
    onSpeechEnd: () => setAudioReceiving(false),
    onUtterance: async (pcm16k, capture) => {
      // Drop sub-0.2s blips (16kHz → 3200 samples) that slipped the VAD.
      if (pcm16k.length < 3200) return;
      try {
        const text = (await transcribeChunk(VOICEMODE_WHISPER_URL, f32ToWav(pcm16k, 16000))).trim();
        // P-004: same wake-phrase gate as the Silero always-on path above.
        // `capture` is the audio's own span, captured before this await — see WI-954890.
        if (!isBlankTranscript(text)) dispatchAlwaysOnUtterance(text, capture);
      } catch { /* network blip / whisper down — drop this utterance */ }
    },
  });
  setWakeListening(true);
  // Capture is live; clear the optimistic 'connecting' to the listening-ready
  // state (mode label shows "Always-on"; audioReceiving drives the hearing UI).
  if (state.status === 'connecting') {
    clearConnectingWatchdog();
    setState({ status: 'idle', micOwnedByFullAgent: false });
  }
}

/**
 * Flip the "a wake-capable capture loop is live" flag (idempotent). Called
 * ONLY at the exact points a capture loop actually starts or stops, so the
 * value is derived-correct at the source — never a verify-after guess (P-003).
 */
function setWakeListening(listening: boolean): void {
  if (state.wakeListening !== listening) setState({ wakeListening: listening });
}

function stopWhisperCaptureIfRunning(): void {
  if (whisperCapture) {
    try { whisperCapture.stop(); } catch { /* ignore */ }
    whisperCapture = null;
  }
  if (porcupineHandle) {
    void porcupineHandle.stop();
    porcupineHandle = null;
  }
  // Whatever was listening for the wake phrase is now gone (the Web Speech
  // recognizer path is torn down by its own call sites, which also route
  // through here on mode changes). Honest default: nothing is listening.
  setWakeListening(false);
}

interface ConfiguredWakePhraseMatch {
  matched: boolean;
  trailing: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Web Speech keeps the configured wake word, while the default wake phrase
 * also benefits from the shared fuzzy matcher used by local Whisper. Both
 * paths are anchored at the beginning; unlike stripWakeWordAndPrefix, a
 * sentence that merely mentions the wake phrase cannot activate the mic.
 */
function matchConfiguredWakePhrase(transcript: string): ConfiguredWakePhraseMatch {
  const configured = config.wakeWord.trim().replace(/\s+/g, ' ');
  if (!configured || configured.toLowerCase() === DEFAULT_CONFIG.wakeWord) {
    return matchWakePhrase(transcript);
  }
  const phrase = configured
    .split(' ')
    .filter(Boolean)
    .map(escapeRegExp)
    .join('\\s+');
  const matcher = new RegExp(`^[\\s"'([{-]*${phrase}[\\s,.!?;:-]*`, 'i');
  const match = matcher.exec(transcript);
  if (!match) return { matched: false, trailing: '' };
  return {
    matched: true,
    trailing: transcript.slice(match[0].length).trim(),
  };
}

function wakeDispatchText(trailing: string): string {
  const trimmed = trailing.trim();
  return /^operator\s+/i.test(trimmed) ? trimmed : `operator ${trimmed}`;
}

/** Exported so the Web Speech anchoring contract is directly testable. */
export function __matchWebSpeechWakePhrase(transcript: string): ConfiguredWakePhraseMatch {
  return matchConfiguredWakePhrase(transcript);
}

/**
 * Dispatch a final Web Speech wake+command after the anchored match. This
 * uses the recent-spoken-TTS guard instead of the capture-less cooldown guard:
 * matching our own sentence is rejected, while a different command can still
 * barge in and cancel the current reply.
 */
function dispatchWebSpeechWakeCommand(transcript: string, trailing: string): boolean {
  return dispatchAlwaysOnUtterance(wakeDispatchText(trailing), undefined, {
    preGated: true,
    sourceText: transcript,
    selfAudioGuard: 'recent-spoken-tts',
    cancelSpeechOnAccept: true,
    signalWake: true,
  });
}

/** Test seam for the final Web Speech wake+command callback path. */
export function __simulateWebSpeechFinalWake(transcript: string): boolean {
  const wake = matchConfiguredWakePhrase(transcript);
  if (!wake.matched || !wake.trailing) return false;
  return dispatchWebSpeechWakeCommand(transcript, wake.trailing);
}

function startWakeWordListening(): void {
  if (typeof window === 'undefined' || !state.hasWebSpeechSTT) {
    // No Web Speech on this runtime — NOTHING can hear the wake phrase.
    // Flag it so the UI stops advertising "say <wake word>" and shows the
    // PTT affordance instead (P-003 honest wake copy).
    setWakeListening(false);
    return;
  }
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.onresult = (event: any) => {
    let transcript = '';
    let sawFinal = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
      if (event.results[i].isFinal) sawFinal = true;
    }
    const wake = matchConfiguredWakePhrase(transcript);
    if (wake.matched) {
      // Single-utterance fast path: wake word + command spoken together
      // and the recognizer has already marked the utterance final. Dispatch
      // immediately instead of opening a fresh recognizer that would wait
      // for the no-speech timeout (~5s) before firing onend.
      if (sawFinal && wake.trailing) {
        dispatchWebSpeechWakeCommand(transcript, wake.trailing);
        if (state.mode === 'always-on') {
          setTimeout(() => startWakeWordListening(), 200);
        }
        try { recognition?.stop(); } catch { /* ignore */ }
        return;
      }
      signalWakeDetected();
      activateListening(wake.trailing);
    }
  };
  recognition.onerror = () => {
    // Errors are routine (no-speech, audio-capture); restart silently.
    if (state.mode === 'always-on') {
      setTimeout(() => startWakeWordListening(), 1000);
    }
  };
  recognition.onend = () => {
    if (state.mode === 'always-on') {
      // Restart for continuous listening.
      setTimeout(() => startWakeWordListening(), 100);
    }
  };
  try {
    recognition.start();
  } catch {
    /* already started */
  }
  // The Web Speech wake recognizer is live (or already was — idempotent).
  setWakeListening(true);
}

function activateListening(seedTranscript: string): void {
  // Barge-in: stop any current TTS before listening.
  cancelAllSpeech();
  setState({ status: 'listening', lastTranscript: seedTranscript });
  // Listen for the rest of the utterance.
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
  }
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  let finalTranscript = seedTranscript;
  recognition.onresult = (event: any) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += ' ' + event.results[i][0].transcript;
      }
    }
    setState({ lastTranscript: finalTranscript.trim() });
  };
  recognition.onend = () => {
    const trimmed = finalTranscript.trim();
    setState({ status: 'idle', lastTranscript: trimmed });
    if (trimmed) {
      // Re-prefix "operator " when the wake word stripped it, so
      // parseOperatorIntent can match. Skip if user already said
      // "operator …" as the seed (rare case where wakeWord === intent prefix).
      const dispatch = trimmed.toLowerCase().startsWith('operator ')
        ? trimmed
        : `operator ${trimmed}`;
      onUtteranceFinal(dispatch);
    }
    // Resume wake-word listening if mode is always-on.
    if (state.mode === 'always-on') {
      setTimeout(() => startWakeWordListening(), 200);
    }
  };
  try {
    recognition.start();
  } catch {
    /* ignore */
  }
}

/**
 * Push-to-talk: start capture using the user's configured STT engine.
 * Was hardcoded to Web Speech, which silently no-op'd for users on
 * Voicemode whisper or Deepgram. Now respects sttEngine the same way
 * always-on does.
 */
export function startPushToTalk(): void {
  if (!state.supported) return;
  pttActive = true;
  setState({ status: 'listening' });
  // Use the same capture path as always-on. setVoiceMode-style sync
  // handles which engine to spin up based on prefs.sttEngine.
  void maybeStartCaptureForPtt().catch(() => {
    // Last-ditch: try Web Speech if everything else failed.
    if (state.hasWebSpeechSTT) activateListening('');
  });
}

/**
 * Fire the actionable "no audio" toast, tailoring the message to the real
 * getUserMedia failure (captured by useMicLevel / the PTT raw capture) so it
 * stops being a guessing game. Always phase:'no-audio' so VoiceButton renders
 * the "Mic permissions" deep-link action.
 */
function dispatchNoAudioToast(): void {
  if (typeof window === 'undefined') return;
  const errStr = lastMicError ? `${lastMicError.name} ${lastMicError.message}` : '';
  let message = 'No audio detected — check your microphone and try again.';
  if (/NotAllowedError|SecurityError|Permission|denied/i.test(errStr)) {
    message = 'Microphone access is blocked — grant permission and try again.';
  } else if (/NotReadableError|NotFoundError|OverconstrainedError|AbortError|busy|in use|device/i.test(errStr)) {
    message = `Microphone unavailable${lastMicError?.name ? ` (${lastMicError.name})` : ''} — make sure it isn't muted or used by another app, and that the right input device is selected.`;
  }
  try {
    window.dispatchEvent(
      new CustomEvent('papercusp:voiceTimeout', { detail: { phase: 'no-audio', message } }),
    );
  } catch { /* ignore */ }
}

/**
 * WI-5174 (owner repro 2026-07-17: "they replied a fine response but it showed
 * up in the text chat and wasn't spoken out loud").
 *
 * Fire the spoken-output-failed toast. Every failure inside synthViaAdapter used
 * to be swallowed (`if (!r.ok) return`, `onerror → resolve()`,
 * `play().catch(() => resolve())`, `catch { /* ignore *​/ }`), so the synth queue
 * advanced as though the utterance had been SPOKEN. The reply still rendered in
 * the transcript, which is exactly the owner's symptom: text appears, no audio,
 * and nothing anywhere says why. Speech that fails to play must SAY so.
 *
 * Reuses the existing papercusp:voiceTimeout channel — VoiceButton toasts any
 * phase it doesn't special-case, so no new listener/surface is needed.
 *
 * Throttled: a broken audio sink fails on EVERY utterance, and one toast per
 * reply would be its own bug.
 */
let lastPlaybackWarnAt = 0;
const PLAYBACK_WARN_THROTTLE_MS = 30_000;

function dispatchSpeechPlaybackToast(message: string): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (now - lastPlaybackWarnAt < PLAYBACK_WARN_THROTTLE_MS) return;
  lastPlaybackWarnAt = now;
  try {
    window.dispatchEvent(
      new CustomEvent('papercusp:voiceTimeout', {
        detail: { phase: 'playback', message },
      }),
    );
  } catch { /* ignore */ }
}

/** Fire the "no transcript" toast — the mic worked but no words came back. */
function dispatchNoTranscriptToast(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('papercusp:voiceTimeout', {
        detail: { phase: 'transcript', message: 'No transcript received — try speaking again.' },
      }),
    );
  } catch { /* ignore */ }
}

/** Stop push-to-talk: tear down whichever capture is running. */
export function stopPushToTalk(): void {
  pttActive = false;
  // Read before the reset below: for streaming engines this is the "did we
  // capture audio?" signal.
  const heardAudio = state.audioReceiving || !!state.lastTranscript;
  setState({ status: state.mode === 'off' ? 'off' : 'idle', audioReceiving: false });
  if (recognition) {
    try { recognition.stop(); } catch { /* ignore */ }
    recognition = null;
  }

  // Voicemode raw-capture path: finalize from the actual recorded buffer
  // (robust — the no-audio decision comes from real captured audio, not the
  // visualization analyser's threshold).
  if (pttRawCapture) {
    const cap = pttRawCapture;
    pttRawCapture = null;
    let result: PttRawCaptureResult | null = null;
    try { result = cap.stop(); } catch { result = null; }
    void finalizePttRawCapture(result);
    return;
  }

  // Streaming engines (Deepgram / Web Speech): only enter "processing
  // transcript" if we actually captured audio. If audioReceiving never became
  // true during the hold, the mic was dead — fire the no-audio toast instead
  // of pretending a transcript is on the way.
  stopWhisperCaptureIfRunning();
  if (heardAudio) {
    beginProcessingTranscript();
  } else {
    dispatchNoAudioToast();
  }
}

/**
 * Finalize a voicemode PTT raw capture: classify the buffer, and either fire
 * the actionable no-audio toast (capture failed / mic delivered silence) or
 * resample → WAV-encode → POST to whisper and dispatch the transcript.
 */
async function finalizePttRawCapture(result: PttRawCaptureResult | null): Promise<void> {
  if (classifyPttResult(result) === 'no-audio') {
    dispatchNoAudioToast();
    return;
  }
  // Non-null after classify !== 'no-audio'.
  const captured = result as PttRawCaptureResult;
  beginProcessingTranscript();
  try {
    const pcm16k = resampleLinearTo16k(captured.samples, captured.sampleRate);
    const blob = f32ToWav(pcm16k, 16000);
    const text = (await transcribeChunk(VOICEMODE_WHISPER_URL, blob)).trim();
    if (!isBlankTranscript(text)) {
      setState({ lastTranscript: text });
      onUtteranceFinal(text); // clears processing, begins awaiting-response
    } else {
      endProcessingTranscript();
      dispatchNoTranscriptToast();
    }
  } catch {
    endProcessingTranscript();
    dispatchNoTranscriptToast();
  }
}

async function maybeStartCaptureForPtt(): Promise<void> {
  if (pttRawCapture) return; // already capturing
  // Release any lingering always-on capture (e.g. energy-VAD) so PTT owns the
  // mic — otherwise its open stream blocks this and PTT silently no-ops.
  stopWhisperCaptureIfRunning();

  // Open the mic and start buffering IMMEDIATELY — before resolving prefs,
  // probing whisper, or importing engines. That async startup used to run
  // first and swallow the opening ~0.5–1s of speech on a quick hold, surfacing
  // as "No audio detected". Voicemode whisper (raw capture → transcribe on
  // release) is the default and the only engine that works on the WebKitGTK
  // desktop; deepgram/web-speech are swapped in below when configured.
  try {
    if (!whisperCapture) {
      const cap = await startPttRawCapture();
      if (!pttActive) { try { cap.stop(); } catch { /* ignore */ } return; } // released mid-startup
      pttRawCapture = cap;
      setMicCaptureError(null);
    }
  } catch (err) {
    // getUserMedia/permission/device failure — record it so the no-audio toast
    // on release names the real cause. pttRawCapture stays null, so
    // stopPushToTalk falls through to the no-audio branch.
    setMicCaptureError(err);
  }

  // Deepgram streaming STT was REMOVED from operator-core (voice-engine
  // slim-down, 2026-07-09 — see WI-3510); a stored 'deepgram' preference now
  // just keeps the raw-capture voicemode path below instead of importing the
  // deleted engine (second dead call site of the same class as the always-on
  // branch above — desktop-auto-update-operational-2026-07-09 release-gate fix).

  // Voicemode default keeps the raw capture already running. If neither the raw
  // capture nor a streaming engine came up, last-ditch Web Speech.
  if (!pttRawCapture && !whisperCapture && state.hasWebSpeechSTT) activateListening('');
}

const utteranceListeners = new Set<(text: string, transcriptSource?: TranscriptSource) => void>();

export function onFinalUtterance(
  listener: (text: string, transcriptSource?: TranscriptSource) => void,
): () => void {
  utteranceListeners.add(listener);
  return () => {
    utteranceListeners.delete(listener);
  };
}



function onUtteranceFinal(text: string, transcriptSource: TranscriptSource = 'localWhisper'): void {
  endProcessingTranscript();
  beginAwaitingResponse();
  const transport = canonicalTransportForSource(transcriptSource);
  if (transport) {
    localCanonicalAdapter.finalTranscript({
      text,
      transport,
      latencyClass: 'interactive',
      executor: 'papercup-local',
    });
  }
  for (const l of utteranceListeners) {
    try {
      l(text, transcriptSource);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Test helper used by the "Test wake word" button in /settings/voice.
 * Fires onUtteranceFinal as if a real STT engine had just produced
 * a transcript, exercising the full dispatch path (VoiceAppBridge →
 * stripWakeWordAndPrefix → parseOperatorIntent).
 *
 * `transcriptSource` defaults to the local engine (what the wake-word
 * button simulates); tests drive the provider arm through the same seam.
 */
export function __simulateUtterance(
  text: string,
  transcriptSource: TranscriptSource = 'localWhisper',
): void {
  setState({ lastTranscript: text });
  onUtteranceFinal(text, transcriptSource);
}

// Dev test seam (sentinel-tui-shared-backend §3): the most recent text routed to
// speak(), captured before the support/leader/mode gates so the agent-e2e bridge
// can read back a voice reply without a mic. Set in speak() below.
let __lastSpokenForTest: { text: string; role: string; at: number } | null = null;

/**
 * WI-5174 (owner repro 2026-07-17): "spoken question answered in TEXT chat
 * only — reply not spoken aloud". speak() has FIVE silent early-returns
 * (unsupported / mode-off / output-muted / realtime-active / not-the-leader-
 * tab) and every one of them looked identical to the owner: correct reply,
 * no audio, nothing in devtools to say why. Root-caused several PLAUSIBLE
 * gates (isVoiceOutputMuted's persisted mute surviving silently across
 * sessions; a genuine ~250ms boot-election race where bootVoiceLeader sets
 * `available:true` synchronously before the election resolves 250ms later,
 * so a speak() fired in that narrow window reads a false-follower state) but
 * could NOT pin down which one fired for this specific incident without
 * either polluting the owner's live conversation thread with a driven test
 * utterance or reading their real (non-isolated) browser profile's
 * localStorage — neither safe to do from here. So: instrument every silent
 * gate instead of guessing further. `__lastSilencedForTest` mirrors
 * `__lastSpokenForTest` (captures the last reason speak() DIDN'T speak) and
 * every gate below emits a console.debug breadcrumb — the next occurrence is
 * diagnosable from live devtools/log capture instead of reproducing this
 * same "no leads" investigation from scratch.
 */
let __lastSilencedForTest: { reason: string; text: string; at: number } | null = null;

function silenceSpeak(reason: string, text: string): void {
  __lastSilencedForTest = { reason, text, at: Date.now() };
  // eslint-disable-next-line no-console
  console.debug(`[voice] speak() silenced (${reason}):`, text.slice(0, 120));
}

// Expose an injection + read-back hook for the agent-e2e bridge — dev-shell ONLY
// (gated on the desktop dev wrapper). There is otherwise no headless way to drive
// a conversational voice turn: simulate(text) fires the full dispatch
// (VoiceAppBridge → operator:converse), lastSpoken() returns the captured reply.
if (
  typeof window !== 'undefined' &&
  (window as { __PAPERCUSP_DEV_WRAPPER__?: unknown }).__PAPERCUSP_DEV_WRAPPER__
) {
  (window as unknown as { __pcVoiceTest?: unknown }).__pcVoiceTest = {
    simulate: (t: string) => __simulateUtterance(t),
    lastSpoken: () => __lastSpokenForTest,
    // WI-5174: WHY didn't the last reply speak? Mirrors lastSpoken() but for
    // the negative case — one of speak()'s 5 silent gates (see silenceSpeak).
    lastSilenced: () => __lastSilencedForTest,
    // Voice mode gates the whole utterance dispatch (VoiceAppBridge returns
    // when mode is 'off'), and the UI toggle is the only production way to
    // flip it — headless verification needs this seam (WI-4838 live-verify).
    setMode: (m: VoiceMode) => setVoiceMode(m),
    getState: () => getVoiceState(),
  };
}

/**
 * Speak text in the voice assigned to `role`. Queues if another role is
 * already speaking. Only one utterance plays at a time.
 */
export function speak(
  text: string,
  role = 'system:operator',
  priority: 'polite' | 'assertive' = 'polite',
  options: {
    force?: boolean;
    allowDuringRealtime?: boolean;
    preserveAwaitingResponse?: boolean;
  } = {},
): void {
  // Dev test seam: record the reply text regardless of the gates below (we want
  // the brain's reply even on a tab that won't emit TTS). See __lastSpokenForTest.
  __lastSpokenForTest = { text, role, at: Date.now() };
  if (!state.supported) {
    silenceSpeak('tts-unsupported', text);
    return;
  }
  if (!options.force) {
    // Normal path: voice mode must be on AND we must be the leader tab.
    // Test/preview buttons in /settings/voice pass force:true to bypass.
    // (Removed the `oracle-tutorial-complete` gate 2026-06-22: that
    //  sessionStorage flag was set ONLY by e2e specs, so in the real app it
    //  silenced EVERY non-forced spoken reply — the root cause of "voice
    //  gives no audible response". Voice-mode-on is the real gate; Phase 1 of
    //  sentinel-tui-shared-backend-and-cards routes replies through here.)
    if (state.mode === 'off') {
      silenceSpeak('voice-mode-off', text);
      return;
    }
    // Voice-output mute (the voice-bar speaker toggle, owner 2026-06-23):
    // silence spoken replies without leaving voice mode. force:true bypasses.
    if (isVoiceOutputMuted()) {
      silenceSpeak('output-muted', text);
      return;
    }
  }
  // Aria-live publish — independent of TTS engine + leader election so
  // screen-reader users always see the same content the leader speaks.
  try {
    // Lazy-import to avoid pulling React-side bus into non-React callers.
    void import('./aria-live-bus').then((m) => m.publishAriaLive(priority, text));
  } catch { /* ignore */ }
  // When a full-agent engine (EL Conv AI / OpenAI Realtime) is active,
  // the agent itself is the voice. Local speak() calls — spend-cap
  // warnings, op-narration, anything else routed through here — would
  // talk over the agent in a different voice. Drop them silently after
  // the aria-live publish above so screen readers still see the text.
  // Callers who genuinely need to override (test buttons in
  // /settings/voice) already pass force:true.
  if (realtimeSession && !options.force && !options.allowDuringRealtime) {
    silenceSpeak('realtime-session-active', text);
    return;
  }
  // Leader-election gate (v4 §2i): only the leader tab actually emits TTS.
  // Followers are silent; aria-live still publishes so screen-readers in any
  // tab see the text.
  try {
    const leader = getVoiceLeaderState();
    if (leader.available && !leader.isLeader && !options.force) {
      silenceSpeak('not-leader-tab', text);
      return;
    }
  } catch { /* leader module not yet loaded — fall through and speak */ }
  synthQueue.push({
    text,
    role,
    preserveAwaitingResponse: options.preserveAwaitingResponse === true,
  });
  // Local Papercup replies are produced by the same `speak()` seam used by
  // typed text. Keep the canonical sentence/completion events observational;
  // the existing queue and TTS behavior remain untouched. An instant ack can
  // leave the turn open so the substantive response records its own sentence
  // and end-to-end latency.
  if (localCanonicalAdapter.activeTurnId) {
    localCanonicalAdapter.assistantSentence(text);
    if (!options.preserveAwaitingResponse) localCanonicalAdapter.complete();
  }
  // Cap queue depth: drop the oldest items beyond MAX so newer (more
  // relevant) utterances win. Critical when a stuck TTS engine + a
  // chatty caller (background scanner during always-on voice) would
  // otherwise queue megabytes of stale text.
  if (synthQueue.length > SYNTH_QUEUE_MAX) {
    synthQueue = synthQueue.slice(-SYNTH_QUEUE_MAX);
  }
  if (!isSynthSpeaking) processSynthQueue();
}

function processSynthQueue(): void {
  if (typeof window === 'undefined') return;
  const next = synthQueue.shift();
  if (!next) {
    isSynthSpeaking = false;
    synthQuietSince = Date.now(); // legacy fallback cooldown (WI-4500)
    playoutLedger.close(); // playout ended — close the audible interval (WI-954890)
    setState({ status: state.mode === 'off' ? 'off' : 'idle', speakingRole: null });
    return;
  }
  isSynthSpeaking = true;
  playoutLedger.open(); // our voice is audible from here until the queue drains
  // Record only after all speak() gates have passed and this utterance is
  // selected for playout. Web Speech has no capture window, so it compares
  // later transcripts against this bounded recent-text ledger instead of
  // muting every barge-in while TTS is active.
  recentSpokenTtsLedger.record(next.text);
  if (!next.preserveAwaitingResponse) endAwaitingResponse();
  setState({ status: 'speaking', speakingRole: next.role });

  // Engine routing: only use Web Speech if the user explicitly picked it,
  // OR if it's our last-resort fallback (no speechSynthesis would mean
  // we go straight to the adapter route). Previously we always used
  // speechSynthesis when available, ignoring the user's engine choice —
  // so picking Kokoro in settings still produced robotic OS voices.
  // WI-4873: resolve the engine SYNCHRONOUSLY before the browser-vs-adapter
  // decision so the FIRST utterance (cold cache — e.g. right after a page load
  // or an operator restart) already honors the user's SELECTED engine (kokoro)
  // instead of falling through to browser Web Speech, which EXISTS but is
  // SILENT in the WebKitGTK desktop shell — so the first spoken reply produced
  // no audio at all (owner-reported PTT "no response"). Only an EXPLICIT
  // 'browser' pref uses Web Speech now; every adapter engine is honored on
  // utterance #1, not just from the second reply once the async cache warmed.
  if (adapterEngineCache === null) {
    try {
      adapterEngineCache = loadVoicePrefsClient().ttsEngine ?? 'kokoro';
      adapterEngineCacheAt = Date.now();
    } catch { /* prefs unreadable → keep null, old fallback applies */ }
  }
  const cachedEngine = adapterEngineCache; // sync read; resolved above / by prior fetch
  const useBrowser =
    cachedEngine === 'browser' ||
    (cachedEngine === null && window.speechSynthesis && state.hasWebSpeechTTS);
  if (useBrowser && window.speechSynthesis) {
    const utt = new SpeechSynthesisUtterance(next.text);
    utt.rate = config.rate;
    const voiceName = voiceForRole(next.role);
    if (voiceName) {
      const voices = window.speechSynthesis.getVoices();
      const v = voices.find((vv) => vv.name === voiceName);
      if (v) utt.voice = v;
    }
    utt.onend = () => { processSynthQueue(); };
    utt.onerror = () => { processSynthQueue(); };
    window.speechSynthesis.speak(utt);
    // Kick off prefs fetch in the background so the next utterance can
    // route correctly once we know the user's pick.
    if (cachedEngine === null) void fetchPreferredEngine();
    return;
  }

  // Adapter route — Kokoro / ElevenLabs / OpenAI / Cartesia via the
  // server-side TTS preview endpoint (keys never leave the server).
  void synthViaAdapter(next.text, next.role).finally(() => processSynthQueue());
}

let adapterAudio: HTMLAudioElement | null = null;
let adapterEngineCache: string | null = null;
let adapterEngineCacheAt = 0;

async function fetchPreferredEngine(): Promise<string> {
  // Cache the prefs lookup for 30s so a chatty caller doesn't hammer the
  // prefs route once per utterance.
  const now = Date.now();
  if (adapterEngineCache && now - adapterEngineCacheAt < 30_000) return adapterEngineCache;
  const prefs = loadVoicePrefsClient();
  adapterEngineCache = prefs.ttsEngine ?? 'kokoro';
  adapterEngineCacheAt = now;
  return adapterEngineCache;
}

async function synthViaAdapter(text: string, role: string): Promise<void> {
  let engine = await fetchPreferredEngine();
  // 'browser' isn't synthable here (no speechSynthesis); coerce to kokoro.
  if (engine === 'browser') engine = 'kokoro';
  const voiceId = voiceForEngineRole(engine, role);
  try {
    const r = await fetch('/api/agent-mcp/operator-tts-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine, text, voiceId }),
    });
    if (!r.ok) {
      // The TTS route itself failed — no audio bytes exist to play.
      dispatchSpeechPlaybackToast(
        `Couldn't generate speech (${engine} returned ${r.status}) — the reply is in the chat.`,
      );
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    if (adapterAudio) {
      try { adapterAudio.pause(); } catch {}
      try { URL.revokeObjectURL(adapterAudio.src); } catch {}
    }
    const a = new Audio(url);
    adapterAudio = a;
    await new Promise<void>((resolve) => {
      // onerror and play()'s rejection can BOTH fire for one utterance; settle
      // once so a single failure yields a single toast and a single revoke.
      let settled = false;
      const settle = (failure?: string): void => {
        if (settled) return;
        settled = true;
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        if (failure) dispatchSpeechPlaybackToast(failure);
        resolve();
      };
      a.onended = () => settle();
      a.onerror = () => settle("The spoken reply couldn't be played — the reply is in the chat.");
      void a.play().catch((err: unknown) => {
        // Autoplay policy is the one recoverable case and needs its own words:
        // the browser refused because no user gesture has unlocked audio yet.
        // "Check your speakers" would send the user hunting the wrong problem.
        const name = err instanceof Error ? err.name : '';
        const autoplayBlocked = /NotAllowedError|SecurityError/i.test(
          `${name} ${err instanceof Error ? err.message : String(err)}`,
        );
        settle(
          autoplayBlocked
            ? 'Audio is blocked until you interact with the window — click anywhere, then try again.'
            : "The spoken reply couldn't be played — the reply is in the chat.",
        );
      });
    });
  } catch (e) {
    // Never swallow: the queue keeps flowing either way, but the user is told.
    dispatchSpeechPlaybackToast(
      `Speech playback failed (${e instanceof Error ? e.name : 'error'}) — the reply is in the chat.`,
    );
  }
}

/**
 * Cancel any in-progress speech and clear the queue. Used for barge-in
 * and when voice mode is turned off.
 */
export function cancelAllSpeech(): void {
  // Barge-in / mode-off terminates any local canonical turn still awaiting a
  // substantive answer. The existing audio cancellation semantics are kept.
  if (localCanonicalAdapter.activeTurnId) localCanonicalAdapter.interrupt('user');
  synthQueue = [];
  isSynthSpeaking = false;
  // BARGE-IN CLOSES THE INTERVAL TOO (WI-954890). The old code cleared
  // isSynthSpeaking here and left synthQuietSince untouched, so a CANCELLED reply
  // started no cooldown at all — the constant's own comment claimed "processSynthQueue
  // / barge-in cancel" set it, but this half was never written. Audio already in the
  // device buffer keeps playing for a moment after a cancel, so this is a real gap.
  synthQuietSince = Date.now();
  playoutLedger.close();
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
  if (adapterAudio) {
    try { adapterAudio.pause(); } catch {}
    try { URL.revokeObjectURL(adapterAudio.src); } catch {}
    adapterAudio = null;
  }
  if (state.status === 'speaking') {
    setState({ status: state.mode === 'off' ? 'off' : 'idle', speakingRole: null });
  }
}

/** Output-only consumer of the maintained TTS/settings surface. Unlike voice
 * mode, creating this player never acquires a microphone. Its lifetime belongs
 * to the caller, so obsolete responses cannot enter the global speech queue. */
export function createVoiceOutputPlayback(
  requestSpeech: (text: string, engine: string, voiceId: string | null, signal: AbortSignal) => Promise<Blob>,
  onStatus: (status: 'idle' | 'loading' | 'playing' | 'unavailable') => void,
) {
  let current: AbortController | null = null;
  let disposeAudio: (() => void) | null = null;
  const stop = () => {
    current?.abort(); current = null;
    disposeAudio?.(); disposeAudio = null;
    onStatus('idle');
  };
  return {
    stop,
    async play(text: string) {
      stop();
      if (isVoiceOutputMuted() || !text.trim()) return;
      const controller = new AbortController(); current = controller;
      const signal = controller.signal;
      onStatus('loading');
      try {
        const engine = loadVoicePrefsClient().ttsEngine ?? 'kokoro';
        if (engine === 'browser') {
          if (!window.speechSynthesis) throw new Error('speech_unavailable');
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.rate = config.rate;
          const name = voiceForRole('system:operator');
          utterance.voice = window.speechSynthesis.getVoices().find(voice => voice.name === name) ?? null;
          disposeAudio = () => window.speechSynthesis.cancel();
          utterance.onstart = () => { if (!signal.aborted) onStatus('playing'); };
          utterance.onend = () => { if (!signal.aborted) onStatus('idle'); };
          utterance.onerror = () => { if (!signal.aborted) onStatus('unavailable'); };
          window.speechSynthesis.speak(utterance);
          return;
        }
        const blob = await requestSpeech(text, engine, voiceForEngineRole(engine, 'system:operator'), signal);
        if (signal.aborted || current !== controller || isVoiceOutputMuted()) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        let disposed = false;
        const dispose = () => { if (!disposed) { disposed = true; audio.pause(); audio.removeAttribute('src'); URL.revokeObjectURL(url); } };
        disposeAudio = dispose;
        audio.onended = () => { dispose(); if (!signal.aborted) onStatus('idle'); };
        audio.onerror = () => { dispose(); if (!signal.aborted) onStatus('unavailable'); };
        await audio.play();
        if (!signal.aborted && !disposed) onStatus('playing');
      } catch {
        if (!signal.aborted && current === controller) { disposeAudio?.(); disposeAudio = null; onStatus('unavailable'); }
      }
    },
  };
}

/**
 * Get the list of available browser voices. Used by the settings UI.
 */
export function listAvailableVoices(): Array<{ name: string; lang: string }> {
  if (typeof window === 'undefined' || !window.speechSynthesis) return [];
  return window.speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang }));
}

/** Assign a specific voice to a role. */
export function assignVoiceToRole(role: string, voiceName: string): void {
  config.roleVoices = { ...config.roleVoices, [role]: voiceName };
  saveConfig();
}
