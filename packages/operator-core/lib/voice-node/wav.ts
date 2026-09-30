/** Minimal PCM16 WAV encode/decode — enough for Whisper upload + TTS playback. */

export function encodeWavPcm16(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const w = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, dataLen, true);
  new Int16Array(buf, 44).set(samples);
  return new Uint8Array(buf);
}

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  samples: Int16Array; // mono-mixed
}

/** Decode a PCM16 RIFF WAV (any channel count → mono-mixed). Throws on non-PCM16. */
export function decodeWavPcm16(bytes: Uint8Array): DecodedWav {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('wav: not RIFF/WAVE');
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let data: Uint8Array | null = null;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') {
      const fmt = v.getUint16(off + 8, true);
      channels = v.getUint16(off + 10, true);
      sampleRate = v.getUint32(off + 12, true);
      bits = v.getUint16(off + 22, true);
      if (fmt !== 1 || bits !== 16) throw new Error(`wav: need PCM16, got fmt=${fmt} bits=${bits}`);
    } else if (id === 'data') {
      data = bytes.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!data || !sampleRate || !channels) throw new Error('wav: missing fmt/data');
  const interleaved = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (channels === 1) return { sampleRate, channels, samples: interleaved };
  const mono = new Int16Array(Math.floor(interleaved.length / channels));
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += interleaved[i * channels + c];
    mono[i] = Math.round(sum / channels);
  }
  return { sampleRate, channels, samples: mono };
}

/** Linear resample PCM16 mono. Identity when rates match. */
export function resamplePcm16(samples: Int16Array, srcRate: number, dstRate: number): Int16Array {
  if (srcRate === dstRate || samples.length === 0) return samples;
  const ratio = srcRate / dstRate;
  const out = new Int16Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = samples[Math.min(i0, samples.length - 1)];
    const b = samples[Math.min(i0 + 1, samples.length - 1)];
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}
