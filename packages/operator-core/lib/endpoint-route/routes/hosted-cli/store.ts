/**
 * Postgres store for psu CLI sign-in (WI-10002874, byoc D-412).
 *
 * Grants and tokens are hosted_service rows (migration 1209). The org's workspace list is a
 * control-plane read of `harness_shared.customer_workspaces`, the same privilege and query shape
 * `first-workspace-dependencies.ts` uses: the organization is always the one the verified token
 * carries, never a request field.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { HostedServiceContextRunner } from '../../../auth/hosted/workos-lifecycle-postgres';

export type HostedCliGrantDecision = 'approved' | 'denied';

/**
 * What a device grant is for (migration 1268, EAA D-031): `cli` is psu sign-in and is exchanged
 * for a CLI token; `relay-link` links a local install to the portal relay and is exchanged for a
 * connector enrollment. Each exchange refuses the other purpose's grants.
 */
export type HostedDeviceGrantPurpose = 'cli' | 'relay-link';

export interface HostedCliPendingGrant {
  readonly userCode: string;
  readonly clientLabel: string;
  readonly expiresAt: Date;
  readonly purpose: HostedDeviceGrantPurpose;
  /** relay-link only: the install id the linking machine generated for itself. */
  readonly installId: string | null;
}

export type HostedRelayLinkExchangeResult =
  | { readonly status: 'pending' | 'slow_down' | 'denied' | 'expired' | 'invalid' }
  | {
      readonly status: 'approved';
      readonly userId: string;
      readonly organizationId: string;
      readonly installId: string;
      readonly clientLabel: string;
    };

/** A relay-linked install as the portal knows it: a customer workspace of kind 'linked'. */
export interface HostedLinkedWorkspace {
  readonly customerWorkspaceId: string;
  readonly hostId: string;
  readonly routeLabel: string;
}

export interface HostedCliToken {
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly clientLabel: string;
  readonly expiresAt: Date;
}

export type HostedCliExchangeResult =
  | { readonly status: 'pending' | 'slow_down' | 'denied' | 'expired' | 'invalid' }
  | { readonly status: 'issued'; readonly token: HostedCliToken };

export interface HostedCliWorkspace {
  readonly id: string;
  readonly displayName: string;
  readonly state: string;
  readonly hostId: string | null;
  readonly connector: {
    readonly state: 'pending' | 'active' | 'revoked';
    readonly routeLabel: string;
    readonly transport: 'sse' | 'websocket';
    readonly generation: number;
    readonly heartbeatAt: Date | null;
  } | null;
}

export interface HostedCliStore {
  createGrant(input: {
    deviceCodeHash: string;
    userCode: string;
    clientLabel: string;
    createdAt: Date;
    expiresAt: Date;
    /** Defaults to 'cli'. A 'relay-link' grant requires `installId`. */
    purpose?: HostedDeviceGrantPurpose;
    installId?: string;
  }): Promise<boolean>;
  findPendingGrant(userCode: string, now: Date): Promise<HostedCliPendingGrant | null>;
  decideGrant(input: {
    userCode: string;
    decision: HostedCliGrantDecision;
    userId: string;
    organizationId: string;
    at: Date;
  }): Promise<boolean>;
  /** One transaction: a pending grant records the poll; an approved one is consumed into `token`. */
  exchangeGrant(input: {
    deviceCodeHash: string;
    now: Date;
    minPollIntervalMs: number;
    token: { id: string; tokenHash: string; expiresAt: Date };
  }): Promise<HostedCliExchangeResult>;
  /**
   * One transaction, relay-link grants only: a pending grant records the poll; an approved one is
   * consumed and its approver returned. Never issues a CLI token.
   */
  exchangeRelayLinkGrant(input: {
    deviceCodeHash: string;
    now: Date;
    minPollIntervalMs: number;
  }): Promise<HostedRelayLinkExchangeResult>;
  /**
   * Create, or bring back, the linked customer workspace for (organization, install). The id is
   * derived from both, so a re-link by the same install into the same organization reuses it.
   */
  upsertLinkedWorkspace(input: {
    organizationId: string;
    installId: string;
    displayName: string;
    userId: string;
    at: Date;
  }): Promise<HostedLinkedWorkspace>;
  /** Mark a linked workspace deleted (idempotent). Returns false for an unknown or hosted workspace. */
  unlinkLinkedWorkspace(input: { organizationId: string; customerWorkspaceId: string; at: Date }): Promise<boolean>;
  resolveToken(tokenHash: string, now: Date): Promise<HostedCliToken | null>;
  revokeToken(tokenId: string, reason: string, at: Date): Promise<boolean>;
  /** The organization's Papercusp-hosted workspaces. Linked installs serve no terminal and are not listed. */
  listWorkspaces(organizationId: string): Promise<readonly HostedCliWorkspace[]>;
  /** The organization's display name, so a CLI holding several sign-ins can label each; null when unknown. */
  organizationName(organizationId: string): Promise<string | null>;
}

