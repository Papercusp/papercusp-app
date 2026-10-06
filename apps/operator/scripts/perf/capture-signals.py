#!/usr/bin/env python3
"""Round-4 Lane E — E1 signal-capture harness (host-side leg).

Emits a perf-signals-v1 JSON snapshot of the host-obtainable round-4 signals so
before/after diffs are apples-to-apples. Read-only; changes nothing. Cron-safe.

Coverage NOTE: the host-side signals (loadavg, service CPUWeight/quota, operator
worker CPU%/RSS, :3070 CLOSE_WAIT, :8788 reachability, kopia cap+healthcheck) are
captured directly here and do NOT depend on the (flaky) operator. The MCP-sourced
signals (per-tool p50/p95/call-rate, PG conn active/idle, biggest tables) are NULL
here and must be merged by an agent run of dev:telemetry / dev:pg_health — keyed by
the same `capturedAt`. Lane F (SLO budgets) consumes the perf-signals-v1 schema.

Usage:  python3 capture-signals.py [--label round4] [--out DIR]
Prints the written path on stdout. No shell=True (no injection surface).
"""
import argparse
import json, os, re, shutil, socket, subprocess, sys, time
import urllib.request
from datetime import datetime, timezone

OUT_DIR = os.path.expanduser("~/.papercusp/perf-baselines")
USER_SERVICES = ["papercusp-dev-api", "papercusp-bg-host", "papercusp-staging-api",
                 "papercup-inference-gateway", "kopia-snapshots", "papercusp-vm-mac"]
OPERATOR_CHECKOUT = "papercup-release"   # the :3070 green-main checkout
GATEWAY_PORT = 8788
OPERATOR_PORT = 3070


def run(args):
    """Run argv (no shell) and return stdout; '' on any failure."""
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return ""


def loadavg():
    try:
        a, b, c = open("/proc/loadavg").read().split()[:3]
        return {"l1": float(a), "l5": float(b), "l15": float(c), "cores": os.cpu_count()}
    except Exception:
        return {"l1": None, "l5": None, "l15": None, "cores": os.cpu_count()}


def svc_props(name):
    raw = run(["systemctl", "--user", "show", f"{name}.service",
               "-p", "CPUWeight", "-p", "CPUQuotaPerSecUSec", "-p", "Nice",
               "-p", "ActiveState", "-p", "SubState", "-p", "MainPID"])
    d = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
    return {"cpuWeight": d.get("CPUWeight"), "cpuQuota": d.get("CPUQuotaPerSecUSec"),
            "nice": d.get("Nice"), "active": d.get("ActiveState"),
            "sub": d.get("SubState"), "mainPid": d.get("MainPID")}


CPU_SAMPLE_SEC = 1.0   # two-sample window for the true CPU rate; see operator_workers()


def _proc_cpu_ticks(pid):
    """utime+stime for `pid` in clock ticks, or None if it vanished/is unreadable.

    /proc/<pid>/stat's `comm` field is parenthesised and MAY ITSELF CONTAIN SPACES AND
    PARENS, so a naive .split() misaligns every field after it. Splitting after the LAST
    ')' is the only correct parse. utime/stime are fields 14/15 (1-based); the slice
    below starts at field 3, hence indices 11/12.
    """
    try:
        with open("/proc/%d/stat" % pid, "r") as fh:
            data = fh.read()
    except (IOError, OSError):
        return None
    rp = data.rfind(")")
    if rp < 0:
        return None
    fields = data[rp + 2:].split()
    try:
        return int(fields[11]) + int(fields[12])
    except (IndexError, ValueError):
        return None


def operator_workers():
    # WI-38449 / perf-testing-sweep P-012: the sample MUST cover the worst worker on
    # EACH budgeted axis, because perf-budgets.ts evaluates two independent budgets over
    # this one array (workerCpuPctWarn AND workerRssKbWarn). Ranking by CPU alone made
    # the RSS budget structurally blind: measured 2026-08-16T11:17Z on a 16-worker
    # SO_REUSEPORT cluster, the true worst-RSS worker (pid 3013854, 3,255,500 KB) was not
    # in the CPU top-8, so the capture reported worst RSS 2,806,996 KB — BELOW the
    # 3,000,000 KB warn threshold while the real value was 448,504 KB ABOVE it. A
    # false-OK, not merely an under-report.
    #
    # Fix: rank on both axes and union. Kept bounded (<=8 per axis, so <=16 rows) and
    # deduped by pid. `maxWorkerCpuPct` / `workersOver100Pct` are maxima/counts over this
    # array, and a superset can only make them more correct, never less.
    #
    # P-041 (2026-08-17): the CPU axis carried the SAME class of defect as the RSS axis
    # above — a budget graded by an instrument that cannot report the thing it budgets.
    # `ps -eo pcpu` is a PROCESS-LIFETIME AVERAGE (total CPU / total elapsed), not a
    # current rate, and CLAUDE.md names it explicitly as the probe that "fails toward a
    # false idle". Measured here 2026-08-16T23:43Z: the workers had etimeSec=6934, so
    # every reported cpuPct was an average over ~1h55m. A worker that idled for an hour
    # and is NOW pegged at 400% still reports a low lifetime average, and
    # `workerCpuPctWarn` (200) never fires — the hot-thread budget is structurally unable
    # to see a hot thread. The reading agreed with truth that day (29.9 reported vs 31.0
    # measured) only because this workload happened to be steady; agreement under a
    # steady load is not evidence the instrument works, since that is exactly when a
    # lifetime average and a current rate coincide.
    #
    # CPU usage IS a delta, so we take one: two samples of /proc/<pid>/stat utime+stime
    # over a measured interval, divided by the MEASURED elapsed time (never the nominal
    # sleep). Ranking happens AFTER this, so the top-8-by-CPU selection is itself now
    # ranked on true rates rather than lifetime averages.
    out = run(["ps", "-eo", "pid,pcpu,rss,etimes,args", "--sort=-pcpu"])
    rows = []
    for line in out.splitlines():
        if OPERATOR_CHECKOUT in line and ("node" in line or "hono" in line):
            m = re.match(r"\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.*)", line)
            if m:
                rows.append({"pid": int(m.group(1)), "cpuPct": float(m.group(2)),
                             "rssKb": int(m.group(3)), "etimeSec": int(m.group(4))})

    # Two-sample CPU delta over every discovered worker (small /proc reads, so sampling
    # all of them costs far less than the sleep that separates the samples).
    clk = os.sysconf("SC_CLK_TCK") or 100
    first = dict((r["pid"], _proc_cpu_ticks(r["pid"])) for r in rows)
    t0 = time.monotonic()
    time.sleep(CPU_SAMPLE_SEC)
    elapsed = time.monotonic() - t0
    for r in rows:
        a, b = first.get(r["pid"]), _proc_cpu_ticks(r["pid"])
        if a is None or b is None or elapsed <= 0 or b < a:
            # Process vanished mid-sample, or the counter went backwards (pid reuse).
            # Keep the ps lifetime average rather than substituting 0 — a fabricated
            # zero is the false-idle this change exists to remove, and a stale-but-real
            # number degrades honestly where an invented one does not.
            r["cpuPctSource"] = "ps-lifetime-fallback"
        else:
            r["cpuPct"] = round((b - a) / clk / elapsed * 100.0, 1)
            r["cpuPctSource"] = "proc-delta"

    top_by_cpu = sorted(rows, key=lambda r: r["cpuPct"], reverse=True)[:8]
    top_by_rss = sorted(rows, key=lambda r: r["rssKb"], reverse=True)[:8]
    merged, seen = [], set()
    for r in top_by_cpu + top_by_rss:
        if r["pid"] not in seen:
            seen.add(r["pid"])
            merged.append(r)
    return merged


