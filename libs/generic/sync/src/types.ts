/**
 * Supported live transports are SSE and POLLING. `WEBSOCKETS` is retained as
 * a legacy compatibility input and is normalized to SSE by `SyncProvider`.
 */
export type SyncType = 'WEBSOCKETS' | 'SSE' | 'POLLING';

export interface SyncProviderProps {
  /**
   * Preferred transport. `WEBSOCKETS` is accepted for source compatibility,
   * then normalized to SSE because the Zero WebSocket adapter is unsupported.
   */
  syncType?: SyncType;
  children: React.ReactNode;
  /** User ID for the sync connection. */
  userId?: string;
  /** Server URL or REST endpoint base used by the SSE/polling transports. */
  server?: string;
  /** REST endpoint base URL for polling. Default: server value or '/zero'. */
  restEndpoint?: string;
  /**
   * Polling interval in ms for the POLLING transport and its SSE fallback,
   * where the tick IS the freshness source.
   * Default: 10_000 (10s).
   */
  pollIntervalMs?: number;
  /**
   * Drift-repair interval in ms for the SSE transport. Under SSE, freshness
   * comes from invalidate-driven refetches; this tick only repairs pushes
   * lost to an SSE blip or a table missing its invalidation bridge entry —
   * it is NOT a freshness source, so it should be LONG. (EI-278: when this
   * shared the 5-10s pollIntervalMs, every subscribed query REST-refetched
   * on that cadence on top of SSE — ~3.2 fetches/s sustained on the
   * operator's /adv page, the dominant workload behind a 16GB webview OOM.)
   * Default: 180_000 (3min).
   */
  ssePollIntervalMs?: number;
  /** Milliseconds of sustained SSE failure before fallback. Default: 10_000 (10s). */
  fallbackDelayMs?: number;
  /**
   * After falling back, wait this long before retrying the preferred
   * transport (doubles per failed retry, capped at recoveryMaxDelayMs;
   * resets once a retry sticks). 0 disables recovery. Default: 30_000.
   */
  recoveryDelayMs?: number;
  /** Cap for the doubling recovery delay. Default: 300_000 (5 min). */
  recoveryMaxDelayMs?: number;
  /**
   * @deprecated The Zero WebSocket transport was removed. Retained for source
   * compatibility with older providers; supported SSE/POLLING transports ignore
   * this reserved field.
   */
  schema?: any;
  /**
   * @deprecated Legacy Zero named-query registry. Retained for source
   * compatibility and ignored by supported transports.
   */
  queries?: any;
  /**
   * When set, the SSE EventSource URL gets `?token=<value>` appended.
   * For environments that auth via a query-string token because
   * EventSource can't carry custom headers (e.g. mobile + JWT-gated
   * `/api/device/sync/sse`).
   *
   * Only applied to the SSE transport; ignored by polling.
   */
  tokenQueryParam?: string;
  /**
   * Max sync requests in flight against the endpoint at once. Default 24.
   *
   * The polling/SSE transports issue ONE `GET /rest-query` per query and share
   * a single concurrency gate across the hook, the prefetch helper and
   * `fetchSyncQuery`. Change it only with a measurement taken over the
   * transport you actually ship on: over loopback HTTP wall time looks flat
   * from ~6 to ~24, but over the desktop's Tauri IPC path it is not — a
   * 106-query wave measured 4981ms at 12 versus 2922ms at 24 (medians). The
   * cost of raising it is per-query latency (p50 212ms → 395ms) as parallel
   * resolvers contend for the same PG pool and event loop.
   * See libs/generic/sync/src/transports/polling/query-fetcher.ts (and plan
   * drop-sync-batcher-2026-07-25 D-003).
   */
  maxInFlightFetches?: number;
  /**
   * Override the default SSE endpoint path (which is `${restEndpoint}/sse`).
   * Use the absolute path you want hit, e.g. `/api/device/sync/sse`.
   *
   * The polling fetcher still goes to `${restEndpoint}/rest-query` —
   * this only affects the EventSource URL.
   */
  endpointOverride?: string;
  /**
   * When true, the SSE adapter pauses (closes the EventSource) once
   * `document.visibilityState === 'hidden'` for VISIBILITY_PAUSE_MS,
   * and reopens on next visibility return.
   *
   * Saves battery on phones and idle background tabs without breaking
   * the polling fallback (which still ticks per `pollIntervalMs`).
   * Default: false (preserves prior always-on behavior).
   */
  visibilityPause?: boolean;
  /**
   * @deprecated Legacy Zero custom-mutator registry. Retained for source
   * compatibility and ignored by supported SSE/POLLING transports; writes use
   * the per-call REST fallback in `useSyncMutate`.
   */
  mutators?: any;
  /**
   * @deprecated KV backend for the Zero replica on the removed WebSocket
   * transport (`'mem'` sidestepped Firefox's IndexedDB quirks, which crashed WS
   * island hydration). Retained for source compatibility and ignored by
   * supported SSE/POLLING transports, which keep no local replica — the Firefox
   * failure it worked around cannot occur without the Zero client.
   */
  kvStore?: 'mem' | 'idb';
  /**
   * Query names (exact `queryName` match, e.g. `'plans.attention'`) to
   * exclude from the host app's persisted-cache snapshot by default —
   * equivalent to every `useSyncQuery` call for that name implicitly getting
   * `persist: false`, without having to annotate each call site (and without
   * missing a future one). A per-call `persist: true` overrides this for
   * that one site.
   *
   * Exists because `@papercusp/sync` is transport-agnostic and must not hold
   * app-specific query names itself (WI-6656): the HOST APP is the one that
   * knows which queries are its size outliers, so it passes the list here
   * once, at the provider. Ignored unless the host also calls
   * `enablePersistedSyncCache()` — this has no effect on the live in-memory
   * cache, only on what a persisted snapshot includes.
   */
  persistExcludeQueryNames?: readonly string[];
  /**
   * Exact query vocabulary this provider may dispatch. When present, hooks
   * outside the allowlist stay disabled and imperative prefetch/invalidate
   * calls are inert. Hosts with a deliberately narrow server endpoint use
   * this to stop mounted shared chrome from probing routes the endpoint does
   * not expose.
   */
  queryNameAllowlist?: readonly string[];
}

