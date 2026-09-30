/**
 * Operator-voice host wiring (universal-voice-interface-2026-06-05, P-002/3/4).
 *
 * Constructs the singleton `OperatorVoiceSession` with its production deps and
 * attaches it to the local-audio-socket bus (so the socket routes inbound
 * HELLO/MIC/CONTROL to it and fans its outbound frames to every attached
 * client), then keeps the elected player's voice-lease warm on a heartbeat.
 * Called once from the operator bootstrap, right after the voice socket + the
 * desktop WS bridge are up.
 */
import { startLocalVoiceSocket, broadcastOpVoice, setOperatorVoiceSession } from './local-audio-socket';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { OperatorVoiceSession } from './operator-voice-session';
import { createOperatorVoiceSessionDeps } from './operator-voice-session-deps';
import { startSentinelSaysPump } from './sentinel-says-pump';
import { runSentinelProactiveSweep, type SentinelSweepDeps } from '../papercup/papercup-proactive-sweep';
import { buildSentinelSweepDeps, speakIntoSession } from '../papercup/papercup-proactive-sweep-deps';

/** Re-claim the elected player's lease well under its 12s TTL. */
const LEASE_HEARTBEAT_MS = 5_000;

/** How often the server-side Sentinel proactive sweep ticks. The sweep is
 *  heavily gated (FLAGS.PAPERCUP_PROACTIVE default OFF + role + DND/pause/budget +
 *  single-owner + an internal throttle), so a frequent tick is cheap — most ticks
 *  are a single flag read and a no-op. Env-tunable, hard min 5s. */
function sentinelSweepTickMs(): number {
  const n = Number(
    process.env.PAPERCUSP_PAPERCUP_SWEEP_TICK_MS ??
      process.env.PAPERCUSP_SENTINEL_SWEEP_TICK_MS ?? // legacy env name — dual-accept until callers migrate
      30_000,
  );
  return Number.isFinite(n) && n >= 5_000 ? n : 30_000;
}

let started = false;
let session: OperatorVoiceSession | null = null;
let heartbeat: ManagedHandle | null = null;
let sentinelSweep: ManagedHandle | null = null;
let saysPump: ManagedHandle | null = null;
// The sweep dep set is built lazily once (the heavy legs are lazy-imported inside
// it), reusing the host's broadcastOpVoice sink so a proactive utterance fans to
// every attached client exactly like the EL audio path does.
let sweepDeps: SentinelSweepDeps | null = null;
// Re-entrancy guard: a slow sweep (a real converse turn + TTS) must not overlap
// the next tick.
let sweepInFlight = false;

export function startOperatorVoiceHost(): void {
  if (started) return;
  started = true;
  // The bus transport must exist before clients can attach (idempotent — the
  // bootstrap also starts it for the P2P channel path).
  startLocalVoiceSocket();
  session = new OperatorVoiceSession(createOperatorVoiceSessionDeps(broadcastOpVoice));
  setOperatorVoiceSession(session);
  heartbeat = managedSetInterval('operator-voice-heartbeat', LEASE_HEARTBEAT_MS, () => {
    void session?.heartbeat();
  }, { category: 'lifecycle' });

  // Server-side Sentinel proactive "decide to speak" sweep (P-019). DEFAULT OFF:
  // the very first gate inside the sweep is FLAGS.PAPERCUP_PROACTIVE (default
  // false), so when the flag is off every tick is a single flag read returning a
  // no-op — live voice + the browser-provider proactive ticks are byte-for-byte
  // unchanged. The sweep only ever acts when the flag is ON *and* this host owns
  // the elected voice lease (single-owner) *and* the persona is sentinel *and* no
  // DND/pause/over-budget — see sentinel-proactive-sweep.ts for the full gate set.
  // Voice-OUT for the one-brain pipeline (voice-unified-sentinel-pipeline
  // P-002): while a session is live, drain the pane's voice:say lines and speak
  // them into the bus. When no session is live the pump no-ops and the webview's
  // local-mode drain keeps the FIFO (the sessionLive gate = single consumer).
  saysPump = startSentinelSaysPump({
    sessionLive: () => session?.sweepState().sessionLive ?? false,
    drain: async () => {
      const { drainSentinelSays } = await import('../sentinel-output-buffer');
      return drainSentinelSays();
    },
    speak: async (text) => {
      session?.emitCanonicalAssistantSentence(text);
      return speakIntoSession(text, broadcastOpVoice);
    },
    broadcast: broadcastOpVoice,
    // No persist dep (WI-4838): voice:say persists the line to the shared
    // conversation at PUSH time, covering every drain path exactly once.
    log: (msg) => console.log(`[voice-host] ${msg}`),
  });

  sweepDeps = buildSentinelSweepDeps(broadcastOpVoice);
  sentinelSweep = managedSetInterval('operator-voice-sentinel-sweep', sentinelSweepTickMs(), () => {
    if (sweepInFlight || !session || !sweepDeps) return;
    sweepInFlight = true;
    void runSentinelProactiveSweep(session.sweepState(), sweepDeps)
      .then((r) => {
        if (r.fired) console.log('[voice-host] sentinel sweep fired', r);
      })
      .catch((err) => console.warn('[voice-host] sentinel sweep error:', err instanceof Error ? err.message : err))
      .finally(() => {
        sweepInFlight = false;
      });
  }, { category: 'lifecycle' });

  console.log('[voice-host] operator voice session host attached to the bus');
}

export async function stopOperatorVoiceHost(): Promise<void> {
  if (heartbeat) {
    heartbeat.stop();
    heartbeat = null;
  }
  if (sentinelSweep) {
    sentinelSweep.stop();
    sentinelSweep = null;
  }
  if (saysPump) {
    saysPump.stop();
    saysPump = null;
  }
  sweepDeps = null;
  sweepInFlight = false;
  setOperatorVoiceSession(null);
  if (session) {
    await session.stop().catch(() => {});
    session = null;
  }
  started = false;
}
