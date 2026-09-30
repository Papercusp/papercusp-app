import { getOrgPg } from '@papercusp/db-org';
import type { SessionBackend } from './types';

export type SessionPortStatus = 'prepared' | 'pending' | 'delivered' | 'failed' | 'expired';

export interface SessionPortRow {
  id: string;
  workspaceId: string;
  idempotencyKey: string;
  retryOfPortId?: string | null;
  protocolVersion: number;
  sourceAdvSessionId: number;
  targetAdvSessionId: number | null;
  sourceBackend: SessionBackend;
  targetBackend: SessionBackend;
  targetModel: string | null;
  status: SessionPortStatus;
  sourceHash: string;
  normalizedHash: string;
  renderedHash: string;
  tokenHash: string;
  artifactPath: string;
  metadata: Record<string, unknown>;
  error: string | null;
  preparedAt: string;
  pendingAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  expiresAt: string;
}

const TRANSITIONS: Record<SessionPortStatus, readonly SessionPortStatus[]> = {
  prepared: ['pending', 'failed', 'expired'],
  pending: ['delivered', 'failed', 'expired'],
  delivered: [],
  failed: [],
  expired: [],
};

export function canTransitionSessionPort(from: SessionPortStatus, to: SessionPortStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

const mapRow = (r: any): SessionPortRow => ({
  id: r.id,
  workspaceId: r.workspace_id,
  idempotencyKey: r.logical_request_key ?? r.idempotency_key,
  retryOfPortId: r.retry_of_port_id ?? null,
  protocolVersion: Number(r.protocol_version),
  sourceAdvSessionId: Number(r.source_adv_session_id),
  targetAdvSessionId: r.target_adv_session_id == null ? null : Number(r.target_adv_session_id),
  sourceBackend: r.source_backend,
  targetBackend: r.target_backend,
  targetModel: r.target_model,
  status: r.status,
  sourceHash: r.source_hash,
  normalizedHash: r.normalized_hash,
  renderedHash: r.rendered_hash,
  tokenHash: r.token_hash,
  artifactPath: r.artifact_path,
  metadata: r.metadata ?? {},
  error: r.error ?? null,
  preparedAt: new Date(r.prepared_at).toISOString(),
  pendingAt: r.pending_at == null ? null : new Date(r.pending_at).toISOString(),
  deliveredAt: r.delivered_at == null ? null : new Date(r.delivered_at).toISOString(),
  failedAt: r.failed_at == null ? null : new Date(r.failed_at).toISOString(),
  expiresAt: new Date(r.expires_at).toISOString(),
});

/** Explicit rollout handshake: inspect must fail before source acquisition or
 * preparation when migration 611 has not reached the serving operator. */
export async function assertSessionPortStorageReady(): Promise<void> {
  const { sql } = getOrgPg();
  const rows = await sql<
    Array<{
      table_ready: boolean;
      retry_column_ready: boolean;
      logical_key_column_ready: boolean;
      adv_columns: number;
    }>
  >`
    SELECT to_regclass('harness_shared.session_ports') IS NOT NULL AS table_ready,
           EXISTS (
             SELECT 1 FROM pg_attribute
              WHERE attrelid = to_regclass('harness_shared.session_ports')
                AND attname = 'retry_of_port_id'
                AND NOT attisdropped
           ) AS retry_column_ready,
           EXISTS (
             SELECT 1 FROM pg_attribute
              WHERE attrelid = to_regclass('harness_shared.session_ports')
                AND attname = 'logical_request_key'
                AND NOT attisdropped
           ) AS logical_key_column_ready,
           (SELECT count(*)::int
              FROM pg_attribute
             WHERE attrelid = to_regclass('harness_shared.adv_sessions')
               AND attname IN ('port_id', 'port_source_adv_session_id', 'port_status', 'port_metadata')
               AND NOT attisdropped) AS adv_columns`;
  if (
    !rows[0]?.table_ready ||
    !rows[0]?.retry_column_ready ||
    !rows[0]?.logical_key_column_ready ||
    Number(rows[0]?.adv_columns) !== 4
  ) {
    throw new Error(
      'session-port storage migrations 611/1182 are not installed; upgrade/migrate psu operator before porting',
    );
  }
}

/** Atomically expire active rows whose token TTL elapsed, and also return any
 * previously-expired rows whose crash cleanup has not yet completed. */
export async function sessionPortsNeedingCleanup(workspaceId: string): Promise<SessionPortRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<any[]>`
    WITH newly_expired AS (
      UPDATE harness_shared.session_ports
         SET status = 'expired',
             logical_request_key = COALESCE(logical_request_key, idempotency_key),
             idempotency_key = CASE
               WHEN idempotency_key = COALESCE(logical_request_key, idempotency_key)
                 THEN idempotency_key || ':terminal:' || id::text
               ELSE idempotency_key
             END,
             error = COALESCE(error, 'preparation expired before native persistence'),
             failed_at = COALESCE(failed_at, now())
       WHERE workspace_id = ${workspaceId}
         AND (
           (status IN ('prepared', 'pending') AND expires_at <= now())
           OR (
             status = 'expired'
             AND idempotency_key = COALESCE(logical_request_key, idempotency_key)
           )
         )
      RETURNING *
    )
    SELECT * FROM newly_expired
    UNION ALL
    SELECT p.* FROM harness_shared.session_ports p
     WHERE p.workspace_id = ${workspaceId}
       AND p.status = 'expired'
       AND COALESCE(p.metadata->>'cleanupComplete', 'false') <> 'true'
       AND NOT EXISTS (SELECT 1 FROM newly_expired n WHERE n.id = p.id)`;
  return rows.map(mapRow);
}

