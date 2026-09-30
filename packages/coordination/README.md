# @papercusp/coordination

Agent-coordination substrate, extracted from
`apps/operator/lib/agent-tools/coordination/` as host-agnostic pieces
(papercusp-systems-abstraction D-009 / P-011). No operator / domain runtime
deps — the only injected couplings are a PG handle and a `coordDir` resolver.

## The pieces

| Import | What it is | Storage backends |
|---|---|---|
| `@papercusp/coordination/core` | Pure protocol layer — envelope types + `newMsgId`, glob matcher (`patternToRegex`), watermark merge, and the fold/filter logic (thread, inbox, handoffs, escalations, plan-events, promote validation). | none (pure) |
| `@papercusp/coordination/event-log` | `CoordEventLog` — the swappable append-only channel-log seam. Covers messages, handoffs, escalations, plan-events. | `FsCoordLog` (portable default) / `InMemoryCoordLog` (double) / `PgCoordLog` (single `harness_shared.coord_event_log` table) |
| `@papercusp/coordination/presence` | `PresenceStore` — live agent presence (mutable single-row-per-owner). | `PgPresenceStore` (injected PgHandle) / `InMemoryPresenceStore` |
| `@papercusp/coordination/subscription-store` | `SubscriptionStore` — watch/notify subscriptions. | `PgSubscriptionStore` / `InMemorySubscriptionStore` |
| `@papercusp/coordination/watermark-store` | `WatermarkStore` — per-agent read-cursor docs (mutable per-owner). | `PgWatermarkStore` / `InMemoryWatermarkStore` |

`CoordEventLog` and the mutable stores (`PresenceStore` / `WatermarkStore` /
`SubscriptionStore`) are deliberately separate interfaces (D-009): an
append-only event log and a mutable single-row-per-owner table are different
data models, not one logic over two engines.

> **Product path:** the operator wires the **PG backends exclusively** —
> `PgCoordLog` + the Pg presence/watermark/subscription stores
> (`coord-channels-pg-port-2026-05-30`). `FsCoordLog` (homed in
> `@papercusp/pubsub-substrate`, re-exported here) remains the *generic*
> portable backend for detached/portability use — it is not the operator
> runtime path.

## What stays host-side (by design — NOT in this package)

- **Identity resolution** (`resolveAgentIdentity` from a host ctx) — host/ctx
  glue. The pure core receives resolved owner-id strings.
- **`defineTool` verb wrappers**, role gating, and `coord/` repo-root
  resolution. The operator's channel modules (`messages.ts`, `handoffs.ts`,
  …) are thin adapters that pick a backend and delegate to these seams.

## Seam injection

`FsCoordLog` takes a `coordDir: () => string` resolver (the host owns
repo-root / env policy). The PG stores (`PgCoordLog`, `PgPresenceStore`,
`PgWatermarkStore`, `PgSubscriptionStore`) take `getSql: () => Sql` +
`ensureSchema: () => Promise<void>`. Every `*InMemory*` double passes the same
conformance suite as the production impl — the swappability (P-050) gate.
`PgCoordLog` is exercised against the same event-log conformance suite as the
fs/in-memory backends in the operator's live-PG run.

Tests: `npm test` (vitest) — the package pins the in-memory + fs doubles; the
PG impls are run against the shared conformance suites with a live
`harness_shared` schema in the operator.

## Detached-mode proof (P-051)

The detached-mode example lives with the generic substrate it proves:
`libs/generic/pubsub-substrate/examples/detached-mode.ts` stands the
event-log substrate up with **zero operator and zero Postgres** — it
imports only `core` + `event-log` and runs the full L3 loop
(messages/inbox, thread fold, handoff accept, append-only escalation
resolve, plan-events) over an OS temp dir, proving the portability claim
(D-004): a detached agent participates purely over the filesystem. Run it:

```
npx tsx libs/generic/pubsub-substrate/examples/detached-mode.ts   # exits 0 on PASS
```

This proves *genericity*, not a product configuration — the detached FS
event-log path is no longer the operator's product path (see the product-path
note above; `coord-channels-pg-port-2026-05-30`).
