import { randomUUID } from 'node:crypto';

/**
 * Typed admission contract for the capless resource governor.
 *
 * This module deliberately contains no capacity formula or ceiling. It owns the
 * stable seam that resource-consuming callers use while the durable queue,
 * health controller, and lease implementation are introduced behind it.
 */

export const ADMISSION_CONTRACT_VERSION = 1 as const;
export const ADMISSION_IDEMPOTENCY_KEY_MAX_CHARS = 200;
export const ADMISSION_COALESCE_KEY_MAX_CHARS = 200;
export const ADMISSION_PAYLOAD_REF_MAX_CHARS = 2_000;

export type KnownAdmissionClass =
  | 'agent'
  | 'process'
  | 'mcp'
  | 'inference'
  | 'embedding'
  | 'database'
  | 'transfer'
  | 'indexing'
  | 'build'
  | 'background'
  | 'control';

/** Extensible for plugins/subsystems without weakening the known labels. */
export type AdmissionClass = KnownAdmissionClass | (string & {});

export interface ResourceDemand {
  /** Relative CPU residency, not a core count or ceiling. */
  readonly cpuWeight?: number;
  readonly memoryBytes?: number;
  readonly databaseConnections?: number;
  readonly fileDescriptors?: number;
  readonly diskBytes?: number;
  readonly networkBytes?: number;
  readonly providerRequests?: number;
  readonly custom?: Readonly<Record<string, number>>;
}

export type AdmissionMetadataValue = string | number | boolean | null;

export interface AdmissionContext {
  readonly contractVersion: typeof ADMISSION_CONTRACT_VERSION;
  readonly requestId: string;
  readonly rootRequestId: string;
  readonly parentRequestId: string | null;
  /** Canonical durable receipt for this request, populated by durable drivers. */
  readonly receiptId?: string;
  /** Parent's canonical durable receipt when this is a nested claim. */
  readonly parentReceiptId?: string | null;
  readonly idempotencyKey: string;
  readonly admissionClass: AdmissionClass;
  readonly priority: number;
  /** Request deadline copied onto the lineage context when one was supplied. */
  readonly deadlineAtMs?: number | null;
  /** Incremental demand introduced at THIS boundary, not the whole root request. */
  readonly demand: Readonly<ResourceDemand>;
  /** Durable payload reference copied onto the lineage context when one was supplied. */
  readonly payloadRef?: string | null;
  /** Structured caller/provider facts, kept separate from the resource vector. */
  readonly metadata?: Readonly<Record<string, AdmissionMetadataValue>>;
  readonly depth: number;
  readonly createdAtMs: number;
  readonly decisionGeneration: number;
  readonly leaseId?: string;
}

export interface AdmissionRequest {
  readonly idempotencyKey: string;
  readonly admissionClass: AdmissionClass;
  readonly priority?: number;
  readonly deadlineAtMs?: number;
  /** Incremental demand introduced by this request. */
  readonly demand?: ResourceDemand;
  /** Durable content-addressed or canonical work reference; never the payload itself. */
  readonly payloadRef?: string;
  /** Optional latest-wins lane. A newer accepted request supersedes older queued work in the same lane. */
  readonly coalesceKey?: string;
  readonly parent?: AdmissionContext;
  /** Must be authorized by the governor's registry; callers cannot self-exempt. */
  readonly bypassKey?: string;
  readonly metadata?: Readonly<Record<string, AdmissionMetadataValue>>;
}

export interface NormalizedAdmissionRequest {
  readonly idempotencyKey: string;
  readonly admissionClass: AdmissionClass;
  readonly priority: number;
  readonly deadlineAtMs: number | null;
  readonly demand: Readonly<ResourceDemand>;
  readonly payloadRef: string | null;
  readonly coalesceKey: string | null;
  readonly parent: AdmissionContext | null;
  readonly bypassKey: string | null;
  readonly metadata: Readonly<Record<string, AdmissionMetadataValue>>;
}

export type QueueReceiptState =
  | 'queued'
  | 'eligible'
  | 'leased'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'superseded'
  | 'expired';

export interface QueueReceipt {
  /** Canonical durable work-item id. */
  readonly receiptId: string;
  readonly idempotencyKey: string;
  readonly state: QueueReceiptState;
  readonly enqueuedAtMs: number;
  readonly decisionGeneration: number;
}

