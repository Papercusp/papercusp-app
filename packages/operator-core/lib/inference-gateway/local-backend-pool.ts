/**
 * local-backend-pool — LIVE runtime state for the local inference-backend pool
 * (local-concurrent-inference-2026-07-02 P-004, D-002). The registry
 * (local-backend-store.ts) says what backends EXIST; this module tracks what's
 * HEALTHY and BUSY right now and picks where the next request goes — the local
 * peer of the Claude/Codex `AccountPool` (gateway.ts), with the same
 * `reload(next)` hot-swap shape (B-HOT-1 parity) so a registry change applies
 * to the running gateway without a restart.
 *
 * Selection is least-loaded (fewest in-flight requests) among ENABLED,
 * HEALTHY backends serving the requested model id. When the backend engine
 * reports fresh physical slots, that reading is the capacity gate;
 * registry `maxConcurrent` remains policy/diagnostic metadata only. Missing
 * or stale engine evidence is deliberately unbounded for routing.
 * Health demotes after HEALTH_FAIL_THRESHOLD consecutive failures — periodic
 * probes (runHealthChecks) AND live request outcomes (recordOutcome) both feed
 * it, so a backend that dies mid-traffic is skipped within 2 failed requests,
 * not just at the next probe tick (mirrors the proactive egress prober's
 * 2-consecutive-failure circuit in gateway.ts).
 *
 * SLOT AFFINITY (deterministic-context-carry P-028, context-is-rent): when the
 * caller passes its owner id, selection PREFERS the backend that owner last
 * used — the session's KV prefix lives in that llama-server process, and the
 * server's own prompt-similarity slot matching then reuses the warm slot; a
 * switch to a different process forces a full re-prefill (minutes of GPU for a
 * long context). Sticky beats least-loaded as long as the sticky backend is
 * eligible (enabled, healthy, serves the model, under maxConcurrent, not
 * already tried this request); it is NEVER waited on — at capacity the request
 * falls over to least-loaded (a counted `switch`, the eviction-rate numerator)
 * rather than queueing, so throughput semantics are unchanged.
 */

export type LocalBackendKind = 'llama-server' | 'vllm' | 'ollama';

export interface LocalBackend {
  id: string;
  kind: LocalBackendKind;
  /** No trailing slash. The OpenAI-compatible surface lives at `${baseUrl}/v1/...`. */
  baseUrl: string;
  models: readonly string[];
  maxConcurrent: number;
  enabled: boolean;
  /** How this backend's PROCESS is managed (registry fact, migration 843). Carried into the live
   *  pool because the ROUTING path needs it: a dead end for a model is startable only when the
   *  backend serving it is 'on-demand' (P-008/D-009). Optional so every pre-P-008 construction
   *  site (tests, fixtures) stays valid; absent reads as 'always-on' — the safe default, since it
   *  makes a backend NOT startable, mirroring the store's defensive narrowing. */
  lifecycle?: 'always-on' | 'on-demand';
  /** The systemd --user unit owning this backend's process, e.g. `llama-ornith.service`.
   *  ⚠ NOT derivable from baseUrl (D-005) — ornith's baseUrl is a cheap always-on proxy, not the
   *  GPU-resident process. Absent ⇒ nothing to start, so the backend is treated as not startable. */
  unitName?: string | null;
}

export interface LocalBackendHealth {
  healthy: boolean;
  lastCheckedAt: number;
  latencyMs: number | null;
  error: string | null;
  consecutiveFailures: number;
}

export interface LocalBackendCandidate {
  backend: LocalBackend;
  inFlight: number;
  healthy: boolean;
  /** Fresh physical engine evidence. The pool adjusts freeSlots for activity
   * since the observation before exposing candidates. */
  engineCapacity?: LocalBackendEngineCapacity | null;
}

/** Physical capacity reported by a backend engine (for example llama-server
 * `/props`). This is deliberately separate from registry maxConcurrent, which
 * is local policy and never a physical ceiling. */
export interface LocalBackendEngineCapacity {
  readonly freeSlots?: number | null;
  readonly totalSlots?: number | null;
  readonly contextTokens?: number | null;
  readonly observedAtMs: number;
  readonly source?: string;
}

/** Engine readings older than this are unsuitable for headroom/saturation. */
export const ENGINE_CAPACITY_FRESH_FOR_MS = 15_000;

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function freshEngineCapacity(capacity: LocalBackendEngineCapacity | null | undefined, now = Date.now()): boolean {
  return (
    capacity !== null &&
    capacity !== undefined &&
    finiteNonNegative(capacity.freeSlots) &&
    Number.isFinite(capacity.observedAtMs) &&
    now >= capacity.observedAtMs &&
    now - capacity.observedAtMs <= ENGINE_CAPACITY_FRESH_FOR_MS
  );
}

