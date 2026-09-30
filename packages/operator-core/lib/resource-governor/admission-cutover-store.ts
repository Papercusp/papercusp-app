/**
 * Bounded rolling-cutover store for resource-governor admissions.
 *
 * New identities are always written to the dedicated admission ledger. The
 * work-item store is present only to finish receipts created by an older binary
 * while independently deployed writer generations overlap.
 */
import { getOrgPg } from '@papercusp/db-org';
import { boundedOrgTxn } from '../pg-bounded-txn';
import { activeWorkspaceId } from '../workspace-registry';
import { AdmissionPersistenceError, type QueueReceiptState, type ResourceDemand } from './admission';
import {
  PgAdmissionLedgerQueueStore,
  RESOURCE_GOVERNOR_LEGACY_WRITERS_RETIRED_SETTING_PREFIX,
  RESOURCE_GOVERNOR_LEDGER_CUTOVER_SETTING_PREFIX,
  type AdmissionLedgerLegacyAdapter,
} from './admission-ledger-store';
import {
  GOVERNOR_QUEUE_OBSERVATION_WINDOW_MS,
  PgWorkItemAdmissionQueueStore,
  RESOURCE_GOVERNOR_PAYLOAD_KEY,
  RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION,
  type DurableAdmissionQueueStore,
  type DurableAdmissionRecord,
  type GovernorQueuePopulationObservation,
  type QueueLeaseSelection,
  type QueueMutationResult,
  type QueueReconciliationResult,
  type SqlClient,
  type StoredAdmissionRecord,
} from './queue';

type ResolveSessionStates = typeof import('../agent-tools/coordination/liveness-oracle').resolveSessionStates;
type DecisionValue = string | number | boolean | null;

interface LegacyDbRow {
  feature_id: string;
  payload: unknown;
}

interface CountRow {
  total: number | string | null;
  active: number | string | null;
  newest_created_ms?: number | string | null;
  created_after_cutover?: number | string | null;
  created_after_retirement?: number | string | null;
}

interface RetirementControlRow {
  cutover_value: string | null;
  ledger_total: number | string | null;
  legacy_newest_created_ms: number | string | null;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  let current = value;
  for (let i = 0; i < 2 && typeof current === 'string'; i += 1) {
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      return null;
    }
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null;
}

function isQueueState(value: unknown): value is QueueReceiptState {
  return (
    value === 'queued' ||
    value === 'eligible' ||
    value === 'leased' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'superseded' ||
    value === 'expired'
  );
}

function legacyStored(row: LegacyDbRow): StoredAdmissionRecord {
  const payload = jsonObject(row.payload);
  const raw = jsonObject(payload?.[RESOURCE_GOVERNOR_PAYLOAD_KEY]);
  if (
    !raw ||
    raw.schemaVersion !== RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION ||
    typeof raw.namespace !== 'string' ||
    typeof raw.idempotencyKey !== 'string' ||
    typeof raw.requestFingerprint !== 'string' ||
    typeof raw.admissionClass !== 'string' ||
    typeof raw.priority !== 'number' ||
    typeof raw.enqueuedAtMs !== 'number' ||
    typeof raw.updatedAtMs !== 'number' ||
    !isQueueState(raw.state)
  ) {
    throw new AdmissionPersistenceError(`legacy work-item ${row.feature_id} carries a corrupt governor record`);
  }
  return { receiptId: row.feature_id, record: raw as unknown as DurableAdmissionRecord };
}

function nextDecision(
  record: DurableAdmissionRecord,
  state: QueueReceiptState,
  nowMs: number,
  reason: string,
  evidence: Readonly<Record<string, DecisionValue>> = {},
): DurableAdmissionRecord {
  const transitionAtMs = Math.max(nowMs, record.enqueuedAtMs, record.updatedAtMs);
  return {
    ...record,
    state,
    updatedAtMs: transitionAtMs,
    decision: {
      generation: record.decision.generation + 1,
      atMs: transitionAtMs,
      reason,
      evidence,
    },
  };
}

function count(value: number | string | null | undefined): number {
  if (value === null || value === undefined) {
    throw new AdmissionPersistenceError('resource-governor cutover census returned an unmeasured count');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AdmissionPersistenceError(`resource-governor cutover census returned invalid count '${String(value)}'`);
  }
  return parsed;
}

function optionalCount(value: number | string | null | undefined): number | null {
  return value === null || value === undefined ? null : count(value);
}

