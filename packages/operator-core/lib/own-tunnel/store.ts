/**
 * Persistence for the install's own tunnel (external-app-access P-009): the single
 * `harness_shared.remote_access_own_tunnel` row (migration 1262). Tokens are encrypted with
 * pgcrypto under the operator's database encryption key and decrypted only here, server-side.
 *
 * Admin connection (install-level config, not workspace data); `sql` is injectable for tests.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getDbEncryptionKey } from '../db-encryption';

export type OwnTunnelMode = 'cloudflare' | 'manual';

export interface OwnTunnelRow {
  readonly mode: OwnTunnelMode;
  readonly enabled: boolean;
  readonly ingressPort: number;
  readonly operatorPort: number | null;
  readonly hostname: string | null;
  readonly cfAccountId: string | null;
  readonly cfZoneId: string | null;
  readonly cfZoneName: string | null;
  readonly cfTunnelId: string | null;
  readonly cfTunnelName: string | null;
  readonly cfDnsRecordId: string | null;
  readonly lastError: string | null;
  readonly lastErrorAt: Date | null;
  readonly updatedAt: Date;
}

export interface OwnTunnelSecrets {
  readonly apiToken: string | null;
  readonly runToken: string | null;
}

export interface OwnTunnelStoreOptions {
  readonly sql?: Sql;
  readonly encryptionKey?: string;
}

function ctx(opts: OwnTunnelStoreOptions = {}) {
  return { sql: opts.sql ?? getOrgPg().sql, key: opts.encryptionKey ?? getDbEncryptionKey() };
}

export async function readOwnTunnel(opts?: OwnTunnelStoreOptions): Promise<OwnTunnelRow | null> {
  const { sql } = ctx(opts);
  const rows = await sql<OwnTunnelRow[]>`
    SELECT mode, enabled, ingress_port AS "ingressPort", operator_port AS "operatorPort", hostname,
           cf_account_id AS "cfAccountId", cf_zone_id AS "cfZoneId", cf_zone_name AS "cfZoneName",
           cf_tunnel_id AS "cfTunnelId", cf_tunnel_name AS "cfTunnelName", cf_dns_record_id AS "cfDnsRecordId",
           last_error AS "lastError", last_error_at AS "lastErrorAt", updated_at AS "updatedAt"
      FROM harness_shared.remote_access_own_tunnel
     WHERE singleton`;
  return rows[0] ?? null;
}

export async function readOwnTunnelSecrets(opts?: OwnTunnelStoreOptions): Promise<OwnTunnelSecrets> {
  const { sql, key } = ctx(opts);
  const rows = await sql<{ apiToken: string | null; runToken: string | null }[]>`
    SELECT CASE WHEN api_token_ct IS NULL THEN NULL ELSE pgp_sym_decrypt(api_token_ct, ${key}) END AS "apiToken",
           CASE WHEN run_token_ct IS NULL THEN NULL ELSE pgp_sym_decrypt(run_token_ct, ${key}) END AS "runToken"
      FROM harness_shared.remote_access_own_tunnel
     WHERE singleton`;
  return rows[0] ?? { apiToken: null, runToken: null };
}

export interface SaveCloudflareTunnel {
  readonly ingressPort: number;
  readonly operatorPort: number | null;
  readonly hostname: string;
  readonly accountId: string;
  readonly zoneId: string;
  readonly zoneName: string;
  readonly tunnelId: string;
  readonly tunnelName: string;
  readonly dnsRecordId: string;
  readonly apiToken: string;
  readonly runToken: string;
}

/** Record a provisioned Cloudflare tunnel (replaces any previous row), enabled. */
export async function saveCloudflareTunnel(t: SaveCloudflareTunnel, opts?: OwnTunnelStoreOptions): Promise<void> {
  const { sql, key } = ctx(opts);
  await sql`
    INSERT INTO harness_shared.remote_access_own_tunnel
      (singleton, mode, enabled, ingress_port, operator_port, hostname, cf_account_id, cf_zone_id, cf_zone_name,
       cf_tunnel_id, cf_tunnel_name, cf_dns_record_id, api_token_ct, run_token_ct, last_error, last_error_at, updated_at)
    VALUES (true, 'cloudflare', true, ${t.ingressPort}, ${t.operatorPort}, ${t.hostname}, ${t.accountId}, ${t.zoneId},
            ${t.zoneName}, ${t.tunnelId}, ${t.tunnelName}, ${t.dnsRecordId},
            pgp_sym_encrypt(${t.apiToken}, ${key}), pgp_sym_encrypt(${t.runToken}, ${key}), NULL, NULL, now())
    ON CONFLICT (singleton) DO UPDATE SET
      mode = EXCLUDED.mode, enabled = true, ingress_port = EXCLUDED.ingress_port, operator_port = EXCLUDED.operator_port,
      hostname = EXCLUDED.hostname, cf_account_id = EXCLUDED.cf_account_id, cf_zone_id = EXCLUDED.cf_zone_id,
      cf_zone_name = EXCLUDED.cf_zone_name, cf_tunnel_id = EXCLUDED.cf_tunnel_id, cf_tunnel_name = EXCLUDED.cf_tunnel_name,
      cf_dns_record_id = EXCLUDED.cf_dns_record_id, api_token_ct = EXCLUDED.api_token_ct, run_token_ct = EXCLUDED.run_token_ct,
      last_error = NULL, last_error_at = NULL, updated_at = now()`;
}