def close_wait(port):
    out = run(["ss", "-tan"])
    n = 0
    for ln in out.splitlines():
        parts = ln.split()
        if len(parts) >= 4 and parts[0] == "CLOSE-WAIT" and parts[3].endswith(f":{port}"):
            n += 1
    return n


def tcp_reachable(port, host="127.0.0.1", timeout=2.0):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def event_loop_lag(port=OPERATOR_PORT, host="127.0.0.1", timeout=3.0):
    """Event-loop lag p95/p99/max (ms) + pressure band, from the operator's own
    deep-health probe.

    THE per-thread saturation signal. perf-budgets.ts warns at p95 >= 250ms and
    raises a deploy-BLOCKING `operator-defect` at >= 1000ms — but it reads this key,
    which was hardcoded None, so BOTH branches were unreachable and every snapshot
    reported the metric as simply absent (P-010, perf-testing-sweep-2026-07-27).

    Host-local unauthenticated GET against 127.0.0.1 — the endpoint needs no token
    and this is the same blast radius as tcp_reachable() above.

    Returns None on ANY failure. That is deliberate: an unreadable signal must stay
    UNMEASURED rather than collapse to a 0 that a budget evaluator would score as a
    perfect pass.
    """
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/api/health/deep", timeout=timeout) as resp:
            if resp.status != 200:
                return None
            lag = json.loads(resp.read().decode("utf-8")).get("loopLag")
    except Exception:
        return None
    if not isinstance(lag, dict) or not isinstance(lag.get("p95Ms"), (int, float)):
        return None
    return {
        "lag_p95_ms": lag.get("p95Ms"),
        "lag_p99_ms": lag.get("p99Ms"),
        "lag_max_ms": lag.get("maxMs"),
        "sample_count": lag.get("sampleCount"),
        "window_ms": lag.get("windowMs"),
        "window_mature": lag.get("windowMature"),
        "pressure": lag.get("pressure"),
        "source": f"http://{host}:{port}/api/health/deep",
    }


def kopia():
    q = svc_props("kopia-snapshots")
    hc = run(["systemctl", "--user", "is-failed", "kopia-healthcheck.service"]) or "unknown"
    return {"snapshotCpuQuota": q.get("cpuQuota"), "snapshotCpuWeight": q.get("cpuWeight"),
            "snapshotNice": q.get("nice"), "healthcheckState": hc}


def psi():
    """/proc/pressure/* — kernel Pressure Stall Information. THE host-saturation
    signal on a many-core box: loadavg-absolute lies at 128 cores (see perf-budgets
    header), but psi cpu `some avg60` = %time at least one task STARVED for CPU —
    ratio-free. The 2026-07-10 fs-watch meltdown ran cpu some avg10=96 while every
    naive metric needed interpretation. `full` (all tasks stalled) matters for io/mem."""
    out = {}
    for res in ("cpu", "io", "memory"):
        try:
            d = {}
            for ln in open(f"/proc/pressure/{res}"):
                parts = ln.split()
                kind = parts[0]  # some | full
                vals = dict(p.split("=") for p in parts[1:] if "=" in p)
                d[kind] = {"avg10": float(vals.get("avg10", "nan")),
                           "avg60": float(vals.get("avg60", "nan")),
                           "avg300": float(vals.get("avg300", "nan"))}
            out[res] = d
        except Exception:
            out[res] = None
    return out