function engineFreeSlots(candidate: LocalBackendCandidate, now = Date.now()): number | undefined {
  if (!freshEngineCapacity(candidate.engineCapacity, now)) return undefined;
  return Math.max(0, candidate.engineCapacity!.freeSlots!);
}

/** Consecutive failures (probe OR live request) before a backend drops out of
 *  selection. A lone blip doesn't evict it — mirrors the gateway's proactive
 *  egress-probe circuit threshold. */
export const HEALTH_FAIL_THRESHOLD = 2;

export const DEFAULT_HEALTH_TIMEOUT_MS = 4000;

/**
 * Pure selection: the least-loaded eligible backend serving `model`, or null
 * when none qualify (not registered for this model, disabled, unhealthy, or
 * every candidate with fresh engine evidence has no free slot). Candidates
 * without fresh evidence are eligible: unknown/stale capacity is unbounded
 * for routing and never falls back to maxConcurrent.
 * Ties broken by id for determinism (round-robin-ish across equally-idle
 * backends without needing a cursor).
 */
export function pickLeastLoaded(
  candidates: readonly LocalBackendCandidate[],
  model: string,
  exclude?: ReadonlySet<string>,
): LocalBackend | null {
  const eligible = candidates.filter(
    (c) =>
      c.backend.enabled &&
      c.healthy &&
      c.backend.models.includes(model) &&
      (engineFreeSlots(c) === undefined || engineFreeSlots(c)! > 0) &&
      !exclude?.has(c.backend.id),
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => a.inFlight - b.inFlight || a.backend.id.localeCompare(b.backend.id));
  return eligible[0].backend;
}

/**
 * Pure saturation check — the exact complement of `pickLeastLoaded` returning null. True when
 * `model` IS served by ≥1 enabled + healthy (non-excluded) backend but EVERY such backend with
 * fresh engine evidence has no free slot: retryable BACKPRESSURE the caller should answer with a
 * 429 + Retry-After. False when NO enabled+healthy backend serves the model (unmatched /
 * all-unhealthy — a genuine dead end the caller should 502), or when a slot is free (select() would
 * have returned a backend). Unknown/stale engine evidence is not saturation evidence. `exclude`
 * matches `pickLeastLoaded` (ids already tried this request).
 */
export function isSaturatedFor(
  candidates: readonly LocalBackendCandidate[],
  model: string,
  exclude?: ReadonlySet<string>,
): boolean {
  const serving = candidates.filter(
    (c) => c.backend.enabled && c.healthy && c.backend.models.includes(model) && !exclude?.has(c.backend.id),
  );
  if (serving.length === 0) return false;
  return serving.every((c) => {
    const free = engineFreeSlots(c);
    return free !== undefined && free <= 0;
  });
}

/** Outcome kind of one affinity-aware selection (P-028): `hit` = the owner's sticky backend was
 *  chosen (KV prefix survives); `switch` = the owner HAD a sticky backend but it was ineligible
 *  (saturated/unhealthy/tried) so a different one was picked — the re-prefill event the dashboard's
 *  eviction rate counts; `cold` = first assignment for this owner. */
export type AffinityOutcome = 'hit' | 'switch' | 'cold';

/**
 * Pure affinity-aware selection: prefer `preferredId` when it is eligible for `model` (sticky KV
 * reuse wins over load-balance), else fall back to `pickLeastLoaded`. Returns the pick plus the
 * affinity outcome relative to whether a preference existed.
 */
export function pickWithAffinity(
  candidates: readonly LocalBackendCandidate[],
  model: string,
  preferredId: string | null,
  exclude?: ReadonlySet<string>,
): { backend: LocalBackend | null; outcome: AffinityOutcome | null } {
  if (preferredId && !exclude?.has(preferredId)) {
    const preferred = candidates.find(
      (c) =>
        c.backend.id === preferredId &&
        c.backend.enabled &&
        c.healthy &&
        c.backend.models.includes(model) &&
        (engineFreeSlots(c) === undefined || engineFreeSlots(c)! > 0),
    );
    if (preferred) return { backend: preferred.backend, outcome: 'hit' };
  }
  const backend = pickLeastLoaded(candidates, model, exclude);
  if (!backend) return { backend: null, outcome: null }; // nothing assigned — no affinity event
  return { backend, outcome: preferredId ? 'switch' : 'cold' };
}

/** Sticky owner→backend entries beyond this are pruned oldest-first (bounded memory for a
 *  long-lived gateway serving many short-lived owners). */
export const AFFINITY_MAX_OWNERS = 4096;
/** A sticky entry older than this is treated as cold — the KV slot is long since recycled by
 *  other traffic, so following it would pin for no benefit. */
export const AFFINITY_TTL_MS = 60 * 60 * 1000;

