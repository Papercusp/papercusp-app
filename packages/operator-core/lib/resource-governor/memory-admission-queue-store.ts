/**
 * An in-memory `DurableAdmissionQueueStore` for hermetic tests.
 *
 * WHY THIS IS A MODULE AND NOT A FOURTH COPY
 * ------------------------------------------
 * Three test files independently grew their own near-identical `MemoryStore`
 * (`queue.test.ts`, `execution.test.ts`, `inference-gateway/durable-admission.test.ts`).
 * A fourth copy was the cheapest way to give P-014's restart property a store that
 * survives driver reconstruction, and it would also have been the fourth place a
 * receipt-state-machine change has to be mirrored by hand. This is that shared
 * seam instead, in the same spirit as `memoryGatewayPayloadSpool`.
 *
 * Rows are keyed by a nested namespace→key map rather than a joined string. The
 * hand-rolled copies joined on a NUL byte, which is correct at runtime but makes
 * the source unreadable to ripgrep and to `git diff`, and trips the repo's
 * `lint:no-control-bytes` green-checkpoint leg. Nesting removes the question.
 *
 * ⚠ `leaseNext` IS DELIBERATELY UNIMPLEMENTED — READ THIS BEFORE REACHING FOR IT.
 * The production `PgWorkItemAdmissionQueueStore` implements lease SELECTION in SQL:
 * class policy, weighted fair share, and aging all live in that query. Re-expressing
 * that ordering in TypeScript here would produce a test that passes against a
 * reimplementation of the scheduler rather than against the scheduler — the most
 * expensive kind of green. It returns `null`, exactly as all three hand-rolled
 * copies already did. A property that depends on lease ORDERING (work-conserving
 * priority, aging, fair share) must be proven either against the controller that
 * decides windows, or against the PG store in an `*.integration.test.ts`. Nothing
 * about queue ordering may be concluded from this seam.
 */

import { GOVERNOR_RECEIPT_ABANDON_MS } from './queue';
import type {
  DurableAdmissionQueueStore,
  DurableAdmissionRecord,
  QueueLeaseSelection,
  QueueMutationResult,
  StoredAdmissionRecord,
} from './queue';

export class MemoryAdmissionQueueStore implements DurableAdmissionQueueStore {
  #nextId = 0;
  /** namespace → idempotencyKey → row. Nested, so no separator can ever collide. */
  readonly #rows = new Map<string, Map<string, StoredAdmissionRecord>>();
  /** Set true to make `enqueue` throw, exercising the persistence-failure path. */
  fail = false;
  /**
   * No-deadline abandonment dwell, mirroring the PG store's `abandonAfterMs`.
   * Defaults to the production constant so this seam cannot quietly disagree with
   * the store it stands in for; a test that wants the floor to bite sets it small.
   */
  #abandonAfterMs: number = GOVERNOR_RECEIPT_ABANDON_MS;

  /** Override the abandonment dwell (ms). Returns `this` so it can be chained onto construction. */
  withAbandonAfterMs(ms: number): this {
    this.#abandonAfterMs = ms;
    return this;
  }

