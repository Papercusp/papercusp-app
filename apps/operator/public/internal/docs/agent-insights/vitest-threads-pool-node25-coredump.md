# Vitest `threads` pool core-dumps under Node ≥25 (use `forks`)
URL: /internal/docs/agent-insights/vitest-threads-pool-node25-coredump

>-

## The trap

`npm run test:affected` would die part-way through the `apps/operator`
(`@papercusp/web`) unit suite with:

```
libuv: io_uring_enter(getevents): Operation not supported
Aborted (core dumped)
npm error code 134
npm error command sh -c vitest run --passWithNoTests
```

Crash point was **non-deterministic** (different file each run; sometimes
**no** io\_uring message at all). Every test that actually executed *passed* —
it was a worker-process abort, not an assertion failure.

## Root cause

`libs/test-config/src/vitest-config.ts` set the unit (and browser) layer to
the **`threads`** pool (vitest's `worker_threads` backend). worker\_threads
share a single libuv event loop, and under **Node ≥25** on this kernel that
loop aborts mid-run (the io\_uring message is a *symptom on some runs*, not the
whole story — `UV_USE_IO_URING=0` alone does **not** fix it). The dev box's
PATH resolves linuxbrew Node **25.9.0** for everything launched via `npm`
(even when an interactive `node -v` shows 22), so the test runner always hit
the bad path.

It only crashed on `apps/operator` because that's the only suite big enough
(661 files) to keep enough worker threads alive long enough to trip it.

## Fix

```ts
// libs/test-config/src/vitest-config.ts
pool: layer === 'browser' ? 'threads' : 'forks',
```

`forks` (vitest's *own default* — the repo had overridden it to `threads` for
speed) runs each test file in its own child process with its own libuv loop,
so it's stable across Node versions and doesn't depend on which Node the
runner's PATH resolves. Wall-clock for the full operator suite is \~29s
parallel — no meaningful regression. **Prefer fixing the pool over pinning
Node 22**: a pool change is robust everywhere (CI, every contributor's box);
PATH-based Node pinning is exactly the fragile env-coupling that breaks again.

## Two things the fix *reveals* but does NOT cause

Once the suite runs to completion, two pre-existing conditions become visible.
Neither is introduced by the pool change (both reproduce identically under the
old `threads` pool when a single file is run in isolation):

1. **A large body of pre-existing unit-test failures** (\~60–110 files
   depending on the run) that the perpetual crash had been masking. `test:affected`
   normally runs only the *changed* files' closure, so these rarely all ran at
   once — and on this box `origin/main` is hundreds of commits behind, so the
   affected diff is huge. These are genuine broken/stale tests, tracked
   separately from the infra crash.

2. **Spurious 5s-timeout failures from CPU contention** — \~60 `Test timed out
   in 5000ms` failures appear *only* when all 661 files run fully parallel
   (forks defaults `maxForks` = CPU count). They **vanish entirely** when the
   suite is serialized (`--no-file-parallelism` → 0 timeouts). This is a
   worst-case-only artifact of running the whole suite at once on a busy shared
   box; normal `test:affected` subsets don't hit it. If it becomes a problem,
   cap `poolOptions.forks.maxForks` or raise the unit `testTimeout` — both are
   speed tradeoffs, so measure first.

## Don't

* Don't "fix" this by pinning Node 22 via PATH — it re-breaks the moment any
  runner (CI, a new box) resolves a different Node.
* Don't quarantine your way out of the crash — it's infra, not flaky tests.
* Don't read the post-fix failure tally as "the pool change broke things" —
  verify any suspect file against `--pool=threads` in isolation; if it fails
  there too, it's pre-existing.
