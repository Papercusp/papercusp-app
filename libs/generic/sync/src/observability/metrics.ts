/**
 * Sync metrics shim.
 *
 * Lightweight in-memory counters for the sync layer. Exposed on
 * `window.__sync_metrics__` so they're inspectable from DevTools without
 * any UI plumbing, and consumable later by a /api/sync-metrics POST shim
 * (deferred — wait for real signal before defining the wire format).
 *
 * Designed to be effectively free in the hot path: integer increments,
 * no allocations per event, no async work.
 *
 * Counters reset only on full page reload. If a longer-running aggregation
 * window is needed, the consumer reads `__sync_metrics__.snapshot()` on a
 * timer and computes deltas.
 */

import type { OriginSchedulerSnapshot } from '../transports/polling/origin-scheduler';

/** One completed (or failed) query request, as kept in the bounded recent-ring. */
export interface SyncQueryEvent {
  /** Query name, e.g. `plans.list`. */
  name: string;
  /** performance.now() at the moment the caller asked — BEFORE the gate. */
  startedAtMs: number;
  /** ms spent QUEUED behind the concurrency gate before the request was sent. */
  waitMs: number;
  /** ms from request sent to body fully read. */
  requestMs: number;
  /** Response body length in chars (≈bytes for JSON), or -1 when not observed. */
  bytes: number;
  /** 'ok' | 'error' | 'timeout' | 'aborted'. */
  outcome: SyncQueryOutcome;
  /** Correlates the request with the later React commit/frame stages. */
  traceId?: string;
  /** Stage timings captured by the writers on this request. Every duration is ms. */
  stages?: SyncStageTimings;
}

export type SyncQueryOutcome = 'ok' | 'error' | 'timeout' | 'aborted';

/**
 * The freshness stages are deliberately a closed set. Keep the names and the
 * `*Ms` suffix stable: dashboards and recurrence tests use this contract to
 * prevent a writer from silently changing units (for example, seconds → ms).
 */
export const SYNC_STAGE_NAMES = [
  'commit',
  'eventReceipt',
  'schedulerWait',
  'resolver',
  'transfer',
  'parseCache',
  'reactCommit',
  'updateToScreen',
] as const;

export type SyncStageName = (typeof SYNC_STAGE_NAMES)[number];

/** Per-request stage values. Timestamp fields are instants; duration fields are milliseconds. */
export interface SyncStageTimings {
  /** Server-side event commit/emit epoch timestamp (`SyncEvent.ts`). */
  committedAtMs?: number;
  /** Client-side event receipt epoch timestamp. */
  eventReceivedAtMs?: number;
  schedulerWaitMs?: number;
  resolverMs?: number;
  transferMs?: number;
  parseCacheMs?: number;
  reactCommitMs?: number;
  updateToScreenMs?: number;
}

/** One bounded stage sample. `unit` is explicit so consumers cannot guess the scale. */
export interface SyncStageSample {
  stage: SyncStageName;
  unit: 'ms';
  durationMs: number;
  measuredAtMs: number;
  queryName?: string;
  traceId?: string;
}

export interface SyncStageStat {
  unit: 'ms';
  count: number;
  durationMsTotal: number;
  durationMsMax: number;
  lastDurationMs: number | null;
}

export interface SyncStageSnapshot {
  unit: 'ms';
  byStage: Record<SyncStageName, SyncStageStat>;
  recent: SyncStageSample[];
  /** Samples rejected because a writer supplied a non-finite/negative duration. */
  invalidSamples: number;
}

/** Server timing metadata carried alongside a successful REST query response. */
export interface SyncServerTiming {
  unit: 'ms';
  resolverStartedAtMs: number;
  resolverCompletedAtMs: number;
  resolverMs: number;
}

/** Client-side trace carried through the query cache to React's commit/frame writers. */
export interface SyncQueryTiming extends SyncStageTimings {
  traceId: string;
  /** Monotonic timestamp at which parse/cache handoff completed. */
  parseCacheEndedAtMs: number;
}

/** Per-queryName rollup — the "which query costs what" view. */
export interface SyncQueryStat {
  requests: number;
  bytes: number;
  waitMsTotal: number;
  requestMsTotal: number;
  requestMsMax: number;
  failures: number;
}

