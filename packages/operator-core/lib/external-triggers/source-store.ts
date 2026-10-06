/**
 * Canonical trigger-source ownership seam.
 *
 * `owner_user_id` is captured from the authenticated local connection flow.
 * Provider payload fields and `created_by` are deliberately absent from the
 * resolver API, so adapters cannot accidentally treat either as vault identity.
 */
import type postgres from 'postgres';

export interface ExternalTriggerSourceRow {
  id: string;
  workspaceId: string;
  kind: string;
  ownerUserId: string | null;
  providerAccountId: string | null;
  credentialRef: string | null;
  status: string;
  config: Record<string, unknown>;
  cursor: Record<string, unknown>;
}

export interface OwnedExternalTriggerSourceRow extends ExternalTriggerSourceRow {
  lastError: string | null;
  lastConnectedAt: string | null;
  updatedAt: string;
}

export interface DisconnectOwnedExternalTriggerSourcesResult {
  sources: number;
  credentialRefs: string[];
}

export interface CreateOwnedExternalTriggerSourceInput {
  workspaceId: string;
  kind: string;
  ownerUserId: string;
  providerAccountId?: string;
  credentialRef?: string | null;
  status?: string;
  config?: Record<string, unknown>;
  cursor?: Record<string, unknown>;
  createdBy?: string | null;
}

export interface ExternalTriggerSourceSyncState {
  status: 'connecting' | 'connected' | 'degraded' | 'error';
  cursor?: Record<string, unknown>;
  lastError: string | null;
  connected?: boolean;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`external_trigger_${field}_required`);
  return normalized;
}

function ownedProviderAccountId(input: CreateOwnedExternalTriggerSourceInput, credentialRef: string | null): string {
  return required(
    input.providerAccountId?.trim() || credentialRef || `legacy-owner:${input.ownerUserId}`,
    'provider_account_id',
  );
}

/** Provision a user-owned source from an authenticated local connection. */
export async function createOwnedExternalTriggerSource(
  sql: postgres.Sql,
  input: CreateOwnedExternalTriggerSourceInput,
): Promise<ExternalTriggerSourceRow> {
  const workspaceId = required(input.workspaceId, 'workspace_id');
  const kind = required(input.kind, 'source_kind');
  const ownerUserId = required(input.ownerUserId, 'owner_user_id');
  const credentialRef = input.credentialRef?.trim() || null;
  const providerAccountId = ownedProviderAccountId(input, credentialRef);
  const status = input.status?.trim() || 'unconfigured';
  const config = JSON.stringify(input.config ?? {});
  const cursor = JSON.stringify(input.cursor ?? {});
  const rows = await sql<ExternalTriggerSourceRow[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, credential_ref, status, config, cursor, created_by)
    VALUES (
      ${workspaceId}, ${kind}, ${ownerUserId}::uuid, ${providerAccountId}, ${credentialRef}, ${status},
      ${config}::text::jsonb, ${cursor}::text::jsonb, ${input.createdBy?.trim() || null}
    )
    RETURNING id::text,
              workspace_id AS "workspaceId",
              kind,
              owner_user_id::text AS "ownerUserId",
              provider_account_id AS "providerAccountId",
              credential_ref AS "credentialRef",
              status,
              config,
              cursor`;
  if (!rows[0]) throw new Error('external_trigger_source_create_failed');
  return rows[0];
}

/**
 * Idempotently connect the one owned source of a given kind. Re-consent may
 * rotate the OAuth field/reference, but it must not discard provider cursors or
 * non-secret source config accumulated by an already-connected adapter.
 */
export async function upsertOwnedExternalTriggerSource(
  sql: postgres.Sql,
  input: CreateOwnedExternalTriggerSourceInput,
): Promise<ExternalTriggerSourceRow> {
  const workspaceId = required(input.workspaceId, 'workspace_id');
  const kind = required(input.kind, 'source_kind');
  const ownerUserId = required(input.ownerUserId, 'owner_user_id');
  const credentialRef = required(input.credentialRef ?? '', 'credential_ref');
  const providerAccountId = ownedProviderAccountId(input, credentialRef);
  const status = input.status?.trim() || 'connected';
  const config = JSON.stringify(input.config ?? {});
  const cursor = JSON.stringify(input.cursor ?? {});
  const rows = await sql<ExternalTriggerSourceRow[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, credential_ref, status, config, cursor,
       last_connected_at, last_error, created_by)
    VALUES (
      ${workspaceId}, ${kind}, ${ownerUserId}::uuid, ${providerAccountId}, ${credentialRef}, ${status},
      ${config}::text::jsonb, ${cursor}::text::jsonb, now(), NULL,
      ${input.createdBy?.trim() || null}
    )
    ON CONFLICT (workspace_id, kind, owner_user_id, provider_account_id)
      WHERE owner_user_id IS NOT NULL AND provider_account_id IS NOT NULL
    DO UPDATE SET
      credential_ref = EXCLUDED.credential_ref,
      status = CASE
                 WHEN data_sources.config @> '{"capabilityEnabled":false}'::jsonb THEN 'disabled'
                 ELSE EXCLUDED.status
               END,
      last_connected_at = now(),
      last_error = NULL,
      updated_at = now()
    RETURNING id::text,
              workspace_id AS "workspaceId",
              kind,
              owner_user_id::text AS "ownerUserId",
              provider_account_id AS "providerAccountId",
              credential_ref AS "credentialRef",
              status,
              config,
              cursor`;
  if (!rows[0]) throw new Error('external_trigger_source_upsert_failed');
  return rows[0];
}

