/**
 * Pure helper for the wake-word → intent re-prefix logic used by the
 * Web Speech wake-word listener.
 *
 * Wake word ≠ intent prefix. The user typically says "hey operator" as
 * the wake word, but `parseOperatorIntent` matches utterances starting
 * with "operator ". This helper strips the wake word and re-prefixes
 * "operator " so the intent parser sees a parseable string.
 */

export interface WakeStripResult {
  /** True when the transcript contained the wake word. */
  matched: boolean;
  /** Text to pass to onUtteranceFinal (already prefixed for parseOperatorIntent). */
  dispatchText: string;
  /** Trailing text after the wake word (no prefix added). */
  trailing: string;
}

export function stripWakeWordAndPrefix(
  transcript: string,
  wakeWord: string,
): WakeStripResult {
  const lower = transcript.toLowerCase();
  const wake = wakeWord.toLowerCase();
  const idx = lower.lastIndexOf(wake);
  if (idx < 0) return { matched: false, dispatchText: '', trailing: '' };
  const trailing = transcript.slice(idx + wake.length).trim();
  if (!trailing) return { matched: true, dispatchText: '', trailing: '' };
  // If the trailing text already starts with "operator ", don't double-prefix
  // (case where the wakeWord doesn't include "operator").
  const dispatchText = /^operator\s+/i.test(trailing) ? trailing : `operator ${trailing}`;
  return { matched: true, dispatchText, trailing };
}

// ─── Fuzzy wake-PHRASE matching (voice-public-release-readiness P-004) ──────
//
// The always-on local path (energy-VAD / Silero → whisper) transcribes EVERY
// utterance; the wake gate forwards only wake-phrase-prefixed ones to the
// brain. Whisper renders the phrase with unpredictable punctuation/spacing —
// "Hey, Papercup.", "hey paper cup", "Hey PaperCusp!" — so an exact substring
// match (stripWakeWordAndPrefix above) misses real wakes. This matcher is
// deliberately tolerant: separator-insensitive, punctuation-insensitive, and
// accepts the hey/ok/okay lead-ins plus both brand spellings (papercup /
// papercusp — the physical rename is mid-flight).

export interface WakePhraseMatch {
  /** True when the transcript starts with a recognized wake phrase. */
  matched: boolean;
  /** Text after the wake phrase, trimmed. Empty = a bare wake ("hey papercup"). */
  trailing: string;
}

const WAKE_PHRASE_RE =
  /^[\s"'`([{-]*(?:hey|ok|okay)[\s,.!?;:-]*paper[\s.-]*(?:cusp|cup)[\s,.!?;:-]*/i;

/**
 * Match a spoken wake phrase ("hey papercup" and tolerant variants) at the
 * START of a transcript. Pure + deterministic (unit-tested); UI and capture
 * layers share it so the gate and the copy can never disagree.
 */
export function matchWakePhrase(transcript: string): WakePhraseMatch {
  const m = WAKE_PHRASE_RE.exec(transcript);
  if (!m) return { matched: false, trailing: '' };
  return { matched: true, trailing: transcript.slice(m[0].length).trim() };
}
