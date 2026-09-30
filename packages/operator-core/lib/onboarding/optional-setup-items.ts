/**
 * Canonical Phase-A optional-setup items for onboarding
 * (deterministic-onboarding-tutorial-2026-07-04 P-002).
 *
 * ONE list, consumed by BOTH onboarding paths:
 *  - the deterministic tutorial runner (offers each item, collects a value, applies it);
 *  - the fallback agent tutor (renders these into its Phase-A prompt via a token).
 *
 * `preview: true` items have a backing feature that is NOT ready yet — telemetry
 * consent, mobile pairing, the auto-update channel (owner-directed 2026-07-04). They are
 * gated behind FLAGS.ONBOARDING_PREVIEW_FEATURES (default OFF): a fresh install never
 * sees them; a tester flips the flag ON to exercise the not-yet-shipped surfaces. As each
 * backing feature ships, drop that item's `preview` tag (and eventually retire the flag).
 *
 * `input` tells the deterministic runner HOW to collect the value:
 *  - 'confirm'  → a yes/no
 *  - 'text'     → a free-text value (may be masked for secrets)
 *  - 'terminal' → spawn an interactive terminal command (its spec comes from
 *                 /api/desktop/setup-pty-commands, e.g. `gh auth login`)
 *  - 'preview'  → not-ready: informational only, no write wired yet
 */
export type OptionalSetupInput = 'confirm' | 'text' | 'terminal' | 'preview';

export interface OptionalSetupItem {
  /** Stable id (used by the runner + progress). */
  key: string;
  /** Short display name. */
  label: string;
  /** One-line "why" the runner/tutor shows. */
  why: string;
  /** How the runner collects the value. */
  input: OptionalSetupInput;
  /**
   * true ⇒ the backing feature is NOT ready; shown only when
   * FLAGS.ONBOARDING_PREVIEW_FEATURES is ON. Default installs never see these.
   */
  preview: boolean;
  /**
   * true ⇒ the user MUST make a decision on this item before onboarding can
   * graduate (setup:complete). For a 'confirm' item, "no" is a valid answer
   * that satisfies the requirement — required means "must be answered", not
   * "must be yes". Default (undefined) = optional/skippable.
   * (Owner-directed 2026-07-10: telemetry consent is required-but-answerable-no.)
   */
  required?: boolean;
}

export const OPTIONAL_SETUP_ITEMS: readonly OptionalSetupItem[] = [
  {
    key: 'git-identity',
    label: 'Git identity',
    why: 'the name/email stamped on every commit agents make for you',
    input: 'text',
    preview: false,
  },
  {
    key: 'github',
    label: 'GitHub sign-in',
    why: 'lets agents clone and push your private repos',
    input: 'terminal',
    preview: false,
  },
  {
    key: 'backups',
    label: 'Backups',
    why: 'local snapshots that protect against agent mistakes',
    input: 'confirm',
    preview: false,
  },
  {
    key: 'api-keys',
    label: 'More API keys',
    why: 'optional pay-per-use model providers',
    input: 'text',
    preview: false,
  },
  {
    // Backing feature shipped (setup:set_telemetry + the flush pipeline), so this
    // is no longer a preview stub. REQUIRED: onboarding must collect an explicit
    // yes/no before graduating; "no" is a valid, satisfying answer.
    key: 'telemetry',
    label: 'Telemetry consent',
    why: 'an explicit yes/no on anonymized diagnostics + crash reports',
    input: 'confirm',
    preview: false,
    required: true,
  },
  // ── Preview items — backing feature NOT ready; gated behind ONBOARDING_PREVIEW_FEATURES ──
  {
    key: 'mobile-pairing',
    label: 'Mobile pairing',
    why: 'pair your phone to get notifications / remote control',
    input: 'preview',
    preview: true,
  },
  {
    key: 'update-channel',
    label: 'Auto-update channel',
    why: 'alpha = freshest, stable = calmest',
    input: 'preview',
    preview: true,
  },
];

/** The keys of every item whose backing feature is not ready (gated by the preview flag). */
export const PREVIEW_ITEM_KEYS: readonly string[] = OPTIONAL_SETUP_ITEMS.filter(
  (i) => i.preview,
).map((i) => i.key);

/**
 * The optional-setup items the user MUST decide before onboarding can graduate
 * (`setup:complete`). "No" is a valid, satisfying answer — required means "must be
 * answered". Today this is just telemetry consent (owner-directed 2026-07-10).
 * The graduation gate (setup:complete) and the deterministic runner both derive
 * their required-set from THIS one list so the two surfaces can't drift.
 */
export function requiredOptionalSetupItems(): OptionalSetupItem[] {
  return OPTIONAL_SETUP_ITEMS.filter((i) => i.required === true);
}

/**
 * Map an optional-setup item key → the `collectSetupStatus` StepId that proves it
 * decided (so the graduation gate can read a single, shared status probe instead of
 * re-deriving "decided?" per item). Most required items map straight to a step of the
 * same name (telemetry → 'telemetry'); the fallback returns the key itself, and the
 * gate only blocks on keys that actually exist in the status map.
 */
export function statusStepForItemKey(key: string): string {
  const MAP: Record<string, string> = {
    telemetry: 'telemetry',
    'mobile-pairing': 'mobile-pairing',
    'update-channel': 'auto-update',
    'git-identity': 'git',
  };
  return MAP[key] ?? key;
}

/**
 * The items to actually offer, given whether preview features are enabled.
 * previewEnabled=false (the default a fresh install sees) drops every `preview` item.
 */
export function visibleOptionalSetupItems(previewEnabled: boolean): OptionalSetupItem[] {
  return OPTIONAL_SETUP_ITEMS.filter((i) => previewEnabled || !i.preview);
}

/** Render the flag-filtered items as a markdown table row set for the fallback tutor prompt. */
export function optionalSetupItemsMarkdown(previewEnabled: boolean): string {
  const rows = visibleOptionalSetupItems(previewEnabled)
    .map((i) => `| ${i.label} | ${i.why} |`)
    .join('\n');
  return `| Step | The one-line why |\n|---|---|\n${rows}`;
}