/** Read one source and its persisted local principal. */
export async function getExternalTriggerSource(
  sql: postgres.Sql,
  workspaceId: string,
  sourceId: string,
): Promise<ExternalTriggerSourceRow | null> {
  const rows = await sql<ExternalTriggerSourceRow[]>`
    SELECT id::text,
           workspace_id AS "workspaceId",
           kind,
           owner_user_id::text AS "ownerUserId",
           provider_account_id AS "providerAccountId",
           credential_ref AS "credentialRef",
           status,
           config,
           cursor
      FROM harness_shared.data_sources
     WHERE workspace_id = ${required(workspaceId, 'workspace_id')}
       AND id = ${required(sourceId, 'source_id')}::uuid
     LIMIT 1`;
  return rows[0] ?? null;
}

/** How a connector receives provider changes (migration 1317, plan D-010). */
export type DataSourceSyncMode = 'poll' | 'webhook' | 'socket' | 'federated' | 'manual';
/** Who a source's ingested data belongs to: one person, the organization, or one pot. */
export type DataSourceScope = 'personal' | 'organization' | 'pot';
export type DataSourceBackfillStatus = 'not-requested' | 'pending' | 'running' | 'complete' | 'failed';

/**
 * The data-source record (enterprise-data-sources P-013, plan D-010): a trigger
 * source row plus the ingestion-policy columns migration 1317 added in place.
 * Trigger consumers keep reading {@link ExternalTriggerSourceRow}; ingestion reads
 * this, so a trigger is one consumer of a data source rather than its identity.
 * The JSON policy columns are shape-checked by CHECK constraints in the database.
 */
export interface DataSourceRecord extends ExternalTriggerSourceRow {
  syncMode: DataSourceSyncMode;
  backfillStatus: DataSourceBackfillStatus;
  scope: DataSourceScope;
  /** The pot slug when `scope` is `pot`; null otherwise (enforced by a CHECK). */
  scopeRef: string | null;
  scopeMapping: Record<string, unknown>;
  /** Provider record type -> datatype key, e.g. `{ "message": "email-message" }`. */
  datatypeMappings: Record<string, unknown>;
  /** Datatype key -> destinations (document / event / record); never work. */
  destinationPolicy: Record<string, unknown>;
  retentionPolicy: Record<string, unknown>;
  permissionMapping: Record<string, unknown>;
}

function dataSourceColumns(sql: postgres.Sql) {
  return sql`
    id::text,
    workspace_id AS "workspaceId",
    kind,
    owner_user_id::text AS "ownerUserId",
    provider_account_id AS "providerAccountId",
    credential_ref AS "credentialRef",
    status,
    config,
    cursor,
    sync_mode AS "syncMode",
    backfill_status AS "backfillStatus",
    scope,
    scope_ref AS "scopeRef",
    scope_mapping AS "scopeMapping",
    datatype_mappings AS "datatypeMappings",
    destination_policy AS "destinationPolicy",
    retention_policy AS "retentionPolicy",
    permission_mapping AS "permissionMapping"`;
}

/** Read one source as a data-source record, including its ingestion policy. */
export async function getDataSourceRecord(
  sql: postgres.Sql,
  workspaceId: string,
  sourceId: string,
): Promise<DataSourceRecord | null> {
  const rows = await sql<DataSourceRecord[]>`
    SELECT ${dataSourceColumns(sql)}
      FROM harness_shared.data_sources
     WHERE workspace_id = ${required(workspaceId, 'workspace_id')}
       AND id = ${required(sourceId, 'source_id')}::uuid
     LIMIT 1`;
  return rows[0] ?? null;
}