export type HostedControlPlaneWorkspaceRunner = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

interface GrantRow {
  state: 'pending' | 'approved' | 'denied' | 'consumed';
  user_id: string | null;
  organization_id: string | null;
  client_label: string;
  expires_at: Date | string;
  last_polled_at: Date | string | null;
}

interface TokenRow {
  id: string;
  user_id: string;
  organization_id: string;
  client_label: string;
  expires_at: Date | string;
}

const date = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** A relay install id: what the machine generated for itself (migration 1268 CHECK). */
export const RELAY_INSTALL_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;

/**
 * The portal identity of a relay-linked install (D-031). Derived from (organization, install)
 * so a re-link lands on the same row, and two organizations linking one machine never collide.
 * The workspace id doubles as the connector's route label (lower-case, DNS-label safe), and the
 * host id is synthetic: a linked install has no workspace_hosts row.
 */
export function linkedWorkspaceIdentity(organizationId: string, installId: string): {
  customerWorkspaceId: string;
  hostId: string;
  routeLabel: string;
} {
  const digest = createHash('sha256').update(`${organizationId}\u0000${installId}`, 'utf8').digest('hex').slice(0, 24);
  const customerWorkspaceId = `lw-${digest}`;
  return { customerWorkspaceId, hostId: `linked-${customerWorkspaceId}`, routeLabel: customerWorkspaceId };
}

function tokenFromRow(row: TokenRow): HostedCliToken {
  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    clientLabel: row.client_label,
    expiresAt: date(row.expires_at),
  };
}

export class PostgresHostedCliStore implements HostedCliStore {
  constructor(
    private readonly runService: HostedServiceContextRunner,
    private readonly runControlPlane: HostedControlPlaneWorkspaceRunner,
    private readonly controlPlaneWorkspaceId: string,
  ) {}

  createGrant(input: Parameters<HostedCliStore['createGrant']>[0]): Promise<boolean> {
    return this.runService(async (s) => {
      // Expired grants have no further use; clearing them here bounds the table without a sweeper.
      await s`DELETE FROM papercusp_auth.hosted_cli_device_grants WHERE expires_at < ${input.createdAt}`;
      const rows = await s`
        INSERT INTO papercusp_auth.hosted_cli_device_grants
          (device_code_hash, user_code, control_workspace_id, client_label, state, created_at, expires_at,
           purpose, install_id)
        VALUES (${input.deviceCodeHash}, ${input.userCode}, ${this.controlPlaneWorkspaceId},
                ${input.clientLabel}, 'pending', ${input.createdAt}, ${input.expiresAt},
                ${input.purpose ?? 'cli'}, ${input.purpose === 'relay-link' ? (input.installId ?? null) : null})
        ON CONFLICT DO NOTHING
        RETURNING 1`;
      return rows.length === 1;
    });
  }

  findPendingGrant(userCode: string, now: Date): Promise<HostedCliPendingGrant | null> {
    return this.runService(async (sql) => {
      const rows = await sql<{
        user_code: string; client_label: string; expires_at: Date | string;
        purpose: HostedDeviceGrantPurpose; install_id: string | null;
      }[]>`
        SELECT user_code, client_label, expires_at, purpose, install_id
          FROM papercusp_auth.hosted_cli_device_grants
         WHERE user_code = ${userCode}
           AND control_workspace_id = ${this.controlPlaneWorkspaceId}
           AND state = 'pending'
           AND expires_at > ${now}`;
      const row = rows[0];
      return row
        ? {
            userCode: row.user_code,
            clientLabel: row.client_label,
            expiresAt: date(row.expires_at),
            purpose: row.purpose,
            installId: row.install_id,
          }
        : null;
    });
  }

  decideGrant(input: Parameters<HostedCliStore['decideGrant']>[0]): Promise<boolean> {
    return this.runService(async (sql) => {
      const approved = input.decision === 'approved';
      const rows = await sql`
        UPDATE papercusp_auth.hosted_cli_device_grants
           SET state = ${input.decision},
               decided_at = ${input.at},
               user_id = ${approved ? input.userId : null},
               organization_id = ${approved ? input.organizationId : null}
         WHERE user_code = ${input.userCode}
           AND control_workspace_id = ${this.controlPlaneWorkspaceId}
           AND state = 'pending'
           AND expires_at > ${input.at}
        RETURNING 1`;
      return rows.length === 1;
    });
  }

