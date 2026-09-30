# A batch watchdog that already samples progress but decides purely on wall-clock will kill live work
URL: /internal/docs/agent-insights/progress-aware-watchdog-not-wall-clock-only-kill

A task-level watchdog that SIGKILLs on elapsed time alone can kill a task that is demonstrably still emitting output, if the code already samples a progress signal but only reads it AFTER the kill (to word the report) instead of before (to decide whether to kill). Fix: feed the same signal into the kill decision itself — extend on progress, cap at an absolute ceiling.

## The trap

A long-running batch task watchdog (here: the per-task timeout inside
`scripts/affected-tests.mjs`, which runs `@papercusp/operator-core :: test:lane-stateful`
under the green-checkpoint gate) can already have everything it needs to avoid killing
live work, and still kill it — because the progress signal it collects is wired to the
wrong side of the decision.

Concretely: `scripts/lib/batch-watchdog.mjs` already sampled `capturedBytes` from the
child's output stream every 60s and already had a `classifyBatchProgress` function
distinguishing `advancing` from `stalled`. But that classification was only consulted
**after** the SIGKILL fired, to word the failure report ("was it a stall or a timeout?").
The actual kill trigger was a bare `setTimeout` — pure wall-clock, blind to whether the
child was doing anything.

Symptom: `test:lane-stateful` was SIGKILLed at exactly the 2700s floor timeout on two
independent green-checkpoint runs, in both cases with `capturedBytes` still climbing in
the run's own progress samples (e.g. 762,401B\@2340s → 797,873B\@2700s). The task was
alive and completing files — not wedged — and got killed anyway, reding the whole gate
for a non-code reason.

## Why the obvious-looking causes are red herrings

Before the real defect was found, three plausible mechanisms were chased for *why the
task was so slow*: a bimodal test-duration distribution straddling the timeout, an
EWMA duration estimate that settles below the slow mode of a bimodal lane, and a manual
checkpoint-run getting starved scheduler capacity (`shared/2-fork` vs `reserved/8-fork`).
All three may be real and worth fixing on their own terms — but **none of them is the
bug**. Even a task slow for a completely legitimate reason should not be SIGKILLed while
it is still visibly emitting output. Chasing "why is it slow" is a distraction from
"why did we kill something that was alive" — the second question is the one a watchdog
exists to answer correctly, and it doesn't require knowing the first.

## The fix

Make the kill decision itself progress-aware instead of pure wall-clock, with two
safety properties that make it safe to ship in front of a hard gate ceiling:

1. **Monotone** — the new decision must never fire EARLIER than the old time-only
   watchdog would have. A silently-wedged task is still killed at its original deadline.
2. **Bounded** — extensions stop at an absolute ceiling well under the caller's hard
   limit (here `BATCH_TIMEOUT_MAX_MS`, 90m, under the gate's \~120m ceiling). A task that
   chatters just enough to look "advancing" while genuinely wedged still dies at the
   ceiling.

Both properties are unit-tested with two-sided cases: one that fails if the watchdog
ever kills a genuinely-live task again, and one that fails if it ever stops killing a
genuinely-stalled one. See `packages/operator-core/lib/__tests__/batch-watchdog.test.ts`
(`decideWatchdogExpiry` for the pure policy, `createProgressAwareWatchdog` for the
re-arming watchdog with an injected clock/timer so the wiring itself is testable).

## The general lesson

**If your watchdog already samples a liveness/progress signal for its REPORT, check
whether it also feeds the DECISION.** Collecting the evidence and using it are two
different wires, and it is easy to build the first without the second — the collection
looks like it's "already handled" because the symptom (a worded report explaining the
kill) looks complete. Verify the wire, not the presence of the variable.

## How this was closed out (verification methodology note)

The item's own checkpoint set an explicit closing bar: "a green-checkpoint run completes
having killed no live task." Rather than waiting on a single fresh gate run (the gate
runs hourly and can take up to \~90 minutes), the closing pass checked ALL retained
checkpoint logs from the fix's landing forward: `grep -c 'state=watchdog-killed'` was `0`
across 21 consecutive green-checkpoint runs spanning 24+ hours, with the fix's presence
in the earliest of those candidates confirmed by blob (`git show <sha>:path | grep -c <symbol>`) rather than by commit subject or `git blame` (both are unreliable in this repo
— see [repo-conventions](/internal/docs/system/repo-conventions) on git-sync sweep
attribution). A repeated empirical absence across many independent runs is stronger
evidence than a single clean run, and was available for free from logs already on disk.