/** List a workspace's data sources, optionally narrowed to one scope. */
export async function listDataSourceRecords(
  sql: postgres.Sql,
  workspaceId: string,
  opts: { scope?: DataSourceScope } = {},
): Promise<DataSourceRecord[]> {
  const ws = required(workspaceId, 'workspace_id');
  return sql<DataSourceRecord[]>`
    SELECT ${dataSourceColumns(sql)}
      FROM harness_shared.data_sources
     WHERE workspace_id = ${ws}
       ${opts.scope ? sql`AND scope = ${opts.scope}` : sql``}
     ORDER BY created_at, id`;
}

/**
 * Read the owned, credentialed sources a replay-safe provider poller may run.
 * `error`/`disabled` rows are normally excluded. A credential-not-connected
 * error can be retried after a later connection of that same credential by a
 * sibling source owned by the same user. Other terminal auth errors still need
 * reconnect, while transient provider failures remain `degraded` and are retried
 * by the next durable routine fire.
 */
export async function listPollableExternalTriggerSources(
  sql: postgres.Sql,
  workspaceId: string,
  kind: string,
): Promise<ExternalTriggerSourceRow[]> {
  return sql<ExternalTriggerSourceRow[]>`
    SELECT source.id::text,
           source.workspace_id AS "workspaceId",
           source.kind,
           source.owner_user_id::text AS "ownerUserId",
           source.provider_account_id AS "providerAccountId",
           source.credential_ref AS "credentialRef",
           source.status,
           source.config,
           source.cursor
      FROM harness_shared.data_sources AS source
     WHERE source.workspace_id = ${required(workspaceId, 'workspace_id')}
       AND source.kind = ${required(kind, 'source_kind')}
       AND source.owner_user_id IS NOT NULL
       AND source.credential_ref IS NOT NULL
       AND (
         source.status IN ('ready', 'connecting', 'connected', 'degraded')
         OR (
           source.status = 'error'
           AND source.last_error ~* 'oauth.*not[_ -]?connected'
           AND EXISTS (
             SELECT 1
               FROM harness_shared.data_sources AS sibling
              WHERE sibling.workspace_id = source.workspace_id
                AND sibling.owner_user_id = source.owner_user_id
                AND sibling.credential_ref = source.credential_ref
                AND sibling.id <> source.id
                AND sibling.last_connected_at > source.updated_at
           )
         )
       )
     ORDER BY id`;
}

/** Read every source owned by one authenticated local principal, including disabled/error rows. */
export async function listOwnedExternalTriggerSources(
  sql: postgres.Sql,
  workspaceId: string,
  ownerUserId: string,
): Promise<OwnedExternalTriggerSourceRow[]> {
  return sql<OwnedExternalTriggerSourceRow[]>`
    SELECT id::text,
           workspace_id AS "workspaceId",
           kind,
           owner_user_id::text AS "ownerUserId",
           provider_account_id AS "providerAccountId",
           credential_ref AS "credentialRef",
           status,
           config,
           cursor,
           last_error AS "lastError",
           last_connected_at::text AS "lastConnectedAt",
           updated_at::text AS "updatedAt"
      FROM harness_shared.data_sources
     WHERE workspace_id = ${required(workspaceId, 'workspace_id')}
       AND owner_user_id = ${required(ownerUserId, 'owner_user_id')}::uuid
     ORDER BY kind, id`;
}

/**
 * Replace the provisional identity of one owned provider account without
 * replacing any source rows. Bindings, cursors, delivery history, and source
 * ids all continue to point at the same rows after the provider reveals its
 * canonical account identity during OAuth.
 */
