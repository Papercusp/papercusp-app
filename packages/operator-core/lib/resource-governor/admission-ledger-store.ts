/**
 * PostgreSQL persistence for the existing resource-governor admission queue.
 *
 * Unlike the bounded legacy adapter, this store has no work-item dependency:
 * every new receipt is an RG-UUID row in resource_governor_admissions.
 */
import { getOrgPg, withDbCallDeadline } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { boundedOrgTxn } from '../pg-bounded-txn';
import { AdmissionPersistenceError, type QueueReceiptState } from './admission';
import {
  GOVERNOR_QUEUE_OBSERVATION_WINDOW_MS,
  GOVERNOR_RECEIPT_ABANDON_MS,
  RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION,
  type DurableAdmissionQueueStore,
  type DurableAdmissionRecord,
  type QueueLeaseSelection,
  type QueueLeaseOwnerObservation,
  type GovernorQueuePopulationObservation,
  type QueueMutationResult,
  type QueueReconciliationResult,
  type SqlClient,
  type StoredAdmissionRecord,
  RESOURCE_GOVERNOR_LIVENESS_READ_DEADLINE_MS,
  EndedLeaseOwnerScanCoalescer,
  selectEndedLeaseOwners,
  readGovernorQueuePopulation,
} from './queue';

const RECONCILE_LOCK_PREFIX = 'resource-governor-reconcile:';
const RECONCILE_BATCH_SIZE = 25;
export const RESOURCE_GOVERNOR_LEDGER_CUTOVER_SETTING_PREFIX = 'resource_governor_admission_ledger_cutover:';
export const RESOURCE_GOVERNOR_LEGACY_WRITERS_RETIRED_SETTING_PREFIX =
  'resource_governor_admission_legacy_writers_retired:';

type ResolveSessionStates = typeof import('../agent-tools/coordination/liveness-oracle').resolveSessionStates;

type DecisionValue = string | number | boolean | null;

interface LedgerDbRow {
  receipt_id: string;
  record: unknown;
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

function durableRecord(value: unknown, receiptId: string): DurableAdmissionRecord {
  const raw = jsonObject(value);
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
    throw new AdmissionPersistenceError(`resource-governor admission ${receiptId} carries a corrupt ledger record`);
  }
  return raw as unknown as DurableAdmissionRecord;
}

function storedFromRow(row: LedgerDbRow): StoredAdmissionRecord {
  return { receiptId: row.receipt_id, record: durableRecord(row.record, row.receipt_id) };
}

function activeState(state: QueueReceiptState): boolean {
  return state === 'queued' || state === 'eligible' || state === 'leased' || state === 'running';
}

