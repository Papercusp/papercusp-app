# Testing — @papercusp/pubsub-substrate

Run: `npm test` (from this dir) — Vitest, node environment.

## What's covered

- **`src/core/*.test.ts`** — the pure protocol layer: envelope ordering/ids,
  inbox filtering, thread/handoff/escalation folds, watermark merge, glob.
- **`src/event-log/event-log.test.ts`** — runs the shared `CoordEventLog`
  conformance suite (`conformance.ts`) against the two host-free backends
  (`InMemoryCoordLog` + `FsCoordLog`), plus the fs-specific plan-events month
  rotation + `filesBack` hint. A passing in-memory impl against the SAME suite
  is the swappability proof.
- **`src/presence/presence.test.ts`** — the `PresenceStore` conformance suite
  against `InMemoryPresenceStore`.
- **`src/watermark-store/watermark-store.test.ts`** — the `WatermarkStore`
  conformance suite against `InMemoryWatermarkStore`.

## What's NOT covered here (by design)

- **The Postgres backends** (`PgCoordLog`, `PgPresenceStore`, `PgWatermarkStore`,
  the Pg capability stores) — they're the host tie-in adapter in
  `@papercusp/coordination`, and they run the SAME `*/conformance` suites
  exported from this package against a live `harness_shared` schema in the
  operator's integration tests (`packages/operator-core/lib/agent-tools/coordination/__tests__/*-conformance.test.ts`).
- **The `capabilities` slice** depends on `@papercusp/linkable-edges`; its
  conformance suite lives behind `./capabilities/conformance`.

## After editing

The conformance suites are the contract every backend (here AND the host's PG
backends) is held to — if you change a suite, re-run the operator's live-PG
conformance tests too, or you'll silently weaken the PG contract.
