/**
 * pot-git/scope-serve-gate.ts — the ROSTER SERVE-GATE for per-scope bare repos
 * (P-006 §5.3 / P-108 D-018 option (b); ratified D-017).
 *
 * A scope repo's git bytes may be served ONLY to a verified member of that
 * scope. This module issues the {@link ScopeRepoServeGrant} that
 * `fetch-transport.serveUploadPack` demands for any path inside the
 * `<root>/<hive>/scopes/` family — making the roster check STRUCTURALLY
 * unskippable by whatever wiring eventually hosts the serve side (there is no
 * live `serveUploadPack` caller yet; this gate lands first so the fail-closed
 * contract exists before the plane does).
 *
 * DISCIPLINE (mirrors hyperbee/scope-cores.ts):
 * - Authorize per INBOUND FETCH — never cache a grant across fetches. The
 *   membership predicate's contract is a cache-bypassing read every call
 *   (GrantBackedScopeRoster.predicate does direct PG reads), so revocation
 *   takes effect on the next fetch (§5.3 revocation edge).
 * - Fail-closed everywhere: malformed path, invalid peer id, non-member, and a
 *   THROWING roster all refuse (D-004: the refusal object is the caller's
 *   receipt trigger — emit a P-004 receipt / M15 counter per refusal, reason
 *   string convention `scoped-repo-serve:<reason>`).
 * - A grant is bound to the exact repoPath + peer it was issued for and is only
 *   trusted when it came from THIS module ({@link isIssuedScopeServeGrant} —
 *   a hand-built object with the right fields is refused).
 */

import { type ScopeId, formatScopeId, parseScopeRepoPath } from './scope-repo';

/** Cache-bypassing scope-membership read (structurally identical to the
 *  hyperbee layer's `IsScopeMember`; declared locally so pot-git does not
 *  import from the hyperbee layer — `roster.predicate` satisfies both). */
export type ScopeMemberPredicate = (
  scope: ScopeId,
  githubUserId: number,
) => Promise<boolean> | boolean;

/** A refused serve authorization — the caller's P-004 receipt / M15 counter
 *  trigger (D-004: never a silent drop). */
export interface ScopeRepoServeRefusal {
  reason: 'malformed-scope-path' | 'invalid-peer-id' | 'not-a-member' | 'roster-error';
  repoPath: string;
  /** Canonical scope id when the path parsed; null for malformed paths. */
  scopeId: string | null;
  peerGithubUserId: number;
  detail?: string;
}

/** Proof that THIS fetch of THIS scope repo by THIS peer passed the roster. */
export interface ScopeRepoServeGrant {
  readonly repoPath: string;
  readonly scopeId: string;
  readonly peerGithubUserId: number;
}

/** Grants issued by {@link authorizeScopeRepoServe} — the only trusted mint. */
const ISSUED = new WeakSet<object>();

/** True only for a grant object minted by this module (not a look-alike). */
export function isIssuedScopeServeGrant(grant: unknown): grant is ScopeRepoServeGrant {
  return typeof grant === 'object' && grant !== null && ISSUED.has(grant);
}

export type ScopeRepoServeDecision =
  | { ok: true; grant: ScopeRepoServeGrant }
  | { ok: false; refusal: ScopeRepoServeRefusal };

/**
 * Authorize serving the scope repo at `repoPath` to the VERIFIED peer
 * `peerGithubUserId` (the caller must have admitted the peer's signed announce
 * first — never pass a pre-admission identity). One call per inbound fetch.
 */
export async function authorizeScopeRepoServe(input: {
  repoPath: string;
  peerGithubUserId: number;
  isScopeMember: ScopeMemberPredicate;
}): Promise<ScopeRepoServeDecision> {
  const { repoPath, peerGithubUserId } = input;
  const refuse = (
    reason: ScopeRepoServeRefusal['reason'],
    scopeId: string | null,
    detail?: string,
  ): ScopeRepoServeDecision => ({
    ok: false,
    refusal: { reason, repoPath, scopeId, peerGithubUserId, ...(detail ? { detail } : {}) },
  });

  const parsed = parseScopeRepoPath(repoPath);
  if (!parsed) return refuse('malformed-scope-path', null);
  const scopeId = formatScopeId(parsed.scope);
  if (!Number.isInteger(peerGithubUserId) || peerGithubUserId <= 0) {
    return refuse('invalid-peer-id', scopeId);
  }
  let member: boolean;
  try {
    member = await input.isScopeMember(parsed.scope, peerGithubUserId);
  } catch (e) {
    return refuse('roster-error', scopeId, e instanceof Error ? e.message : String(e));
  }
  if (member !== true) return refuse('not-a-member', scopeId);

  const grant: ScopeRepoServeGrant = Object.freeze({ repoPath, scopeId, peerGithubUserId });
  ISSUED.add(grant);
  return { ok: true, grant };
}
