/**
 * Render the configured wake-word as a short, TTS-friendly phrase.
 *
 * Used by the silence-nudge fallbackText so the announcer reads
 * "When you're ready, click Ready or say <wake-word>." The phrase
 * needs to sound natural through TTS — Porcupine keywords are
 * already title-case English (lowercase for TTS); openWakeWord
 * keywords are snake_case identifiers (spaces + lowercase).
 *
 * Returns null when no wake-word engine is configured, so callers
 * can branch fallbackText shape accordingly.
 *
 * Plan: apps/operator/docs/plans/silence-nudge-reliability-2026-05-14.md §C.3
 */

import type { VoicePrefs } from '../voice-prefs';

export function getConfiguredWakeWordForDisplay(prefs: VoicePrefs): string | null {
  if (prefs.wakeWordEngine === 'porcupine') {
    return prefs.porcupineKeyword.toLowerCase();
  }
  if (prefs.wakeWordEngine === 'openwakeword') {
    return prefs.openwakewordKeyword.replace(/_/g, ' ').toLowerCase();
  }
  // wakeWordEngine === 'off' — no engine configured.
  return null;
}