function aggregateReconciliation(
  legacy: QueueReconciliationResult,
  ledger: QueueReconciliationResult,
): QueueReconciliationResult {
  return {
    requeued: legacy.requeued + ledger.requeued,
    expired: legacy.expired + ledger.expired,
    abandoned: legacy.abandoned + ledger.abandoned,
    total: legacy.total + ledger.total,
  };
}

/**
 * The only transaction-bound access the ledger writer has to work_items.
 * There is intentionally no insert method on this adapter.
 */
class LegacyWorkItemAdmissionAdapter implements AdmissionLedgerLegacyAdapter {
  constructor(private readonly workspaceId: string) {}

  async findIdentity(tx: SqlClient, namespace: string, idempotencyKey: string): Promise<StoredAdmissionRecord | null> {
    const rows = await tx<LegacyDbRow[]>`
      SELECT feature_id, payload
        FROM harness_shared.work_items
       WHERE workspace_id = ${this.workspaceId}
         AND payload->'resource_governor'->>'schemaVersion' = ${String(RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION)}
         AND payload->'resource_governor'->>'namespace' = ${namespace}
         AND payload->'resource_governor'->>'idempotencyKey' = ${idempotencyKey}
       ORDER BY feature_id ASC
       FOR UPDATE
       LIMIT 2`;
    if (rows.length > 1) {
      throw new AdmissionPersistenceError(
        `legacy work_items contains multiple resource-governor identities for '${namespace}/${idempotencyKey}'`,
      );
    }
    return rows[0] ? legacyStored(rows[0]) : null;
  }

  async supersedeActiveCoalesce(tx: SqlClient, record: DurableAdmissionRecord): Promise<void> {
    if (!record.coalesceKey) return;
    const rows = await tx<LegacyDbRow[]>`
      SELECT feature_id, payload
        FROM harness_shared.work_items
       WHERE workspace_id = ${this.workspaceId}
         AND payload->'resource_governor'->>'schemaVersion' = ${String(RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION)}
         AND payload->'resource_governor'->>'namespace' = ${record.namespace}
         AND payload->'resource_governor'->>'coalesceKey' = ${record.coalesceKey}
         AND payload->'resource_governor'->>'state' IN ('queued', 'eligible', 'leased', 'running')
       ORDER BY feature_id ASC
       FOR UPDATE`;
    for (const row of rows) {
      const prior = legacyStored(row);
      const superseded: DurableAdmissionRecord = {
        ...nextDecision(prior.record, 'superseded', record.enqueuedAtMs, 'coalesced-by-newer-request', {
          idempotencyKey: record.idempotencyKey,
        }),
        lease: undefined,
      };
      const updated = await tx<LegacyDbRow[]>`
        UPDATE harness_shared.work_items
           SET payload = jsonb_set(
                 COALESCE(payload, '{}'::jsonb)
                   - '_claimHold' - 'held_open_by' - 'held_open_reason' - 'held_open_at'
                   - 'claim_hold_by' - 'claim_hold_reason' - 'claim_hold_at',
                 ARRAY['resource_governor']::text[],
                 ${JSON.stringify(superseded)}::text::jsonb,
                 true
               ),
               status = 'dropped',
               taken_by = NULL,
               taken_at = NULL,
               updated_ts = ${record.enqueuedAtMs}
         WHERE workspace_id = ${this.workspaceId}
           AND feature_id = ${prior.receiptId}
         RETURNING feature_id, payload`;
      if (!updated[0]) {
        throw new AdmissionPersistenceError(
          `legacy resource-governor receipt ${prior.receiptId} disappeared during cutover coalescing`,
        );
      }
    }
  }
}

export interface PgAdmissionCutoverQueueStoreOptions {
  readonly sql?: SqlClient;
  readonly workspaceId?: string;
  readonly abandonAfterMs?: number;
  readonly resolveSessionStatesFn?: ResolveSessionStates;
}

/** Positive-control census that gates removal of the bounded legacy adapter. */
export interface AdmissionCutoverCensus {
  readonly cutoverLatched: boolean;
  readonly cutoverAtMs: number | null;
  readonly legacyWritersRetired: boolean;
  readonly legacyWritersRetiredAtMs: number | null;
  readonly ledgerTotal: number;
  readonly ledgerActive: number;
  readonly legacyTotal: number;
  readonly legacyActive: number;
  readonly legacyTerminal: number;
  readonly legacyNewestCreatedMs: number | null;
  readonly legacyCreatedAfterCutover: number;
  readonly legacyCreatedAfterRetirement: number;
  /** P-005 may delete terminal legacy rows only after this becomes true. */
  readonly terminalLegacyDeletionReady: boolean;
}

