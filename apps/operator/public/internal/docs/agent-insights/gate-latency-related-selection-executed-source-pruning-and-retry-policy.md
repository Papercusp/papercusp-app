# Green-checkpoint latency: the related-selection threshold, the executed-source map, the PC_TEST_FILTER_LIST channel, and the AFFECTED_RETRY_* log markers
URL: /internal/docs/agent-insights/gate-latency-related-selection-executed-source-pruning-and-retry-policy

Doc trail for the durable surfaces the gate-latency plan (gate-latency-selection-and-retry-policy-2026-09-06) added to the affected-tests runner: the AFFECTED_RELATED_THRESHOLD tunable behind RELATED_SELECTION widening (default 0.95, was 0.5), the harness_shared.test_executed_sources table (migration 1132) that lets the selector prune statically-selected tests that never execute the change, the PC_TEST_FILTER_LIST env channel that hands the content-addressed selection file to defineVitestConfig, and the four greppable retry markers AFFECTED_RETRY_DECISION / AFFECTED_RETRY_SKIPPED / AFFECTED_RETRY_BUDGET / AFFECTED_RETRY_POOL an agent triaging a gate red reads to tell a flake re-run from a deterministic red.

The gate-latency plan (`gate-latency-selection-and-retry-policy-2026-09-06`) changed four things in `scripts/affected-tests.mjs` and its libraries that an agent reading a green-checkpoint log, tuning a run, or triaging a red will meet. None of them is flag-gated; all are on by default. This page is the doc trail the class rubric requires for them.

## 1. Related selection widens at `AFFECTED_RELATED_THRESHOLD` (default 0.95)

