# `await` is not a yield — an operation that starves the event loop gets its own host restarted, and reads as merely slow
URL: /internal/docs/agent-insights/await-is-not-a-yield-an-operation-that-starves-its-own-host

A loop awaiting promises that resolve in the current tick never reaches the event loop's timer phase, so every setInterval in the process stops. When a watchdog restarts the host on exactly that signal, the operation kills the process it needs to survive — and no timeout on either side can fix it.

## The trap (five failed release cuts, \~1 week of agent time)

`await` yields to the **microtask** queue. It does *not* yield to the event loop.

So this loop — the ordinary shape for reading a log — starves every timer in the process
for its entire duration, while looking perfectly asynchronous:

```ts
for (let start = 0; start < end; start += WINDOW) {
  const blocks = await Promise.all(/* … reads … */);
  for (const b of blocks) fold(b);
}
```

The reads are `await`ed, so the intuition is "this yields." It only does when a read
actually goes to disk *and misses*. A block already resident in the store resolves
**within the current tick**, so the loop drains microtasks forever and the event loop
never reaches its **timer phase**. Every `setInterval` in the process stops: in
`papercup-bg-host` that is the DBOS routines ticker, git-sync, and wake delivery.

## Why it was expensive, and not merely slow

`bghost-watchdog.mjs` restarts `papercup-bg-host` when `MAX(last_fired_at)` across active
routines is more than 240s stale while the unit is active. That is a good freeze signal
and it was working correctly.

But `produceLogSnapshot` *induced* that signal. The snapshot starved the ticker, the
watchdog concluded — correctly — that the ticker was frozen, and restarted the unit,
killing the snapshot. **The operation was killing the process it needed to survive.**

That structure is what made it unfixable from either end:

* a longer client timeout does nothing — the host dies first
* a longer route timeout does nothing — the host dies first
* a more patient watchdog would only trade a real freeze detector for a slow snapshot

Measured 2026-08-09 against the live 461,475-block own log:

|               | pre-fix                               | post-fix                                 |
| ------------- | ------------------------------------- | ---------------------------------------- |
| result        | `http=000` at 455s, connection killed | `http=200` at **114s**, `appended:true`  |
| holder        | **REPLACED** mid-operation            | survived (same MainPID before and after) |
| routine fires | 11:45=4, then **ZERO 11:46–11:54**    | 12:49=6, 12:50=10, 12:51=8, 12:52=10     |
| peak memory   | 20.1GB, SIGABRT                       | 7.0GB                                    |

Watchdog log at the kill:

```
FROZEN -> restarting papercup-bg-host … routine fires 417s stale
AND scheduler (routinesTick) 422s ago (> 240s) while active
```

## The part that makes it masquerade as slowness

A blocked event loop also stalls the **poll** phase — so the loop's *own* I/O cannot
complete either. The starvation was throttling the very reads it was waiting on.

Adding the yield made the read **\~4x faster** (455s and unfinished → 114s and complete).
That is the opposite of what "adding a yield" intuitively costs, and it is why two earlier
fixes both looked like real progress and both died at the identical wall:

1. a bounded read pipeline (the serial `await get(i)` form was RTT-bound)
2. an incremental fold (materialising 461,475 decoded ops peaked at 20.1GB and SIGABRT'd)

Each made the read genuinely leaner. Neither touched the starvation. **When successive
optimisations all fail at the same wall, stop optimising and ask whether the operation is
interfering with its own environment.**

## The fix

One yield per window, at the end of the loop body:

```ts
await new Promise<void>((resolve) => setImmediate(resolve));
```

`setImmediate` runs in the **check** phase, which the loop reaches only after giving
timers their turn. At a 256-block window that is \~1.8k turns for this corpus — negligible
against the read, and it changes nothing about what is folded or in what order.

## The diagnostic — one query settles this whole class

A routine-fire histogram over the operation's window. A **hole** matching the operation's
span is event-loop starvation, not slowness:

```sql
SELECT date_trunc('minute', last_fired_at), count(*)
  FROM harness_shared.routines
 WHERE workspace_id = 'papercusp-workspace'      -- multi-tenant: always scope it
   AND last_fired_at BETWEEN <start> AND <end>
 GROUP BY 1 ORDER BY 1;
```

Slowness leaves the fires intact and just takes longer. Starvation leaves a gap with hard
edges at the operation's start and end.

## Where to look when a host restarts for no visible reason

`papercup-bg-host` logs **nothing** before its stop — it is an external `systemctl
restart`, so the journal shows `Stopping…` / `Stopped` / `Started` with no cause. Reading
the journal alone makes the restart look causeless, which invites inventing one.

**`~/.papercusp/bghost-watchdog.log` is the authoritative record of who restarts it and
why**, including the trigger text and the collateral it killed.

## Two corrections to claims that were circulating

Both pointed work in the wrong direction, and both survived several sessions:

* **"bg-host self-recycles every \~8.5 min" is not unconditional.** The watchdog log shows
  **41 minutes healthy with zero restarts** (10:54:29Z → 11:35:01Z). It recycles on that
  cadence *only while a head-snapshot is in flight*. Every observation of "the cadence" had
  been taken while snapshots were being attempted — the observations were real, the
  generalisation was not.
* **The watchdog was not the thing to change.** It was correctly reporting a real
  9-minute freeze. "Suppress the alarm" would have left a process wedged for minutes at a
  time and called it fixed.

## Testing this property

The guard is `packages/operator-core/lib/sync/hyperbee/__tests__/log-snapshot-event-loop-yield.test.ts`.

The instrument is a `setTimeout(…, 0)` armed *before* the operation: it can only fire from
the timer phase, so whether it lands DURING or AFTER the operation is a direct,
wall-clock-independent read of "did this yield." No sleeps, no timing thresholds, nothing
load-dependent.

Falsifiability follows the repo's tier-1 discipline for an imported module (see
[proving a guard is falsifiable](/internal/docs/system/repo-conventions)): a permanently
resident, deliberately wrong implementation — the pre-fix loop shape — that the same
instrument must report as STARVED. No production code is mutated.

Two things worth knowing before you write one of these:

* **It takes more than one yield to observe.** `setImmediate` resolves in the check phase
  of the *current* iteration, without having passed back through timers, so a single yield
  can land before the armed timer gets a turn. A one-shot calibration measured `after`.
* **A repeating-timer assertion needs a corpus big enough to span real time.** A
  `setInterval(fn, 1)` can only fire once it is *due*; over a sub-millisecond read it
  reports 0 ticks against a perfectly correct implementation. That is a statement about the
  clock, not about yielding — keep the single-shot probe as the primary guard.

## Generalises to

Any long, CPU- or cache-bound loop inside a process that something else is watching for
liveness: log/corestore reads, large in-memory folds, bulk crypto, big JSON parses in a
loop. If a process holds a heartbeat, a scheduler, or a health endpoint, an operation that
monopolises its loop is not just slow — it is *lying about being alive*, and anything
built to notice that will act on it.

Filed: WI-37480 (root cause + fix), WI-36770 (the recycle symptom this explains).
