/**
 * kokoro-tts — vendored, trimmed port of kokoro-js@1.2.1
 * (https://github.com/hexgrad/kokoro · Apache-2.0; upstream author: Xenova/hexgrad).
 * Extracted from papercusp's operator-core into this generic package (WI-4470);
 * originally landed at packages/operator-core/lib/voice-node/kokoro/kokoro-tts.ts
 * (P-009, plan D-009, WI-4449).
 *
 * WHY VENDORED: kokoro-js pins @huggingface/transformers@^3.5.1 while consuming
 * repos may ship a newer major — and npm's `overrides` do NOT apply to
 * workspace-package transitive deps (verified live 2026-07-12 in papercusp:
 * global, nested, and $-reference override forms all left a nested 3.8.1 copy —
 * a 706MB duplicate onnxruntime+transformers stack). The engine itself runs
 * verified on transformers 4.2.0 (spike 2026-07-12: identical output quality),
 * so this port simply binds the SAME ~200 lines of glue to whatever transformers
 * primitives the host injects (see ./config.ts) + the tiny `phonemizer` package.
 * Behavioral parity is with kokoro-js's dist/kokoro.js, ported statement-for-
 * statement; upstream fixes should be diffed against that file.
 *
 * WHY A HOST SEAM (not a direct `@huggingface/transformers` import, WI-4470):
 * this package is meant to be domain-free (libs/generic), and importing
 * transformers directly here would reintroduce the exact version-pinning
 * risk that caused the original vendoring — any consumer that resolves a
 * different transformers major would get the same duplicate-install problem
 * one level up. Injection via configureKokoroTts() keeps this package at
 * zero transformers coupling; the host (operator-core) already owns that
 * dependency and supplies the three primitives this file actually calls.
 *
 * Deliberate trims vs upstream:
 *   - No TextSplitterStream / stream() (papercusp synthesizes whole replies;
 *     sentence streaming is a later latency optimization).
 *   - Voice style bins are NOT bundled (upstream ships all 27 ≈ 27MB in-package):
 *     they are fetched from the canonical HF repo on first use and cached on
 *     disk next to the model (`<cacheDir>/voices/<voice>.bin`) — the host's
 *     provision step pre-fetches the default voice.
 *   - The upstream `env` re-export was dropped: nothing in papercusp consumed
 *     it (the original file's own comment flagged it "unused in papercusp
 *     today"), and it doesn't fit a version-free host seam. A consumer that
 *     needs to tune the ONNX backend env should do so via its own
 *     `@huggingface/transformers` import — this package doesn't hold one.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { phonemize } from './phonemize';
import { KOKORO_HF_REPO, KOKORO_SAMPLE_RATE, KOKORO_VOICES, kokoroVoiceUrl, type KokoroVoiceInfo } from './voices';
import { kokoroTransformersHost } from './config';

export { KOKORO_HF_REPO, KOKORO_SAMPLE_RATE, KOKORO_VOICES, kokoroVoiceUrl, type KokoroVoiceInfo };
export { phonemize, normalizeText } from './phonemize';

export interface KokoroTtsOptions {
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
  device?: 'cpu' | null;
  /** transformers.js model cache dir (papercusp: ~/.papercusp/models/kokoro). */
  cacheDir?: string;
  /** Voice style bins cache dir (papercusp: `<cacheDir>/voices`). */
  voicesDir?: string;
  progress_callback?: (p: unknown) => void;
}

export interface KokoroRawAudio {
  audio: Float32Array;
  sampling_rate: number;
}

export class KokoroTts {
  private readonly voiceCache = new Map<string, Float32Array>();

  private constructor(
    private readonly model: import('./config').KokoroModelHandle,
    private readonly tokenizer: import('./config').KokoroTokenizerHandle,
    private readonly voicesDir: string | undefined,
  ) {}

  static async from_pretrained(modelId: string = KOKORO_HF_REPO, opts: KokoroTtsOptions = {}): Promise<KokoroTts> {
    const host = kokoroTransformersHost();
    const loadOpts = {
      dtype: opts.dtype ?? 'q8',
      device: opts.device ?? undefined,
      cache_dir: opts.cacheDir,
      progress_callback: opts.progress_callback,
    } as Record<string, unknown>;
    const [model, tokenizer] = await Promise.all([
      host.StyleTextToSpeech2Model.from_pretrained(modelId, loadOpts),
      host.AutoTokenizer.from_pretrained(modelId, { cache_dir: opts.cacheDir, progress_callback: opts.progress_callback }),
    ]);
    return new KokoroTts(model, tokenizer, opts.voicesDir);
  }

  get voices(): Readonly<Record<string, KokoroVoiceInfo>> {
    return KOKORO_VOICES;
  }

  private validateVoice(voice: string): 'a' | 'b' {
    if (!Object.hasOwn(KOKORO_VOICES, voice)) {
      throw new Error(`Voice "${voice}" not found. Should be one of: ${Object.keys(KOKORO_VOICES).join(', ')}.`);
    }
    return voice[0] as 'a' | 'b';
  }

  /** Fetch-or-read the 510×256 f32 style table for `voice` (disk-cached under voicesDir). */
  async loadVoiceStyle(voice: string): Promise<Float32Array> {
    const cached = this.voiceCache.get(voice);
    if (cached) return cached;
    let buffer: ArrayBufferLike | null = null;
    const diskPath = this.voicesDir ? `${this.voicesDir}/${voice}.bin` : null;
    if (diskPath && existsSync(diskPath)) {
      buffer = (await readFile(diskPath)).buffer;
    } else {
      const r = await fetch(kokoroVoiceUrl(voice));
      if (!r.ok) throw new Error(`kokoro voice fetch failed HTTP ${r.status} for ${voice}`);
      buffer = await r.arrayBuffer();
      if (diskPath) {
        await mkdir(dirname(diskPath), { recursive: true });
        await writeFile(diskPath, Buffer.from(buffer));
      }
    }
    const data = new Float32Array(buffer);
    this.voiceCache.set(voice, data);
    return data;
  }

  /** Upstream generate(): phonemize → tokenize → style row by token count → model. */
  async generate(text: string, { voice = 'af_heart', speed = 1 }: { voice?: string; speed?: number } = {}): Promise<KokoroRawAudio> {
    const host = kokoroTransformersHost();
    const language = this.validateVoice(voice);
    const phonemes = await phonemize(text, language);
    const { input_ids } = this.tokenizer(phonemes, { truncation: true });
    // Style row selection, verbatim from upstream: offset = 256 * min(max(tokens-2, 0), 509).
    const numTokens = Math.min(Math.max((input_ids.dims.at(-1) as number) - 2, 0), 509);
    const styleTable = await this.loadVoiceStyle(voice);
    const styleRow = styleTable.slice(numTokens * 256, numTokens * 256 + 256);
    const inputs = {
      input_ids,
      style: new host.Tensor('float32', styleRow, [1, 256]),
      speed: new host.Tensor('float32', [speed], [1]),
    };
    const { waveform } = await this.model(inputs);
    return { audio: waveform.data, sampling_rate: KOKORO_SAMPLE_RATE };
  }
}
