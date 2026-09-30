/**
 * PG-backed fleet leader lease store (P-302 LIVE-2 seam 1).
 *
 * The election service treats the lease as a liveness/anti-flap hint, not an
 * authorization grant. The table is still peer-log federated so every machine in
 * the Hive reads the same incumbent before running the deterministic election.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { FleetLeaderLeaseStore } from './fleet-leader-election-service';
import type { FleetLeaderLease } from './fleet-leader-election';
import type { ScopeId } from '../sync/pot-git/scope-repo';
import { resolveP2pGrantWorkspace } from './grant-store';

export interface PgFleetLeaderLeaseStoreDeps {
  /** The caller's identity workspace (run through resolveP2pGrantWorkspace, C3). */
  workspaceId: string | null | undefined;
  /** The hive HOME slug the lease row federates under. */
  potSlug: string;
  sqlOverride?: Sql;
}

interface FleetLeaderLeaseDbRow {
  device_pubkey: string;
  leader_github_user_id: string | number;
  since_ms: string | number;
  roster_epoch: string | number;
}

function rowToLease(row: FleetLeaderLeaseDbRow): FleetLeaderLease {
  return {
    devicePubkey: row.device_pubkey,
    githubUserId: Number(row.leader_github_user_id),
    sinceMs: Number(row.since_ms),
    rosterEpoch: Number(row.roster_epoch),
  };
}

function assertFleetScope(scope: ScopeId): void {
  if (scope.kind !== 'fleet' || !Number.isSafeInteger(scope.ownerGithubUserId) || scope.ownerGithubUserId <= 0 || !scope.slug) {
    throw new Error(`PgFleetLeaderLeaseStore: invalid fleet scope ${JSON.stringify(scope)}`);
  }
}

export class PgFleetLeaderLeaseStore implements FleetLeaderLeaseStore {
  private readonly deps: PgFleetLeaderLeaseStoreDeps;

  constructor(deps: PgFleetLeaderLeaseStoreDeps) {
    this.deps = deps;
  }

  private workspaceId(): string {
    const ws = resolveP2pGrantWorkspace(this.deps.workspaceId);
    if (!ws) throw new Error('PgFleetLeaderLeaseStore: workspaceId required');
    return ws;
  }

  private potSlug(): string {
    if (!this.deps.potSlug) throw new Error('PgFleetLeaderLeaseStore: potSlug required');
    return this.deps.potSlug;
  }

  private sql(): Sql {
    return this.deps.sqlOverride ?? getOrgPg().sql;
  }

  async read(scope: ScopeId): Promise<FleetLeaderLease | null> {
    assertFleetScope(scope);
    const rows = (await this.sql()`
      SELECT device_pubkey, leader_github_user_id, since_ms, roster_epoch
        FROM harness_shared.p2p_fleet_leader_leases
       WHERE workspace_id = ${this.workspaceId()}
         AND harness_slug = ${this.potSlug()}
         AND owner_github_user_id = ${scope.ownerGithubUserId}
         AND fleet_slug = ${scope.slug}
       LIMIT 1
    `) as unknown as FleetLeaderLeaseDbRow[];
    return rows[0] ? rowToLease(rows[0]) : null;
  }

  async write(scope: ScopeId, lease: FleetLeaderLease | null): Promise<void> {
    assertFleetScope(scope);
    const workspaceId = this.workspaceId();
    const potSlug = this.potSlug();
    const sql = this.sql();
    if (lease == null) {
      await sql`
        DELETE FROM harness_shared.p2p_fleet_leader_leases
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${potSlug}
           AND owner_github_user_id = ${scope.ownerGithubUserId}
           AND fleet_slug = ${scope.slug}
      `;
      return;
    }

    const now = Date.now();
    await sql`
      INSERT INTO harness_shared.p2p_fleet_leader_leases
        (workspace_id, harness_slug, owner_github_user_id, fleet_slug,
         device_pubkey, leader_github_user_id, since_ms, roster_epoch,
         created_at, updated_at)
      VALUES
        (${workspaceId}, ${potSlug}, ${scope.ownerGithubUserId}, ${scope.slug},
         ${lease.devicePubkey}, ${lease.githubUserId}, ${lease.sinceMs}, ${lease.rosterEpoch},
         ${now}, ${now})
      ON CONFLICT (workspace_id, harness_slug, owner_github_user_id, fleet_slug) DO UPDATE SET
        device_pubkey          = EXCLUDED.device_pubkey,
        leader_github_user_id = EXCLUDED.leader_github_user_id,
        since_ms               = EXCLUDED.since_ms,
        roster_epoch           = EXCLUDED.roster_epoch,
        updated_at             = ${now}
    `;
  }
}
