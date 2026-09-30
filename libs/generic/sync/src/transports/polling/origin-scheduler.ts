/**
 * Origin-wide admission for finite browser work.
 *
 * `createConcurrencyGate` is intentionally tiny and remains the compatibility
 * primitive used by older callers.  A browser page, however, has more than one
 * kind of finite request.  Giving each hook its own semaphore multiplies the
 * effective cap and lets a background hydration wave consume the connection
 * needed by an auth or navigation click.  This scheduler keeps one queue per
 * origin and orders work by class while retaining the gate's FIFO behaviour
 * inside a class.
 *
 * The scheduler is transport-agnostic.  A consumer can use the conservative
 * HTTP profile (normally three finite requests with one interactive slot held
 * back), or pass the separately measured IPC cap (for example 24).  Standing
 * streams are registered explicitly; streams beyond the baseline dynamically
 * reduce finite admission.  Bulk/media streams can be registered with
 * `countsAgainstBudget: false` so they remain visible without consuming the
 * control-origin reservation (the BYOC reverse-connector contract).
 */

import { createConcurrencyGate, type ConcurrencyGate } from './concurrency-gate';

export const ORIGIN_SCHEDULER_CLASSES = [
  'interactive-control',
  'foreground-read',
  'background-sync',
  'bulk',
] as const;

export type OriginSchedulerClass = (typeof ORIGIN_SCHEDULER_CLASSES)[number];

/** Friendly aliases accepted at the boundary for callers migrating from a
 * two-lane gate.  The canonical values above are what snapshots expose. */
const CLASS_ALIASES: Record<string, OriginSchedulerClass> = {
  interactive: 'interactive-control',
  control: 'interactive-control',
  foreground: 'foreground-read',
  read: 'foreground-read',
  background: 'background-sync',
  sync: 'background-sync',
};

function normalizeClass(value: unknown): OriginSchedulerClass {
  if (typeof value === 'string') {
    if ((ORIGIN_SCHEDULER_CLASSES as readonly string[]).includes(value)) {
      return value as OriginSchedulerClass;
    }
    const alias = CLASS_ALIASES[value.toLowerCase()];
    if (alias) return alias;
  }
  return 'foreground-read';
}

const CLASS_ORDER: readonly OriginSchedulerClass[] = ORIGIN_SCHEDULER_CLASSES;

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function nonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function abortReason(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason !== undefined) return reason;
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { addEventListener?: unknown }).addEventListener === 'function' &&
    typeof (value as { removeEventListener?: unknown }).removeEventListener === 'function'
  );
}

export type OriginSchedulerOutcome =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'aborted'
  | 'shed'
  | 'rejected';

/** Errors are typed so a caller can distinguish local back-pressure from a
 * server/transport failure without matching human-facing strings. */
export class OriginSchedulerError extends Error {
  readonly code:
    | 'queue_full'
    | 'superseded'
    | 'stale'
    | 'timeout'
    | 'aborted'
    | 'closed';
  readonly requestClass: OriginSchedulerClass;

  constructor(
    code: OriginSchedulerError['code'],
    message: string,
    requestClass: OriginSchedulerClass,
  ) {
    super(message);
    this.name = 'OriginSchedulerError';
    this.code = code;
    this.requestClass = requestClass;
  }
}

export interface OriginSchedulerClassMetrics {
  queued: number;
  inFlight: number;
  admitted: number;
  completed: number;
  failures: number;
  timeouts: number;
  aborted: number;
  shed: number;
  rejected: number;
  waitMsTotal: number;
  waitMsMax: number;
  requestMsTotal: number;
  requestMsMax: number;
  bytes: number;
}

export interface OriginSchedulerSnapshot {
  /** The normalized origin key used by the process-wide registry. */
  origin: string;
  /** Optional transport profile label (`http`, `ipc`, or an app-defined name). */
  profile: string;
  /** Negotiated protocol when the host has reported one (for example h1/h2). */
  protocol: string | null;
  /** Configured cap before stream reservations. */
  baseLimit: number;
  /** Current cap after counted standing streams are reserved. */
  limit: number;
  inFlight: number;
  queued: number;
  /** All registered streams, including bulk/media streams. */
  streams: number;
  /** Streams that reduce finite admission. */
  countedStreams: number;
  baselineStreams: number;
  reservedInteractive: number;
  maxBackground: number;
  maxBulk: number;
  byClass: Record<OriginSchedulerClass, OriginSchedulerClassMetrics>;
}

