/** Clamped PCM16 gain — the `voiceInputGain` stage (unity = pass-through). */
export function applyGainPcm16(frame: Int16Array, gain: number): Int16Array {
  if (gain === 1) return frame;
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] * gain;
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0;
  }
  return out;
}