def inotify(budget_sec=8.0):
    """Per-uid inotify usage: instances + watches per process, worst offenders,
    kernel limits. The 2026-07-10 meltdown was a silent watch balloon (a recursive
    fs.watch → 94.5k watches × 16 workers); nothing surfaced it before the host
    starved, so agents only saw the symptom (loadavg 1100), never the cause.
    /proc/<pid>/fd is only readable for our own uid — exactly the scope the
    per-uid kernel limits apply to. Bounded by budget_sec; partial=True if hit."""
    deadline = time.monotonic() + budget_sec
    total_inst = total_watch = scanned = 0
    per_proc = []
    partial = False
    try:
        pids = [p for p in os.listdir("/proc") if p.isdigit()]
    except Exception:
        pids = []
    for pid in pids:
        if time.monotonic() > deadline:
            partial = True
            break
        fd_dir = f"/proc/{pid}/fd"
        try:
            fds = os.listdir(fd_dir)
        except Exception:
            continue  # other-uid / vanished
        scanned += 1
        inst = watches = 0
        for fd in fds:
            try:
                if os.readlink(f"{fd_dir}/{fd}") != "anon_inode:inotify":
                    continue
                inst += 1
                with open(f"/proc/{pid}/fdinfo/{fd}") as f:
                    watches += sum(1 for ln in f if ln.startswith("inotify"))
            except Exception:
                continue  # fd vanished mid-scan
        if inst:
            total_inst += inst
            total_watch += watches
            try:
                comm = open(f"/proc/{pid}/comm").read().strip()
            except Exception:
                comm = "?"
            # WI-6538: capture the cgroup so the budget evaluator can tell OUR processes
            # apart from third-party ones. Without it the per-process watch budget warns on
            # whatever holds the most watches host-wide — which on a dev box is the editor
            # (VS Code was found holding 38,937), i.e. a permanent un-actionable amber that
            # trains everyone to ignore perf warnings. cgroup is the principled
            # discriminator here because our own services are confined to papercup-*
            # systemd units and the kernel accounts for every descendant of those roots.
            # Only read for processes that actually hold inotify instances (a few dozen),
            # so this stays cheap.
            try:
                cgroup = open(f"/proc/{pid}/cgroup").read().strip()
            except Exception:
                cgroup = ""
            per_proc.append({"pid": int(pid), "comm": comm, "instances": inst,
                             "watches": watches, "cgroup": cgroup})
    per_proc.sort(key=lambda r: -r["watches"])

    def sysctl_int(name):
        try:
            return int(open(f"/proc/sys/fs/inotify/{name}").read())
        except Exception:
            return None

    return {
        "totalInstances": total_inst,
        "totalWatches": total_watch,
        "maxPerProcess": per_proc[0] if per_proc else None,
        # WI-6538: widened 5 -> 20 so the budget evaluator can reliably find the worst
        # PAPERCUSP-OWNED holder. With only 5, a run where several third-party processes
        # out-watch ours would push ours off the list and silently read as "we hold none".
        # Only a few dozen processes hold inotify instances at all, so 20 is effectively
        # the whole population.
        "topProcs": per_proc[:20],
        "scannedProcs": scanned,
        "partial": partial,
        "limits": {"maxUserWatches": sysctl_int("max_user_watches"),
                   "maxUserInstances": sysctl_int("max_user_instances")},
    }


def session_dirs():
    """Per-session dir populations (session-db-archive-retire-dirs P-007):
    after archive-at-death lands these are capped ~ live-session count; a
    rebound means the exit-hook / hourly reconciler stopped archiving — the
    exact population the 2026-07-10 fs-watch meltdown grew on."""
    home = os.path.expanduser("~")

    def count(p):
        try:
            with os.scandir(p) as it:
                return sum(1 for e in it if e.is_dir(follow_symlinks=False))
        except Exception:
            return None

    return {
        "claudeOwnerDirs": count(os.path.join(home, ".papercusp", "session-claude")),
        "codexHomes": count(os.path.join(home, ".papercusp", "su-codex-homes")),
    }


def _process_identity(pid, proc_root="/proc"):
    """Bounded, privacy-conscious identity for a direct cgroup process.

    Incident scopes can disappear seconds after a capture. Preserve enough of
    the process identity in the same snapshot to diagnose that event later,
    without copying arbitrary command arguments (which may contain prompts or
    credentials). argvPreview therefore keeps argv[0], flag NAMES (never
    ``--flag=value`` values), and existing script paths; inline ``-e``/``-c``
    payloads and free-form arguments are deliberately omitted.
    """
    base = os.path.join(proc_root, str(pid))
    try:
        status = {}
        with open(os.path.join(base, "status")) as f:
            for line in f:
                key, _, value = line.partition(":")
                if key in ("State", "VmRSS", "VmSwap"):
                    status[key] = value.strip()
        with open(os.path.join(base, "comm")) as f:
            comm = f.read().strip()[:80]
        try:
            exe = os.readlink(os.path.join(base, "exe"))[:240]
        except Exception:
            exe = None
        try:
            with open(os.path.join(base, "cmdline"), "rb") as f:
                argv = [part.decode("utf-8", "replace")
                        for part in f.read(4096).split(b"\0") if part]
        except Exception:
            argv = []

        preview = []
        truncated = False
        for index, arg in enumerate(argv):
            if len(preview) >= 3:
                truncated = True
                break
            if index == 0:
                # Chromium/Electron and a few process-title setters rewrite
                # argv[0] into one space-delimited string containing all their
                # valued flags. Treat only its first token as executable
                # identity; `exe` above retains the exact executable path.
                executable_token = arg.split(None, 1)[0] if arg else ""
                preview.append(executable_token[:240])
                truncated = truncated or executable_token != arg or len(executable_token) > 240
                continue
            if arg in ("-e", "--eval", "-c", "--command"):
                preview.append(arg)
                truncated = True
                break
            if arg.startswith("-"):
                flag = arg.split("=", 1)[0]
                preview.append(flag[:120])
                truncated = truncated or "=" in arg or len(flag) > 120
                continue
            if os.path.exists(arg):
                preview.append(arg[:240])
                truncated = truncated or len(arg) > 240
                continue
            # Never persist a free-form positional argument. It may be a user
            # prompt, an inline query, or a credential passed without a flag.
            truncated = True
            break

        def kib(field):
            raw = status.get(field, "")
            match = re.match(r"(\d+)\s+kB$", raw)
            return int(match.group(1)) * 1024 if match else None

        return {
            "pid": pid,
            "comm": comm,
            "exe": exe,
            "state": status.get("State"),
            "rssBytes": kib("VmRSS"),
            "swapBytes": kib("VmSwap"),
            "argvPreview": preview,
            "argvTruncated": truncated,
        }
    except Exception:
        # The process may have exited between cgroup.procs and /proc. The
        # caller records the miss explicitly rather than fabricating identity.
        return None