export interface OriginSchedulerOptions {
  /** Finite-request cap. `maxInFlight` is accepted as a readable alias. */
  limit?: number;
  maxInFlight?: number;
  /** Maximum queued waiters across all classes. */
  maxQueued?: number;
  /** Per-class queue ceilings, useful for protecting control traffic. */
  maxQueuedByClass?: Partial<Record<OriginSchedulerClass, number>>;
  /** Slots held exclusively for interactive-control work. */
  reservedInteractive?: number;
  interactiveReserve?: number;
  /** Background and bulk class concurrency ceilings. */
  maxBackground?: number;
  maxBulk?: number;
  /** One expected standing control stream does not shrink the finite cap. */
  baselineStreams?: number;
  /** Default total deadline for a task (queue wait + execution). */
  requestTimeoutMs?: number;
  /** Default age after which queued background work is stale. */
  staleBackgroundMs?: number;
  profile?: string;
  protocol?: string;
  origin?: string;
  now?: () => number;
}

export interface OriginSchedulerTaskContext {
  readonly id: string;
  readonly requestClass: OriginSchedulerClass;
  /** Attribute response size/protocol to this scheduler sample. */
  recordBytes(bytes: number): void;
  recordProtocol(protocol: string | null | undefined): void;
}

export interface OriginSchedulerRunOptions {
  class?: OriginSchedulerClass | string;
  requestClass?: OriginSchedulerClass | string;
  priority?: OriginSchedulerClass | string;
  signal?: AbortSignal;
  /** Total deadline from enqueue through settle. */
  timeoutMs?: number;
  /** Supersedes an older queued background task with the same key. */
  coalesceKey?: string;
  /** Queue age at which this background task is shed. */
  staleAfterMs?: number;
  /** Optional initial byte count for metrics. */
  bytes?: number;
  /** A caller may label the protocol without changing scheduling semantics. */
  protocol?: string;
}

export interface OriginStreamOptions {
  id?: string;
  name?: string;
  /** `bulk`/`media` streams default to outside the control budget. */
  kind?: 'control' | 'standing' | 'bulk' | 'media' | string;
  countsAgainstBudget?: boolean;
}

export interface OriginStreamLease {
  readonly id: string;
  readonly name?: string;
  readonly countsAgainstBudget: boolean;
  readonly release: () => void;
  readonly unregister: () => void;
}

type TaskFunction<T> = (
  signal: AbortSignal,
  context: OriginSchedulerTaskContext,
) => Promise<T> | T;

interface QueueEntry<T> {
  id: string;
  requestClass: OriginSchedulerClass;
  fn: TaskFunction<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  controller: AbortController;
  enqueuedAt: number;
  deadlineAt: number | null;
  staleAfterMs: number | null;
  coalesceKey?: string;
  bytes: number;
  protocol: string | null;
  state: 'queued' | 'running' | 'settled';
  settled: boolean;
  cancelListener?: () => void;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  cancelReject?: (reason: unknown) => void;
  timeoutReject?: (reason: unknown) => void;
  cancellationRequested: boolean;
  timeoutRequested: boolean;
  startedAt: number | null;
}

interface MutableClassMetrics extends OriginSchedulerClassMetrics {
  /** Kept separate so `queued` can be derived from the actual queues. */
  _queuedEnqueued: number;
}

function freshClassMetrics(): MutableClassMetrics {
  return {
    queued: 0,
    inFlight: 0,
    admitted: 0,
    completed: 0,
    failures: 0,
    timeouts: 0,
    aborted: 0,
    shed: 0,
    rejected: 0,
    waitMsTotal: 0,
    waitMsMax: 0,
    requestMsTotal: 0,
    requestMsMax: 0,
    bytes: 0,
    _queuedEnqueued: 0,
  };
}