/**
 * Transport-layer health. `inFlight` / `queued` / `limit` are LIVE reads of the
 * concurrency gate via a registered probe — they existed on the gate interface
 * from the start and nothing outside tests ever read them, which is exactly how
 * a saturated gate stayed invisible while users waited (WI-6559, and P-003 of
 * no-http-anywhere-2026-07-28). The counters beside them are cumulative since
 * page load.
 */
export interface SyncTransportSnapshot {
  /** Requests currently occupying a gate slot, or null when no gate is registered. */
  inFlight: number | null;
  /** Callers QUEUED for a slot — the number that is nonzero while the user waits. */
  queued: number | null;
  /** The gate's current cap. */
  limit: number | null;
  requests: number;
  failures: number;
  timeouts: number;
  bytesReceived: number;
  /** Cumulative queue wait, and the tail that matters for "the user is waiting". */
  queueWaitMsTotal: number;
  queueWaitMsMax: number;
  queueWaitOver250: number;
  queueWaitOver1000: number;
}

export interface SyncMetricsSnapshot {
  /** ms since process start (performance.now-based) when this snapshot was taken. */
  takenAtMs: number;
  /**
   * Host-reported bounded startup IPC assertion state. These fields are absent
   * until a host with an IPC startup probe reports a timeout; absence means the
   * probe has not reported that outcome, not that IPC is healthy.
   */
  ipcAssertTimedOut?: boolean;
  ipcAssertLastClient?: string | null;
  sse: {
    /** ms since the current connection opened, or null when disconnected. */
    connectedSinceMs: number | null;
    /** Total reconnect attempts since page load (excludes the first connect). */
    reconnectCount: number;
    /** Total SSE events received from the server. */
    eventsReceived: number;
    /** Latest server→client event latency in ms, or null if not yet measured.
     *  Requires server-side event timestamps; currently no-op until Pass 2.2. */
    lastEventLatencyMs: number | null;
    /** Total bytes received over the SSE stream (best-effort, JSON.length). */
    bytesReceived: number;
  };
  cache: {
    /** Queries served from the react-query cache without a network round-trip. */
    hits: number;
    /** Queries that triggered a network fetch (initial load + post-stale refetch). */
    misses: number;
  };
  invalidations: {
    /** Invalidations triggered by an SSE/WS push. */
    fromSse: number;
    /** Invalidations triggered by react-query's polling interval (timer). */
    fromTimer: number;
    /** Invalidations triggered explicitly via the result.invalidate() callback. */
    fromManual: number;
    /**
     * EI-19406583179082751: `fromSse` alone cannot say WHICH query names dominate an
     * SSE-push-volume anomaly (a 96k-events/5h idle-client measurement had no way to
     * attribute the count). Per-name counts of SSE-driven invalidations, keyed by the
     * server-pushed `event.name` — a broadcast the client never subscribed to still
     * increments its entry here, so a name with a high count and zero matching entries
     * in `byQuery` is exactly the "server broadcasts events this client doesn't observe"
     * signature `logInvalidationsBySse()` is built to surface.
     */
    bySseName: Record<string, number>;
  };
  transport: SyncTransportSnapshot;
  /** Live origin-wide scheduler view, when a transport has registered one. */
  scheduler?: OriginSchedulerSnapshot;
  /** Per-queryName rollup, keyed by query name. */
  byQuery: Record<string, SyncQueryStat>;
  /** Stage-by-stage freshness telemetry. Optional for callers constructing test snapshots. */
  stages?: SyncStageSnapshot;
}

/** Live gate reader, registered by the transport that owns the gate. */
export type GateProbe = () => { inFlight: number; queued: number; limit: number };

/**
 * How many recent query events to keep. Sized to comfortably hold a cold page's
 * whole hydration wave (measured at 87 distinct keys on the operator's densest
 * route, 2026-07-28 / P-002) so `recentQueries()` answers "what did first paint
 * actually fetch" without an external recorder.
 */
export const SYNC_QUERY_RING_SIZE = 400;

