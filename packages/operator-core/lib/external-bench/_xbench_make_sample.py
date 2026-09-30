#!/usr/bin/env python3
"""Build the grader sample.jsonl for the bounded hive-vs-ablated comparison.

The eval (swe_bench_pro_eval.py) reads LOWERCASE `fail_to_pass` / `pass_to_pass`
columns and `eval()`s them — they must be STRING-encoded Python lists. The dataset
JSONL carries UPPERCASE FAIL_TO_PASS/PASS_TO_PASS (one a native list, one a string).
We project the chosen instances and add the lowercase eval-able columns with the
CORRECT empty-list encoding ("[]" not "'[]'", so eval() yields [] not the string).
"""
import json, sys, ast

SRC = "/home/dev/.papercusp/bench-harnesses/SWE-bench_Pro-os/helper_code/sweap_eval_full_v2.jsonl"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/xbench-sample.jsonl"
IDS_FILE = sys.argv[2] if len(sys.argv) > 2 else "/tmp/xbench-chosen-ids.txt"

with open(IDS_FILE) as f:
    chosen = [l.strip() for l in f if l.strip()]

def as_list(v):
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        if not v:
            return []
        try:
            r = ast.literal_eval(v)
            return r if isinstance(r, list) else [r]
        except Exception:
            return [v]
    return []

m = {}
with open(SRC) as f:
    for line in f:
        d = json.loads(line)
        m[d["instance_id"]] = d

written = 0
with open(OUT, "w") as out:
    for iid in chosen:
        d = m[iid]
        f2p = as_list(d.get("FAIL_TO_PASS"))
        p2p = as_list(d.get("PASS_TO_PASS"))
        # eval-able string-encoded Python lists (repr → ast.literal_eval round-trips)
        d["fail_to_pass"] = repr(f2p)
        d["pass_to_pass"] = repr(p2p)
        out.write(json.dumps(d) + "\n")
        written += 1
        # sanity: confirm eval() round-trips to a real list
        assert isinstance(ast.literal_eval(d["fail_to_pass"]), list)
        assert isinstance(ast.literal_eval(d["pass_to_pass"]), list)

print(f"wrote {written} instances -> {OUT}")