`scripts/lib/related-tests.mjs` selects every test whose transitive import closure reaches a changed file, then decides whether that subset is close enough to the whole suite that an explicit file list is pure overhead. That decision used to be `selected/total > 0.5 → run everything`; on gate run e70cd139 (2026-09-05) it turned a correct 3,849-of-6,493 operator-core selection into `mode=full`, running 2,634 unrelated files for nothing (about 40% of that lane's wall clock).

* Default is now `RELATED_WIDEN_THRESHOLD_DEFAULT = 0.95`.
* Override with `AFFECTED_RELATED_THRESHOLD=<fraction in (0, 1]>`. An unparseable value falls back to the default and is REPORTED (`source`/`invalid` on the result), so a typo cannot silently re-widen or re-narrow the gate.
* The soundness rails still precede the widening rule and all fail toward running MORE tests: no test files in the workspace, no changed path inside the indexed root, an unresolved import (treated as depending on everything), and an emptied selection each return `mode=full` with their own `reason`.

The log line to read is:

```
RELATED_SELECTION ws=@papercusp/operator-core selected=3267 total=6569 mode=related reason=ok widenThreshold=0.95
```

`mode=full` with `reason=over-threshold` means the widening rule fired; any other `reason` on `mode=full` is a rail. ⚠ The line is emitted only under `--related` (the green-checkpoint sets it). A hand replay such as `node scripts/affected-tests.mjs --print-affected --changed-paths <paths>` prints ZERO `RELATED_SELECTION` lines without `--related`, which reads exactly like "the mechanism is gone". Add `--related`.

## 2. Executed-source pruning: `harness_shared.test_executed_sources` (migration 1132)

The static closure is a large superset of what a test actually loads (barrels). vitest observes the true executed set per test file; the reporter in `libs/test-config/src/executed-source-map-reporter.ts` records it, one row per `(workspace_name, test_file, recorded_sha)`, into `harness_shared.test_executed_sources` (`libs/papercusp/libs/db/sql/1132-executed-source-map.sql`). The reporter only writes from a CLEAN checkout (a dirty tree has no sha that describes what ran); the runner points it at the table through `PC_EXECUTED_SOURCE_MAP_WORKSPACE` / `PC_EXECUTED_SOURCE_MAP_OUT`.

`scripts/lib/executed-source-map.mjs` then prunes a statically selected test ONLY when all three guards hold: its recorded map exists, the map is current (nothing in the test's closure changed between `recorded_sha` and the judged sha, via `gitChangedBetween`), and the executed set misses the change. It is fail-open by construction: a graph hole (unresolved import) is kept whatever the map says, the changed test itself is always kept, and a pruning that would empty the selection is refused (`wouldEmpty=true`, the static selection stands with `pruned=0`). The summary line is `EXECUTED_SOURCE_MAP ws=… wouldEmpty=… keptChangedTest=… keptUnresolved=…` (`formatExecutedMapLine`). Missing table, missing PG URL, or a dirty checkout simply disables pruning — the static selection runs.

## 3. `PC_TEST_FILTER_LIST`: how the selection reaches vitest

The runner writes the selected test paths to a content-addressed JSON file and passes its path in `PC_TEST_FILTER_LIST` (`libs/test-config/src/vitest-config.ts`, `PC_TEST_FILTER_LIST_ENV`). `@papercusp/test-config`'s `defineVitestConfig` narrows the workspace's `include` to that list; the file must contain a JSON array of test paths or the config throws. This is runner-internal plumbing: it replaces passing thousands of file arguments on the command line. If a vitest run under the gate appears to run a subset of a workspace, this is why, and the `RELATED_SELECTION` line above says how the subset was chosen. Unset it (or run `testing:run` / `npm run test:file`) for an unfiltered run.

## 4. Retry markers: `AFFECTED_RETRY_DECISION` / `_SKIPPED` / `_BUDGET` / `_POOL`

A failed task used to be re-run unconditionally, one at a time, each retry assuming the whole worker budget (the 34-minute second pass on e70cd139). `scripts/lib/retry-failure-shape.mjs` now decides per task from the FAILURE SHAPE — report-scoped flake signatures with per-file attribution — and `scripts/affected-tests.mjs` runs every retry through ONE budgeted pool in three phases (decide and budget every retry, run them, report in order). The pre-existing `AFFECTED_RETRY_FAILED=0/1` still wins when set explicitly; its default is load-derived (`load1/core > 1.0`).

Each line is greppable and carries `ws=<workspace>`:

* `AFFECTED_RETRY_DECISION ws=… retry=1 mode=… failedFiles=N flakeClasses=… flakeScope=… flakeFiles=N retryFiles=N reason=…` — a retry WAS scheduled; `retryFiles` is the attributed subset that re-runs.
* `AFFECTED_RETRY_SKIPPED ws=… retry=0 … reason=broad-deterministic-red(N>max)` or `reason=deterministic-shape(N file(s), no flake signature)` — the red is deterministic; no retry. This is the line that tells a triaging agent the failure is real and the files named in the report are the ones to fix.
* `AFFECTED_RETRY_BUDGET ws=… budgetMs=… source=… referenceMs=… referenceSource=… firstPassMs=… durationEstimateMs=… floorMs=60000 capMs=1200000` — the budget for a scheduled retry: the larger of history and the first pass, times 2 headroom, floored at 60s and capped at 20m; with no reference at all the CAP applies, never the floor. The retry child gets this as both its watchdog timeout and its extension ceiling.
* `AFFECTED_RETRY_POOL phase=start|done|aborted tasks=N budgetSumMs=… wallMs=… settled=N detail=…` — brackets the whole retry stretch so its wall time is attributable. `phase=aborted` means the pool failed; the initial failures stand and the run still reports (a pool failure can no longer become a lost run).

## 5. Setup stretch stamps

`apps/operator/lib/release/setup-stretch-stamps.ts` stamps the phases between candidate selection and the first test (setup-tree, early-typecheck, slot wait, other) and the `candidate-age:` log line names the dominant phase; a stretch over the 20-minute budget is called out as a stale-tree warning (`dominant phase: setup-tree`, WI-7069), and an unstamped remainder is reported as such rather than hidden.

## Reading a red with these in hand

1. `RELATED_SELECTION` per workspace: was the failing file even selected, and by which mode?
2. `AFFECTED_RETRY_SKIPPED` with a `deterministic-shape`/`broad-deterministic-red` reason: treat the red as real; `AFFECTED_RETRY_DECISION` followed by a green second pass: a flake, and the flake class is named.
3. `AFFECTED_RETRY_BUDGET`/`AFFECTED_RETRY_POOL`: whether the second pass, not the first, is what made the run long.
