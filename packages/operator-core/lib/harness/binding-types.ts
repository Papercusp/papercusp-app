/**
 * binding-types — canonical types for the shared-repo binding service.
 *
 * Sources from `dogfood-design-memo-binding-service-api-2026-05-24.md`.
 * Types-only module — no logic, no runtime. The implementation (Phase 1b
 * P-068) will consume these types directly.
 *
 * Why types-first: the memo is "draft for review." Shipping the types now
 * lets P-068's eventual implementation use them without a circular
 * design-vs-implementation race. If the memo revises (e.g. adds a column
 * to BindingRecord), this file changes alongside, and downstream consumers
 * get a typecheck error to update.
 *
 * Two consumers will eventually import from here:
 *   - apps/operator/lib/harness/binding-service.ts (embedded, P-068)
 *   - apps/operator-public/lib/binding-service.ts (Cupboard server, P-051a)
 *
 * The types are deliberately identical across the two deployments per
 * memo D-A.
 */

/**
 * Provider identifier — currently github-only. Future PrHost expansion
 * (gitlab / gitea / bitbucket) extends this union. Leaving it as a
 * single-variant union NOW (not a string literal) makes the
 * expansion-time typecheck error trivial.
 */
export type BindingProvider = 'github';

/**
 * Privacy mode for the binding's harness. Per v5 §5 — `shared-private`
 * means contributors must hold a binding to see the harness;
 * `shared-public` means the binding is listed in Cupboard.
 */
export type BindingPrivacy = 'shared-private' | 'shared-public';

/**
 * Claim lifecycle states. `unclaimed` is the default after
 * `createUnclaimedBinding`; `claimed` after a successful `claimBinding`;
 * `stale` after the daily re-check finds all claimants have lost the
 * required GitHub permission; `superseded` after an admin-initiated
 * `supersedeBinding` flips the previous binding's pointer to a new
 * harness topic.
 */
export type BindingClaimStatus =
  | 'unclaimed'
  | 'claimed'
  | 'stale'
  | 'superseded';

/**
 * The canonical binding record. Keyed by `(provider, github_repository_id)`
 * per memo D-B — owner/name renames, numeric ids don't.
 *
 * Field names use snake_case to match the SQL column shape exactly
 * (`shared_repo_binding_cache` in Phase 1a P-013a follows the same).
 */
export type BindingRecord = {
  // Identity
  provider: BindingProvider;
  github_repository_id: number;
  github_full_name: string;

  // Harness pointer
  harness_topic: string;
  harness_slug: string;
  harness_link: string;

  // Visibility
  privacy: BindingPrivacy;

  // Claim state
  claim_status: BindingClaimStatus;
  provisional_owner_github_user_id: number;
  /** GitHub login of the provisional owner (the engineer who created the
   *  binding). Stored at create time so the share UI can name the existing
   *  publisher without an extra id→login GitHub lookup on every resolve. */
  provisional_owner_github_login: string;
  claimed_by_github_user_ids: number[];

  // Lifecycle
  created_at: string;
  claimed_at?: string;
  last_permission_verified_at?: string;
  superseded_by_harness_topic?: string;
};

/**
 * Structured error union per memo D-D. Callers branch on `code`; UI
 * maps each variant to user-actionable copy. Free-text errors are for
 * the implementer's log, not for the user.
 */
export type BindingServiceError =
  | { code: 'BINDING_EXISTS'; binding: BindingRecord }
  | { code: 'BINDING_NOT_FOUND' }
  | { code: 'BINDING_NOT_CLAIMABLE'; reason: string }
  | { code: 'CLAIM_PERMISSION_DENIED'; actual: string; required: string }
  | { code: 'SUPERSEDE_PERMISSION_DENIED'; actual: string; required: string }
  | { code: 'GITHUB_REPO_NOT_FOUND' }
  | { code: 'GITHUB_REPO_PRIVATE_NO_ACCESS' }
  | { code: 'GITHUB_API_RATE_LIMIT'; retry_after_ms: number }
  | { code: 'GITHUB_API_DOWN'; message: string };

/**
 * GitHub permission levels returned by
 * `GET /repos/{owner}/{repo}/collaborators/{login}/permission`. Used
 * in `CLAIM_PERMISSION_DENIED` / `SUPERSEDE_PERMISSION_DENIED`'s
 * `actual` field, and to type the permission-check return value.
 */
export type GithubRepoPermission =
  | 'admin'
  | 'maintain'
  | 'write'
  | 'triage'
  | 'read'
  | 'none';

/**
 * Compose a binding id from (provider, repository_id). The composition
 * is reversible — `parseBindingId` recovers both parts — so callers
 * can pass the id around as an opaque string but the service layer can
 * route by repo_id without a lookup table.
 */
export function composeBindingId(
  provider: BindingProvider,
  repositoryId: number,
): string {
  return provider + ':' + String(repositoryId);
}

/**
 * Reverse of `composeBindingId`. Returns null on malformed input;
 * callers handle the null case (a malformed id is a client bug, not
 * a domain error — surface it as 400, not as one of the typed
 * BindingServiceError variants).
 */
export function parseBindingId(
  id: string,
): { provider: BindingProvider; repositoryId: number } | null {
  const colonIdx = id.indexOf(':');
  if (colonIdx === -1) return null;
  const provider = id.slice(0, colonIdx);
  if (provider !== 'github') return null;
  const repoIdStr = id.slice(colonIdx + 1);
  if (!/^[0-9]+$/.test(repoIdStr)) return null;
  const repoId = Number.parseInt(repoIdStr, 10);
  if (!Number.isSafeInteger(repoId) || repoId <= 0) return null;
  return { provider, repositoryId: repoId };
}

/**
 * Required-permission table per memo. Exported so UI + service share
 * one source of truth — if the rule changes (e.g. claim requires
 * admin too), only this constant moves.
 */
export const CLAIM_REQUIRED_PERMISSION: GithubRepoPermission[] = [
  'admin',
  'maintain',
];
export const SUPERSEDE_REQUIRED_PERMISSION: GithubRepoPermission[] = ['admin'];

/**
 * Predicate: does the actual permission satisfy the required set?
 * `none` always fails. Used by the eventual P-068 implementation +
 * by the UI to disable the "claim" / "supersede" button preemptively.
 */
export function hasRequiredPermission(
  actual: GithubRepoPermission,
  required: GithubRepoPermission[],
): boolean {
  return required.includes(actual);
}

/**
 * Structured throwable wrapper for `BindingServiceError`. Lives in the
 * types module (not the service) so UI / client code can `instanceof`
 * the error without dragging in the server-only binding-service
 * imports (octokit, workspace-registry, PG).
 */
export class BindingServiceErrorThrowable extends Error {
  readonly error: BindingServiceError;

  constructor(error: BindingServiceError) {
    super(error.code);
    this.error = error;
    this.name = 'BindingServiceErrorThrowable';
  }
}