export interface AffinityStats {
  hits: number;
  /** Sticky backend existed but was ineligible → routed elsewhere (the eviction/re-prefill count). */
  switches: number;
  cold: number;
  trackedOwners: number;
}

/** Pure health-state transition given one probe/request outcome (testable without a clock/network). */
export function nextHealthState(
  prev: LocalBackendHealth | undefined,
  ok: boolean,
  latencyMs: number,
  error: string | null,
  now: number,
): LocalBackendHealth {
  const consecutiveFailures = ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
  const healthy = ok ? true : consecutiveFailures < HEALTH_FAIL_THRESHOLD && (prev?.healthy ?? true);
  return {
    healthy,
    lastCheckedAt: now,
    latencyMs: ok ? latencyMs : (prev?.latencyMs ?? null),
    error,
    consecutiveFailures,
  };
}

export interface LocalBackendPool {
  /** Read-only snapshot of the live registry (no cursor advance). */
  entries(): readonly LocalBackend[];
  size(): number;
  /** HOT-SWAP the live entries (B-HOT-1 parity) — drops in-flight/health state for ids no longer
   *  present; keeps it for ids that survive the reload (a re-registered backend's live counters
   *  aren't reset by an unrelated sibling's edit). */
  reload(next: readonly LocalBackend[]): void;
  /** Least-loaded eligible backend for `model`, or null (no match / all saturated / all unhealthy).
   *  `exclude` skips ids already tried THIS request (single-attempt in-request failover — the caller
   *  need not wait for HEALTH_FAIL_THRESHOLD failures before trying a sibling backend).
   *  `ownerId` (P-028) opts into slot affinity: the owner's last backend is preferred while
   *  eligible, and the assignment is remembered for the next hop. */
  select(model: string, exclude?: ReadonlySet<string>, ownerId?: string): LocalBackend | null;
  /** Affinity hit/switch/cold counters since boot (P-028) — `switches` is the dashboard's
   *  eviction-rate numerator (a sticky backend abandoned → KV re-prefill on the new one). */
  affinityStats(): AffinityStats;
  /** True when `model` is served by ≥1 enabled+healthy backend but ALL have measured engine
   * capacity exhausted — i.e.
   *  select() returned null from SATURATION (retryable backpressure → 429), not from the model being
   *  unmatched / all-unhealthy (a genuine dead end → 502). `exclude` matches select()'s. */
  saturatedFor(model: string, exclude?: ReadonlySet<string>): boolean;
  recordStart(id: string): void;
  recordEnd(id: string): void;
  inFlight(id: string): number;
  /** Feed a LIVE request's outcome into the health state — lets a mid-traffic death get skipped
   *  within HEALTH_FAIL_THRESHOLD failed requests, without waiting for the next probe tick. */
  recordOutcome(id: string, ok: boolean, error?: string | null): void;
  health(): ReadonlyMap<string, LocalBackendHealth>;
  /** Replace the latest physical engine-capacity reading for one registered backend. */
  updateEngineCapacity(id: string, capacity: LocalBackendEngineCapacity | null): void;
  /** Alias for updateEngineCapacity, retained for setter-oriented callers. */
  setEngineCapacity(id: string, capacity: LocalBackendEngineCapacity | null): void;
  /** Read the latest raw engine-capacity reading (without in-flight adjustment). */
  engineCapacity(id: string): LocalBackendEngineCapacity | null;
  /** Probe every registered backend's `${baseUrl}/v1/models` (supported by llama-server, vllm, and
   *  ollama's OpenAI-compat surface alike) and update health state. Injectable fetch for tests. */
  runHealthChecks(fetchImpl?: typeof fetch, timeoutMs?: number): Promise<void>;
}

