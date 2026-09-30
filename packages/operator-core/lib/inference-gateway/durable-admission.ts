/**
 * Durable admission adapter for the inference gateway.
 *
 * The gateway's HTTP compatibility seam expects an admitted request before it
 * invokes a provider handler.  The canonical admission ledger deliberately
 * exposes a two-stage lifecycle (enqueue -> lease -> running), so this driver
 * performs those transitions atomically from the gateway's point of view and
 * releases the durable claim when the handler settles.
 */
import { randomUUID } from 'node:crypto';
import {
  AdmissionPersistenceError,
  Governor,
  type AdmissionContext,
  type AdmissionDriver,
  type AdmissionMetadataValue,
  type AdmissionOutcome,
  type AdmissionRelease,
  type AdmissionRequest,
  type AdmissionStatus,
  type NormalizedAdmissionRequest,
  type ResourceDemand,
} from '../resource-governor/admission';
import { PgAdmissionCutoverQueueStore } from '../resource-governor/admission-cutover-store';
import { WorkItemAdmissionQueueDriver, type DurableAdmissionQueueStore } from '../resource-governor/queue';
import { GATEWAY_ADMISSION_BYPASS_REGISTRY, type GatewayAdmissionGovernor } from './admission-context';

const DEFAULT_NAMESPACE = 'inference-gateway';
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;
const LEASE_GRACE_MS = 5_000;
const MIN_LEASE_TTL_MS = 5_000;
const MAX_LEASE_TTL_MS = 30 * 60_000;

export interface DurableGatewayAdmissionOptions {
  /** Workspace owning the canonical admission-ledger rows. */
  readonly workspaceId?: string;
  /** Queue namespace, allowing gateway instances to share the ledger safely. */
  readonly namespace?: string;
  /** Stable lease owner; defaults to this gateway process. */
  readonly owner?: string;
  /** Default lease lifetime for requests without a useful deadline. */
  readonly leaseTtlMs?: number;
  readonly now?: () => number;
  /** Test seam; production uses the PG-backed canonical store. */
  readonly store?: DurableAdmissionQueueStore;
  readonly leaseIdFactory?: () => string;
}

function leaseTtlFor(context: AdmissionContext, fallback: number, nowMs: number): number {
  const deadline = context.deadlineAtMs;
  if (deadline !== undefined && deadline !== null && Number.isFinite(deadline) && deadline > nowMs) {
    return Math.min(MAX_LEASE_TTL_MS, Math.max(MIN_LEASE_TTL_MS, Math.floor(deadline - nowMs + LEASE_GRACE_MS)));
  }
  return fallback;
}

