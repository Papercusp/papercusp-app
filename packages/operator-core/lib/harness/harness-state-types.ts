/**
 * harness-state-types — pure state machine + sub-harness slug
 * helpers for v5 §1.2 (harness state) + §1.3 (sub-harness).
 *
 * Types-only and PURE. No fs, no git.
 *
 * Thirty-first module in the dogfood-arc types-only spine.
 *
 * Per v5 §1.2:
 *   - state ∈ {private, shared-private, shared-public}
 *   - private — single-engineer, no Hyperbee, no user-branch
 *   - shared-private — explicit repo-link or harness-link gated.
 *     Hyperbee sync + user-branch + GitHub-forced
 *   - shared-public — same as shared-private + Cupboard registry entry
 *   - Default for Entries 1+3 (local-only): `private`
 *   - Entry 2 (GitHub URL) is shared-only per D-025
 *
 * Per v5 line 319 + 320:
 *   - shared-private → shared-public via "publish to Cupboard" action
 *   - shared-public → shared-private via "remove from Cupboard" action
 *   - private → shared-private via §5 share-this-harness wizard
 *   - shared → private: NOT allowed in v1 (downgrade would leave
 *     peers stranded; future v2 may add with explicit confirmation)
 *
 * Per v5 §1.3:
 *   - Sub-harness slugs are path-qualified: `papercup/libs/sync`
 *   - NOT a separate queue; sub-harnesses register as code-location
 *     nodes within the root harness's queue
 */

/**
 * The 3 canonical harness states per §1.2.
 */
export const HARNESS_STATES = ['private', 'shared-private', 'shared-public'] as const;
export type HarnessState = (typeof HARNESS_STATES)[number];

/**
 * Forward transitions per v5 line 319-320. Encodes:
 *   - private → shared-private (§5 wizard)
 *   - shared-private → shared-public (publish to Cupboard)
 *   - shared-public → shared-private (remove from Cupboard)
 *   - shared-private → private: NOT allowed in v1 (would strand peers)
 *   - shared-public → private: NOT allowed in v1
 */
export const HARNESS_STATE_FORWARD: Record<HarnessState, ReadonlySet<HarnessState>> = {
  private: new Set(['shared-private']),
  'shared-private': new Set(['shared-public']),
  'shared-public': new Set(['shared-private']),
};

/**
 * Pure predicate: is this transition allowed per §1.2 + line 319-320?
 */
export function isLegalHarnessTransition(from: HarnessState, to: HarnessState): boolean {
  return HARNESS_STATE_FORWARD[from].has(to);
}

/**
 * Discriminated transition result.
 */
export type HarnessTransitionResult =
  | { kind: 'ok' }
  | { kind: 'illegal'; from: HarnessState; to: HarnessState }
  | { kind: 'requires_wizard'; from: HarnessState; to: HarnessState }
  | { kind: 'requires_unpublish'; from: HarnessState };

/**
 * Pure transition function. Per §1.2:
 *   - private → shared-private → requires §5 share-this-harness wizard
 *     (caller must dispatch the wizard, not direct-flip the column)
 *   - shared-* → private → not allowed (returns 'requires_unpublish'
 *     for shared-public + 'illegal' for shared-private since there
 *     is no documented downgrade path)
 */
export function attemptHarnessTransition(args: {
  from: HarnessState;
  to: HarnessState;
}): HarnessTransitionResult {
  if (args.from === args.to) {
    return { kind: 'ok' }; // no-op transitions are OK
  }
  if (!isLegalHarnessTransition(args.from, args.to)) {
    if (args.from === 'shared-public' && args.to === 'private') {
      return { kind: 'requires_unpublish', from: args.from };
    }
    return { kind: 'illegal', from: args.from, to: args.to };
  }
  if (args.from === 'private' && args.to === 'shared-private') {
    return { kind: 'requires_wizard', from: args.from, to: args.to };
  }
  return { kind: 'ok' };
}

/**
 * Predicate: does this state require Hyperbee sync?
 * Per §1.2: shared-private + shared-public require Hyperbee;
 * private does not.
 */
export function requiresHyperbee(state: HarnessState): boolean {
  return state !== 'private';
}