/**
 * Composite compatibility store used only for the rolling deployment window.
 *
 * - enqueue is one advisory-locked ledger transaction that also inspects and
 *   coalesces legacy identities;
 * - receipt-targeted transitions route by opaque identity prefix;
 * - bounded legacy work is leased before new ledger work so the adapter cannot
 *   starve under a continuously non-empty new queue;
 * - reconciliation covers both stores, while retention remains a later P-005
 *   concern.
 */
export class PgAdmissionCutoverQueueStore implements DurableAdmissionQueueStore {
  private readonly sql: SqlClient;
  private readonly workspaceId: string;
  private readonly ledger: PgAdmissionLedgerQueueStore;
  private readonly legacy: PgWorkItemAdmissionQueueStore;

  constructor(options: PgAdmissionCutoverQueueStoreOptions = {}) {
    this.sql = options.sql ?? getOrgPg().sql;
    this.workspaceId = options.workspaceId?.trim() || activeWorkspaceId();
    const shared = {
      sql: this.sql,
      workspaceId: this.workspaceId,
      ...(options.abandonAfterMs ? { abandonAfterMs: options.abandonAfterMs } : {}),
      ...(options.resolveSessionStatesFn ? { resolveSessionStatesFn: options.resolveSessionStatesFn } : {}),
    };
    this.legacy = new PgWorkItemAdmissionQueueStore(shared);
    this.ledger = new PgAdmissionLedgerQueueStore({
      ...shared,
      legacyAdapter: new LegacyWorkItemAdmissionAdapter(this.workspaceId),
    });
  }

  enqueue(record: DurableAdmissionRecord): Promise<StoredAdmissionRecord & { readonly created: boolean }> {
    return this.ledger.enqueue(record);
  }

  private async findAcrossStores(namespace: string, idempotencyKey: string): Promise<StoredAdmissionRecord | null> {
    const [ledger, legacy] = await Promise.all([
      this.ledger.find(namespace, idempotencyKey),
      this.legacy.find(namespace, idempotencyKey),
    ]);
    if (ledger && legacy) {
      throw new AdmissionPersistenceError(
        `resource-governor identity '${namespace}/${idempotencyKey}' exists in both ` +
          `the admission ledger (${ledger.receiptId}) and legacy work_items (${legacy.receiptId})`,
      );
    }
    return ledger ?? legacy;
  }

  find(namespace: string, idempotencyKey: string): Promise<StoredAdmissionRecord | null> {
    return this.findAcrossStores(namespace, idempotencyKey);
  }

  async cancel(
    namespace: string,
    idempotencyKey: string,
    reason: string | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    const found = await this.findAcrossStores(namespace, idempotencyKey);
    if (!found) return null;
    return this.storeForReceipt(found.receiptId).cancel(namespace, idempotencyKey, reason, nowMs);
  }

  async leaseNext(
    namespace: string,
    owner: string,
    leaseId: string,
    ttlMs: number,
    nowMs: number,
    selection?: QueueLeaseSelection,
  ): Promise<QueueMutationResult | null> {
    const legacy = await this.legacy.leaseNext(namespace, owner, leaseId, ttlMs, nowMs, selection);
    if (legacy) return legacy;
    return this.ledger.leaseNext(namespace, owner, leaseId, ttlMs, nowMs, selection);
  }

  leaseReceipt(
    namespace: string,
    receiptId: string,
    owner: string,
    leaseId: string,
    ttlMs: number,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    return this.storeForReceipt(receiptId).leaseReceipt(namespace, receiptId, owner, leaseId, ttlMs, nowMs);
  }

  markRunning(receiptId: string, leaseId: string, nowMs: number): Promise<QueueMutationResult | null> {
    return this.storeForReceipt(receiptId).markRunning(receiptId, leaseId, nowMs);
  }

  complete(
    receiptId: string,
    leaseId: string,
    resultRef: string | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    return this.storeForReceipt(receiptId).complete(receiptId, leaseId, resultRef, nowMs);
  }

  releaseLease(receiptId: string, leaseId: string, nowMs: number): Promise<QueueMutationResult | null> {
    return this.storeForReceipt(receiptId).releaseLease(receiptId, leaseId, nowMs);
  }

  releaseClaim(
    receiptId: string,
    leaseId: string,
    actualDemand: Readonly<ResourceDemand> | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    return this.storeForReceipt(receiptId).releaseClaim(receiptId, leaseId, actualDemand, nowMs);
  }

  supersede(receiptId: string, replacementReceiptId: string, nowMs: number): Promise<QueueMutationResult | null> {
    return this.storeForReceipt(receiptId).supersede(receiptId, replacementReceiptId, nowMs);
  }

