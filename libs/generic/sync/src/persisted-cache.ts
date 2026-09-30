/**
 * Persisted sync cache (WI-3318) — app-wide stale-while-revalidate across
 * reloads. Snapshots the sync QueryClient's successful queries to
 * `localStorage` (debounced, size-capped) and hydrates them back BEFORE the
 * first component mounts, so a reload paints every panel from disk instantly
 * while the normal staleTime/SSE-invalidate machinery revalidates in the
 * background.
 *
 * Hand-rolled on react-query's own `dehydrate`/`hydrate` instead of
 * `@tanstack/react-query-persist-client`: the QueryClient here is a lib
 * singleton (SSEAdapter mounts its own `QueryClientProvider` around
 * `getQueryClient()` — there is no app-level provider to wrap in a
 * `PersistQueryClientProvider`), restore must be SYNCHRONOUS to beat the
 * first `useQuery` mount, and no new dependency is needed.
 *
 * Opt-in: nothing here runs unless the HOST APP calls
 * `enablePersistedSyncCache()` at module-eval time (the same
 * before-any-component-mounts slot the desktop IPC polyfills use — see
 * apps/operator RootSyncProvider). Other consumers of @papercusp/sync are
 * untouched.
 *
 * Failure posture: best-effort cache. Every storage/parse failure degrades to
 * "no persisted cache" (bad entries are removed), never to a thrown error on
 * the boot path.
 */
import { dehydrate, hydrate, type QueryClient } from '@tanstack/react-query';
import { getQueryClient } from './transports/polling/queryClient';

/** Minimal storage seam (localStorage-shaped) so tests inject an in-memory one. */
export type SyncCacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface PersistedSyncCacheOptions {
  /** Storage key. Default `papercusp:sync-cache:v1`. */
  key?: string;
  /**
   * Cache-buster: persisted snapshots written under a different buster are
   * dropped on restore. Bump (or pass a build id) when row shapes change
   * incompatibly.
   */
  buster?: string;
  /** Drop snapshots older than this on restore. Default 24h. */
  maxAgeMs?: number;
  /**
   * Skip the write when the serialized snapshot exceeds this many BYTES —
   * localStorage quota is ~5MB and a QuotaExceededError inside the subscriber
   * would otherwise fire on every cache event. Default 4 MiB.
   *
   * WI-6502: this is measured as `serialized.length * 2`, because a JS string
   * is UTF-16 and storage quota is accounted in bytes. Comparing `.length`
   * directly (as this did originally) is off by 2x, which let a 3.31M-char
   * snapshot through a 4MiB guard and straight into a guaranteed
   * QuotaExceededError on every write.
   */
  maxBytes?: number;
  /**
   * Skip persisting any SINGLE query whose serialized data exceeds this many
   * BYTES (UTF-16, i.e. `.length * 2` — same accounting as `maxBytes`).
   * Default 256 KiB, a sixteenth of the default whole-snapshot budget.
   * `Infinity` restores the old persist-everything behaviour.
   *
   * P-029 / D-038. The persisted snapshot is rehydrated SYNCHRONOUSLY before
   * the first component mounts, so every restored entry is a zero-observer
   * cache entry until some panel subscribes — and under the sync client's
   * 1-hour gcTime, whatever the boot route does not render stays resident for
   * an hour. Measured live 2026-08-03 on /adv: 36 of 57 cached keys had zero
   * observers holding 1.46 MB, and THREE entries were 91% of it
   * (`agentRunsConsolidated.bySlug` 1090 KiB, `featuresConsolidated.bySlug`
   * 976 KiB, `learning.improvements` 588 KiB). The stored snapshot itself was
   * 3.03 MB against the 4 MiB `maxBytes` cap — 76% of a cliff past which the
   * write is skipped SILENTLY and persistence stops for every query, not just
   * the oversized one.
   *
   * Large payloads are where stale-while-revalidate pays least and costs most:
   * `staleTime` is 5s, so they are re-fetched almost immediately anyway, while
   * they dominate both the quota and the rehydration cost. Capping per-entry
   * (rather than naming queries) means the next large query is covered without
   * anyone remembering to opt it out with `meta.persist: false`.
   */
  maxEntryBytes?: number;
  /** Debounce between cache-event and write. Default 1000ms. */
  debounceMs?: number;
  /** Default `window.localStorage`. */
  storage?: SyncCacheStorage;
  /** Default: the sync transports' singleton (`getQueryClient()`). */
  client?: QueryClient;
}