def cgroup_memory(budget_sec=5.0, max_scanned=4096, top_n=40, root=None,
                  proc_root=None, max_processes_per_cgroup=8):
    """Largest cgroup-v2 memory consumers at capture time.

    PSI tells us *that* the host is thrashing, but not which workload owned the
    memory while it happened. Preserve a bounded, host-wide attribution sample
    in the same snapshot so a self-recovered incident remains diagnosable. Values
    are inclusive of child cgroups (the cgroup-v2 accounting contract), therefore
    paths are retained rather than pretending the rows are additive.

    The walk is capped by both wall time and cgroup count. A busy host must never
    make the two-minute capture timer overlap itself just to collect forensics.
    """
    root = root or os.environ.get("PAPERCUSP_PERF_CGROUP_ROOT", "/sys/fs/cgroup")
    proc_root = proc_root or os.environ.get("PAPERCUSP_PERF_PROC_ROOT", "/proc")
    deadline = time.monotonic() + budget_sec
    rows = []
    scanned = 0
    partial = False

    def read_int(path):
        try:
            return int(open(path).read().strip())
        except Exception:
            return None

    try:
        walker = os.walk(root)
        for dirpath, dirnames, _files in walker:
            # Stable traversal makes a capped/partial sample reproducible.
            dirnames.sort()
            if time.monotonic() > deadline or scanned >= max_scanned:
                partial = True
                break
            current = read_int(os.path.join(dirpath, "memory.current"))
            if current is None:
                continue  # not a cgroup-v2 memory accounting node
            scanned += 1
            if current <= 0:
                continue
            stats = {}
            try:
                with open(os.path.join(dirpath, "memory.stat")) as f:
                    for line in f:
                        key, value = line.split(None, 1)
                        if key in ("anon", "file", "shmem", "kernel", "slab", "sock"):
                            stats[key] = int(value)
            except Exception:
                pass
            # EI-21025158485847408 (WI-5471 recurrence class): every field above
            # measures a LEVEL, but the memory alarm fires on PSI — which measures
            # STALLS. Size does not say whether a cgroup is being reclaimed, so a
            # size-ranked capture structurally cannot attribute a reclaim stall,
            # and 13 consecutive investigations of this class closed "offender
            # unresolved" while hunting per-process swap deltas during rare live
            # windows. `memory.events` is the kernel's own monotonic per-cgroup
            # record of exactly that: `high` counts MemoryHigh throttle/reclaim
            # events, `max` counts hard-ceiling hits. Being CUMULATIVE, it
            # preserves evidence that an episode happened even when nobody
            # sampled during it; it does NOT prove that the same cgroup owns a
            # later PSI window. Consumers must label these rows as historical
            # context unless a contemporaneous event delta is also available.
            #
            # BOTH scopes are captured, and the difference is load-bearing:
            #   * `memory.events` is HIERARCHICAL (includes descendants). It is the
            #     ONLY surviving record of a short-lived child that has already
            #     exited — measured here: papercusp.slice reports 553,837 max-hits
            #     and 140 oom-kills whose owning agent scopes are long gone. That is
            #     precisely why per-PID forensics kept concluding "offender
            #     unresolved": the offenders were already dead.
            #   * `memory.events.local` counts only THIS cgroup's own events, so an
            #     ancestor is not credited with its children's stalls. Without it a
            #     throttle ranking is topped by /user.slice — the same useless
            #     coarse-ancestor answer that inclusive memory.current already gives.
            # Rank by local (true ownership); keep hierarchical (retained history).
            def read_events(name):
                out = {}
                try:
                    with open(os.path.join(dirpath, name)) as f:
                        for line in f:
                            key, value = line.split(None, 1)
                            if key in ("high", "max", "oom", "oom_kill"):
                                out[key] = int(value)
                except Exception:
                    pass
                return out

            events = read_events("memory.events")
            events_local = read_events("memory.events.local")
            try:
                with open(os.path.join(dirpath, "cgroup.procs")) as f:
                    pids = [int(line.strip()) for line in f if line.strip().isdigit()]
                direct_pids = len(pids)
            except Exception:
                pids = []
                direct_pids = None
            direct_processes = []
            unresolved_sampled_pids = 0
            for pid in pids[:max_processes_per_cgroup]:
                identity = _process_identity(pid, proc_root=proc_root)
                if identity is None:
                    unresolved_sampled_pids += 1
                else:
                    direct_processes.append(identity)
            relative = os.path.relpath(dirpath, root)
            rows.append({
                "path": "/" if relative == "." else "/" + relative,
                "memoryBytes": current,
                "swapBytes": read_int(os.path.join(dirpath, "memory.swap.current")),
                "anonBytes": stats.get("anon"),
                "fileBytes": stats.get("file"),
                "shmemBytes": stats.get("shmem"),
                "kernelBytes": stats.get("kernel"),
                "slabBytes": stats.get("slab"),
                "sockBytes": stats.get("sock"),
                "directPids": direct_pids,
                "directProcesses": direct_processes,
                "unresolvedSampledPids": unresolved_sampled_pids,
                "directProcessSampleTruncated": len(pids) > max_processes_per_cgroup,
                "throttledHighEvents": events_local.get("high"),
                "throttledMaxEvents": events_local.get("max"),
                "oomEvents": events_local.get("oom"),
                "oomKillEvents": events_local.get("oom_kill"),
                "throttledHighEventsSubtree": events.get("high"),
                "throttledMaxEventsSubtree": events.get("max"),
                "oomKillEventsSubtree": events.get("oom_kill"),
            })
    except Exception:
        partial = True

    rows.sort(key=lambda row: (-row["memoryBytes"], row["path"]))

    # `top` is ranked by SIZE, so truncating it at top_n can discard a
    # small-but-thrashing cgroup entirely — the stall signal would be dropped
    # before any responder ever read it. Rank the throttled cgroups separately
    # so "who has recorded reclaim events" survives the size cap independently
    # of "who is biggest". These are two different questions. Because the event
    # counters are monotonic lifetime totals, this list is a historical lead,
    # not proof of who owns the current PSI window.
    def _events(row, key):
        return row.get(key) or 0

    def _local_total(row):
        return _events(row, "throttledHighEvents") + _events(row, "throttledMaxEvents")

    def _subtree_total(row):
        return _events(row, "throttledHighEventsSubtree") + _events(row, "throttledMaxEventsSubtree")

    throttled = [
        row
        for row in rows
        if _local_total(row)
        or _subtree_total(row)
        or _events(row, "oomKillEvents")
        or _events(row, "oomKillEventsSubtree")
    ]
    # Local events rank FIRST, so a cgroup that actually owns its stalls outranks
    # every ancestor that merely contains one. Subtree-only rows still follow
    # (never lead), because for an exited child they are the only record left.
    throttled.sort(
        key=lambda row: (
            -_local_total(row),
            -_events(row, "oomKillEvents"),
            -_subtree_total(row),
            row["path"],
        )
    )

    return {
        "accounting": "cgroup-v2-inclusive-descendants",
        "top": rows[:top_n],
        "throttled": throttled[:top_n],
        "throttledCgroups": len(throttled),
        "scannedCgroups": scanned,
        "candidateCgroups": len(rows),
        "maxScanned": max_scanned,
        "maxRows": top_n,
        "maxProcessesPerCgroup": max_processes_per_cgroup,
        "budgetSec": budget_sec,
        "partial": partial,
    }


