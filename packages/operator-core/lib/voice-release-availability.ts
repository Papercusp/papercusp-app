/**
 * Voice engines NOT available in the current public voice release.
 *
 * Source of truth for the release scope ruled in
 * voice-final-public-release-2026-10-01#D-005 (Avi, 2026-10-06): an engine
 * we cannot accept with a working provider key in our own environment is
 * not offered as supported. Measured when the ruling formed: the stored
 * ElevenLabs key is rejected by the provider (TTS preview and ConvAI agent
 * fetch both return 401); no OpenAI, Cartesia or Picovoice key is set.
 * Gemini Live has no dispatch path at all (WI-10004792).
 *
 * Contract every consumer follows (one list, three seams):
 *   - settings picker: the option stays visible but disabled, labelled with
 *     RELEASE_UNAVAILABLE_LABEL, and a saved value shows a scoped alert;
 *   - client activation (voice-mode.ts): a saved unavailable engine is
 *     refused with a visible toast BEFORE any provider call or microphone
 *     capture — never silently substituted with another engine;
 *   - server synthesis (resolveTtsEngine): an unavailable TTS engine is a
 *     clean 4xx, which covers desktop synth, the TUI's operator-tts call
 *     and hosted lesson speech.
 * A saved preference naming one of these engines is PRESERVED, never
 * rewritten, so restoring an engine later needs no data migration.
 *
 * Re-adding an engine = remove it here AND give it its own release
 * acceptance with a working key (the plan's R-2/R-3 bars).
 *
 * Deliberately import-free (types only) so the client bundle can use it.
 */

import type { FullAgentEngineKind, TtsEngineKind, VoicePrefs } from './voice-prefs';

export type WakeWordEngineKind = VoicePrefs['wakeWordEngine'];

/** Suffix shown on a disabled picker option. */
export const RELEASE_UNAVAILABLE_LABEL = 'not available in this release';

export const RELEASE_UNAVAILABLE_FULL_AGENT_ENGINES: ReadonlySet<FullAgentEngineKind> = new Set<FullAgentEngineKind>([
  'gemini-live',
  'openai-realtime',
  'elevenlabs-conv',
  'elevenlabs-conversational',
]);

export const RELEASE_UNAVAILABLE_TTS_ENGINES: ReadonlySet<TtsEngineKind> = new Set<TtsEngineKind>([
  'elevenlabs',
  'openai',
  'cartesia',
]);

export const RELEASE_UNAVAILABLE_WAKE_ENGINES: ReadonlySet<WakeWordEngineKind> = new Set<WakeWordEngineKind>([
  'porcupine',
]);

export function isFullAgentEngineUnavailable(engine: unknown): boolean {
  return typeof engine === 'string' && RELEASE_UNAVAILABLE_FULL_AGENT_ENGINES.has(engine as FullAgentEngineKind);
}

export function isTtsEngineUnavailable(engine: unknown): boolean {
  return typeof engine === 'string' && RELEASE_UNAVAILABLE_TTS_ENGINES.has(engine as TtsEngineKind);
}

export function isWakeEngineUnavailable(engine: unknown): boolean {
  return typeof engine === 'string' && RELEASE_UNAVAILABLE_WAKE_ENGINES.has(engine as WakeWordEngineKind);
}

const ENGINE_NAMES: Record<string, string> = {
  'gemini-live': 'Gemini Live',
  'openai-realtime': 'OpenAI Realtime',
  'elevenlabs-conv': 'ElevenLabs Conversational AI',
  'elevenlabs-conversational': 'ElevenLabs Conversational AI',
  elevenlabs: 'ElevenLabs TTS',
  openai: 'OpenAI TTS',
  cartesia: 'Cartesia TTS',
  porcupine: 'Porcupine wake word',
};

/** Human message for a refused engine — identical across picker alert, toast and server error. */
export function releaseUnavailableMessage(engine: string): string {
  const name = ENGINE_NAMES[engine] ?? engine;
  return `${name} is ${RELEASE_UNAVAILABLE_LABEL}. Choose another engine in /settings/voice.`;
}
