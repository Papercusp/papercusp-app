# Host loadavg is not frame starvation — never conclude \"the box was too loaded\"
URL: /internal/docs/agent-insights/host-loadavg-is-not-frame-starvation

A high /proc/loadavg on a shared box is NOT evidence that your containerized frames were starved — loadavg is not cgroup-scoped. Use cgroup-v2 cpu.pressure or the frame's own event-loop-lag instead, and make every failure line say which one it is reporting. Ordinary agents get a host-wide version of the same discrimination for free via coord:orient.

## The trap

A gate/rig scenario fails. The failure line says `load 129.64`. You conclude the box was
too loaded, mark it environmental, and stop.

That conclusion is **not supported by that number**, and it has now cost at least five
investigations (WI-5481, WI-5634, WI-5639, EI-18716933933700596, EI-20495650388693372).

## Why the number cannot mean what you think

`/proc/loadavg` is **not cgroup-scoped or PID-namespace-scoped** in mainline Linux. Read it
from *inside* a container and you still get the **host-wide** figure — regardless of whether
that container has its own reserved cpuset. So one number is returned for two completely
different questions:

* "were **my frames** starved?"
* "were **a hundred unrelated containers** on the shared box busy?"

Loadavg can neither rule frame starvation *in* nor *out*. It is also inflated by **D-state
I/O wait**, which is not CPU contention at all — so a box can read loadavg 130 while every
core your work needs sits idle.

Measured on this dev box (2026-07-26): host loadavg **129.64**, while the rig frames sat at
CPU **8.21% / 2.34%** with frame-scoped `cpu.pressure` some+full avg10/60/300 all **0.00**.
The frames were idle. The load was three unrelated long-lived pgvector containers doing
tens of GB of block I/O. Anyone reading the failure line alone would have blamed the box —
and missed a real regression.

## What to read instead

Two signals ARE genuinely frame-scoped:

1. **cgroup-v2 CPU PSI** — `/sys/fs/cgroup/cpu.pressure` read inside the frame. A nonzero
   `avg10`/`avg60` is the first real evidence of frame-local starvation; an all-zero
   reading **conclusively rules it out**. (`_rd_remote_cpu_pressure` in
   `deb-hetzner-restart.sh`.)
2. **The frame's own event-loop lag** — `[event-loop-lag] … maxMs` in the banked
   `serve-*.log`. A >1s single-threaded stall blows a 30s boot budget on its own.
   (`_frame_lag_scan` / `check_local_matrix_frame_starvation` in `live-federation-gate.sh`.)

A comparison from the same box makes the scale difference obvious: a container's own
`cpu.pressure` read `avg60=0.00 total=161593` against the host's `avg60=0.19
total=49703324973` — three orders of magnitude apart, measuring different things.

## An ordinary agent gets the same discrimination for free — no manual /proc reading needed

The traps above were written for gate/rig scripts that read `/proc` themselves. An agent
just reading `coord:orient`'s ambient `host` block used to have the identical problem one
level up: it carried `load` + `cores` and nothing else, so "`load` exceeds `cores`" was
**unfalsifiable from the payload alone** — it is equally consistent with a genuine CPU
generator (worth hunting) and with a pile of D-state tasks doing no CPU work at all (a
wedge, or slow storage). That gap is exactly what filed EI-20495650388693372: a raw
"128 cores, load \[217.72, 137.62, 122.82]" reading that had to concede in its own body it
was "a raw sensor observation, not a causal diagnosis".

`HostSnapshot` (`packages/operator-core/lib/host-snapshot.ts`, folded into every
`coord:orient`) now carries the mechanism alongside the raw number:

* **`procsRunning` / `procsBlocked`** — the `/proc/stat` run-queue decomposition. A
  CPU-bound burst shows high `procsRunning` and near-zero `procsBlocked`; an I/O-wedged
  host shows the reverse. This is what actually answers "transient parallel build/test
  work, or a wedged workload" — `load` alone cannot.
* **`psiCpuSome60`** — the CPU-PSI stall-time falsifier, the CPU-side twin of the
  pre-existing `psiMemSome60`. It answers "is anything actually STARVED by this load, or
  just queued". Measured live on this host with `load 90.56` against `cores 128`:
  `psiCpuSome60` (some avg60) `1.08`, with `full avg60=0.00` — i.e. **load and real CPU
  saturation were decoupled**, the same disconnect the rig-frame case above measures at
  container scope.

Same durable rule as below, now enforced at the data-model level for the common ambient
case: a reader of `coord:orient` can no longer see `load`/`cores` without also seeing
whether anything is actually running vs. blocked vs. starved on that CPU dimension. (The
memory-pressure companion, `psiMemSome60`, already existed and is the pointer to a
*different*, already-tracked class of incident — chronic memory overcommit / swap
thrashing, e.g. WI-9155 — which a CPU-only detector cannot diagnose and does not claim to.)

## The durable rule for anything that PRINTS a load number

A failure line that names host loadavg **and nothing else** does not merely omit context —
it actively proposes a wrong cause to every future reader. If you emit a load number,
emit the frame-scoped (or, for an ordinary agent, the run-queue/PSI) verdict on the same
line, and say which is which.

`live-federation-gate.sh`'s `frame_pressure_note()` is the worked example. It reports three
states, and the distinction between the last two is the whole point:

* `STARVED` — n/m banked frame logs show `maxMs > 1000ms`.
* `frames NOT starved` — evidence exists and is clean, plus an explicit *"host loadavg is a
  SHARED-BOX aggregate and does not measure these frames — do NOT conclude 'the box was too
  loaded'"*.
* `UNKNOWN` — no frame evidence was banked. **Absence of evidence is reported as unknown,
  never as clean.**

It is built on the *same* scanner the starvation downgrade decides with, so the number a
verdict prints can never disagree with the number it decided on.

## Two traps to avoid when you implement this

**A load-flavoured downgrade can hide a real regression.** The gate downgrades a RED to
`SKIPPED-STORM` on host loadavg alone — a proxy its own comments call weak. That downgrade
was deliberately left in place, but the note now rides the line, so
`SKIPPED-STORM … frames NOT starved` is visibly self-contradicting and tells you the RED may
be genuine. Read the frame-scoped clause before you accept any starvation downgrade.

**A missing shell function reads as `false`.** `local-matrix-starvation.selftest.sh`
`sed`-extracts these helpers from the gate and `eval`s them. When the predicate gained a new
dependency the selftest did not extract, the call failed with `command not found` — which
exits non-zero, which reads as *"not starved"*. Three of its cases silently **degenerated
into passes**; only the two positive cases went red. If you extract shell functions for a
test, name every dependency in the presence guard so a refactor **SKIPs loudly** instead of
quietly weakening coverage.

## In one line

High load is a *finding* — something is generating it, go find out what — but it is never,
on its own, an *explanation* for your failure. As of `HostSnapshot`'s run-queue + CPU-PSI
legs, an ordinary agent reading `coord:orient` has the mechanism to say WHAT KIND of
finding it is, rather than reporting the raw number as weather.
