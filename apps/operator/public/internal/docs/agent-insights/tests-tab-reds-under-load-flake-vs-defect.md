# A Tests-tab red under high box load is usually a flake, not a defect — how to triage
URL: /internal/docs/agent-insights/tests-tab-reds-under-load-flake-vs-defect

When you're asked to 'get the Tests tab green', most reds you see under a loaded box (load avg 30–90, fleet + benchmarks running) are load-induced flakes that self-green, NOT product/test defects. Two flake classes dominate operator-core/operator-vite: (1) TIMEOUT-under-load — a heavy module-import-graph transform (or real PG/FS I/O) counted against a per-test timeout tips over 60s/15s under CPU starvation (a 43-line test can take 50s purely from transforming its `await import(...)` graph); (2) MODULE-REGISTRY-RACE — 'sql is not a function' / 'Cannot read properties of undefined' from a parallel mock-bleed between vi.mock-heavy files. A GENUINE red is deterministic (fails the same way in an isolated re-run) and PERSISTS as the file's latest row. Triage with testing:runs (latest-per-file) + an isolated re-run before touching anything. Also covers: the breadth-test-with-real-I/O anti-pattern, the green-checkpoint code-143 gate-stall, and why a manual `--reporter=dot` run never records a green row.

## The mistake this prevents

You're told "test the app / get the Tests tab green." You pull the run history,
see a pile of `fail` rows, and start "fixing" tests — bumping timeouts, loosening
assertions, or rewriting passing tests. Under a loaded box, **most of those reds are
flakes that have already self-greened**, and mutating them is both wasted work and exactly
the "don't game the tests" failure mode.

The Tests tab (`/admin/testing`, `/adv` → Tests) is a **viewer** over `test_runs`, not a
runner — a chip is red only when a **file that still exists on disk** has a **latest
matching row** of `fail`/`error`. See
[the tab status model](/internal/docs/agent-insights/) memory
`reference_testing_tab_status_model` for the exact query. Deleted probe/scratch files and
`papercupai-workspace/papercup-checkpoint/**` mirror paths are NOT shown — filter them out.

## Step 1 — get the REAL red set (not raw fail rows)

```
testing:runs { status: ["fail","error"], sinceHours: 24 }
```

`latestPerFile` defaults ON when you do not name a `filePath`, and is exactly the
`DISTINCT ON (file_path) … finished_at DESC NULLS LAST, id DESC` collapse this step used to
hand-write — without it a file that failed an hour ago and has passed since still lists as
failing. Rows carry `branch` and `outputTail`. ⚠ One difference worth knowing if you are
comparing against an older hand-written query: `sinceHours` windows on run START, not on
`finished_at`.

Then drop any `papercupai-workspace/%` path and any path that no longer exists (`test -f`) —
neither filter is expressible in the verb. What's left is what the tab actually shows red.
Read each one's `outputTail` — it carries the failing test name + assertion (or the timeout
message).

## Step 2 — classify each red: flake vs genuine

**Genuine defect** — fix it (the code, or a bad test, legitimately):

* `outputTail` is a concrete assertion (`expected 6 to be 5`, `expected 404 to be 400`).
* It's **deterministic**: re-run the file *in isolation* and it fails the same way.
* It **persists** as the file's latest row across the fleet's re-runs.

**Load-induced flake** — leave it, note it, do NOT mutate:

* **Timeout class:** `outputTail` is `Test timed out in 60000ms` (or 15000ms). Check the
  file's run history — `testing:runs { filePath: "<fragment>" }`, which turns the
  latest-per-file collapse OFF and gives you the history — and if it alternates pass/fail
  with passes near the timeout ceiling (e.g. passes 47–59s against a 60s timeout), it's
  tipping over under load. A trivial 43-line test (e.g. `pot/guard.test.ts`) can take 50s
  purely transforming the `await import('./create')` module graph under CPU starvation — the
  cost is vitest transform, not the test body. Bumping the timeout is a losing treadmill
  (proven on `sync-resolver/index.test.ts`: 10s→30s→120s, still timed out at load 90).
