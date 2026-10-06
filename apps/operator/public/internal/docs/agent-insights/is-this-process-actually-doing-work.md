# Is this process doing work? Cgroup CPU deltas and PID namespace traps
URL: /internal/docs/agent-insights/is-this-process-actually-doing-work

Use two-sample cgroup CPU deltas, avoid false-idle /proc probes, and interpret liveness readings from PID-namespaced shells and proxied loopback.

## The question this answers

"Is this process actually DOING WORK right now?" — asked of a long job you backgrounded, a
suite that looks wedged, or a session you suspect is spinning.

**Every single-shot CPU probe answers a DIFFERENT question, and each fails toward a false
"idle".** `ps -o %cpu` is a **process-lifetime average**, not an instantaneous rate: measured
at 208% on a VM whose instantaneous load was 200% — right only by coincidence, and badly
wrong for anything whose load has changed. Any first-iteration sampler has no prior sample to
difference against. CPU usage *is* a delta; ask for one.

## The instrument: a two-sample delta over the CGROUP

Measure the whole **process tree**, not the pid you were handed. A service's `MainPID` is
often a **wrapper** sitting at `utime=0` while the real work runs in a child, so measuring it
alone reports "idle" about a process burning a full core.

```bash
# THE INSTRUMENT IS THE CGROUP, NOT A HAND-WALKED TREE. It accounts for EVERY descendant
# at ANY depth (nothing can hide below a walk bound), and usage_usec is a MONOTONIC
# counter -- so the delta is a true rate even as children spawn and exit between samples.
CG=$(sed 's|^0::||' /proc/<pid>/cgroup); F=/sys/fs/cgroup${CG}/cpu.stat
A=$(awk '/^usage_usec/{print $2}' $F); S=$(date +%s.%N); sleep 10
B=$(awk '/^usage_usec/{print $2}' $F); E=$(date +%s.%N)
echo "scale=2;($B-$A)/1000000/($E-$S)" | bc   # cores -- divide by MEASURED elapsed, never the sleep
wc -l < /sys/fs/cgroup${CG}/cgroup.procs      # how many processes that covers
# per-thread: two-sample fields 14-15 over /proc/<pid>/task/*/stat (tid == pid => MAIN thread)
```

Every `capability:bash` / `managedSpawn` job runs in its own systemd scope, so this is the
normal case here — and it is the same no-escape property the task manager relies on
(see [the task manager and the no-escape property](/internal/docs/agent-insights/task-manager-and-the-no-escape-property)).

Divide by the **measured** elapsed time, never by the `sleep` argument: under load the sleep
overshoots, and dividing by the nominal 10s inflates the reported core count.

## The two false-idle traps

**A hand-rolled `/proc` walk reports a confident FALSE IDLE two independent ways, and both
were measured on runs burning a full core.**

1. **A depth-bounded walk.** This repo's own test entrypoint is EIGHT levels deep
   (`bash → npm → sh -c → pc-heavy.sh → affected-tests.mjs → npm → sh -c → node vitest → esbuild`),
   so a 6-generation walk stops at a shell wrapper holding 0 ticks and the sum is dominated by
   processes that are legitimately idle.
2. **One pid's `utime+stime+cutime+cstime`.** The `c*` pair is credited only when a child is
   `wait()`ed on, and *vitest* reaps its own workers while the root reaps nothing until the run
   ends — so a live worker contributes exactly zero.

Reach for the `/proc` tree sum ONLY for a process in no managed scope; if you must, print the
members and confirm the deepest one is the real worker rather than a `sh -c` wrapper.

`top -n1` is usable here, but the two-sample cgroup recipe is still the one to reach for,
because it needs no column-index guess — `%CPU` is field **9** in `-H` output, not 8, and
field 8 is the state column, so misreading it yields a whole column of `S` that looks like data.

## A related trap: a beat emitted BY the process cannot report on its own saturation

A liveness/progress heartbeat emitted by the process being judged cannot report main-thread
saturation. `await` yields to the microtask queue, not the event loop, so a saturated Node main
thread stops every `setInterval`/`setTimeout` while still looking perfectly asynchronous. The
beat goes missing exactly when it is the thing you need. Use a host-side reader such as `processes:list` for liveness; a shell may not share the host PID namespace.

## PID-namespace readings can look like process death

`capability:bash` may run in a separate PID namespace from the operator. A host PID missing from `/proc/<pid>` therefore means it is invisible to that shell's namespace; `ENOENT` does not establish that it exited.

A `cgroup.procs` file containing only `0` means at least one process exists in the cgroup but is invisible in the reader's PID namespace. It does not mean the cgroup is empty, and `0` is not a process ID. `pids.current` counts kernel tasks, including threads, rather than task-manager process rows.

`capability:bash` loopback traffic is proxied. A request to an unused port can return HTTP 502 rather than `ECONNREFUSED` (`curl` exit 7); the 502 comes from the proxy path and proves neither that the target answered nor that it is absent. Do not turn any of these shell readings into a death verdict.

When diagnosing a bash-side probe, report `readlink /proc/self/ns/pid`, the visible numeric /proc PID count, and `$$` in the same call. If `$$` is tiny or only a few PIDs are visible, treat every `/proc/<host-pid>` absence from that call as namespace-blind and discard it; these local readings calibrate the shell but do not prove host absence.

