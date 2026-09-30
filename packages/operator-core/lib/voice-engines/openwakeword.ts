/**
 * openWakeWord wake-word detection (Apache 2.0 alternative to Picovoice Porcupine).
 *
 * Same `startWakeWordDetection({onWake, ...})` shape as `porcupine.ts` so
 * voice-mode.ts dispatches identically. Differences:
 *   - No access key required (Picovoice's commercial gate is gone)
 *   - Custom keywords are free — train a `.onnx` classifier via the
 *     openWakeWord Colab/Kaggle tutorial and ship it
 *   - We open getUserMedia + AudioContext ourselves (Picovoice has its
 *     own WebVoiceProcessor that handles this for us)
 *
 * Pre-trained models for built-in keywords are fetched from the upstream
 * GitHub release so the user doesn't need to bundle them. ONNX models
 * are cached by the browser after first load.
 */

// Note: `openwakeword-js` is dynamically imported below. Importing it at
// the top of the module makes Turbopack try to resolve onnxruntime-web's
// WASM binaries at compile time, which fails because they're loaded via
// `new URL(...)` patterns. Deferring keeps the page from breaking just
// because a user *might* later flip the engine to openwakeword.

export type OpenWakeWordKeyword =
  | 'alexa'
  | 'hey_jarvis'
  | 'hey_mycroft'
  | 'hey_rhasspy'
  | 'ok_nabu'
  | 'weather'
  | 'timer';

const RELEASE_BASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1';
const MEL_URL = `${RELEASE_BASE}/melspectrogram.onnx`;
const EMBED_URL = `${RELEASE_BASE}/embedding_model.onnx`;
const VAD_URL = `${RELEASE_BASE}/silero_vad.onnx`;

const KEYWORD_URLS: Record<OpenWakeWordKeyword, string> = {
  alexa: `${RELEASE_BASE}/alexa_v0.1.onnx`,
  hey_jarvis: `${RELEASE_BASE}/hey_jarvis_v0.1.onnx`,
  hey_mycroft: `${RELEASE_BASE}/hey_mycroft_v0.1.onnx`,
  hey_rhasspy: `${RELEASE_BASE}/hey_rhasspy_v0.1.onnx`,
  ok_nabu: `${RELEASE_BASE}/ok_nabu_v0.1.onnx`,
  weather: `${RELEASE_BASE}/weather_v0.1.onnx`,
  timer: `${RELEASE_BASE}/timer_v0.1.onnx`,
};

const KEYWORD_MODEL_NAMES: Record<OpenWakeWordKeyword, string> = {
  alexa: 'alexa_v0.1',
  hey_jarvis: 'hey_jarvis_v0.1',
  hey_mycroft: 'hey_mycroft_v0.1',
  hey_rhasspy: 'hey_rhasspy_v0.1',
  ok_nabu: 'ok_nabu_v0.1',
  weather: 'weather_v0.1',
  timer: 'timer_v0.1',
};

export interface OpenWakeWordOptions {
  keyword: OpenWakeWordKeyword;
  /** Detection threshold (0..1). Higher = fewer false positives, more misses. Default 0.5. */
  threshold?: number;
  onWake: () => void;
  onError?: (err: Error) => void;
}

export interface OpenWakeWordHandle {
  stop(): Promise<void>;
}

export async function startOpenWakeWordDetection(
  opts: OpenWakeWordOptions,
): Promise<OpenWakeWordHandle> {
  if (typeof window === 'undefined') throw new Error('not in browser');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');

  const threshold = opts.threshold ?? 0.5;
  const modelName = KEYWORD_MODEL_NAMES[opts.keyword];

  // Use a Function-constructor'd import so neither Turbopack nor webpack
  // tries to resolve openwakeword-js's WASM/ONNX runtime paths at compile
  // time (those use `new URL(..., import.meta.url)` patterns the bundler
  // can't follow). The package is loaded straight from node_modules at
  // runtime via the user's own bundler/dev server.
  const dyn = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
  const { Model } = await dyn('openwakeword-js');
  const model = new Model({
    wakewordModels: [KEYWORD_URLS[opts.keyword]],
    melspectrogramModelPath: MEL_URL,
    embeddingModelPath: EMBED_URL,
    vadModelPath: VAD_URL,
    vadThreshold: 0.5,
    inferenceFramework: 'onnx',
    debounceTime: 1.0,
    // Required for the browser context: tell onnxruntime-web where to
    // find its WASM blobs. We mirror them into /public/wake-runtime/ at
    // install time (see apps/operator/scripts/setup-wake-runtime.sh).
    wasmPaths: '/wake-runtime/',
  });
  await model.init();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
  });

  const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);

  // openWakeWord expects 1280-sample chunks (80ms @ 16kHz). Use a
  // ScriptProcessor for max compat — AudioWorklet would be cleaner but
  // requires a separate worklet module file.
  const CHUNK = 1280;
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  let pending = new Float32Array(0);
  let stopped = false;

  processor.onaudioprocess = async (e) => {
    if (stopped) return;
    const input = e.inputBuffer.getChannelData(0);
    // Append to pending buffer
    const merged = new Float32Array(pending.length + input.length);
    merged.set(pending, 0);
    merged.set(input, pending.length);
    pending = merged;
    // Process complete 1280-sample chunks
    while (pending.length >= CHUNK) {
      const chunk = pending.slice(0, CHUNK);
      pending = pending.slice(CHUNK);
      try {
        const scores = await model.predict(chunk);
        const score = scores[modelName] ?? 0;
        if (score >= threshold) {
          opts.onWake();
        }
      } catch (err) {
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  src.connect(processor);
  processor.connect(ctx.destination);

  return {
    async stop(): Promise<void> {
      stopped = true;
      try { processor.disconnect(); } catch { /* ignore */ }
      try { src.disconnect(); } catch { /* ignore */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { await ctx.close(); } catch { /* ignore */ }
    },
  };
}

export const OPENWAKEWORD_KEYWORDS: OpenWakeWordKeyword[] = [
  'alexa', 'hey_jarvis', 'hey_mycroft', 'hey_rhasspy', 'ok_nabu', 'weather', 'timer',
];
