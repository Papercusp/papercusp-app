# A createWorkItem test with a fakeSql must stub the emitAwaitedEvent sink
URL: /internal/docs/agent-insights/fakesql-create-tests-stub-the-emit-sink

Tests that drive createWorkItem against a fakeSql leak a fire-and-forget lifecycle emit into the real await engine, tripping vitest-fail-on-console in a LATER test — stub ./events/await/engine emitAwaitedEvent.

# A createWorkItem test with a fakeSql must stub the emitAwaitedEvent sink

## Symptom

A unit test that exercises `createWorkItem` against a `fakeSql` passes in
isolation but **flakes intermittently** in a full run, with a red like:

```
[work-items-events] claimable-event for WI-9001 emit failed: Invalid time value
   at failSoft (packages/operator-core/lib/work-items-events.ts)
Expected test not to call console.warn().  (vitest-fail-on-console)
```

The warn is often attributed to a **different** test than the one that caused
it, and the file it reds is not always the file that created the item.

## Why it happens

`createWorkItem` fires its lifecycle events **fire-and-forget** through a
**dynamic** `import('./work-items-events')`, and `work-items` ↔
`work-items-events` form an **import cycle**. Vitest's per-function module mock
of `./work-items-events` does **not** reliably intercept a dynamic import under
that cycle, so a **real** emit can leak through. It reaches the real await
engine, which parses delivery/await rows from the `fakeSql` — and a typical
`fakeSql` answers *every* query with a single canned row like
`[{ id: 'WI-9001' }]`, so the row is missing `created_at` /
`next_attempt_at`. The engine's row map then does
`new Date(undefined).toISOString()` → **`Invalid time value`** (older variants
tripped `undefined.startsWith`). That rejection's `.catch → failSoft →
console.warn` resolves on a **later microtask/macrotask**, so
`vitest-fail-on-console` reds whatever test happens to be running then.

## The fix — stub the single sink

Mocking `./work-items-events` per-function is **not** enough (the cycle defeats
it). Stub the one function every emit path funnels through —
`emitAwaitedEvent` in `./events/await/engine` — so no emit, mocked or leaked,
can ever touch PG:

```ts
vi.mock('./events/await/engine', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAwaitedEvent: vi.fn(async () => ({ ok: true, key: '', woken: 0, notified: [], msgId: null })),
}));
```

Also spread `importOriginal` in any `./work-items-events` mock so a leaked
call to a non-mocked export resolves to the real (now-harmless, sink-stubbed)
function rather than `undefined`.

## Rule of thumb

If a test constructs a **fakeSql** and calls **createWorkItem** (or any path
that flows into `setWorkItemState` / claim / release / link), stub
`emitAwaitedEvent` up front. The event leg has its own coverage in
`work-items-events.test.ts`; a create/lifecycle test should never let a real
emit reach the store.

## History

This class has red-pinned the green-checkpoint gate repeatedly:
`work-items-urgent.test.ts` (WI-3309 / EI-8413, 4 reds, 2026-07-07) and
`work-items-created-event-hook.test.ts` (EI-9654, 2026-07-11). The guard is the
stub itself — a nondeterministic async leak has no before/after regression test.
