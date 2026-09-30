/**
 * user-profile-types — data shapes for the §18 user profile page
 * per papercusp-dogfood-v5 (D-028 in addendum 3).
 *
 * Types-only and PURE. No PG, no React.
 *
 * Twenty-seventh module in the dogfood-arc types-only spine.
 *
 * Per v5 §18:
 *   Route: /users/github/<github_user_id>
 *   Legacy alias: /users/<github_login> → 301 to canonical numeric.
 *   Privacy: profile-fetchable for any contributor in any shared
 *     harness the viewer is a member of; viewers with no shared-
 *     harness overlap see only GitHub-derived header + tier-A from
 *     shared-public harnesses.
 *   Tier-D: omitted from profile entirely (personal spend never
 *     crosses to other viewers).
 *
 * UI implementer drops these in when paperclip-zone work resumes.
 */

import {
  type BindingStatus,
} from '../identity/binding-verifier-types';
import {
  type TieredStat,
} from './stat-tier-types';

/**
 * Header block — always rendered, even for viewers with no shared-
 * harness overlap.
 */
export interface UserProfileHeader {
  github_user_id: number;
  github_login: string;
  display_name: string | null;
  avatar_url: string | null;
  /** True only if pubkey↔login binding passed §0.2.7. */
  binding_status: BindingStatus;
  /** Full GitHub profile URL. */
  github_url: string;
}

/**
 * Per-harness collapsible block per §18.
 */
export interface UserProfileHarnessBlock {
  harness_slug: string;
  harness_title: string;
  /** Whether this harness is shared-public, shared-private, or private. */
  harness_state: 'private' | 'shared-private' | 'shared-public';
  /** Tier-A stats per §18 (PRs opened/merged/reviewed from GitHub API). */
  tier_a_stats: TieredStat<number>[];
  /** Tier-B stats per §18 (completion_ref-verified features). */
  tier_b_stats: TieredStat<number>[];
  /** Tier-C stats per §18 (Hyperbee-claimed activity). Omitted when
   * viewer doesn't satisfy the per-harness privacy gate. */
  tier_c_stats: TieredStat<number>[] | null;
}

/**
 * Recent activity feed entry per §18 ("last ~30 events, tier-badged").
 * Same shape as ActivityEvent in insights-card-types but scoped to
 * one user across multiple harnesses.
 */
export interface UserProfileActivityEntry {
  /** Epoch ms — sort key. */
  ts: number;
  harness_slug: string;
  label: string;
  detail_url: string;
  /** Inherits from `ACTIVITY_EVENT_TIER` per kind. */
  tier: 'A' | 'B' | 'C';
}

export const USER_PROFILE_ACTIVITY_DEFAULT_LIMIT = 30;

/**
 * Footer block per §18 — claimed harnesses ("where this user is a
 * verified claimant per §5.1"). Useful for the "what else does
 * Alice maintain?" path.
 */
export interface UserProfileClaimedHarness {
  harness_slug: string;
  harness_title: string;
  /** Permission level at claim verification time. */
  github_permission: 'maintain' | 'admin';
  /** Epoch ms when the claim was verified. */
  claimed_at: number;
}

/**
 * The full profile-page payload. UI iterates `harness_blocks` per
 * §18 in title-asc or recent-activity-desc order (renderer's choice).
 */
export interface UserProfilePayload {
  header: UserProfileHeader;
  /** Per-harness blocks the viewer is allowed to see. May be empty
   * for low-overlap viewers — UI renders an empty-state in that case. */
  harness_blocks: UserProfileHarnessBlock[];
  recent_activity: UserProfileActivityEntry[];
  claimed_harnesses: UserProfileClaimedHarness[];
  /** True when this contributor is unverified — UI shows the
   * §18 prominent banner. */
  show_unverified_banner: boolean;
}

// ─── Routing helpers ────────────────────────────────────────────

export const USER_PROFILE_CANONICAL_PATH_PREFIX = '/users/github/' as const;
export const USER_PROFILE_LEGACY_PATH_PREFIX = '/users/' as const;

/**
 * Build the canonical numeric profile URL. Single source of truth
 * for every avatar-click target across the operator UI.
 */
export function userProfilePath(githubUserId: number): string {
  if (!Number.isInteger(githubUserId) || githubUserId <= 0) {
    throw new TypeError('githubUserId must be a positive integer');
  }
  return USER_PROFILE_CANONICAL_PATH_PREFIX + githubUserId;
}

