import { getOrgPg } from '@papercusp/db-org/connection';
import type { WorkOSSealedSessionRecord, WorkOSSealedSessionVault } from './workos-provider';

type SqlClient = ReturnType<typeof getOrgPg>['sql'];

interface WorkOSSealedSessionRow {
  external_session_id: string;
  sealed_session: string;
  expires_at: Date | string;
}

function externalSessionId(value: string): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function sealedSession(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('sealedSession must be a non-empty string');
  }
  return value;
}

function expiresAt(value: number): Date {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('expiresAtMs must be a positive safe integer');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('expiresAtMs must be a valid timestamp');
  }
  return date;
}

function fromRow(row: WorkOSSealedSessionRow): WorkOSSealedSessionRecord {
  const id = externalSessionId(row.external_session_id);
  if (id === null || typeof row.sealed_session !== 'string' || row.sealed_session.length === 0) {
    throw new Error('WorkOS sealed-session vault returned an invalid record');
  }
  const expiry = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  const expiresAtMs = expiry.getTime();
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
    throw new Error('WorkOS sealed-session vault returned an invalid expiry');
  }
  return {
    externalSessionId: id,
    sealedSession: row.sealed_session,
    expiresAtMs,
  };
}

/**
 * PostgreSQL-backed store for WorkOS's provider-encrypted sealed session data.
 *
 * Expiry is returned to the provider unchanged: `WorkOSHostedIdentityProvider`
 * owns the fail-closed expiry check and deletes an expired row before reporting
 * `session_expired`. Keeping that policy in the provider makes every vault
 * implementation obey the same contract.
 */
export class PostgresWorkOSSealedSessionVault implements WorkOSSealedSessionVault {
  constructor(private readonly sql: SqlClient = getOrgPg().sql) {}

  async get(value: string): Promise<WorkOSSealedSessionRecord | null> {
    const id = externalSessionId(value);
    if (id === null) return null;
    const rows = await this.sql<WorkOSSealedSessionRow[]>`
      SELECT external_session_id, sealed_session, expires_at
        FROM papercusp_auth.workos_sealed_sessions
       WHERE external_session_id = ${id}
       LIMIT 1
    `;
    return rows.length === 0 ? null : fromRow(rows[0]);
  }

  async put(record: WorkOSSealedSessionRecord): Promise<void> {
    const id = externalSessionId(record.externalSessionId);
    if (id === null) {
      throw new TypeError('externalSessionId must be a non-empty string');
    }
    const payload = sealedSession(record.sealedSession);
    const expiry = expiresAt(record.expiresAtMs).toISOString();

    await this.sql`
      INSERT INTO papercusp_auth.workos_sealed_sessions
        (external_session_id, sealed_session, expires_at)
      VALUES (${id}, ${payload}, ${expiry})
      ON CONFLICT (external_session_id) DO UPDATE
        SET sealed_session = EXCLUDED.sealed_session,
            expires_at = EXCLUDED.expires_at,
            updated_at = now()
    `;
  }

  async delete(value: string): Promise<void> {
    const id = externalSessionId(value);
    if (id === null) return;
    await this.sql`
      DELETE FROM papercusp_auth.workos_sealed_sessions
       WHERE external_session_id = ${id}
    `;
  }
}

export function createPostgresWorkOSSealedSessionVault(
  sql: SqlClient = getOrgPg().sql,
): PostgresWorkOSSealedSessionVault {
  return new PostgresWorkOSSealedSessionVault(sql);
}