  #bucket(namespace: string): Map<string, StoredAdmissionRecord> {
    let bucket = this.#rows.get(namespace);
    if (!bucket) {
      bucket = new Map<string, StoredAdmissionRecord>();
      this.#rows.set(namespace, bucket);
    }
    return bucket;
  }

  #get(namespace: string, idempotencyKey: string): StoredAdmissionRecord | null {
    return this.#rows.get(namespace)?.get(idempotencyKey) ?? null;
  }

  #all(): StoredAdmissionRecord[] {
    const out: StoredAdmissionRecord[] = [];
    for (const bucket of this.#rows.values()) out.push(...bucket.values());
    return out;
  }

  #byReceipt(receiptId: string): StoredAdmissionRecord | null {
    return this.#all().find((row) => row.receiptId === receiptId) ?? null;
  }

  #replace(stored: StoredAdmissionRecord, record: DurableAdmissionRecord): StoredAdmissionRecord {
    const next = { receiptId: stored.receiptId, record };
    this.#bucket(record.namespace).set(record.idempotencyKey, next);
    return next;
  }

  async enqueue(record: DurableAdmissionRecord) {
    if (this.fail) throw new Error('persistence unavailable');
    const existing = this.#get(record.namespace, record.idempotencyKey);
    // The unique idempotency record is what makes a retry observe the FIRST
    // receipt instead of creating a second one. `created:false` is the signal the
    // driver uses to refuse a duplicate upstream execution.
    if (existing) return { ...existing, created: false };
    const stored = { receiptId: `WI-${++this.#nextId}`, record };
    this.#bucket(record.namespace).set(record.idempotencyKey, stored);
    return { ...stored, created: true };
  }

  async find(namespace: string, idempotencyKey: string) {
    return this.#get(namespace, idempotencyKey);
  }

  async reconcileExpired(namespace: string, nowMs: number) {
    let requeued = 0;
    let expired = 0;
    let abandoned = 0;
    for (const stored of this.#all()) {
      if (stored.record.namespace !== namespace) continue;
      let record = stored.record;
      if (
        (record.state === 'leased' || record.state === 'running') &&
        record.lease &&
        record.lease.expiresAtMs <= nowMs
      ) {
        record = {
          ...record,
          state: 'queued',
          updatedAtMs: nowMs,
          decision: {
            generation: record.decision.generation + 1,
            atMs: nowMs,
            reason: 'lease-expired',
            evidence: {},
          },
          lease: undefined,
        };
        this.#replace(stored, record);
        requeued += 1;
      }
      if (
        (record.state === 'queued' || record.state === 'eligible') &&
        record.deadlineAtMs !== null &&
        record.deadlineAtMs <= nowMs
      ) {
        this.#replace(stored, {
          ...record,
          state: 'expired',
          updatedAtMs: nowMs,
          decision: {
            generation: record.decision.generation + 1,
            atMs: nowMs,
            reason: 'deadline-expired',
            evidence: {},
          },
          lease: undefined,
        });
        expired += 1;
        continue;
      }
      // The no-deadline abandonment floor — mirrors the PG store's third branch.
      // See GOVERNOR_RECEIPT_ABANDON_MS in queue.ts for why this has to exist:
      // without it, a receipt requeued after its lease died is exempt from the
      // deadline branch above (it has no deadline) AND from receipt-gc (which
      // never sweeps an active state), so it lives forever. WI-1741497.
      if (
        (record.state === 'queued' || record.state === 'eligible') &&
        record.deadlineAtMs === null &&
        record.updatedAtMs <= nowMs - this.#abandonAfterMs
      ) {
        this.#replace(stored, {
          ...record,
          state: 'expired',
          updatedAtMs: nowMs,
          decision: {
            generation: record.decision.generation + 1,
            atMs: nowMs,
            reason: 'abandoned-without-deadline',
            evidence: {},
          },
          lease: undefined,
        });
        abandoned += 1;
      }
    }
    return { requeued, expired, abandoned, total: requeued + expired + abandoned };
  }

  async reconcileExpiredAll(nowMs: number) {
    let requeued = 0;
    let expired = 0;
    let abandoned = 0;
    for (const namespace of new Set(this.#all().map((row) => row.record.namespace))) {
      const result = await this.reconcileExpired(namespace, nowMs);
      requeued += result.requeued;
      expired += result.expired;
      abandoned += result.abandoned;
    }
    return { requeued, expired, abandoned, total: requeued + expired + abandoned };
  }

  async cancel(namespace: string, idempotencyKey: string, reason: string | undefined, nowMs: number) {
    const stored = this.#get(namespace, idempotencyKey);
    if (!stored) return null;
    const next = this.#replace(stored, {
      ...stored.record,
      state: 'cancelled',
      updatedAtMs: nowMs,
      decision: {
        generation: stored.record.decision.generation + 1,
        atMs: nowMs,
        reason: 'cancelled',
        evidence: reason ? { reason } : {},
      },
      lease: undefined,
    });
    return { ...next, changed: true };
  }

  /** See the module header: selection ordering is SQL-owned and not modelled here. */
  async leaseNext(
    _namespace: string,
    _owner: string,
    _leaseId: string,
    _ttlMs: number,
    _nowMs: number,
    _selection?: QueueLeaseSelection,
  ) {
    return null;
  }

  async leaseReceipt(
    namespace: string,
    receiptId: string,
    owner: string,
    leaseId: string,
    ttlMs: number,
    nowMs: number,
  ) {
    const stored = this.#byReceipt(receiptId);
    if (!stored || stored.record.namespace !== namespace || !['queued', 'eligible'].includes(stored.record.state)) {
      return stored ? { ...stored, changed: false } : null;
    }
    const generation = stored.record.decision.generation + 1;
    const next = this.#replace(stored, {
      ...stored.record,
      state: 'leased',
      updatedAtMs: nowMs,
      decision: { generation, atMs: nowMs, reason: 'leased', evidence: { owner } },
      lease: { leaseId, owner, generation, expiresAtMs: nowMs + ttlMs },
    });
    return { ...next, changed: true };
  }

  #mutate(
    receiptId: string,
    leaseId: string,
    fn: (record: DurableAdmissionRecord) => DurableAdmissionRecord,
  ): QueueMutationResult | null {
    const stored = this.#byReceipt(receiptId);
    if (!stored || stored.record.lease?.leaseId !== leaseId) return stored ? { ...stored, changed: false } : null;
    return { ...this.#replace(stored, fn(stored.record)), changed: true };
  }

  async markRunning(receiptId: string, leaseId: string, nowMs: number) {
    return this.#mutate(receiptId, leaseId, (record) => ({
      ...record,
      state: 'running',
      updatedAtMs: nowMs,
      decision: {
        generation: record.decision.generation + 1,
        atMs: nowMs,
        reason: 'execution-started',
        evidence: {},
      },
    }));
  }

  async complete(receiptId: string, leaseId: string, resultRef: string | undefined, nowMs: number) {
    // `evidence` is Readonly<Record<string, DecisionValue>> and DecisionValue is
    // string|number|boolean|null. Written inline, the ternary widens to
    // `{ resultRef: string } | { resultRef?: undefined }`, and that optional
    // `undefined` member is what the record type rejects. Naming the value with
    // its own annotation keeps the empty branch a plain record instead.
    const evidence: Record<string, string> = resultRef ? { resultRef } : {};
    return this.#mutate(receiptId, leaseId, (record) => ({
      ...record,
      state: 'completed',
      updatedAtMs: nowMs,
      decision: {
        generation: record.decision.generation + 1,
        atMs: nowMs,
        reason: 'execution-completed',
        evidence,
      },
      lease: undefined,
      ...(resultRef ? { resultRef } : {}),
    }));
  }

  async releaseLease(receiptId: string, leaseId: string, nowMs: number) {
    return this.#mutate(receiptId, leaseId, (record) => ({
      ...record,
      state: 'queued',
      updatedAtMs: nowMs,
      decision: {
        generation: record.decision.generation + 1,
        atMs: nowMs,
        reason: 'lease-released',
        evidence: {},
      },
      lease: undefined,
    }));
  }

  async releaseClaim(
    receiptId: string,
    leaseId: string,
    actualDemand: DurableAdmissionRecord['demand'] | undefined,
    nowMs: number,
  ) {
    return this.#mutate(receiptId, leaseId, (record) => ({
      ...record,
      state: 'completed',
      updatedAtMs: nowMs,
      decision: {
        generation: record.decision.generation + 1,
        atMs: nowMs,
        reason: 'resources-released',
        evidence: {},
      },
      lease: undefined,
      ...(actualDemand ? { actualDemand } : {}),
      releasedAtMs: nowMs,
    }));
  }

  async supersede(_receiptId: string, _replacementReceiptId: string, _nowMs: number) {
    return null;
  }

  /** Test helper: the receipt state for one idempotency key, or undefined. */
  state(namespace: string, idempotencyKey: string): string | undefined {
    return this.#get(namespace, idempotencyKey)?.record.state;
  }

  /** Test helper: how many distinct receipts exist, for duplicate-execution checks. */
  get size(): number {
    return this.#all().length;
  }

  /** Test helper: every stored record, for assertions over the whole queue. */
  records(): readonly StoredAdmissionRecord[] {
    return this.#all();
  }
}
