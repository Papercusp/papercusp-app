/**
 * sentinel-proactive-sweep — the SERVER-SIDE proactive "decide to speak" engine
 * for the Sentinel.
 *
 * The browser-provider active-mode proactive ticks
 * (apps/operator/app/_components/OperatorConversationProvider.tsx) let the brain
 * decide to keep speaking — but ONLY while a desktop UI is open. This module moves
 * that loop SERVER-SIDE so the Sentinel can speak with NO desktop UI open: a
 * periodic sweep (driven by the voice-host timer) runs a role:'sentinel' converse
 * turn with trigger 'sentinel_scan', TTS's the reply, and pushes it out-of-band
 * into the live voice session via broadcastOpVoice → OPV_RESPONSE_AUDIO. When no
 * live voice session exists, a salient alert is routed via attention-push +
 * hindsight ("[While you were away]") instead.
 *
 * EVERYTHING is GATED so live behavior is BYTE-FOR-BYTE UNCHANGED by default. A
 * sweep FIRES only when ALL of these hold (mirrors the browser-provider gates +
 * adds the server-side ones):
 *   1. FLAGS.PAPERCUP_PROACTIVE is ON          (the master switch — DEFAULT OFF)
 *   2. humanFacingRole === 'sentinel'          (the Sentinel persona is live)
 *   3. NOT do-not-disturb (silenceVoice)       (DND — the user muted the Sentinel)
 *   4. NOT operator-paused                     (the global pause sentinel)
 *   5. proactiveTicksEnabled                   (the active-mode auto-fire master)
 *   6. NOT over the daily budget               (the converse-gate precondition)
 *   7. SINGLE-OWNER: ownsVoiceLease === true   (only the elected host runs it —
 *                                               never double-fires alongside a
 *                                               browser provider / another host)
 *   8. NOT inside the per-sweep throttle window (one utterance per cooldown)
 *
 * Pure + fully dependency-injected so it unit-tests without a live EL endpoint,
 * audio hardware, PG, or the flags backend. The voice-host wires the production
 * deps (see buildSentinelSweepDeps in operator-voice-session-deps).
 */

/** The minimum spacing between two proactive utterances. Generous by design —
 *  a Sentinel that narrates every tick is worse than one that waits (mirrors the
 *  browser provider's EL cool-off). Env-tunable, hard min 60s. */
export function sentinelSweepThrottleMs(): number {
  const n = Number(
    process.env.PAPERCUSP_PAPERCUP_SWEEP_THROTTLE_MS ??
      process.env.PAPERCUSP_SENTINEL_SWEEP_THROTTLE_MS ?? // legacy env name — dual-accept until callers migrate
      5 * 60 * 1000,
  );
  return Number.isFinite(n) && n >= 60_000 ? n : 5 * 60 * 1000;
}

/** The live state the host knows at sweep time (NOT injected — passed per tick). */
export interface SentinelSweepState {
  /** Is the operator voice session live (status !== 'off')? */
  sessionLive: boolean;
  /** Does THIS host own the elected voice lease / player role? The single-owner
   *  guard — only the lease holder runs the sweep so it never double-fires. */
  ownsVoiceLease: boolean;
  /** The live brain persona ('operator' default | 'sentinel'). */
  humanFacingRole: 'operator' | 'papercup';
}

/** The FLEET-STATUS the sweep surfaces (P-020) — the markdown the converse turn
 *  is fed as its situational context, plus a coarse salience flag for the
 *  voice-off importance gate. */
export interface SentinelFleetStatus {
  /** Rendered FLEET-STATUS markdown (anomalies / signals / patterns / progress). */
  context: string;
  /** Is anything in the status genuinely salient (a critical anomaly / urgent
   *  signal)? Gates the voice-OFF attention push (importance-gated, P-021). */
  salient: boolean;
  /** A one-line headline for the voice-off alert / hindsight, when salient. */
  headline: string | null;
}

/** Everything the sweep needs from the outside world — real in prod, faked in tests. */
export interface SentinelSweepDeps {
  /** Is FLAGS.PAPERCUP_PROACTIVE enabled? (getFlag, default OFF.) */
  flagEnabled(): Promise<boolean>;
  /** The do-not-disturb pref (voice prefs `silenceVoice`). */
  isSilenced(): Promise<boolean>;
  /** The global operator pause sentinel (isPaused). */
  isPaused(): Promise<boolean>;
  /** The active-mode auto-fire master (voice prefs `proactiveTicksEnabled`). */
  proactiveTicksEnabled(): Promise<boolean>;
  /** Is today's spend over the daily budget cap? (true ⇒ suppress.) */
  overBudget(): Promise<boolean>;
  /** Gather + render the FLEET-STATUS context (P-020). */
  gatherFleetStatus(): Promise<SentinelFleetStatus>;
  /** Run a role:'sentinel' converse turn with trigger 'sentinel_scan' over the
   *  FLEET-STATUS context. Returns the clean spoken `<say>` body (or empty/null
   *  when the Sentinel chose silence). */
  runSentinelScan(context: string): Promise<string | null>;
  /** TTS `text` → push it out-of-band into the live voice session via
   *  broadcastOpVoice → OPV_RESPONSE_AUDIO. Returns true on a successful push. */
  speakIntoSession(text: string): Promise<boolean>;
  /** Voice-OFF path: route a salient alert via attention-notify /
   *  device-push-dispatcher (importance-gated). */
  pushAttention(headline: string): Promise<void>;
  /** Voice-OFF path: record a hindsight "[While you were away]" note for the
   *  next session (notifyOperatorHindsight). */
  notifyHindsight(headline: string): Promise<void>;
  /** Monotonic clock (injectable for throttle tests). */
  now(): number;
  log?(msg: string, extra?: unknown): void;
}