interface MetricsState {
  sse: {
    connectedAt: number | null;
    reconnectCount: number;
    eventsReceived: number;
    lastEventLatencyMs: number | null;
    bytesReceived: number;
  };
  cache: { hits: number; misses: number };
  invalidations: { fromSse: number; fromTimer: number; fromManual: number };
  invalidationsBySseName: Map<string, number>;
  ipcAssertTimedOut: boolean | undefined;
  ipcAssertLastClient: string | null;
  transport: {
    requests: number;
    failures: number;
    timeouts: number;
    bytesReceived: number;
    queueWaitMsTotal: number;
    queueWaitMsMax: number;
    queueWaitOver250: number;
    queueWaitOver1000: number;
  };
  byQuery: Map<string, SyncQueryStat>;
  /** Bounded ring of recent query events (oldest dropped first). */
  recent: SyncQueryEvent[];
  gateProbe: GateProbe | null;
  schedulerProbe: (() => OriginSchedulerSnapshot) | null;
  stages: {
    byStage: Map<SyncStageName, SyncStageStat>;
    recent: SyncStageSample[];
    invalidSamples: number;
  };
}

const freshTransport = (): MetricsState['transport'] => ({
  requests: 0,
  failures: 0,
  timeouts: 0,
  bytesReceived: 0,
  queueWaitMsTotal: 0,
  queueWaitMsMax: 0,
  queueWaitOver250: 0,
  queueWaitOver1000: 0,
});

const state: MetricsState = {
  sse: {
    connectedAt: null,
    reconnectCount: 0,
    eventsReceived: 0,
    lastEventLatencyMs: null,
    bytesReceived: 0,
  },
  cache: { hits: 0, misses: 0 },
  invalidations: { fromSse: 0, fromTimer: 0, fromManual: 0 },
  invalidationsBySseName: new Map(),
  ipcAssertTimedOut: undefined,
  ipcAssertLastClient: null,
  transport: freshTransport(),
  byQuery: new Map(),
  recent: [],
  gateProbe: null,
  schedulerProbe: null,
  stages: {
    byStage: new Map(),
    recent: [],
    invalidSamples: 0,
  },
};

const STAGE_RING_SIZE = 400;

function freshStageStat(): SyncStageStat {
  return {
    unit: 'ms',
    count: 0,
    durationMsTotal: 0,
    durationMsMax: 0,
    lastDurationMs: null,
  };
}

function resetStageStats(): void {
  state.stages.byStage.clear();
  for (const stage of SYNC_STAGE_NAMES) state.stages.byStage.set(stage, freshStageStat());
  state.stages.recent.length = 0;
  state.stages.invalidSamples = 0;
}

resetStageStats();

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

let nextTraceId = 1;

/** Make a bounded, page-local correlation id for a sync freshness trace. */
export function createSyncTraceId(prefix = 'sync'): string {
  return `${prefix}-${nextTraceId++}`;
}

function recordStageSample(
  stage: SyncStageName,
  durationMs: number,
  meta: { queryName?: string; traceId?: string; measuredAtMs?: number } = {},
): void {
  if (!SYNC_STAGE_NAMES.includes(stage) || !Number.isFinite(durationMs) || durationMs < 0) {
    state.stages.invalidSamples++;
    return;
  }
  const measuredAtMs = meta.measuredAtMs ?? now();
  if (!Number.isFinite(measuredAtMs)) {
    state.stages.invalidSamples++;
    return;
  }
  const stat = state.stages.byStage.get(stage) ?? freshStageStat();
  stat.count++;
  stat.durationMsTotal += durationMs;
  stat.durationMsMax = Math.max(stat.durationMsMax, durationMs);
  stat.lastDurationMs = durationMs;
  state.stages.byStage.set(stage, stat);
  state.stages.recent.push({
    stage,
    unit: 'ms',
    durationMs,
    measuredAtMs,
    ...(meta.queryName ? { queryName: meta.queryName } : {}),
    ...(meta.traceId ? { traceId: meta.traceId } : {}),
  });
  if (state.stages.recent.length > STAGE_RING_SIZE) state.stages.recent.shift();
}

