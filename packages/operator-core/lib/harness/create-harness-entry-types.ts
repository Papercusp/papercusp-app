/**
 * create-harness-entry-types — discriminated input types for the 4
 * create-harness entries per papercusp-dogfood-v5 §3.
 *
 * Types-only and PURE. No fs, no Octokit, no HTTP.
 *
 * Thirty-second module in the dogfood-arc types-only spine.
 *
 * Per v5 §3 four mutually-exclusive entry points:
 *   Entry 1 — New local directory (non-git): init+scaffold; private default
 *   Entry 2 — GitHub URL (shared-only per D-025): clone+bind; shared-private default
 *   Entry 3 — Existing local repo: scaffold; private default; no GitHub auth
 *   Entry 4 — Harness link: clone+join+bind; inherits state from binding
 *
 * Consumers:
 *   - P-012 picker UI (renders 4 cards, dispatches per kind)
 *   - POST /api/harness/projects route (validates + dispatches backend)
 *   - The 4 backend code paths each consume their own input variant
 *
 * Same pattern as auto-review-decision-types: a discriminated union
 * forces every consumer to `switch` on `kind` exhaustively, so adding
 * a 5th entry (if it ever happens) becomes a typecheck-driven
 * fan-out instead of a hunt-and-replace.
 */

import {
  defaultStateForEntry,
  type HarnessEntryKind,
  type HarnessState,
} from './harness-state-types';

/**
 * The 4 entry kinds per v5 §3. Re-exports `HarnessEntryKind` from
 * harness-state-types so consumers can import the enum AND the
 * input types from one module.
 */
export {
  type HarnessEntryKind,
  defaultStateForEntry,
} from './harness-state-types';

/**
 * Entry 1 input: new local dir (non-git).
 */
export interface Entry1InitInput {
  kind: 'entry_1_init';
  /** Slug for the new harness (kebab-case). */
  slug: string;
  /** Absolute path to the parent directory. */
  parentDir: string;
  /** Name for the new folder under parentDir. */
  folderName: string;
}

/**
 * Entry 2 input: GitHub URL (shared-only per D-025).
 */
export interface Entry2GithubUrlInput {
  kind: 'entry_2_github_url';
  /** HTTPS GitHub URL the user pasted. */
  githubUrl: string;
  /** OAuth token (resolved via gh-token before dispatch). */
  oauthToken: string;
}

/**
 * Entry 3 input: existing local repo. Defaults to private; NO
 * GitHub auth required (entry 3's whole point is "I just want my
 * private harness for code I already have").
 */
export interface Entry3ExistingFolderInput {
  kind: 'entry_3_existing_folder';
  /** Slug for the new harness. */
  slug: string;
  /** Absolute path to the existing folder. */
  path: string;
}

/**
 * Entry 4 input: harness link (papercusp://harness?...). State
 * inherits from the existing binding the link resolves to.
 */
export interface Entry4HarnessLinkInput {
  kind: 'entry_4_harness_link';
  /** The full harness link URL the user pasted. Validated via
   * parseHarnessLink before dispatch. */
  harnessLink: string;
  /** OAuth token from gh-token. */
  oauthToken: string;
  /** Optional slug override (if absent, derived from the link's
   * github_repo segment). */
  slug?: string;
}

/**
 * The full discriminated union. Consumers `switch` on `kind` to
 * dispatch the right backend code path.
 */
export type CreateHarnessEntryInput =
  | Entry1InitInput
  | Entry2GithubUrlInput
  | Entry3ExistingFolderInput
  | Entry4HarnessLinkInput;

// ─── Auth requirement gate ──────────────────────────────────────

/**
 * Per v5 §3: Entries 2 + 4 require GitHub auth. Entries 1 + 3 are
 * local-only and don't.
 */
export function requiresGithubAuthForEntry(kind: HarnessEntryKind): boolean {
  return kind === 'entry_2_github_url' || kind === 'entry_4_harness_link';
}

// ─── Pre-flight validation ──────────────────────────────────────

/**
 * Discriminated validation result for a pre-dispatch input check.
 *
 *   `ok`            — input is well-formed; proceed to dispatch.
 *   `missing_field` — required input field is missing or empty.
 *   `bad_url`       — Entry 2 githubUrl or Entry 4 harnessLink
 *                     doesn't pass shape checks.
 *   `bad_oauth_token` — auth-requiring entry has no oauthToken.
 *   `bad_path`      — Entry 1 parentDir or Entry 3 path is empty.
 */
