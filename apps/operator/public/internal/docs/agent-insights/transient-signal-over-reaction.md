# Don't over-react to a single transient signal (lock contention, health probes, blinded reads)
URL: /internal/docs/agent-insights/transient-signal-over-reaction

A recurring anti-pattern: code treats ONE transient reading — a single pg-57014 lock timeout, a single 2500ms health-probe timeout, a momentarily-blinded panel — as a hard outage, and skips/fail-opens/alarms on it. Under box load these fire constantly as false positives. The fix recipes (retry-with-backoff, escalating probe, verify/fold) and where NOT to apply them.

## The pattern

Code reads ONE signal and treats a single transient failure as a permanent
outage — then skips a tick, fails open, or fires an OFFLINE alarm. Under box
load (loadavg 30–90), the transient becomes constant and the over-reaction
becomes a flood of false positives that erodes trust in every alarm and stalls
pipelines. Found and fixed **five times** in one session (2026-06-19→20):

| Site                                                      | Bug                                                                                             | Fix                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `harness/improvements/learning-infra-health.ts` (EI-1693) | one 2500ms gateway `/healthz` timeout → "🔴 learning system OFFLINE"                            | escalating-timeout retry                 |
| `system-health/compute.ts` (WI-266)                       | same single-probe gateway false-negative in the rollup                                          | escalating-timeout retry                 |
| `system-health/liveness-alarm.ts` (EI-1695)               | `accounts-starved` BLOCKER fired off a panel read that's BLINDED when the bg engine is frozen   | suppress/fold when the snapshot is stale |
| `harness/git-sync/git-sync-action.ts` (EI-1720)           | one pg-57014 lock-acquire timeout → skip the whole git-sync tick (multi-minute, once 3h, stall) | retry-with-backoff                       |
| `agent-tools/locks/file-lock-guard.ts` (WI-262)           | one pg-57014 → fail-open, silently bypassing the file-lock (concurrent fleet edits race)        | retry-with-backoff                       |

## The recipes

1. **PG-backed lock acquire under transient contention (pg 57014 statement\_timeout
   / 55P03 lock\_timeout).** Use the shared
   `agent-tools/locks/contention-retry.ts` → `acquireWithContentionRetry(run)`
   (backoffs `[500,1500,4000]ms`; `isWorkspaceContended(e)` matches the SQLSTATEs).
   Wrap the `inWorkspaceTxn(...)` acquire. The lock self-recovers once load eases,
   so a few retries ride out the dip instead of skipping/fail-opening on one timeout.

2. **HTTP health probe (e.g. gateway `/healthz`).** Use the shared
   `lib/escalating-http-probe.ts` → `probeHttpReachable(url, {timeouts})` — it
   retries with an ESCALATING, load-aware timeout (`[2500, 6000]ms`) before
   concluding "down" (a process that answers in \<1ms can still miss a single
   2500ms timer under contention). ANY HTTP answer (incl. 503 pacing) = alive;
   only unreachable-on-EVERY-attempt is an outage. Both gateway probes
   (learning-infra-health, system-health/compute) delegate to it — DON'T
   hand-roll a copy; an independent copy is exactly how WI-266 drifted.

3. **An alarm derived from a possibly-blinded read.** If the upstream that
   maintains the state is known-down (e.g. the bg routine engine is frozen → the
   in-engine account/token read is stale), SUPPRESS the derived alarm and fold it
   into the one root-cause signal — don't fire N blockers for one incident.

## Where NOT to apply this (don't blanket-sweep)

* **Interactive `locks:*` tools** (acquire/release/heartbeat from an agent/user
  waiting): they SHOULD fail-fast → the `WorkspaceContendedError` → `busy` result
  is correct. Retrying would make a waiting caller hang.
* **Deliberate fail-open / tolerate-and-reconcile** (work-item claim authority,
  pot federation, D-007): those fail-opens are by-design correctness choices, not
  the bug. Releases that fail-open (the lease drains at TTL) are also fine.

So the audit is per-site judgment: retry only **background/pipeline** acquires
that should ride out load; leave interactive fail-fast and federation fail-open
alone. Open follow-up: the spawn-fire/nursery acquire (zombie cup rows under
contention) — WI-262.

Related: \[\[/agent-insights/native-addon-abi-mismatch-memory-hang]] (the same
"green check over a wedged subsystem" family).
