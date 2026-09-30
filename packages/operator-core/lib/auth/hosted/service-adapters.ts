/** Shared hosted-service/RLS adapters for hosted HTTP composition roots. */

import {
  HOSTED_SERVICE_ROLE,
  type VerifiedTenantServerContext,
} from '@papercusp/db-org/tenant-context';
import type { Sql } from 'postgres';
import {
  PostgresHostedIdentityDirectory,
  type HostedIdentityDirectory,
} from '../hosted-identity-binding';
import {
  PostgresHostedMembershipAuthority,
  type HostedMembershipAuthority,
  type HostedMembershipAuthorityReader,
} from '../hosted-membership-authority';
import {
  HostedSessionStore,
  type CreateHostedSessionInput,
  type HostedSession,
  type ResolveHostedSessionOptions,
} from '../hosted-session';
import type { HostedServiceContextRunner } from './workos-lifecycle-postgres';
import { PostgresWorkOSSealedSessionVault } from './workos-session-vault';

export type HostedTenantContextRunner = <T>(
  context: VerifiedTenantServerContext,
  fn: (sql: Sql) => Promise<T>,
) => Promise<T>;

interface HostedServiceRoleRow {
  readonly current_user: string;
}

export class HostedServiceSessionStore {
  constructor(private readonly run: HostedServiceContextRunner) {}

  create(input: CreateHostedSessionInput): Promise<HostedSession> {
    return this.run((sql) => new HostedSessionStore(sql as never).create(input));
  }

  resolve(id: string, options?: ResolveHostedSessionOptions): Promise<HostedSession | null> {
    return this.run((sql) => new HostedSessionStore(sql as never).resolve(id, options));
  }

  revoke(id: string, reason?: string, at?: Date): Promise<boolean> {
    return this.run((sql) => new HostedSessionStore(sql as never).revoke(id, reason, at));
  }
}

export class HostedServiceIdentityDirectory implements HostedIdentityDirectory {
  constructor(private readonly run: HostedServiceContextRunner) {}

  resolveLinkedUser(input: { providerId: string; subject: string }): Promise<{ userId: string } | null> {
    return this.run((sql) => new PostgresHostedIdentityDirectory(sql as never).resolveLinkedUser(input));
  }

  resolveOrganization(input: {
    providerId: string;
    externalOrganizationId: string;
  }): Promise<{ organizationId: string } | null> {
    return this.run((sql) => new PostgresHostedIdentityDirectory(sql as never).resolveOrganization(input));
  }

  listActiveOrganizationIds(input: { userId: string }): Promise<readonly string[]> {
    return this.run((sql) => new PostgresHostedIdentityDirectory(sql as never).listActiveOrganizationIds(input));
  }
}

export class HostedRuntimeMembershipAuthority implements HostedMembershipAuthorityReader {
  constructor(
    private readonly runService: HostedServiceContextRunner,
    private readonly runTenant: HostedTenantContextRunner,
  ) {}

  resolveActive(input: { userId: string; organizationId: string }): Promise<HostedMembershipAuthority | null> {
    return this.runService((sql) => new PostgresHostedMembershipAuthority(sql as never).resolveActive(input));
  }

  workspaceBelongsToOrganization(
    input: Parameters<HostedMembershipAuthorityReader['workspaceBelongsToOrganization']>[0],
  ): Promise<boolean> {
    const context: VerifiedTenantServerContext = {
      principal: {
        kind: 'user',
        profile: 'hosted',
        authMethod: 'cookie-session',
        trust: 'verified',
        slug: input.userId,
        workspaceId: input.controlPlaneWorkspaceId,
        userId: input.userId,
        activeOrganizationId: input.organizationId,
        selectedWorkspaceId: input.customerWorkspaceId,
        sessionId: input.sessionId,
        sessionVersion: input.sessionVersion,
      },
      selectedWorkspace: {
        id: input.customerWorkspaceId,
        organizationId: input.organizationId,
      },
    };
    return this.runTenant(context, (sql) =>
      new PostgresHostedMembershipAuthority(sql as never).workspaceBelongsToOrganization(input),
    );
  }
}

export function serviceWorkOSSessionVault(run: HostedServiceContextRunner) {
  return {
    get: (externalSessionId: string) =>
      run((sql) => new PostgresWorkOSSealedSessionVault(sql as never).get(externalSessionId)),
    put: (record: Parameters<PostgresWorkOSSealedSessionVault['put']>[0]) =>
      run((sql) => new PostgresWorkOSSealedSessionVault(sql as never).put(record)),
    delete: (externalSessionId: string) =>
      run((sql) => new PostgresWorkOSSealedSessionVault(sql as never).delete(externalSessionId)),
  };
}

/** Fail at boot unless the runner really entered the non-bypass hosted role. */
export async function assertHostedServicePosture(runService: HostedServiceContextRunner): Promise<void> {
  await runService(async (sql) => {
    const rows = await sql<HostedServiceRoleRow[]>`
      SELECT current_user::text AS current_user
    `;
    const currentUser = rows.length === 1 ? rows[0]?.current_user : undefined;
    if (currentUser !== HOSTED_SERVICE_ROLE) {
      throw new Error(`hosted_runtime_service_role_mismatch:${currentUser ?? 'missing'}`);
    }
  });
}
