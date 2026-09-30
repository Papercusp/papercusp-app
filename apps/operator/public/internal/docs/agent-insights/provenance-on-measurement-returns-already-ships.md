# Provenance on measurement returns already ships — extend the surface's own marker, don't add an envelope
URL: /internal/docs/agent-insights/provenance-on-measurement-returns-already-ships

Every measurement surface here already returns freshness/fidelity/ownership attached to its result, under a name adapted to that surface. Before proposing a uniform provenance envelope, read the four existing markers — the usual gap is naming drift, not absence.

## The trap

An agent hits a measurement that misled it — a stale gate red, a coverage count that meant less than it looked, a local test run contaminated by a peer's uncommitted edit — and reaches the same conclusion every time:

> *"No tool bundles provenance as a first-class return type. The raw result is returned bare, so I must issue secondary probe calls to reconstruct context that should have been co-located with the measurement. We should wrap every measurement return in a mandatory envelope: `{measured_at, candidate_commit, commits_behind_head, isolation_verified, current_owner_session, load_suspect}`."*

The diagnosis of the *symptom* is right. The premise is false, and it has been independently re-derived at least twice (most recently EI-20288508326973012, a Scout idea independently graded 4/5).

**Every measurement surface named in that proposal already returns its provenance attached to the result.** Each one uses a name adapted to what can actually go wrong on that surface, which is why a keyword search for `provenance` or `measured_at` finds only some of them and reads as absence.

## What already ships

| failure mode           | the marker that already exists                                                                                                                                                                                                                                                     | where                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| gate verdict staleness | `gateFailingTestsMeasurement()` → `{ failingTests, measured: boolean \| null, provenance: 'measured' \| 'carried' \| 'not-measured' \| 'unknown' }` — `null` means UNKNOWN, never `false`                                                                                          | `operator-core/lib/git-pipeline-stats.ts`                          |
| candidate freshness    | `source: { value, authoritative, why }`; `candidateSource:'run-probe'` is explicitly labelled non-authoritative, and the CRON degradation ("the checkpoint checkout's live HEAD, an inference that can change between two reads") is modelled in the cell's own explanatory string | `operator-core/lib/cell-registrations.ts`                          |
| coverage fidelity      | `fidelity: FidelityMarker` — *"the WEAKEST fidelity present, the honest ceiling on how much this number means"*; *"numeric zero is interpreted only with its population provenance"*                                                                                               | `operator-core/lib/agent-tools/testing/coverage.ts`                |
| run isolation          | `test_runs.worktree_dirty` + `commit_sha` + `source`, stamped per run; the `TEST_FILE_PROVENANCE … uncommitted=N` banner with per-path `[DIRTY]` / `[UNTRACKED]` labels                                                                                                            | `operator-core/lib/testing-run-store.ts`, `scripts/test-files.mjs` |

Related markers in the same family: `stillBrokenCount` vs `stillBrokenNeedsRunCount` (confirmed vs merely presumed broken), `truncatedByLimit` on bounded aggregates, and `_partial` on trimmed tool payloads.

## Why the names differ — and why that is correct

The envelope proposal assumes the fields should be uniform. They are not, because each surface's real failure mode is different, and the adapted marker is **stronger** than the generic one would be:

* A generic `measured_at` timestamp tells you a gate verdict is old. `provenance:'carried'` tells you *it was never measured this tick*, which is the thing that actually misleads you.
* A generic `isolation_verified (pid_count == 1)` would **not** catch the real contamination here. On this shared tree the hazard is a peer's uncommitted edit silently entering your run — `test:file` runs the working tree. Counting PIDs cannot see that; `worktree_dirty` can. The proposed field would have reported a clean isolation on precisely the runs that mislead people.

So the adapted markers are not an inconsistent implementation of the envelope. They are the envelope, specialised — and specialising is what makes them able to answer.

The bet attached to the envelope proposal — *"graders can auto-classify a failure as stale vs real defect without secondary tool calls"* — is already realised. Agents do exactly that today using `worktreeDirty` + `source` + `commit_sha` (see EI-22152577082220678, EI-22185991124277912, EI-22154442583865972, WI-1180462).

## What to do instead

1. **Before proposing an envelope, read the surface's existing marker.** The four above cover the cited cases; the field is rarely called `provenance`.
2. **If a measurement genuinely lacks one, add a field to that surface** — the reuse-first move. Most "this needs provenance" is one more field on an existing return, not a new struct.
3. **Never make a result available bare when its qualifier exists.** That part of the proposal is sound and is already the local convention: `coverage.ts` deliberately keeps the numerator inaccessible without its population provenance.
4. **Do not build a mandatory uniform envelope across the tool catalogue.** It is a large breaking change over \~550 tools that would replace better-adapted markers with weaker generic ones, and it duplicates an existing surface — the top review smell in this repo.

## The one real residue

The genuine cost is not absence, it is **rediscovery**: the pattern has been converged on independently on \~6 surfaces under different names, so each new author reinvents it and each investigating agent re-derives it. That is a discoverability problem with a documentation-shaped fix — this page — not an architecture problem with a refactor-shaped one.

If you find a seventh surface, add its marker to the table above rather than starting a parallel scheme.
