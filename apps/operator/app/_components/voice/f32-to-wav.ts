/**
 * WAV (PCM16, mono) encoder for Float32 audio samples.
 *
 * Extracted from stt-voicemode.ts so the pure byte-encoding can be unit
 * tested without importing `@ricky0123/vad-web` — a browser-only module
 * that can't load in the node test environment.
 *
 * Whisper's HTTP endpoint handles WAV natively; cleaner than re-encoding
 * to webm/opus and round-tripping.
 */

/** Encode mono Float32 samples as a little-endian PCM16 WAV byte buffer. */
export function f32ToWavBuffer(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const numChannels = 1;
  const bytesPerSample = 2; // PCM16
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  let offset = 0;
  function writeStr(s: string) {
    for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i));
  }
  function writeU32(v: number) { view.setUint32(offset, v, true); offset += 4; }
  function writeU16(v: number) { view.setUint16(offset, v, true); offset += 2; }

  writeStr('RIFF');
  writeU32(36 + dataSize);
  writeStr('WAVE');
  writeStr('fmt ');
  writeU32(16);              // PCM header size
  writeU16(1);               // PCM format
  writeU16(numChannels);
  writeU32(sampleRate);
  writeU32(byteRate);
  writeU16(blockAlign);
  writeU16(bytesPerSample * 8);
  writeStr('data');
  writeU32(dataSize);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buf;
}

/** Encode mono Float32 samples as a WAV Blob (audio/wav). */
export function f32ToWav(samples: Float32Array, sampleRate = 16000): Blob {
  return new Blob([f32ToWavBuffer(samples, sampleRate)], { type: 'audio/wav' });
}
