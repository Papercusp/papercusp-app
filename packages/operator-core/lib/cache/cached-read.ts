/**
 * cachedRead — the ONE operator-side wrapper over `getOperatorCache().getOrSet`
 * (cache-expensive-tool-reads-2026-06-22 P-001 / D-003).
 *
 * Standardizes the five things every cache consumer must get right, in ONE place,
 * so each integration is ~3 lines and uniform and a future cross-cutting change
 * (a new bypass condition, richer metrics) lands here once:
 *
 *   1. workspace-scope — resolved EXACTLY as the cache-invalidation ECA bump does
 *      (`ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId()`, see
 *      `events/dispatch-reaction.ts`), so a `getOrSet` entry and the `cache.bumpTags`
 *      that must invalidate it share ONE `(workspace, tag)` generation. Throws on an
 *      empty resolve (the D-010 cross-workspace-leak guard).
 *   2. key namespacing — every key is prefixed with the tool name, so two tools can
 *      never collide on a coincidentally-equal arg key, and a key is greppable to its
 *      owning tool.
 *   3. the CACHE_LAYER kill-switch — honored by the underlying cache's `bypass` seam
 *      (getOrSet runs the factory byte-identically when off); this wrapper adds nothing
 *      that defeats it.
 *   4. per-tool telemetry — hit/miss/stale/bypass counters PER TOOL (the shared
 *      `cache.stats` can't attribute per consumer), via the cache's `onOutcome` hook.
 *   5. a deterministic args→key serializer ({@link stableKey}) — stable regardless of
 *      object key-order, so `{ a, b }` and `{ b, a }` map to the SAME cache entry.
 *
 * Reuse, NOT a new system: a thin call over the existing singleton cache + the ECA
 * invalidation already wired off the change stream.
 */

import { getOrSetBounded, type CacheOutcome, type CacheReadReason } from "@papercusp/cache";
import { getOperatorCache } from "./instance";
import { withL2, type L2Outcome } from "./l2-tier";
import { activeWorkspaceId } from "../workspace-registry";

/** The slice of a tool ctx cachedRead needs — workspace resolution only. */
export interface CachedReadCtx {
  workspaceId?: string | null;
  principal?: { workspaceId?: string | null } | null;
}

/**
 * Default HARD TTL applied when a consumer sets no `hardTtlMs` (WI-1547 defense-
 * in-depth). SWR (`softTtlMs`) serves a stale entry of ANY age and revalidates in
 * the background — which is only bounded when the cache-ECA invalidation rail is
 * live. WI-1547 (plans:get returning ~45-min-stale snapshots) proved the rail can
 * be silently inert in a whole process (a reuseport cluster worker whose lazy
 * SSE-started LISTEN never started), making "stale once per idle period" unbounded.
 * A hard TTL forces a BLOCKING rebuild past this age, so the worst-case staleness
 * of ANY cachedRead is bounded even with the rail down. Env-tunable
 * (`PAPERCUSP_CACHED_READ_HARD_TTL_MS`; `0` disables the default). An explicit
 * caller `hardTtlMs` always wins — including `0`, which in the underlying lib
 * means "always rebuild".
 */
export const DEFAULT_CACHED_READ_HARD_TTL_MS = 600_000;

function defaultHardTtlMs(): number | undefined {
  const raw = process.env.PAPERCUSP_CACHED_READ_HARD_TTL_MS;
  if (raw !== undefined && raw !== "") {
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) return v > 0 ? v : undefined; // 0 ⇒ disabled
  }
  return DEFAULT_CACHED_READ_HARD_TTL_MS;
}