function ownerFrom(context: AdmissionContext, fallback: string): string {
  const value = context.metadata?.['gateway.ownerId'];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * AdmissionDriver that turns a persisted queue receipt into a running lease
 * before the gateway invokes its upstream handler.  Persistence failures are
 * propagated; no synthetic admission receipt is returned when a transition
 * cannot be recorded.
 */
export class DurableGatewayAdmissionDriver implements AdmissionDriver {
  readonly queue: WorkItemAdmissionQueueDriver;
  readonly namespace: string;
  readonly owner: string;
  readonly leaseTtlMs: number;
  readonly #now: () => number;

  constructor(options: DurableGatewayAdmissionOptions = {}) {
    this.namespace = options.namespace?.trim() || DEFAULT_NAMESPACE;
    this.owner = options.owner?.trim() || `gateway:${process.pid}`;
    const ttl = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.leaseTtlMs = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_LEASE_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
    const store = options.store ?? new PgAdmissionCutoverQueueStore({ workspaceId: options.workspaceId });
    this.queue = new WorkItemAdmissionQueueDriver(store, {
      namespace: this.namespace,
      now: this.#now,
      leaseIdFactory: options.leaseIdFactory ?? (() => randomUUID()),
    });
  }

  async admit(request: NormalizedAdmissionRequest, context: AdmissionContext): Promise<AdmissionOutcome> {
    // The gateway targets a freshly-persisted receipt directly and never calls
    // leaseNext, so opportunistic lease cleanup there cannot protect this
    // namespace. Reconcile first so a crashed/abandoned request cannot keep its
    // owner pinned forever or make an idempotent retry look permanently running.
    await this.queue.reconcileExpired();
    const queued = await this.queue.admit(request, context);
    if (queued.kind !== 'queued') return queued;

    // A receipt may be observed in a terminal/running state when a caller
    // retries with the same idempotency key.  Do not issue a second upstream
    // execution; the compatibility gateway treats this as an admission error
    // until result replay is wired by the durable response store.
    if (queued.receipt.state !== 'queued' && queued.receipt.state !== 'eligible') {
      throw new AdmissionPersistenceError(
        `durable gateway receipt '${queued.receipt.receiptId}' is already ${queued.receipt.state}`,
      );
    }

    const claim = await this.queue.leaseReceipt({
      receiptId: queued.receipt.receiptId,
      owner: ownerFrom(context, this.owner),
      ttlMs: leaseTtlFor(context, this.leaseTtlMs, this.#now()),
    });
    if (!claim) {
      await this.queue
        .cancel(request.idempotencyKey, 'durable gateway receipt could not be leased')
        .catch(() => undefined);
      throw new AdmissionPersistenceError(`durable gateway receipt '${queued.receipt.receiptId}' could not be leased`);
    }

    let running: Awaited<ReturnType<WorkItemAdmissionQueueDriver['markRunning']>>;
    try {
      running = await this.queue.markRunning(claim.receiptId, claim.lease.leaseId);
    } catch (error) {
      await this.queue.releaseLease(claim.receiptId, claim.lease.leaseId).catch(() => undefined);
      await this.queue
        .cancel(request.idempotencyKey, 'durable gateway running transition failed')
        .catch(() => undefined);
      throw error;
    }
    if (!running?.changed) {
      await this.queue.releaseLease(claim.receiptId, claim.lease.leaseId).catch(() => undefined);
      await this.queue
        .cancel(request.idempotencyKey, 'durable gateway running transition was rejected')
        .catch(() => undefined);
      throw new AdmissionPersistenceError(`durable gateway receipt '${claim.receiptId}' could not enter running state`);
    }

    return {
      kind: 'admitted',
      context: Object.freeze({ ...claim.context }),
      lease: Object.freeze({ ...claim.lease }),
    };
  }

  status(idempotencyKey: string): Promise<AdmissionStatus> {
    return this.queue.status(idempotencyKey);
  }

  cancel(idempotencyKey: string, reason?: string) {
    return this.queue.cancel(idempotencyKey, reason);
  }

  release(context: AdmissionContext, actualDemand?: ResourceDemand): Promise<AdmissionRelease> {
    return this.queue.release(context, actualDemand);
  }
}

/**
 * Gateway-facing facade. A fresh Governor is intentionally used per call: the
 * generic Governor caches an in-flight promise forever for process-local
 * idempotency, whereas this HTTP seam must consult the durable receipt on each
 * retry. The queue's unique idempotency record then rejects a second lease so a
 * retried request can never execute upstream twice.
 */
export class DurableGatewayAdmissionGovernor implements GatewayAdmissionGovernor {
  readonly driver: DurableGatewayAdmissionDriver;
  readonly #bypassKeys = GATEWAY_ADMISSION_BYPASS_REGISTRY;

  constructor(options: DurableGatewayAdmissionOptions = {}) {
    this.driver = new DurableGatewayAdmissionDriver(options);
  }

  admit(request: AdmissionRequest): Promise<AdmissionOutcome> {
    return new Governor(this.driver, { bypassKeys: this.#bypassKeys }).admit(request);
  }

  status(idempotencyKey: string): Promise<AdmissionStatus> {
    return this.driver.status(idempotencyKey);
  }

  cancel(idempotencyKey: string, reason?: string) {
    return this.driver.cancel(idempotencyKey, reason);
  }

  release(context: AdmissionContext, actualDemand?: ResourceDemand): Promise<AdmissionRelease> {
    return this.driver.release(context, actualDemand);
  }
}

/** Build a gateway governor configured for the registered control bypasses. */
export function createDurableGatewayAdmissionGovernor(
  options: DurableGatewayAdmissionOptions = {},
): DurableGatewayAdmissionGovernor {
  return new DurableGatewayAdmissionGovernor(options);
}

export type DurableGatewayAdmissionMetadata = Readonly<Record<string, AdmissionMetadataValue>>;
