/**
 * voice-node/kokoro-local — IN-PROCESS local TTS via the `@papercusp/kokoro-tts` port
 * (voice-public-release-readiness-2026-07-12 P-009 hop 2/3, plan D-009, WI-4449).
 *
 * Public users get free, keyless, offline TTS with ZERO sidecar: Kokoro-82M runs on the repo's
 * existing @huggingface/transformers 4.2.0 + onnxruntime-node (native EP). The kokoro-js npm
 * package is deliberately NOT a dependency — it pins transformers 3.x, which npm-workspaces
 * `overrides` cannot dedupe (a 706MB duplicate onnxruntime stack; see @papercusp/kokoro-tts's
 * header and WI-4471) — so its ~200 lines of glue were originally vendored in-tree, then
 * extracted to `libs/generic/kokoro-tts` behind a `configureKokoroTts()` host seam (WI-4470)
 * so the package itself carries zero transformers coupling.
 *
 * Measured live 2026-07-12 on this box (CPU q8, steady state over 4 synths): rtFactor 0.81–1.07,
 * i.e. roughly real-time — parity with the kokoro-js spike (0.71–1.03), so vendoring cost no
 * performance. The FIRST synth in a process is slower (~1.8x) — graph + threadpool warm-up.
 * The cloud engines remain the low-latency option, and an external kokoro server on KOKORO_URL
 * (e.g. the dev box's GPU kokoro-fastapi) always takes precedence in tts-synth.ts.
 *
 * Layers:
 *   - `isKokoroLocalProvisioned()` — fs-only marker check (no model load, no network).
 *   - `provisionKokoroLocal()`     — the explicit "install local voice" step: downloads the
 *     ~90MB q8 ONNX model + voices into `~/.papercusp/models/kokoro`, validates with a real
 *     warm synth, then writes the `.provisioned.json` marker. Single-flight.
 *   - `kokoroLocalSynthWav()`      — lazy-loads the engine once per process and synthesizes
 *     a PCM16 WAV (the container tts-synth.ts's kokoro branch already advertises).
 *
 * The model id/dtype are pinned here; the marker records them so a future pin bump simply
 * re-provisions (marker mismatch reads as not-provisioned).
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { encodeWavPcm16 } from './wav';
import { probeKokoroHealth } from '../endpoint-route/routes/agent-mcp/operator-voice-proxy-helpers';

export const KOKORO_LOCAL_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_LOCAL_DTYPE = 'q8';
export const KOKORO_LOCAL_DEFAULT_VOICE = 'af_bella';

interface ProvisionMarker {
  modelId: string;
  dtype: string;
  provisionedAt: string;
}

/** Minimal structural type for the kokoro engine (`@papercusp/kokoro-tts`'s KokoroTts, loaded
 *  dynamically — keeping this file import-light means no onnxruntime native load at operator
 *  boot). */
export interface KokoroEngineLike {
  generate(text: string, opts: { voice: string }): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

export interface KokoroLocalDeps {
  home?: string;
  /** Engine loader injection for tests (default: dynamic-import kokoro-js). */
  loadEngine?: (modelDir: string) => Promise<KokoroEngineLike>;
  now?: () => string;
}

function defaultHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '';
}

export function kokoroLocalCacheDir(home = defaultHome()): string {
  return `${home}/.papercusp/models/kokoro`;
}

function markerPath(home?: string): string {
  return `${kokoroLocalCacheDir(home)}/.provisioned.json`;
}

/** fs-only: has the explicit provision step completed for the CURRENT model pin? */
export async function isKokoroLocalProvisioned(home?: string): Promise<boolean> {
  const p = markerPath(home);
  if (!existsSync(p)) return false;
  try {
    const marker = JSON.parse(await readFile(p, 'utf8')) as ProvisionMarker;
    return marker.modelId === KOKORO_LOCAL_MODEL_ID && marker.dtype === KOKORO_LOCAL_DTYPE;
  } catch {
    return false;
  }
}

async function defaultLoadEngine(cacheDir: string): Promise<KokoroEngineLike> {
  // Dynamic import keeps onnxruntime-node's native load OFF the operator boot path — the
  // engine only materializes on first provision/synth. @papercusp/kokoro-tts (WI-4470,
  // extracted from the formerly-vendored ./kokoro/kokoro-tts) carries zero transformers
  // coupling of its own — we wire the repo's own @huggingface/transformers 4.2.0 in via its
  // configureKokoroTts() host seam (see its header for why not the kokoro-js npm package,
  // and config.ts for why injection instead of a direct dependency).
  const [{ KokoroTts, configureKokoroTts }, transformers] = await Promise.all([
    import('@papercusp/kokoro-tts'),
    import('@huggingface/transformers'),
  ]);
  configureKokoroTts({
    StyleTextToSpeech2Model: transformers.StyleTextToSpeech2Model,
    AutoTokenizer: transformers.AutoTokenizer,
    Tensor: transformers.Tensor,
  });
  return KokoroTts.from_pretrained(KOKORO_LOCAL_MODEL_ID, {
    dtype: KOKORO_LOCAL_DTYPE,
    device: 'cpu',
    // Keeps model + voice files in OUR cache dir instead of mutating the global env.cacheDir
    // (which other in-repo transformers users own).
    cacheDir,
    voicesDir: `${cacheDir}/voices`,
  });
}

