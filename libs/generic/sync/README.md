# @papercusp/sync

Schema-agnostic client sync over SSE with a polling fallback, reconnect, and
backpressure handling. A `SyncProvider` picks the active transport and exposes
the live query handle to the app.

- **SSE transport** (`transports/sse`) — the primary push path:
  consumes a server endpoint that pushes invalidate/update over PG
  `LISTEN/NOTIFY`, with resilient reconnect (via `@papercusp/sse`).
- **Polling transport** (`transports/polling`) — the degraded fallback when
  SSE cannot stay connected, sharing the same query fetcher and cache.

`syncType="WEBSOCKETS"` remains accepted as a source-compatibility input for
older callers, but `SyncProvider` normalizes it to SSE. The Zero WebSocket
client and adapter are no longer supported or mounted.

## Schema-agnostic by injection

The lib never imports a concrete application schema. Consumers identify reads
with `queryName` + `args`, so `@papercusp/sync` stays domain-free. Legacy
`schema` and `queries` provider props remain typed for source compatibility but
are reserved and ignored by the supported transports.

## Status

Submodule under `github.com/Papercusp/`. The SSE-primary decision and the
legacy WebSocket-to-SSE compatibility normalization live in the consuming
provider (for the operator: `apps/operator/providers/HarnessSyncProvider.tsx`).
