# A dead-man sampler fed once per pass false-alarms during a legitimately long pass
URL: /internal/docs/agent-insights/replication-liveness-sampling-stale-once-per-pass-heartbeat

replication-liveness's sampling_stale axis (60s) fired for logs that were healthy but merely waiting behind (or being) a single merge pass that legitimately runs longer than the sampler's own dead-man window, because the sampler is fed only once per pass.

## The trap

Two subsystems each had a correct, well-documented design in isolation, and their
interaction was the bug:

1. **`replication-liveness.ts`'s `sampling_stale` axis** is a dead-man switch: if a
   log hasn't been sampled (`sampleReplicationLiveness()`) in `SAMPLING_STALE_AFTER_MS`
   (60s), it assumes the merge loop itself is dead/wedged.
2. **`sampleReplicationLiveness()` is fed exactly ONCE per merge pass**, at the TOP
   of `mergeOnePass` (boot.ts), before the fold body runs.
3. **A single merge pass over one log's backlog is bounded to `maxOpsPerPass`
   (50,000 ops), not to any wall-clock limit.** `mergeAdmittedLogsIncremental`'s
   own docs (read-merge.ts) say plainly that a pass over a large backlog can
   legitimately outlast the 240s bg-host watchdog and never return within that
   window — this is a KNOWN, intentional property of the fold, not a defect.

Put together: a harness that is perfectly healthy — `substrateActive=true`,
`bootedCount=1`, a peer actively replicating a huge (143k-op) log — can still read
`verdict=degraded` because the sampler's 60s dead-man window is an order of
magnitude SHORTER than the fold's own documented legitimate duration. Both the
actively-folding log (`mergeQueueIndex=0`) AND any other admitted log merely
queued behind it (sampled once at pass start, untouched since) go stale for the
whole pass.

Filed as EI-20453145044075727: "VM hello-world substrate replication sampler is
stale while handle remains booted." The escalation explicitly said "must not be
dismissed as load" — and it wasn't load; it was a genuine detector defect, just
not the one it looked like at first (no\_replicator/frozen, the two axes everyone
reaches for first, were both fine).

## Why this is easy to miss

Each half reads correct on its own:

* The dead-man axis doc comment explicitly calls `SAMPLING_STALE_AFTER_MS`
  "not configurable per-sample — it's a property of the READ" and reasons about
  it purely in terms of "the sampler rides the \~1s merge poll" — true in the
  steady-state, small-backlog case, but silently false the moment one log's
  backlog needs a genuinely slow pass.
* The fold's `onCursorAdvance` intra-pass persistence comment explicitly reasons
  about "a large-backlog pass that outlasts the 240s bg-host watchdog" — but that
  reasoning was scoped only to PG-cursor persistence (`pgMergeCursorStore`), never
  cross-referenced against the liveness sampler's OWN, much shorter, 60s window.

Neither file's comments contradict each other; they just never mention each
other, and nothing forced the numbers (60s vs "can outlast 240s") to be compared
side by side.

## The fix

`mergeAdmittedLogsIncremental` already exposes `onCursorAdvance` — it fires
periodically DURING a pass (every `MERGE_PERSIST_EVERY_OPS` = 5,000 ops, and at
the end of each log's fold), carrying the cursor's live per-log positions. That
is exactly the "the merge loop is still alive and making progress" signal the
dead-man axis needs and never had.

Added `touchReplicationLivenessSamples(workspaceId, harnessSlug, keyHexes)` to
replication-liveness.ts: it refreshes `lastSampleMs` ONLY on already-tracked
`LogState` entries, and touches nothing else (`knownLength`/`mergedPosition`/
`peersCount`/etc. are untouched). Wired into boot.ts's `onCursorAdvance`
assembly, unconditionally (previously that hook only existed when
`pgMergeCursorStore` was configured — the heartbeat now fires regardless, with
`persistCursor` still chained only when a PG cursor store exists).

Because the touch only ever moves `lastSampleMs`, it can only clear the
`sampling_stale` false-positive — it structurally cannot mask a genuine
`no_replicator`/`frozen` stall (those are still driven solely by
`sampleReplicationLiveness`'s real per-pass peers/swarm reads), and a genuinely
wedged merge loop (zero `onCursorAdvance` calls) still alarms once
`SAMPLING_STALE_AFTER_MS` elapses past the last real heartbeat.

## The generalizable lesson

When a "hasn't been fed recently → assume dead" dead-man/liveness detector sits
downstream of a producer that is documented to legitimately run long (a bounded-
but-not-time-bounded batch, a backlog drain, anything explicitly designed to
outlast some OTHER watchdog), check whether the producer has an intra-operation
progress hook — and if the detector's own window is shorter than the producer's
documented worst case, that gap IS a live bug, not a hypothetical one. Grep both
sides for their timing constants and compare them directly; a design note that
only reasons about "the steady-state 1Hz case" is the tell that the long-tail
case was never checked against it.
