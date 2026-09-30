# Testing — @papercusp/structured-concurrency

**Run:** `npx vitest run` (from this directory). Pure + in-memory; no Docker, no DB.

## What's covered

The suite runs every mechanism against the in-memory reference store (`src/mem-store.ts`),
which *is* the genericity proof — the same algorithms the papercusp PG adapter drives, here
over a domain-free substrate.

| File | Covers |
|---|---|
| `lock-order.test.ts` | total-order sort, unknown-class ranking, purity/stability |
| `dining-philosophers.test.ts` | the classic deadlock removed by `orderLocks` (concurrent, bounded so a deadlock fails the test rather than hangs) |
| `governor.test.ts` | `refilledTokens` math, bucket exhaustion + bulkheads, all-or-nothing admission, circuit open/cooldown/half-open |
| `producer-consumer.test.ts` | the classic bounded-buffer backpressure (credits) + rate bounding (token bucket) |
| `nursery.test.ts` | transitive cancel, terminal-node skipping, lock-release/notify effect fan-out, idempotency, the completion gate |
| `supervision.test.ts` | `decideIntensity` windowing, `computeRestartSet` strategies, store-backed intensity counting, restart-vs-escalate decision |
| `saga.test.ts` | forward completion, reverse compensation, `compensate_failed` handling, tombstone soft-delete / deferred GC / restore |

## What's NOT covered here

- **Durable-store wiring** (real Postgres, FOR-UPDATE under concurrency, claim releases) —
  that's the host adapter's job. Papercusp's PG binding + its integration tests live in
  `packages/operator-core/lib/fleet/*.integration.test.ts`.
- The host-specific effects (lock release, coord notify, escalate) are injected as spies
  here; their real implementations are tested in the adapter.

## After editing

Run `npx vitest run` here, then — if you touched the seam (ports) — the papercusp adapter's
fleet integration suite: `cd ../../../packages/operator-core && npx vitest run --config
vitest.integration.config.ts lib/fleet` (needs Docker).
