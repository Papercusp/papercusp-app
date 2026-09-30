/**
 * sentinel-says-pump — voice-OUT for the one-brain pipeline
 * (voice-unified-sentinel-pipeline-2026-07-01, P-002/D-001/D-002).
 *
 * The Sentinel pane (the one brain) speaks by calling `voice:say`, which lands
 * lines in the shared PG FIFO `harness_shared.sentinel_says` (migration 390).
 * While an operator voice session is LIVE, this pump drains those lines
 * server-side, synthesizes them (the same synth→WAV→PCM→OPV_RESPONSE_AUDIO
 * pattern the proactive sweep uses), and fans them out over the voice bus to
 * every attached client (webview, TUI) — the elected player renders. Each line
 * is also broadcast as a response transcript (clients display the text) and
 * persisted to the shared conversation thread, so the answer is WRITTEN and
 * SPOKEN identically whether the question arrived by voice or typed text.
 *
 * When NO session is live the pump stays hands-off: the webview's local-mode
 * drain of GET /operator/papercup-output keeps working as before (kokoro
 * speak-on-poll). The `sessionLive` gate is what keeps exactly one consumer on
 * the FIFO at a time; the PG drain itself (DELETE … RETURNING) is atomic, so a
 * transition race delivers a line to exactly one of them, never both.
 *
 * Pure orchestration over injected ports so it unit-tests without PG or audio.
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { encodeResponseTranscript } from './operator-voice-bus';

export interface SentinelSaysPumpDeps {
  /** Is the shared operator voice session live (status !== 'off')? */
  sessionLive(): boolean;
  /** Drain-and-clear the pending pane lines (prod: drainSentinelSays / PG). */
  drain(): Promise<string[]>;
  /** Synthesize + broadcast one line as bus audio (prod: speakIntoSession). */
  speak(text: string): Promise<boolean>;
  /** Fan a framed bus message to every attached client. */
  broadcast(frame: Uint8Array): void;
  log?(msg: string): void;
}

export const SAYS_PUMP_TICK_MS = 1_000;

/**
 * One pump tick: drain pending lines and, in order, display + speak each.
 * Chat persistence is NOT the pump's job (WI-4838): the `voice:say` tool
 * persists at PUSH time — one seam shared by every drain path — so a
 * drain-time persist here would double-write the turn.
 * Exported for unit tests; `startSentinelSaysPump` runs it on an interval
 * with a re-entrancy guard (a long synth must not overlap the next tick).
 */
export async function pumpSentinelSaysOnce(deps: SentinelSaysPumpDeps): Promise<number> {
  if (!deps.sessionLive()) return 0;
  const lines = await deps.drain();
  for (const line of lines) {
    // Transcript first so the text appears even if synth fails.
    deps.broadcast(encodeResponseTranscript({ text: line }));
    const spoken = await deps.speak(line).catch(() => false);
    if (!spoken) deps.log?.(`says-pump: synth failed for line (${line.length} chars)`);
  }
  return lines.length;
}

export function startSentinelSaysPump(deps: SentinelSaysPumpDeps, tickMs = SAYS_PUMP_TICK_MS): ManagedHandle {
  let inFlight = false;
  return managedSetInterval(
    'operator-voice-sentinel-says-pump',
    tickMs,
    () => {
      if (inFlight) return;
      inFlight = true;
      void pumpSentinelSaysOnce(deps)
        .catch((err) => deps.log?.(`says-pump tick failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          inFlight = false;
        });
    },
    { category: 'lifecycle' },
  );
}
