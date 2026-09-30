/**
 * claim-status-resolver — Phase 8 P-069 (a/b/e) view-model.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 *
 * PURE logic that turns a `shared_repo_binding_cache` row (the
 * claim-status data source, keyed by `(workspace_id, harness_slug)`) +
 * the local viewer's github id into exactly what the live `/adv`
 * `HarnessClaimHeader` needs to render:
 *
 *   - status / claimantLogin / supersededByHref inputs for the badge,
 *   - the claimant list (id + resolved login),
 *   - the provisional owner login,
 *   - viewer-scoped predicates (`isProvisionalOwner`, `isClaimant`,
 *     `viewerCanClaim`) computed against the passed viewer id,
 *   - a one-line `claimantSummary` for the settings-banner copy
 *     (P-069b: "You're the provisional owner." / "Claimed by @alice
 *     + 2 others.").
 *
 * No fetch, no PG — the route reads the row and `useViewer()` supplies
 * the id. `viewerCanClaim` here is only a UI HINT (status is claimable
 * + a known viewer); the authoritative permission check is the GitHub
 * `maintain/admin` lookup the claim route does server-side via
 * `claimBinding`. The CTA therefore optimistically shows and the
 * structured permission error surfaces on rejection.
 */

import { composeBindingId, type BindingClaimStatus } from './binding-types';

/** The subset of a binding-cache row the resolver needs. */
export interface ClaimStatusRow {
  github_repository_id: number;
  claim_status: BindingClaimStatus;
  provisional_owner_github_user_id: number;
  provisional_owner_github_login: string;
  claimed_by_github_user_ids: number[];
  /**
   * Optional id→login map for the claimants. The binding cache stores
   * only numeric ids; the route joins `harness_shared.contributors`
   * to resolve logins where available. Missing entries render as a
   * null login (id shown, no @handle).
   */
  claimant_logins: Record<number | string, string>;
  /** For superseded bindings, the successor harness topic (→ href). */
  superseded_by_harness_topic?: string | null;
}

export interface ClaimantEntry {
  githubUserId: number;
  /** Resolved GitHub login, or null when no mapping is available. */
  login: string | null;
}

export interface ResolvedClaimStatus {
  status: BindingClaimStatus;
  /** Opaque binding id (`github:<repoId>`) for the claim CTA, or null
   *  when there is no binding row. */
  bindingId: string | null;
  /** Lead claimant login (first claimant), or null. Feeds the badge. */
  claimantLogin: string | null;
  /** All claimants with resolved logins. */
  claimants: ClaimantEntry[];
  /** Provisional owner login, or null when there is no binding. */
  provisionalOwnerLogin: string | null;
  /** True when the viewer is the binding's provisional owner. */
  isProvisionalOwner: boolean;
  /** True when the viewer is among the claimants. */
  isClaimant: boolean;
  /**
   * UI hint: show the claim CTA. True only for a known (non-anonymous)
   * viewer when the status is claimable (`unclaimed` / `stale`). The
   * real permission gate is the server-side GitHub check.
   */
  viewerCanClaim: boolean;
  /** Optional successor href (superseded). */
  supersededByHref: string | null;
  /** One-line settings-banner copy (P-069b). */
  claimantSummary: string;
}

function lookupLogin(
  map: Record<number | string, string>,
  id: number,
): string | null {
  const v = map[id] ?? map[String(id)];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function summaryFor(
  status: BindingClaimStatus,
  claimants: ClaimantEntry[],
  provisionalOwnerLogin: string | null,
  isProvisionalOwner: boolean,
): string {
  if (status === 'claimed' && claimants.length > 0) {
    const lead = claimants[0]!.login ? `@${claimants[0]!.login}` : `user ${claimants[0]!.githubUserId}`;
    const others = claimants.length - 1;
    return others > 0
      ? `Claimed by ${lead} + ${others} other${others === 1 ? '' : 's'}.`
      : `Claimed by ${lead}.`;
  }
  if (status === 'stale') {
    return 'The last claimant lost their GitHub permission — provisional-owner controls are re-enabled.';
  }
  if (status === 'superseded') {
    return 'This harness has been superseded by a newer canonical binding.';
  }
  // unclaimed
  if (isProvisionalOwner) return "Unclaimed — you're the provisional owner.";
  if (provisionalOwnerLogin) {
    return `Unclaimed — @${provisionalOwnerLogin} is the provisional owner.`;
  }
  return 'Unclaimed — no provisional owner recorded.';
}

/**
 * Resolve a binding-cache row (or null) + the viewer's github id into
 * the HarnessClaimHeader view-model. `null` row = no shared binding
 * exists for the harness yet (LOCAL-only, never published / joined).
 */
export function resolveClaimStatus(
  rowOrNull: ClaimStatusRow | null,
  viewerGithubUserId: number | null,
): ResolvedClaimStatus {
  if (!rowOrNull) {
    return {
      status: 'unclaimed',
      bindingId: null,
      claimantLogin: null,
      claimants: [],
      provisionalOwnerLogin: null,
      isProvisionalOwner: false,
      isClaimant: false,
      viewerCanClaim: false,
      supersededByHref: null,
      claimantSummary: 'This harness has no shared binding yet.',
    };
  }

  const row = rowOrNull;
  const claimants: ClaimantEntry[] = (row.claimed_by_github_user_ids ?? []).map((id) => ({
    githubUserId: Number(id),
    login: lookupLogin(row.claimant_logins ?? {}, Number(id)),
  }));

  const provisionalOwnerLogin =
    row.provisional_owner_github_login && row.provisional_owner_github_login.length > 0
      ? row.provisional_owner_github_login
      : null;

  const isProvisionalOwner =
    viewerGithubUserId != null &&
    Number(row.provisional_owner_github_user_id) === viewerGithubUserId;

  const isClaimant =
    viewerGithubUserId != null &&
    claimants.some((c) => c.githubUserId === viewerGithubUserId);

  const claimable = row.claim_status === 'unclaimed' || row.claim_status === 'stale';
  const viewerCanClaim = claimable && viewerGithubUserId != null;

  const supersededByHref =
    row.claim_status === 'superseded' && row.superseded_by_harness_topic
      ? `papercusp://harness?topic=${row.superseded_by_harness_topic}`
      : null;

  return {
    status: row.claim_status,
    bindingId: composeBindingId('github', Number(row.github_repository_id)),
    claimantLogin: claimants[0]?.login ?? null,
    claimants,
    provisionalOwnerLogin,
    isProvisionalOwner,
    isClaimant,
    viewerCanClaim,
    supersededByHref,
    claimantSummary: summaryFor(
      row.claim_status,
      claimants,
      provisionalOwnerLogin,
      isProvisionalOwner,
    ),
  };
}