def cgroup_cpu(budget_sec=5.0, max_scanned=4096, top_n=40, root=None,
               sample_sec=CPU_SAMPLE_SEC, usage_reader=None,
               monotonic_fn=time.monotonic, sleep_fn=time.sleep):
    """Bounded two-sample cgroup-v2 CPU ownership attribution.

    ``cpu.stat:usage_usec`` is a cumulative counter for a cgroup and its
    descendants. Sampling the delta (rather than reading ps lifetime averages)
    identifies which workload is consuming CPU during the pressure window. The
    capture is intentionally forensic: it does not add a new threshold or claim
    that the top cgroup caused PSI starvation by itself.

    ``usage_reader``, ``monotonic_fn`` and ``sleep_fn`` are narrow test seams;
    production leaves them unset. A disappearing cgroup, unreadable counter, or
    partial walk is omitted/marked rather than converted into a reassuring zero.
    """
    root = root or os.environ.get("PAPERCUSP_PERF_CGROUP_ROOT", "/sys/fs/cgroup")
    deadline = monotonic_fn() + budget_sec

    def read_usage(dirpath):
        if usage_reader is not None:
            try:
                value = usage_reader(dirpath)
                return int(value) if value is not None else None
            except Exception:
                return None
        try:
            with open(os.path.join(dirpath, "cpu.stat")) as fh:
                for line in fh:
                    key, _, value = line.partition(" ")
                    if key == "usage_usec":
                        return int(value.strip())
        except Exception:
            return None
        return None

    def direct_pids(dirpath):
        try:
            with open(os.path.join(dirpath, "cgroup.procs")) as fh:
                return sum(1 for line in fh if line.strip().isdigit())
        except Exception:
            return None

    def collect():
        rows = {}
        scanned = 0
        partial = False
        try:
            walker = os.walk(root)
            for dirpath, dirnames, _files in walker:
                dirnames.sort()
                if monotonic_fn() > deadline or scanned >= max_scanned:
                    partial = True
                    break
                usage = read_usage(dirpath)
                if usage is None:
                    continue
                scanned += 1
                rows[dirpath] = usage
        except Exception:
            partial = True
        return rows, scanned, partial

    first, first_scanned, first_partial = collect()
    sample_started = monotonic_fn()
    sleep_fn(max(0, sample_sec))
    elapsed = max(0.0, monotonic_fn() - sample_started)
    second, second_scanned, second_partial = collect()

    rows = []
    elapsed_usec = elapsed * 1_000_000
    for dirpath, before in first.items():
        after = second.get(dirpath)
        if after is None or after < before or elapsed_usec <= 0:
            continue
        delta_usec = after - before
        relative = os.path.relpath(dirpath, root)
        rows.append({
            "path": "/" if relative == "." else "/" + relative,
            "cpuUsageUsecDelta": delta_usec,
            "cpuPct": round(delta_usec / elapsed_usec * 100.0, 1),
            "directPids": direct_pids(dirpath),
        })

    rows.sort(key=lambda row: (-row["cpuPct"], row["path"]))
    return {
        "accounting": "cgroup-v2-inclusive-descendants",
        "top": rows[:top_n],
        "scannedCgroups": max(first_scanned, second_scanned),
        "candidateCgroups": len(rows),
        "maxScanned": max_scanned,
        "maxRows": top_n,
        "sampleSec": elapsed,
        "budgetSec": budget_sec,
        "partial": first_partial or second_partial,
    }


def _read_io_stat(dirpath):
    """Sum a cgroup's ``io.stat`` counters across devices; None if unreadable.

    The kernel lists only devices the cgroup has touched, so an EMPTY file is a
    real zero, while a missing or unreadable one returns None (no measurement).
    """
    totals = {"rbytes": 0, "wbytes": 0, "rios": 0, "wios": 0}
    try:
        with open(os.path.join(dirpath, "io.stat")) as fh:
            for line in fh:
                for field in line.split()[1:]:
                    key, _, value = field.partition("=")
                    if key in totals and value.isdigit():
                        totals[key] += int(value)
    except Exception:
        return None
    return totals