export function createLocalBackendPool(initial: readonly LocalBackend[] = []): LocalBackendPool {
  let backends = new Map<string, LocalBackend>(initial.map((b) => [b.id, b]));
  const inFlightCounts = new Map<string, number>();
  const healthMap = new Map<string, LocalBackendHealth>();
  // Keep the raw engine reading plus the pool counter observed alongside it.
  // The baseline lets us reconcile local starts/ends against a physical
  // reading without treating the same request as two slots consumed.
  const engineCapacityMap = new Map<string, { capacity: LocalBackendEngineCapacity; inFlightAtObservation: number }>();
  // P-028: owner → last backend. Insertion-ordered Map doubles as the LRU — a re-assignment
  // deletes + re-sets so the oldest entry is always first for pruning.
  const affinity = new Map<string, { backendId: string; assignedAt: number }>();
  const affinityCounters = { hits: 0, switches: 0, cold: 0 };

  function candidatesFor(): LocalBackendCandidate[] {
    return [...backends.values()].map((backend) => {
      const inFlight = inFlightCounts.get(backend.id) ?? 0;
      const measured = engineCapacityMap.get(backend.id);
      let engineCapacity: LocalBackendEngineCapacity | null = null;
      if (measured) {
        const delta = inFlight - measured.inFlightAtObservation;
        const freeSlots = finiteNonNegative(measured.capacity.freeSlots)
          ? Math.max(0, measured.capacity.freeSlots - delta)
          : measured.capacity.freeSlots;
        engineCapacity = { ...measured.capacity, freeSlots };
      }
      return {
        backend,
        inFlight,
        // Optimistic default: a backend never checked yet (fresh register, checks not yet ticked) is
        // usable immediately — the FIRST probe or live failure is what demotes it, not silence.
        healthy: healthMap.get(backend.id)?.healthy ?? true,
        engineCapacity,
      };
    });
  }

  return {
    entries: () => [...backends.values()],
    size: () => backends.size,
    reload(next) {
      const nextIds = new Set(next.map((b) => b.id));
      backends = new Map(next.map((b) => [b.id, b]));
      for (const id of [...inFlightCounts.keys()]) if (!nextIds.has(id)) inFlightCounts.delete(id);
      for (const id of [...healthMap.keys()]) if (!nextIds.has(id)) healthMap.delete(id);
      for (const id of [...engineCapacityMap.keys()]) if (!nextIds.has(id)) engineCapacityMap.delete(id);
      for (const [owner, a] of [...affinity.entries()]) if (!nextIds.has(a.backendId)) affinity.delete(owner);
    },
    select(model, exclude, ownerId) {
      if (!ownerId) return pickLeastLoaded(candidatesFor(), model, exclude);
      const now = Date.now();
      const sticky = affinity.get(ownerId);
      const preferredId = sticky && now - sticky.assignedAt <= AFFINITY_TTL_MS ? sticky.backendId : null;
      const { backend, outcome } = pickWithAffinity(candidatesFor(), model, preferredId, exclude);
      if (!backend) return null;
      if (outcome) affinityCounters[outcome === 'hit' ? 'hits' : outcome === 'switch' ? 'switches' : 'cold']++;
      affinity.delete(ownerId); // re-set for insertion-order LRU
      affinity.set(ownerId, { backendId: backend.id, assignedAt: now });
      while (affinity.size > AFFINITY_MAX_OWNERS) {
        const oldest = affinity.keys().next().value;
        if (oldest === undefined) break;
        affinity.delete(oldest);
      }
      return backend;
    },
    affinityStats: () => ({ ...affinityCounters, trackedOwners: affinity.size }),
    saturatedFor(model, exclude) {
      return isSaturatedFor(candidatesFor(), model, exclude);
    },
    recordStart(id) {
      inFlightCounts.set(id, (inFlightCounts.get(id) ?? 0) + 1);
    },
    recordEnd(id) {
      const cur = inFlightCounts.get(id) ?? 0;
      if (cur <= 1) inFlightCounts.delete(id);
      else inFlightCounts.set(id, cur - 1);
    },
    inFlight: (id) => inFlightCounts.get(id) ?? 0,
    recordOutcome(id, ok, error = null) {
      if (!backends.has(id)) return;
      healthMap.set(id, nextHealthState(healthMap.get(id), ok, healthMap.get(id)?.latencyMs ?? 0, error, Date.now()));
    },
    health: () => new Map(healthMap),
    updateEngineCapacity(id, capacity) {
      if (!backends.has(id)) return;
      if (capacity === null) {
        engineCapacityMap.delete(id);
        return;
      }
      engineCapacityMap.set(id, {
        capacity: { ...capacity },
        inFlightAtObservation: inFlightCounts.get(id) ?? 0,
      });
    },
    setEngineCapacity(id, capacity) {
      if (!backends.has(id)) return;
      if (capacity === null) {
        engineCapacityMap.delete(id);
        return;
      }
      engineCapacityMap.set(id, {
        capacity: { ...capacity },
        inFlightAtObservation: inFlightCounts.get(id) ?? 0,
      });
    },
    engineCapacity: (id) => {
      const value = engineCapacityMap.get(id)?.capacity;
      return value ? { ...value } : null;
    },
    async runHealthChecks(fetchImpl = fetch, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
      await Promise.all(
        [...backends.values()].map(async (backend) => {
          const startedAt = Date.now();
          let ok = false;
          let error: string | null = null;
          try {
            const r = await fetchImpl(`${backend.baseUrl}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
            ok = r.ok;
            if (!ok) error = `probe returned ${r.status}`;
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
          const latencyMs = Date.now() - startedAt;
          healthMap.set(backend.id, nextHealthState(healthMap.get(backend.id), ok, latencyMs, error, Date.now()));
        }),
      );
    },
  };
}