  async reconcileExpired(namespace: string, nowMs: number): Promise<QueueReconciliationResult> {
    // Both stores use the same workspace reconciliation advisory lock, so these
    // passes must be sequential rather than Promise.all (where one would skip).
    const legacy = await this.legacy.reconcileExpired(namespace, nowMs);
    const ledger = await this.ledger.reconcileExpired(namespace, nowMs);
    return aggregateReconciliation(legacy, ledger);
  }

  readQueuePopulation(
    nowMs = Date.now(),
    observationWindowMs = GOVERNOR_QUEUE_OBSERVATION_WINDOW_MS,
  ): Promise<GovernorQueuePopulationObservation[]> {
    return this.ledger.readQueuePopulation(nowMs, observationWindowMs);
  }

  readGovernorQueuePopulation(
    nowMs = Date.now(),
    observationWindowMs = GOVERNOR_QUEUE_OBSERVATION_WINDOW_MS,
  ): Promise<GovernorQueuePopulationObservation[]> {
    return this.readQueuePopulation(nowMs, observationWindowMs);
  }

  async reconcileExpiredAll(nowMs = Date.now()): Promise<QueueReconciliationResult> {
    const legacy = await this.legacy.reconcileExpiredAll(nowMs);
    const ledger = await this.ledger.reconcileExpiredAll(nowMs);
    return aggregateReconciliation(legacy, ledger);
  }

