/**
 * Persistence for this install's opt-in Papercusp relay (external-app-access P-008, D-031 #6):
 * the single `harness_shared.remote_access_portal_relay` row (migration 1268). The pending
 * device code and the connector bearer are secrets: they are encrypted with pgcrypto under the
 * operator's database key and decrypted only here, server-side.
 *
 * Admin connection (install-level config, not workspace data); `sql` is injectable for tests.
 * Shaped like own-tunnel/store.ts (P-009), the other route an install can use.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getDbEncryptionKey } from '../db-encryption';

export type PortalRelayState = 'off' | 'linking' | 'linked';

export interface PortalRelayRow {
  readonly installId: string;
  readonly portalOrigin: string;
  readonly state: PortalRelayState;
  readonly consentNoticeVersion: number | null;
  readonly consentedAt: Date | null;
  readonly consentedBy: string | null;
  readonly userCode: string | null;
  readonly verificationUri: string | null;
  readonly grantExpiresAt: Date | null;
  readonly pollIntervalSec: number | null;
  readonly organizationId: string | null;
  readonly customerWorkspaceId: string | null;
  readonly appBaseUrl: string | null;
  readonly connectorUrl: string | null;
  readonly operatorPort: number | null;
  readonly linkedAt: Date | null;
  readonly lastError: string | null;
  readonly lastErrorAt: Date | null;
  readonly updatedAt: Date;
}

export interface PortalRelaySecrets {
  readonly deviceCode: string | null;
  readonly connectorBearer: string | null;
}

export interface PortalRelayStoreOptions {
  readonly sql?: Sql;
  readonly encryptionKey?: string;
}

function ctx(opts: PortalRelayStoreOptions = {}) {
  return { sql: opts.sql ?? getOrgPg().sql, key: opts.encryptionKey ?? getDbEncryptionKey() };
}

export async function readPortalRelay(opts?: PortalRelayStoreOptions): Promise<PortalRelayRow | null> {
  const { sql } = ctx(opts);
  const rows = await sql<PortalRelayRow[]>`
    SELECT install_id AS "installId", portal_origin AS "portalOrigin", state,
           consent_notice_version AS "consentNoticeVersion", consented_at AS "consentedAt",
           consented_by AS "consentedBy", user_code AS "userCode", verification_uri AS "verificationUri",
           grant_expires_at AS "grantExpiresAt", poll_interval_sec AS "pollIntervalSec",
           organization_id AS "organizationId", customer_workspace_id AS "customerWorkspaceId",
           app_base_url AS "appBaseUrl", connector_url AS "connectorUrl", operator_port AS "operatorPort",
           linked_at AS "linkedAt", last_error AS "lastError", last_error_at AS "lastErrorAt",
           updated_at AS "updatedAt"
      FROM harness_shared.remote_access_portal_relay
     WHERE singleton`;
  return rows[0] ?? null;
}

export async function readPortalRelaySecrets(opts?: PortalRelayStoreOptions): Promise<PortalRelaySecrets> {
  const { sql, key } = ctx(opts);
  const rows = await sql<{ deviceCode: string | null; connectorBearer: string | null }[]>`
    SELECT CASE WHEN device_code_ct IS NULL THEN NULL ELSE pgp_sym_decrypt(device_code_ct, ${key}) END AS "deviceCode",
           CASE WHEN connector_bearer_ct IS NULL THEN NULL ELSE pgp_sym_decrypt(connector_bearer_ct, ${key}) END AS "connectorBearer"
      FROM harness_shared.remote_access_portal_relay
     WHERE singleton`;
  return rows[0] ?? { deviceCode: null, connectorBearer: null };
}

/**
 * Create the row on first use with this install's id. The portal can be changed only while the
 * relay is off, so a linked or linking install never silently points at a different portal.
 */
export async function ensurePortalRelayRow(
  input: { installId: string; portalOrigin: string },
  opts?: PortalRelayStoreOptions,
): Promise<void> {
  const { sql } = ctx(opts);
  await sql`
    INSERT INTO harness_shared.remote_access_portal_relay (singleton, install_id, portal_origin, state)
    VALUES (true, ${input.installId}, ${input.portalOrigin}, 'off')
    ON CONFLICT (singleton) DO UPDATE
      SET portal_origin = EXCLUDED.portal_origin, updated_at = now()
      WHERE harness_shared.remote_access_portal_relay.state = 'off'
        AND harness_shared.remote_access_portal_relay.portal_origin <> EXCLUDED.portal_origin`;
}

