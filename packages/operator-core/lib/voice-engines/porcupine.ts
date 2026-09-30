/**
 * Picovoice Porcupine wake-word detection.
 *
 * Replaces "transcribe everything via Whisper, then string-match wake
 * word" with "ONNX-detect wake word, only spin up STT after match."
 * Big idle-CPU win when always-on mode is on but the user isn't talking.
 *
 * Usage:
 *   const stop = await startWakeWordDetection({
 *     accessKey,
 *     keyword: 'Computer',     // built-in Porcupine keyword
 *     onWake: () => { … },     // fires when wake word is heard
 *   });
 *   // later
 *   stop();
 *
 * The free Picovoice access key tier covers personal/dev use.
 */

import { PorcupineWorker, BuiltInKeyword } from '@picovoice/porcupine-web';
import { WebVoiceProcessor } from '@picovoice/web-voice-processor';

/**
 * Where the wake-word model is served from.
 *
 * cdn-egress-fixes-2026-08-02 P-003. This used to be
 * `https://raw.githubusercontent.com/Picovoice/porcupine/master/lib/common/porcupine_params.pv`
 * — a ~961KB runtime fetch from a rate-limited SOURCE host, off a MOVING ref, on
 * a path where a 404 silently disables wake-word. The model is now vendored into
 * the publicDir at setup time by apps/operator/scripts/setup-porcupine-runtime.sh
 * (pinned by commit sha and checksum-verified), so nothing is fetched from the
 * internet at runtime.
 */
export const PORCUPINE_MODEL_PATH = '/porcupine/porcupine_params.pv';

export interface WakeWordOptions {
  accessKey: string;
  /** Built-in Porcupine keyword. For custom keywords, swap to a .ppn URL. */
  keyword: keyof typeof BuiltInKeyword | BuiltInKeyword;
  onWake: () => void;
  onError?: (err: Error) => void;
}

export interface WakeWordHandle {
  /** Stop detection + release the worker. Idempotent. */
  stop(): Promise<void>;
}

export async function startWakeWordDetection(opts: WakeWordOptions): Promise<WakeWordHandle> {
  if (typeof window === 'undefined') throw new Error('not in browser');
  const keyword =
    typeof opts.keyword === 'string' && opts.keyword in BuiltInKeyword
      ? BuiltInKeyword[opts.keyword as keyof typeof BuiltInKeyword]
      : (opts.keyword as BuiltInKeyword);

  const worker = await PorcupineWorker.create(
    opts.accessKey,
    [{ builtin: keyword, sensitivity: 0.6 }],
    () => opts.onWake(),
    {
      publicPath: PORCUPINE_MODEL_PATH,
      forceWrite: true,
    },
  );

  await WebVoiceProcessor.subscribe(worker);

  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try { await WebVoiceProcessor.unsubscribe(worker); } catch { /* ignore */ }
      try { worker.terminate(); } catch { /* ignore */ }
    },
  };
}

export const BUILT_IN_WAKE_WORDS = Object.values(BuiltInKeyword);
