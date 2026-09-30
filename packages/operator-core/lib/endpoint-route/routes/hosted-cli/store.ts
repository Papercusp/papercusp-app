/**
 * Postgres store for psu CLI sign-in (WI-10002874, byoc D-412).
 *
 * Grants and tokens are hosted_service rows (migration 1209). The org's workspace list is a
 * control-plane read of `harness_shared.customer_workspaces`, the same privilege and query shape
 * `first-workspace-dependencies.ts` uses: the organization is always the one the verified token
 * carries, never a request field.
 */
import type { Sql } from 'postgres';
import type { HostedServiceContextRunner } from '../../../auth/hosted/workos-lifecycle-postgres';

export type HostedCliGrantDecision = 'approved' | 'denied';

export interface HostedCliPendingGrant {
  readonly userCode: string;
  readonly clientLabel: string;
  readonly expiresAt: Date;
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
  resolveToken(tokenHash: string, now: Date): Promise<HostedCliToken | null>;
  revokeToken(tokenId: string, reason: string, at: Date): Promise<boolean>;
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
          (device_code_hash, user_code, control_workspace_id, client_label, state, created_at, expires_at)
        VALUES (${input.deviceCodeHash}, ${input.userCode}, ${this.controlPlaneWorkspaceId},
                ${input.clientLabel}, 'pending', ${input.createdAt}, ${input.expiresAt})
        ON CONFLICT DO NOTHING
        RETURNING 1`;
      return rows.length === 1;
    });
  }

  findPendingGrant(userCode: string, now: Date): Promise<HostedCliPendingGrant | null> {
    return this.runService(async (sql) => {
      const rows = await sql<{ user_code: string; client_label: string; expires_at: Date | string }[]>`
        SELECT user_code, client_label, expires_at
          FROM papercusp_auth.hosted_cli_device_grants
         WHERE user_code = ${userCode}
           AND control_workspace_id = ${this.controlPlaneWorkspaceId}
           AND state = 'pending'
           AND expires_at > ${now}`;
      const row = rows[0];
      return row ? { userCode: row.user_code, clientLabel: row.client_label, expiresAt: date(row.expires_at) } : null;
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