export interface CachedReadOptions<V = unknown> {
  /** Tool name — the key namespace AND the telemetry bucket (e.g. 'plans:list'). */
  tool: string;
  /**
   * Everything BESIDES the workspace + tool that varies the result: the serialized
   * args + any ctx-derived dimension (e.g. the resolved harness set). A string is
   * used verbatim; anything else is run through {@link stableKey}. The caller is
   * responsible for including EVERY output-determining dimension here — a missed
   * dimension is a cross-arg leak.
   */
  key: unknown;
  /** Base-table-name data dependencies — a write to any one auto-invalidates (ECA). */
  tags: readonly string[];
  /** Serve-stale-and-revalidate after this many ms (backstop for un-triggered deps). */
  softTtlMs?: number;
  /**
   * Force a blocking rebuild after this many ms. Omitted ⇒ the WI-1547 default
   * ({@link DEFAULT_CACHED_READ_HARD_TTL_MS}) bounds worst-case staleness; an
   * explicit value (including 0 = always rebuild) is passed through verbatim.
   */
  hardTtlMs?: number;
  /** Also cache null/undefined factory results (negative caching). Default false. */
  cacheEmpty?: boolean;
  /**
   * Cap the CALLER's wait at this many ms when the read would actually run the
   * factory (a cold miss, or a forced blocking rebuild past `hardTtlMs`/an
   * invalidation) — EI-184 (plans:attention occasionally exceeding its 60s tool-call
   * ceiling on a post-restart cold L1: `getOrSet`'s 'dead' path blocks on the FULL
   * factory duration with no bound). A fresh hit or an SWR stale-serve resolves
   * immediately regardless — this only bounds the genuinely-blocking path, via the
   * existing {@link getOrSetBounded} (built for exactly this "prompt-build" shape:
   * the underlying build keeps running in the background and lands in cache for the
   * NEXT caller even after this caller's wait times out). Requires `onDeadline`.
   * Omitted (default) ⇒ today's unbounded behavior, byte-identical for every
   * existing consumer.
   */
  deadlineMs?: number;
  /**
   * Required alongside `deadlineMs`: the degraded value to return when the wait
   * hits the deadline — the caller's degrade policy (cachedRead never invents a
   * fallback). Mirror the factory's own best-effort philosophy (e.g. an empty/
   * partial result), not an error — a deadline is a graceful degrade, not a failure.
   */
  onDeadline?: () => V | Promise<V>;
  /**
   * Opt this read into the durable L2 tier (P-007 / D-082) — a cross-process
   * Postgres-backed store consulted on an L1 miss, so ONE worker's build serves the
   * whole 16-worker cluster instead of each paying its own cold build (D-078).
   *
   * OPT-IN, not default, for one concrete reason: an L2 value crosses a jsonb
   * round-trip, so a `Date`/`Map`/`Set` inside it would come back reshaped. Only
   * opt in a read whose value is plain JSON. Gated globally by `FLAGS.CACHE_L2`
   * (and subordinate to `CACHE_LAYER`); off ⇒ byte-identical to L1-only.
   *
   * Requires a `softTtlMs` (or `hardTtlMs`) — it bounds the L2 row's life so L2 can
   * never serve a value that would already have gone stale in L1. See l2-tier.ts.
   */
  l2?: boolean;
}

/**
 * Resolve the cache workspace EXACTLY as the ECA bump does (events/dispatch-reaction.ts)
 * so a cached entry and the invalidation that targets it share one generation. Throws
 * if no non-empty workspace can be resolved (the D-010 cross-workspace guard).
 */
export function resolveCacheWorkspaceId(ctx: CachedReadCtx): string {
  const ws =
    ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
  if (!ws || !ws.trim()) {
    throw new Error(
      "cachedRead: no workspace to scope the cache key (workspace-scoped — D-010)",
    );
  }
  return ws;
}

/**
 * Deterministic, key-order-stable serialization of an args/key value to a string.
 * Object keys are sorted recursively, so `{ a:1, b:2 }` and `{ b:2, a:1 }` serialize
 * identically; `undefined` object fields are dropped (an absent arg == an undefined
 * arg). Arrays keep their order (the caller sorts where order is irrelevant, e.g. a
 * harness set). Primitives serialize via JSON. NOT cryptographic — a stable cache
 * discriminator only.
 */
export function stableKey(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  // JSON argument keys such as __proto__ must stay data, never invoke a setter.
  const out: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v === undefined) continue;
    out[k] = canonicalize(v);
  }
  return out;
}

// ── vitest safety gate ──────────────────────────────────────────────────────────────
// Under the vitest runner the cache-invalidation ECA (change-stream → cache.bumpTags)
// is NOT wired, so a cached tool read can't observe a same-process write — which would
// silently break the many tool-handler tests that create/mutate then re-read (e.g.
// work_items create→get→claim→get). So cachedRead BYPASSES under VITEST unless a cache
// test explicitly opts in via __setCachedReadEnabledForTests(true). This gates ONLY the
// tool-read wrapper, not getOperatorCache() itself (the cache-infra tests are untouched),
// and is inert outside vitest — a real-operator test (Playwright/LLM, VITEST unset) has
// the ECA wired, so caching stays coherent there.
let testCacheEnabled = false;

