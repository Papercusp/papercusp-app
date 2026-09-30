# Cache-ECA rides the SSE LISTEN — a host process with no SSE subscriber served unboundedly-stale cachedRead snapshots (WI-1547)
URL: /internal/docs/agent-insights/cache-eca-rides-the-sse-listen

plans:get returned ~45-min-stale item statuses intermittently on :3070. Root cause: the cache.bumpTags invalidation rides the sync_invalidate PG LISTEN, which started lazily on the FIRST SSE SUBSCRIBE — 15 of 16 reuseport cluster workers never subscribed, so their L1 never invalidated and SWR served arbitrarily old entries. Fix: ensureInvalidationListener() at boot in every worker + a default hard TTL on cachedRead.

## Symptom

`plans:get` (and potentially ANY `cachedRead` consumer) intermittently returned a
**\~45-minute-old snapshot** (item statuses from a long-gone state), then the very
next call returned current data. Same client, same API base (`:3070`), minutes
apart. Tracked as **WI-1547** ("read-consistency flap").

## Root cause (two compounding facts)

1. **The cache-ECA invalidation rides the SSE invalidation bus's single PG
   LISTEN.** `operator-core/lib/sync-sse.ts` creates ONE `sync_invalidate`
   LISTEN per process; its `bridge` taps every `<schema>.<table>.changed`
   trigger event into the reaction matcher → `cache.bumpTags`. That LISTEN
   started **lazily on the first SSE subscribe** (`bus.subscribe`). A process
   that never receives an SSE subscriber never LISTENs — so **its cache layer is
   built but INERT**: no write ever invalidates an entry there.

2. **`:3070` is a 16-worker SO\_REUSEPORT cluster** (hono-host P3-2): the kernel
   load-balances connections across 16 node processes, each with its OWN
   in-process L1 (`getOperatorCache()` is per-process). Only the worker(s) that
   happened to receive an SSE client ever started the LISTEN — `pg_stat_activity`
   showed exactly **one** `listen "sync_invalidate"` backend for the whole
   cluster. The other 15 workers' L1s never saw a `bumpTags`.

With invalidation inert, `cachedRead`'s SWR (`softTtlMs`) **serves a stale entry
of ANY age** once per idle period and revalidates in the background — that's the
flap: whichever blind worker your connection landed on served its last snapshot
(45 minutes old if that's when it last read), then self-refreshed.

## Diagnosis shortcut (next time)

```sql
-- how many processes actually receive invalidations?
SELECT pid, backend_start FROM pg_stat_activity WHERE query ILIKE '%listen%sync_invalidate%';
-- vs how many serve the port:
--   ss -ltnp | grep :3070   (one pid per reuseport worker)
```

If LISTEN-count \< worker-count, those workers' caches are invalidation-blind.

## Fix (landed 2026-07-02)

1. **Eager start** — `ensureInvalidationListener()` (exported from
   `operator-core/lib/sync-sse.ts`, bounded-retry, fail-soft) is called in
   `apps/operator/bin/hono-host.ts` `startRequestServers()`, which runs in
   **every** cluster worker and in single-process mode. Every operator host
   process now LISTENs from boot; the existing `onListen` cold-bust (`clearL1`)
   covers reconnect gaps.
2. **Bounded staleness backstop** — `cachedRead` now applies a **default
   `hardTtlMs` of 10 min** (`DEFAULT_CACHED_READ_HARD_TTL_MS`, env
   `PAPERCUSP_CACHED_READ_HARD_TTL_MS`, `0` disables) when the caller passes
   none: past it the read rebuilds BLOCKING, so even a future rail outage can
   never serve a 45-minute-old snapshot again. Explicit caller values win.

Recurrence guards: `lib/cache/cached-read.test.ts` ("WI-1547 — default hard TTL
bounds worst-case staleness", 4 tests).

## Generalizable lessons

* **A lazily-started side-channel that correctness depends on is a trap**: the
  ECA was correctness-critical but piggybacked on a rail whose start was an
  optimization for a *different* consumer (SSE). If a subsystem is load-bearing,
  start it explicitly at boot.
* **Reuseport clusters multiply per-process assumptions.** "The process has X
  wired" must hold for EVERY worker; verify with `pg_stat_activity` /
  `ss -ltnp`, not by observing one process.
* **SWR without a hard TTL = unbounded staleness under any invalidation gap.**
  Always pair serve-stale-while-revalidate with a hard bound.