  exchangeGrant(input: Parameters<HostedCliStore['exchangeGrant']>[0]): Promise<HostedCliExchangeResult> {
    return this.runService(async (s) => {
      const rows = await s<GrantRow[]>`
        SELECT state, user_id, organization_id, client_label, expires_at, last_polled_at
          FROM papercusp_auth.hosted_cli_device_grants
         WHERE device_code_hash = ${input.deviceCodeHash}
           AND control_workspace_id = ${this.controlPlaneWorkspaceId}
           AND purpose = 'cli'
         FOR UPDATE`;
      const grant = rows[0];
      // A relay-link grant is absent here on purpose: it must never become a CLI token.
      if (!grant || grant.state === 'consumed') return { status: 'invalid' };
      if (date(grant.expires_at) <= input.now) return { status: 'expired' };
      if (grant.state === 'denied') return { status: 'denied' };
      if (grant.state === 'pending') {
        const last = grant.last_polled_at ? date(grant.last_polled_at).getTime() : null;
        await s`
          UPDATE papercusp_auth.hosted_cli_device_grants SET last_polled_at = ${input.now}
           WHERE device_code_hash = ${input.deviceCodeHash}`;
        return {
          status: last !== null && input.now.getTime() - last < input.minPollIntervalMs ? 'slow_down' : 'pending',
        };
      }
      await s`
        UPDATE papercusp_auth.hosted_cli_device_grants SET state = 'consumed', last_polled_at = ${input.now}
         WHERE device_code_hash = ${input.deviceCodeHash}`;
      const inserted = await s<TokenRow[]>`
        INSERT INTO papercusp_auth.hosted_cli_tokens
          (id, token_hash, control_workspace_id, user_id, organization_id, client_label, created_at, expires_at)
        VALUES (${input.token.id}, ${input.token.tokenHash}, ${this.controlPlaneWorkspaceId},
                ${grant.user_id}, ${grant.organization_id}, ${grant.client_label}, ${input.now}, ${input.token.expiresAt})
        RETURNING id, user_id, organization_id, client_label, expires_at`;
      return { status: 'issued', token: tokenFromRow(inserted[0]) };
    });
  }

  exchangeRelayLinkGrant(input: Parameters<HostedCliStore['exchangeRelayLinkGrant']>[0]): Promise<HostedRelayLinkExchangeResult> {
    return this.runService(async (s) => {
      const rows = await s<(GrantRow & { install_id: string | null })[]>`
        SELECT state, user_id, organization_id, client_label, expires_at, last_polled_at, install_id
          FROM papercusp_auth.hosted_cli_device_grants
         WHERE device_code_hash = ${input.deviceCodeHash}
           AND control_workspace_id = ${this.controlPlaneWorkspaceId}
           AND purpose = 'relay-link'
         FOR UPDATE`;
      const grant = rows[0];
      if (!grant || grant.state === 'consumed') return { status: 'invalid' };
      if (date(grant.expires_at) <= input.now) return { status: 'expired' };
      if (grant.state === 'denied') return { status: 'denied' };
      if (grant.state === 'pending') {
        const last = grant.last_polled_at ? date(grant.last_polled_at).getTime() : null;
        await s`
          UPDATE papercusp_auth.hosted_cli_device_grants SET last_polled_at = ${input.now}
           WHERE device_code_hash = ${input.deviceCodeHash}`;
        return {
          status: last !== null && input.now.getTime() - last < input.minPollIntervalMs ? 'slow_down' : 'pending',
        };
      }
      if (!grant.user_id || !grant.organization_id || !grant.install_id) return { status: 'invalid' };
      await s`
        UPDATE papercusp_auth.hosted_cli_device_grants SET state = 'consumed', last_polled_at = ${input.now}
         WHERE device_code_hash = ${input.deviceCodeHash}`;
      return {
        status: 'approved',
        userId: grant.user_id,
        organizationId: grant.organization_id,
        installId: grant.install_id,
        clientLabel: grant.client_label,
      };
    });
  }

