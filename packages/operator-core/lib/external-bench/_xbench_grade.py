#!/usr/bin/env python3
"""Grade one arm's collected diffs with the official swe_bench_pro_eval.py (--use_local_docker).

Reads <OUT_DIR>/<arm>.json (perTask + diffs-<arm>/<instance>.diff), builds the predictions JSON
[{instance_id, patch, prefix}], runs the eval over the SAME sample.jsonl, and prints the
per-instance resolved map from eval_results.json. The TS grader (swe-bench-pro.ts) runs this exact
command; we drive it directly here so the grading step is decoupled/resumable from generation.
"""
import json, os, subprocess, sys

OUT_DIR = os.environ.get("XBENCH_OUT_DIR", "/tmp/xbench-compare-out")
SAMPLE = os.environ.get("XBENCH_SAMPLE", "/tmp/xbench-sample.jsonl")
EVAL_DIR = os.environ.get("PAPERCUSP_SWEBENCH_EVAL_DIR", "/home/dev/.papercusp/bench-harnesses/SWE-bench_Pro-os")
PY = os.environ.get("PAPERCUSP_SWEBENCH_PYTHON", os.path.join(EVAL_DIR, ".venv/bin/python"))
WORKERS = os.environ.get("PAPERCUSP_SWEBENCH_NUM_WORKERS", "4")
DOCKERHUB_USER = os.environ.get("PAPERCUSP_SWEBENCH_DOCKERHUB_USER", "jefzda")

arm = sys.argv[1] if len(sys.argv) > 1 else "hive"
arm_json = os.path.join(OUT_DIR, f"{arm}.json")
diffs_dir = os.path.join(OUT_DIR, f"diffs-{arm}")
grade_out = os.path.join(OUT_DIR, f"grade-{arm}")
os.makedirs(grade_out, exist_ok=True)

with open(arm_json) as f:
    arm_data = json.load(f)

# FAIRNESS (benchmark-fairness-fix, Priority 2): OMIT empty-diff / external-or-infra-failed rows from the
# predictions. The grader keys resolved on (FAIL_TO_PASS pass) — for an instance that produced NO real
# submission (empty patch) or whose generation was an EXTERNAL/transient/infra failure (a wall-clock
# timeout, a 429/contention spawn, a drain-unsettled member, a crash), the grader would otherwise apply an
# empty patch and manufacture resolved=false — scoring an unfairly-failed task as a capability fail. We drop
# those rows from predictions instead, so they become resolved=null (no eval_results.json entry) → EXCLUDED
# from the resolved% denominator by the readers (preserved-runs/summarizePreservedRun, _xbench_report,
# run-store), never a fail. Kept in sync with NON_SCORED_STOP_REASONS in types.ts.
NON_SCORED_STOP_REASONS = {"error", "timeout", "infra-failed"}

preds = []
omitted_empty = 0
omitted_infra = 0
for t in arm_data["perTask"]:
    iid = t["instanceId"]
    dp = os.path.join(diffs_dir, f"{iid}.diff")
    patch = ""
    if os.path.exists(dp):
        with open(dp) as df:
            patch = df.read()
    stop_reason = t.get("stopReason")
    gen_error = t.get("generationError")
    if stop_reason in NON_SCORED_STOP_REASONS or gen_error:
        # External/transient/infra failure — never produced a fairly-given submission → exclude (resolved=null).
        omitted_infra += 1
        continue
    if not patch.strip():
        # No real submission for this instance → exclude rather than manufacture a resolved=false.
        omitted_empty += 1
        continue
    preds.append({"instance_id": iid, "patch": patch, "prefix": f"arm-{arm}"})

preds_path = os.path.join(grade_out, "predictions.json")
with open(preds_path, "w") as f:
    json.dump(preds, f)

n_nonempty = sum(1 for p in preds if p["patch"].strip())
print(
    f"[grade] arm={arm} predictions={len(preds)} nonEmptyPatches={n_nonempty} "
    f"omitted(empty-diff={omitted_empty}, infra/transient={omitted_infra}) "
    f"[omitted rows → resolved=null, excluded from resolved%, never a fail]"
)
print(f"[grade] running swe_bench_pro_eval.py over {len(preds)} instances (workers={WORKERS}) ...")

cmd = [
    PY, "swe_bench_pro_eval.py",
    f"--raw_sample_path={SAMPLE}",
    f"--patch_path={preds_path}",
    f"--output_dir={grade_out}/out",
    "--scripts_dir=run_scripts",
    f"--num_workers={WORKERS}",
    f"--dockerhub_username={DOCKERHUB_USER}",
    "--use_local_docker",
]
print("[grade] cmd:", " ".join(cmd))
proc = subprocess.run(cmd, cwd=EVAL_DIR, capture_output=True, text=True)
# Tail of stderr/stdout for diagnostics
print("[grade] eval exit:", proc.returncode)
sys.stdout.write(proc.stdout[-3000:])
if proc.returncode != 0:
    sys.stderr.write(proc.stderr[-3000:])

results_path = os.path.join(grade_out, "out", "eval_results.json")
if os.path.exists(results_path):
    with open(results_path) as f:
        results = json.load(f)
    resolved = sum(1 for v in results.values() if v is True)
    print(f"\n[grade] arm={arm} RESOLVED {resolved}/{len(results)} = {resolved/len(results)*100:.1f}%")
    print(json.dumps(results, indent=2))
    # write a normalized summary
    with open(os.path.join(OUT_DIR, f"resolved-{arm}.json"), "w") as f:
        json.dump({"arm": arm, "resolved": resolved, "total": len(results), "perInstance": results}, f, indent=2)
else:
    print(f"\n[grade] NO eval_results.json at {results_path} — grading produced no verdict")
    sys.exit(2)
