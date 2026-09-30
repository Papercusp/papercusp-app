# Testing code that calls emitAwaitedEvent: three traps that read as 'the wake never queued'
URL: /internal/docs/agent-insights/testing-await-event-emit-paths

(1) The await-event store pins EVERY row to DEFAULT_COORD_WORKSPACE — registerAwait/fireAwaitsForKey accept a workspaceId arg but eventsWs() ignores it, so a PG assertion filtered by YOUR workspace_id finds zero rows even though the wake queued fine; drop the workspace predicate. (2) The real emit kicks an async wake pump (setImmediate) whose executor console.warns 'dead waiter' for fake test subscribers, and vitest-fail-on-console RE-PATCHES console per test — a beforeAll spy gets wrapped and the test still fails; install the console.warn spy in beforeEach (or the test body), never beforeAll. (3) A blanket sql stub can leak a malformed row into the pattern-await branch; use query-shaped rows or the real migrated org PG fixture.

## The mistake this prevents

Wiring the cross-Pot reply path (pot-network-surface-2026-06-11 B-03) to the
real `emitAwaitedEvent` and asserting "a wake delivery row exists" burned two
debugging cycles on failures that looked like the emit was broken. It wasn't —
both were test-harness traps.

## Trap 1 — the await store ignores your workspaceId

`packages/operator-core/lib/events/await/store.ts`:

```ts
const eventsWs = (_caller?: string): string => DEFAULT_COORD_WORKSPACE;
```

Every store function (`registerAwait`, `fireAwaitsForKey`, `insertDeliveries`,
`listActiveAwaitsForKey`, …) takes a `workspaceId` input and **discards it** —
events are coord-plane, single-workspace by design. The symptom: your emit
visibly fired the await (`listActiveAwaitsForKey` drops to zero) but

```sql
SELECT * FROM harness_shared.event_wake_deliveries WHERE workspace_id = '<yours>'
```

returns nothing. The row exists — under `DEFAULT_COORD_WORKSPACE`. In test
assertions, filter by `subscriber_id` + `event_key` and **omit the
workspace\_id predicate**.

## Trap 2 — beforeAll console spies don't survive vitest-fail-on-console

The real `emitAwaitedEvent` kicks the wake pump off the hot path
(`setImmediate`). For a fake subscriber (no wake handle, no presence) the
executor rightly logs `[await-event] wake #N DROPPED (dead waiter)` via
`console.warn` — at an async moment that lands inside whichever test is
running. `vitest-fail-on-console` then fails that (unrelated) test.

The trap inside the trap: the library **re-patches the console methods per
test**, so a `vi.spyOn(console, 'warn')` installed in `beforeAll` gets wrapped
by the library's fresh interceptor and the warn still counts as a failure.
Install the spy where it runs AFTER their patch:

```ts
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
```

(In-test-body spies work for the same reason.) Working example of both fixes:
`packages/operator-core/lib/cross-hive-reply-events.integration.test.ts`.

## Trap 3 — a blanket `sql` stub leaks into the pattern-await path (WI-3309 / EI-8413)

Same family as Trap 2, one layer deeper. `fireAwaitsForKey` (in `store.ts`) has a
**pattern-await** branch that fetches candidate rows (`event_key LIKE '%*%'`) and runs
each through `keyMatchesPattern(r.event_key, …)`. A test double that mocks
`@papercusp/db-org`'s `sql` to answer **every** query with the *same* canned,
differently-shaped row feeds that branch a "candidate" whose `event_key` is not a real
key — and `keyMatchesPattern(undefined, …)` then threw `undefined.startsWith`. Because
the emit kicks the pump fire-and-forget (`void pumpWakeDeliveries(ws).catch(log)` in
`engine.ts`), the throw surfaced as a `[await-event]` **`console.warn`** at an async
moment inside an unrelated test → the same `vitest-fail-on-console` failure that reads
as "the emit broke".

The code now guards it:

```ts
const matched = patternCandidates.filter(
  (r: any) => typeof r.event_key === 'string' && keyMatchesPattern(r.event_key, input.eventKey),
);
```

`event_key` is `NOT NULL` in real Postgres (and a null can't satisfy the `LIKE '%*%'`
filter anyway), so this only ever trips on a malformed stub row — it now skips it
instead of crashing the emit. **Lesson for tests:** when you mock `sql`, return
query-shaped rows (or `[]`) **per query** — a single blanket canned row leaks into
this pattern-await path. Prefer the real migrated org PG fixture
(`test/_org-test-db.ts`) over a hand-stubbed `sql`, as the working example above does.
