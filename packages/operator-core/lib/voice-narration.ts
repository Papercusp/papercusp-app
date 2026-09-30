/**
 * Voice narration — side-channel TTS dispatch for long-op announcements.
 *
 * Per /docs/agents/operator-persona §6: narration bypasses the EL Conv
 * AI agent. We POST the deterministic template to the existing TTS
 * preview endpoint (which proxies to ElevenLabs/OpenAI/Cartesia
 * server-side using the user's stored API keys), get back an audio
 * stream, and play it through the operator's existing audio sink.
 *
 * Why side-channel:
 *   - Cost: narration doesn't burn EL Conv AI minutes
 *   - Determinism: templates are exact strings, no LLM rephrasing
 *   - Provider-agnostic: works whether the live voice is EL, Realtime, or off
 *
 * API:
 *   announceOpStart(kind, ctx) → NarrationHandle
 *   announceOpEnd(kind, ctx)
 *
 * Handle.cancel() clears any pending mid-update timers. Always call it
 * (or call announceOpEnd) — leaked timers fire stale narration.
 */

'use client';

import { OP_POLICIES, kickoffText, midText, completionText, type OpKind, type CompletionCtx, type KickoffCtx } from './op-narration-policy';

export interface NarrationHandle {
  /** Clear any pending mid-update timers. Idempotent. */
  cancel(): void;
}

interface InternalState {
  audioCtx: AudioContext | null;
  current: HTMLAudioElement | null;
  enabled: boolean;
  /** Refreshed from /api/agent-mcp/operator-voice-prefs once per session. */
  prefsRefreshedAt: number;
}

const state: InternalState = {
  audioCtx: null,
  current: null,
  enabled: true,
  prefsRefreshedAt: 0,
};

const PREFS_REFRESH_MS = 30_000;

async function maybeRefreshPrefs(): Promise<void> {
  const now = Date.now();
  if (now - state.prefsRefreshedAt < PREFS_REFRESH_MS) return;
  state.prefsRefreshedAt = now;
  try {
    const r = await fetch('/api/agent-mcp/operator-voice-prefs');
    if (!r.ok) return;
    const prefs = (await r.json()) as { narrateLongOps?: boolean; fullAgentEngine?: string };
    const userOptedOut = prefs.narrateLongOps === false;
    // When a full-agent engine (EL Conv AI / OpenAI Realtime) is on,
    // the agent itself can speak ("still working through it") in its
    // own voice. The local side-channel narration was designed for
    // the STT+Claude+TTS path where nothing else was talking — running
    // both produces a second, mismatched voice talking over the agent
    // ("Still on it." in Rachel while the agent is mid-sentence in
    // Relaxing Rachel). Disable side-channel narration whenever a
    // full-agent engine is active.
    const fullAgentActive = !!prefs.fullAgentEngine && prefs.fullAgentEngine !== 'off';
    state.enabled = !userOptedOut && !fullAgentActive;
  } catch {
    /* keep last value */
  }
}

/**
 * Send `text` to the side-channel TTS endpoint and play it. Cancels
 * any in-flight narration (one narration line at a time — newer wins).
 */
async function speak(text: string): Promise<void> {
  if (typeof window === 'undefined') return;
  await maybeRefreshPrefs();
  if (!state.enabled) return;

  // Cancel any in-flight narration first — last-line-wins.
  if (state.current) {
    try { state.current.pause(); } catch { /* ignore */ }
    state.current = null;
  }

  let resp: Response;
  try {
    resp = await fetch('/api/agent-mcp/operator-tts-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'elevenlabs', text }),
    });
  } catch {
    return;
  }
  if (!resp.ok) return;

  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  state.current = audio;
  audio.onended = () => {
    URL.revokeObjectURL(url);
    if (state.current === audio) state.current = null;
  };
  audio.onerror = () => {
    URL.revokeObjectURL(url);
    if (state.current === audio) state.current = null;
  };
  try {
    await audio.play();
  } catch {
    // Autoplay blocked or other transient — drop the line.
    URL.revokeObjectURL(url);
    if (state.current === audio) state.current = null;
  }
}

/**
 * Listen for user-speech events (handled by voice-mode) and duck the
 * current narration so we don't talk over the user. Only ducks; doesn't
 * re-speak after.
 */
function attachDuckListener(): void {
  if (typeof window === 'undefined') return;
  if ((window as any).__pcNarrationDuckAttached) return;
  (window as any).__pcNarrationDuckAttached = true;
  window.addEventListener('voice:user-speaking', () => {
    if (state.current) {
      try { state.current.pause(); } catch { /* ignore */ }
      state.current = null;
    }
  });
}

attachDuckListener();

/**
 * Begin a long-op narration. Speaks the kickoff line if the policy
 * allows and schedules mid-update lines per cadence. Returns a handle
 * to cancel pending timers.
 *
 * Caller MUST invoke either handle.cancel() or announceOpEnd to clean
 * up timers.
 */
export function announceOpStart(kind: OpKind, ctx: KickoffCtx = {}): NarrationHandle {
  const policy = OP_POLICIES[kind];
  const kickoff = kickoffText(kind, ctx);
  if (kickoff) void speak(kickoff);

  const timers: ReturnType<typeof setTimeout>[] = [];
  if (policy.midMaxFires > 0) {
    let fired = 0;
    const scheduleNext = (delay: number) => {
      const t = setTimeout(() => {
        const text = midText(kind, fired);
        if (text) void speak(text);
        fired++;
        if (fired < policy.midMaxFires && policy.midCadenceMs > 0) {
          scheduleNext(policy.midCadenceMs);
        }
      }, delay);
      timers.push(t);
    };
    scheduleNext(policy.midFirstAt);
  }

  return {
    cancel() {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
  };
}

/**
 * Announce op completion. Caller passes the same handle from
 * announceOpStart so we can cancel the pending mid timers in one step.
 *
 * Outcome `'ok'` uses default-mode template; `'fail'` uses sober. The
 * narration mode is informational — at the TTS layer all narration
 * uses the same voice tuning constants today (§3 of the persona plan).
 */
export function announceOpEnd(
  kind: OpKind,
  ctx: CompletionCtx,
  handle?: NarrationHandle,
): void {
  handle?.cancel();
  const result = completionText(kind, ctx);
  if (!result) return;
  void speak(result.text);
}

/**
 * Test-only: drain in-flight narration state. Doesn't pause audio
 * (that's a browser API); just resets the handle bookkeeping.
 */
export function __resetNarrationStateForTests(): void {
  state.current = null;
  state.prefsRefreshedAt = 0;
  state.enabled = true;
}
