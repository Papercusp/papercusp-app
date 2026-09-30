import { randomBytes } from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

export type AttackTenantKey = 'alpha' | 'beta';
export type AttackMembershipRole = 'member' | 'admin';
export type AttackMembershipStatus = 'active' | 'revoked';

export type AttackTenantFixture = {
  organizationId: string;
  userId: string;
  workspaceId: string;
  resources: readonly [{ id: string; displayName: string }, { id: string; displayName: string }];
};

export type AttackResourceRow = {
  organization_id: string;
  workspace_id: string;
  id: string;
  display_name: string;
};

export type AttackMembershipRow = {
  organization_id: string;
  user_id: string;
  role: AttackMembershipRole;
  status: AttackMembershipStatus;
};

export type RuntimeRoleFacts = {
  current_user: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolinherit: boolean;
  table_owner: string;
  row_security_forced: boolean;
};

export type PostgresErrorEvidence = {
  code: string | null;
  constraint: string | null;
};

export type AttackSql = Sql | TransactionSql;

/**
 * The deliberately overlapping fixture catches tests that accidentally use a
 * resource id, workspace id, or display name as the tenant boundary. Only the
 * organization + verified user membership may distinguish these rows.
 */
export const TWO_TENANT_ATTACK_FIXTURE: Readonly<Record<AttackTenantKey, AttackTenantFixture>> = {
  alpha: {
    organizationId: 'organization-alpha',
    userId: 'user-alpha',
    workspaceId: 'workspace-overlap',
    resources: [
      { id: 'resource-overlap', displayName: 'Overlapping resource' },
      { id: 'resource-alpha-only', displayName: 'Tenant-only resource' },
    ],
  },
  beta: {
    organizationId: 'organization-beta',
    userId: 'user-beta',
    workspaceId: 'workspace-overlap',
    resources: [
      { id: 'resource-overlap', displayName: 'Overlapping resource' },
      { id: 'resource-beta-only', displayName: 'Tenant-only resource' },
    ],
  },
};