export interface AdmissionLease {
  readonly leaseId: string;
  readonly generation: number;
  readonly admissionClass: AdmissionClass;
  readonly expiresAtMs: number;
}

export type AdmissionOutcome =
  | {
      readonly kind: 'admitted';
      readonly context: AdmissionContext;
      readonly lease?: AdmissionLease;
    }
  | {
      readonly kind: 'queued';
      readonly context: AdmissionContext;
      readonly receipt: QueueReceipt;
    }
  | {
      readonly kind: 'bypass';
      readonly context: AdmissionContext;
      readonly bypassKey: string;
    };

export interface AdmissionStatus {
  readonly idempotencyKey: string;
  readonly state: QueueReceiptState | 'admitted' | 'bypass' | 'unknown';
  readonly receipt?: QueueReceipt;
  readonly resultRef?: string;
  /** Durable lineage for tracing this receipt to its root/parent receipt. */
  readonly context?: AdmissionContext;
}

export interface AdmissionCancellation {
  readonly idempotencyKey: string;
  readonly cancelled: boolean;
  readonly state: AdmissionStatus['state'];
}

export interface AdmissionRelease {
  readonly requestId: string;
  readonly released: boolean;
}

/** Durable drivers implement the queue/controller behind the stable seam. */
export interface AdmissionDriver {
  admit(request: NormalizedAdmissionRequest, context: AdmissionContext): Promise<AdmissionOutcome>;
  status?(idempotencyKey: string): Promise<AdmissionStatus>;
  cancel?(idempotencyKey: string, reason?: string): Promise<AdmissionCancellation>;
  release?(context: AdmissionContext, actualDemand?: ResourceDemand): Promise<AdmissionRelease>;
}

export interface GovernorOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
  /** Registry-owned bypass keys. Unknown keys fail closed. */
  readonly bypassKeys?: ReadonlySet<string>;
}

export class AdmissionValidationError extends Error {
  readonly code = 'ADMISSION_INVALID_REQUEST';
  constructor(message: string) {
    super(message);
    this.name = 'AdmissionValidationError';
  }
}

export class AdmissionAuthorizationError extends Error {
  readonly code = 'ADMISSION_BYPASS_UNAUTHORIZED';
  constructor(key: string) {
    super(`admission bypass '${key}' is not registered`);
    this.name = 'AdmissionAuthorizationError';
  }
}

export class AdmissionIdempotencyConflictError extends Error {
  readonly code = 'ADMISSION_IDEMPOTENCY_CONFLICT';
  constructor(key: string) {
    super(`admission idempotency key '${key}' was reused with a different request`);
    this.name = 'AdmissionIdempotencyConflictError';
  }
}

/** Raised when a driver cannot truthfully persist a queued request. */
export class AdmissionPersistenceError extends Error {
  readonly code = 'ADMISSION_PERSISTENCE_FAILED';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AdmissionPersistenceError';
  }
}

function finiteNonNegative(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new AdmissionValidationError(`${field} must be a finite non-negative number`);
  }
  return value;
}

export function normalizeResourceDemand(input: ResourceDemand | undefined): Readonly<ResourceDemand> {
  const customEntries = Object.entries(input?.custom ?? {})
    .map(([key, value]) => {
      const normalizedKey = key.trim();
      if (!normalizedKey) throw new AdmissionValidationError('demand.custom keys must be non-empty');
      return [normalizedKey, finiteNonNegative(value, `demand.custom.${normalizedKey}`)!] as const;
    })
    .sort(([a], [b]) => a.localeCompare(b));

  return Object.freeze({
    ...(finiteNonNegative(input?.cpuWeight, 'demand.cpuWeight') !== undefined ? { cpuWeight: input!.cpuWeight } : {}),
    ...(finiteNonNegative(input?.memoryBytes, 'demand.memoryBytes') !== undefined
      ? { memoryBytes: input!.memoryBytes }
      : {}),
    ...(finiteNonNegative(input?.databaseConnections, 'demand.databaseConnections') !== undefined
      ? { databaseConnections: input!.databaseConnections }
      : {}),
    ...(finiteNonNegative(input?.fileDescriptors, 'demand.fileDescriptors') !== undefined
      ? { fileDescriptors: input!.fileDescriptors }
      : {}),
    ...(finiteNonNegative(input?.diskBytes, 'demand.diskBytes') !== undefined ? { diskBytes: input!.diskBytes } : {}),
    ...(finiteNonNegative(input?.networkBytes, 'demand.networkBytes') !== undefined
      ? { networkBytes: input!.networkBytes }
      : {}),
    ...(finiteNonNegative(input?.providerRequests, 'demand.providerRequests') !== undefined
      ? { providerRequests: input!.providerRequests }
      : {}),
    ...(customEntries.length > 0 ? { custom: Object.freeze(Object.fromEntries(customEntries)) } : {}),
  });
}