/** Record agreement to one version of the relay notice. The caller checks it is the current one. */
export async function recordPortalRelayConsent(
  input: { noticeVersion: number; by: string | null },
  opts?: PortalRelayStoreOptions,
): Promise<boolean> {
  const { sql } = ctx(opts);
  const rows = await sql`
    UPDATE harness_shared.remote_access_portal_relay
       SET consent_notice_version = ${input.noticeVersion}, consented_at = now(),
           consented_by = ${input.by}, updated_at = now()
     WHERE singleton
    RETURNING 1`;
  return rows.length > 0;
}

export interface SavePortalRelayLinking {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly deviceCode: string;
  readonly grantExpiresAt: Date;
  readonly pollIntervalSec: number;
}

/** Move to `linking` with the portal's pending grant. The CHECK requires consent to be recorded. */
export async function savePortalRelayLinking(t: SavePortalRelayLinking, opts?: PortalRelayStoreOptions): Promise<void> {
  const { sql, key } = ctx(opts);
  await sql`
    UPDATE harness_shared.remote_access_portal_relay
       SET state = 'linking', user_code = ${t.userCode}, verification_uri = ${t.verificationUri},
           device_code_ct = pgp_sym_encrypt(${t.deviceCode}, ${key}), grant_expires_at = ${t.grantExpiresAt},
           poll_interval_sec = ${t.pollIntervalSec},
           organization_id = NULL, customer_workspace_id = NULL, app_base_url = NULL, connector_url = NULL,
           connector_bearer_ct = NULL, linked_at = NULL, last_error = NULL, last_error_at = NULL, updated_at = now()
     WHERE singleton`;
}

export interface SavePortalRelayLinked {
  readonly organizationId: string;
  readonly customerWorkspaceId: string;
  readonly appBaseUrl: string;
  readonly connectorUrl: string;
  readonly connectorBearer: string;
  readonly operatorPort: number | null;
}

/** Move to `linked`: the pending grant is spent and the connector bearer is stored encrypted. */
export async function savePortalRelayLinked(t: SavePortalRelayLinked, opts?: PortalRelayStoreOptions): Promise<void> {
  const { sql, key } = ctx(opts);
  await sql`
    UPDATE harness_shared.remote_access_portal_relay
       SET state = 'linked', user_code = NULL, verification_uri = NULL, device_code_ct = NULL,
           grant_expires_at = NULL, poll_interval_sec = NULL,
           organization_id = ${t.organizationId}, customer_workspace_id = ${t.customerWorkspaceId},
           app_base_url = ${t.appBaseUrl}, connector_url = ${t.connectorUrl},
           connector_bearer_ct = pgp_sym_encrypt(${t.connectorBearer}, ${key}),
           operator_port = ${t.operatorPort}, linked_at = now(),
           last_error = NULL, last_error_at = NULL, updated_at = now()
     WHERE singleton`;
}

/**
 * Turn the relay off: drop the pending grant, the link and both secrets. Consent and the install
 * id stay, so connecting again needs no new agreement to the same notice. `error` explains why
 * the relay went off when it was not the user's choice (denied, expired, revoked).
 */
export async function setPortalRelayOff(error: string | null, opts?: PortalRelayStoreOptions): Promise<void> {
  const { sql } = ctx(opts);
  await sql`
    UPDATE harness_shared.remote_access_portal_relay
       SET state = 'off', user_code = NULL, verification_uri = NULL, device_code_ct = NULL,
           grant_expires_at = NULL, poll_interval_sec = NULL,
           organization_id = NULL, customer_workspace_id = NULL, app_base_url = NULL, connector_url = NULL,
           connector_bearer_ct = NULL, linked_at = NULL,
           last_error = ${error ? error.slice(0, 2000) : null}, last_error_at = ${error ? sql`now()` : null},
           updated_at = now()
     WHERE singleton`;
}

export async function recordPortalRelayError(message: string | null, opts?: PortalRelayStoreOptions): Promise<void> {
  const { sql } = ctx(opts);
  await sql`
    UPDATE harness_shared.remote_access_portal_relay
       SET last_error = ${message ? message.slice(0, 2000) : null},
           last_error_at = ${message ? sql`now()` : null}, updated_at = now()
     WHERE singleton`;
}

/** Move the connector to the operator on `port` (the desktop's port hint changed between launches). */
export async function setPortalRelayOperatorPort(port: number, opts?: PortalRelayStoreOptions): Promise<void> {
  const { sql } = ctx(opts);
  await sql`UPDATE harness_shared.remote_access_portal_relay SET operator_port = ${port}, updated_at = now() WHERE singleton`;
}