export async function findSessionPortByIdempotency(
  workspaceId: string,
  idempotencyKey: string,
): Promise<SessionPortRow | null> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.session_ports
       SET status = 'expired',
           logical_request_key = COALESCE(logical_request_key, idempotency_key),
           idempotency_key = CASE
             WHEN idempotency_key = COALESCE(logical_request_key, idempotency_key)
               THEN idempotency_key || ':terminal:' || id::text
             ELSE idempotency_key
           END,
           error = COALESCE(error, 'preparation expired before target persistence'),
           failed_at = COALESCE(failed_at, now())
     WHERE workspace_id = ${workspaceId}
       AND (logical_request_key = ${idempotencyKey} OR (logical_request_key IS NULL AND idempotency_key = ${idempotencyKey}))
       AND status IN ('prepared', 'pending')
       AND expires_at <= now()`;
  // Protocol-v1 writers leave terminal rows occupying the legacy UNIQUE slot.
  // Preserve their semantic key, then release only that physical arbiter slot
  // so a linked protocol-v2 attempt can be inserted without breaking the old
  // writer's un-predicated ON CONFLICT contract during rollout.
  await sql`
    UPDATE harness_shared.session_ports
       SET logical_request_key = COALESCE(logical_request_key, idempotency_key),
           idempotency_key = idempotency_key || ':terminal:' || id::text
     WHERE workspace_id = ${workspaceId}
       AND (logical_request_key = ${idempotencyKey} OR (logical_request_key IS NULL AND idempotency_key = ${idempotencyKey}))
       AND status IN ('failed', 'expired')
       AND idempotency_key = COALESCE(logical_request_key, idempotency_key)`;
  const rows = await sql<any[]>`
    SELECT * FROM harness_shared.session_ports
     WHERE workspace_id = ${workspaceId}
       AND (logical_request_key = ${idempotencyKey} OR (logical_request_key IS NULL AND idempotency_key = ${idempotencyKey}))
     ORDER BY CASE WHEN status IN ('prepared', 'pending', 'delivered') THEN 0 ELSE 1 END,
              prepared_at DESC
     LIMIT 1`;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createPreparedSessionPort(input: Omit<
  SessionPortRow,
  'status' | 'targetAdvSessionId' | 'error' | 'preparedAt' | 'pendingAt' | 'deliveredAt' | 'failedAt'
>): Promise<SessionPortRow> {
  const { sql } = getOrgPg();
  let retryOfPortId = input.retryOfPortId ?? null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rows = await sql<any[]>`
      INSERT INTO harness_shared.session_ports
        (id, workspace_id, idempotency_key, logical_request_key, retry_of_port_id,
         protocol_version, source_adv_session_id, source_backend, target_backend, target_model,
         source_hash, normalized_hash, rendered_hash, token_hash, artifact_path, metadata, expires_at)
      VALUES
        (${input.id}, ${input.workspaceId}, ${input.idempotencyKey}, ${input.idempotencyKey}, ${retryOfPortId},
         ${input.protocolVersion}, ${input.sourceAdvSessionId}, ${input.sourceBackend}, ${input.targetBackend},
         ${input.targetModel}, ${input.sourceHash}, ${input.normalizedHash}, ${input.renderedHash},
         ${input.tokenHash}, ${input.artifactPath}, ${JSON.stringify(input.metadata)}::text::jsonb,
         ${input.expiresAt})
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
      RETURNING *`;
    if (rows[0]) return mapRow(rows[0]);
    const existing = await findSessionPortByIdempotency(input.workspaceId, input.idempotencyKey);
    if (!existing) throw new Error('session-port idempotency conflict lost its row');
    if ((existing.status === 'failed' || existing.status === 'expired') && attempt === 0) {
      retryOfPortId = existing.id;
      continue;
    }
    return existing;
  }
  throw new Error('session-port terminal retry could not acquire the legacy idempotency slot');
}

export async function getSessionPort(id: string, workspaceId: string): Promise<SessionPortRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql<any[]>`
    SELECT * FROM harness_shared.session_ports WHERE id = ${id} AND workspace_id = ${workspaceId}`;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function transitionSessionPort(
  id: string,
  workspaceId: string,
  to: SessionPortStatus,
  fields: { targetAdvSessionId?: number | null; error?: string | null; metadata?: Record<string, unknown> } = {},
): Promise<SessionPortRow> {
  const current = await getSessionPort(id, workspaceId);
  if (!current) throw new Error('session port not found');
  if (!canTransitionSessionPort(current.status, to)) throw new Error(`invalid session-port transition ${current.status} -> ${to}`);
  if (
    fields.targetAdvSessionId != null &&
    current.targetAdvSessionId != null &&
    fields.targetAdvSessionId !== current.targetAdvSessionId
  ) {
    throw new Error(
      `session-port target binding is immutable (${current.targetAdvSessionId} != ${fields.targetAdvSessionId})`,
    );
  }
  if (fields.targetAdvSessionId != null && current.targetAdvSessionId == null && to === current.status) {
    throw new Error('session-port same-state transition cannot introduce a target binding');
  }
  const { sql } = getOrgPg();
  const rows = await sql<any[]>`
    UPDATE harness_shared.session_ports
       SET status = ${to},
           logical_request_key = COALESCE(logical_request_key, idempotency_key),
           idempotency_key = CASE
             WHEN ${to} IN ('failed', 'expired')
              AND idempotency_key = COALESCE(logical_request_key, idempotency_key)
               THEN idempotency_key || ':terminal:' || id::text
             ELSE idempotency_key
           END,
           target_adv_session_id = COALESCE(target_adv_session_id, ${fields.targetAdvSessionId ?? null}),
           error = ${fields.error ?? null},
           metadata = metadata || ${JSON.stringify(fields.metadata ?? {})}::text::jsonb,
           pending_at = CASE WHEN ${to} = 'pending' THEN COALESCE(pending_at, now()) ELSE pending_at END,
           delivered_at = CASE WHEN ${to} = 'delivered' THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
           failed_at = CASE WHEN ${to} IN ('failed', 'expired') THEN COALESCE(failed_at, now()) ELSE failed_at END
     WHERE id = ${id} AND workspace_id = ${workspaceId} AND status = ${current.status}
     RETURNING *`;
  if (!rows[0]) throw new Error('session-port state changed concurrently');
  return mapRow(rows[0]);
}

export const sessionPortBootstrapLedgerKey = (portId: string): string => `bootstrap-su:session-port:${portId}`;

const SESSION_PORT_BOOTSTRAP_CLAIM = 'session-port-bootstrap-claim/v1';
const SESSION_PORT_BOOTSTRAP_RECEIPT = 'session-port-bootstrap-receipt/v1';
const SESSION_PORT_BOOTSTRAP_FAILURE = 'session-port-bootstrap-failure/v1';

type SessionPortBootstrapLedgerSummary = {
  kind?: unknown;
  portId?: unknown;
  requestHash?: unknown;
  targetAdvSessionId?: unknown;
  result?: unknown;
};

export type SessionPortBootstrapDisposition =
  | { status: 'reserved'; port: SessionPortRow; targetAdvSessionId: number }
  | { status: 'replay'; port: SessionPortRow; targetAdvSessionId: number; receipt: Record<string, unknown> }
  | { status: 'in_progress'; port: SessionPortRow; targetAdvSessionId: number }
  | { status: 'terminal'; port: SessionPortRow };

function bootstrapReceiptFromSummary(
  summary: SessionPortBootstrapLedgerSummary | null | undefined,
  input: { portId: string; requestHash: string; targetAdvSessionId: number },
): Record<string, unknown> | null {
  if (
    summary?.kind !== SESSION_PORT_BOOTSTRAP_RECEIPT ||
    summary.portId !== input.portId ||
    summary.requestHash !== input.requestHash ||
    Number(summary.targetAdvSessionId) !== input.targetAdvSessionId ||
    summary.result == null ||
    typeof summary.result !== 'object' ||
    Array.isArray(summary.result)
  )
    return null;
  return summary.result as Record<string, unknown>;
}

function assertBootstrapBinding(port: SessionPortRow, requestHash: string): number {
  if (port.metadata.bootstrapRequestHash !== requestHash) {
    throw new Error('session-port bootstrap request does not match the immutable prepared request');
  }
  if (port.targetAdvSessionId == null) {
    throw new Error(`session-port ${port.status} row has no target binding`);
  }
  return port.targetAdvSessionId;
}

/** Read an already-progressed attempt before artifact access. The opaque token
 * is authenticated by the caller; this function additionally binds replay to
 * the exact material bootstrap request and committed target identity. */
export async function readSessionPortBootstrapDisposition(input: {
  portId: string;
  workspaceId: string;
  requestHash: string;
}): Promise<Exclude<SessionPortBootstrapDisposition, { status: 'reserved' }>> {
  const { sql } = getOrgPg();
  return sql.begin(async (tx) => {
    const portRows = await tx<any[]>`
      SELECT * FROM harness_shared.session_ports
       WHERE id = ${input.portId} AND workspace_id = ${input.workspaceId}
       FOR UPDATE`;
    if (!portRows[0]) throw new Error('session port not found');
    let port = mapRow(portRows[0]);
    if (port.status === 'failed' || port.status === 'expired') return { status: 'terminal', port };
    const targetAdvSessionId = assertBootstrapBinding(port, input.requestHash);
    const ledgerRows = await tx<Array<{ summary: SessionPortBootstrapLedgerSummary }>>`
      SELECT summary
        FROM harness_shared.agent_launch_idempotency
       WHERE workspace_id = ${input.workspaceId}
         AND idempotency_key = ${sessionPortBootstrapLedgerKey(input.portId)}
       FOR UPDATE`;
    const receipt = bootstrapReceiptFromSummary(ledgerRows[0]?.summary, {
      portId: input.portId,
      requestHash: input.requestHash,
      targetAdvSessionId,
    });
    if (receipt) return { status: 'replay', port, targetAdvSessionId, receipt };
    if ((port.status === 'prepared' || port.status === 'pending') && Date.parse(port.expiresAt) <= Date.now()) {
      const expiredRows = await tx<any[]>`
        UPDATE harness_shared.session_ports
           SET status = 'expired',
               logical_request_key = COALESCE(logical_request_key, idempotency_key),
               idempotency_key = CASE
                 WHEN idempotency_key = COALESCE(logical_request_key, idempotency_key)
                   THEN idempotency_key || ':terminal:' || id::text
                 ELSE idempotency_key
               END,
               error = COALESCE(error, 'target reservation expired before bootstrap receipt'),
               failed_at = COALESCE(failed_at, now())
         WHERE id = ${input.portId} AND workspace_id = ${input.workspaceId}
        RETURNING *`;
      port = expiredRows[0] ? mapRow(expiredRows[0]) : port;
      return { status: 'terminal', port };
    }
    return { status: 'in_progress', port, targetAdvSessionId };
  });
}

/**
 * Reserve the final hidden ADV identity and bind prepared -> pending in the
 * same transaction. The session-port row lock is the single-writer fence; the
 * existing launch-idempotency ledger stores the durable replay receipt.
 */
export async function reserveSessionPortTarget(input: {
  portId: string;
  workspaceId: string;
  requestHash: string;
  target: {
    planSlug: string | null;
    agent: SessionBackend;
    mode: string;
    cwd: string;
    label: string | null;
    coordOwnerId: string;
    nativeSessionId: string | null;
    launchArgv: string[] | null;
    portMetadata: Record<string, unknown>;
  };
}): Promise<SessionPortBootstrapDisposition> {
  const { sql } = getOrgPg();
  return sql.begin(async (tx) => {
    const portRows = await tx<any[]>`
      SELECT * FROM harness_shared.session_ports
       WHERE id = ${input.portId} AND workspace_id = ${input.workspaceId}
       FOR UPDATE`;
    if (!portRows[0]) throw new Error('session port not found');
    let port = mapRow(portRows[0]);
    if (port.status === 'failed' || port.status === 'expired') return { status: 'terminal', port };
    if (port.status !== 'prepared') {
      const targetAdvSessionId = assertBootstrapBinding(port, input.requestHash);
      const ledgerRows = await tx<Array<{ summary: SessionPortBootstrapLedgerSummary }>>`
        SELECT summary
          FROM harness_shared.agent_launch_idempotency
         WHERE workspace_id = ${input.workspaceId}
           AND idempotency_key = ${sessionPortBootstrapLedgerKey(input.portId)}`;
      const receipt = bootstrapReceiptFromSummary(ledgerRows[0]?.summary, {
        portId: input.portId,
        requestHash: input.requestHash,
        targetAdvSessionId,
      });
      return receipt
        ? { status: 'replay', port, targetAdvSessionId, receipt }
        : { status: 'in_progress', port, targetAdvSessionId };
    }
    if (Date.parse(port.expiresAt) <= Date.now()) {
      const expiredRows = await tx<any[]>`
        UPDATE harness_shared.session_ports
           SET status = 'expired',
               logical_request_key = COALESCE(logical_request_key, idempotency_key),
               idempotency_key = CASE
                 WHEN idempotency_key = COALESCE(logical_request_key, idempotency_key)
                   THEN idempotency_key || ':terminal:' || id::text
                 ELSE idempotency_key
               END,
               error = COALESCE(error, 'preparation expired before target reservation'),
               failed_at = COALESCE(failed_at, now())
         WHERE id = ${input.portId} AND workspace_id = ${input.workspaceId} AND status = 'prepared'
        RETURNING *`;
      port = expiredRows[0] ? mapRow(expiredRows[0]) : port;
      return { status: 'terminal', port };
    }

    const ledgerKey = sessionPortBootstrapLedgerKey(input.portId);
    const claim = JSON.stringify({
      kind: SESSION_PORT_BOOTSTRAP_CLAIM,
      portId: input.portId,
      requestHash: input.requestHash,
    });
    const claimed = await tx<Array<{ idempotency_key: string }>>`
      INSERT INTO harness_shared.agent_launch_idempotency
        (workspace_id, idempotency_key, launched_at, launched_by, summary)
      VALUES (${input.workspaceId}, ${ledgerKey}, ${Date.now()}, ${input.target.coordOwnerId}, ${claim}::text::jsonb)
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
      RETURNING idempotency_key`;
    if (claimed.length === 0) {
      const ledgerRows = await tx<Array<{ summary: SessionPortBootstrapLedgerSummary }>>`
        SELECT summary
          FROM harness_shared.agent_launch_idempotency
         WHERE workspace_id = ${input.workspaceId} AND idempotency_key = ${ledgerKey}
         FOR UPDATE`;
      const summary = ledgerRows[0]?.summary;
      if (summary?.portId !== input.portId || summary.requestHash !== input.requestHash)
        throw new Error('session-port bootstrap attempt key is already bound to a different request');
      const targetAdvSessionId = Number(summary.targetAdvSessionId);
      const receipt =
        Number.isSafeInteger(targetAdvSessionId) && targetAdvSessionId > 0
          ? bootstrapReceiptFromSummary(summary, {
              portId: input.portId,
              requestHash: input.requestHash,
              targetAdvSessionId,
            })
          : null;
      if (receipt) return { status: 'replay', port, targetAdvSessionId, receipt };
      if (Number.isSafeInteger(targetAdvSessionId) && targetAdvSessionId > 0) {
        return { status: 'in_progress', port, targetAdvSessionId };
      }
      throw new Error('session-port bootstrap claim exists without a target reservation');
    }

    const targetRows = await tx<Array<{ id: number }>>`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, plan_slug, agent, mode, cwd, label, coord_owner_id, session_id, launch_argv,
         port_id, port_source_adv_session_id, port_status, port_metadata)
      VALUES
        (${input.workspaceId}, ${input.target.planSlug}, ${input.target.agent}, ${input.target.mode},
         ${input.target.cwd}, ${input.target.label}, ${input.target.coordOwnerId}, ${input.target.nativeSessionId},
         ${input.target.launchArgv ? JSON.stringify(input.target.launchArgv) : null}::text::jsonb,
         ${input.portId}, ${port.sourceAdvSessionId}, 'pending',
         ${JSON.stringify(input.target.portMetadata)}::text::jsonb)
      RETURNING id`;
    const targetAdvSessionId = targetRows[0]?.id;
    if (!Number.isSafeInteger(targetAdvSessionId) || targetAdvSessionId <= 0) {
      throw new Error('could not reserve the pending session-port target row');
    }
    const binding = JSON.stringify({
      bootstrapRequestHash: input.requestHash,
      bootstrapLedgerKey: ledgerKey,
      targetCoordOwnerId: input.target.coordOwnerId,
      targetNativeSessionId: input.target.nativeSessionId,
    });
    const boundRows = await tx<any[]>`
      UPDATE harness_shared.session_ports
         SET status = 'pending',
             target_adv_session_id = ${targetAdvSessionId},
             pending_at = COALESCE(pending_at, now()),
             metadata = metadata || ${binding}::text::jsonb
       WHERE id = ${input.portId}
         AND workspace_id = ${input.workspaceId}
         AND status = 'prepared'
         AND target_adv_session_id IS NULL
      RETURNING *`;
    if (!boundRows[0]) throw new Error('session-port prepared binding changed concurrently');
    port = mapRow(boundRows[0]);
    const claimedTarget = JSON.stringify({
      kind: SESSION_PORT_BOOTSTRAP_CLAIM,
      portId: input.portId,
      requestHash: input.requestHash,
      targetAdvSessionId,
    });
    await tx`
      UPDATE harness_shared.agent_launch_idempotency
         SET summary = ${claimedTarget}::text::jsonb
       WHERE workspace_id = ${input.workspaceId} AND idempotency_key = ${ledgerKey}`;
    return { status: 'reserved', port, targetAdvSessionId };
  });
}

/** Commit the response before it leaves the server. A lost HTTP response can
 * then be replayed exactly without touching the already-progressed port. */
export async function recordSessionPortBootstrapReceipt(input: {
  portId: string;
  workspaceId: string;
  requestHash: string;
  targetAdvSessionId: number;
  receipt: Record<string, unknown>;
}): Promise<void> {
  const { sql } = getOrgPg();
  await sql.begin(async (tx) => {
    const rows = await tx<any[]>`
      SELECT * FROM harness_shared.session_ports
       WHERE id = ${input.portId} AND workspace_id = ${input.workspaceId}
       FOR UPDATE`;
    if (!rows[0]) throw new Error('session port not found');
    const port = mapRow(rows[0]);
    if (port.status !== 'pending') {
      throw new Error(`session-port bootstrap receipt requires pending state; got ${port.status}`);
    }
    const targetAdvSessionId = assertBootstrapBinding(port, input.requestHash);
    if (targetAdvSessionId !== input.targetAdvSessionId) {
      throw new Error('session-port bootstrap receipt target does not match the immutable binding');
    }
    const ledgerSummary = JSON.stringify({
      kind: SESSION_PORT_BOOTSTRAP_RECEIPT,
      portId: input.portId,
      requestHash: input.requestHash,
      targetAdvSessionId,
      result: input.receipt,
    });
    const updated = await tx<Array<{ idempotency_key: string }>>`
      UPDATE harness_shared.agent_launch_idempotency
         SET summary = ${ledgerSummary}::text::jsonb
       WHERE workspace_id = ${input.workspaceId}
         AND idempotency_key = ${sessionPortBootstrapLedgerKey(input.portId)}
      RETURNING idempotency_key`;
    if (updated.length !== 1) throw new Error('session-port bootstrap ledger claim is missing');
    await tx`
      UPDATE harness_shared.session_ports
         SET metadata = metadata || ${JSON.stringify({
           bootstrapReceiptCommitted: true,
           bootstrapReceiptTargetAdvSessionId: targetAdvSessionId,
         })}::text::jsonb
       WHERE id = ${input.portId} AND workspace_id = ${input.workspaceId}`;
  });
}

/** Roll back only the reserved attempt. The terminal row and ledger receipt are
 * retained as diagnosis/linkage, while a later prepare may create a new port id
 * with retry_of_port_id pointing here. */
export async function failSessionPortTargetReservation(input: {
  portId: string;
  workspaceId: string;
  requestHash: string;
  targetAdvSessionId: number;
  error: string;
}): Promise<boolean> {
  const { sql } = getOrgPg();
  return sql.begin(async (tx) => {
    const rows = await tx<any[]>`
      SELECT * FROM harness_shared.session_ports
       WHERE id = ${input.portId} AND workspace_id = ${input.workspaceId}
       FOR UPDATE`;
    if (!rows[0]) return false;
    const port = mapRow(rows[0]);
    if (port.status === 'failed') return true;
    if (port.status !== 'pending') return false;
    if (assertBootstrapBinding(port, input.requestHash) !== input.targetAdvSessionId) return false;
    const message = input.error.slice(0, 1000);
    await tx`
      UPDATE harness_shared.session_ports
         SET status = 'failed',
             logical_request_key = COALESCE(logical_request_key, idempotency_key),
             idempotency_key = CASE
               WHEN idempotency_key = COALESCE(logical_request_key, idempotency_key)
                 THEN idempotency_key || ':terminal:' || id::text
               ELSE idempotency_key
             END,
             error = ${message}, failed_at = COALESCE(failed_at, now()),
             metadata = metadata || ${JSON.stringify({ bootstrapFailureStage: 'before-receipt' })}::text::jsonb
       WHERE id = ${input.portId} AND workspace_id = ${input.workspaceId}`;
    await tx`
      UPDATE harness_shared.adv_sessions
         SET port_status = 'failed',
             port_metadata = COALESCE(port_metadata, '{}'::jsonb) || ${JSON.stringify({ deliveryError: message })}::text::jsonb,
             ended_at = COALESCE(ended_at, now()), ended_by = COALESCE(ended_by, 'cleanup')
       WHERE id = ${input.targetAdvSessionId}
         AND workspace_id = ${input.workspaceId}
         AND port_id = ${input.portId}`;
    const failure = JSON.stringify({
      kind: SESSION_PORT_BOOTSTRAP_FAILURE,
      portId: input.portId,
      requestHash: input.requestHash,
      targetAdvSessionId: input.targetAdvSessionId,
      error: message,
    });
    await tx`
      UPDATE harness_shared.agent_launch_idempotency
         SET summary = ${failure}::text::jsonb
       WHERE workspace_id = ${input.workspaceId}
         AND idempotency_key = ${sessionPortBootstrapLedgerKey(input.portId)}`;
    return true;
  });
}