interface Envelope {
  v: number;
  buster: string;
  ts: number;
  state: ReturnType<typeof dehydrate>;
}

const ENVELOPE_VERSION = 1;
const DEFAULT_KEY = 'papercusp:sync-cache:v1';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** P-029 / D-038 — see `maxEntryBytes`. A sixteenth of DEFAULT_MAX_BYTES. */
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024;
const DEFAULT_DEBOUNCE_MS = 1000;
/**
 * WI-6502: after this many consecutive failed/over-budget writes, stop trying.
 * A snapshot that does not fit does not start fitting on the next cache event,
 * and retrying it every second is how this burned ~36ms of main thread per
 * second while persisting nothing at all.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

function resolveStorage(opts?: PersistedSyncCacheOptions): SyncCacheStorage | null {
  if (opts?.storage) return opts.storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Sandboxed frame / storage-disabled webview: localStorage GETTER throws.
  }
  return null;
}

/**
 * Hydrate the persisted snapshot into the client. Synchronous — call before
 * the first `useQuery` mounts. Returns true when a snapshot was applied.
 */
export function restorePersistedSyncCache(opts: PersistedSyncCacheOptions = {}): boolean {
  const storage = resolveStorage(opts);
  if (!storage) return false;
  const key = opts.key ?? DEFAULT_KEY;
  try {
    const raw = storage.getItem(key);
    if (!raw) return false;
    const env = JSON.parse(raw) as Envelope;
    const fresh =
      env &&
      env.v === ENVELOPE_VERSION &&
      env.buster === (opts.buster ?? '') &&
      typeof env.ts === 'number' &&
      Date.now() - env.ts <= (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS) &&
      env.state != null;
    if (!fresh) {
      storage.removeItem(key);
      return false;
    }
    hydrate(opts.client ?? getQueryClient(), env.state);
    return true;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* storage gone mid-flight — nothing to clean */
    }
    return false;
  }
}

/**
 * Content-identity key for a dehydrated snapshot: everything that changes what
 * a RESTORE would produce, and nothing that does not.
 *
 * WI-10002023. `dehydrateQuery` spreads the WHOLE `QueryState` into the
 * snapshot, and most of that state is fetch BOOKKEEPING that react-query
 * re-stamps on every successful fetch even when the rows are byte-identical:
 * `dataUpdatedAt`, `dataUpdateCount`, `fetchStatus`, `isInvalidated`, plus the
 * error/failure counters. Comparing the raw dehydrated state therefore reports
 * "changed" for every REFETCH, so an app that merely revalidates on its 5s
 * staleTime rewrote the entire snapshot every few seconds forever. Measured in
 * the wild: an 11.4 GB `.localstorage-wal` growing ~374 MB/h behind a 4.3 MB
 * database — and unreclaimable while the app holds the file open, because a
 * TRUNCATE checkpoint cannot complete against a live read lock.
 *
 * The WI-5983 dedup did not catch it: that guard only ever saw cache events
 * which left every query's state untouched, so the cheap `signature()` gate
 * short-circuited before the content comparison was reached at all.
 *
 * This is an ALLOW-LIST deliberately. Enumerating the volatile fields instead
 * would silently reintroduce the leak the next time react-query adds one.
 * Queries are sorted by hash so cache eviction/re-admission reordering is not
 * mistaken for a content change either.
 */
export function syncCacheContentKey(
  state: ReturnType<typeof dehydrate>,
  buster: string,
): string {
  const queries = (state.queries ?? [])
    .map((q) => {
      const s = q.state as { data?: unknown; status?: unknown; error?: unknown };
      // Allow-list: queryKey/hash identify the entry, meta rides along on
      // restore, and status/error/data are the only state a restore reads.
      return {
        hash: q.queryHash,
        key: q.queryKey,
        meta: q.meta,
        status: s.status,
        error: s.error,
        data: s.data,
      };
    })
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return JSON.stringify({
    v: ENVELOPE_VERSION,
    buster,
    queries,
    mutations: state.mutations,
  });
}

/**
 * Subscribe to the query cache and write a debounced snapshot on change
 * (plus a final synchronous flush on pagehide). Returns a dispose fn.
 * Persists only SUCCESSFUL queries, and skips any query whose
 * `meta.persist === false`.
 */
