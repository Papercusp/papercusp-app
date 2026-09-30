# A load-sensitive flake is not evidence of a timeout — check for a missing happens-before first
URL: /internal/docs/agent-insights/load-sensitive-flake-is-not-always-a-timeout

A test that fails under load and passes in isolation is usually read as \"a fixed timeout got crossed\". Often it is a missing barrier against an ASYNC background producer. Read the actual assertion before touching any timeout.

## The trap

A test fails in a full parallel suite and passes in isolation, with a thin duration
margin (9.5s passing vs 11.2s failing). The near-universal reading — and the one
written into the filed bug (EI-18724820303729937) — is:

> "That is the signature of a fixed timeout being crossed under contention."

It often is not. In that case **every wait in the test was already 10 minutes.** No
timeout was anywhere near being crossed. Acting on the filed hypothesis would have
meant widening 10-minute timeouts and watching the flake continue.

## What it actually was

`substrate-compaction.integration.test.ts` asserts a fresh joiner *sparse-fetches*
(skips history) because the writer has compacted. But the producer appends its
`__snapshot__` **asynchronously — inside a merge pass, on the merge-poll cadence**,
not as part of `append()`. So `writer-done` does **not** imply "compacted".

The test spawned the fresh joiner immediately after `writer-done`, racing that
append. Whichever side won was pure scheduling luck:

* writer wins → snapshot exists → joiner seeds its cursor at it → skips history → pass
* joiner wins → no snapshot found → cursor seeds at 0 → replays the WHOLE log → fail

That is why it correlated with load without being a timeout: contention just changes
who wins a race that was never ordered.

## The tell you can check in one step

**Read the actual assertion text before theorising.** Here it was:

```
AssertionError: expected 4601 to be less than 2300.5
```

A *value* assertion, not a timeout. `4601` was the full log length — the joiner had
downloaded everything. Nothing about that error says "slow"; it says "the thing I
depend on had not happened yet".

Rules of thumb:

* **Timeout flake** → the failure is a timeout/`waitFor` returning null, and the
  limit is genuinely close to the observed duration. Check the limit *first*: if it
  is orders of magnitude above the runtime, it is not your cause.
* **Ordering flake** → the failure is a value/shape assertion about state some
  background producer was supposed to have written. Duration correlates only because
  scheduling does.

Corollary: a run that PASSES *slower* than a previous FAILING run is strong evidence
against the timeout theory. Post-fix, this test passed at 11 571 ms — longer than the
11 244 ms run that had failed.

## The fix shape

Not a longer timeout, and not a `sleep(2000)`. Give the test a real happens-before
edge against the async producer, bounded by a deadline:

* the writer child gained a `wait-snapshot` command that polls its OWN log until the
  snapshot op exists, then answers `{evt:'snapshot-ready', index}`;
* the test blocks on it and asserts `index > 0` **before** spawning the joiner.

Two properties worth copying:

1. **Poll the cheap side.** The barrier polls the producer's own local log, with a
   small tail lookback — a full-history scan each poll would burn CPU and slow the
   very merge pass being awaited.
2. **Bound the child, not just the parent.** The child gives up after
   `snapshotWaitMs` and answers `index: null`, so the parent gets a definitive
   failure with a readable message instead of hanging to its own deadline.

The barrier doubles as the regression guard, and it closed a real hole in the test's
meaning: before it, a run could pass while proving nothing about sparse-fetch at all
(the joiner may simply have folded from 0 and still converged).

## Aside: quarantining would have been wrong

The tempting "it passed on retry" resolution would have left a test that silently
proves nothing whenever it loses the race. The ordering bug was in the test's
assumptions, and fixing it made the assertion mean what it claims.