* **Module-registry-race class:** `outputTail` is `sql is not a function` /
  `Cannot read properties of undefined` from a `vi.mock`/`vi.doMock` bleed across
  parallel files. The failing test is often correctly written (e.g.
  `overwatch/liveness.test.ts` passes a fake `sql` directly and clears mocks in
  `beforeEach`) — it just ran in a worker a sibling polluted. Passes in isolation;
  self-greens on the next fleet run.
  * **The race can wear a CONCRETE-ASSERTION disguise.** `plans/set-schedule.test.ts`
    flaked twice (2026-06-19 02:15 + 02:43, both on load spikes) with
    `expected [ Array(1) ] to be undefined` — which *reads* like a deterministic
    defect, not a `undefined`-is-not-a-function bleed. Don't be fooled: it asserts
    `b.warnings` is undefined (weekly RRULE → no frequency warning), runs the REAL
    pure `frequencyWarning`, and that function returns `null` for that input at
    **every** wall-clock (verified 0/6720 samples across 14 days) — so a non-null
    warning can ONLY come from cross-file `vi.mock` contamination of
    `harness/routines/schedule-next` under the parallel scheduler. It's a vi.mock-heavy
    file (3 mocks); passes 7/7 isolated. Lesson: a concrete-looking `toBe`/`toBeUndefined`
    failure is STILL this class if (a) it passes in isolation, (b) the asserted
    production logic is provably deterministic for the input, and (c) it only fails on
    load spikes. Re-run isolated before ever touching a correct test.

Both classes correlate with **box load** (fleet + benchmark containers; saw load avg 33–90,
180 vitest procs). They are test-INFRA fragility, not defects — the fix is lower load, not
a code/test change. A bare `tsx -e "import('./file')"` returning in under 2s while
`npx vitest run <file>` hangs for minutes confirms it's CPU starvation, not a real hang.

## Step 3 — the green-checkpoint code-143 gate-stall

If deploys to `:3070` have stopped, check `harness_shared.pipeline_events`:

```sql
SELECT to_char(created_at,'HH24:MI') t, (detail->>'green') green, (detail->>'code') code,
       detail->'failingTests'
FROM harness_shared.pipeline_events WHERE kind='green_checkpoint'
ORDER BY created_at DESC LIMIT 6;
```

A `code: 143` (SIGTERM) row with no `green` value = the green-checkpoint was **killed under
load before it could finish `test:affected`** — the gate can't *certify* green even when the
tests ARE green. This self-heals when load drops (a checkpoint completes, sees green,
fast-forwards `main`, deploys). `failingTests` is reported at the **workspace** level
(`@papercusp/operator-core`); the actual failing FILES are recorded under the
`papercup-checkpoint/` mirror paths around that run's timestamp — read those `outputTail`s,
then confirm the **canonical** versions' latest rows are green (they usually already are).

## The breadth-test-with-real-I/O anti-pattern (and its fix)

A test that DISPATCHES every registry entry for real (`for (const name of names) await
resolve(name, ...)`) does real PG/FS I/O per entry, so its runtime scales with
`entry-count × I/O-latency` and chronically trips the gate as entries grow. `sync-resolver/
index.test.ts`'s "every registered name dispatches without TypeError" did exactly this
(51→123 entries; froze `main` \~8h on 2026-06-14). Its real INTENT was only to catch a
mis-wired entry (a typo'd `resolves:` leaving `resolve` undefined). **Fix: validate the
registry STRUCTURALLY** — iterate entries and assert `typeof entry.resolve === 'function'`
(+ optional `argsSchema.parse`) via a test-only `getRegistryEntryV2(name)` export. O(1) per
entry, zero I/O, deterministic, no timeout ever. General rule: a "dispatch every entry"
breadth scan that does real I/O is the wrong implementation of a structural-wiring check.

## Manually greening a chip: the `--reporter` trap

To record a green row you must run **without** a CLI `--reporter` override.
`defineVitestConfig` auto-wires `admin-test-runs-reporter` into the config's `reporters`
array; passing `npx vitest run <f> --reporter=dot` REPLACES that array, so the run records
NOTHING and the chip stays red even though it passed. Run with default reporters (no
`--reporter` flag), or just let the green-checkpoint/fleet re-run the file. The reporter is
also fire-and-forget with 1s pg connect+insert timeouts that swallow on failure — under load
a legit row can silently drop; re-run when load eases.
