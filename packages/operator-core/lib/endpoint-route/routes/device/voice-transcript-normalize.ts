/**
 * Whisper transcript normalization for the device voice turn.
 *
 * whisper.cpp emits its OWN bracketed / parenthesized annotations for
 * NON-SPEECH audio — `[BLANK_AUDIO]`, `[SILENCE]`, `[ Silence ]`, `(silence)`,
 * `[MUSIC]`, `[NOISE]`, `*background noise*` — and for a long silence it emits
 * several in a row (observed live: `"[BLANK_AUDIO]\n [BLANK_AUDIO]"`). Those
 * strings are TRUTHY, so a plain `if (!transcript)` guard let a silent utterance
 * through and burned a full brain + TTS round-trip on nothing, polluting the
 * shared operator conversation with a `[BLANK_AUDIO]` user turn
 * (mobile-app-release-readiness rubric → voice-input-edge-cases, 2026-07-14).
 *
 * whisper never wraps genuinely dictated speech in brackets/parens/asterisks —
 * those spans are always its own annotations — so stripping them and keeping
 * what remains yields the true spoken transcript (empty ⇒ an empty turn), while
 * a mixed utterance like `"[BLANK_AUDIO] what is the capital of France?"` keeps
 * its real words.
 *
 * Kept as a tiny dependency-free module so it is unit-testable without the SSE /
 * DB / whisper import graph of voice-turn.ts.
 */

/**
 * Strip whisper's non-speech annotations and collapse whitespace, returning the
 * real spoken text (`''` when the turn carried no speech).
 */
export function stripNonSpeechAnnotations(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/\[[^\]]*\]/g, ' ') // [BLANK_AUDIO], [SILENCE], [ Silence ], [MUSIC] …
    .replace(/\([^)]*\)/g, ' ') // (silence), (music), (speaking foreign language) …
    .replace(/\*[^*]*\*/g, ' ') // *background noise*, *sighs* …
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when a whisper transcript carries no actual speech (only silence/ambient markers). */
export function isBlankTranscript(raw: string | null | undefined): boolean {
  return stripNonSpeechAnnotations(raw).length === 0;
}
