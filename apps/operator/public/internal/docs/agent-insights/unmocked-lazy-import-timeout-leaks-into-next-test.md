# A unit test that lazy-imports a heavy real module can time out — and the timeout leaks into the NEXT test
URL: /internal/docs/agent-insights/unmocked-lazy-import-timeout-leaks-into-next-test

Why an un-mocked dynamic import() of a PG-backed module chain makes a unit test flaky-slow, and how the 60s per-test timeout produces a misleading \"expected N calls, got N+1\" failure in the following test.

## Symptom

A vitest unit file fails intermittently on the green-checkpoint box (server-class, loaded) while passing in isolation locally, with a two-part signature:

* test 1: `Test timed out in 60000ms`
* test 2: `expected "vi.fn()" to be called 2 times, but got 3 times`

The "got 3, expected 2" is **not** a bug in test 2. It's a *leak from test 1*: when test 1's `await` on a mocked spy times out, the underlying promise is still pending. It resolves *after* test 2's `beforeEach` has already `mockClear()`ed the spy, so test 1's deferred call lands inside test 2's window and inflates its count. Chasing test 2 is a dead end — the real fault is whatever made test 1 slow enough to time out.

## Root cause

The code under test made a **lazy `import()` of a real, heavy module** that was *not* mocked. Concretely, `surfaceForApproval` (operator-sentinel-handoff-deps) does `Promise.all([import('./escalations'), import('./operator-standing-candidates'), import('./delegated-tasks')])`. The test mocked the first two but forgot `./delegated-tasks`, which transitively pulls in the PG chain (`@papercusp/db-org` → `./work-items` → `./issues-engineer`). The **one-time cold transform of that graph took \~26s locally** — comfortably under 60s on a quiet box, comfortably *over* it on a loaded CI box. First test pays the cold-import cost; later tests reuse the module cache and are fast, which is why "run it again and it passes."

## Fix

Mock every module the code-under-test dynamically imports — including the ones imported only for a single constant. Here the whole point of `./delegated-tasks` in this path was the `OPERATOR_COORD_OWNER` string:

```ts
vi.mock('./delegated-tasks', () => ({ OPERATOR_COORD_OWNER: 'operator' }));
```

Test body dropped from \~26s to \~100ms; the timeout (and its leak into the next test) is gone deterministically.

## Rules of thumb

* **A unit test must not lazy-import a real PG/coord module.** If the code-under-test does `import('./x')` and `x` (transitively) touches `@papercusp/db-org` / `./work-items` / coordination, mock `x` — even if only a constant is used from it. `vi.mock` replaces the whole module, so the heavy transitive graph never loads.
* **Time is a dependency.** A test that *passes but takes 20s+* is a red flag, not a pass — it's one loaded-box slowdown away from a 60s timeout. Treat a slow unit test as a missing mock.
* **When you see "expected N, got N+1" in one test, check whether a *sibling* test timed out.** A per-test timeout doesn't cancel the pending promise; its deferred mock call leaks into the next test's cleared-spy window.
