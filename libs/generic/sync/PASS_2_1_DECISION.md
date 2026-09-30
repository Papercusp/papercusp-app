# Pass 2.1 — Path A vs Path B decision

> **⚠️ SUPERSEDED 2026-05-07.** This document is preserved for archival. The
> "stop investing in SSE" decision below was reversed one day later when the
> desktop deployment model crystallized:
>
> - **Desktop (Tauri) is the shipping product.** Webapp is for testing only.
> - **SSE is the production push transport on desktop.** PG LISTEN/NOTIFY →
>   `apps/operator/app/api/zero-harness/sse/route.ts` → `SSEAdapter`.
> - Zero WS remains primary on the browser test path; SSE acts as fallback there.
>
> Source of truth: `apps/operator/providers/HarnessSyncProvider.tsx`. Also
> see `/CLAUDE.md` § "Deployment model".
>
> The investigation and reasoning below were correct given the information at
> the time (2026-05-06) — desktop ships embedded-pg, web ships zero-cache,
> SSE-as-Zero-fallback had no consumer. What changed: the desktop SSE *server*
> got built (the route now exists and is load-bearing), and the SSEAdapter
> resilience knobs (jitter, zombie watchdog) became production-critical
> infrastructure rather than aspirational code.

---

**Date:** 2026-05-06
**Question:** Should we keep optimizing the SSE transport (Path A), or commit
to Zero WS as the only push transport and let SSE rot as a thin fallback (Path B)?

**Decision:** **Path B — and most of it is already done.** Stop investing in SSE.

## The investigation

### What I expected to find
The plan as drafted assumed SSE was the active fallback for "desktop pglite mode
with no logical replication." Path B would have meant building a Zero adapter
against pglite via a custom-change-source HTTP shim — multi-week effort.

### What I actually found

| Component | Reality |
|---|---|
| Desktop persistence | `libs/papercusp/packages/embedded-postgres-server/` boots a **real PG 17 binary** via `embedded-postgres`, configured with `wal_level=logical max_wal_senders=10`. NOT pglite. |
| Desktop sync transport | `libs/papercusp/packages/zero-cache-server/` spawns Zero's zero-cache as a subprocess against embedded-pg via PG logical replication. Browser clients hit `ws://127.0.0.1:<port>`. |
| Web sync transport | Production `zero-cache` service (docker-compose.papercup.prod.yml) — same protocol. |
| pglite | Exists as a code path (`PAPERCUSP_USE_PGLITE` env var, `PAPERCUSP_PGLITE_SOCKET_DIR` socket override) but no current ship uses it. |
| SSE server | **Does not exist.** No `apps/operator/app/api/zero-harness/sse/route.ts`. No event emitter. The SSE adapter (`libs/sync/src/transports/sse/SSEAdapter.tsx`) is client-only. |
| SSE consumers | Zero. No callsite in the operator or shop sets `syncType="SSE"`. |

### Stale comment that misled the original plan
`apps/operator/app/api/zero-harness/rest-query/route.ts` lines 3-7:
> "the desktop bundle, where pglite-server stands in for a real Postgres but
> doesn't expose logical replication, so zero-cache can't subscribe."

This was true at some prior point but is no longer accurate. The desktop ships
embedded-pg, Zero WS works there. The rest-query endpoint exists for `POLLING`
mode fallback, which kicks in when the runtime-config fetch fails or returns
no `zeroServer` URL — a degraded-mode scenario, not a primary path.

## Implications

Path A (optimize SSE as fallback) was investing in a transport with:
- No server endpoint
- No client consumers
- No fallback mode that exercises it
- A defensive role that's already covered by the polling adapter (which DOES
  have a server endpoint and IS exercised in degraded runtime-config scenarios)

The "fallback" SSE was supposedly defending is **already implemented as
polling**. SSE was a planned upgrade to "polling + push invalidates" that never
shipped a server side.

## Action

| Pass | Original plan | Revised |
|---|---|---|
| 1.1 — react-query knobs | Ship | **Shipped** (commit `3b75588`). Worth it — benefits polling fallback. |
| 1.2 — observability | Ship | **Shipped** (commit `071a6c2`). Worth it — `__sync_metrics__` works for any transport. |
| 1.3 — SSE resilience (client) | Ship | **Shipped** (commit `40a5479`). Cheap, harmless, and tests well even with no server. |
| 1.4 — SSE adapter tests | Ship before 2.x | **Drop**. Pinning behavior on dead-code adapter is busywork. |
| 1.5 — burst batching | Ship | **Drop**. No server to batch in. |
| 2.1 — path decision spike | Half-day | **Done — this document.** |
| 2.2 — payload-on-invalidate | 3-4 days | **Drop**. Reinventing Zero WS over SSE is the architectural smell the reviewer flagged; with no consumer, doubly pointless. |
| 2.3 — Last-Event-ID resume | 3-4 days | **Drop**. Zero handles its own resync. |
| 2.4 — selectors via `select` | Real but deferred | **Keep deferred.** Useful for polling fallback callsites; not urgent. |

**Net cumulative work avoided: ~2-3 weeks** (passes 1.4, 1.5, 2.2, 2.3, building
out the SSE server, schema-versioning plumbing, event ring buffer, etc.)

## Cleanup

A small follow-up commit should:
1. Update the stale comment in `rest-query/route.ts` to reflect that
   embedded-pg + Zero WS is the primary desktop sync, polling is the
   degraded-mode fallback, and SSE is reserved for future use.
2. Mark `SSEAdapter.tsx` as "no current consumer; preserved for future use" in
   its module doc, so future-self doesn't assume it's load-bearing.
3. Memory entry capturing this finding.

## What about the polling path?

Polling is the real fallback. The work that already shipped (passes 1.1-1.3)
mostly accrues to it:
- `notifyOnChangeProps` reduces render fanout on background polls.
- `staleTime` per-query lets human-cadence panels (status pills, count cards)
  stop refetching every 5s on tab focus.
- Metrics shim measures cache hit/miss for polling consumers too.

Resilience knobs in Pass 1.3 only matter when SSE actually runs, so they sit
inert in the codebase for now — but they're 50 lines of well-documented code,
not architectural debt.

## Future work (if circumstances change)

If a real corporate-proxy WS-blocking deploy ever materializes, or if a true
pglite-only desktop mode is shipped without embedded-pg, revisit:
- Build the SSE server endpoint (`apps/operator/app/api/zero-harness/sse/route.ts`).
- Wire payload-on-invalidate (extends `update` event type per the protocol I
  documented in SSEAdapter.tsx).
- Land the burst-batching server-side debounce.

Until then: SSE adapter is preserved-but-frozen.
