# @papercusp/structured-concurrency

A generic distributed-systems concurrency toolkit. One durable **spawn tree**, four
mechanisms, all over injected **store ports** — zero domain coupling, zero runtime deps.

| Mechanism | What it gives you |
|---|---|
| **nursery** | structured concurrency — transitive `cancelSubtree` (cancel a node ⇒ cancel + release every descendant's resources *now*, not after N leases expire) + a completion gate (a nursery can't finish while a child lives). |
| **supervision** | an OTP supervision tree — `one_for_one` / `one_for_all` / `rest_for_one` restart strategies + a restart-**intensity** governor (> MaxR in MaxT ⇒ tear the subtree down + escalate, instead of crash-looping forever). |
| **governor** | layered backpressure — a token bucket (+ per-scope **bulkhead**), a circuit breaker, and credits, composed into one **all-or-nothing** `admitSpawn` gate. |
| **saga** | sagas (forward execute → reverse compensate) + tombstones (soft-delete is logically reversible; only the deferred physical GC is final) — destructive cross-machine ops made compensable. |
| **lock-order** | a total lock-class order (`orderLocks`) — acquire multiple locks in canonical order ⇒ no circular wait ⇒ no deadlock (the dining-philosophers fix). |

## The seam

The algorithms are pure. The host injects:

- a **`SpawnTreeStore`** — the durable parent→child tree + its atomic compound ops
  (`cancelActiveSubtree`, row-locked `recordRestartIntensity`).
- a **`GovernorStore`** — the backpressure rows + a `transaction(fn)` unit-of-work
  (FOR-UPDATE read + write); the toolkit holds the refill / admission math.
- a **`SagaJournal`** + **`TombstoneStore`** — durable saga bookkeeping + tombstones.
- effects: a **`LockReleaser`**, a **`CancelNotifier`**, an **`EscalateFn`**.

A reference **in-memory** implementation of every port ships at `./mem-store` (it serialises
its `transaction` with a mutex, reproducing FOR-UPDATE semantics) — it is both the substrate
the conformance suite runs against and a ready default for a single-process fleet.

## Usage

```ts
import {
  createNursery, createSupervisor, createGovernor, createTombstones, runSaga, createLockOrdering,
} from '@papercusp/structured-concurrency';
import { createInMemorySpawnTreeStore, createInMemoryGovernorStore } from '@papercusp/structured-concurrency/mem-store';

const nursery = createNursery({ store: createInMemorySpawnTreeStore(), lockReleaser, notifier });
await nursery.cancelSubtree({ workspaceId, rootSpawnId, reason: 'abort' });

const gov = createGovernor(createInMemoryGovernorStore());
await gov.configureBucket({ workspaceId, scopeKey: 'global', capacity: 100, refillPerSec: 1 });
const { admitted } = await gov.admitSpawn({ workspaceId, harness: 'a', role: 'worker' });
```

Papercusp's own host binding (a Postgres store over `harness_shared.*` + coord/lock/escalation
effects) lives in `packages/operator-core/lib/fleet/` — the canonical worked example of wiring
this toolkit to a real substrate.

> Extracted from `packages/operator-core/lib/fleet/` per plan
> `generalize-libs-to-generic-2026-06-05` (row #4). Behavior-preserving move + seam.