export const syncMetrics = {
  // SSE lifecycle
  sseConnected(): void {
    state.sse.connectedAt = now();
  },
  sseDisconnected(): void {
    state.sse.connectedAt = null;
  },
  sseReconnectAttempt(): void {
    state.sse.reconnectCount++;
  },
  sseEventReceived(
    byteLen: number,
    serverEmittedAtMs?: number,
    meta?: { queryName?: string; traceId?: string; receivedAtMs?: number },
  ): void {
    state.sse.eventsReceived++;
    state.sse.bytesReceived += byteLen;
    if (serverEmittedAtMs !== undefined && Number.isFinite(serverEmittedAtMs)) {
      // Server uses Date.now(); we use Date.now() here too so the math lines up
      // even though performance.now() is preferred elsewhere. Clock skew between
      // client and server makes this approximate; it's still useful for trends.
      const receivedAtMs = meta?.receivedAtMs ?? Date.now();
      const deltaMs = receivedAtMs - serverEmittedAtMs;
      state.sse.lastEventLatencyMs = deltaMs >= 0 ? deltaMs : 0;
      recordStageSample('commit', 0, {
        queryName: meta?.queryName,
        traceId: meta?.traceId,
        measuredAtMs: serverEmittedAtMs,
      });
      recordStageSample('eventReceipt', state.sse.lastEventLatencyMs, {
        queryName: meta?.queryName,
        traceId: meta?.traceId,
        measuredAtMs: receivedAtMs,
      });
    }
  },
  // Cache events
  cacheHit(): void {
    state.cache.hits++;
  },
  cacheMiss(): void {
    state.cache.misses++;
  },
  // Invalidation source
  /**
   * `name` (the server-pushed event's query name) is optional so no existing call
   * site is stranded, but SSEAdapter always has it available and passes it — see
   * `bySseName` on the snapshot for why this matters.
   */
  invalidateFromSse(name?: string): void {
    state.invalidations.fromSse++;
    if (name) {
      state.invalidationsBySseName.set(name, (state.invalidationsBySseName.get(name) ?? 0) + 1);
    }
  },
  invalidateFromTimer(): void {
    state.invalidations.fromTimer++;
  },
  invalidateFromManual(): void {
    state.invalidations.fromManual++;
  },
  /**
   * Register the live gate reader. Idempotent by replacement — the transport
   * owns exactly one gate per endpoint and re-registers on retune. Passing null
   * unregisters (the snapshot then reports nulls rather than stale numbers,
   * because "no gate" and "an idle gate" are different facts).
   */
  registerGateProbe(probe: GateProbe | null): void {
    state.gateProbe = probe;
  },
  /**
   * Register the process-pinned origin scheduler's live snapshot. This is a
   * separate probe from the legacy gate depth so existing consumers keep their
   * shape while new diagnostics can see streams and per-class queue tails.
   */
  registerSchedulerProbe(probe: (() => OriginSchedulerSnapshot) | null): void {
    state.schedulerProbe = probe;
  },
  /**
   * Record that a host's bounded startup IPC assertion gave up. This is a
   * host-level diagnostic rather than a sync request counter, but it belongs
   * in the same inspectable snapshot so a permanently capped session is not
   * silent after the deadline expires.
   */
  recordIpcAssertionTimeout(lastClient: string | null): void {
    state.ipcAssertTimedOut = true;
    state.ipcAssertLastClient = lastClient;
  },
  /**
   * Record one freshness stage. All accepted values are explicitly milliseconds;
   * invalid writer values are counted and dropped rather than becoming plausible
   * telemetry with an unknown unit.
   */
  recordStage(
    stage: SyncStageName,
    durationMs: number,
    meta: { queryName?: string; traceId?: string; measuredAtMs?: number } = {},
  ): void {
    recordStageSample(stage, durationMs, meta);
  },
  /** A copy of the bounded stage ring, oldest first. */
  recentStages(): SyncStageSample[] {
    return state.stages.recent.slice();
  },
  /**
   * Record one completed query request. Called from the transport's gated path
   * so `waitMs` is the REAL queue wait — the interval the user spends waiting
   * for permission to make a request, which no previous counter exposed.
   */
  queryCompleted(ev: SyncQueryEvent): void {
    const t = state.transport;
    t.requests++;
    if (ev.outcome === 'error') t.failures++;
    if (ev.outcome === 'timeout') {
      t.failures++;
      t.timeouts++;
    }
    if (ev.bytes > 0) t.bytesReceived += ev.bytes;
    t.queueWaitMsTotal += ev.waitMs;
    if (ev.waitMs > t.queueWaitMsMax) t.queueWaitMsMax = ev.waitMs;
    if (ev.waitMs > 250) t.queueWaitOver250++;
    if (ev.waitMs > 1000) t.queueWaitOver1000++;

    let stat = state.byQuery.get(ev.name);
    if (!stat) {
      stat = { requests: 0, bytes: 0, waitMsTotal: 0, requestMsTotal: 0, requestMsMax: 0, failures: 0 };
      state.byQuery.set(ev.name, stat);
    }
    stat.requests++;
    if (ev.bytes > 0) stat.bytes += ev.bytes;
    stat.waitMsTotal += ev.waitMs;
    stat.requestMsTotal += ev.requestMs;
    if (ev.requestMs > stat.requestMsMax) stat.requestMsMax = ev.requestMs;
    if (ev.outcome === 'error' || ev.outcome === 'timeout') stat.failures++;

    const stages = ev.stages ?? {};
    // The scheduler writer is the query event itself, so retain the existing
    // waitMs field as the compatibility source of truth.
    recordStageSample('schedulerWait', stages.schedulerWaitMs ?? ev.waitMs, {
      queryName: ev.name,
      traceId: ev.traceId,
    });
    if (stages.resolverMs !== undefined) {
      recordStageSample('resolver', stages.resolverMs, { queryName: ev.name, traceId: ev.traceId });
    }
    if (stages.transferMs !== undefined) {
      recordStageSample('transfer', stages.transferMs, { queryName: ev.name, traceId: ev.traceId });
    }
    if (stages.parseCacheMs !== undefined) {
      recordStageSample('parseCache', stages.parseCacheMs, { queryName: ev.name, traceId: ev.traceId });
    }
    if (stages.committedAtMs !== undefined) {
      recordStageSample('commit', 0, {
        queryName: ev.name,
        traceId: ev.traceId,
        measuredAtMs: stages.committedAtMs,
      });
    }
    if (stages.eventReceivedAtMs !== undefined && stages.committedAtMs !== undefined) {
      recordStageSample(
        'eventReceipt',
        Math.max(0, stages.eventReceivedAtMs - stages.committedAtMs),
        { queryName: ev.name, traceId: ev.traceId, measuredAtMs: stages.eventReceivedAtMs },
      );
    }

    state.recent.push(ev);
    if (state.recent.length > SYNC_QUERY_RING_SIZE) state.recent.shift();
  },
  /** The bounded recent-query ring, oldest first. A copy — callers may sort it. */
  recentQueries(): SyncQueryEvent[] {
    return state.recent.slice();
  },
  // Snapshot for inspection / future POST
  snapshot(): SyncMetricsSnapshot {
    const gate = state.gateProbe;
    let live: { inFlight: number; queued: number; limit: number } | null = null;
    try {
      live = gate ? gate() : null;
    } catch {
      // A throwing probe must never break the snapshot — report unknown instead.
      live = null;
    }
    let scheduler: OriginSchedulerSnapshot | undefined;
    try {
      scheduler = state.schedulerProbe ? state.schedulerProbe() : undefined;
    } catch {
      scheduler = undefined;
    }
    const byQuery: Record<string, SyncQueryStat> = {};
    for (const [name, stat] of state.byQuery) byQuery[name] = { ...stat };
    const byStage = {} as Record<SyncStageName, SyncStageStat>;
    for (const stage of SYNC_STAGE_NAMES) {
      byStage[stage] = { ...(state.stages.byStage.get(stage) ?? freshStageStat()) };
    }
    return {
      takenAtMs: now(),
      ...(state.ipcAssertTimedOut === undefined
        ? {}
        : {
            ipcAssertTimedOut: state.ipcAssertTimedOut,
            ipcAssertLastClient: state.ipcAssertLastClient,
          }),
      transport: {
        inFlight: live ? live.inFlight : null,
        queued: live ? live.queued : null,
        limit: live ? live.limit : null,
        ...state.transport,
      },
      ...(scheduler ? { scheduler } : {}),
      byQuery,
      sse: {
        connectedSinceMs:
          state.sse.connectedAt !== null ? now() - state.sse.connectedAt : null,
        reconnectCount: state.sse.reconnectCount,
        eventsReceived: state.sse.eventsReceived,
        lastEventLatencyMs: state.sse.lastEventLatencyMs,
        bytesReceived: state.sse.bytesReceived,
      },
      cache: { ...state.cache },
      invalidations: {
        ...state.invalidations,
        bySseName: Object.fromEntries(state.invalidationsBySseName),
      },
      stages: {
        unit: 'ms',
        byStage,
        recent: state.stages.recent.slice(),
        invalidSamples: state.stages.invalidSamples,
      },
    };
  },
  // Test/debug only — wipe counters.
  __resetForTests(): void {
    state.sse.connectedAt = null;
    state.sse.reconnectCount = 0;
    state.sse.eventsReceived = 0;
    state.sse.lastEventLatencyMs = null;
    state.sse.bytesReceived = 0;
    state.cache.hits = 0;
    state.cache.misses = 0;
    state.invalidations.fromSse = 0;
    state.invalidations.fromTimer = 0;
    state.invalidations.fromManual = 0;
    state.invalidationsBySseName.clear();
    state.ipcAssertTimedOut = undefined;
    state.ipcAssertLastClient = null;
    state.transport = freshTransport();
    state.byQuery.clear();
    state.recent.length = 0;
    state.gateProbe = null;
    state.schedulerProbe = null;
    resetStageStats();
    nextTraceId = 1;
  },
};

