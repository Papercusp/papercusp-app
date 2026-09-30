'use client';

/**
 * Self-echo protection as a property of the AUDIO, not of the clock (WI-954890).
 *
 * WHAT WAS WRONG. The half-duplex guard added for WI-4500 asked "is papercup
 * speaking RIGHT NOW, or did it stop within the last 700ms?" — evaluated at the
 * moment a transcript was DISPATCHED. But a transcript is dispatched long after
 * the audio it describes was captured, and the gap is not small:
 *
 *   • end-of-speech detection is dead time before transcription even starts —
 *     energy-VAD `hangoverFrames: 8` × 4096 samples = 683ms @48kHz (743ms
 *     @44.1kHz); the Silero path's `redemptionFrames: 8` × 512 samples = 256ms;
 *   • then whisper. MEASURED 2026-08-30 against the shipped local server
 *     (127.0.0.1:2022, 16 kHz mono WAV): 0.96s of audio → 827/976/1037ms ·
 *     3.08s → 588ms (fastest seen, warm) to 1378ms · 10.14s → 2111-3056ms.
 *     Latency tracks machine state far more than audio length, so there is no
 *     short-utterance case that comes in under budget.
 *
 * So even the FASTEST path observed from "audio stopped" to "guard evaluated"
 * costs 683 + 588 = 1271ms, against a 700ms window — and a normal reply is
 * 2-3.8s. The cooldown was expired by ~1.8× at absolute best and several times
 * over typically; it could never be in effect when an echo arrived. What
 * actually protected the product was only the `isSynthSpeaking` branch, which
 * catches mid-reply segments of a long reply; the FINAL segment, whose
 * speech-end is CAUSED by the playout stopping, always escaped. That segment
 * carries the reply's closing words, which is exactly the "Okay, Papercup has
 * completed the release check." shape that failed C4 of the voice-public-release
 * acceptance grade — verified end-to-end with real Kokoro audio through the real
 * local whisper: playout-end→dispatch 1271ms, old guard passes it, this one
 * rejects it, and real user speech after the room goes quiet still gets through.
 *
 * WHAT THIS DOES INSTEAD. Record WHEN our own playout was audible, carry the
 * capture window's real start/end with the audio, and reject an utterance whose
 * AUDIO overlapped playout — however late the transcript turns up. The decision
 * no longer references the current time at all, so it cannot be outrun by a slow
 * transcription, a long utterance, a loaded box, or a future STT engine. The one
 * remaining tunable is PLAYOUT_TAIL_MS, and it now has a single, checkable job:
 * cover acoustic decay (speaker buffer + room), not machine latency.
 */

/** The wall-clock span of real audio a transcript was produced from. */
export interface CaptureWindow {
  /** Wall-clock ms at which the captured audio BEGAN. */
  startedAtMs: number;
  /** Wall-clock ms at which the captured audio ENDED. */
  endedAtMs: number;
}

/**
 * Acoustic settle tail added after playout ends. This covers ONLY the physical
 * decay — the audio device's buffer and the room — because the machine latency
 * that used to have to fit inside the old cooldown is now irrelevant to the
 * decision. Widening this trades a slightly longer post-reply deaf spot for
 * echo safety; it can never again be defeated by a slow transcription.
 */
export const PLAYOUT_TAIL_MS = 300;

/** Forget playout older than this — the ledger is for recent audio, not history. */
const KEEP_MS = 60_000;
/** Hard cap so a pathological session can't grow the ledger without bound. */
const MAX_INTERVALS = 64;

interface PlayoutInterval {
  startedAtMs: number;
  /** null while playout is still in progress. */
  endedAtMs: number | null;
}

/**
 * A short ledger of when our own TTS was audible, so a captured window can be
 * tested for overlap against it.
 *
 * `open()`/`close()` are driven by the synth lifecycle. Every path that stops
 * playout must close — including barge-in cancel, which the old scalar cooldown
 * never handled (it cleared `isSynthSpeaking` and left `synthQuietSince` stale,
 * so a cancelled reply started no cooldown at all).
 */
export class PlayoutLedger {
  private intervals: PlayoutInterval[] = [];
  private readonly tailMs: number;

  constructor(opts: { tailMs?: number } = {}) {
    this.tailMs = opts.tailMs ?? PLAYOUT_TAIL_MS;
  }

  /** True while at least one playout interval is still open. */
  get isPlaying(): boolean {
    return this.intervals.some((iv) => iv.endedAtMs === null);
  }

  /** Playout started. Coalesces: a second open while one is in flight is a no-op. */
  open(atMs: number = Date.now()): void {
    if (!this.isPlaying) this.intervals.push({ startedAtMs: atMs, endedAtMs: null });
    this.prune(atMs);
  }

  /** Playout ended (queue drained, cancelled, or torn down). Idempotent. */
  close(atMs: number = Date.now()): void {
    for (const iv of this.intervals) {
      if (iv.endedAtMs === null) iv.endedAtMs = Math.max(atMs, iv.startedAtMs);
    }
    this.prune(atMs);
  }

  /**
   * Did this captured audio overlap any interval in which our own playout was
   * audible? Deliberately takes NO `now` argument — that is the whole point:
   * the verdict is a property of the recording, so it is identical whether the
   * transcript arrives in 200ms or 20 seconds.
   */
  overlaps(win: CaptureWindow): boolean {
    for (const iv of this.intervals) {
      const audibleEnd = iv.endedAtMs === null
        ? Number.POSITIVE_INFINITY
        : iv.endedAtMs + this.tailMs;
      if (win.startedAtMs < audibleEnd && win.endedAtMs > iv.startedAtMs) return true;
    }
    return false;
  }

  /** Drop everything (mode change / tests). */
  reset(): void {
    this.intervals = [];
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - KEEP_MS;
    this.intervals = this.intervals.filter(
      (iv) => iv.endedAtMs === null || iv.endedAtMs + this.tailMs >= cutoff,
    );
    if (this.intervals.length > MAX_INTERVALS) {
      this.intervals = this.intervals.slice(-MAX_INTERVALS);
    }
  }
}

/**
 * Build a capture window from the moment the audio ENDED plus how long it ran.
 *
 * Both capture paths know their audio's true duration (they hold the samples),
 * and both can name the instant it ended better than "now" — so neither has to
 * guess. Where an estimate is unavoidable, err EARLY: shifting a window later
 * than the truth is what loses an overlap, while shifting it earlier only ever
 * costs a little extra caution.
 */
export function captureWindowEndingAt(endedAtMs: number, durationMs: number): CaptureWindow {
  return { startedAtMs: endedAtMs - Math.max(0, durationMs), endedAtMs };
}