/** Test-only: enable cachedRead under the vitest runner (it bypasses by default — see above). */
export function __setCachedReadEnabledForTests(on: boolean): void {
  testCacheEnabled = on;
}

// ── per-tool telemetry (the shared cache.stats can't attribute per consumer) ────────
export interface CachedReadToolStats {
  hits: number;
  misses: number;
  stale: number;
  bypass: number;
  /** `deadlineMs` was set AND the wait hit it — the factory kept building in the
   *  background; this caller got `onDeadline()`'s degraded value instead (EI-184). */
  deadline: number;
  /** L1 missed AND the durable L2 tier served the value — a cold build AVOIDED,
   *  which is the whole point of L2 (D-082). Only ever nonzero for an `l2: true`
   *  read while `FLAGS.CACHE_L2` is on. */
  l2Hits: number;
  /** L1 missed, L2 missed too ⇒ this call paid a real build. */
  l2Misses: number;
  /** The L2 store errored and the read degraded to a real build. Persistent
   *  nonzero here means the tier is silently doing nothing — worth alerting on. */
  l2Errors: number;
  /** Lookup misses; absent cannot distinguish a new key from eviction/listener reconnect. */
  missAbsent: number;
  missInvalidated: number;
  missHardExpired: number;
  /** Actual factory invocations, excluding L2 hits and single-flight joins; includes bypass/SWR. */
  builds: number;
  /** Settled invocations covered by buildMs; builds - buildsCompleted are still running. */
  buildsCompleted: number;
  buildErrors: number;
  /** Monotonic elapsed factory time, including failed builds. No prompt/key payloads retained. */
  buildMs: number;
  maxBuildMs: number;
}

const TOOL_STATS = new Map<string, CachedReadToolStats>();

function emptyStats(): CachedReadToolStats {
  return {
    hits: 0, misses: 0, stale: 0, bypass: 0, deadline: 0,
    l2Hits: 0, l2Misses: 0, l2Errors: 0,
    missAbsent: 0, missInvalidated: 0, missHardExpired: 0,
    builds: 0, buildsCompleted: 0, buildErrors: 0, buildMs: 0, maxBuildMs: 0,
  };
}

/** Per-tool L2 telemetry. Separate from {@link recordOutcome} because an L2
 *  consultation happens INSIDE a miss — it refines a miss, it never replaces one. */
function recordL2(tool: string, outcome: L2Outcome): void {
  if (outcome === "off") return;
  let s = TOOL_STATS.get(tool);
  if (!s) {
    s = emptyStats();
    TOOL_STATS.set(tool, s);
  }
  if (outcome === "hit") s.l2Hits++;
  else if (outcome === "miss") s.l2Misses++;
  else s.l2Errors++;
}

function recordOutcome(tool: string, outcome: CacheOutcome, reason: CacheReadReason): void {
  let s = TOOL_STATS.get(tool);
  if (!s) {
    s = emptyStats();
    TOOL_STATS.set(tool, s);
  }
  if (outcome === "hit") s.hits++;
  else if (outcome === "miss") {
    s.misses++;
    if (reason === "absent") s.missAbsent++;
    else if (reason === "invalidated") s.missInvalidated++;
    else if (reason === "hard-ttl") s.missHardExpired++;
  }
  else if (outcome === "stale") s.stale++;
  else s.bypass++;
}

function recordDeadline(tool: string): void {
  let s = TOOL_STATS.get(tool);
  if (!s) {
    s = emptyStats();
    TOOL_STATS.set(tool, s);
  }
  s.deadline++;
}

/** Snapshot per-tool cache telemetry (a copy — callers can't mutate the live counters). */
export function snapshotCachedReadStats(): Record<string, CachedReadToolStats> {
  const out: Record<string, CachedReadToolStats> = {};
  for (const [tool, s] of TOOL_STATS) out[tool] = { ...s };
  return out;
}

/** Test-only: clear the per-tool telemetry counters. */
export function resetCachedReadStatsForTests(): void {
  TOOL_STATS.clear();
}