export type TwoTenantAttackHarness = {
  readonly fixture: typeof TWO_TENANT_ATTACK_FIXTURE;
  readonly runtimeRole: string;
  readonly tableOwnerRole: string;
  reset(): Promise<void>;
  close(): Promise<void>;
  asTenant<T>(tenant: AttackTenantKey, run: (tx: AttackSql, fixture: AttackTenantFixture) => Promise<T>): Promise<T>;
  asTableOwner<T>(run: (tx: AttackSql) => Promise<T>): Promise<T>;
  withoutTenantContext<T>(run: (tx: AttackSql) => Promise<T>): Promise<T>;
  listResources(tx: AttackSql): Promise<AttackResourceRow[]>;
  findResourcesById(tx: AttackSql, id: string): Promise<AttackResourceRow[]>;
  readMembership(tx: AttackSql): Promise<AttackMembershipRow | null>;
  setMembership(
    tenant: AttackTenantKey,
    patch: { role?: AttackMembershipRole; status?: AttackMembershipStatus },
  ): Promise<void>;
  insertLink(
    tx: AttackSql,
    row: {
      organizationId: string;
      workspaceId: string;
      id: string;
      resourceId: string;
    },
  ): Promise<void>;
  runtimeRoleFacts(): Promise<RuntimeRoleFacts>;
  attemptTableOwnerRole(tx: AttackSql): Promise<void>;
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function roleScopedUrl(url: string, role: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

export async function capturePostgresError(operation: Promise<unknown>): Promise<PostgresErrorEvidence> {
  try {
    await operation;
  } catch (error) {
    const pgError = error as { code?: unknown; constraint_name?: unknown };
    return {
      code: typeof pgError.code === 'string' ? pgError.code : null,
      constraint: typeof pgError.constraint_name === 'string' ? pgError.constraint_name : null,
    };
  }
  throw new Error('expected the Postgres operation to fail');
}

export async function createTwoTenantAttackHarness(): Promise<TwoTenantAttackHarness> {
  const suffix = randomBytes(6).toString('hex');
  const schema = `tenant_attack_${suffix}`;
  const tableOwnerRole = `tenant_attack_owner_${suffix}`;
  const runtimeRole = `tenant_attack_app_${suffix}`;
  const runtimePassword = randomBytes(24).toString('base64url');
  const schemaSql = quoteIdentifier(schema);
  const ownerSql = quoteIdentifier(tableOwnerRole);
  const runtimeSql = quoteIdentifier(runtimeRole);
  const membershipsSql = `${schemaSql}.memberships`;
  const resourcesSql = `${schemaSql}.resources`;
  const linksSql = `${schemaSql}.resource_links`;

  const db: MigratedTestDb = await createFreshTestDb({ prefix: 'tenantattack' });
  const admin = postgres(db.url, { max: 4, onnotice: () => {} });

  await admin.unsafe(`
    CREATE ROLE ${ownerSql} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    CREATE ROLE ${runtimeSql}
      LOGIN PASSWORD ${quoteLiteral(runtimePassword)}
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    CREATE SCHEMA ${schemaSql} AUTHORIZATION ${ownerSql};

    SET ROLE ${ownerSql};
    CREATE TABLE ${membershipsSql} (
      organization_id text NOT NULL,
      user_id text NOT NULL,
      role text NOT NULL CHECK (role IN ('member', 'admin')),
      status text NOT NULL CHECK (status IN ('active', 'revoked')),
      PRIMARY KEY (organization_id, user_id)
    );
    CREATE TABLE ${resourcesSql} (
      organization_id text NOT NULL,
      workspace_id text NOT NULL,
      id text NOT NULL,
      display_name text NOT NULL,
      PRIMARY KEY (organization_id, workspace_id, id)
    );
    CREATE TABLE ${linksSql} (
      organization_id text NOT NULL,
      workspace_id text NOT NULL,
      id text NOT NULL,
      resource_id text NOT NULL,
      PRIMARY KEY (organization_id, workspace_id, id),
      CONSTRAINT attack_links_resource_fk
        FOREIGN KEY (organization_id, workspace_id, resource_id)
        REFERENCES ${resourcesSql} (organization_id, workspace_id, id)
    );

    ALTER TABLE ${membershipsSql} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${membershipsSql} FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${resourcesSql} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${resourcesSql} FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${linksSql} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${linksSql} FORCE ROW LEVEL SECURITY;

    CREATE POLICY memberships_tenant_select ON ${membershipsSql}
      FOR SELECT TO ${runtimeSql}
      USING (
        organization_id = nullif(current_setting('app.organization_id', true), '')
        AND user_id = nullif(current_setting('app.user_id', true), '')
      );
    CREATE POLICY resources_tenant_select ON ${resourcesSql}
      FOR SELECT TO ${runtimeSql}
      USING (
        organization_id = nullif(current_setting('app.organization_id', true), '')
        AND workspace_id = nullif(current_setting('app.workspace_id', true), '')
        AND EXISTS (
          SELECT 1
            FROM ${membershipsSql} AS membership
           WHERE membership.organization_id = ${resourcesSql}.organization_id
             AND membership.user_id = nullif(current_setting('app.user_id', true), '')
             AND membership.status = 'active'
        )
      );
    CREATE POLICY links_tenant_all ON ${linksSql}
      FOR ALL TO ${runtimeSql}
      USING (
        organization_id = nullif(current_setting('app.organization_id', true), '')
        AND workspace_id = nullif(current_setting('app.workspace_id', true), '')
        AND EXISTS (
          SELECT 1
            FROM ${membershipsSql} AS membership
           WHERE membership.organization_id = ${linksSql}.organization_id
             AND membership.user_id = nullif(current_setting('app.user_id', true), '')
             AND membership.status = 'active'
        )
      )
      WITH CHECK (
        organization_id = nullif(current_setting('app.organization_id', true), '')
        AND workspace_id = nullif(current_setting('app.workspace_id', true), '')
        AND EXISTS (
          SELECT 1
            FROM ${membershipsSql} AS membership
           WHERE membership.organization_id = ${linksSql}.organization_id
             AND membership.user_id = nullif(current_setting('app.user_id', true), '')
             AND membership.status = 'active'
        )
      );
    RESET ROLE;

    GRANT USAGE ON SCHEMA ${schemaSql} TO ${runtimeSql};
    GRANT SELECT ON ${membershipsSql}, ${resourcesSql}, ${linksSql} TO ${runtimeSql};
    GRANT INSERT ON ${linksSql} TO ${runtimeSql};
  `);

  const app = postgres(roleScopedUrl(db.url, runtimeRole, runtimePassword), {
    max: 4,
    onnotice: () => {},
  });
  let closed = false;

  const reset = async (): Promise<void> => {
    await admin.begin(async (tx) => {
      await tx.unsafe(`TRUNCATE ${linksSql}, ${resourcesSql}, ${membershipsSql}`);
      for (const tenant of Object.values(TWO_TENANT_ATTACK_FIXTURE)) {
        await tx.unsafe(
          `INSERT INTO ${membershipsSql} (organization_id, user_id, role, status)
           VALUES ($1, $2, 'member', 'active')`,
          [tenant.organizationId, tenant.userId],
        );
        for (const resource of tenant.resources) {
          await tx.unsafe(
            `INSERT INTO ${resourcesSql}
               (organization_id, workspace_id, id, display_name)
             VALUES ($1, $2, $3, $4)`,
            [tenant.organizationId, tenant.workspaceId, resource.id, resource.displayName],
          );
        }
      }
    });
  };

  const listResources = (tx: AttackSql): Promise<AttackResourceRow[]> =>
    tx.unsafe(
      `SELECT organization_id, workspace_id, id, display_name
         FROM ${resourcesSql}
        ORDER BY id`,
    ) as Promise<AttackResourceRow[]>;

  await reset();

  return {
    fixture: TWO_TENANT_ATTACK_FIXTURE,
    runtimeRole,
    tableOwnerRole,
    reset,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await app.end({ timeout: 5 }).catch(() => {});
      try {
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
        await admin.unsafe(`DROP OWNED BY ${runtimeSql}`);
        await admin.unsafe(`DROP ROLE IF EXISTS ${runtimeSql}`);
        await admin.unsafe(`DROP OWNED BY ${ownerSql}`);
        await admin.unsafe(`DROP ROLE IF EXISTS ${ownerSql}`);
      } finally {
        await admin.end({ timeout: 5 }).catch(() => {});
        await db.drop().catch(() => {});
      }
    },
    async asTenant<T>(
      tenantKey: AttackTenantKey,
      run: (tx: AttackSql, fixture: AttackTenantFixture) => Promise<T>,
    ): Promise<T> {
      const tenant = TWO_TENANT_ATTACK_FIXTURE[tenantKey];
      return (await app.begin(async (tx) => {
        await tx.unsafe(
          `SELECT
             set_config('app.user_id', $1, true),
             set_config('app.organization_id', $2, true),
             set_config('app.workspace_id', $3, true)`,
          [tenant.userId, tenant.organizationId, tenant.workspaceId],
        );
        return run(tx, tenant);
      })) as T;
    },
    async asTableOwner<T>(run: (tx: AttackSql) => Promise<T>): Promise<T> {
      return (await admin.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${ownerSql}`);
        return run(tx);
      })) as T;
    },
    async withoutTenantContext<T>(run: (tx: AttackSql) => Promise<T>): Promise<T> {
      return (await app.begin(run)) as T;
    },
    listResources,
    findResourcesById(tx: AttackSql, id: string): Promise<AttackResourceRow[]> {
      return tx.unsafe(
        `SELECT organization_id, workspace_id, id, display_name
           FROM ${resourcesSql}
          WHERE id = $1
          ORDER BY organization_id`,
        [id],
      ) as Promise<AttackResourceRow[]>;
    },
    async readMembership(tx: AttackSql): Promise<AttackMembershipRow | null> {
      const rows = (await tx.unsafe(
        `SELECT organization_id, user_id, role, status
           FROM ${membershipsSql}`,
      )) as AttackMembershipRow[];
      return rows[0] ?? null;
    },
    async setMembership(tenantKey, patch): Promise<void> {
      const tenant = TWO_TENANT_ATTACK_FIXTURE[tenantKey];
      await admin.unsafe(
        `UPDATE ${membershipsSql}
            SET role = COALESCE($3, role),
                status = COALESCE($4, status)
          WHERE organization_id = $1 AND user_id = $2`,
        [tenant.organizationId, tenant.userId, patch.role ?? null, patch.status ?? null],
      );
    },
    async insertLink(tx, row): Promise<void> {
      await tx.unsafe(
        `INSERT INTO ${linksSql}
           (organization_id, workspace_id, id, resource_id)
         VALUES ($1, $2, $3, $4)`,
        [row.organizationId, row.workspaceId, row.id, row.resourceId],
      );
    },
    async runtimeRoleFacts(): Promise<RuntimeRoleFacts> {
      const rows = (await app.unsafe(
        `SELECT
           current_user,
           role.rolsuper,
           role.rolbypassrls,
           role.rolinherit,
           tables.tableowner AS table_owner,
           classes.relforcerowsecurity AS row_security_forced
         FROM pg_roles AS role
         JOIN pg_tables AS tables
           ON tables.schemaname = $1 AND tables.tablename = 'resources'
         JOIN pg_class AS classes
           ON classes.oid = to_regclass($2)
        WHERE role.rolname = current_user`,
        [schema, `${schema}.resources`],
      )) as RuntimeRoleFacts[];
      if (!rows[0]) throw new Error('runtime role facts were not visible');
      return rows[0];
    },
    async attemptTableOwnerRole(tx: AttackSql): Promise<void> {
      await tx.unsafe(`SET ROLE ${ownerSql}`);
    },
  };
}