  upsertLinkedWorkspace(input: Parameters<HostedCliStore['upsertLinkedWorkspace']>[0]): Promise<HostedLinkedWorkspace> {
    const linked = linkedWorkspaceIdentity(input.organizationId, input.installId);
    return this.runControlPlane(async (sql) => {
      // A deleted row (an earlier unlink) still holds the identity, so re-linking revives it.
      const rows = await sql<{ id: string; workspace_host_id: string; kind: string }[]>`
        INSERT INTO harness_shared.customer_workspaces (
          workspace_id, id, organization_id, workspace_host_id, display_name, state,
          created_by_principal_kind, created_by_principal_id, kind, linked_install_id
        ) VALUES (
          ${this.controlPlaneWorkspaceId}, ${linked.customerWorkspaceId}, ${input.organizationId},
          ${linked.hostId}, ${input.displayName}, 'active', 'user', ${input.userId}, 'linked', ${input.installId}
        )
        ON CONFLICT (workspace_id, id) DO UPDATE
          SET state = 'active', deleted_at = NULL, display_name = EXCLUDED.display_name, updated_at = ${input.at}
          WHERE harness_shared.customer_workspaces.kind = 'linked'
            AND harness_shared.customer_workspaces.organization_id = EXCLUDED.organization_id
        RETURNING id, workspace_host_id, kind`;
      const row = rows[0];
      if (!row || row.kind !== 'linked') throw new Error('linked_workspace_identity_conflict');
      return { customerWorkspaceId: row.id, hostId: row.workspace_host_id, routeLabel: linked.routeLabel };
    });
  }

  unlinkLinkedWorkspace(input: Parameters<HostedCliStore['unlinkLinkedWorkspace']>[0]): Promise<boolean> {
    return this.runControlPlane(async (sql) => {
      // Idempotent for a linked row: a retry after a failed connector revoke still answers true,
      // so the caller revokes again instead of leaving a live connector on a deleted workspace.
      const rows = await sql`
        UPDATE harness_shared.customer_workspaces
           SET state = 'deleted', deleted_at = COALESCE(deleted_at, ${input.at}), updated_at = ${input.at}
         WHERE workspace_id = ${this.controlPlaneWorkspaceId}
           AND organization_id = ${input.organizationId}
           AND id = ${input.customerWorkspaceId}
           AND kind = 'linked'
        RETURNING 1`;
      return rows.length === 1;
    });
  }

  resolveToken(tokenHash: string, now: Date): Promise<HostedCliToken | null> {
    return this.runService(async (sql) => {
      const rows = await sql<TokenRow[]>`
        UPDATE papercusp_auth.hosted_cli_tokens SET last_used_at = ${now}
         WHERE token_hash = ${tokenHash}
           AND control_workspace_id = ${this.controlPlaneWorkspaceId}
           AND revoked_at IS NULL
           AND expires_at > ${now}
        RETURNING id, user_id, organization_id, client_label, expires_at`;
      return rows[0] ? tokenFromRow(rows[0]) : null;
    });
  }

  revokeToken(tokenId: string, reason: string, at: Date): Promise<boolean> {
    return this.runService(async (sql) => {
      const rows = await sql`
        UPDATE papercusp_auth.hosted_cli_tokens SET revoked_at = ${at}, revocation_reason = ${reason}
         WHERE id = ${tokenId} AND revoked_at IS NULL
        RETURNING 1`;
      return rows.length === 1;
    });
  }

  organizationName(organizationId: string): Promise<string | null> {
    return this.runService(async (sql) => {
      const rows = await sql<{ display_name: string }[]>`
        SELECT display_name FROM papercusp_auth.organizations
         WHERE id::text = ${organizationId} AND deleted_at IS NULL`;
      const name = rows[0]?.display_name?.trim();
      return name ? name : null;
    });
  }

  async listWorkspaces(organizationId: string): Promise<readonly HostedCliWorkspace[]> {
    const workspaces = await this.runControlPlane((sql) => sql<{
      id: string; display_name: string; state: string; workspace_host_id: string | null;
    }[]>`
      SELECT id, display_name, state, workspace_host_id
        FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${this.controlPlaneWorkspaceId}
         AND organization_id = ${organizationId}
         AND state <> 'deleted'
         AND kind = 'hosted'
       ORDER BY created_at`);
    const connectors = await this.runService((sql) => sql<{
      customer_workspace_id: string; host_id: string; route_label: string; state: 'pending' | 'active' | 'revoked';
      transport: 'sse' | 'websocket'; generation: number | string; heartbeat_at: Date | string | null;
    }[]>`
      SELECT customer_workspace_id, host_id, route_label, state, transport, generation, heartbeat_at
        FROM papercusp_auth.hosted_workspace_connectors
       WHERE control_workspace_id = ${this.controlPlaneWorkspaceId}
         AND organization_id = ${organizationId}`);
    return workspaces.map((workspace) => {
      const connector = connectors.find(
        (row) => row.customer_workspace_id === workspace.id && row.host_id === workspace.workspace_host_id,
      );
      return {
        id: workspace.id,
        displayName: workspace.display_name,
        state: workspace.state,
        hostId: workspace.workspace_host_id,
        connector: connector
          ? {
              state: connector.state,
              routeLabel: connector.route_label,
              transport: connector.transport,
              generation: Number(connector.generation),
              heartbeatAt: connector.heartbeat_at ? date(connector.heartbeat_at) : null,
            }
          : null,
      };
    });
  }
}
