# @papercusp/file-claim

Shared **vocabulary** for file-claim coordination across Papercusp.
This package is an interface + a conformance suite — **not** an
implementation. The two real coordinators correctly keep separate
implementations (one in-process `Map`, one PG-backed); what they share
is the contract.

## Why this exists

Papercusp has two file-claim coordinators that grew up independently:

| | `FileLockQueue` | SU-locks |
|---|---|---|
| Location | `libs/papercusp/packages/orchestrator/src/file-lock-queue.ts` | `apps/operator/lib/agent-tools/locks/su-lock-store.ts` |
| Scope | In-process; async worker dispatches inside one orchestrator Node process | Cross-process; independent `papercusp-su` agents (OMP sessions) |
| Backing | In-memory `Map` | Postgres (`papercusp_su` database) |
| Wait/wake | Promise resolution | `LISTEN`/`NOTIFY` |
| TTL | None (orphans clear on process restart) | Per-claim TTL + heartbeat |

They have the **same conceptual contract** — acquire a path set
atomically, release, extend, reap, FIFO-fair, deadlock-free — but
historically used different method names, argument shapes, and even
different (one wrong) explanations of *why* they're deadlock-free.
`@papercusp/file-claim` aligns the vocabulary so an engineer who
learns one understands the other.

## The contract

`FileClaimCoordinator` (see `src/index.ts`) — five methods:

- `acquire(owner, paths, options?)` → `AcquireResult`
- `release(claim)` → `void`
- `extend(claim, options)` → `ExtendResult` (**new** claim; never
  mutates the input — file-locking #10)
- `heartbeat(claim, ttlMs?)` → `HeartbeatResult`
- `reap(owner)` → number of claims dropped

Invariants every implementation MUST preserve (the conformance suite
asserts each):

- **Atomic multi-path.** `acquire(paths)` takes every path or none.
  Partial holds are never observable.
- **FIFO fairness per path.** Earlier waiters on a contended path win
  first.
- **Deadlock-free** — via the **no-hold-while-waiting** rule: a caller
  acquires its whole set atomically and never blocks on one path
  while holding another. (The alphabetical sort that both
  implementations happen to do is **not** load-bearing for this — it
  only buys FIFO determinism. An earlier `FileLockQueue` header
  wrongly credited the sort; corrected in file-locking #9.)
- **`extend` never mutates the input claim** — always returns a fresh
  one.
- **`release` is idempotent** — releasing an already-released or
  unknown claim is a no-op.
- **`reap(owner)` drops every claim the owner holds** and returns the
  count; a second reap returns 0.
- **Empty-path `acquire` is legal** — returns a no-op claim.

## Implementations

| Adapter | Package | Use when |
|---|---|---|
| `FileLockQueueCoordinator` | `@papercusp/orchestrator` (`src/file-lock-queue-coordinator.ts`) | In-process worker coordination; no TTL needed; restart clears orphans. |
| `SuLocksCoordinator` | operator (`apps/operator/lib/agent-tools/locks/coordinator.ts`) | Cross-process agent coordination; durable; TTL + heartbeat. |

## Adding a third coordinator

A future filesystem-lockfile or Redis coordinator (for environments
without PG — air-gapped, offline-first desktop) drops in behind the
same interface:

1. `class MyCoordinator implements FileClaimCoordinator`.
2. `describeConformance('MyCoordinator', factory)` from
   `@papercusp/file-claim/conformance` — the same suite that holds
   the other two honest.
3. Green suite ⇒ behaviourally interchangeable. You do not need to
   read either existing implementation.

## Note on interface shape

The interface deliberately uses discriminated unions
(`AcquireResult`, `ExtendResult`, `HeartbeatResult` = `{ ok: true … }
| { ok: false … }`) rather than throwing on contention or returning a
bare handle. This makes every failure mode explicit at the
type level — a caller cannot forget to handle `busy`. `ttl*` values
are milliseconds throughout for consistency with the JS time unit;
adapters convert to their backend's native unit internally.
