/**
 * TTS engine failure handling + STT mid-session disconnect probe
 * (Phase 1f, v4 §2k + §1.1.2).
 *
 * Pure logic — counters + transition-detection. The chrome wires these
 * to `toast()` via Sonner with `role="alert"` (assertive aria-live).
 *
 * TTS failure model:
 *   - On every speak() throw, increment consecutive-error counter
 *   - On 3 consecutive errors → mark engine disabled
 *   - Disabled state persists in-process (re-enable from /settings/voice)
 *   - On any successful speak(), reset counter to 0
 *
 * STT disconnect model:
 *   - 30s probe loop hits engine.health()
 *   - Track last-known-up state
 *   - On transition up→down: fire disconnect alert
 *   - On transition down→up: fire reconnect notice
 */

import { managedSetInterval } from '@papercusp/scheduled-registry';

const TTS_DISABLE_THRESHOLD = 3;
const STT_PROBE_INTERVAL_MS = 30_000;

interface TtsFailureState {
  consecutiveErrors: number;
  disabled: boolean;
  lastError: string | null;
}

const ttsState: TtsFailureState = {
  consecutiveErrors: 0,
  disabled: false,
  lastError: null,
};

export type TtsTransition =
  | { kind: 'none' }
  | { kind: 'now-disabled'; reason: string };

export function recordTtsSpeakSuccess(): void {
  ttsState.consecutiveErrors = 0;
  ttsState.lastError = null;
  // Note: success does NOT auto-re-enable; user opts back in via settings.
}

export function recordTtsSpeakError(message: string): TtsTransition {
  if (ttsState.disabled) return { kind: 'none' };
  ttsState.consecutiveErrors++;
  ttsState.lastError = message;
  if (ttsState.consecutiveErrors >= TTS_DISABLE_THRESHOLD) {
    ttsState.disabled = true;
    return { kind: 'now-disabled', reason: message };
  }
  return { kind: 'none' };
}

export function isTtsDisabled(): boolean {
  return ttsState.disabled;
}

export function reEnableTts(): void {
  ttsState.disabled = false;
  ttsState.consecutiveErrors = 0;
  ttsState.lastError = null;
}

export function _resetTtsHealthForTests(): void {
  ttsState.consecutiveErrors = 0;
  ttsState.disabled = false;
  ttsState.lastError = null;
}

// ────────────────────────────────────────────────────────────────────────
// STT mid-session disconnect probe
// ────────────────────────────────────────────────────────────────────────

export interface SttHealthMonitor {
  /** Stop the probe loop. Idempotent. */
  stop(): void;
}

export interface SttHealthCallbacks {
  onDisconnect: (engineKind: string) => void;
  onReconnect: (engineKind: string) => void;
}

/**
 * Start a probe loop on the given STT engine. Caller is responsible for
 * `.stop()` on teardown.
 */
export function startSttHealthMonitor(
  engineKind: string,
  probe: () => Promise<boolean>,
  callbacks: SttHealthCallbacks,
  intervalMs: number = STT_PROBE_INTERVAL_MS,
): SttHealthMonitor {
  let lastUp = true;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    let up = false;
    try { up = await probe(); } catch { up = false; }
    if (up !== lastUp) {
      if (up) callbacks.onReconnect(engineKind);
      else callbacks.onDisconnect(engineKind);
      lastUp = up;
    }
  };
  // Kick once immediately to anchor lastUp.
  void tick();

  const handle = managedSetInterval('voice-engine-health-probe', intervalMs, () => void tick(), { category: 'lifecycle', instanced: true });

  return {
    stop(): void {
      stopped = true;
      handle.stop();
    },
  };
}
