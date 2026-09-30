# A fire-and-forget setImmediate auto-pump races a test's controlled pump — and an added await tips the race
URL: /internal/docs/agent-insights/setimmediate-autopump-races-controlled-test-pump

Why adding an unrelated `await` in emitAwaitedEvent broke wake-on-message.integration.test.ts: the internal setImmediate(pumpWakeDeliveries) uses PRODUCTION host discovery, can't see testbed sockets, and now wins the race against the test's controlled pump. Fix: gate the internal auto-pump behind a default-ON flag tests can disable.

# A fire-and-forget `setImmediate` auto-pump races a test's controlled pump

## Symptom

`packages/operator-core/lib/events/await/wake-on-message.integration.test.ts`
started failing (EI-9483) with:

* test 1: `bDeliveries[0]` matched `{status:'delivered'}` but the **channel**
  mismatched (`coord-inbox`, not `psu-socket-inject`).
* test 2: `hostB.received` was empty (`[]` vs length 1).

Both = the wake was **not** delivered over the test's live testbed socket. The
red appeared with a commit whose only relevant change was adding
`await listEventKeySubscribers(opts.key)` to `emitAwaitedEvent` — a change with
no logical connection to socket delivery.

## Root cause — an added `await` tips a pre-existing race

`emitAwaitedEvent` (the path `coord:send {wake:true}` → `wakeRecipients` takes)
**fire-and-forgets an internal pump**:

```ts
setImmediate(() => { void pumpWakeDeliveries(ws).catch(...) });
```

That internal pump runs with `deps = {}` → **production** host discovery
(`findLiveHost`), which scans the real psu-pty dir and **cannot see the testbed's
isolated sockets**. So when it claims the pending delivery it finds no host and
**degrades it to a coord-inbox delivery** — consuming the row before the test's
*controlled* pump (`pumpWakeDeliveries(ws, { findPsuHost: tb.findPsuHostDep() })`)
can deliver it over the live testbed socket.

The race always existed; the test won it because, before the change, `emit`
returned almost immediately after scheduling the `setImmediate`. Adding an
`await` (a real DB round-trip) **after** the schedule inserts an event-loop yield
— the check phase runs, the internal pump fires, and it now **wins**. Locality
proof: the two `wake:true` tests (which hit `emit`) failed; the `wake:false` test
(which never reaches `emit`) stayed green.

## The general lesson

1. **A fire-and-forget `setImmediate`/`queueMicrotask`/`.then()` side-effect is a
   latent race.** Any later `await` added to the same function can change whether
   that side-effect runs before or after the caller proceeds. "I only added an
   unrelated await" can absolutely break a timing-sensitive test.
2. **An internal auto-pump that uses production dependencies is incompatible with
   a test that injects testbed dependencies for the *same* work.** Whoever claims
   the delivery first wins — and the internal one mis-handles it.

## Fix

Gate the internal `setImmediate` auto-pump kicks behind a module flag
`autoPumpEnabled` (defaults **ON** → production byte-identical) with a test-only
setter `setAutoPumpEnabledForTests`. An integration test that drives the pump
itself disables it in `beforeEach` / restores in `afterEach`, making its
controlled pump the sole delivery path (which such a suite already intends).

## Where to look

* `emitAwaitedEvent` + the three `if (autoPumpEnabled) setImmediate(...)` kicks in
  `engine.ts`.
* The wake path: `coord:send` → `wakeRecipients` (`inbox-wake.ts`) →
  `emitAwaitedEvent`.
* The delivery/host-discovery split: `executeWake` in `wake-executor.ts`
  (`const findPsuHost = deps.findPsuHost ?? findLiveHost`).
