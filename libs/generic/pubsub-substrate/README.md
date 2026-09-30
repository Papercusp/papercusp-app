# @papercusp/pubsub-substrate

A **host-agnostic agent-coordination / pub-sub substrate** — the generic core
extracted from `@papercusp/coordination` (generalize-libs-to-generic D-003 #6).
Zero domain coupling, **zero `postgres` dependency**: every storage backend here
is either pure-logic, in-memory, or portable filesystem; the Postgres backends
are the host tie-in and live in the adapter package `@papercusp/coordination`.

## The pieces

| Import | What it is | Backends |
|---|---|---|
| `@papercusp/pubsub-substrate/core` | Pure protocol layer — envelope types + `newMsgId`, glob matcher (`patternToRegex`), watermark merge, and the fold/filter logic (thread, inbox, handoffs, escalations, plan-events, promote validation). | none (pure) |
| `@papercusp/pubsub-substrate/event-log` | `CoordEventLog` — the swappable append-only channel-log seam (the outbox/CDC). Covers messages, handoffs, escalations, plan-events. | `FsCoordLog` (portable default) / `InMemoryCoordLog` (double) |
| `@papercusp/pubsub-substrate/presence` | `PresenceStore` — live agent presence (mutable single-row-per-owner). | `InMemoryPresenceStore` |
| `@papercusp/pubsub-substrate/watermark-store` | `WatermarkStore` — per-agent read-cursor docs (mutable per-owner). | `InMemoryWatermarkStore` |
| `@papercusp/pubsub-substrate/capabilities` | Subscribable / Threadable / Topics + the `resolveObjectSubscribers` fan-out. Depends on `@papercusp/linkable-edges` for the typed-entity graph (`ObjectRef`, `TaggableStore`). | in-memory doubles |

`CoordEventLog` and the mutable stores (`PresenceStore` / `WatermarkStore`) are
deliberately separate interfaces: an append-only event log and a mutable
single-row-per-owner table are different data models, not one logic over two
engines.

## The seam (how a host plugs Postgres in)

`FsCoordLog` takes a `coordDir: () => string` resolver (the host owns repo-root
/ env policy). The Postgres backends (`PgCoordLog`, `PgPresenceStore`,
`PgWatermarkStore`, the Pg capability stores) live in `@papercusp/coordination`
and take `getSql: () => Sql` + `ensureSchema: () => Promise<void>` — the host
owns the connection + schema. **Every in-memory / fs double passes the SAME
conformance suite as the production PG impl** (the swappability gate): the
conformance suites ship here behind the `*/conformance` subpaths and are run
against the PG backends in the operator's live-PG integration tests.

## Detached-mode proof

`examples/detached-mode.ts` stands the substrate up with **zero operator and
zero Postgres** — it imports only `core` + `event-log` and runs the full L3 loop
(messages/inbox, thread fold, handoff accept, append-only escalation resolve,
plan-events) over an OS temp dir, proving the portability claim: a detached
agent participates purely over the filesystem. Run it:

```
npx tsx libs/generic/pubsub-substrate/examples/detached-mode.ts   # exits 0 on PASS
```

## Tests

`npm test` (vitest) runs the algorithm + conformance suites against the
in-memory + fs doubles. The PG backends are exercised against the same
conformance suites in the host adapter's live-PG integration tests.
