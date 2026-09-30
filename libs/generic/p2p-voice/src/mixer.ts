/** Pure PCM16 mixing + level helpers. */

/** Saturating sum of N equal-length Int16 frames into one. Empty input → silence. */
export function mixInt16(frames: Int16Array[], frameLength: number): Int16Array {
  const out = new Int16Array(frameLength);
  for (const f of frames) {
    const n = Math.min(frameLength, f.length);
    for (let i = 0; i < n; i++) {
      const v = out[i] + f[i];
      out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
  }
  return out;
}

/** Mean-absolute level, normalized 0..1 — cheap speaking detector input. */
export function energy(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += Math.abs(frame[i]);
  return sum / frame.length / 32768;
}
