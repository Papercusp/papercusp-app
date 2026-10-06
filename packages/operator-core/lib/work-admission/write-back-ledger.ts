/**
 * The write-back ledger (linear-asana-task-sync-2026-10-05 P-002; migration 1380).
 *
 * Every write the host makes back to the source of an admitted work item (a comment, a workflow
 * transition) is recorded with the provider's own id for the change. That id is spelled the way
 * the provider's sync later reports the same change (its nativeId), so when the next sync ingests
 * it the lifecycle rules can ask {@link findAdmissionWriteBack} and recognise their own write
 * instead of reacting to it as an outside close, cancel or comment (echo suppression).
 *
 * The ledger never stores comment text, only the capability, the ids and small facts such as the
 * target category.
 */
import type { AdmissionDb, AdmissionRow } from './admission-sources';

/** Which write: the source's `<datatype>.comment` or `<datatype>.transition` capability. */
export type AdmissionWriteBackAction = 'comment' | 'transition';

export interface AdmissionWriteBackEntry {
  admissionId: string;
  workItemId: string;
  dataSourceId: string | null;
  action: AdmissionWriteBackAction;
  updateId: string | null;
  externalRef: string | null;
  detail: Record<string, unknown>;
  /** The lifecycle event this write answered (lifecycle.ts), or null for a write a person asked for. */
  lifecycleKey: string | null;
  createdAt: string;
}

interface LedgerRow {
  admission_id: string;
  work_item_id: string;
  data_source_id: string | null;
  action: AdmissionWriteBackAction;
  update_id: string | null;
  external_ref: string | null;
  detail: Record<string, unknown> | null;
  lifecycle_key: string | null;
  created_at: Date | string;
}

function toEntry(r: LedgerRow): AdmissionWriteBackEntry {
  return {
    admissionId: r.admission_id,
    workItemId: r.work_item_id,
    dataSourceId: r.data_source_id,
    action: r.action,
    updateId: r.update_id,
    externalRef: r.external_ref,
    detail: r.detail ?? {},
    lifecycleKey: r.lifecycle_key ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

function clean(v: string | null | undefined): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
}

/**
 * Records one write. A second write reporting the same provider update id on the same source is
 * the same change (a retried call) and is not recorded twice; neither is a second write for the
 * same lifecycle event of the same admission.
 */
export async function recordAdmissionWriteBack(
  sql: AdmissionDb,
  input: {
    admission: AdmissionRow;
    action: AdmissionWriteBackAction;
    updateId?: string | null;
    externalRef?: string | null;
    detail?: Record<string, unknown>;
    lifecycleKey?: string | null;
  },
): Promise<void> {
  const { admission } = input;
  // Two partial unique indexes guard this table (provider update id, lifecycle key); a bare
  // ON CONFLICT DO NOTHING covers either, so a retried write is a no-op whichever one matched.
  await sql`
    INSERT INTO harness_shared.admission_write_backs
      (workspace_id, admission_id, work_item_id, data_source_id, action, update_id, external_ref, detail, lifecycle_key)
    VALUES (${admission.workspaceId}, ${admission.id}::uuid, ${admission.workItemId},
            ${admission.dataSourceId}::uuid, ${input.action}, ${clean(input.updateId)},
            ${clean(input.externalRef)}, ${sql.json((input.detail ?? {}) as never)}, ${clean(input.lifecycleKey)})
    ON CONFLICT DO NOTHING`;
}

/** The lifecycle events already written back, per admission id (lifecycle.ts reads this before acting). */
export async function lifecycleKeysByAdmission(
  sql: AdmissionDb,
  workspaceId: string,
  admissionIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (admissionIds.length === 0) return out;
  const rows = await sql<Array<{ admission_id: string; lifecycle_key: string }>>`
    SELECT admission_id::text AS admission_id, lifecycle_key
      FROM harness_shared.admission_write_backs
     WHERE workspace_id = ${workspaceId} AND admission_id = ANY(${admissionIds as string[]}::uuid[])
       AND lifecycle_key IS NOT NULL`;
  for (const r of rows) {
    const keys = out.get(r.admission_id) ?? new Set<string>();
    keys.add(r.lifecycle_key);
    out.set(r.admission_id, keys);
  }
  return out;
}

/**
 * The host's own write that produced `updateId` on `dataSourceId`, or null when the change came
 * from somewhere else. This is the echo test the lifecycle rules apply to ingested changes.
 */
export async function findAdmissionWriteBack(
  sql: AdmissionDb,
  input: { workspaceId: string; dataSourceId: string; updateId: string },
): Promise<AdmissionWriteBackEntry | null> {
  const updateId = clean(input.updateId);
  if (!updateId) return null;
  const [row] = await sql<LedgerRow[]>`
    SELECT admission_id::text AS admission_id, work_item_id, data_source_id::text AS data_source_id,
           action, update_id, external_ref, detail, lifecycle_key, created_at
      FROM harness_shared.admission_write_backs
     WHERE workspace_id = ${input.workspaceId} AND data_source_id = ${input.dataSourceId}::uuid
       AND update_id = ${updateId}
     LIMIT 1`;
  return row ? toEntry(row) : null;
}

/** Every write the host made back for one work item, newest first. */
export async function writeBacksForWorkItem(
  sql: AdmissionDb,
  workspaceId: string,
  workItemId: string,
): Promise<AdmissionWriteBackEntry[]> {
  const rows = await sql<LedgerRow[]>`
    SELECT admission_id::text AS admission_id, work_item_id, data_source_id::text AS data_source_id,
           action, update_id, external_ref, detail, lifecycle_key, created_at
      FROM harness_shared.admission_write_backs
     WHERE workspace_id = ${workspaceId} AND work_item_id = ${workItemId}
     ORDER BY created_at DESC, id`;
  return rows.map(toEntry);
}