def _read_pressure(path):
    """Parse a PSI file (host ``/proc/pressure/*`` or cgroup ``*.pressure``)."""
    out = {}
    try:
        with open(path) as fh:
            for ln in fh:
                parts = ln.split()
                if not parts:
                    continue
                vals = dict(p.split("=", 1) for p in parts[1:] if "=" in p)
                out[parts[0]] = {"avg10": float(vals.get("avg10", "nan")),
                                 "avg60": float(vals.get("avg60", "nan")),
                                 "avg300": float(vals.get("avg300", "nan"))}
    except Exception:
        return None
    return out or None


def cgroup_io(budget_sec=5.0, max_scanned=4096, top_n=40, root=None,
              sample_sec=CPU_SAMPLE_SEC, stat_reader=None,
              monotonic_fn=time.monotonic, sleep_fn=time.sleep):
    """Bounded two-sample cgroup-v2 IO ownership attribution (EI-24438849822675827).

    Host ``/proc/pressure/io`` says the box is IO-stalled but not WHO is writing.
    ``io.stat`` is cumulative per cgroup (inclusive of descendants), so a short
    delta names the cgroups moving bytes during the stall, and each row carries
    that cgroup's own ``io.pressure`` (its tasks' stall share). Forensic only: it
    adds no threshold and does not claim the top writer caused the stall. Writers
    outside any readable cgroup (kernel flushers, journal threads) do not appear
    here — ``dstate_tasks()`` is the complementary view. A counter that went
    backwards (cgroup recreated) is dropped, never reported as a delta.
    """
    root = root or os.environ.get("PAPERCUSP_PERF_CGROUP_ROOT", "/sys/fs/cgroup")
    deadline = monotonic_fn() + budget_sec
    reader = stat_reader or _read_io_stat

    def collect():
        rows, scanned, partial = {}, 0, False
        try:
            for dirpath, dirnames, _files in os.walk(root):
                dirnames.sort()
                if monotonic_fn() > deadline or scanned >= max_scanned:
                    partial = True
                    break
                stat = reader(dirpath)
                if stat is None:
                    continue
                scanned += 1
                rows[dirpath] = stat
        except Exception:
            partial = True
        return rows, scanned, partial

    first, first_scanned, first_partial = collect()
    sample_started = monotonic_fn()
    sleep_fn(max(0, sample_sec))
    elapsed = max(0.0, monotonic_fn() - sample_started)
    second, second_scanned, second_partial = collect()

    rows = []
    if elapsed > 0:
        for dirpath, before in first.items():
            after = second.get(dirpath)
            if after is None:
                continue
            delta = {key: after.get(key, 0) - before.get(key, 0) for key in before}
            if any(value < 0 for value in delta.values()) or not any(delta.values()):
                continue
            relative = os.path.relpath(dirpath, root)
            rows.append({
                "path": "/" if relative == "." else "/" + relative,
                "writeMBps": round(delta["wbytes"] / elapsed / 1e6, 2),
                "readMBps": round(delta["rbytes"] / elapsed / 1e6, 2),
                "writeIops": round(delta["wios"] / elapsed, 1),
                "readIops": round(delta["rios"] / elapsed, 1),
                "ioPressure": _read_pressure(os.path.join(dirpath, "io.pressure")),
            })

    rows.sort(key=lambda row: (-(row["writeMBps"] + row["readMBps"]), row["path"]))
    return {
        "accounting": "cgroup-v2-inclusive-descendants",
        "top": rows[:top_n],
        "scannedCgroups": max(first_scanned, second_scanned),
        "candidateCgroups": len(rows),
        "maxScanned": max_scanned,
        "maxRows": top_n,
        "sampleSec": elapsed,
        "budgetSec": budget_sec,
        "partial": first_partial or second_partial,
    }


_DISKSTATS_SKIP_PREFIXES = ("loop", "ram", "zram")


def _read_diskstats(path):
    """Parse ``/proc/diskstats`` into ``{name: counters}``; None if unreadable.

    Field positions (kernel Documentation/admin-guide/iostats.rst, after the
    major/minor/name columns): reads, reads merged, sectors read, ms reading,
    writes, writes merged, sectors written, ms writing, I/Os in flight, ms doing
    I/O, weighted ms. Sectors are always 512 bytes here regardless of the
    device's logical block size.
    """
    out = {}
    try:
        with open(path) as fh:
            for line in fh:
                parts = line.split()
                if len(parts) < 14 or not all(p.isdigit() for p in parts[3:14]):
                    continue
                v = [int(p) for p in parts[3:14]]
                out[parts[2]] = {
                    "devno": f"{parts[0]}:{parts[1]}",
                    "reads": v[0], "readSectors": v[2], "readMs": v[3],
                    "writes": v[4], "writeSectors": v[6], "writeMs": v[7],
                    "inFlight": v[8], "ioMs": v[9],
                }
    except Exception:
        return None
    return out


def _disk_mounts(disk, sys_block_root, mounts_path):
    """Mountpoints served by ``disk`` or one of its partitions (sorted, deduped)."""
    try:
        partitions = {name for name in os.listdir(os.path.join(sys_block_root, disk))
                      if name.startswith(disk)}
    except Exception:
        partitions = set()
    names = {disk} | partitions
    points = set()
    try:
        with open(mounts_path) as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 2 and parts[0].startswith("/dev/") \
                        and os.path.basename(parts[0]) in names:
                    points.add(parts[1].replace("\\040", " "))
    except Exception:
        pass
    return sorted(points)


