#!/usr/bin/env bash
# _xbench_su_resume.sh — ROBUST RESUME for the su-independent SWE-bench-Pro run.
#
# Each SWE-bench-Pro task is fully isolated (own clone + own bee), so an infra interruption
# (a peer restarting :3170, a transient gateway blip, a bee crash) only loses the in-flight
# tasks — never the completed ones. This wrapper re-runs ONLY the tasks that don't yet have a
# clean `done` result, in waves, until all 30 are done or MAX_ROUNDS is hit. It reads the
# durable incremental results.jsonl (written by _xbench_su_compare.ts onTaskCollected), so it
# self-heals across launcher deaths without ever re-running an already-done task.
#
# Pin: XBENCH_TIER=opus46 (claude-opus-4-6:xhigh) — the fair same-model comparison vs mini-swe-agent.
set -uo pipefail
REPO="${PAPERCUSP_REPO_ROOT:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)}"
cd "$REPO"

OUT=/tmp/xbench-strat30-su-46v2
SAMPLE="$HOME/.papercusp/bench-results/stratified-30/tasks.jsonl"
SCRIPT="$REPO/packages/operator-core/lib/external-bench/_xbench_su_compare.ts"
CANON=/tmp/_canon30.txt
RESULTS=$OUT/su-independent.results.jsonl
MAX_ROUNDS=${XBENCH_RESUME_ROUNDS:-5}

for round in $(seq 1 "$MAX_ROUNDS"); do
  MISS=$(python3 - "$RESULTS" "$CANON" <<'PY'
import json, sys
results, canon = sys.argv[1], sys.argv[2]
done = set()
try:
    for ln in open(results):
        ln = ln.strip()
        if not ln: continue
        r = json.loads(ln)
        if r.get("stopReason") == "done" and (r.get("diffBytes") or 0) > 0:
            done.add(r["instanceId"])
except FileNotFoundError:
    pass
canon_ids = [l.strip() for l in open(canon) if l.strip()]
miss = [i for i in canon_ids if i not in done]
sys.stderr.write(f"{len(done)} done / {len(canon_ids)} | {len(miss)} missing\n")
print(",".join(miss))
PY
)
  NMISS=$(echo "$MISS" | tr ',' '\n' | grep -c .)
  echo "[resume round $round/$MAX_ROUNDS] $NMISS tasks missing"
  if [ -z "$MISS" ]; then echo "[resume] ALL 30 DONE — exiting"; break; fi

  XBENCH_SAMPLE="$SAMPLE" XBENCH_OUT_DIR="$OUT" XBENCH_CAP=2 XBENCH_TIER=opus46 \
    XBENCH_MAX_USD=50 AGENT_CMD='claude -p' PAPERCUSP_OPERATOR_BASE=http://localhost:3170 \
    XBENCH_ONLY_IIDS="$MISS" \
    npx tsx "$SCRIPT"
  echo "[resume round $round] launcher exited code $? — recomputing missing"
done

echo "[resume] FINAL state:"
python3 - "$RESULTS" "$CANON" <<'PY'
import json, sys
results, canon = sys.argv[1], sys.argv[2]
done = set()
for ln in open(results):
    ln = ln.strip()
    if not ln: continue
    r = json.loads(ln)
    if r.get("stopReason") == "done" and (r.get("diffBytes") or 0) > 0:
        done.add(r["instanceId"])
canon_ids = [l.strip() for l in open(canon) if l.strip()]
miss = [i for i in canon_ids if i not in done]
print(f"  done: {len(done)}/{len(canon_ids)}")
for m in miss: print(f"  STILL MISSING: {m}")
PY
