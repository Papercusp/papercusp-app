'use client';

/**
 * Client-side voice-prefs cache.
 *
 * The server-side `voice-prefs.ts` reads the filesystem directly and
 * can't run in the browser. Client surfaces (toasts, panel commands)
 * use this cache, fed by VoicePrefsSyncBridge from the root sync query.
 *
 * Writes still update it optimistically through setVoicePrefsClient; the
 * named-query invalidation then reconciles it with server truth.
 */

import type { VoicePrefs } from '@papercusp/operator-core/lib/voice-prefs';

const DEFAULT_CLIENT_PREFS: VoicePrefs = {
  speakSuggestions: true,
  speakBackgroundToasts: true,
  speakModeFlips: false,
  speakCadenceStatus: false,
  speakNudges: true,
  wakeWordIntents: true,
  speakOpenCards: true,
  cardAnsweringEnabled: true,
  silenceNudgeGraceSecs: 30,
  speakSessionHandoff: true,
  proactiveTicksEnabled: true,
  maxConsecutiveContinues: 5,
  maxContinueChainSecs: 300,
  sttEngine: 'voicemode',
  ttsEngine: 'kokoro',
  elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
  audienceMode: 'engineer' as const,
  webSpeechLeakAcked: false,
  kokoroSlowSuggestionDismissed: false,
  nudgeDedup: {
    budget:  { lastSpokenAt: null },
    breaker: { lastSpokenAt: null },
    pause:   { lastSpokenAt: null },
  },
};

let cache: VoicePrefs = { ...DEFAULT_CLIENT_PREFS };

type Listener = (prefs: VoicePrefs) => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) {
    try { l(cache); } catch { /* ignore */ }
  }
}

export function loadVoicePrefsClient(): VoicePrefs {
  return cache;
}

export function setVoicePrefsClient(next: VoicePrefs): void {
  cache = next;
  notify();
}

export async function refreshVoicePrefsClient(): Promise<VoicePrefs> {
  return cache;
}

/**
 * Subscribe to prefs changes. Fires on hydrate, on setVoicePrefsClient,
 * and on refreshVoicePrefsClient. Returns an unsubscribe.
 *
 * Consumers that need live updates (e.g. the voice-card router's
 * cardAnsweringEnabled gate) should subscribe; passive readers can
 * stay on the synchronous loadVoicePrefsClient() snapshot.
 */
export function subscribeVoicePrefsClient(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