export async function renameOwnedExternalTriggerSourceAccount(
  sql: postgres.Sql,
  input: {
    workspaceId: string;
    ownerUserId: string;
    previousProviderAccountId: string;
    providerAccountId: string;
  },
): Promise<ExternalTriggerSourceRow[]> {
  const workspaceId = required(input.workspaceId, 'workspace_id');
  const ownerUserId = required(input.ownerUserId, 'owner_user_id');
  const previousProviderAccountId = required(input.previousProviderAccountId, 'previous_provider_account_id');
  const providerAccountId = required(input.providerAccountId, 'provider_account_id');

  return sql.begin(async (tx) => {
    const existing = await tx<Array<{ id: string }>>`
      SELECT id::text
        FROM harness_shared.data_sources
       WHERE workspace_id = ${workspaceId}
         AND owner_user_id = ${ownerUserId}::uuid
         AND provider_account_id = ${previousProviderAccountId}
       FOR UPDATE`;
    if (!existing.length) {
      throw new Error(`external_trigger_provider_account_not_found:${previousProviderAccountId}`);
    }
    if (previousProviderAccountId === providerAccountId) {
      return tx<ExternalTriggerSourceRow[]>`
        SELECT id::text,
               workspace_id AS "workspaceId",
               kind,
               owner_user_id::text AS "ownerUserId",
               provider_account_id AS "providerAccountId",
               credential_ref AS "credentialRef",
               status,
               config,
               cursor
          FROM harness_shared.data_sources
         WHERE workspace_id = ${workspaceId}
           AND owner_user_id = ${ownerUserId}::uuid
           AND provider_account_id = ${providerAccountId}
         ORDER BY kind, id`;
    }
    const conflict = await tx<Array<{ present: boolean }>>`
      SELECT true AS present
        FROM harness_shared.data_sources
       WHERE workspace_id = ${workspaceId}
         AND owner_user_id = ${ownerUserId}::uuid
         AND provider_account_id = ${providerAccountId}
       LIMIT 1
       FOR UPDATE`;
    if (conflict.length) {
      throw new Error(`external_trigger_provider_account_conflict:${providerAccountId}`);
    }
    return tx<ExternalTriggerSourceRow[]>`
      UPDATE harness_shared.data_sources
         SET provider_account_id = ${providerAccountId},
             updated_at = now()
       WHERE workspace_id = ${workspaceId}
         AND owner_user_id = ${ownerUserId}::uuid
         AND provider_account_id = ${previousProviderAccountId}
      RETURNING id::text,
                workspace_id AS "workspaceId",
                kind,
                owner_user_id::text AS "ownerUserId",
                provider_account_id AS "providerAccountId",
                credential_ref AS "credentialRef",
                status,
                config,
                cursor`;
  });
}

/**
 * Toggle one provider surface without revoking the shared OAuth connection.
 * The durable preference lives on the existing source config row and the
 * status transition makes every current poller honor it immediately. A source
 * missing from an older connection is created against the already-owned,
 * opaque credential reference supplied by the connection-level caller.
 */
export async function setOwnedExternalTriggerSourceCapability(
  sql: postgres.Sql,
  input: {
    workspaceId: string;
    ownerUserId: string;
    providerAccountId?: string;
    kind: string;
    credentialRef: string;
    enabled: boolean;
    createdBy?: string | null;
  },
): Promise<ExternalTriggerSourceRow> {
  const workspaceId = required(input.workspaceId, 'workspace_id');
  const ownerUserId = required(input.ownerUserId, 'owner_user_id');
  const kind = required(input.kind, 'source_kind');
  const credentialRef = required(input.credentialRef, 'credential_ref');
  const providerAccountId = required(input.providerAccountId?.trim() || credentialRef, 'provider_account_id');
  const status = input.enabled ? 'connected' : 'disabled';
  const config = JSON.stringify({ capabilityEnabled: input.enabled });
  const rows = await sql<ExternalTriggerSourceRow[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, credential_ref, status, config,
       last_connected_at, last_error, created_by)
    VALUES (
      ${workspaceId}, ${kind}, ${ownerUserId}::uuid, ${providerAccountId}, ${credentialRef}, ${status},
      ${config}::text::jsonb, CASE WHEN ${input.enabled} THEN now() ELSE NULL END,
      NULL, ${input.createdBy?.trim() || null}
    )
    ON CONFLICT (workspace_id, kind, owner_user_id, provider_account_id)
      WHERE owner_user_id IS NOT NULL AND provider_account_id IS NOT NULL
    DO UPDATE SET
      credential_ref = CASE
                         WHEN data_sources.credential_ref IS NULL THEN EXCLUDED.credential_ref
                         ELSE data_sources.credential_ref
                       END,
      status = EXCLUDED.status,
      config = data_sources.config || EXCLUDED.config,
      last_connected_at = CASE
                            WHEN ${input.enabled} THEN COALESCE(data_sources.last_connected_at, now())
                            ELSE data_sources.last_connected_at
                          END,
      last_error = NULL,
      updated_at = now()
    RETURNING id::text,
              workspace_id AS "workspaceId",
              kind,
              owner_user_id::text AS "ownerUserId",
              provider_account_id AS "providerAccountId",
              credential_ref AS "credentialRef",
              status,
              config,
              cursor`;
  if (!rows[0]) throw new Error('external_trigger_source_capability_update_failed');
  return rows[0];
}

/**
 * Stop polling selected owned source kinds without deleting settled events or
 * Personal Vault documents. The opaque reference remains as the reconnect
 * target while its token-store values are cleared by the caller; pollers honor
 * the disabled status and never treat the reference itself as a live token.
 */
export async function disconnectOwnedExternalTriggerSources(
  sql: postgres.Sql,
  workspaceId: string,
  ownerUserId: string,
  kinds: string[],
  providerAccountId?: string,
): Promise<DisconnectOwnedExternalTriggerSourcesResult> {
  const normalizedKinds = [...new Set(kinds.map((kind) => required(kind, 'source_kind')))];
  if (!normalizedKinds.length) throw new Error('external_trigger_source_kinds_required');
  const accountId = providerAccountId?.trim() || null;
  const rows = await sql<Array<{ sources: number; credentialRefs: string[] }>>`
    WITH matched AS (
      SELECT id, credential_ref
        FROM harness_shared.data_sources
       WHERE workspace_id = ${required(workspaceId, 'workspace_id')}
         AND owner_user_id = ${required(ownerUserId, 'owner_user_id')}::uuid
         AND (${accountId}::text IS NULL OR provider_account_id = ${accountId})
         AND kind = ANY(${normalizedKinds as string[]}::text[])
       FOR UPDATE
    ),
    disconnected AS (
      UPDATE harness_shared.data_sources AS source
         SET status = 'disabled',
             last_error = NULL,
             updated_at = now()
        FROM matched
       WHERE source.id = matched.id
       RETURNING matched.credential_ref
    )
    SELECT count(*)::int AS sources,
           COALESCE(
             array_agg(DISTINCT credential_ref) FILTER (WHERE credential_ref IS NOT NULL),
             ARRAY[]::text[]
           ) AS "credentialRefs"
      FROM disconnected`;
  return rows[0] ?? { sources: 0, credentialRefs: [] };
}

/**
 * A revoked or expired grant must not leave its sources looking connected:
 * every source on `credentialRef` moves to `reconnect_required`. Pollers only
 * run ready/connecting/connected/degraded sources, so sync stops; cursors and
 * synced data are kept, and a successful reconnect (upsert) restores
 * `connected` on the same source ids.
 */
export async function markExternalTriggerSourcesReconnectRequired(
  sql: postgres.Sql,
  workspaceId: string,
  credentialRef: string,
  reason: string,
): Promise<number> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.data_sources
       SET status = 'reconnect_required',
           last_error = ${reason.slice(0, 4000)},
           updated_at = now()
     WHERE workspace_id = ${required(workspaceId, 'workspace_id')}
       AND credential_ref = ${required(credentialRef, 'credential_ref')}
       AND status <> 'disabled'
    RETURNING id::text`;
  return rows.length;
}