def disk_stats(proc_root=None, sys_block_root=None, sample_sec=CPU_SAMPLE_SEC,
               monotonic_fn=time.monotonic, sleep_fn=time.sleep):
    """Two-sample per-DISK IO rates, waits and queue depth (WI-10005308).

    ``cgroup_io()`` names who moved bytes but sums across devices, so an incident
    could not say WHICH disk was stalled (root NVMe vs data NVMe). This samples
    ``/proc/diskstats`` twice over whole disks only (entries listed in
    ``/sys/block``; loop/ram/zram skipped) and reports throughput, IOPS, average
    read/write wait per completed I/O, the in-flight count at the second sample
    and the busy share of the window. Each disk carries its mountpoints because
    NVMe enumeration order is not stable across boots. A counter that went
    backwards (reset/overflow) drops that disk rather than reporting a negative
    rate; an unreadable ``/proc/diskstats`` is reported as unavailable, never as
    an idle box.
    """
    proc_root = proc_root or os.environ.get("PAPERCUSP_PERF_PROC_ROOT", "/proc")
    sys_block_root = sys_block_root or os.environ.get(
        "PAPERCUSP_PERF_SYS_BLOCK_ROOT", "/sys/block")
    stats_path = os.path.join(proc_root, "diskstats")
    mounts_path = os.path.join(proc_root, "mounts")

    first = _read_diskstats(stats_path)
    if first is None:
        return {"available": False, "devices": None}
    started = monotonic_fn()
    sleep_fn(max(0, sample_sec))
    elapsed = max(0.0, monotonic_fn() - started)
    second = _read_diskstats(stats_path)
    if second is None or elapsed <= 0:
        return {"available": False, "devices": None}

    try:
        whole_disks = set(os.listdir(sys_block_root))
    except Exception:
        whole_disks = None   # cannot tell disks from partitions: keep every row

    rows = []
    for name, before in first.items():
        after = second.get(name)
        if after is None or name.startswith(_DISKSTATS_SKIP_PREFIXES):
            continue
        if whole_disks is not None and name not in whole_disks:
            continue
        delta = {key: after[key] - before[key] for key in before if key not in ("devno", "inFlight")}
        if any(value < 0 for value in delta.values()):
            continue
        mounts = _disk_mounts(name, sys_block_root, mounts_path)
        # An unmounted disk that did nothing (idle nbd/virtual devices) is noise;
        # an idle MOUNTED disk stays, because "this disk was quiet" is evidence.
        if not mounts and not after["inFlight"] and not any(delta.values()):
            continue
        rows.append({
            "device": name,
            "devno": after["devno"],
            "mounts": mounts,
            "readMBps": round(delta["readSectors"] * 512 / elapsed / 1e6, 2),
            "writeMBps": round(delta["writeSectors"] * 512 / elapsed / 1e6, 2),
            "readIops": round(delta["reads"] / elapsed, 1),
            "writeIops": round(delta["writes"] / elapsed, 1),
            "readAwaitMs": round(delta["readMs"] / delta["reads"], 2) if delta["reads"] else None,
            "writeAwaitMs": round(delta["writeMs"] / delta["writes"], 2) if delta["writes"] else None,
            "inFlight": after["inFlight"],
            "utilPct": round(min(100.0, delta["ioMs"] / (elapsed * 1000) * 100), 1),
        })
    rows.sort(key=lambda row: (-row["utilPct"], -(row["readMBps"] + row["writeMBps"]), row["device"]))
    return {"available": True, "devices": rows, "sampleSec": elapsed,
            "wholeDisksKnown": whole_disks is not None}


def _dstate_comm_key(comm):
    """Group per-worker kernel threads: ``kworker/u256:3+flush-259:1`` keeps its
    work item (``+flush-259:1`` names the device) but drops the worker id."""
    return re.sub(r"^kworker/[^+]*", "kworker/*", comm)


def dstate_tasks(budget_sec=5.0, max_tasks=200000, top_n=15, proc_root=None,
                 monotonic_fn=time.monotonic):
    """Census of tasks in uninterruptible sleep (state D) at capture time.

    During the 2026-09-27 saturation ~915 tasks sat in D while no user.slice
    cgroup wrote >2 MB/s, so the stalled set (often kernel flushers and journal
    threads) is the evidence cgroup IO alone cannot give. Counts per thread,
    grouped by command, kernel wait channel (wchan) and owning cgroup. Bounded
    by wall time and task count; a cut-off walk is marked ``partial``.
    """
    proc_root = proc_root or os.environ.get("PAPERCUSP_PERF_PROC_ROOT", "/proc")
    deadline = monotonic_fn() + budget_sec
    by_comm, by_wchan, by_cgroup = {}, {}, {}
    scanned = d_count = 0
    partial = False
    try:
        pids = sorted((p for p in os.listdir(proc_root) if p.isdigit()), key=int)
    except Exception:
        return {"available": False, "dStateTasks": None, "partial": True}

    def bump(table, key):
        table[key] = table.get(key, 0) + 1

    for pid in pids:
        if monotonic_fn() > deadline or scanned >= max_tasks:
            partial = True
            break
        task_dir = os.path.join(proc_root, pid, "task")
        try:
            tids = os.listdir(task_dir)
        except Exception:
            continue  # exited between listdir calls
        cgroup = None
        for tid in tids:
            scanned += 1
            try:
                with open(os.path.join(task_dir, tid, "stat")) as fh:
                    raw = fh.read()
            except Exception:
                continue
            close = raw.rfind(")")  # comm may itself contain spaces and parens
            if close < 0 or raw[close + 2:close + 3] != "D":
                continue
            d_count += 1
            bump(by_comm, _dstate_comm_key(raw[raw.find("(") + 1:close]))
            try:
                with open(os.path.join(task_dir, tid, "wchan")) as fh:
                    wchan = fh.read().strip() or "?"
            except Exception:
                wchan = "?"
            bump(by_wchan, wchan)
            if cgroup is None:
                cgroup = "?"
                try:
                    with open(os.path.join(proc_root, pid, "cgroup")) as fh:
                        for line in fh:
                            if line.startswith("0::"):
                                cgroup = line[3:].strip() or "/"
                                break
                except Exception:
                    pass
            bump(by_cgroup, cgroup)

    def top(table, label):
        ranked = sorted(table.items(), key=lambda kv: (-kv[1], kv[0]))[:top_n]
        return [{label: key, "count": count} for key, count in ranked]

    return {
        "available": True,
        "dStateTasks": d_count,
        "scannedTasks": scanned,
        "topComms": top(by_comm, "comm"),
        "topWchans": top(by_wchan, "wchan"),
        "topCgroups": top(by_cgroup, "cgroup"),
        "maxTasks": max_tasks,
        "maxRows": top_n,
        "budgetSec": budget_sec,
        "partial": partial,
    }