  /**
   * Establish the explicit end of old-writer overlap.
   *
   * The table lock drains any already-started INSERT and blocks the next one until
   * the marker commits. Migration 1073 then rejects every later legacy admission,
   * turning a measured edge into a stable boundary. The newest-row CAS prevents a
   * caller from marking retirement from a stale census.
   */
  async markLegacyWritersRetired(
    expectedLegacyNewestCreatedMs: number | null,
    nowMs = Date.now(),
  ): Promise<AdmissionCutoverCensus> {
    const retiredAtMs = Math.floor(nowMs);
    if (!Number.isSafeInteger(retiredAtMs) || retiredAtMs < 0) {
      throw new AdmissionPersistenceError(`invalid legacy-writer retirement time '${String(nowMs)}'`);
    }
    if (
      expectedLegacyNewestCreatedMs !== null &&
      (!Number.isSafeInteger(expectedLegacyNewestCreatedMs) || expectedLegacyNewestCreatedMs < 0)
    ) {
      throw new AdmissionPersistenceError(
        `invalid expected newest legacy receipt time '${String(expectedLegacyNewestCreatedMs)}'`,
      );
    }
    const cutoverKey = `${RESOURCE_GOVERNOR_LEDGER_CUTOVER_SETTING_PREFIX}${this.workspaceId}`;
    const retiredKey = `${RESOURCE_GOVERNOR_LEGACY_WRITERS_RETIRED_SETTING_PREFIX}${this.workspaceId}`;
    await boundedOrgTxn(
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governor-retire:${this.workspaceId}`}, 0))`;
        await tx`LOCK TABLE harness_shared.work_items IN SHARE ROW EXCLUSIVE MODE`;
        const rows = await tx<RetirementControlRow[]>`
          SELECT (
                   SELECT value
                     FROM harness_shared.operator_settings
                    WHERE key = ${cutoverKey}
                    LIMIT 1
                 ) AS cutover_value,
                 (
                   SELECT count(*)::bigint
                     FROM harness_shared.resource_governor_admissions
                    WHERE workspace_id = ${this.workspaceId}
                 ) AS ledger_total,
                 (
                   SELECT max(created_ts)::bigint
                     FROM harness_shared.work_items
                    WHERE workspace_id = ${this.workspaceId}
                      AND payload->'resource_governor'->>'schemaVersion' = ${String(
                        RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION,
                      )}
                 ) AS legacy_newest_created_ms`;
        const control = rows[0];
        if (control?.cutover_value !== '1' || count(control?.ledger_total) === 0) {
          throw new AdmissionPersistenceError(
            'legacy writers cannot be retired before the ledger cutover latch and a positive ledger row exist',
          );
        }
        const currentNewest = optionalCount(control.legacy_newest_created_ms);
        if (currentNewest !== expectedLegacyNewestCreatedMs) {
          throw new AdmissionPersistenceError(
            `legacy receipt census changed before retirement: expected newest ${String(
              expectedLegacyNewestCreatedMs,
            )}, measured ${String(currentNewest)}`,
          );
        }
        await tx`
          INSERT INTO harness_shared.operator_settings (
            key, value, description, updated_at, workspace_id
          ) VALUES (
            ${retiredKey},
            '1',
            'Every independently deployed resource-governor writer is ledger-only; reject all later legacy work_items admissions.',
            ${retiredAtMs},
            ${this.workspaceId}
          )
          ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            description = EXCLUDED.description,
            updated_at = EXCLUDED.updated_at,
            workspace_id = EXCLUDED.workspace_id`;
      },
      { client: this.sql },
    );
    const census = await this.readCutoverCensus();
    if (!census.legacyWritersRetired || census.legacyWritersRetiredAtMs !== retiredAtMs) {
      throw new AdmissionPersistenceError('legacy-writer retirement marker did not persist at the requested boundary');
    }
    return census;
  }

  async readCutoverCensus(): Promise<AdmissionCutoverCensus> {
    const cutoverKey = `${RESOURCE_GOVERNOR_LEDGER_CUTOVER_SETTING_PREFIX}${this.workspaceId}`;
    const retiredKey = `${RESOURCE_GOVERNOR_LEGACY_WRITERS_RETIRED_SETTING_PREFIX}${this.workspaceId}`;
    const settingRows = await this.sql<Array<{ key: string; value: string; updated_at: number | string | null }>>`
      SELECT key, value, updated_at
        FROM harness_shared.operator_settings
       WHERE key IN (${cutoverKey}, ${retiredKey})`;
    const latch = settingRows.find((row) => row.key === cutoverKey);
    const retired = settingRows.find((row) => row.key === retiredKey);
    const cutoverLatched = latch?.value === '1';
    const cutoverAtMs = cutoverLatched ? count(latch?.updated_at) : null;
    const legacyWritersRetired = retired?.value === '1';
    const legacyWritersRetiredAtMs = legacyWritersRetired ? count(retired?.updated_at) : null;
    const [ledgerRows, legacyRows] = await Promise.all([
      this.sql<CountRow[]>`
        SELECT count(*)::bigint AS total,
               count(*) FILTER (WHERE state IN ('queued', 'eligible', 'leased', 'running'))::bigint AS active
          FROM harness_shared.resource_governor_admissions
         WHERE workspace_id = ${this.workspaceId}`,
      this.sql<CountRow[]>`
        SELECT count(*)::bigint AS total,
               count(*) FILTER (
                 WHERE payload->'resource_governor'->>'state' IN ('queued', 'eligible', 'leased', 'running')
               )::bigint AS active,
               max(created_ts)::bigint AS newest_created_ms,
               count(*) FILTER (
                 WHERE ${cutoverAtMs}::bigint IS NOT NULL
                   AND created_ts > ${cutoverAtMs}
               )::bigint AS created_after_cutover,
               count(*) FILTER (
                 WHERE ${legacyWritersRetiredAtMs}::bigint IS NOT NULL
                   AND created_ts > ${legacyWritersRetiredAtMs}
               )::bigint AS created_after_retirement
          FROM harness_shared.work_items
         WHERE workspace_id = ${this.workspaceId}
           AND payload->'resource_governor'->>'schemaVersion' = ${String(RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION)}`,
    ]);
    const ledgerTotal = count(ledgerRows[0]?.total);
    const ledgerActive = count(ledgerRows[0]?.active);
    const legacyTotal = count(legacyRows[0]?.total);
    const legacyActive = count(legacyRows[0]?.active);
    const legacyNewestCreatedMs = optionalCount(legacyRows[0]?.newest_created_ms);
    const legacyCreatedAfterCutover = count(legacyRows[0]?.created_after_cutover);
    const legacyCreatedAfterRetirement = count(legacyRows[0]?.created_after_retirement);
    return {
      cutoverLatched,
      cutoverAtMs,
      legacyWritersRetired,
      legacyWritersRetiredAtMs,
      ledgerTotal,
      ledgerActive,
      legacyTotal,
      legacyActive,
      legacyTerminal: legacyTotal - legacyActive,
      legacyNewestCreatedMs,
      legacyCreatedAfterCutover,
      legacyCreatedAfterRetirement,
      terminalLegacyDeletionReady:
        cutoverLatched &&
        legacyWritersRetired &&
        ledgerTotal > 0 &&
        legacyActive === 0 &&
        legacyCreatedAfterRetirement === 0,
    };
  }

  private storeForReceipt(receiptId: string): DurableAdmissionQueueStore {
    if (receiptId.startsWith('RG-')) return this.ledger;
    if (receiptId.startsWith('WI-')) return this.legacy;
    throw new AdmissionPersistenceError(
      `resource-governor receipt '${receiptId}' has neither an RG ledger identity nor a WI legacy identity`,
    );
  }
}