function nextDecision(
  record: DurableAdmissionRecord,
  state: QueueReceiptState,
  nowMs: number,
  reason: string,
  evidence: Readonly<Record<string, DecisionValue>> = {},
): DurableAdmissionRecord {
  // A newer request can carry an earlier wall-clock reading than an existing
  // receipt (different hosts or a clock adjustment). Never move a receipt's
  // persisted transition behind its enqueue/previous transition timestamp.
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

export interface PgAdmissionLedgerQueueStoreOptions {
  readonly sql?: SqlClient;
  readonly workspaceId?: string;
  readonly abandonAfterMs?: number;
  /** Injectable shared liveness oracle for owner-death lease reclamation. */
  readonly resolveSessionStatesFn?: ResolveSessionStates;
  /** Bounded pre-cutover work-item adapter. Omitted for the ledger-only store. */
  readonly legacyAdapter?: AdmissionLedgerLegacyAdapter;
  /**
   * Reuse a settled ended-lease-owner scan on the lease hot path for this many ms
   * (see EndedLeaseOwnerScanCoalescer). Default 0: concurrent callers still share
   * an in-flight scan, but sequential callers each read fresh state.
   */
  readonly endedLeaseOwnerReuseMs?: number;
}

/**
 * Transaction-bound compatibility seam used only during the rolling cutover.
 * It deliberately cannot create a legacy receipt: enqueue remains ledger-only.
 */
export interface AdmissionLedgerLegacyAdapter {
  findIdentity(tx: SqlClient, namespace: string, idempotencyKey: string): Promise<StoredAdmissionRecord | null>;
  supersedeActiveCoalesce(tx: SqlClient, record: DurableAdmissionRecord): Promise<void>;
}

/** Ledger-only implementation. Legacy WI receipt compatibility is composed outside this class. */
export class PgAdmissionLedgerQueueStore implements DurableAdmissionQueueStore {
  private readonly sql: SqlClient;
  private readonly workspaceId: string;
  private readonly abandonAfterMs: number;
  private readonly resolveSessionStatesFn: ResolveSessionStates | undefined;
  private readonly legacyAdapter: AdmissionLedgerLegacyAdapter | undefined;
  private readonly endedOwnerScans: EndedLeaseOwnerScanCoalescer;

  constructor(options: PgAdmissionLedgerQueueStoreOptions = {}) {
    this.endedOwnerScans = new EndedLeaseOwnerScanCoalescer(options.endedLeaseOwnerReuseMs);
    this.sql = options.sql ?? getOrgPg().sql;
    this.workspaceId = options.workspaceId?.trim() || activeWorkspaceId();
    this.abandonAfterMs =
      typeof options.abandonAfterMs === 'number' &&
      Number.isFinite(options.abandonAfterMs) &&
      options.abandonAfterMs > 0
        ? options.abandonAfterMs
        : GOVERNOR_RECEIPT_ABANDON_MS;
    this.resolveSessionStatesFn = options.resolveSessionStatesFn;
    this.legacyAdapter = options.legacyAdapter;
  }

  private transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return boundedOrgTxn(fn, { client: this.sql });
  }

  /** Complete ledger + bounded-overlap population used by governor snapshots. */
  readQueuePopulation(
    nowMs = Date.now(),
    observationWindowMs = GOVERNOR_QUEUE_OBSERVATION_WINDOW_MS,
  ): Promise<GovernorQueuePopulationObservation[]> {
    return readGovernorQueuePopulation(this.sql, this.workspaceId, nowMs, observationWindowMs);
  }

  readGovernorQueuePopulation(
    nowMs = Date.now(),
    observationWindowMs = GOVERNOR_QUEUE_OBSERVATION_WINDOW_MS,
  ): Promise<GovernorQueuePopulationObservation[]> {
    return this.readQueuePopulation(nowMs, observationWindowMs);
  }

  private async lockKeys(tx: SqlClient, keys: readonly string[]): Promise<void> {
    for (const key of [...new Set(keys)].sort()) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    }
  }

  private async latchCutover(tx: SqlClient): Promise<void> {
    const key = `${RESOURCE_GOVERNOR_LEDGER_CUTOVER_SETTING_PREFIX}${this.workspaceId}`;
    await tx`
      INSERT INTO harness_shared.operator_settings (
        key, value, description, updated_at, workspace_id
      ) VALUES (
        ${key},
        '1',
        'New-code resource-governor admissions are ledger-only; bound old-writer overlap with cross-store collision guards.',
        ${Date.now()},
        ${this.workspaceId}
      )
      ON CONFLICT (key) DO NOTHING`;
    const rows = await tx<{ value: string }[]>`
      SELECT value
        FROM harness_shared.operator_settings
       WHERE key = ${key}
       LIMIT 1`;
    if (rows[0]?.value !== '1') {
      throw new AdmissionPersistenceError(`resource-governor ledger cutover latch ${key} is missing or not enabled`);
    }
  }

  private async findRow(
    sql: SqlClient,
    namespace: string,
    idempotencyKey: string,
    lock = false,
  ): Promise<LedgerDbRow | null> {
    const rows = await sql<LedgerDbRow[]>`
      SELECT receipt_id, record
        FROM harness_shared.resource_governor_admissions
       WHERE workspace_id = ${this.workspaceId}
         AND namespace = ${namespace}
         AND idempotency_key = ${idempotencyKey}
       ${lock ? sql`FOR UPDATE` : sql``}
       LIMIT 1`;
    return rows[0] ?? null;
  }

  private async findReceiptRow(sql: SqlClient, receiptId: string, lock = false): Promise<LedgerDbRow | null> {
    const rows = await sql<LedgerDbRow[]>`
      SELECT receipt_id, record
        FROM harness_shared.resource_governor_admissions
       WHERE workspace_id = ${this.workspaceId}
         AND receipt_id = ${receiptId}
       ${lock ? sql`FOR UPDATE` : sql``}
       LIMIT 1`;
    return rows[0] ?? null;
  }

  private async writeRecord(
    sql: SqlClient,
    receiptId: string,
    record: DurableAdmissionRecord,
  ): Promise<StoredAdmissionRecord> {
    const rows = await sql<LedgerDbRow[]>`
      UPDATE harness_shared.resource_governor_admissions
         SET record = ${JSON.stringify(record)}::text::jsonb
       WHERE workspace_id = ${this.workspaceId}
         AND receipt_id = ${receiptId}
       RETURNING receipt_id, record`;
    if (!rows[0]) {
      throw new AdmissionPersistenceError(
        `canonical admission ledger receipt ${receiptId} disappeared during transition`,
      );
    }
    return storedFromRow(rows[0]);
  }

  async enqueue(record: DurableAdmissionRecord): Promise<StoredAdmissionRecord & { readonly created: boolean }> {
    return this.transaction(async (tx) => {
      const identityLock = `resource-governor:${this.workspaceId}:${record.namespace}:id:${record.idempotencyKey}`;
      const coalesceLock = record.coalesceKey
        ? `resource-governor:${this.workspaceId}:${record.namespace}:coalesce:${record.coalesceKey}`
        : identityLock;
      await this.lockKeys(tx, [identityLock, coalesceLock]);
      await this.latchCutover(tx);

      const existing = await this.findRow(tx, record.namespace, record.idempotencyKey, true);
      const legacy = await this.legacyAdapter?.findIdentity(tx, record.namespace, record.idempotencyKey);
      if (existing && legacy) {
        throw new AdmissionPersistenceError(
          `resource-governor identity '${record.namespace}/${record.idempotencyKey}' exists in both ` +
            `the admission ledger (${existing.receipt_id}) and legacy work_items (${legacy.receiptId})`,
        );
      }
      if (legacy) return { ...legacy, created: false };
      if (existing) return { ...storedFromRow(existing), created: false };

      if (record.coalesceKey) {
        await this.legacyAdapter?.supersedeActiveCoalesce(tx, record);
        const priorRows = await tx<LedgerDbRow[]>`
          SELECT receipt_id, record
            FROM harness_shared.resource_governor_admissions
           WHERE workspace_id = ${this.workspaceId}
             AND namespace = ${record.namespace}
             AND coalesce_key = ${record.coalesceKey}
             AND state IN ('queued', 'eligible', 'leased', 'running')
           FOR UPDATE`;
        for (const row of priorRows) {
          const prior = storedFromRow(row);
          const superseded: DurableAdmissionRecord = {
            ...nextDecision(prior.record, 'superseded', record.enqueuedAtMs, 'coalesced-by-newer-request', {
              idempotencyKey: record.idempotencyKey,
            }),
            lease: undefined,
          };
          await this.writeRecord(tx, prior.receiptId, superseded);
        }
      }

      const rows = await tx<LedgerDbRow[]>`
        INSERT INTO harness_shared.resource_governor_admissions (
          workspace_id, record
        ) VALUES (
          ${this.workspaceId}, ${JSON.stringify(record)}::text::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING receipt_id, record`;
      if (rows[0]) return { ...storedFromRow(rows[0]), created: true };
      const raced = await this.findRow(tx, record.namespace, record.idempotencyKey, true);
      const racedLegacy = await this.legacyAdapter?.findIdentity(tx, record.namespace, record.idempotencyKey);
      if (raced && racedLegacy) {
        throw new AdmissionPersistenceError(
          `resource-governor identity '${record.namespace}/${record.idempotencyKey}' raced into both ` +
            `the admission ledger (${raced.receipt_id}) and legacy work_items (${racedLegacy.receiptId})`,
        );
      }
      if (racedLegacy) return { ...racedLegacy, created: false };
      if (!raced) {
        throw new AdmissionPersistenceError('admission ledger insert returned no row and no durable receipt exists');
      }
      return { ...storedFromRow(raced), created: false };
    });
  }

  async find(namespace: string, idempotencyKey: string): Promise<StoredAdmissionRecord | null> {
    const row = await this.findRow(this.sql, namespace, idempotencyKey);
    return row ? storedFromRow(row) : null;
  }

  async cancel(
    namespace: string,
    idempotencyKey: string,
    reason: string | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    return this.transaction(async (tx) => {
      const row = await this.findRow(tx, namespace, idempotencyKey, true);
      if (!row) return null;
      const stored = storedFromRow(row);
      if (!activeState(stored.record.state)) return { ...stored, changed: false };
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'cancelled', nowMs, 'cancelled', {
          ...(reason ? { reason } : {}),
        }),
        lease: undefined,
        ...(reason ? { cancellationReason: reason } : {}),
      };
      return { ...(await this.writeRecord(tx, stored.receiptId, next)), changed: true };
    });
  }

  /** Read active ledger lease identities without taking row locks or mutating state. */
  async readActiveLeaseOwners(namespace: string | null = null): Promise<QueueLeaseOwnerObservation[]> {
    const namespacePredicate = namespace === null ? this.sql`` : this.sql`AND namespace = ${namespace}`;
    const rows = await withDbCallDeadline(
      this.sql<Array<{ receipt_id: string | null; lease_id: string | null; owner: string | null }>>`
        SELECT receipt_id,
               record->'lease'->>'leaseId' AS lease_id,
               lease_owner AS owner
          FROM harness_shared.resource_governor_admissions
         WHERE workspace_id = ${this.workspaceId}
           ${namespacePredicate}
           AND state IN ('leased', 'running')
           AND btrim(COALESCE(record->'lease'->>'leaseId', '')) <> ''
           AND lease_owner IS NOT NULL
         ORDER BY receipt_id ASC`,
      { ms: RESOURCE_GOVERNOR_LIVENESS_READ_DEADLINE_MS, label: 'resource-governor.ledger-liveness-read' },
    );
    return rows.flatMap((row) => {
      const receiptId = row.receipt_id?.trim();
      const leaseId = row.lease_id?.trim();
      const owner = row.owner?.trim();
      return receiptId && leaseId && owner ? [{ receiptId, leaseId, owner }] : [];
    });
  }

  /** Lease hot path: concurrent callers share one scan (WI-10004631). */
  private hotPathEndedLeaseOwners(namespace: string | null, nowMs: number): Promise<QueueLeaseOwnerObservation[]> {
    return this.endedOwnerScans.scan(namespace, nowMs, () => this.endedLeaseOwners(namespace, nowMs));
  }

  private async endedLeaseOwners(namespace: string | null, nowMs = Date.now()): Promise<QueueLeaseOwnerObservation[]> {
    let active: QueueLeaseOwnerObservation[];
    try {
      active = await this.readActiveLeaseOwners(namespace);
    } catch (error) {
      console.warn(
        `[resource-governor] ledger active lease liveness read failed: ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
    const owners = [...new Set(active.map((row) => row.owner))];
    if (owners.length === 0) return [];
    const resolve =
      this.resolveSessionStatesFn ?? (await import('../agent-tools/coordination/liveness-oracle')).resolveSessionStates;
    try {
      const verdicts = await resolve(
        owners.map((ownerId) => ({ ownerId })),
        // One owner-filtered presence read for the whole roster (WI-10004631);
        // per-id hydration issued one point read per active lease owner.
        { hydrateBatch: true, nowMs },
      );
      return selectEndedLeaseOwners(active, verdicts);
    } catch (error) {
      console.warn(
        `[resource-governor] ledger active lease liveness resolution failed: ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  private async selectReconcileRows(
    tx: SqlClient,
    namespace: string | null,
    state: 'lease' | 'deadline' | 'abandoned',
    nowMs: number,
  ): Promise<StoredAdmissionRecord[]> {
    const namespaceSql = namespace === null ? tx`` : tx`AND namespace = ${namespace}`;
    const stateSql =
      state === 'lease'
        ? tx`
            AND state IN ('leased', 'running')
            AND lease_expires_at_ms <= ${nowMs}`
        : state === 'deadline'
          ? tx`
              AND state IN ('queued', 'eligible')
              AND deadline_at_ms IS NOT NULL
              AND deadline_at_ms <= ${nowMs}`
          : tx`
              AND state IN ('queued', 'eligible')
              AND deadline_at_ms IS NULL
              AND updated_at_ms <= ${nowMs - this.abandonAfterMs}`;
    const rows = await tx<LedgerDbRow[]>`
      SELECT receipt_id, record
        FROM harness_shared.resource_governor_admissions
       WHERE workspace_id = ${this.workspaceId}
         ${namespaceSql}
         ${stateSql}
       ORDER BY updated_at_ms ASC, receipt_id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT ${RECONCILE_BATCH_SIZE}`;
    return rows.map(storedFromRow);
  }

  private async reconcileExpiredRows(
    tx: SqlClient,
    namespace: string | null,
    nowMs: number,
    endedLeaseOwners: readonly QueueLeaseOwnerObservation[] = [],
  ): Promise<QueueReconciliationResult> {
    const reconcileLock = `${RECONCILE_LOCK_PREFIX}${this.workspaceId}`;
    const lockRows = await tx<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${reconcileLock}, 0)) AS locked`;
    if (lockRows.length > 0 && lockRows[0]?.locked === false) {
      return { requeued: 0, expired: 0, abandoned: 0, total: 0 };
    }

    const ended =
      endedLeaseOwners.length === 0
        ? []
        : await tx<LedgerDbRow[]>`
            SELECT item.receipt_id, item.record
              FROM harness_shared.resource_governor_admissions AS item
              JOIN jsonb_to_recordset(${JSON.stringify(endedLeaseOwners)}::text::jsonb) AS identity(
                "receiptId" text,
                "leaseId" text,
                owner text
              )
                ON identity."receiptId" = item.receipt_id
             WHERE item.workspace_id = ${this.workspaceId}
               ${namespace === null ? tx`` : tx`AND item.namespace = ${namespace}`}
               AND item.state IN ('leased', 'running')
               AND item.record->'lease'->>'leaseId' = identity."leaseId"
               AND item.lease_owner = identity.owner
             ORDER BY item.updated_at_ms ASC, item.receipt_id ASC
             FOR UPDATE OF item SKIP LOCKED
             LIMIT ${RECONCILE_BATCH_SIZE}`;
    for (const row of ended) {
      const stored = storedFromRow(row);
      const identity = endedLeaseOwners.find((candidate) => candidate.receiptId === stored.receiptId);
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'queued', nowMs, 'owner-ended', {
          owner: identity?.owner ?? stored.record.lease?.owner ?? null,
          leaseId: identity?.leaseId ?? stored.record.lease?.leaseId ?? null,
          sessionState: 'ended',
        }),
        lease: undefined,
      };
      await this.writeRecord(tx, stored.receiptId, next);
    }

    const lapsed = await this.selectReconcileRows(tx, namespace, 'lease', nowMs);
    for (const stored of lapsed) {
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'queued', nowMs, 'lease-expired'),
        lease: undefined,
      };
      await this.writeRecord(tx, stored.receiptId, next);
    }

    const deadlines = await this.selectReconcileRows(tx, namespace, 'deadline', nowMs);
    for (const stored of deadlines) {
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'expired', nowMs, 'deadline-expired'),
        lease: undefined,
      };
      await this.writeRecord(tx, stored.receiptId, next);
    }

    const abandoned = await this.selectReconcileRows(tx, namespace, 'abandoned', nowMs);
    for (const stored of abandoned) {
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'expired', nowMs, 'abandoned-without-deadline'),
        lease: undefined,
      };
      await this.writeRecord(tx, stored.receiptId, next);
    }
    return {
      requeued: ended.length + lapsed.length,
      expired: deadlines.length,
      abandoned: abandoned.length,
      total: ended.length + lapsed.length + deadlines.length + abandoned.length,
    };
  }

  async reconcileExpired(namespace: string, nowMs: number): Promise<QueueReconciliationResult> {
    const endedLeaseOwners = await this.endedLeaseOwners(namespace, nowMs);
    return this.transaction((tx) => this.reconcileExpiredRows(tx, namespace, nowMs, endedLeaseOwners));
  }

  async reconcileExpiredAll(nowMs = Date.now()): Promise<QueueReconciliationResult> {
    const endedLeaseOwners = await this.endedLeaseOwners(null, nowMs);
    return this.transaction((tx) => this.reconcileExpiredRows(tx, null, nowMs, endedLeaseOwners));
  }

  async leaseNext(
    namespace: string,
    owner: string,
    leaseId: string,
    ttlMs: number,
    nowMs: number,
    selection?: QueueLeaseSelection,
  ): Promise<QueueMutationResult | null> {
    const endedLeaseOwners = await this.hotPathEndedLeaseOwners(namespace, nowMs);
    return this.transaction(async (tx) => {
      await this.reconcileExpiredRows(tx, namespace, nowMs, endedLeaseOwners);
      let rows: LedgerDbRow[];
      if (!selection) {
        rows = await tx<LedgerDbRow[]>`
          SELECT receipt_id, record
            FROM harness_shared.resource_governor_admissions
           WHERE workspace_id = ${this.workspaceId}
             AND namespace = ${namespace}
             AND state IN ('queued', 'eligible')
           ORDER BY priority DESC, enqueued_at_ms ASC, receipt_id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1`;
      } else {
        if (selection.classes.length === 0) return null;
        const policies = JSON.stringify(
          selection.classes.map((item) => ({
            admission_class: item.admissionClass,
            virtual_time: Number.isFinite(item.virtualTime) ? Math.max(0, item.virtualTime) : 0,
            weight: Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 1,
            constrained_resources: item.constrainedResources,
          })),
        );
        const releasedResources = JSON.stringify(selection.releasedResources);
        const agingIntervalMs = Math.max(1, Math.floor(selection.agingIntervalMs));
        const deadlineHorizonMs = Math.max(1, Math.floor(selection.deadlineHorizonMs));
        const affinityBonus = Math.max(0, selection.resourceAffinityBonus);
        const constrainedPenalty = Math.max(0, selection.constrainedResourcePenalty);
        rows = await tx<LedgerDbRow[]>`
          SELECT item.receipt_id, item.record
            FROM harness_shared.resource_governor_admissions AS item
            JOIN LATERAL (
              SELECT policy.*
                FROM jsonb_to_recordset(${policies}::text::jsonb) AS policy(
                  admission_class text,
                  virtual_time double precision,
                  weight double precision,
                  constrained_resources jsonb
                )
               WHERE policy.admission_class = item.admission_class
               LIMIT 1
            ) AS class_policy ON true
            CROSS JOIN LATERAL (
              SELECT
                (
                  SELECT count(*)
                    FROM jsonb_array_elements_text(
                      COALESCE(class_policy.constrained_resources, '[]'::jsonb)
                    ) AS resource(value)
                   WHERE CASE resource.value
                           WHEN 'cpu' THEN COALESCE((item.record->'demand'->>'cpuWeight')::double precision, 0)
                           WHEN 'memory' THEN COALESCE((item.record->'demand'->>'memoryBytes')::double precision, 0)
                           WHEN 'database' THEN COALESCE((item.record->'demand'->>'databaseConnections')::double precision, 0)
                           WHEN 'provider' THEN COALESCE((item.record->'demand'->>'providerRequests')::double precision, 0)
                           ELSE COALESCE(
                             (item.record->'demand'->'custom'->>('resource:' || resource.value))::double precision,
                             (item.record->'demand'->'custom'->>resource.value)::double precision,
                             0
                           )
                         END > 0
                      OR item.record->'metadata'->>'resourceAffinity' = resource.value
                ) AS constrained_count,
                (
                  SELECT count(*)
                    FROM jsonb_array_elements_text(${releasedResources}::text::jsonb) AS resource(value)
                   WHERE CASE resource.value
                           WHEN 'cpu' THEN COALESCE((item.record->'demand'->>'cpuWeight')::double precision, 0)
                           WHEN 'memory' THEN COALESCE((item.record->'demand'->>'memoryBytes')::double precision, 0)
                           WHEN 'database' THEN COALESCE((item.record->'demand'->>'databaseConnections')::double precision, 0)
                           WHEN 'provider' THEN COALESCE((item.record->'demand'->>'providerRequests')::double precision, 0)
                           ELSE COALESCE(
                             (item.record->'demand'->'custom'->>('resource:' || resource.value))::double precision,
                             (item.record->'demand'->'custom'->>resource.value)::double precision,
                             0
                           )
                         END > 0
                      OR item.record->'metadata'->>'resourceAffinity' = resource.value
                ) AS affinity_count
            ) AS resource_score
           WHERE item.workspace_id = ${this.workspaceId}
             AND item.namespace = ${namespace}
             AND item.state IN ('queued', 'eligible')
           ORDER BY class_policy.virtual_time ASC,
                    (
                      item.priority
                      + floor(GREATEST(0, ${nowMs} - item.enqueued_at_ms) / ${agingIntervalMs})
                      + CASE
                          WHEN item.deadline_at_ms IS NOT NULL
                          THEN GREATEST(
                            0,
                            ${deadlineHorizonMs} - GREATEST(0, item.deadline_at_ms - ${nowMs})
                          ) / ${agingIntervalMs}
                          ELSE 0
                        END
                      + resource_score.affinity_count * ${affinityBonus}
                      - resource_score.constrained_count * ${constrainedPenalty}
                    ) DESC,
                    item.enqueued_at_ms ASC,
                    item.receipt_id ASC
           FOR UPDATE OF item SKIP LOCKED
           LIMIT 1`;
      }
      if (!rows[0]) return null;
      const stored = storedFromRow(rows[0]);
      const generation = stored.record.decision.generation + 1;
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'leased', nowMs, 'leased', { owner }),
        lease: { leaseId, owner, generation, expiresAtMs: nowMs + ttlMs },
      };
      return { ...(await this.writeRecord(tx, stored.receiptId, next)), changed: true };
    });
  }

  async leaseReceipt(
    namespace: string,
    receiptId: string,
    owner: string,
    leaseId: string,
    ttlMs: number,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    const endedLeaseOwners = await this.hotPathEndedLeaseOwners(namespace, nowMs);
    return this.transaction(async (tx) => {
      await this.reconcileExpiredRows(tx, namespace, nowMs, endedLeaseOwners);
      const row = await this.findReceiptRow(tx, receiptId, true);
      if (!row) return null;
      const stored = storedFromRow(row);
      if (stored.record.namespace !== namespace) return { ...stored, changed: false };
      if (stored.record.state !== 'queued' && stored.record.state !== 'eligible') {
        return { ...stored, changed: false };
      }
      if (stored.record.deadlineAtMs !== null && stored.record.deadlineAtMs <= nowMs) {
        const expired: DurableAdmissionRecord = {
          ...nextDecision(stored.record, 'expired', nowMs, 'deadline-expired'),
          lease: undefined,
        };
        return { ...(await this.writeRecord(tx, receiptId, expired)), changed: false };
      }
      const generation = stored.record.decision.generation + 1;
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'leased', nowMs, 'observe-only-targeted-lease', { owner }),
        lease: { leaseId, owner, generation, expiresAtMs: nowMs + ttlMs },
      };
      return { ...(await this.writeRecord(tx, receiptId, next)), changed: true };
    });
  }

  private async leaseTransition(
    receiptId: string,
    leaseId: string,
    nowMs: number,
    mutate: (record: DurableAdmissionRecord) => DurableAdmissionRecord,
  ): Promise<QueueMutationResult | null> {
    return this.transaction(async (tx) => {
      const row = await this.findReceiptRow(tx, receiptId, true);
      if (!row) return null;
      const stored = storedFromRow(row);
      if (!stored.record.lease || stored.record.lease.leaseId !== leaseId) {
        return { ...stored, changed: false };
      }
      const next = mutate(stored.record);
      return { ...(await this.writeRecord(tx, receiptId, next)), changed: true };
    });
  }

  markRunning(receiptId: string, leaseId: string, nowMs: number): Promise<QueueMutationResult | null> {
    return this.leaseTransition(receiptId, leaseId, nowMs, (record) =>
      record.state === 'leased'
        ? nextDecision(record, 'running', nowMs, 'execution-started', {
            owner: record.lease?.owner ?? null,
          })
        : record,
    ).then((result) =>
      result && result.changed && result.record.state !== 'running' ? { ...result, changed: false } : result,
    );
  }

  complete(
    receiptId: string,
    leaseId: string,
    resultRef: string | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    return this.leaseTransition(receiptId, leaseId, nowMs, (record) => {
      if (record.state !== 'leased' && record.state !== 'running') return record;
      return {
        ...nextDecision(record, 'completed', nowMs, 'execution-completed', {
          ...(resultRef ? { resultRef } : {}),
        }),
        lease: undefined,
        ...(resultRef ? { resultRef } : {}),
      };
    }).then((result) =>
      result && result.changed && result.record.state !== 'completed' ? { ...result, changed: false } : result,
    );
  }

  releaseLease(receiptId: string, leaseId: string, nowMs: number): Promise<QueueMutationResult | null> {
    return this.leaseTransition(receiptId, leaseId, nowMs, (record) => {
      if (record.state !== 'leased' && record.state !== 'running') return record;
      return { ...nextDecision(record, 'queued', nowMs, 'lease-released'), lease: undefined };
    }).then((result) =>
      result && result.changed && result.record.state !== 'queued' ? { ...result, changed: false } : result,
    );
  }

  releaseClaim(
    receiptId: string,
    leaseId: string,
    actualDemand: DurableAdmissionRecord['actualDemand'] | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    return this.leaseTransition(receiptId, leaseId, nowMs, (record) => {
      if (record.state !== 'leased' && record.state !== 'running') return record;
      return {
        ...nextDecision(record, 'completed', nowMs, 'resources-released', {
          actualDemandReported: actualDemand !== undefined,
        }),
        lease: undefined,
        ...(actualDemand ? { actualDemand } : {}),
        releasedAtMs: nowMs,
      };
    }).then((result) =>
      result && result.changed && result.record.state !== 'completed' ? { ...result, changed: false } : result,
    );
  }

  async supersede(receiptId: string, replacementReceiptId: string, nowMs: number): Promise<QueueMutationResult | null> {
    return this.transaction(async (tx) => {
      const row = await this.findReceiptRow(tx, receiptId, true);
      if (!row) return null;
      const stored = storedFromRow(row);
      if (!activeState(stored.record.state)) return { ...stored, changed: false };
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'superseded', nowMs, 'superseded', {
          replacementReceiptId,
        }),
        lease: undefined,
        supersededByReceiptId: replacementReceiptId,
      };
      return { ...(await this.writeRecord(tx, receiptId, next)), changed: true };
    });
  }
}