IO_PSI_INCIDENT_FULL_AVG10 = 20.0   # host io `full avg10` that marks an IO-stall capture
IO_INCIDENT_MIN_GAP_SEC = 1800       # at most one io-pressure incident copy per 30 min
IO_INCIDENT_RETENTION_SEC = 14 * 86400  # matches perf-budgets INCIDENT_CAPTURE_RETENTION_DAYS


def maybe_preserve_io_incident(host_psi, out_dir, path,
                               threshold=IO_PSI_INCIDENT_FULL_AVG10,
                               min_gap_sec=IO_INCIDENT_MIN_GAP_SEC,
                               retention_sec=IO_INCIDENT_RETENTION_SEC, now_fn=time.time):
    """Keep this capture past rotation when host IO is stalled.

    The infra panel's crit edge (compute.ts -> preserveIncidentCapture) fires on
    CPU/memory pressure, not IO, so an IO-only saturation would rotate out of the
    newest-15 window before anyone looks. ``*-incident-*`` files are exempt from
    that rotation and pruned by age in perf-budgets. Rate-limited so a long stall
    yields one copy per ``min_gap_sec``, not one per 2-minute tick. Returns the
    incident path, or None when not triggered or on any failure (fail-soft).
    """
    try:
        full = ((((host_psi or {}).get("io") or {}).get("full")) or {}).get("avg10")
        if not isinstance(full, (int, float)) or full != full or full < threshold:
            return None
        now = now_fn()
        for name in os.listdir(out_dir):
            if not name.endswith("-incident-io-pressure.json"):
                continue
            existing = os.path.join(out_dir, name)
            age = now - os.path.getmtime(existing)
            if age > retention_sec:
                # perf-budgets prunes *-incident-* only on an infra-crit edge, which an
                # IO-only stall never raises, so this writer bounds its own copies.
                os.remove(existing)
            elif age < min_gap_sec:
                return None
        base = os.path.basename(path)
        stem = base[:-len(".json")] if base.endswith(".json") else base
        dest = os.path.join(out_dir, f"{stem}-incident-io-pressure.json")
        shutil.copyfile(path, dest)
        return dest
    except Exception:
        return None


def host_state(la):
    """stable | loaded | wedge-suspect — pure-local loadavg proxy. An agent run
    should overwrite with the real event-loop-lag verdict when available."""
    if la["l1"] is None or not la["cores"]:
        return "unknown"
    ratio = la["l1"] / la["cores"]
    return "stable" if ratio < 0.7 else "loaded" if ratio < 1.2 else "wedge-suspect"


def argument_parser():
    parser = argparse.ArgumentParser(
        description="Capture host-obtainable perf-signals-v1 metrics."
    )
    parser.add_argument(
        "--label",
        default="adhoc",
        help="label to include in the snapshot filename (default: %(default)s)",
    )
    parser.add_argument(
        "--out",
        default=OUT_DIR,
        help="directory for the snapshot (default: %(default)s)",
    )
    return parser


def main():
    args = argument_parser().parse_args()
    label, out_dir = args.label, args.out
    os.makedirs(out_dir, exist_ok=True)

    la = loadavg()
    ow = operator_workers()
    # Per-thread admission signal (D-010): the hot operator thread, NOT loadavg.
    # maxWorkerCpuPct + event-loop-lag are P-008's admission inputs (su-7b402 reframe).
    max_worker_cpu = max((w["cpuPct"] for w in ow), default=None)
    workers_over_100 = sum(1 for w in ow if w["cpuPct"] >= 100.0)
    snap = {
        "schemaVersion": "perf-signals-v1",
        "capturedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "label": label,
        "capturedBy": "E1 capture-signals.py (host-side leg)",
        "hostState": host_state(la),
        "signals": {
            "loadavg": la,
            "services": {s: svc_props(s) for s in USER_SERVICES},
            "operatorWorkers": ow,
            "maxWorkerCpuPct": max_worker_cpu,
            "workersOver100Pct": workers_over_100,
            "closeWait_3070": close_wait(OPERATOR_PORT),
            "eventLoopLag": event_loop_lag(OPERATOR_PORT),
            "gateway_8788_reachable": tcp_reachable(GATEWAY_PORT),
            "operator_3070_reachable": tcp_reachable(OPERATOR_PORT),
            "kopia": kopia(),
            "psi": (host_psi := psi()),
            "cgroupMemory": cgroup_memory(),
            "cgroupCpu": cgroup_cpu(),
            "cgroupIo": cgroup_io(),
            "diskStats": disk_stats(),
            "dState": dstate_tasks(),
            "inotify": inotify(),
            "sessionDirs": session_dirs(),
            "_mcp_supplemented": {
                "note": "Fill by an agent run keyed to capturedAt; not host-local.",
                "toolLatency": None, "toolCallRate": None,
                "pgConns": None, "tablesTopBytes": None, "eventLoopLag": None,
            },
        },
    }
    path = os.path.join(out_dir, f"{snap['capturedAt'].replace(':', '')}-{label}.json")
    with open(path, "w") as f:
        json.dump(snap, f, indent=2)
    print(path)
    incident = maybe_preserve_io_incident(host_psi, out_dir, path)
    if incident:
        print(incident)


if __name__ == "__main__":
    main()