function makeClassMetrics(): Record<OriginSchedulerClass, MutableClassMetrics> {
  return {
    'interactive-control': freshClassMetrics(),
    'foreground-read': freshClassMetrics(),
    'background-sync': freshClassMetrics(),
    bulk: freshClassMetrics(),
  };
}

let nextSchedulerId = 1;
let nextStreamId = 1;

/** A reusable scheduler for one normalized origin. */
export interface OriginScheduler extends ConcurrencyGate {
  run<T>(fn: TaskFunction<T>, options?: OriginSchedulerRunOptions | AbortSignal): Promise<T>;
  run<T>(options: OriginSchedulerRunOptions, fn: TaskFunction<T>): Promise<T>;
  /** `schedule` is a semantic alias useful at call sites that don't say gate. */
  schedule<T>(fn: TaskFunction<T>, options?: OriginSchedulerRunOptions | AbortSignal): Promise<T>;
  setLimit(next: number): void;
  setProtocol(protocol: string | null | undefined): void;
  setProfile(profile: string): void;
  registerStream(options?: OriginStreamOptions | string): OriginStreamLease;
  /** Explicitly shed stale queued background work; returns the count removed. */
  shedStaleBackground(maxAgeMs?: number): number;
  /** Cancel queued work by coalescing key. */
  cancel(coalesceKey: string, reason?: unknown): number;
  snapshot(): OriginSchedulerSnapshot;
  metrics(): OriginSchedulerSnapshot;
  close(reason?: unknown): void;
}

function defaultOrigin(): string {
  if (typeof location !== 'undefined' && location.origin) return location.origin;
  return 'http://localhost';
}

/** Normalize an endpoint/path to the origin key used by the registry. */
export function normalizeOrigin(input: string, base = defaultOrigin()): string {
  if (!input) return base;
  try {
    const url = new URL(input, base);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    return `${url.protocol}//${url.host}`;
  } catch {
    return input.replace(/\/+$/, '') || base;
  }
}

