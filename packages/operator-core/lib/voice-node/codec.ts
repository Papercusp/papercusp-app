/**
 * Opus codec seam for @papercusp/p2p-voice — opusscript (WASM) implementation.
 *
 * D-010: the codec lives HERE (the operator), not in the clients — clients
 * stream raw 48k PCM16 over the local voice socket; the agent tap needs decoded
 * audio operator-side anyway. opusscript is WASM (zero native-ABI risk on
 * Node 25); a native @discordjs/opus swap behind this same seam is a later
 * optimization if profiling ever asks for it.
 */
import type { VoiceCodec } from '@papercusp/p2p-voice';

export const VOICE_SAMPLE_RATE = 48_000;
export const VOICE_FRAME_MS = 20;
/** 20ms @ 48kHz mono. */
export const VOICE_FRAME_SAMPLES = (VOICE_SAMPLE_RATE / 1000) * VOICE_FRAME_MS; // 960

interface OpusScriptLike {
  encode(pcm: Buffer, frameSize: number): Buffer;
  decode(data: Buffer): Buffer;
  delete(): void;
}

let codecPromise: Promise<VoiceCodec & { dispose(): void }> | null = null;

export function getOpusCodec(): Promise<VoiceCodec & { dispose(): void }> {
  codecPromise ??= (async () => {
    // Lazy import — opusscript is declared in apps/operator (hoisted to root),
    // mirroring how the hyperbee swarm lazy-imports hyperswarm.
    const mod = (await import('opusscript')) as unknown as {
      default: new (rate: number, channels: number, application?: number) => OpusScriptLike;
    } & { default: { Application?: { VOIP: number } } & (new (r: number, c: number, a?: number) => OpusScriptLike) };
    const OpusScript = mod.default;
    const app = (OpusScript as unknown as { Application?: { VOIP: number } }).Application?.VOIP;
    const opus = new OpusScript(VOICE_SAMPLE_RATE, 1, app);
    const codec: VoiceCodec & { dispose(): void } = {
      frameSamples: VOICE_FRAME_SAMPLES,
      encode(pcm: Int16Array): Uint8Array {
        const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        return new Uint8Array(opus.encode(buf, VOICE_FRAME_SAMPLES));
      },
      decode(data: Uint8Array): Int16Array {
        const out = opus.decode(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        return new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2);
      },
      dispose() {
        try {
          opus.delete();
        } catch {
          /* already disposed */
        }
        codecPromise = null;
      },
    };
    return codec;
  })();
  return codecPromise;
}
