#!/usr/bin/env python3
"""Analyze a sidecar-idle-soak.sh run.log (plan agent-capacity-and-cost-gcp-2026-09-30).

Moved in-tree from .papercusp/scratch/p532f/analyze.py by WI-10006497.

Usage: python3 sidecar-idle-analyze.py <run.log>

Measurement only. It prints:
  1. run markers and tenant installs (TENANT_RESULT)
  2. WI-10005481 / WI-10005586: per-tenant listener ownership for the four fixed loopback
     services (gateway, MCP proxy, mobile voice, desktop voice), from each PORTS block
  3. WI-10005630 / P-532: per-tenant sidecar idle exit, whether it stayed down, and why any
     respawn happened (real embed vs probe/sweep), from the CENSUS blocks
  4. WI-10006420: env-switcher operators on the headless Server, from ENV_OPERATORS_VERDICT
  5. WI-10006479: the D-051 deferred-resolve fix on a real artifact, meaning the run stopped
     early because every tenant idle-exited, and no sidecar came back without a real embed
  6. memory: tenant cgroup memory.current / anon with the sidecar down, vs the P-011 in-process
     control (D-045: idle-unload OFF, settled, mean 3.24 GiB memory.current). The saved-GiB
     figure feeds cost-model.ts --p532-saved-gib.

Verdict words: PASS / FAIL / NOT_OBSERVED (no evidence either way). It never prints PASS for a
check whose input lines are absent. Each verdict is also printed as one machine-readable line:
  ANALYZE_VERDICT key=<key> verdict=<PASS|FAIL|NOT_OBSERVED> [detail=<...>]
"""
import os
import re
import sys
from collections import defaultdict

P011_CONTROL_CUR_GIB = 3.24  # D-045, idle-unload OFF, settled 60 min, tenant memory.current mean

# packages/operator-core/lib/process-supervision/tenant-loopback-port.ts
SERVICES = [
    ("gateway", 8788, 23800, 1000),
    ("mcp-proxy", 9071, 24800, 1000),
    ("mobile-voice", 3068, 25800, 1000),
    ("desktop-voice", 3076, 26800, 1000),
]

MARKERS = (
    "CREATE_START", "CREATE_FAILED", "SSH_READY", "SCP_FAILED", "SEED_STAGE_FAILED", "UPLOAD_FAILED",
    "OBSERVE_START", "OBSERVE_END", "EARLY_STOP", "STABLE_IDLE", "TEARDOWN_START", "SOAK_DONE",
    # P-532c/f scratch-driver names, so the historical logs still analyze.
    "PULLED", "P532C_DONE", "NO_DEB", "NO_SEED", "NO_TRACE",
)
MARKER_RE = re.compile(r"^(" + "|".join(MARKERS) + r")\b(.*)")
DONE_MARKERS = {"SOAK_DONE", "P532C_DONE"}
RANK = {"FAIL": 3, "PASS": 2, "NOT_OBSERVED": 1, None: 0}


def service_of(port):
    for name, dflt, base, span in SERVICES:
        if port == dflt or base <= port < base + span:
            return name
    return None


def fnum(s):
    try:
        return float(str(s).rstrip("G"))
    except (TypeError, ValueError):
        return None


def inum(s):
    try:
        return int(s or 0)
    except (TypeError, ValueError):
        return 0


def minutes_since(hhmmss, iso_ts):
    """Minutes from a lastReal 'HH:MM:SS' (UTC) to a census ISO timestamp; None if unknown."""
    m1 = re.match(r"^(\d\d):(\d\d):(\d\d)", str(hhmmss or ""))
    m2 = re.search(r"T(\d\d):(\d\d):(\d\d)", str(iso_ts or ""))
    if not (m1 and m2):
        return None
    a = int(m1.group(1)) * 3600 + int(m1.group(2)) * 60 + int(m1.group(3))
    b = int(m2.group(1)) * 3600 + int(m2.group(2)) * 60 + int(m2.group(3))
    return ((b - a) % 86400) / 60.0


