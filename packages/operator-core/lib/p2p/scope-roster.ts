/**
 * lib/p2p/scope-roster.ts — the P-006 §5.2/§5.3 ROSTER SEAM (FS-D2/FS-D6): who
 * is a member of a fleet scope, resolved cache-bypassingly + keyed by NUMERIC
 * GitHub user id (X9), with the scope's current epoch (X6).
 *
 * WHY THIS IS DELIBERATELY THIN (and NOT grant-store-derived per-user):
 *   The P-001 grant primitive is keyed `(grantor-uid → grantee {fleet-slug |
 *   pool-id}, capability)` (D-010). It answers "is FLEET F authorized by
 *   grantor G for capability C" — it does NOT encode, and cannot answer,
 *   "is USER U a member of fleet F": the grantee is a fleet/pool string, never
 *   a user id, and resolving a grantee-fleet-slug back to its member users needs
 *   the P-101 fleet directory's `owner` + `publisher set` fields (design §9:
 *   "roster derivation depends on P-101's directory schema"). Guessing a
 *   per-user mapping out of the grant rows would bake a SECURITY-relevant
 *   membership bug (membership = who may read foreign work). So we don't guess.
 *
 * WHAT SHIPS NOW (FS-D5 tier 1 = SAME-OWNER machines only): a fleet scope's
 * roster is exactly its owner's numeric id — the owner and the owner's OWN other
 * attested machines all announce under that single github user id, which is the
 * whole tier-1 rig (tower + iMac). Cross-user membership (tier 2) is GATED on
 * 5.4 per-scope crypto (not built) alongside the X1 loopback boundary — so a
 * same-owner-only roster is not a stopgap, it is the correct enforcement for
 * everything that is allowed to replicate today.
 *
 * P-101 SLOT-IN: when the directory lands, implement {@link FleetDirectory} over
 * it and pass it to {@link GrantBackedScopeRoster}; the membership answer widens
 * to `{owner} ∪ publisher-set` with ZERO change to every §5.1/§5.3 caller (they
 * only ever see the {@link IsScopeMember} predicate). Until then the directory
 * is absent and membership is owner-only.
 *
 * C6/FS-D6: `isMember` / `currentEpoch` are DIRECT PG reads on every call — no
 * memoization, no TTL — so a revocation (epoch bump) that federated one
 * statement ago is enforced on the very next disclose/serve check.
 */

// LAZY on purpose — see the note at the `await import('@papercusp/db-org')`
// call site below and plan harden-shared-hive-to-256-peers-2026-06-29 / D-024.
// This module is reached from the substrate boot path via pot-git/serve-wiring;
// a static edge here charges every peer process ~125MB of drizzle it never uses.
import type { OrgSql } from '../work-items';
import { resolveP2pGrantWorkspace } from './grant-store';
import type { ScopeId } from '../sync/pot-git/scope-repo';
import type { IsScopeMember } from '../sync/hyperbee/scope-disclosure';

/**
 * P-101 directory seam (absent until P-101 ships). An implementation resolves a
 * fleet scope to the NUMERIC github user ids of its members — the owner plus the
 * ratified publisher set — cache-bypassingly. Kept intentionally minimal so
 * P-101 owns the schema; this module only consumes numeric ids (X9).
 */
export interface FleetDirectory {
  /** Numeric github user ids that are members of `scope` right now, or null when
   *  the directory has no record of the scope (⇒ owner-only fallback). */
  scopeMembers(scope: ScopeId): Promise<number[] | null>;
}

export interface ScopeRoster {
  /** FS-D6: is `githubUserId` in `scope`'s roster right now? Cache-bypassing. */
  isMember(scope: ScopeId, githubUserId: number): Promise<boolean>;
  /** The full member id set (disclosure/redisclosure inputs). */
  members(scope: ScopeId): Promise<number[]>;
  /** X6: the scope's current epoch — the grantor(=owner) high-water, so a
   *  revocation that bumped the owner's epoch advances every disclosure. */
  currentEpoch(scope: ScopeId): Promise<number>;
  /** The {@link IsScopeMember} predicate the §5.1/§5.3 layer consumes. */
  readonly predicate: IsScopeMember;
}

export interface ScopeRosterDeps {
  /** The caller's resolved identity workspace (C3 — run through resolveP2pGrantWorkspace). */
  workspaceId: string | null | undefined;
  /** The hive HOME slug the fleet's grants/epochs federate under. */
  potSlug: string;
  /** P-101 directory, when it exists. Absent ⇒ owner-only (tier-1). */
  directory?: FleetDirectory;
  sqlOverride?: OrgSql;
}

/**
 * The grant-store-backed roster. Membership = `{owner}` (tier-1) widened by the
 * injected {@link FleetDirectory} publisher set (tier-2/P-101). The epoch is the
 * owner's grantor high-water (X6), read live.
 */
export class GrantBackedScopeRoster implements ScopeRoster {
  private readonly deps: ScopeRosterDeps;
  readonly predicate: IsScopeMember;

  constructor(deps: ScopeRosterDeps) {
    this.deps = deps;
    // Bind the predicate the disclosure/serve layer consumes.
    this.predicate = (scope: ScopeId, uid: number) => this.isMember(scope, uid);
  }

  async isMember(scope: ScopeId, githubUserId: number): Promise<boolean> {
    // The owner is always in their own scope — no store read needed, and it
    // holds even before any grant/directory row exists (bootstrap-safe).
    if (githubUserId === scope.ownerGithubUserId) return true;
    const dir = this.deps.directory;
    if (!dir) return false; // tier-1: owner-only
    const members = await dir.scopeMembers(scope);
    if (members == null) return false; // directory has no record ⇒ owner-only
    return members.includes(githubUserId);
  }

  async members(scope: ScopeId): Promise<number[]> {
    const dir = this.deps.directory;
    if (!dir) return [scope.ownerGithubUserId];
    const members = await dir.scopeMembers(scope);
    if (members == null) return [scope.ownerGithubUserId];
    // Owner is always in — de-dup in case the directory already lists them.
    return members.includes(scope.ownerGithubUserId)
      ? members
      : [scope.ownerGithubUserId, ...members];
  }

  /**
   * X6: the scope epoch = the owner's high-water epoch in p2p_grantor_epochs,
   * so leave/revoke (which bumps the grantor epoch, grant-store.ts) advances
   * every disclosure of this scope. 0 when the owner has no epoch row yet
   * (no grant/revocation has ever happened — a fresh, un-revoked scope).
   * Cache-bypassing direct read (C6).
   */
  async currentEpoch(scope: ScopeId): Promise<number> {
    const ws = resolveP2pGrantWorkspace(this.deps.workspaceId);
    if (!ws) return 0; // unresolvable partition ⇒ epoch 0 (fail-closed: no disclosure widening)
    const sql = this.deps.sqlOverride ?? (await import('@papercusp/db-org')).getOrgPg().sql;
    const rows = (await sql`
      SELECT high_water_epoch
        FROM harness_shared.p2p_grantor_epochs
       WHERE workspace_id = ${ws} AND harness_slug = ${this.deps.potSlug}
         AND grantor_github_user_id = ${scope.ownerGithubUserId}
       LIMIT 1`) as unknown as { high_water_epoch: string | number }[];
    const e = rows[0]?.high_water_epoch;
    return e == null ? 0 : Number(e);
  }
}

/** Convenience: the roster for the current tier-1 rollout (no directory). */
export function getScopeRoster(deps: ScopeRosterDeps): ScopeRoster {
  return new GrantBackedScopeRoster(deps);
}
