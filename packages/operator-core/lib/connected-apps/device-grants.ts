/**
 * Device-code sign-in for apps on a LOCAL install (external-app-access-to-workspaces-2026-09-29
 * P-005, RFC 8628; migration 1248).
 *
 * An app that cannot be handed a key by hand asks the local server for a code, the user approves
 * that code on the machine, and the app's next poll receives a scoped app key. Nothing here talks
 * to the portal: the grant, the approval and the issued key are all local rows (D-004).
 *
 * Connection split (same as ./store.ts):
 *   - create / find / list / decide / poll run on the admin connection: the app polls before any
 *     workspace is known, and a pending grant has no workspace yet.
 *   - the final exchange runs inside the approved workspace's `withWorkspace` transaction: it
 *     INSERTs the key and marks the grant consumed together, so two concurrent polls can never
 *     both receive a key (the loser's UPDATE finds the grant already consumed and rolls its key
 *     back).
 */

import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import {
  AppKeyScopeError,
  insertAppKey,
  resolveAppKeyScopes,
  type AppKeyScopes,
  type CreatedAppKey,
} from './store';
import type { AppKeyScopeProblem } from './scope-policy';

export type DeviceGrantDecision = 'approved' | 'denied';

export interface PendingDeviceGrant {
  readonly userCode: string;
  readonly clientLabel: string;
  readonly requestedScopes: AppKeyScopes;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type DeviceGrantExchange =
  | { readonly status: 'pending' | 'slow_down' | 'denied' | 'expired' | 'invalid' }
  /** Approved, but the scopes it asked for are no longer grantable (the catalog changed). */
  | { readonly status: 'invalid_scope'; readonly problems: readonly AppKeyScopeProblem[] }
  | { readonly status: 'issued'; readonly issued: CreatedAppKey };

export interface DeviceGrantStore {
  /** False when the user code collided with a live grant; the caller draws another. */
  createGrant(input: {
    deviceCodeHash: string;
    userCode: string;
    clientLabel: string;
    requestedScopes: AppKeyScopes;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<boolean>;
  findPendingGrant(userCode: string, now: Date): Promise<PendingDeviceGrant | null>;
  listPendingGrants(now: Date): Promise<readonly PendingDeviceGrant[]>;
  /** False when no live pending grant has that code. `workspaceId` is required to approve. */
  decideGrant(input: {
    userCode: string;
    decision: DeviceGrantDecision;
    workspaceId: string | null;
    decidedBy: string;
    at: Date;
  }): Promise<boolean>;
  /** One poll. A pending grant records it (or answers slow_down); an approved one becomes a key. */
  exchangeGrant(input: { deviceCodeHash: string; now: Date; minPollIntervalMs: number }): Promise<DeviceGrantExchange>;
}

interface GrantRow {
  user_code: string;
  client_label: string;
  requested_scopes: AppKeyScopes;
  state: 'pending' | 'approved' | 'denied' | 'consumed';
  workspace_id: string | null;
  approved_by: string | null;
  created_at: Date;
  expires_at: Date;
}

const pending = (row: GrantRow): PendingDeviceGrant => ({
  userCode: row.user_code,
  clientLabel: row.client_label,
  requestedScopes: row.requested_scopes ?? {},
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

/** Thrown inside the exchange transaction when another poll consumed the grant first. */
class GrantAlreadyConsumed extends Error {}

export class PostgresDeviceGrantStore implements DeviceGrantStore {
  async createGrant(input: Parameters<DeviceGrantStore['createGrant']>[0]): Promise<boolean> {
    const { sql } = getOrgPg();
    // Expired grants have no further use; clearing them here bounds the table without a sweeper.
    await sql`DELETE FROM harness_shared.connected_app_device_grants WHERE expires_at < ${input.createdAt}`;
    const rows = await sql`
      INSERT INTO harness_shared.connected_app_device_grants
        (device_code_hash, user_code, client_label, requested_scopes, state, created_at, expires_at)
      VALUES (${input.deviceCodeHash}, ${input.userCode}, ${input.clientLabel},
              ${JSON.stringify(input.requestedScopes)}::jsonb, 'pending', ${input.createdAt}, ${input.expiresAt})
      ON CONFLICT DO NOTHING
      RETURNING 1`;
    return rows.length === 1;
  }

  async findPendingGrant(userCode: string, now: Date): Promise<PendingDeviceGrant | null> {
    const { sql } = getOrgPg();
    const rows = await sql<GrantRow[]>`
      SELECT user_code, client_label, requested_scopes, state, workspace_id, approved_by, created_at, expires_at
        FROM harness_shared.connected_app_device_grants
       WHERE user_code = ${userCode} AND state = 'pending' AND expires_at > ${now}
       LIMIT 1`;
    return rows[0] ? pending(rows[0]) : null;
  }

  async listPendingGrants(now: Date): Promise<readonly PendingDeviceGrant[]> {
    const { sql } = getOrgPg();
    const rows = await sql<GrantRow[]>`
      SELECT user_code, client_label, requested_scopes, state, workspace_id, approved_by, created_at, expires_at
        FROM harness_shared.connected_app_device_grants
       WHERE state = 'pending' AND expires_at > ${now}
       ORDER BY created_at DESC
       LIMIT 50`;
    return rows.map(pending);
  }

  async decideGrant(input: Parameters<DeviceGrantStore['decideGrant']>[0]): Promise<boolean> {
    if (input.decision === 'approved' && !input.workspaceId) return false;
    const { sql } = getOrgPg();
    const approved = input.decision === 'approved';
    const rows = await sql`
      UPDATE harness_shared.connected_app_device_grants
         SET state = ${input.decision},
             workspace_id = ${approved ? input.workspaceId : null},
             approved_by = ${input.decidedBy},
             decided_at = ${input.at}
       WHERE user_code = ${input.userCode} AND state = 'pending' AND expires_at > ${input.at}
      RETURNING 1`;
    return rows.length === 1;
  }

  async exchangeGrant(input: { deviceCodeHash: string; now: Date; minPollIntervalMs: number }): Promise<DeviceGrantExchange> {
    const { sql } = getOrgPg();
    const rows = await sql<GrantRow[]>`
      SELECT user_code, client_label, requested_scopes, state, workspace_id, approved_by, created_at, expires_at
        FROM harness_shared.connected_app_device_grants
       WHERE device_code_hash = ${input.deviceCodeHash}
       LIMIT 1`;
    const row = rows[0];
    if (!row || row.state === 'consumed') return { status: 'invalid' };
    if (row.expires_at.getTime() <= input.now.getTime()) return { status: 'expired' };
    if (row.state === 'denied') return { status: 'denied' };
    if (row.state === 'pending') {
      const since = new Date(input.now.getTime() - input.minPollIntervalMs);
      const polled = await sql`
        UPDATE harness_shared.connected_app_device_grants
           SET last_polled_at = ${input.now}
         WHERE device_code_hash = ${input.deviceCodeHash} AND state = 'pending'
           AND (last_polled_at IS NULL OR last_polled_at <= ${since})
        RETURNING 1`;
      return { status: polled.length === 1 ? 'pending' : 'slow_down' };
    }
    // approved: issue the key with exactly the scopes the app asked for, re-checked now.
    let scopes: AppKeyScopes;
    try {
      scopes = resolveAppKeyScopes(row.requested_scopes ?? {});
    } catch (err) {
      if (err instanceof AppKeyScopeError) return { status: 'invalid_scope', problems: err.problems };
      throw err;
    }
    const workspaceId = row.workspace_id!;
    try {
      const issued = await withWorkspace(workspaceId, async (tx) => {
        const created = await insertAppKey(tx, {
          workspaceId,
          userEmail: row.approved_by ?? 'local@desktop',
          label: row.client_label,
          scopes,
        });
        const consumed = await tx`
          UPDATE harness_shared.connected_app_device_grants
             SET state = 'consumed', app_id = ${created.app.id}
           WHERE device_code_hash = ${input.deviceCodeHash} AND state = 'approved'
          RETURNING 1`;
        if (consumed.length !== 1) throw new GrantAlreadyConsumed();
        return created;
      });
      return { status: 'issued', issued };
    } catch (err) {
      if (err instanceof GrantAlreadyConsumed) return { status: 'invalid' };
      throw err;
    }
  }
}