/**
 * Run `factory` through the operator cache: workspace-scoped + tag-invalidated +
 * kill-switch-honoring + per-tool-metered. Returns the factory result (cached or
 * freshly built). The factory MUST be PURE / side-effect-free (D-001) — a cache hit
 * skips it entirely, and an SWR stale-serve runs it in the BACKGROUND.
 */
export async function cachedRead<V>(
  ctx: CachedReadCtx,
  opts: CachedReadOptions<V>,
  factory: () => Promise<V> | V,
): Promise<V> {
  // Vitest safety gate: bypass the cache under test (the ECA isn't wired) unless a cache
  // test opted in. Byte-identical to no cache — just runs the factory.
  if (process.env.VITEST && !testCacheEnabled) return factory();
  const workspaceId = resolveCacheWorkspaceId(ctx);
  const keyPart = typeof opts.key === "string" ? opts.key : stableKey(opts.key);
  const fullKey = `${opts.tool}|${keyPart}`;
  const hardTtl = opts.hardTtlMs !== undefined ? opts.hardTtlMs : defaultHardTtlMs();
  const measuredFactory = async (): Promise<V> => {
    let stats = TOOL_STATS.get(opts.tool);
    if (!stats) {
      stats = emptyStats();
      TOOL_STATS.set(opts.tool, stats);
    }
    stats.builds++;
    const started = performance.now();
    try {
      return await factory();
    } catch (error) {
      stats.buildErrors++;
      throw error;
    } finally {
      const elapsed = Math.max(0, performance.now() - started);
      stats.buildsCompleted++;
      stats.buildMs += elapsed;
      stats.maxBuildMs = Math.max(stats.maxBuildMs, elapsed);
    }
  };

  // L2 read-through/write-through (D-082). Wrapping the FACTORY — rather than the
  // cache — is what makes this need no change to the generic lib: `getOrSet` runs the
  // factory on exactly an L1 miss/dead entry, which is exactly when L2 should be
  // consulted. A fresh L1 hit never reaches this and never touches Postgres.
  // `withL2` returns `factory` UNCHANGED when the tier is off, so a disabled L2 is
  // byte-identical to the L1-only path.
  const effectiveFactory = opts.l2
    ? withL2(workspaceId, fullKey, measuredFactory, {
        tags: opts.tags,
        ...(opts.softTtlMs !== undefined ? { softTtlMs: opts.softTtlMs } : {}),
        ...(hardTtl !== undefined ? { hardTtlMs: hardTtl } : {}),
        onL2Outcome: (o: L2Outcome) => recordL2(opts.tool, o),
      })
    : measuredFactory;

  const getOrSetOpts = {
    tags: opts.tags,
    ...(opts.softTtlMs !== undefined ? { softTtlMs: opts.softTtlMs } : {}),
    // WI-1547: no explicit hardTtl ⇒ the bounded-staleness default (see above).
    ...(hardTtl !== undefined ? { hardTtlMs: hardTtl } : {}),
    ...(opts.cacheEmpty !== undefined ? { cacheEmpty: opts.cacheEmpty } : {}),
    onOutcome: (outcome: CacheOutcome, reason: CacheReadReason) => recordOutcome(opts.tool, outcome, reason),
  };

  if (opts.deadlineMs === undefined) {
    return getOperatorCache().getOrSet(workspaceId, fullKey, effectiveFactory, getOrSetOpts);
  }

  // EI-184: bound the wait via getOrSetBounded — the underlying build keeps
  // running (single-flight) and lands in cache for the next caller even after
  // this caller's wait times out. `onDeadline` is the caller's required degrade
  // policy (never invented here); a factory error is re-thrown, preserving
  // today's throw-on-error semantics for the unbounded path above.
  if (!opts.onDeadline) {
    throw new Error(
      `cachedRead(${opts.tool}): deadlineMs requires onDeadline (the degrade-on-timeout value)`,
    );
  }
  const outcome = await getOrSetBounded(getOperatorCache(), workspaceId, fullKey, effectiveFactory, {
    ...getOrSetOpts,
    deadlineMs: opts.deadlineMs,
  });
  if (outcome.ok) return outcome.value;
  if (outcome.reason === "error") throw outcome.error;
  recordDeadline(opts.tool);
  return opts.onDeadline();
}