export interface SyncQueryOptions {
  /** Dot-separated query name from the registry: 'products.page', 'shopOrders.byCustomer' */
  queryName: string;
  /** Arguments passed to the parameterized query. */
  args?: Record<string, unknown>;
  /** Polling interval override for this specific query. */
  pollIntervalMs?: number;
  /** Whether this query is enabled. Default: true. */
  enabled?: boolean;
  /**
   * @deprecated Legacy Zero materialized-query TTL. Retained for source
   * compatibility; supported SSE/POLLING transports ignore it. Use
   * `staleTime` or `pollIntervalMs` for supported cache/freshness controls.
   */
  ttl?: string | number;
  /**
   * Override the cache freshness window for this query (polling/SSE
   * transports). When the cached entry is younger than `staleTime`, react-query
   * serves it without a network round-trip on remount/refocus. Defaults to the
   * QueryClient's global staleTime (5s). Use higher values (e.g. 30_000) for
   * human-cadence data where a few seconds of staleness is acceptable; use 0
   * for queries that must always refetch on key change.
   *
   * Ignored by legacy WEBSOCKETS compatibility contexts (their materialized
   * views are not part of the supported transport implementation).
   */
  staleTime?: number;
  /**
   * Opt this query OUT of (`false`) the host app's persisted-cache snapshot
   * (`@papercusp/sync`'s `persisted-cache.ts`, WI-3318/WI-6656) by stamping
   * `meta.persist = false` on the underlying react-query entry. Omit to
   * inherit the provider-level default — see `SyncProviderProps.persistExcludeQueryNames`
   * for excluding a query by NAME across every call site instead of
   * per-call. Passing `persist: true` here always overrides a provider-level
   * exclusion for that one call site.
   *
   * A query the host never persists (no `enablePersistedSyncCache()` call)
   * ignores this entirely — it only affects what a persisted-cache snapshot
   * includes, never the live in-memory cache or refetch behavior.
   */
  persist?: boolean;
  /*
   * NOTE — `priority: 'interactive' | 'background'` used to live here (WI-5851)
   * and was REMOVED on 2026-07-26 with the batcher it existed to steer
   * (drop-sync-batcher-2026-07-25 P-005). It bought a click its own batch so it
   * would not inherit a poll wave's latency through an indivisible bundle. With
   * one request per query there is no bundle to be trapped in: every query is
   * already independently dispatched and independently returned, so the lane
   * split is not just unnecessary, it is unrepresentable. Nothing replaces it —
   * do not reintroduce a hand-labelled priority; the label rotted (only queries
   * someone remembered to tag were fast) and that rot is why it is gone.
   */
}

export interface SyncQueryResult<T = any> {
  /** The current data — always an array, never undefined. */
  data: T[];
  /** True only on initial load when no data is available yet. */
  loading: boolean;
  /** True whenever a fetch is in-flight (including background refetches and key changes). */
  fetching: boolean;
  /** Current active transport. */
  transport: SyncType;
  /** Force an immediate refetch (SSE/POLLING) or no-op in legacy WS contexts. */
  invalidate: () => void;
  /** Error from the last fetch attempt, if any. */
  error: Error | null;
  /**
   * How many consecutive fetch attempts have FAILED for the current load
   * (0 while healthy; reset on success).
   *
   * ⚠ This is the only way a consumer can tell "still loading" apart from
   * "loading has been failing and silently retrying". `loading` is TanStack's
   * `isLoading` (= `isPending && isFetching`), which stays TRUE for the whole
   * retry sequence, while `error` stays NULL until every retry is exhausted —
   * so a query whose every attempt times out renders as an ordinary,
   * indistinguishable spinner for the full retry budget. With the default 3
   * retries, exponential backoff (1s/2s/4s) and a 10s server-side timeout, that
   * is ~47 SECONDS of a UI claiming it is simply "loading".
   *
   * That is not hypothetical: it is what made the Learning tab's Retain pane
   * appear to load "forever" (WI-39675). Any pane with a bare `loading` branch
   * should read this and say something honest once it is > 0.
   */
  failureCount: number;
  /**
   * The error from the most recent FAILED attempt, even while retries are still
   * in flight — i.e. populated in exactly the window where `error` is still
   * null. Null while healthy.
   */
  failureReason: Error | null;
}

/** Internal: the hook implementation injected by each transport adapter. */
export type UseDataImpl = <T = any>(opts: SyncQueryOptions) => SyncQueryResult<T>;

/** Eagerly cache a query result so a future useSyncQuery with the same key is instant. */
export type PrefetchSyncFn = (opts: SyncQueryOptions) => void;

/**
 * Legacy Zero `zero.mutate` dispatcher — namespaced custom mutators
 * (`mutate.cart.addItem(args)`). Kept for direct compatibility contexts;
 * `null`/absent on supported polling/SSE providers (writes fall back to REST).
 */
export type MutateImpl = Record<string, Record<string, (args: any) => Promise<unknown>>>;
