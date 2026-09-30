/**
 * NLMS acoustic echo canceller (textbook core) — holepunch-voice-channels
 * P-010 / D-013's operator-side AEC, generic-first per BORROWABLE discipline.
 *
 * Model: the near-end mic picks up the local playback (the far-end reference —
 * in Papercusp, the channel MIX the operator sends to local clients) through an
 * unknown room path: a bulk delay (socket + playout + acoustic + capture
 * latency, typically 50–300 ms) followed by a short impulse response. The
 * canceller is:
 *
 *   1. **Bulk-delay estimation** — decimated (÷16) normalized cross-correlation
 *      of the recent mic window against the far-end history, re-estimated every
 *      ~0.5 s. A jump beyond the adaptive filter's span resets the weights.
 *   2. **NLMS adaptive filter** — `taps` weights spanning the residual impulse
 *      response after delay alignment (with a safety `margin` ahead of the
 *      estimate), per-sample normalized-LMS update.
 *   3. **Geigel double-talk detector** — adaptation freezes (filtering
 *      continues) while near-end speech dominates, so the near talker doesn't
 *      smear the filter.
 *
 * Frames are PCM16 mono at a fixed rate (Papercusp: 960 samples @ 48 kHz).
 * Internally float (int16-valued — NLMS normalization is scale-free).
 *
 * Cost: O(2·taps) per sample ≈ 100 M MAC/s at the 1024-tap default @ 48 kHz —
 * realtime in Node on a desktop core, only paid while AEC is enabled and a
 * channel is live. Real-audio efficacy tuning (taps/mu/thresholds against a
 * physical speaker→mic loop) is the hardware-gated remainder recorded on the
 * plan; the synthetic echo-path tests pin convergence, delay recovery, and
 * double-talk behaviour.
 */

export interface NlmsAecOptions {
  /** Samples per frame (default 960 = 20 ms @ 48 kHz). */
  frameSamples?: number;
  /** Adaptive filter length in samples (default 1024 ≈ 21 ms @ 48 kHz). */
  taps?: number;
  /** NLMS step size 0<mu≤1 (default 0.5). */
  mu?: number;
  /** Bulk-delay search window in samples (default 11520 = 240 ms @ 48 kHz). */
  maxDelaySamples?: number;
  /** Alignment safety margin ahead of the delay estimate (default 480 = 10 ms). */
  marginSamples?: number;
}

const DECIMATION = 16;
/** Decimated mic window correlated against far history (240 ≈ 80 ms @ 48k/16). */
const XCORR_WINDOW = 240;
/** Re-estimate the bulk delay every N frames (25 × 20 ms = 0.5 s). */
const ESTIMATE_EVERY_FRAMES = 25;
/** Minimum normalized correlation to trust a delay estimate. */
const XCORR_THRESHOLD = 0.35;
/**
 * Geigel: near-end dominates when |mic|max > ratio × |far|max over the span.
 * The textbook 0.5 assumes ≥6 dB echo-return loss; a speaker driven loud next
 * to a mic can couple closer to unity, and a frozen filter never converges —
 * so we assume only ~1 dB of loss and lean on NLMS's own normalization for
 * robustness against the (now rarer) missed double-talk frames.
 */
const GEIGEL_RATIO = 0.9;
/** Far-end considered active above this RMS (int16 scale) — gates ERLE + DTD. */
const FAR_ACTIVE_RMS = 100;

export class NlmsAec {
  private readonly frameSamples: number;
  private readonly taps: number;
  private readonly mu: number;
  private readonly maxDelay: number;
  private readonly margin: number;

  /** Far-end history ring (int16-valued floats), power-of-two sized. */
  private readonly far: Float32Array;
  private readonly farMask: number;
  /** Absolute count of far-end samples written. */
  private farCount = 0;

  private readonly weights: Float32Array;
  /** Aligned reference power Σx² maintained incrementally per sample. */
  private delayBase = 0;
  private haveDelay = false;
  private weightsLive = false;

  // Decimated streams for the delay estimator.
  private readonly decFar: Float32Array;
  private readonly decMic: Float32Array;
  private decFarCount = 0;
  private decMicCount = 0;
  private framesSinceEstimate = 0;

  // Diagnostics.
  private erleNum = 1e-9;
  private erleDen = 1e-9;

  constructor(opts: NlmsAecOptions = {}) {
    this.frameSamples = opts.frameSamples ?? 960;
    this.taps = opts.taps ?? 1024;
    this.mu = opts.mu ?? 0.5;
    this.maxDelay = opts.maxDelaySamples ?? 11520;
    this.margin = opts.marginSamples ?? 480;

    let size = 1;
    while (size < this.maxDelay + this.taps + this.frameSamples * 2) size <<= 1;
    this.far = new Float32Array(size);
    this.farMask = size - 1;
    this.weights = new Float32Array(this.taps);

    const decLen = Math.ceil((this.maxDelay + this.frameSamples * 4) / DECIMATION) + XCORR_WINDOW;
    let decSize = 1;
    while (decSize < decLen) decSize <<= 1;
    this.decFar = new Float32Array(decSize);
    this.decMic = new Float32Array(XCORR_WINDOW);
  }

  /** Feed one playback frame (what the local user is hearing). */
  pushFarEnd(frame: Int16Array): void {
    for (let i = 0; i < frame.length; i++) {
      this.far[this.farCount++ & this.farMask] = frame[i];
    }
    // Decimate by block-averaging (cheap anti-alias for correlation purposes).
    for (let i = 0; i + DECIMATION <= frame.length; i += DECIMATION) {
      let acc = 0;
      for (let k = 0; k < DECIMATION; k++) acc += frame[i + k];
      this.decFar[this.decFarCount++ & (this.decFar.length - 1)] = acc / DECIMATION;
    }
  }