/** Persist one provider cursor/status transition on the source row. */
export async function updateExternalTriggerSourceSyncState(
  sql: postgres.Sql,
  workspaceId: string,
  sourceId: string,
  input: ExternalTriggerSourceSyncState,
): Promise<ExternalTriggerSourceRow> {
  const cursor = input.cursor === undefined ? null : JSON.stringify(input.cursor);
  const lastError = input.lastError?.slice(0, 4000) ?? null;
  const rows = await sql<ExternalTriggerSourceRow[]>`
    UPDATE harness_shared.data_sources
       SET cursor = CASE
                      WHEN ${cursor}::text IS NULL THEN cursor
                      ELSE ${cursor}::text::jsonb
                    END,
           status = ${input.status},
           last_error = ${lastError},
           last_connected_at = CASE
                                 WHEN ${input.connected === true} THEN now()
                                 ELSE last_connected_at
                               END,
           updated_at = now()
     WHERE workspace_id = ${required(workspaceId, 'workspace_id')}
       AND id = ${required(sourceId, 'source_id')}::uuid
    RETURNING id::text,
              workspace_id AS "workspaceId",
              kind,
              owner_user_id::text AS "ownerUserId",
              provider_account_id AS "providerAccountId",
              credential_ref AS "credentialRef",
              status,
              config,
              cursor`;
  if (!rows[0]) throw new Error(`external_trigger_unknown_source:${sourceId}`);
  return rows[0];
}

/**
 * Resolve the authoritative local principal for a source, failing closed when
 * an old/unowned row has not been connected through the authenticated flow.
 */
export async function requireExternalTriggerSourceOwner(
  sql: postgres.Sql,
  workspaceId: string,
  sourceId: string,
): Promise<string> {
  const source = await getExternalTriggerSource(sql, workspaceId, sourceId);
  if (!source) throw new Error(`external_trigger_unknown_source:${sourceId}`);
  if (!source.ownerUserId) throw new Error(`external_trigger_source_owner_required:${sourceId}`);
  return source.ownerUserId;
}
