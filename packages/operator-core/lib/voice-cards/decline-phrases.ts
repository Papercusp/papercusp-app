/**
 * Voice-card decline phrases.
 *
 * Plan: apps/operator/docs/plans/voice-aware-cards-2026-05-14.md §C.2
 *
 * Phrases the user might say to decline a card by voice. The list is
 * intentionally small and exact-match-only (after normalize) — fuzzy
 * matching is the job of the parser's substring step, not this list.
 *
 * Precedence note: decline phrases lose to exact option-label matches,
 * so a card with an option literally labelled "Skip this step" will
 * submit-on-"skip", not decline. See match-voice-answer.ts §precedence.
 */

const DECLINE_PHRASES: ReadonlySet<string> = new Set([
  'skip',
  'cancel',
  'never mind',
  'nevermind',
  'not now',
  'forget it',
  'no thanks',
  'no thank you',
  'pass',
  'dismiss',
]);

/** Test whether a *normalized* string (see normalize()) is a decline phrase. */
export function isDeclinePhrase(normalized: string): boolean {
  return DECLINE_PHRASES.has(normalized);
}

/** Normalize for comparison: lowercase, strip punctuation, collapse whitespace. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function listDeclinePhrases(): readonly string[] {
  return Array.from(DECLINE_PHRASES);
}