/**
 * Predicate: does this state require a user-branch?
 * Per §1.2: shared-* require user-branch; private does not.
 */
export function requiresUserBranch(state: HarnessState): boolean {
  return state !== 'private';
}

/**
 * Predicate: does this state require GitHub OAuth?
 * Per §1.2: shared-* are GitHub-forced; private has no GitHub
 * requirement (it's local-only).
 */
export function requiresGithubAuth(state: HarnessState): boolean {
  return state !== 'private';
}

/**
 * Predicate: is this state listable on the Cupboard registry?
 * Per §1.2 + §10: shared-public only.
 */
export function isCupboardListable(state: HarnessState): boolean {
  return state === 'shared-public';
}

/**
 * Default state for a new harness per the entry type. Per v5 §1.2 +
 * D-025:
 *   - Entries 1 + 3 (local-only): private
 *   - Entry 2 (GitHub URL): shared-private (D-025: GitHub URL
 *     creation is shared-only)
 *   - Entry 4 (harness link): inherits state from the link's
 *     existing binding (not a fresh default)
 */
export type HarnessEntryKind = 'entry_1_init' | 'entry_2_github_url' | 'entry_3_existing_folder' | 'entry_4_harness_link';

export function defaultStateForEntry(entry: HarnessEntryKind): HarnessState | null {
  switch (entry) {
    case 'entry_1_init':
    case 'entry_3_existing_folder':
      return 'private';
    case 'entry_2_github_url':
      return 'shared-private';
    case 'entry_4_harness_link':
      // Entry 4 doesn't have a fixed default — state inherits from
      // the existing binding the link resolves to.
      return null;
  }
}

// ─── Sub-harness slugs (§1.3) ────────────────────────────────────

/**
 * Sub-harness slugs are path-qualified per v5 §1.3:
 *
 *   `papercup/libs/sync`  (root: papercup, sub-path: libs/sync)
 *
 * NOT just `sync` — that would collide across roots. Use `/` as the
 * separator since it matches the on-disk path semantics.
 */
export const SUB_HARNESS_SLUG_SEP = '/' as const;

/**
 * Pure builder. Composes a sub-harness slug from a root slug + a
 * sub-path. Rejects malformed input.
 *
 *   composeSubHarnessSlug('papercup', 'libs/sync') => 'papercup/libs/sync'
 */
export function composeSubHarnessSlug(rootSlug: string, subPath: string): string {
  if (typeof rootSlug !== 'string' || rootSlug.length === 0) {
    throw new TypeError('rootSlug required');
  }
  if (typeof subPath !== 'string' || subPath.length === 0) {
    throw new TypeError('subPath required');
  }
  if (rootSlug.includes('/')) {
    throw new TypeError('rootSlug must not contain "/"');
  }
  const cleanSub = subPath.replace(/^\/+|\/+$/g, '');
  if (cleanSub.length === 0) {
    throw new TypeError('subPath must contain a non-slash segment');
  }
  return rootSlug + SUB_HARNESS_SLUG_SEP + cleanSub;
}

/**
 * Pure parser. Returns the root + sub-path, or null for non-sub
 * slugs (a slug with no `/` is a root slug, not a sub-harness).
 */
export function parseSubHarnessSlug(
  slug: string,
): { rootSlug: string; subPath: string } | null {
  if (typeof slug !== 'string') return null;
  const idx = slug.indexOf(SUB_HARNESS_SLUG_SEP);
  if (idx <= 0 || idx === slug.length - 1) return null;
  return {
    rootSlug: slug.slice(0, idx),
    subPath: slug.slice(idx + 1),
  };
}

/**
 * Predicate: is this slug a sub-harness (contains a `/`)?
 */
export function isSubHarnessSlug(slug: string): boolean {
  return parseSubHarnessSlug(slug) !== null;
}

/**
 * Extract the root slug from any slug (sub-harness or not). Useful
 * for §9.1 features tab: features are stored on the root, so the
 * UI needs to map a sub-harness back to its root.
 */
export function rootSlugOf(slug: string): string {
  const parsed = parseSubHarnessSlug(slug);
  return parsed === null ? slug : parsed.rootSlug;
}