/** Why a sweep did NOT fire — the gate that blocked it (for tests + telemetry). */
export type SentinelSweepGate =
  | 'flag-off'
  | 'not-sentinel'
  | 'dnd'
  | 'paused'
  | 'proactive-ticks-off'
  | 'over-budget'
  | 'not-lease-owner'
  | 'throttled';

/** The outcome of one sweep tick. */
export type SentinelSweepResult =
  | { fired: false; gate: SentinelSweepGate }
  /** Sentinel chose silence — gates passed, the scan ran, nothing salient to say. */
  | { fired: false; gate: 'silent' }
  /** Spoke an utterance into the live voice session (voice-ON path). */
  | { fired: true; via: 'voice'; text: string }
  /** No live session — routed a salient alert via attention-push + hindsight. */
  | { fired: true; via: 'attention'; headline: string }
  /** No live session AND nothing salient — stayed quiet (no push). */
  | { fired: false; gate: 'no-session-not-salient' };

/** Module-level throttle cursor (last fire time). Reset via resetSentinelSweepThrottle. */
let lastFiredAtMs = 0;

/** Test seam — reset the throttle cursor between cases. */
export function resetSentinelSweepThrottle(): void {
  lastFiredAtMs = 0;
}

/**
 * Run ONE proactive sweep tick. All gates are evaluated in cheapest-first order so
 * the common (flag-off) path is a single async read and a no-op. Returns a
 * structured result describing exactly what happened — the host just logs it.
 *
 * THROTTLE semantics: the throttle cursor advances only when an utterance/alert
 * actually FIRES (voice or attention), so a long run of silent/gated ticks never
 * consumes the cooldown — the next salient moment can speak immediately.
 */
export async function runSentinelProactiveSweep(
  state: SentinelSweepState,
  deps: SentinelSweepDeps,
): Promise<SentinelSweepResult> {
  // (1) master switch — DEFAULT OFF ⇒ this is the only work most ticks do.
  if (!(await deps.flagEnabled())) return { fired: false, gate: 'flag-off' };
  // (2) persona — only the Sentinel proactively speaks.
  if (state.humanFacingRole !== 'papercup') return { fired: false, gate: 'not-sentinel' };
  // (7) single-owner — only the elected lease holder runs the sweep so it never
  //     double-fires alongside a browser provider / a second host. Checked early
  //     (before any PG read) so a non-owner host is a pure no-op.
  if (!state.ownsVoiceLease) return { fired: false, gate: 'not-lease-owner' };
  // (3) DND, (4) pause, (5) proactive-ticks, (6) budget — the suppression gates.
  if (await deps.isSilenced()) return { fired: false, gate: 'dnd' };
  if (await deps.isPaused()) return { fired: false, gate: 'paused' };
  if (!(await deps.proactiveTicksEnabled())) return { fired: false, gate: 'proactive-ticks-off' };
  if (await deps.overBudget()) return { fired: false, gate: 'over-budget' };
  // (8) throttle — one utterance per cooldown window.
  const nowMs = deps.now();
  if (lastFiredAtMs !== 0 && nowMs - lastFiredAtMs < sentinelSweepThrottleMs()) {
    return { fired: false, gate: 'throttled' };
  }

  // Gather FLEET-STATUS (P-020) and let the Sentinel decide whether to speak.
  const status = await deps.gatherFleetStatus();

  if (state.sessionLive) {
    // Voice-ON path: run the scan, speak the reply if the Sentinel chose to.
    const say = (await deps.runSentinelScan(status.context))?.trim();
    if (!say) return { fired: false, gate: 'silent' };
    const spoke = await deps.speakIntoSession(say);
    if (!spoke) {
      deps.log?.('[sentinel-sweep] speakIntoSession returned false — not throttling');
      return { fired: false, gate: 'silent' };
    }
    lastFiredAtMs = nowMs;
    return { fired: true, via: 'voice', text: say };
  }

  // Voice-OFF path (P-021): no live session ⇒ route a SALIENT alert via
  // attention-push (importance-gated) + hindsight for the next "[While you were
  // away]". A non-salient status stays quiet — no push, no throttle consumed.
  if (!status.salient) return { fired: false, gate: 'no-session-not-salient' };
  const headline = (status.headline ?? '').trim() || 'The Sentinel has an update for you.';
  await deps.pushAttention(headline);
  await deps.notifyHindsight(headline);
  lastFiredAtMs = nowMs;
  return { fired: true, via: 'attention', headline };
}