// One engine per process (the model is ~300MB resident once loaded — lazily, never at boot).
let enginePromise: Promise<KokoroEngineLike> | null = null;

/** Test hook. */
export function __resetKokoroLocalForTests(): void {
  enginePromise = null;
  provisioning = null;
}

function getEngine(deps: KokoroLocalDeps = {}): Promise<KokoroEngineLike> {
  if (!enginePromise) {
    const load = deps.loadEngine ?? defaultLoadEngine;
    enginePromise = load(kokoroLocalCacheDir(deps.home)).catch((e) => {
      enginePromise = null; // a failed load must not poison every later call
      throw e;
    });
  }
  return enginePromise;
}

export interface KokoroProvisionResult {
  ok: boolean;
  blocked?: string;
}

let provisioning: Promise<KokoroProvisionResult> | null = null;

/**
 * The explicit download-on-first-enable step (plan D-009): fetch model + voices, prove the
 * engine actually synthesizes, then write the marker. Single-flight — concurrent calls
 * coalesce. Never throws.
 */
export async function provisionKokoroLocal(deps: KokoroLocalDeps = {}): Promise<KokoroProvisionResult> {
  if (await isKokoroLocalProvisioned(deps.home)) return { ok: true };
  if (provisioning) return provisioning;
  provisioning = (async (): Promise<KokoroProvisionResult> => {
    try {
      const cacheDir = kokoroLocalCacheDir(deps.home);
      await mkdir(cacheDir, { recursive: true });
      const engine = await getEngine(deps); // from_pretrained downloads into cacheDir
      // Verify-then-mark: a marker must mean "synthesis WORKS", not "files downloaded".
      const audio = await engine.generate('Local voice ready.', { voice: KOKORO_LOCAL_DEFAULT_VOICE });
      if (!audio?.audio?.length) return { ok: false, blocked: 'kokoro engine loaded but produced empty audio' };
      const marker: ProvisionMarker = {
        modelId: KOKORO_LOCAL_MODEL_ID,
        dtype: KOKORO_LOCAL_DTYPE,
        provisionedAt: (deps.now ?? (() => new Date().toISOString()))(),
      };
      await writeFile(markerPath(deps.home), JSON.stringify(marker, null, 2), 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, blocked: `kokoro local provisioning failed: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      provisioning = null;
    }
  })();
  return provisioning;
}

/** "Can the kokoro engine synthesize on this box?" — an external HTTP kokoro (KOKORO_URL)
 *  OR the provisioned in-process engine. The one answer resolveTtsEngine's browser→kokoro
 *  fallback and the settings health probe both need (P-009 hop 3). */
export async function kokoroTtsAvailable(): Promise<boolean> {
  return (await probeKokoroHealth()) || isKokoroLocalProvisioned();
}

export type KokoroSynth =
  | { ok: true; audio: ArrayBuffer; contentType: 'audio/wav' }
  | { ok: false; error: string };

/** Convert kokoro's float32 [-1,1] PCM to a 24kHz PCM16 RIFF/WAVE (the same channel-ready
 *  container the HTTP kokoro path returns). Pure. */
export function float32ToWav(audio: Float32Array, sampleRate: number): ArrayBuffer {
  const samples = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const clamped = Math.max(-1, Math.min(1, audio[i]));
    samples[i] = Math.round(clamped * 32767);
  }
  const wav = encodeWavPcm16(samples, sampleRate);
  return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
}

/**
 * Synthesize `text` in-process. Refuses (cleanly) when not provisioned — the caller
 * (tts-synth.ts) treats that as "no local kokoro", exactly like an unreachable HTTP kokoro.
 */
export async function kokoroLocalSynthWav(
  text: string,
  voiceId: string | undefined,
  deps: KokoroLocalDeps = {},
): Promise<KokoroSynth> {
  if (!(await isKokoroLocalProvisioned(deps.home))) {
    return { ok: false, error: 'kokoro local model not provisioned' };
  }
  try {
    const engine = await getEngine(deps);
    const audio = await engine.generate(text, { voice: voiceId ?? KOKORO_LOCAL_DEFAULT_VOICE });
    return { ok: true, audio: float32ToWav(audio.audio, audio.sampling_rate), contentType: 'audio/wav' };
  } catch (e) {
    return { ok: false, error: `kokoro local synth failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