  /** Cancel the echo of the far-end from one mic frame. */
  process(mic: Int16Array): Int16Array {
    // Decimated mic window (ring of the most recent XCORR_WINDOW samples).
    for (let i = 0; i + DECIMATION <= mic.length; i += DECIMATION) {
      let acc = 0;
      for (let k = 0; k < DECIMATION; k++) acc += mic[i + k];
      this.decMic[this.decMicCount++ % XCORR_WINDOW] = acc / DECIMATION;
    }
    if (++this.framesSinceEstimate >= ESTIMATE_EVERY_FRAMES) {
      this.framesSinceEstimate = 0;
      this.reestimateDelay();
    }

    if (!this.haveDelay) {
      // No alignment yet — pass through (no far-end correlation found).
      return mic;
    }

    const out = new Int16Array(mic.length);
    const w = this.weights;
    const far = this.far;
    const mask = this.farMask;
    const taps = this.taps;

    // The mic frame's last sample aligns with farCount (both "now"). The
    // first mic sample is frameSamples back from that.
    const frameBase = this.farCount - mic.length;

    // Geigel DTD over this frame: near-end dominates → freeze adaptation.
    let micMax = 0;
    for (let i = 0; i < mic.length; i++) {
      const a = Math.abs(mic[i]);
      if (a > micMax) micMax = a;
    }
    let farMax = 0;
    let farEnergy = 0;
    {
      const start = frameBase - this.delayBase - taps;
      const end = frameBase - this.delayBase + mic.length;
      for (let t = start; t < end; t++) {
        if (t < 0) continue;
        const v = Math.abs(far[t & mask]);
        if (v > farMax) farMax = v;
        farEnergy += v * v;
      }
      farEnergy /= Math.max(1, end - start);
    }
    const farActive = Math.sqrt(farEnergy) > FAR_ACTIVE_RMS;
    const doubleTalk = micMax > GEIGEL_RATIO * farMax;
    const adapt = farActive && !doubleTalk;

    let micE = 0;
    let errE = 0;
    for (let i = 0; i < mic.length; i++) {
      const t = frameBase + i; // absolute time of this mic sample
      const refBase = t - this.delayBase; // newest aligned far sample
      // y_hat = Σ w[k] · far(refBase - k)
      let yHat = 0;
      let xPow = 1e-6;
      for (let k = 0; k < taps; k++) {
        const idx = refBase - k;
        if (idx < 0) break;
        const x = far[idx & mask];
        yHat += w[k] * x;
        xPow += x * x;
      }
      const d = mic[i];
      let e = d - yHat;
      if (e > 32767) e = 32767;
      else if (e < -32768) e = -32768;
      out[i] = e;
      micE += d * d;
      errE += e * e;
      if (adapt) {
        const g = (this.mu * (d - yHat)) / xPow;
        for (let k = 0; k < taps; k++) {
          const idx = refBase - k;
          if (idx < 0) break;
          w[k] += g * far[idx & mask];
        }
        this.weightsLive = true;
      }
    }
    if (farActive && !doubleTalk) {
      this.erleNum += micE;
      this.erleDen += errE;
    }
    return out;
  }

  /** The current bulk-delay estimate in samples, or null before lock. */
  estimatedDelaySamples(): number | null {
    return this.haveDelay ? this.delayBase + this.margin : null;
  }

  /** Running echo-return-loss-enhancement (dB) while far-end was active. */
  erleDb(): number {
    return 10 * Math.log10(this.erleNum / this.erleDen);
  }

  private reestimateDelay(): void {
    if (this.decMicCount < XCORR_WINDOW) return;
    const maxLagDec = Math.floor(this.maxDelay / DECIMATION);
    // Rebuild the mic window in time order (oldest → newest).
    const micWin = new Float32Array(XCORR_WINDOW);
    for (let i = 0; i < XCORR_WINDOW; i++) {
      micWin[i] = this.decMic[(this.decMicCount - XCORR_WINDOW + i) % XCORR_WINDOW];
    }
    let micPow = 1e-9;
    for (let i = 0; i < XCORR_WINDOW; i++) micPow += micWin[i] * micWin[i];

    const decMask = this.decFar.length - 1;
    let bestLag = -1;
    let bestCorr = 0;
    for (let lag = 0; lag <= maxLagDec; lag++) {
      // far window ending `lag` dec-samples before "now"
      const farEnd = this.decFarCount - lag;
      const farStart = farEnd - XCORR_WINDOW;
      if (farStart < 0 || farStart < this.decFarCount - this.decFar.length) break;
      let dot = 0;
      let farPow = 1e-9;
      for (let i = 0; i < XCORR_WINDOW; i++) {
        const f = this.decFar[(farStart + i) & decMask];
        dot += micWin[i] * f;
        farPow += f * f;
      }
      const corr = dot / Math.sqrt(micPow * farPow);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }
    if (bestLag < 0 || bestCorr < XCORR_THRESHOLD) return;

    const delay = bestLag * DECIMATION;
    const newBase = Math.max(0, delay - this.margin);
    if (!this.haveDelay) {
      this.delayBase = newBase;
      this.haveDelay = true;
      return;
    }
    // A small drift stays inside the filter span; a real jump re-anchors and
    // (when weights were already adapted) resets them — the alignment moved.
    if (Math.abs(newBase - this.delayBase) > this.margin) {
      this.delayBase = newBase;
      if (this.weightsLive) {
        this.weights.fill(0);
        this.weightsLive = false;
      }
    }
  }
}
