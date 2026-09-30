/** Shared receipts: status polls may land on any operator worker. */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

export type AmendReceiptState = 'running' | 'committed' | 'previewed' | 'failed';

export interface AmendReceiptEntry {
  idempotencyKey: string;
  rubricRef: string;
  state: AmendReceiptState;
  startedAt: number;
  finishedAt?: number;
  /** The exact JSON payload the synchronous call would have returned. */
  result?: Record<string, unknown>;
  error?: string;
}

export const AMEND_RECEIPT_RETENTION_MS = 60 * 60 * 1000;
interface ReceiptRow {
  idempotency_key: string;
  rubric_ref: string;
  state: AmendReceiptState;
  started_at: Date | string;
  finished_at: Date | string | null;
  result_json: Record<string, unknown> | null;
  error: string | null;
}

function asEntry(row: ReceiptRow): AmendReceiptEntry {
  return {
    idempotencyKey: row.idempotency_key,
    rubricRef: row.rubric_ref,
    state: row.state,
    startedAt: new Date(row.started_at).getTime(),
    ...(row.finished_at ? { finishedAt: new Date(row.finished_at).getTime() } : {}),
    ...(row.result_json ? { result: row.result_json } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

/**
 * Reserve the key before invoking the amend. A same-key request on another
 * worker reads the shared row rather than starting duplicate work.
 */
export async function trackAmendRun(
  idempotencyKey: string,
  rubricRef: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  // Finished previews/failures have no Decision fallback. Retain them for one
  // hour, then bound the shared table opportunistically on the next amend.
  await sql`
    DELETE FROM harness_shared.rubric_amend_receipts
     WHERE workspace_id = ${workspaceId}
       AND finished_at < now() - interval '1 hour' AND state <> 'running'
  `;
  const inserted = await sql<Array<{ idempotency_key: string }>>`
    INSERT INTO harness_shared.rubric_amend_receipts
      (workspace_id, rubric_ref, idempotency_key, state)
    VALUES (${workspaceId}, ${rubricRef}, ${idempotencyKey}, 'running')
    ON CONFLICT (workspace_id, rubric_ref, idempotency_key) DO NOTHING
    RETURNING idempotency_key
  `;
  if (inserted.length === 0) {
    const existing = await getAmendReceipt(rubricRef, idempotencyKey);
    if (!existing) throw new Error('rubric amend receipt disappeared during same-key retry');
    if (existing.result) return existing.result;
    if (existing.state === 'failed') throw new Error(existing.error ?? 'previous rubric amendment failed');
    return { ok: true, pending: true, idempotencyKey, receipt: { rubricRef, idempotencyKey } };
  }
  let result: Record<string, unknown>;
  try {
    result = await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE harness_shared.rubric_amend_receipts
         SET state = 'failed', error = ${message}, finished_at = now()
       WHERE workspace_id = ${workspaceId} AND rubric_ref = ${rubricRef}
         AND idempotency_key = ${idempotencyKey} AND state = 'running'
    `;
    throw error;
  }
  // A persistence failure after the amend committed must never reclassify it as
  // failed. The atomic Decision remains the source of truth for applied BARs.
  const state: AmendReceiptState = result.ok === true
    ? (result.dryRun === true ? 'previewed' : 'committed') : 'failed';
  const error = state === 'failed'
    ? (typeof result.error === 'string' ? result.error : 'amend returned ok:false') : null;
  await sql`
    UPDATE harness_shared.rubric_amend_receipts
       SET state = ${state}, result_json = ${JSON.stringify(result)}::text::jsonb,
           error = ${error}, finished_at = now()
     WHERE workspace_id = ${workspaceId} AND rubric_ref = ${rubricRef}
       AND idempotency_key = ${idempotencyKey}
  `;
  return result;
}

export async function getAmendReceipt(rubricRef: string, idempotencyKey: string): Promise<AmendReceiptEntry | undefined> {
  const { sql } = getOrgPg();
  const rows = await sql<ReceiptRow[]>`
    SELECT idempotency_key, rubric_ref, state, started_at, finished_at, result_json, error
      FROM harness_shared.rubric_amend_receipts
     WHERE workspace_id = ${activeWorkspaceId()}
       AND rubric_ref = ${rubricRef}
       AND idempotency_key = ${idempotencyKey.trim()}
  `;
  return rows[0] ? asEntry(rows[0]) : undefined;
}