def parse(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        lines = fh.read().splitlines()
    out = {"markers": [], "tenant_results": [], "ports": defaultdict(lambda: {"uids": {}, "listeners": []}),
           "census": [], "envops": []}
    block = None
    for ln in lines:
        m = MARKER_RE.match(ln)
        if m:
            out["markers"].append((m.group(1), m.group(2).strip()))
        if ln.startswith("TENANT_RESULT "):
            out["tenant_results"].append(ln)
            continue
        m = re.match(r"^ENV_OPERATORS_VERDICT\s+(.*)", ln)
        if m:
            kv = dict(p.split("=", 1) for p in m.group(1).split() if "=" in p)
            out["envops"].append(kv)
            continue
        m = re.match(r"^#### (\S+) (\S+) (\S+)", ln)
        if m:
            kind, label, ts = m.group(1), m.group(2), m.group(3)
            if kind == "PORTS":
                block = ("ports", label)
            elif kind == "CENSUS":
                block = ("census", label)
                out["census"].append({"label": label, "ts": ts, "tenants": {}})
            else:
                block = None  # ENVOPS and any later block kinds are read through their verdict lines
            continue
        if block and block[0] == "ports":
            m = re.match(r"^UID (\S+)=(\d+)$", ln)
            if m:
                out["ports"][block[1]]["uids"][int(m.group(2))] = m.group(1)
                continue
            m = re.match(r"^(\S+):(\d+) (\S+) pid=(\d+) uid=(\d*)$", ln)
            if m:
                out["ports"][block[1]]["listeners"].append(
                    {"addr": m.group(1), "port": int(m.group(2)), "comm": m.group(3), "pid": int(m.group(4)),
                     "uid": int(m.group(5)) if m.group(5) else None})
                continue
        if block and block[0] == "census" and ln.startswith("TENANT "):
            parts = ln.split()
            if len(parts) >= 2:
                kv = dict(p.split("=", 1) for p in parts[2:] if "=" in p)
                out["census"][-1]["tenants"][parts[1]] = kv
    return out


def ports_report(data):
    print("\n== WI-10005481 (gateway, MCP proxy) / WI-10005586 (voice WS): listener ownership per tenant")
    if not data["ports"]:
        print("  NOT_OBSERVED: no PORTS block in the log")
        return {s[0]: "NOT_OBSERVED" for s in SERVICES}
    verdicts = {}
    for label, blk in data["ports"].items():
        uids = blk["uids"]
        print(f"  [{label}] tenants: " + ", ".join(f"{t}={u}" for u, t in sorted(uids.items())))
        for name, dflt, base, span in SERVICES:
            # Only node listeners; a tenant's embedded postgres picks a random port that can land
            # inside a service range (seen: 23988 in the gateway range).
            rows = [r for r in blk["listeners"] if service_of(r["port"]) == name and r["comm"] != "postgres"]
            per_uid = defaultdict(set)
            port_uids = defaultdict(set)
            for r in rows:
                per_uid[r["uid"]].add(r["port"])
                port_uids[r["port"]].add(r["uid"])
            shared = {p: us for p, us in port_uids.items() if len(us) > 1}
            have = [u for u in uids if per_uid.get(u)]
            missing = [uids[u] for u in uids if not per_uid.get(u)]
            desc = "; ".join(f"{uids.get(u, f'uid{u}')}:{','.join(map(str, sorted(ps)))}"
                             for u, ps in sorted(per_uid.items(), key=lambda x: (x[0] is None, x[0] or 0)))
            if not rows:
                v = "NOT_OBSERVED"
            elif shared or None in per_uid:
                v = "FAIL"
            elif missing:
                v = "FAIL" if have else "NOT_OBSERVED"
            else:
                v = "PASS"
            # Expected range port for non-default holders: base + uid % span (walking forward is allowed).
            notes = []
            for u, ps in per_uid.items():
                for p in ps:
                    if p != dflt and u is not None and p != base + (u % span):
                        notes.append(f"{uids.get(u, u)} on {p} (walked; first choice {base + (u % span)})")
            extra = (" | shared ports: " + str(dict(shared))) if shared else ""
            extra += (" | no listener for: " + ",".join(missing)) if missing and rows else ""
            extra += (" | " + "; ".join(notes)) if notes else ""
            print(f"    {name:13s} {v:12s} {desc}{extra}")
            if RANK[v] > RANK[verdicts.get(name)]:
                verdicts[name] = v
    return verdicts


def sidecar_report(data):
    """Returns (overall verdict, per-tenant memory, count of respawns with no real embed)."""
    print("\n== WI-10005630 / P-532: sidecar idle exit and stays down")
    cen = data["census"]
    if not cen:
        print("  NOT_OBSERVED: no CENSUS block")
        return "NOT_OBSERVED", {}, 0
    tenants = sorted({t for c in cen for t in c["tenants"]})
    verdict_by_t = {}
    mem = {}
    no_real_respawns = 0
    for t in tenants:
        series = [(c["label"], c["ts"], c["tenants"][t]) for c in cen if t in c["tenants"]]
        first_exit = None
        respawns = []
        prev = None
        for label, ts, kv in series:
            ie = inum(kv.get("idleExits"))
            sc = inum(kv.get("sidecarProcs"))
            real = inum(kv.get("realEmbeds"))
            if first_exit is None and ie >= 1:
                first_exit = (label, ts)
            if first_exit is not None and prev is not None and prev["sc"] == 0 and sc > 0:
                why = "real-embed" if real > prev["real"] else "NO-REAL-EMBED"
                respawns.append(f"{label}({why})")
            prev = {"sc": sc, "real": real}
        last = series[-1][2]
        down_rows = [kv for _, _, kv in series
                     if first_exit and kv.get("sidecarProcs") == "0" and inum(kv.get("idleExits")) >= 1]
        up_rows = [kv for _, _, kv in series if inum(kv.get("sidecarProcs")) > 0]
        tail = down_rows[-3:]
        cur_down = [fnum(k.get("curG")) for k in tail if fnum(k.get("curG")) is not None]
        anon_down = [fnum(k.get("anonG")) for k in tail if fnum(k.get("anonG")) is not None]
        cur_up = [fnum(k.get("curG")) for k in up_rows if fnum(k.get("curG")) is not None]
        mem[t] = {
            "cur_down": sum(cur_down) / len(cur_down) if cur_down else None,
            "anon_down": sum(anon_down) / len(anon_down) if anon_down else None,
            "cur_up_max": max(cur_up) if cur_up else None,
            "sidecar_rss": [k.get("sidecarRss") for k in up_rows][-1:] or None,
        }
        bad = [r for r in respawns if "NO-REAL-EMBED" in r]
        no_real_respawns += len(bad)
        idle_min = minutes_since(last.get("lastReal"), series[-1][1])
        up_now = inum(last.get("sidecarProcs")) > 0
        if "idleExits" not in last or "sidecarProcs" not in last:
            v = "NOT_OBSERVED"  # census format without these fields (e.g. P-532b's)
        elif bad:
            v = "FAIL"  # respawned with no real embed: a probe or the empty sweep woke it
        elif up_now and idle_min is not None and idle_min > 7:
            v = "FAIL"  # 5-min idle exit + one census interval of slack has passed
        elif first_exit is None:
            v = "NOT_OBSERVED"  # still within the idle window, or never spawned
        elif up_now:
            v = "NOT_OBSERVED"  # up again after a real embed; re-check the next census
        else:
            v = "PASS"
        verdict_by_t[t] = v
        print(f"  {t}: {v:12s} firstIdleExit={first_exit} respawns={respawns or 'none'} "
              f"last: sidecarProcs={last.get('sidecarProcs')} idleExits={last.get('idleExits')} died={last.get('died')} "
              f"realEmbeds={last.get('realEmbeds')} probes={last.get('probes')} lastReal={last.get('lastReal')}")
    vals = set(verdict_by_t.values())
    overall = "FAIL" if "FAIL" in vals else ("PASS" if vals == {"PASS"} else "NOT_OBSERVED")
    return overall, mem, no_real_respawns


def envops_report(data):
    """WI-10006420: a headless Server must provision no env-switcher operators (dev :3270, :3055, ...)."""
    print("\n== WI-10006420: env-switcher operators on the headless Server")
    rows = data["envops"]
    if not rows:
        print("  NOT_OBSERVED: no ENV_OPERATORS_VERDICT line")
        return "NOT_OBSERVED", "no-lines"
    for kv in rows:
        print(f"  [{kv.get('label', '?')}] verdict={kv.get('verdict', '?')} total={kv.get('total', '?')}")
    seen = [kv.get("verdict") for kv in rows]
    if "present" in seen:
        return "FAIL", "present"
    if all(s == "none" for s in seen):
        return "PASS", "none"
    return "NOT_OBSERVED", "unreadable"


def deferred_resolve_verdict(data, sidecar_verdict, no_real_respawns):
    """WI-10006479: every tenant idle-exited and stayed down (early stop), and no respawn without a real embed."""
    if no_real_respawns:
        return "FAIL", f"respawns-without-real-embed={no_real_respawns}"
    early_all_idle = any(k == "EARLY_STOP" and "all tenants idle-exited" in v for k, v in data["markers"])
    if early_all_idle and sidecar_verdict == "PASS":
        return "PASS", "early-stop-all-idle"
    if sidecar_verdict == "FAIL":
        return "FAIL", "sidecar-up-past-idle-window"
    return "NOT_OBSERVED", "no-all-idle-early-stop" if not early_all_idle else "sidecar-not-pass"


def memory_report(mem):
    print(f"\n== Memory with the sidecar down vs P-011 in-process control ({P011_CONTROL_CUR_GIB} GiB memory.current)")
    downs = []
    for t, m in sorted(mem.items()):
        cd, ad = m["cur_down"], m["anon_down"]
        print(f"  {t}: curG(down, mean of last 3)={cd if cd is None else round(cd, 2)} "
              f"anonG(down)={ad if ad is None else round(ad, 2)} "
              f"curG(up, max)={m['cur_up_max']} lastSidecarRss={m['sidecar_rss']}")
        if cd is not None:
            downs.append(cd)
    if not downs:
        print("  NOT_OBSERVED: no census with the sidecar down after an idle exit")
        return None
    mean_down = sum(downs) / len(downs)
    saved = P011_CONTROL_CUR_GIB - mean_down
    print(f"  mean memory.current with sidecar down: {mean_down:.2f} GiB over {len(downs)} tenants")
    print(f"  saved vs P-011 control: {saved:.2f} GiB per idle Server  ->  "
          f"npx tsx scripts/agent-capacity/cost-model.ts --p532-saved-gib {saved:.2f}")
    print("  caveat: P-011 ran on e2-standard-16; memory.current includes page cache")
    return saved


def emit(key, verdict, detail=None):
    print(f"ANALYZE_VERDICT key={key} verdict={verdict}" + (f" detail={detail}" if detail else ""))


def main(argv):
    if len(argv) != 2:
        print("usage: sidecar-idle-analyze.py <run.log>", file=sys.stderr)
        return 2
    log = argv[1]
    if not os.path.exists(log):
        print(f"NO_LOG {log}")
        return 2
    data = parse(log)
    print("== markers")
    for k, v in data["markers"]:
        if k not in ("STABLE_IDLE", "PULLED"):
            print(f"  {k} {v}")
    print("== tenant installs")
    for ln in data["tenant_results"]:
        print("  " + ln)
    pv = ports_report(data)
    sv, mem, no_real = sidecar_report(data)
    ev, edetail = envops_report(data)
    dv, ddetail = deferred_resolve_verdict(data, sv, no_real)
    saved = memory_report(mem)
    done = any(k in DONE_MARKERS for k, _ in data["markers"])
    print("\n== VERDICTS" + ("" if done else " (RUN NOT FINISHED: provisional)"))
    emit("run-finished", "PASS" if done else "NOT_OBSERVED")
    emit("WI-10005630.sidecar-idle-exit", sv)
    emit("WI-10006479.deferred-resolve", dv, ddetail)
    emit("WI-10006420.env-operators", ev, edetail)
    for name, _, _, _ in SERVICES:
        wi = "WI-10005481" if name in ("gateway", "mcp-proxy") else "WI-10005586"
        emit(f"{wi}.{name}", pv.get(name) or "NOT_OBSERVED")
    print(f"P532_SAVED_GIB {'none' if saved is None else round(saved, 2)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
