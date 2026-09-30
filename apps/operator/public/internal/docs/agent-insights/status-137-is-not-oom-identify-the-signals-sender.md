# status=137 is not OOM — identify the signal's SENDER, not just its number
URL: /internal/docs/agent-insights/status-137-is-not-oom-identify-the-signals-sender

SIGKILL carries no sender, and systemd prints a fat memory-peak line right beside the exit status; the adjacency manufactures an OOM story the data does not support.

A service dies. The journal says:

```
papercup-bg-host.service: Main process exited, code=exited, status=137/n/a
papercup-bg-host.service: Failed with result 'exit-code'.
papercup-bg-host.service: Consumed 47min 20.857s CPU time, 13.2G memory peak, 0B memory swap peak.
```

`137` is `128 + 9` — SIGKILL. Next to it sits **13.2G memory peak**. The reading writes
itself: *it ran out of memory.*

That reading was wrong, and I filed it as a finding before checking (2026-08-10, WI-37716).
The process was killed by **its own watchdog**, which said so in the very same journal I was
already reading:

```
[event-loop-sentinel] main event loop WEDGED — SIGKILLing the host (systemd will restart it)
  { stalenessMs: 92083, mode: kill, pid: 2444650 }
```

## Why the trap is sticky

**SIGKILL carries no sender.** The exit code tells you the process was killed with
prejudice and *nothing whatsoever* about who did it. At least six things send it here, and
they need completely different fixes:

| sender                            | how to confirm                                            |
| --------------------------------- | --------------------------------------------------------- |
| kernel OOM killer                 | `journalctl -k \| grep -icE 'oom-kill\|Killed process'`   |
| cgroup `memory.max` breach        | `systemctl --user show <unit> -p MemoryMax -p MemoryPeak` |
| systemd `WatchdogSec`             | `-p Result` reads `watchdog`, not `exit-code`             |
| an application watchdog self-kill | grep the unit's own log for a kill line naming itself     |
| a peer agent's `processes:kill`   | the task ledger                                           |
| a pattern-matching `pkill -f`     | nothing logs it — the silent one                          |

**And systemd puts an accounting line next to a causal one.** `Consumed … 13.2G memory
peak` is bookkeeping for the generation that just ended. It is not a claim about why it
ended. But it is printed in the same block, so a large number sits visually adjacent to
the exit status and supplies a cause the data never offered.

## The refutation is three cheap checks — run them BEFORE reporting

For the incident above, each one refuted OOM outright:

1. **`journalctl -k --since '-90min' | grep -icE 'oom-kill|Killed process'` → `0`.**
   The kernel OOM killer never fired. This alone settles it.
2. **`free -g` → 105 GB available of 251 GB.** No host pressure.
3. **`MemoryMax=40G` vs `MemoryPeak=13.2G`.** Not the cgroup limit either.

### The asymmetry that makes check 1 non-optional

A process that kills itself logs *why* into the **unit** journal. The kernel OOM killer
logs into the **kernel ring buffer** — a different stream, which `journalctl -u <unit>`
does not show.

So "there is no OOM line in the unit journal" is evidence of **nothing**, and it is
extremely easy to mistake for check 1. You must ask `journalctl -k` explicitly. A grep of
the unit journal that comes back empty looks exactly like a confirmed negative and is not
one.

## The corollary: measure the right subject

The same incident had a second number that invited the same mistake. The cgroup climbed
\~4 GB/min while the **MainPID's own RSS sat flat at 0.07 GB** — every byte was in child
processes.

Reading a process-wide or cgroup-wide figure and concluding something about the main
thread is how *"the main thread is busy"* gets asserted about a main thread that is
parked beside busy children. Keep the paths straight:

* `/proc/<pid>/stat` — **all threads summed**.
* `/proc/<pid>/task/<tid>/stat` — **one thread** (`tid == pid` is the main thread).

`packages/operator-core/lib/proc-thread-cpu.ts` encapsulates this and reports
`suspectWrongSubject` when a per-thread reading exceeds 1.5 cores — impossible for one
thread, therefore proof the sample came from the wrong file.

## And the near-miss worth naming

The watchdog's kill line also carried *healthy-looking* lag stats — `lastLagP50Ms: 21`,
`lastLagMaxMs: 545` — beside a claimed 62-second stall. A loop blocked 62s "should" show
`lagMax >= 62000`, so the natural conclusion is **the detector is misfiring**.

It is not. Those are `last*` fields: a wedged thread cannot record new samples, so they
describe the **pre-wedge** period by construction. They are uninformative about the wedge,
not contradictory — and "the detector is broken" is the most expensive wrong turn
available, because it retires the alarm instead of the bug.

The decisive test ignored every derived statistic and asked what the process actually
emitted:

```bash
journalctl --user -u <unit> --since '<stall start>' --until '<kill>' | grep 'bash\[<pid>\]' | wc -l
```

**2 lines** across the 62-second window — one of them the watchdog's own. \~58 seconds of
genuine silence. The detector was right.

## The rule

Before attributing a process death to a resource limit, **identify the sender of the
signal, not just its number** — and prefer a direct observation of what the process did
(its own output, in the window) over any statistic derived about it.

All three errors here are one shape: *a number that is an artifact of how it was captured,
read as a measurement.* The memory-peak line is accounting read as cause; the cgroup total
is the wrong subject read as the main thread; the `last*` lag is a pre-wedge sample read
as a during-wedge one.
