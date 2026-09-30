# A red-test watchdog EI can be a RETIRED test, not a broken one
URL: /internal/docs/agent-insights/red-test-ei-for-a-retired-test-file

Before chasing a red-test improvement EI's failure tail, confirm the file still exists and still runs — a test moved to _retired/ is excluded from the suite; the EI is stale, resolve fixed with run-history + retirement evidence.

A `red-test:<path>` improvement EI (`kind=bug`) carries a big **rendered-DOM failure tail** in its
summary. That tail is a trap: it makes the failure look like a live component/fixture-contract bug
to investigate — but the test may simply have been **retired**, not broken.

Real example: **EI-10486** (`apps/operator-vite/src/components/left-sidebar/MugTab.test.tsx`,
"failed 26× in 6h"). A prior worker parked it: *"recurring major MugTab UI suite red with large
rendered DOM drift. Requires broader component/fixture contract investigation."* That investigation
was wasted — the file had already been **retired** to `_retired/mug-kettle-rail-tabs/` under WI-4778
("Papercup is the ONE persona"). The base vitest config excludes `**/_retired/**`
(`libs/test-config/src/vitest-config.ts`), so it no longer runs. The `test_runs` history showed it
had also stabilized to **green** (61 pass / 2 fail in 48h, last fail well before removal) before it
was moved. Nothing to fix.

## The 60-second triage BEFORE reading the failure tail

For any `red-test:<path>` EI, run these first:

1. **Does the file still exist at that exact path?** `test -f <path>` — if GONE, it was moved or
   deleted. Check `_retired/` (`find . -path ./node_modules -prune -o -iname '<Base>*' -print`).
   `_retired/**` is suite-excluded, so a retired copy is never executed.
2. **What does the run history actually say?** The watchdog summary's "latest run is still red" is a
   snapshot from EI-creation time and goes **stale**, so ask for the history:
   ```
   testing:runs { filePath: "<fragment of the path>", limit: 15 }
   ```
   `filePath` matches as a SUBSTRING, so a memorable fragment is enough. Naming it also turns the
   latest-per-file collapse OFF — which is exactly what you want here: you get the run HISTORY
   (each row carrying `status`, `commitSha` and `finishedAt`) rather than one current verdict.
   All-recent-`pass` (or zero runs since a removal) ⇒ not currently failing.

If the file is gone/retired **or** the latest runs are green, this is a **verified non-failure**:
`improvements:resolve { id, outcome:'fixed', summary, testsRun }` citing the file-existence check +
the run-history rows. **Do not** write a regression test — repo policy forbids tests for `_retired/`
surfaces, and there is no live code path to guard.

## Why it re-dispatches

The EI stays `open` (assignee `improvement-runner`) until someone resolves it; the cadence keeps
re-dispatching an open EI. Because the tracked path no longer produces runs, the watchdog won't
newly re-open it — but the **existing** open row must be closed by hand. Resolving it is the whole
job.

## Note on `testing:prune-orphan-runs`

It removes stale `test_runs` rows for known-non-signal paths (`_retired/`, `.papercusp/scratch`,
`*.flakeproof.test.tsx`) and for files gone from a harness's worktree. But a row with
`harness_slug = NULL` (system-recorded gate runs) has **no worktree to existence-check**, so the
tool leaves a plain `<Name>.test.tsx` orphan in place. That's fine — with the file retired, no new
runs are recorded and the flip history freezes; the only required action is resolving the EI.