export function normalizeAdmissionRequest(input: AdmissionRequest): NormalizedAdmissionRequest {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > ADMISSION_IDEMPOTENCY_KEY_MAX_CHARS) {
    throw new AdmissionValidationError(
      `idempotencyKey must contain 1-${ADMISSION_IDEMPOTENCY_KEY_MAX_CHARS} characters`,
    );
  }
  const admissionClass = input.admissionClass.trim();
  if (!admissionClass) throw new AdmissionValidationError('admissionClass must be non-empty');
  const priority = input.priority ?? 0;
  if (!Number.isFinite(priority)) throw new AdmissionValidationError('priority must be finite');
  if (input.deadlineAtMs !== undefined && (!Number.isFinite(input.deadlineAtMs) || input.deadlineAtMs < 0)) {
    throw new AdmissionValidationError('deadlineAtMs must be a finite non-negative timestamp');
  }
  const payloadRef = input.payloadRef?.trim() || null;
  if (payloadRef && payloadRef.length > ADMISSION_PAYLOAD_REF_MAX_CHARS) {
    throw new AdmissionValidationError(`payloadRef must contain at most ${ADMISSION_PAYLOAD_REF_MAX_CHARS} characters`);
  }
  const coalesceKey = input.coalesceKey?.trim() || null;
  if (coalesceKey && coalesceKey.length > ADMISSION_COALESCE_KEY_MAX_CHARS) {
    throw new AdmissionValidationError(
      `coalesceKey must contain at most ${ADMISSION_COALESCE_KEY_MAX_CHARS} characters`,
    );
  }
  const metadata = Object.freeze(
    Object.fromEntries(Object.entries(input.metadata ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  );
  return Object.freeze({
    idempotencyKey,
    admissionClass,
    priority,
    deadlineAtMs: input.deadlineAtMs ?? null,
    demand: normalizeResourceDemand(input.demand),
    payloadRef,
    coalesceKey,
    parent: input.parent ?? null,
    bypassKey: input.bypassKey?.trim() || null,
    metadata,
  });
}

/** Stable serialized identity used by durable drivers to reject conflicting replay. */
export function admissionRequestFingerprint(request: NormalizedAdmissionRequest,
  options: { includeGoalAdmissionSnapshot?: boolean } = {}): string {
  return JSON.stringify({
    idempotencyKey: request.idempotencyKey,
    admissionClass: request.admissionClass,
    priority: request.priority,
    deadlineAtMs: request.deadlineAtMs,
    demand: request.demand,
    payloadRef: request.payloadRef,
    coalesceKey: request.coalesceKey,
    parentRequestId: request.parent?.requestId ?? null,
    bypassKey: request.bypassKey,
    // Agent goalAdmission is the resolver's observation, not launch intent.
    // Keep goalId, fleetSlug, targetOwnerId and every other pin in the identity.
    // The option is only for comparing receipts written before this separation.
    metadata: request.admissionClass === 'agent' && !options.includeGoalAdmissionSnapshot
      ? Object.fromEntries(Object.entries(request.metadata).filter(([key]) => key !== 'goalAdmission'))
      : request.metadata,
  });
}

/**
 * Stable public seam. In-process duplicate calls share one promise; the durable
 * driver remains responsible for idempotency across process restarts.
 */
export class Governor {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly bypassKeys: ReadonlySet<string>;
  private readonly inFlight = new Map<string, { fingerprint: string; outcome: Promise<AdmissionOutcome> }>();

  constructor(
    private readonly driver: AdmissionDriver,
    options: GovernorOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.bypassKeys = options.bypassKeys ?? new Set();
  }

  admit(input: AdmissionRequest): Promise<AdmissionOutcome> {
    const request = normalizeAdmissionRequest(input);
    const fingerprint = admissionRequestFingerprint(request);
    const existing = this.inFlight.get(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new AdmissionIdempotencyConflictError(request.idempotencyKey));
      }
      return existing.outcome;
    }

    const requestId = this.idFactory();
    const context: AdmissionContext = Object.freeze({
      contractVersion: ADMISSION_CONTRACT_VERSION,
      requestId,
      rootRequestId: request.parent?.rootRequestId ?? requestId,
      parentRequestId: request.parent?.requestId ?? null,
      parentReceiptId: request.parent?.receiptId ?? null,
      idempotencyKey: request.idempotencyKey,
      admissionClass: request.admissionClass,
      priority: request.priority,
      ...(request.deadlineAtMs !== null ? { deadlineAtMs: request.deadlineAtMs } : {}),
      demand: request.demand,
      ...(request.payloadRef !== null ? { payloadRef: request.payloadRef } : {}),
      ...(Object.keys(request.metadata).length > 0 ? { metadata: request.metadata } : {}),
      depth: (request.parent?.depth ?? -1) + 1,
      createdAtMs: this.now(),
      decisionGeneration: 0,
    });

    const outcome = (async (): Promise<AdmissionOutcome> => {
      if (request.bypassKey) {
        if (!this.bypassKeys.has(request.bypassKey)) throw new AdmissionAuthorizationError(request.bypassKey);
        return { kind: 'bypass', context, bypassKey: request.bypassKey };
      }
      return this.driver.admit(request, context);
    })();
    this.inFlight.set(request.idempotencyKey, { fingerprint, outcome });
    outcome.catch(() => this.inFlight.delete(request.idempotencyKey));
    return outcome;
  }

  async status(idempotencyKey: string): Promise<AdmissionStatus> {
    const key = idempotencyKey.trim();
    if (!key) throw new AdmissionValidationError('idempotencyKey must be non-empty');
    if (this.driver.status) return this.driver.status(key);
    const local = this.inFlight.get(key);
    if (!local) return { idempotencyKey: key, state: 'unknown' };
    const outcome = await local.outcome;
    return {
      idempotencyKey: key,
      state: outcome.kind === 'queued' ? outcome.receipt.state : outcome.kind,
      ...(outcome.kind === 'queued' ? { receipt: outcome.receipt } : {}),
    };
  }

  async cancel(idempotencyKey: string, reason?: string): Promise<AdmissionCancellation> {
    const key = idempotencyKey.trim();
    if (!key) throw new AdmissionValidationError('idempotencyKey must be non-empty');
    if (this.driver.cancel) return this.driver.cancel(key, reason);
    return { idempotencyKey: key, cancelled: false, state: (await this.status(key)).state };
  }

  async release(context: AdmissionContext, actualDemand?: ResourceDemand): Promise<AdmissionRelease> {
    const normalizedActual = actualDemand ? normalizeResourceDemand(actualDemand) : undefined;
    if (this.driver.release) return this.driver.release(context, normalizedActual);
    return { requestId: context.requestId, released: false };
  }
}

/**
 * Flag-on migration adapter: preserves today's admit-immediately behavior while
 * callers move behind Governor.admit. It is deliberately capless and keeps no
 * queue; P-003 replaces it with the durable driver.
 */
export class AdmitImmediatelyDriver implements AdmissionDriver {
  private readonly released = new Set<string>();
  private readonly cancelled = new Set<string>();

  async admit(_request: NormalizedAdmissionRequest, context: AdmissionContext): Promise<AdmissionOutcome> {
    return { kind: 'admitted', context };
  }

  async status(idempotencyKey: string): Promise<AdmissionStatus> {
    if (this.cancelled.has(idempotencyKey)) return { idempotencyKey, state: 'cancelled' };
    return { idempotencyKey, state: 'admitted' };
  }

  async cancel(idempotencyKey: string): Promise<AdmissionCancellation> {
    const first = !this.cancelled.has(idempotencyKey);
    this.cancelled.add(idempotencyKey);
    return { idempotencyKey, cancelled: first, state: 'cancelled' };
  }

  async release(context: AdmissionContext): Promise<AdmissionRelease> {
    const first = !this.released.has(context.requestId);
    this.released.add(context.requestId);
    return { requestId: context.requestId, released: first };
  }
}