export function startSyncCachePersistence(opts: PersistedSyncCacheOptions = {}): () => void {
  const storage = resolveStorage(opts);
  if (!storage) return () => {};
  const key = opts.key ?? DEFAULT_KEY;
  const client = opts.client ?? getQueryClient();
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;

  // WI-5983: dedup against the last WRITTEN payload (content only — the `ts`
  // field is excluded from the comparison so a no-op tick doesn't count as a
  // change). The query cache fires `subscribe` on every state transition —
  // including retry/error churn from queries that never reach `success` (e.g.
  // no backend reachable at all) — so with no backend the debounce above
  // still re-fires every `debounceMs` FOREVER even though the dehydrated
  // snapshot (no successful queries) never changes. Observed in the wild as a
  // sustained ~1 write/sec localStorage-WAL leak with no human interaction
  // (WI-5983: ~3GB/day, unbounded, on a clean-room VM with no reachable
  // backend). Skipping the identical write breaks that loop without touching
  // the debounce/backoff semantics for the normal (data-changing) case.
  let lastWrittenContent: string | null = null;
  // WI-10002023: when the last write physically landed, so an unchanging
  // snapshot can still be refreshed before `maxAgeMs` ages it out on restore.
  let lastWrittenAt = 0;
  const refreshAfterMs = (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS) / 2;

  // WI-6502 (owner-reported typing lag). The dedup above is O(BYTES): it has to
  // dehydrate the whole cache and run a replacer-stringify over it just to
  // DECIDE whether anything changed, and it paid that on every cache event
  // (debounced 1s) forever. Measured in a live desktop instance: a 3236KB cache
  // cost 15-24ms for the replacer pass plus 9-20ms for the second stringify, so
  // ~36ms median (max 49ms) of main-thread block roughly once per second.
  // Keystrokes do not cause that block, they QUEUE BEHIND it — Event Timing put
  // input delay at 36-247ms against 3-5ms of actual handler processing.
  //
  // Most cache events change no persistable DATA at all (invalidate/stale
  // transitions, isFetching toggles, observer add/remove), so gate the whole
  // flush on an O(#queries) signature first: react-query stamps
  // `dataUpdatedAt` on every data write, which is exactly the question the
  // expensive comparison was answering. The content dedup stays as the
  // second-line check for the case where a refetch really did land.
  let lastSignature: string | null = null;

  // P-029 / D-038: per-entry size verdicts, memoized on (queryHash,
  // dataUpdatedAt) so the measuring stringify runs only when a query's DATA
  // actually changed — not on every cache event. This memo is why the size cap
  // does not reintroduce the per-event O(BYTES) main-thread cost WI-6502 removed.
  //
  // The verdict map is rebuilt HERE (this already walks every query on each
  // flush) and READ by `shouldDehydrateQuery` below. Both MUST apply the same
  // predicate: if the signature counted an entry that dehydrate then skipped,
  // every refetch of an excluded query would change the signature and force a
  // full dehydrate+stringify that persists nothing — i.e. exactly the wasted
  // flush this memo exists to prevent, on the largest queries in the cache.
  let sizeVerdicts = new Map<string, boolean>();
  const verdictKey = (hash: string, updatedAt: number): string => hash + '@' + updatedAt;

  const signature = (): string => {
    const parts: string[] = [];
    const next = new Map<string, boolean>();
    for (const q of client.getQueryCache().getAll()) {
      if (q.state.status !== 'success' || q.meta?.persist === false) continue;
      const vk = verdictKey(q.queryHash, q.state.dataUpdatedAt);
      let fits = sizeVerdicts.get(vk);
      if (fits === undefined) {
        try {
          fits = JSON.stringify(q.state.data).length * 2 <= maxEntryBytes;
        } catch {
          // Unserializable data can never be persisted — dehydrate would throw
          // and take the whole snapshot down with it.
          fits = false;
        }
      }
      next.set(vk, fits);
      if (!fits) continue;
      parts.push(q.queryHash, String(q.state.dataUpdatedAt));
    }
    // Replacing (not mutating) bounds the memo to queries still in the cache —
    // evicted/gc'd entries drop out instead of accumulating forever.
    sizeVerdicts = next;
    return parts.join('\u001f');
  };

  // WI-6502: the write failing must not mean "retry the whole serialize on the
  // very next cache event, forever". The catch below used to reset
  // `lastWrittenContent` to null, which DEFEATED the WI-5983 dedup outright:
  // once a write started failing, every subsequent event paid the full cost and
  // no write ever succeeded. Observed in the wild — `papercusp:sync-cache:v1`
  // was ABSENT from localStorage on a live instance while the flush ran every
  // second, i.e. the feature was burning main-thread time and persisting
  // nothing. Give up after a few consecutive failures and say why.
  let consecutiveFailures = 0;
  let disabledReason: string | null = null;
  const noteFailure = (reason: string) => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) disabledReason = reason;
  };

  const flush = () => {
    if (disabledReason) return;
    const sig = signature();
    if (sig === lastSignature) return; // nothing persistable changed — skip before serializing
    lastSignature = sig;
    try {
      const state = dehydrate(client, {
        shouldDehydrateQuery: (q) =>
          q.state.status === 'success' &&
          q.meta?.persist !== false &&
          // P-029 / D-038. Reads the verdict `signature()` just computed for this
          // exact (queryHash, dataUpdatedAt); a missing verdict means the entry
          // appeared between the two walks, so persist it as before.
          sizeVerdicts.get(verdictKey(q.queryHash, q.state.dataUpdatedAt)) !== false,
      });
      // Stable comparison key: same shape as the envelope minus `ts` AND minus
      // each query's `dehydratedAt` (react-query stamps `dehydratedAt:
      // Date.now()` into EVERY dehydrated query on EVERY dehydrate() call —
      // call-time noise unrelated to whether the underlying data changed —
      // so leaving it in the comparison would make every flush look "new"
      // and defeat the dedup entirely).
      const content = syncCacheContentKey(state, opts.buster ?? '');
      // WI-10002023: identical CONTENT still gets a periodic rewrite, because
      // the envelope's `ts` is what `restorePersistedSyncCache` ages out
      // against `maxAgeMs`. Without this, a dataset that is merely revalidated
      // (never changed) would stop being rewritten, let its stored `ts` pass
      // maxAgeMs, and lose stale-while-revalidate on the next boot. Refreshing
      // at half the max age keeps the snapshot restorable forever at ~2 writes
      // a day, against the ~8,600 a day the un-deduped path was doing.
      if (content === lastWrittenContent && Date.now() - lastWrittenAt < refreshAfterMs) {
        return; // nothing persistable changed and the snapshot is still young
      }
      const serialized = JSON.stringify({
        v: ENVELOPE_VERSION,
        buster: opts.buster ?? '',
        ts: Date.now(),
        state,
      } satisfies Envelope);
      // WI-6502: `serialized.length` counts UTF-16 CODE UNITS, and storage
      // quota is accounted in BYTES — so the old `length > maxBytes` test was
      // off by 2x and waved through payloads that could never fit. A 3236KB
      // (3.31M char) snapshot passed the 4MiB guard and then threw
      // QuotaExceededError on every single write.
      if (serialized.length * 2 > maxBytes) {
        noteFailure('oversize');
        return; // over budget — keep the last good snapshot
      }
      storage.setItem(key, serialized);
      lastWrittenContent = content;
      lastWrittenAt = Date.now();
      consecutiveFailures = 0;
    } catch {
      // Quota / serialization failure: drop the stored snapshot so restore
      // never resurrects a half-written or perpetually-oversized entry.
      lastWrittenContent = null;
      noteFailure('write-failed');
      try {
        storage.removeItem(key);
      } catch {
        /* storage gone — nothing to clean */
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const scheduleFlush = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, debounceMs);
  };

  const unsubscribe = client.getQueryCache().subscribe(scheduleFlush);
  // Debounce leaves up to debounceMs of tail loss on navigation/close —
  // pagehide (the reliable unload signal, fires on tab close AND bfcache
  // entry) gets a final synchronous write.
  const onPageHide = () => flush();
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

  return () => {
    unsubscribe();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
  };
}

let activeDispose: (() => void) | null = null;

/**
 * Restore + start persistence in one call (idempotent — a second call is a
 * no-op returning the active dispose). The host app calls this once at
 * module-eval time, before any component mounts.
 */
export function enablePersistedSyncCache(opts: PersistedSyncCacheOptions = {}): () => void {
  if (activeDispose) return activeDispose;
  restorePersistedSyncCache(opts);
  const stop = startSyncCachePersistence(opts);
  activeDispose = () => {
    stop();
    activeDispose = null;
  };
  return activeDispose;
}