export function createOriginScheduler(options: OriginSchedulerOptions = {}): OriginScheduler {
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const origin = normalizeOrigin(options.origin ?? defaultOrigin());
  let baseLimit = positiveInt(options.limit ?? options.maxInFlight, 3);
  let baselineStreams = nonNegativeInt(options.baselineStreams, 1);
  let reservedInteractive = nonNegativeInt(
    options.reservedInteractive ?? options.interactiveReserve,
    1,
  );
  let maxBackground = positiveInt(options.maxBackground, 2);
  let maxBulk = positiveInt(options.maxBulk, 1);
  const maxQueued = positiveInt(options.maxQueued, 100);
  const maxQueuedByClass: Partial<Record<OriginSchedulerClass, number>> = {};
  for (const requestClass of ORIGIN_SCHEDULER_CLASSES) {
    const value = options.maxQueuedByClass?.[requestClass];
    if (value !== undefined) maxQueuedByClass[requestClass] = positiveInt(value, maxQueued);
  }
  const defaultTimeoutMs =
    options.requestTimeoutMs !== undefined ? nonNegativeInt(options.requestTimeoutMs, 0) : 20_000;
  const defaultStaleBackgroundMs =
    options.staleBackgroundMs !== undefined
      ? nonNegativeInt(options.staleBackgroundMs, 0)
      : 0;
  let profile = options.profile ?? 'browser-http';
  let protocol = options.protocol ?? null;
  let closed = false;
  let active = 0;
  // The class-aware picker below decides which waiter wins. The established
  // gate still owns the actual permit counter and release pump, keeping this
  // richer scheduler an extension of the generic gate rather than a second
  // semaphore implementation.
  const permitGate = createConcurrencyGate(baseLimit);
  const queues: Record<OriginSchedulerClass, QueueEntry<unknown>[]> = {
    'interactive-control': [],
    'foreground-read': [],
    'background-sync': [],
    bulk: [],
  };
  const activeByClass: Record<OriginSchedulerClass, number> = {
    'interactive-control': 0,
    'foreground-read': 0,
    'background-sync': 0,
    bulk: 0,
  };
  const classMetrics = makeClassMetrics();
  type StreamRecord = { name?: string; countsAgainstBudget: boolean };
  const streams = new Map<string, StreamRecord>();

  const countedStreams = (): number => {
    let count = 0;
    for (const stream of streams.values()) if (stream.countsAgainstBudget) count++;
    return count;
  };

  const effectiveLimit = (): number =>
    Math.max(1, baseLimit - Math.max(0, countedStreams() - baselineStreams));

  const syncPermitLimit = (): void => {
    const next = effectiveLimit();
    if (permitGate.limit !== next) permitGate.setLimit(next);
  };

  const interactiveReserve = (): number => {
    // A cap of one cannot reserve a slot and also admit useful non-interactive
    // work.  At larger caps this is an exclusive lane, not a soft preference.
    return Math.min(reservedInteractive, Math.max(0, effectiveLimit() - 1));
  };

  const totalQueued = (): number => CLASS_ORDER.reduce((n, c) => n + queues[c].length, 0);

  const updateQueuedMetrics = (): void => {
    for (const requestClass of CLASS_ORDER) classMetrics[requestClass].queued = queues[requestClass].length;
  };

  const removeFromQueue = (entry: QueueEntry<unknown>): boolean => {
    const queue = queues[entry.requestClass];
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    updateQueuedMetrics();
    return true;
  };

  const clearEntryTimers = (entry: QueueEntry<unknown>): void => {
    if (entry.deadlineTimer !== undefined) clearTimeout(entry.deadlineTimer);
    entry.deadlineTimer = undefined;
    if (entry.signal && entry.cancelListener) {
      entry.signal.removeEventListener('abort', entry.cancelListener);
      entry.cancelListener = undefined;
    }
  };

  const settleQueued = (entry: QueueEntry<unknown>, error: unknown, outcome: OriginSchedulerOutcome): void => {
    if (entry.settled) return;
    removeFromQueue(entry);
    entry.state = 'settled';
    entry.settled = true;
    clearEntryTimers(entry);
    const metrics = classMetrics[entry.requestClass];
    if (outcome === 'shed') metrics.shed++;
    else if (outcome === 'timeout') metrics.timeouts++;
    else if (outcome === 'aborted') metrics.aborted++;
    else metrics.rejected++;
    entry.reject(error);
  };

  const staleError = (entry: QueueEntry<unknown>, message: string): OriginSchedulerError =>
    new OriginSchedulerError('stale', message, entry.requestClass);

  const shedEntry = (entry: QueueEntry<unknown>, reason?: unknown): void => {
    settleQueued(
      entry,
      reason ?? staleError(entry, `stale ${entry.requestClass} work was shed before admission`),
      'shed',
    );
  };

  const shedStaleBackground = (maxAgeMs = defaultStaleBackgroundMs): number => {
    if (maxAgeMs <= 0) return 0;
    const cutoff = now() - maxAgeMs;
    const stale = queues['background-sync'].filter((entry) => entry.enqueuedAt <= cutoff);
    for (const entry of stale) shedEntry(entry);
    return stale.length;
  };

  const canAdmit = (entry: QueueEntry<unknown>): boolean => {
    const limit = effectiveLimit();
    if (active >= limit) return false;
    if (entry.requestClass === 'interactive-control') return true;
    const sharedLimit = Math.max(0, limit - interactiveReserve());
    const nonInteractive = active - activeByClass['interactive-control'];
    // Foreground reads may use an otherwise idle reserved slot. Once an
    // interaction is actually waiting, stop admitting new foreground work at
    // the shared boundary so the reservation is immediately available. The
    // reservation is therefore background-proof without reducing normal sync
    // throughput (and preserves the legacy gate's configured cap).
    if (
      entry.requestClass === 'foreground-read' &&
      queues['interactive-control'].length === 0
    ) {
      return true;
    }
    if (nonInteractive >= sharedLimit) return false;
    if (entry.requestClass === 'background-sync' && activeByClass['background-sync'] >= maxBackground) {
      return false;
    }
    if (entry.requestClass === 'bulk' && activeByClass.bulk >= maxBulk) return false;
    return true;
  };

  const chooseNext = (): QueueEntry<unknown> | undefined => {
    for (const requestClass of CLASS_ORDER) {
      const queue = queues[requestClass];
      if (queue.length === 0) continue;
      const first = queue[0];
      if (first.staleAfterMs !== null && now() - first.enqueuedAt >= first.staleAfterMs) {
        shedEntry(first);
        continue;
      }
      if (canAdmit(first)) return first;
      // A blocked higher-priority class may be waiting for its own class cap;
      // allow another class to use otherwise idle capacity.  This matters when
      // background is at its explicit two-request ceiling while a bulk task is
      // still useful, and does not let either class consume the reserved slot.
    }
    return undefined;
  };

  const pump = (): void => {
    syncPermitLimit();
    updateQueuedMetrics();
    while (!closed) {
      const next = chooseNext();
      if (!next) break;
      const permitRelease = permitGate.tryAcquire();
      if (!permitRelease) break;
      removeFromQueue(next);
      // Reserve the scheduler's accounting slot synchronously before handing
      // execution to the shared gate. This keeps the priority picker from
      // selecting the whole queue in one turn while `permitGate.run` awaits a
      // microtask.
      active++;
      activeByClass[next.requestClass]++;
      let reservationReleased = false;
      const releaseReservation = (): void => {
        if (reservationReleased) return;
        reservationReleased = true;
        permitRelease();
        active--;
        activeByClass[next.requestClass]--;
        classMetrics[next.requestClass].inFlight = activeByClass[next.requestClass];
      };
      void execute(next, releaseReservation).catch((error) => {
        // `execute` handles task failures itself; this is only a defensive
        // guard for an unexpected semaphore failure.
        if (!next.settled) {
          next.state = 'settled';
          next.settled = true;
          clearEntryTimers(next);
          classMetrics[next.requestClass].failures++;
          next.reject(error);
        }
        releaseReservation();
        pump();
      });
    }
  };

  const makeContext = (entry: QueueEntry<unknown>): OriginSchedulerTaskContext => ({
    id: entry.id,
    requestClass: entry.requestClass,
    recordBytes(bytes: number): void {
      if (Number.isFinite(bytes) && bytes >= 0) entry.bytes = bytes;
    },
    recordProtocol(next: string | null | undefined): void {
      entry.protocol = next ?? null;
      if (next) protocol = next;
    },
  });

  const execute = async (entry: QueueEntry<unknown>, releaseReservation: () => void): Promise<void> => {
    let startedAt: number | null = null;
    let metrics: MutableClassMetrics | null = null;
    if (entry.settled || closed) {
      if (!entry.settled) settleQueued(entry, new OriginSchedulerError('closed', 'origin scheduler is closed', entry.requestClass), 'rejected');
      releaseReservation();
      pump();
      return;
    }
    const current = now();
    if (entry.deadlineAt !== null && current >= entry.deadlineAt) {
      settleQueued(
        entry,
        new OriginSchedulerError('timeout', `scheduler deadline elapsed before admission`, entry.requestClass),
        'timeout',
      );
      releaseReservation();
      pump();
      return;
    }
    entry.state = 'running';
    metrics = classMetrics[entry.requestClass];
    metrics.admitted++;
    metrics.inFlight = activeByClass[entry.requestClass];
    startedAt = now();
    entry.startedAt = startedAt;
    const waitMs = Math.max(0, startedAt - entry.enqueuedAt);
    metrics.waitMsTotal += waitMs;
    metrics.waitMsMax = Math.max(metrics.waitMsMax, waitMs);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelReject: ((reason: unknown) => void) | undefined;
    let timeoutReject: ((reason: unknown) => void) | undefined;
    const remaining = entry.deadlineAt === null ? null : Math.max(0, entry.deadlineAt - startedAt);
    const operation = Promise.resolve().then(() => entry.fn(entry.controller.signal, makeContext(entry)));
    // A transport that ignores AbortSignal must not hold the scheduler slot.
    // The race settles this wrapper; the underlying promise is intentionally
    // observed so a late rejection cannot become an unhandled rejection.
    operation.catch(() => {});
    const cancellation = new Promise<never>((_, reject) => {
      cancelReject = reject;
    });
    const timeout = new Promise<never>((_, reject) => {
      timeoutReject = reject;
      if (remaining !== null) {
        timer = setTimeout(() => {
          entry.timeoutRequested = true;
          entry.controller.abort();
          reject(
            new OriginSchedulerError(
              'timeout',
              `scheduler task timed out after ${Math.max(0, entry.deadlineAt! - entry.enqueuedAt)}ms`,
              entry.requestClass,
            ),
          );
        }, remaining);
      }
    });
    entry.cancelReject = cancelReject;
    entry.timeoutReject = timeoutReject;

    try {
      const value = await Promise.race([operation, cancellation, timeout]);
      if (!entry.settled) {
        entry.state = 'settled';
        entry.settled = true;
        clearEntryTimers(entry);
        metrics.completed++;
        metrics.bytes += entry.bytes > 0 ? entry.bytes : 0;
        entry.resolve(value);
      }
    } catch (error) {
      if (!entry.settled) {
        entry.state = 'settled';
        entry.settled = true;
        clearEntryTimers(entry);
        if (entry.timeoutRequested || (error instanceof OriginSchedulerError && error.code === 'timeout')) {
          metrics.timeouts++;
        } else if (entry.cancellationRequested || (isAbortSignal(entry.signal) && entry.signal.aborted)) {
          metrics.aborted++;
        } else {
          metrics.failures++;
        }
        metrics.bytes += entry.bytes > 0 ? entry.bytes : 0;
        entry.reject(error);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      entry.cancelReject = undefined;
      entry.timeoutReject = undefined;
      releaseReservation();
      if (metrics && startedAt !== null) {
        const requestMs = Math.max(0, now() - startedAt);
        metrics.requestMsTotal += requestMs;
        metrics.requestMsMax = Math.max(metrics.requestMsMax, requestMs);
      }
      pump();
    }
  };

  const enqueue = <T>(fn: TaskFunction<T>, rawOptions: OriginSchedulerRunOptions = {}): Promise<T> => {
    const requestClass = normalizeClass(rawOptions.class ?? rawOptions.requestClass ?? rawOptions.priority);
    const signal = rawOptions.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (closed) {
      return Promise.reject(new OriginSchedulerError('closed', 'origin scheduler is closed', requestClass));
    }

    // Superseding is deliberately limited to background work.  A mutation or
    // direct interaction must never disappear because a later read arrived.
    if (requestClass === 'background-sync' && rawOptions.coalesceKey) {
      const previous = queues[requestClass].find((entry) => entry.coalesceKey === rawOptions.coalesceKey);
      if (previous) {
        shedEntry(
          previous,
          new OriginSchedulerError(
            'superseded',
            `background task "${rawOptions.coalesceKey}" was superseded`,
            requestClass,
          ),
        );
      }
    }

    const classQueue = queues[requestClass];
    const classLimit = maxQueuedByClass[requestClass] ?? maxQueued;
    if (totalQueued() >= maxQueued || classQueue.length >= classLimit) {
      // Make room for a fresh background key by removing stale work first. If
      // no stale entry exists, reject explicitly instead of silently dropping a
      // caller's request.
      if (requestClass === 'background-sync') shedStaleBackground();
      if (totalQueued() >= maxQueued || classQueue.length >= classLimit) {
        const error = new OriginSchedulerError(
          'queue_full',
          `origin scheduler queue is full for ${requestClass}`,
          requestClass,
        );
        classMetrics[requestClass].rejected++;
        return Promise.reject(error);
      }
    }

    const enqueuedAt = now();
    const timeoutMs =
      rawOptions.timeoutMs === undefined
        ? defaultTimeoutMs
        : nonNegativeInt(rawOptions.timeoutMs, defaultTimeoutMs);
    const deadlineAt = timeoutMs > 0 ? enqueuedAt + timeoutMs : null;
    const controller = new AbortController();
    const entry = {} as QueueEntry<T>;
    const promise = new Promise<T>((resolve, reject) => {
      Object.assign(entry, {
        id: `origin-task-${nextSchedulerId++}`,
        requestClass,
        fn,
        resolve,
        reject,
        signal,
        controller,
        enqueuedAt,
        deadlineAt,
        staleAfterMs:
          rawOptions.staleAfterMs === undefined
            ? requestClass === 'background-sync' && defaultStaleBackgroundMs > 0
              ? defaultStaleBackgroundMs
              : null
            : nonNegativeInt(rawOptions.staleAfterMs, 0) || null,
        coalesceKey: rawOptions.coalesceKey,
        bytes: Number.isFinite(rawOptions.bytes) && (rawOptions.bytes ?? 0) > 0 ? rawOptions.bytes! : 0,
        protocol: rawOptions.protocol ?? null,
        state: 'queued',
        settled: false,
        cancellationRequested: false,
        timeoutRequested: false,
        startedAt: null,
      });
    });
    // Background coalescing and queue shedding intentionally reject superseded
    // promises. Mark the promise handled internally so an unawaited prefetch
    // cannot surface as a process-level unhandled rejection; callers that do
    // await it still observe the original rejection.
    void promise.catch(() => {});

    const typedEntry = entry as QueueEntry<unknown>;
    const onAbort = (): void => {
      if (typedEntry.settled) return;
      typedEntry.cancellationRequested = true;
      if (typedEntry.state === 'queued') {
        settleQueued(typedEntry, abortReason(signal!), 'aborted');
        return;
      }
      typedEntry.controller.abort();
      typedEntry.cancelReject?.(abortReason(signal!));
    };
    if (signal) {
      typedEntry.cancelListener = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (deadlineAt !== null) {
      const delay = Math.max(0, deadlineAt - enqueuedAt);
      typedEntry.deadlineTimer = setTimeout(() => {
        if (typedEntry.settled) return;
        typedEntry.timeoutRequested = true;
        if (typedEntry.state === 'queued') {
          settleQueued(
            typedEntry,
            new OriginSchedulerError('timeout', `scheduler task timed out after ${timeoutMs}ms waiting`, requestClass),
            'timeout',
          );
        } else {
          typedEntry.controller.abort();
          typedEntry.timeoutReject?.(
            new OriginSchedulerError('timeout', `scheduler task timed out after ${timeoutMs}ms`, requestClass),
          );
        }
      }, delay);
    }
    queues[requestClass].push(typedEntry);
    updateQueuedMetrics();
    pump();
    return promise;
  };

  const run = <T>(
    first: TaskFunction<T> | OriginSchedulerRunOptions,
    second?: OriginSchedulerRunOptions | AbortSignal | TaskFunction<T>,
  ): Promise<T> => {
    if (typeof first === 'function') {
      const options = isAbortSignal(second)
        ? { signal: second }
        : (second as OriginSchedulerRunOptions | undefined);
      return enqueue(first, options ?? {});
    }
    if (typeof second !== 'function') {
      return Promise.reject(new TypeError('origin scheduler requires a task function'));
    }
    return enqueue(second, first);
  };

  const registerStream = (raw: OriginStreamOptions | string = {}): OriginStreamLease => {
    const input: OriginStreamOptions = typeof raw === 'string' ? { name: raw, kind: raw } : raw;
    const id = input.id ?? `origin-stream-${nextStreamId++}`;
    const kind = input.kind?.toLowerCase() ?? 'standing';
    const countsAgainstBudget = input.countsAgainstBudget ?? !(kind === 'bulk' || kind === 'media');
    // A caller-provided id is a stable identity for a logical stream.  Treat a
    // second registration as replacement, but bind each lease's release to the
    // record it installed: an old lease must never delete a newer registration
    // that reused the same id.
    const record: StreamRecord = { name: input.name, countsAgainstBudget };
    streams.set(id, record);
    pump();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (streams.get(id) === record) streams.delete(id);
      pump();
    };
    return {
      id,
      ...(input.name ? { name: input.name } : {}),
      countsAgainstBudget,
      release,
      unregister: release,
    };
  };

  const snapshot = (): OriginSchedulerSnapshot => {
    updateQueuedMetrics();
    const byClass = {} as Record<OriginSchedulerClass, OriginSchedulerClassMetrics>;
    for (const requestClass of CLASS_ORDER) {
      const { _queuedEnqueued: _, ...metrics } = classMetrics[requestClass];
      byClass[requestClass] = { ...metrics, queued: queues[requestClass].length, inFlight: activeByClass[requestClass] };
    }
    return {
      origin,
      profile,
      protocol,
      baseLimit,
      limit: effectiveLimit(),
      inFlight: active,
      queued: totalQueued(),
      streams: streams.size,
      countedStreams: countedStreams(),
      baselineStreams,
      reservedInteractive: interactiveReserve(),
      maxBackground,
      maxBulk,
      byClass,
    };
  };

  const scheduler: OriginScheduler = {
    run,
    schedule: run,
    setLimit(next: number): void {
      baseLimit = positiveInt(next, baseLimit);
      reservedInteractive = Math.min(reservedInteractive, Math.max(0, baseLimit - 1));
      syncPermitLimit();
      pump();
    },
    setProtocol(next: string | null | undefined): void {
      protocol = next ?? null;
    },
    setProfile(next: string): void {
      if (next) profile = next;
    },
    registerStream,
    shedStaleBackground,
    cancel(coalesceKey: string, reason?: unknown): number {
      const matches = queues['background-sync'].filter((entry) => entry.coalesceKey === coalesceKey);
      for (const entry of matches) shedEntry(entry, reason);
      return matches.length;
    },
    snapshot,
    metrics: snapshot,
    close(reason?: unknown): void {
      if (closed) return;
      closed = true;
      const error = reason ?? new OriginSchedulerError('closed', 'origin scheduler is closed', 'foreground-read');
      for (const requestClass of CLASS_ORDER) {
        for (const entry of [...queues[requestClass]]) settleQueued(entry, error, 'rejected');
      }
      streams.clear();
    },
    tryAcquire(signal?: AbortSignal): (() => void) | null {
      // This compatibility surface must not jump ahead of work already known
      // to the class-aware scheduler.  `permitGate` only sees permits, not our
      // per-class queues, so checking it alone would let an external caller
      // consume capacity while a queued interactive/background task waits.
      if (closed) return null;
      syncPermitLimit();
      if (totalQueued() > 0) {
        // Give stale entries (and any newly-admissible class) one chance to
        // clear before declining the external reservation.  If a queued entry
        // remains, preserving scheduler order is more important than handing
        // out an unclassified permit.
        pump();
        if (totalQueued() > 0) return null;
      }
      const releasePermit = permitGate.tryAcquire(signal);
      if (!releasePermit) return null;
      active++;
      activeByClass['foreground-read']++;
      classMetrics['foreground-read'].inFlight = activeByClass['foreground-read'];
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releasePermit();
        active--;
        activeByClass['foreground-read']--;
        classMetrics['foreground-read'].inFlight = activeByClass['foreground-read'];
        pump();
      };
    },
    get limit() {
      return effectiveLimit();
    },
    get inFlight() {
      return active;
    },
    get queued() {
      return totalQueued();
    },
  };
  return scheduler;
}