For current host-side liveness, use `processes:list` with an exact `scopeUnit` and `live:true`, and inspect only `live.exactScopeUnitMatches` entries with kind "unaccounted". An empty exact-scope read is not proof. Require a known-present same-kind unaccounted control from an unfiltered live census. Read the control twice and confirm `tasks[].ageSec` advances by elapsed wall time so one transient scan cannot pose as the control.

The live summary uses explicit `Count` and `PidCount` suffixes for numeric values: `live.aliveCount` and `live.unaccountedCount` are numbers, while `live.unaccountedGroups` is the group array. The unfiltered census is usable only when `live.degraded=false`, `live.ownedTruncated=false`, and `live.foreignTruncated=false`; `live.unaccountedCount` must equal `live.unaccountedGroups.length`, and `live.unaccountedPidCount` must equal the PIDs listed in the complete groups. Any missing or inconsistent field leaves absence unknown. On the host, non-zero `pids.current` and the count of `cgroup.procs` entries can corroborate cgroup presence; under the shell namespace, ignore the PID values themselves.

`unaccounted` describes bookkeeping, not abandonment. In particular, `confined:false` does not prove abandonment: a sidecar may legitimately lack a managed owner row. A kill verdict needs positive evidence of abandonment, such as a dead spawner and a stale rig; `unaccounted` alone is insufficient.

Use `dev:listening_ports` when the question is whether a specific host port is bound. A lifecycle candidate's `processLifecycleCandidate.liveness` is a timestamped host observation: `present` means the healthy task-reconcile scan saw it at `observedAt`; it is not proof that the process is present now. `unknown` means no such safe observation was established and does not mean dead.

## It IS burning CPU — now what is it burning it ON?

The instrument above ends at a **rate**. Attributing that rate to **code** is a different
measurement, and on this box every unprivileged path to it is closed in a way that reads as a
policy ceiling when it is not.

The refusal that starts the wrong investigation:

```
$ strace -f -c -p <pid>
strace: attach: ptrace(PTRACE_SEIZE, ...): Operation not permitted
```

`kernel.yama.ptrace_scope` is **1** here — a tracer may attach only to its own descendants, and
a systemd-managed service is nobody's descendant. `perf` is closed too:
`kernel.perf_event_paranoid` is **4**, past the `3` at which unprivileged `perf_event_open` is
already denied outright, so time spent hunting perf flags is time wasted.

**Neither is a policy ceiling.** `sudo -n` is `NOPASSWD: ALL` on this box, so the privileged
form of the same command just works:

```bash
sudo -n timeout 5 strace -f -c -p <pid>   # summarized syscall categories, read-only
```

Measured 2026-09-05 against the live staging Hono (`papercup-staging-api`), seconds after the
unprivileged attach was refused: **1,309 calls summarized in \~3s**, no restart, no config
change. This is the repo guide's general rule — a permission blocker is owner-gated only once
`sudo -n` has ALSO failed — arriving in the one disguise that defeats it: `ptrace: Operation
not permitted` reads as a *kernel security policy* rather than as a privilege you already hold.

`strace` does slow its target, so bound it with `timeout` and prefer staging (`:3170`) over the
green operator (`:3070`) whenever the question can be asked of either.

## ⛔ Do NOT reach for the in-process V8 profiler on a saturated loop

The instinct after a syscall summary is to want **JS frames**, and this repo HAS that machinery:
`captureCpuProfile()` in `packages/operator-core/lib/event-loop-lag-monitor.ts` drives a
`node:inspector` Profiler session and writes a `.cpuprofile`. Pointing it at a CPU-pinned
service re-arms a known outage.

That session's own async `post()`/response must complete **over the same event loop it is
diagnosing**. Under a deeply blocked loop the native binding aborts with `Napi::Error` — a
native abort, NOT a catchable JS exception, so the `try/catch` inside `captureCpuProfile()`
cannot save the process. It crash-looped the green-release operator **8× on 2026-07-10**
(WI-3797, SIGABRT, 60–90s downtime per crash).

So the feature is deliberately **default-OFF** — gated on `opts.profileOnSaturation`, with
`PAPERCUSP_LOOP_PROFILER` kept for tests/dev and never as the production gate — and hard-capped
at `profileMaxP95Ms` (default **3000ms**): a window saturated past that is *skipped*, not
attempted. **It is disabled in precisely the regime you would want it.** A service pinned at
100% CPU is the one case it will never answer, and trying anyway converts a diagnosis into an
incident.

**The out-of-process sampler is correct BECAUSE the loop is blocked.** `sudo -n strace`
observes from the kernel side and cannot be starved by the thing it is measuring — the same
property the heartbeat section above states from the other direction: a signal emitted by the
saturated process goes missing exactly when you need it. Prefer the outside observer for
anything you suspect of saturation, and keep the in-process profiler for chronic, sub-cap lag
on a host you can afford to lose.

## Do not wait on a process-table pattern you typed yourself

`until ! pgrep -f '<pat>'; do sleep 5; done` can NEVER exit from an agent shell: `pgrep -f`
matches the FULL command line, and your own `bash -c` argv contains the literal pattern, so the
poll matches ITSELF. Wait on the PID instead (`tail --pid=<pid> -f /dev/null`, or `kill -0 <pid>`),
or use `node scripts/proc-guard.mjs check <pattern>`, which excludes the caller's own ancestor
chain before matching.
