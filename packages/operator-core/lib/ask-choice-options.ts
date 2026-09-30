/**
 * chat:ask_choice option coercion — the ONE place that knows a model may hand
 * us `options` as a JSON STRING instead of an array.
 *
 * Why this exists (WI-5175, owner repro 2026-07-17):
 * `operator_turns.tools` persists the model's RAW input, and models sometimes
 * emit `options: "[{…}]"` (stringified) rather than `options: [{…}]`. Every
 * reader of that payload must therefore coerce before touching it as an array.
 *
 * Two readers exist, and they disagreed — which is exactly the bug:
 *   - apps/operator/lib/chat-cards/AskChoiceCardEntry.tsx (render) parsed the
 *     string, so the card rendered fine.
 *   - packages/operator-core/lib/endpoint-route/routes/operator/turn-answer.ts
 *     (answer) did `(args?.options ?? []).map(...)`. `??` only catches
 *     null/undefined, so a STRING sails straight through and `.map` throws —
 *     surfacing to the owner as
 *     `turn-answer failed: ((intermediate value) ?? []).map is not a function`.
 * Net effect: the card rendered and then 500'd on click. Fixing only the
 * server would leave the next reader to re-discover this, so the knowledge
 * lives here once and both sides import it.
 *
 * Returns a real array, or null when the payload is unusable. Never throws:
 * callers are on a render path and a user-click path, and neither should
 * explode on a malformed model payload.
 */

/** A single ask_choice option as the model may supply it (id/label are best-effort). */
export type AskChoiceOptionLike = Record<string, unknown>;

/**
 * Coerce a raw `options` payload into an array.
 *
 * Accepts an array (returned as-is) or a JSON string encoding an array
 * (parsed). Anything else — an object, a non-JSON string, a number, a string
 * encoding a non-array — yields null.
 */
export function coerceAskChoiceOptions(raw: unknown): AskChoiceOptionLike[] | null {
  if (Array.isArray(raw)) return raw as AskChoiceOptionLike[];
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as AskChoiceOptionLike[];
    } catch {
      /* not JSON — fall through to null */
    }
  }
  return null;
}

/**
 * The option ids present in a raw `options` payload.
 *
 * Used by the answer path to validate a pick against the offered set. An
 * uncoercible payload yields an EMPTY set, which callers treat as "cannot
 * validate" (skip validation) rather than "no options are valid" — rejecting a
 * legitimate pick because the model stringified its own payload would be the
 * same defect wearing a different hat.
 */
export function askChoiceOptionIds(raw: unknown): Set<string> {
  const options = coerceAskChoiceOptions(raw);
  if (!options) return new Set<string>();
  return new Set(
    options
      .map((o) => (o && typeof o === 'object' ? (o as { id?: unknown }).id : undefined))
      .filter((s): s is string => typeof s === 'string' && s.length > 0),
  );
}