const originSchedulers = new Map<string, OriginScheduler>();

/** Return the one process-pinned scheduler for an endpoint's origin. */
export function getOriginScheduler(
  endpointOrOrigin: string,
  options: OriginSchedulerOptions = {},
): OriginScheduler {
  const origin = normalizeOrigin(endpointOrOrigin);
  const existing = originSchedulers.get(origin);
  if (existing) {
    if (options.limit !== undefined || options.maxInFlight !== undefined) {
      existing.setLimit(options.limit ?? options.maxInFlight!);
    }
    if (options.profile) existing.setProfile(options.profile);
    if (options.protocol !== undefined) existing.setProtocol(options.protocol);
    return existing;
  }
  const scheduler = createOriginScheduler({ ...options, origin });
  originSchedulers.set(origin, scheduler);
  return scheduler;
}

/** Read the registry without creating (or reconfiguring) an entry. */
export function peekOriginScheduler(endpointOrOrigin: string): OriginScheduler | undefined {
  return originSchedulers.get(normalizeOrigin(endpointOrOrigin));
}

/** Alias emphasizing that callers pass an endpoint path, not a bare origin. */
export const getOriginSchedulerForEndpoint = getOriginScheduler;

/** Test/reset hook; production keeps the registry for the page lifetime. */
export function _resetOriginSchedulersForTests(): void {
  for (const scheduler of originSchedulers.values()) scheduler.close();
  originSchedulers.clear();
}