/** Record a manual tunnel: only the ingress listener is opened; the user runs their own tunnel. */
export async function saveManualTunnel(
  t: { ingressPort: number; operatorPort: number | null; hostname?: string | null },
  opts?: OwnTunnelStoreOptions,
): Promise<void> {
  const { sql } = ctx(opts);
  await sql`
    INSERT INTO harness_shared.remote_access_own_tunnel (singleton, mode, enabled, ingress_port, operator_port, hostname, updated_at)
    VALUES (true, 'manual', true, ${t.ingressPort}, ${t.operatorPort}, ${t.hostname ?? null}, now())
    ON CONFLICT (singleton) DO UPDATE SET
      mode = 'manual', enabled = true, ingress_port = EXCLUDED.ingress_port, operator_port = EXCLUDED.operator_port,
      hostname = EXCLUDED.hostname, cf_account_id = NULL, cf_zone_id = NULL, cf_zone_name = NULL, cf_tunnel_id = NULL,
      cf_tunnel_name = NULL, cf_dns_record_id = NULL, api_token_ct = NULL, run_token_ct = NULL,
      last_error = NULL, last_error_at = NULL, updated_at = now()`;
}

/** The kill switch: flips `enabled`; returns false when there is no tunnel row. */
export async function setOwnTunnelEnabled(enabled: boolean, opts?: OwnTunnelStoreOptions): Promise<boolean> {
  const { sql } = ctx(opts);
  const rows = await sql`UPDATE harness_shared.remote_access_own_tunnel SET enabled = ${enabled}, updated_at = now() WHERE singleton RETURNING 1`;
  return rows.length > 0;
}

/**
 * Move the tunnel to the operator on `port` (the desktop's port hint changed between launches).
 * Refuses silently when `port` is the ingress port, which the table's CHECK also forbids.
 */
export async function setOwnTunnelOperatorPort(port: number, opts?: OwnTunnelStoreOptions): Promise<void> {
  const { sql } = ctx(opts);
  await sql`
    UPDATE harness_shared.remote_access_own_tunnel
       SET operator_port = ${port}, updated_at = now()
     WHERE singleton AND ingress_port <> ${port}`;
}

export async function recordOwnTunnelError(message: string | null, opts?: OwnTunnelStoreOptions): Promise<void> {
  const { sql } = ctx(opts);
  await sql`
    UPDATE harness_shared.remote_access_own_tunnel
       SET last_error = ${message ? message.slice(0, 2000) : null},
           last_error_at = ${message ? sql`now()` : null}, updated_at = now()
     WHERE singleton`;
}

export async function deleteOwnTunnel(opts?: OwnTunnelStoreOptions): Promise<void> {
  const { sql } = ctx(opts);
  await sql`DELETE FROM harness_shared.remote_access_own_tunnel WHERE singleton`;
}
