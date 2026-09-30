/**
 * What the "Jev decisions" settings card shows, derived from the
 * GET /api/user/jev-settings envelope (plan jev-decision-model-integration-2026-09-29,
 * P-013 / D-008). Pure, so the wording rules are testable without a DOM.
 *
 * The rule that matters: what the card calls "in use" comes from the server's
 * `effective` mode, never from the stored choice. A stored Log only / On with no
 * key saved is `effective: 'off'` — the current system runs and Jev gets zero
 * calls — and the card must say so rather than echo the choice back.
 */

/** Mirrors `JevMode` in packages/operator-core/lib/memory/jev-settings.ts (the UI never imports operator-core). */
export type JevMode = 'off' | 'shadow' | 'on';

/** The GET/POST /api/user/jev-settings body. The raw key never leaves the server. */
export interface JevSettingsEnvelopeView {
  mode: JevMode;
  keyPresent: boolean;
  maskedKey: string | null;
  effective: JevMode;
  model: string;
}

export const JEV_MODE_OPTIONS: ReadonlyArray<{ value: JevMode; label: string }> = [
  { value: 'off', label: 'Off (use the current system)' },
  { value: 'shadow', label: 'Log only (ask Jev, keep the current result)' },
  { value: 'on', label: "On (use Jev's decision)" },
];

const MODE_NAME: Record<JevMode, string> = { off: 'Off', shadow: 'Log only', on: 'On' };

export function jevModeName(mode: JevMode): string {
  return MODE_NAME[mode];
}

/** The server's minimum (JEV_API_KEY_MIN_LENGTH). The server stays authoritative; this only avoids a pointless round trip. */
export const JEV_KEY_MIN_LENGTH = 8;

/** A client-side hint for the key field, or null when the draft is worth sending. */
export function jevKeyDraftProblem(draft: string): string | null {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return 'Paste your Jev API key first.';
  if (trimmed.length < JEV_KEY_MIN_LENGTH) return `The key is too short (at least ${JEV_KEY_MIN_LENGTH} characters).`;
  if (/\s/.test(trimmed)) return 'The key must not contain spaces or line breaks.';
  return null;
}

/** Said whenever the card is shown, whatever the mode: this is the egress the owner consented to (D-008). */
export const JEV_EGRESS_NOTICE =
  'Log only and On send the current turn and the candidate memory text to TypeSafe (api.typesafe.ai) on each memory lookup. Off sends nothing.';

export interface JevView {
  /** The stored choice, for the mode select. */
  choice: JevMode;
  /** What actually runs right now, from `effective`. */
  inUse: string;
  /** Set when the stored choice is not what runs (a mode is chosen but no key is saved). */
  missingKeyWarning: string | null;
  /** "Saved: ab12…cd34" or "No key saved". */
  keyLine: string;
}

export function jevView(env: JevSettingsEnvelopeView): JevView {
  const inUse =
    env.effective === 'on'
      ? `Jev's decision (${env.model}). The current system is used whenever Jev can't answer.`
      : env.effective === 'shadow'
        ? `The current system. Jev (${env.model}) is asked alongside it and its answers are only logged.`
        : 'The current system. Jev makes no calls.';

  const missingKeyWarning =
    env.mode !== 'off' && env.effective === 'off'
      ? `Jev is set to ${jevModeName(env.mode)}, but no key is saved, so the current system is in use and no calls are made. Save a key to start.`
      : null;

  const keyLine = env.keyPresent ? `Saved: ${env.maskedKey ?? 'a key is stored'}` : 'No key saved';

  return { choice: env.mode, inUse, missingKeyWarning, keyLine };
}