export type EntryValidationResult =
  | { kind: 'ok' }
  | { kind: 'missing_field'; field: string }
  | { kind: 'bad_url'; url: string }
  | { kind: 'bad_oauth_token' }
  | { kind: 'bad_path'; path: string };

/**
 * Pre-dispatch input validator. Returns `ok` or a structured
 * reason. URL-shape validation is intentionally light (full
 * GitHub-URL parsing belongs to Entry 2's backend; harness-link
 * parsing belongs to Entry 4's parser); this is the
 * cheap-up-front check the picker UI uses to disable the Create
 * button until the form is well-formed.
 */
export function validateCreateHarnessEntry(
  input: CreateHarnessEntryInput,
): EntryValidationResult {
  switch (input.kind) {
    case 'entry_1_init':
      if (!input.slug) return { kind: 'missing_field', field: 'slug' };
      if (!input.parentDir) return { kind: 'bad_path', path: input.parentDir };
      if (!input.folderName) return { kind: 'missing_field', field: 'folderName' };
      return { kind: 'ok' };

    case 'entry_2_github_url':
      if (!input.githubUrl) return { kind: 'missing_field', field: 'githubUrl' };
      if (!/^https?:\/\//.test(input.githubUrl)) {
        return { kind: 'bad_url', url: input.githubUrl };
      }
      if (!input.oauthToken) return { kind: 'bad_oauth_token' };
      return { kind: 'ok' };

    case 'entry_3_existing_folder':
      if (!input.slug) return { kind: 'missing_field', field: 'slug' };
      if (!input.path) return { kind: 'bad_path', path: input.path };
      return { kind: 'ok' };

    case 'entry_4_harness_link':
      if (!input.harnessLink) return { kind: 'missing_field', field: 'harnessLink' };
      if (!input.harnessLink.startsWith('papercusp://')) {
        return { kind: 'bad_url', url: input.harnessLink };
      }
      if (!input.oauthToken) return { kind: 'bad_oauth_token' };
      return { kind: 'ok' };
  }
}

// ─── Default-state derivation ───────────────────────────────────

/**
 * Re-export: the default state for an entry kind. Lifts the cross-
 * module dependency on harness-state-types into this single import
 * so picker UI + backend route both get one source of truth.
 */
export function defaultStateForCreateHarnessEntry(
  input: CreateHarnessEntryInput,
): HarnessState | null {
  return defaultStateForEntry(input.kind);
}

/**
 * Per v5 §3 + D-025: Entry 2's defaulting to shared-private is
 * intentional (no "private harness from GitHub URL" branch — the
 * user should use Entry 3 for that). UI MUST NOT offer a privacy
 * toggle for Entry 2's create-flow; the wizard handles all later
 * sharing decisions.
 *
 * Predicate: does this entry support user choosing the initial
 * privacy state? Currently NONE — every entry has a fixed default
 * or inherits.
 */
export function entryAllowsCustomInitialState(kind: HarnessEntryKind): boolean {
  void kind;
  return false;
}

// ─── Display helpers ────────────────────────────────────────────

/**
 * Per v5 §3: each entry has a display label for the picker UI
 * card. Centralized so the picker + the success-toast + the
 * audit-log row share identical copy.
 */
export const ENTRY_DISPLAY_LABELS: Record<HarnessEntryKind, string> = {
  entry_1_init: 'New local directory',
  entry_2_github_url: 'GitHub URL',
  entry_3_existing_folder: 'Existing local folder',
  entry_4_harness_link: 'Harness link',
};

export function displayLabelForEntry(kind: HarnessEntryKind): string {
  return ENTRY_DISPLAY_LABELS[kind];
}

/**
 * Per v5 §3: short-form description (sub-label under the picker
 * card title).
 */
export const ENTRY_DISPLAY_DESCRIPTIONS: Record<HarnessEntryKind, string> = {
  entry_1_init: 'Start a new local-only project. Private by default.',
  entry_2_github_url: 'Paste a GitHub URL. Joins or creates a shared harness.',
  entry_3_existing_folder: 'Use a folder you already have. Private by default.',
  entry_4_harness_link: 'Paste a papercusp:// link from a teammate.',
};

export function displayDescriptionForEntry(kind: HarnessEntryKind): string {
  return ENTRY_DISPLAY_DESCRIPTIONS[kind];
}