/**
 * Install the metrics object on `window.__sync_metrics__`. Idempotent —
 * calling twice from different transport mounts won't re-install. Call from
 * each adapter's mount effect so the global is available regardless of which
 * transport is active.
 */
export function installSyncMetricsGlobal(): void {
  if (typeof window === 'undefined') return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__sync_metrics__) return;
  w.__sync_metrics__ = {
    snapshot: () => syncMetrics.snapshot(),
    /** Every query this page has issued (bounded ring) — the hydration wave. */
    queries: () => syncMetrics.recentQueries(),
    /** Every accepted freshness stage (bounded ring), all durations in ms. */
    stages: () => syncMetrics.recentStages(),
    // Convenience: pretty-print to console.
    log: () => {
      // eslint-disable-next-line no-console
      console.table(syncMetrics.snapshot());
    },
    /** Per-queryName cost table, heaviest first — the P-002 view, live. */
    logQueries: () => {
      const { byQuery } = syncMetrics.snapshot();
      const rows = Object.entries(byQuery)
        .map(([name, s]) => ({
          name,
          requests: s.requests,
          kb: Math.round(s.bytes / 1024),
          avgMs: s.requests ? Math.round(s.requestMsTotal / s.requests) : 0,
          maxMs: Math.round(s.requestMsMax),
          waitMs: Math.round(s.waitMsTotal),
          failures: s.failures,
        }))
        .sort((a, b) => b.kb - a.kb);
      // eslint-disable-next-line no-console
      console.table(rows);
    },
    /**
     * EI-19406583179082751: per-name SSE-push volume, heaviest first, with `refetched`
     * (from `byQuery.requests`) alongside it — a name with a high `sseInvalidations` and
     * `refetched: 0` is a server broadcast this page never asked for (either unobserved
     * on this route, or a `queryClient.invalidateQueries` predicate matching zero mounted
     * queries). Answers "which query names dominate the push volume" directly, without a
     * bespoke repro script.
     */
    logInvalidationsBySse: () => {
      const { invalidations, byQuery } = syncMetrics.snapshot();
      const rows = Object.entries(invalidations.bySseName)
        .map(([name, sseInvalidations]) => ({
          name,
          sseInvalidations,
          refetched: byQuery[name]?.requests ?? 0,
        }))
        .sort((a, b) => b.sseInvalidations - a.sseInvalidations);
      // eslint-disable-next-line no-console
      console.table(rows);
    },
  };
}
