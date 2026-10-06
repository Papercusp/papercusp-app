#!/usr/bin/env python3
"""Split joined-Server footprint samples by whether an embed-backfill drain overlapped them.

WI-10005107; moved in-tree from .papercusp/scratch/s6soak/backfill-split.py by WI-10006497.

D-022 measured an UNJOINED Server only after the first-boot doc-embed backfill drained. The S6
joined Server never got there (a drain every ~5 min hit its 200 s budget with work remaining), so
the comparable joined number is the samples whose whole interval falls BETWEEN drains. Drain
intervals come from serve.log lines
  '[<iso>Z] [embed-backfill] drain: N round(s) in <S>s ...'  ->  [end - S - 5, end + 5]
(5 s slack each side). Footprint samples are sample-footprint.py JSONL rows carrying
't' (epoch seconds) and 'cg' {cpu_usec, anon, mem}.

Usage: backfill-split.py <fp.jsonl> <serve.log> [from_epoch]
"""
import json
import re
import statistics as st
import sys
from datetime import datetime, timezone

DRAIN_RE = re.compile(r"\[(\S+?)Z\] \[embed-backfill\] drain: \d+ round\(s\) in (\d+)s")
SLACK_SEC = 5.0


def read_drains(log_lines):
    drains = []
    for line in log_lines:
        m = DRAIN_RE.match(line)
        if m:
            end = datetime.fromisoformat(m.group(1)).replace(tzinfo=timezone.utc).timestamp()
            drains.append((end - float(m.group(2)) - SLACK_SEC, end + SLACK_SEC))
    return drains


def read_samples(fp_lines):
    samples = []
    for line in fp_lines:
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        if "cg" in d:
            samples.append(d)
    return samples


def split(samples, drains, t_from=0.0):
    """Bucket each consecutive sample pair into 'idle' or 'drain' as (cores, anonGiB, cgroupGiB)."""
    def overlaps(a, b):
        return any(s < b and a < e for s, e in drains)

    rows = {"idle": [], "drain": []}
    for prev, cur in zip(samples, samples[1:]):
        t0, t1 = prev["t"], cur["t"]
        if t0 < t_from or t1 <= t0:
            continue
        cores = (cur["cg"]["cpu_usec"] - prev["cg"]["cpu_usec"]) / 1e6 / (t1 - t0)
        rows["drain" if overlaps(t0, t1) else "idle"].append(
            (cores, cur["cg"]["anon"] / 2**30, cur["cg"]["mem"] / 2**30))
    return rows


def summarize(rows):
    out = {}
    for k, v in rows.items():
        if not v:
            out[k] = None
            continue
        c = sorted(x[0] for x in v)
        out[k] = {
            "n": len(v),
            "cores_mean": st.mean(c),
            "cores_median": st.median(c),
            "cores_p95": c[min(len(c) - 1, int(0.95 * len(c)))],
            "anon_gib_mean": st.mean(x[1] for x in v),
            "cgroup_gib_mean": st.mean(x[2] for x in v),
        }
    return out


def main(argv):
    if len(argv) < 3:
        print("usage: backfill-split.py <fp.jsonl> <serve.log> [from_epoch]", file=sys.stderr)
        return 2
    fp, log = argv[1], argv[2]
    t_from = float(argv[3]) if len(argv) > 3 else 0.0
    with open(log, errors="replace") as fh:
        drains = read_drains(fh)
    with open(fp) as fh:
        samples = read_samples(fh)
    summary = summarize(split(samples, drains, t_from))
    print(f"drains={len(drains)} samples={len(samples)} from={t_from}")
    for k, s in summary.items():
        if s is None:
            print(k, "n=0")
            continue
        print(f"{k}: n={s['n']} cores mean={s['cores_mean']:.3f} median={s['cores_median']:.3f} "
              f"p95={s['cores_p95']:.3f} anonGiB mean={s['anon_gib_mean']:.2f} "
              f"cgroupGiB mean={s['cgroup_gib_mean']:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