/**
 * Build the legacy username path. Caller fetches the numeric id +
 * 301s. Provided so legacy redirect handlers + Marketplace links
 * share one path-builder.
 */
export function userProfileLegacyPath(githubLogin: string): string {
  if (typeof githubLogin !== 'string' || githubLogin.length === 0) {
    throw new TypeError('githubLogin required');
  }
  return USER_PROFILE_LEGACY_PATH_PREFIX + githubLogin;
}

/**
 * Inverse: parse a profile URL path and return the github_user_id
 * if it matches the canonical numeric form. Returns null for legacy
 * username form OR malformed input (caller resolves login → id and
 * 301s separately).
 */
export function parseUserProfilePath(path: string): number | null {
  if (typeof path !== 'string') return null;
  if (!path.startsWith(USER_PROFILE_CANONICAL_PATH_PREFIX)) return null;
  const rest = path.slice(USER_PROFILE_CANONICAL_PATH_PREFIX.length);
  if (rest.length === 0 || rest.includes('/')) return null;
  const id = Number(rest);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

// ─── Privacy helpers ────────────────────────────────────────────

/**
 * Predicate per §18 privacy invariants: should this harness's block
 * be visible to the viewer?
 *
 *   - private:        NEVER visible.
 *   - shared-private: visible only if viewer is a member.
 *   - shared-public:  always visible.
 */
export function isHarnessBlockVisibleToViewer(args: {
  harness_state: 'private' | 'shared-private' | 'shared-public';
  viewer_is_member: boolean;
}): boolean {
  if (args.harness_state === 'private') return false;
  if (args.harness_state === 'shared-public') return true;
  return args.viewer_is_member;
}

/**
 * Predicate per §18 + §17: should tier-C stats render for this
 * harness block? Only when the viewer is a member (per
 * user_profile_member surface in SURFACE_ALLOWED_TIERS).
 */
export function shouldRenderTierCForHarnessBlock(args: {
  harness_state: 'private' | 'shared-private' | 'shared-public';
  viewer_is_member: boolean;
}): boolean {
  if (!isHarnessBlockVisibleToViewer(args)) return false;
  return args.viewer_is_member;
}

/**
 * Build the visible-harnesses filter for a profile payload given
 * the viewer's per-harness membership map. Pure — caller passes
 * `viewer_memberships` as a Set of harness_slugs the viewer is a
 * member of.
 */
export function filterHarnessBlocksForViewer(
  blocks: ReadonlyArray<UserProfileHarnessBlock>,
  viewer_memberships: ReadonlySet<string>,
): UserProfileHarnessBlock[] {
  return blocks.filter((b) =>
    isHarnessBlockVisibleToViewer({
      harness_state: b.harness_state,
      viewer_is_member: viewer_memberships.has(b.harness_slug),
    }),
  );
}

/**
 * Apply the tier-C visibility gate across all blocks. Mutates a
 * fresh copy of each block's `tier_c_stats` to null when the
 * viewer doesn't satisfy the gate.
 */
export function gateBlocksTierCForViewer(
  blocks: ReadonlyArray<UserProfileHarnessBlock>,
  viewer_memberships: ReadonlySet<string>,
): UserProfileHarnessBlock[] {
  return blocks.map((b) => {
    const canSeeTierC = shouldRenderTierCForHarnessBlock({
      harness_state: b.harness_state,
      viewer_is_member: viewer_memberships.has(b.harness_slug),
    });
    return canSeeTierC ? b : { ...b, tier_c_stats: null };
  });
}

// ─── Activity feed cap + sort ───────────────────────────────────

/**
 * Sort + cap helper per §18 ("last ~30 events"). Newest-first.
 */
export function buildRecentActivity(
  events: ReadonlyArray<UserProfileActivityEntry>,
  limit: number = USER_PROFILE_ACTIVITY_DEFAULT_LIMIT,
): UserProfileActivityEntry[] {
  return events
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(0, limit));
}

// ─── Verification banner ────────────────────────────────────────

/**
 * Predicate per §18: should the unverified-contributor banner show?
 * True iff binding_status is not 'verified'.
 */
export function shouldShowUnverifiedBanner(binding_status: BindingStatus): boolean {
  return binding_status !== 'verified';
}
