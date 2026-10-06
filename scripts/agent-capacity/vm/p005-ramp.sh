#!/usr/bin/env bash
# P-005 baseline ramp runner (plan agent-capacity-and-cost-gcp-2026-09-30; method per D-009).
# Runs ON a ramp VM from ~/capacity (scripts + node_modules), replaying the tower corpus that is
# mirrored at ~/.cache/agent-capacity (the load driver's default cache, corpus and prepared repos).
#
#   bash scripts/agent-capacity/vm/p005-ramp.sh <label> <select|all> "<N steps>" [durationSec]
#   e.g. p005-ramp.sh claude-normal cli=claude,profile=light,profile=typical "1 2 4 8 16 32 64" 600
#
# For each N it holds capdrv.slice open, samples it every 5 s with vm/sample-footprint.py, and runs
# load-driver.ts --agents N --duration-sec <durationSec>, so N agents stay busy for the whole window.
# The ramp stops after the first SATURATED step: the driver failed, a session failed or timed out,
# the kernel OOM-killed something in the slice, or the wall slowdown against the recordings passed
# SAT_SLOWDOWN (default 1.5). The step before it is the machine's capacity for this workload.
# It also stops at an UNDERDRIVEN step: the driver's summary says fewer than MIN_DRIVEN (default
# 0.75) x N sessions were running on average once every slot had started, so the step measured the
# driver, not the machine (WI-10004672: with WORKDIR=copy, P-005 held ~13 in flight at N=16/32/64
# on 8 and 32 vCPUs alike). WORKDIR (default overlay) is load-driver.ts --workdir.
#
# Output: ~/.cache/agent-capacity/runs/p005-<label>-n<N>/ (agents.jsonl, summary.json) and
# ~/capacity/fp/p005-<label>-n<N>.{jsonl,driver.log}. Lines to grep: RAMP_*.
set -uo pipefail
cd "$HOME/capacity" || exit 1
LABEL=${1:?usage: p005-ramp.sh <label> <select|all> "<N steps>" [durationSec]}
SELECT=${2:?usage: p005-ramp.sh <label> <select|all> "<N steps>" [durationSec]}
STEPS=${3:?usage: p005-ramp.sh <label> <select|all> "<N steps>" [durationSec]}
DUR=${4:-600}
SAT_SLOWDOWN=${SAT_SLOWDOWN:-1.5}
MIN_DRIVEN=${MIN_DRIVEN:-0.75}
WORKDIR=${WORKDIR:-overlay}
# AGENT_ENV='KEY=VALUE;...' is load-driver.ts --agent-env: variables every session gets (the driver's
# env scrub drops PAPERCUSP_*, so e.g. the hosted tsc-service template must be passed here).
AGENT_ENV=${AGENT_ENV:-}
# PARKED=M (P-015) is load-driver.ts --parked: M extra claude sessions per step that idle mid-session
# on a held reply and all wake together PARK_RELEASE_SEC into the step (default 60% of it).
PARKED=${PARKED:-}
PARK_AT_REQUEST=${PARK_AT_REQUEST:-4}
PARK_RELEASE_SEC=${PARK_RELEASE_SEC:-$((DUR * 6 / 10))}
# PARKED_PER_ACTIVE=R (P-016) replaces the fixed PARKED with round(R x n) parked sessions per step, so
# every step holds the same busy:idle mix (plan D-038: R = (1-b)/b, about 1.9 for the measured fleet).
PARKED_PER_ACTIVE=${PARKED_PER_ACTIVE:-}
if [ -n "$PARKED_PER_ACTIVE" ] && ! [[ "$PARKED_PER_ACTIVE" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "RAMP_ERROR PARKED_PER_ACTIVE must be a non-negative number, got '$PARKED_PER_ACTIVE'"
  exit 2
fi
S="scripts/agent-capacity"
uid=$(id -u)
SLICE=${CAPDRV_SLICE_DIR:-/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/capdrv.slice}
CACHE=${AGENT_CAPACITY_CACHE:-$HOME/.cache/agent-capacity}
FP=$HOME/capacity/fp
mkdir -p "$FP" || exit 1
ts() { date -u +%FT%TZ; }
# A shared tree (WORKDIR=shared) runs no git-sync. A replayed git that is killed mid-write (a session
# hitting its wall limit) therefore leaves .git/index.lock behind, and every later git write in the tree
# fails for the rest of the run (EI-24863025873375990: 25 min on cap-wi5384). Mirror git-sync's
# clearStaleGitLock: unlink the lock once it is STALE_LOCK_SEC old and no git process runs inside the tree.
STALE_LOCK_SEC=${STALE_LOCK_SEC:-90}
LOCK_REAP_SEC=${LOCK_REAP_SEC:-15}
git_in_tree() { # <tree>: is any live git process's cwd inside it?
  local p c
  for p in $(pgrep -x git); do
    c=$(readlink "/proc/$p/cwd" 2>/dev/null) || continue
    case "$c/" in "$1"/*) return 0 ;; esac
  done
  return 1
}
reap_stale_lock() { # <tree> <log>: one reap attempt; a reap appends one line to <log>
  local l="$1/.git/index.lock" m age
  m=$(stat -c %Y "$l" 2>/dev/null) || return 0
  age=$(($(date +%s) - m))
  [ "$age" -ge "$STALE_LOCK_SEC" ] || return 0
  git_in_tree "$1" && return 0
  rm -f "$l" && echo "$(ts) reaped $l age=${age}s" >> "$2"
}
ooms() { awk '$1=="oom_kill"{print $2; f=1} END{if(!f) print 0}' "$SLICE/memory.events" 2>/dev/null || echo 0; }
sel=()
[ "$SELECT" = all ] || sel=(--select "$SELECT")
# TASKS_FILE: the tasks.json the recordings were made from, when it is not the driver's default
# (scripts/agent-capacity/corpus/tasks.json); e.g. the P-019 real-work recordings for P-529.
tasks=()
[ -z "${TASKS_FILE:-}" ] || tasks=(--tasks-file "$TASKS_FILE")
RAMP_ERROR_SEC=${RAMP_ERROR_SEC:-120}

# Preflight: the driver's own validation (import graph, tasks file, corpus, selection, CLI
# versions) with nothing driven. A driver that cannot start must fail here with its real error,
# not read as a saturated first step.
if ! npx tsx "$S/load-driver.ts" --check "${sel[@]}" "${tasks[@]}" --workdir "$WORKDIR" >"$FP/p005-$LABEL.check.log" 2>&1; then
  # The error's own line, not the first line that merely mentions "Error": node/tsx print a source
  # excerpt (`  const err = new Error(message);`) above it, which hid the real cause (WI-10005355).
  why=$(grep -m1 -E '^[[:space:]]*[A-Za-z]*Error( \[[A-Z_]+\])?: |Cannot find' "$FP/p005-$LABEL.check.log" | cut -c1-300)
  echo "RAMP_PREFLIGHT_FAILED $LABEL ${why:-see $FP/p005-$LABEL.check.log} $(ts)"
  exit 3
fi
echo "RAMP_PREFLIGHT_OK $LABEL $(grep -m1 DRIVER_CHECK_OK "$FP/p005-$LABEL.check.log") $(ts)"

for n in $STEPS; do
  run="p005-$LABEL-n$n"
  parked=$PARKED
  [ -z "$PARKED_PER_ACTIVE" ] || parked=$(awk -v r="$PARKED_PER_ACTIVE" -v n="$n" 'BEGIN { printf "%d", r * n + 0.5 }')
  [ "$parked" = 0 ] && parked=''
  systemd-run --user --slice=capdrv.slice --unit="hold-capdrv-$run" --collect sleep 86400 >/dev/null
  python3 "$S/vm/sample-footprint.py" --cgroup "$SLICE" --interval 5 --duration $((DUR + 3600)) \
    --out "$FP/$run.jsonl" --label "$run" >"$FP/$run.log" 2>&1 &
  sampler=$!
  o0=$(ooms)
  echo "RAMP_STEP_START $run n=$n $(ts)"
  [ -z "$parked" ] || echo "RAMP_STEP_PARKED $run parked=$parked release_at_sec=$PARK_RELEASE_SEC"
  t0=$(date +%s)
  reaper=''
  if [ "$WORKDIR" = shared ]; then
    : > "$FP/$run.lock-reaps.log"
    (while :; do reap_stale_lock "$CACHE/prepared/papercusp" "$FP/$run.lock-reaps.log"; sleep "$LOCK_REAP_SEC"; done) &
    reaper=$!
  fi
  npx tsx "$S/load-driver.ts" --agents "$n" --duration-sec "$DUR" --stagger-ms 1000 "${sel[@]}" "${tasks[@]}" \
    --run-id "$run" --isolation systemd --workdir "$WORKDIR" ${AGENT_ENV:+--agent-env "$AGENT_ENV"} \
    ${parked:+--parked "$parked" --park-at-request "$PARK_AT_REQUEST" --release-at-sec "$PARK_RELEASE_SEC"} >"$FP/$run.driver.log" 2>&1
  rc=$?
  [ -z "$reaper" ] || { kill "$reaper" 2>/dev/null; wait "$reaper" 2>/dev/null; }
  # A shared tree keeps every session's edits; record how far it has drifted from its checkout, and
  # how many stale index.locks were reaped (a step with reaps had git writes failing for up to
  # STALE_LOCK_SEC + LOCK_REAP_SEC each, so read its numbers with that in mind).
  [ "$WORKDIR" != shared ] || echo "RAMP_SHARED_TREE run=$run dirty=$(git -C "$CACHE/prepared/papercusp" status --porcelain 2>/dev/null | wc -l) lock_reaps=$(wc -l < "$FP/$run.lock-reaps.log")"
  elapsed=$(($(date +%s) - t0))
  kill "$sampler" 2>/dev/null || true
  systemctl --user stop "hold-capdrv-$run" 2>/dev/null || true
  o1=$(ooms)
  verdict=$(python3 - "$CACHE/runs/$run/summary.json" "$rc" "$((o1 - o0))" "$SAT_SLOWDOWN" "$MIN_DRIVEN" "$elapsed" "$RAMP_ERROR_SEC" <<'PY'
import json, sys
path, rc, oom, limit, min_driven = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
elapsed, error_sec = int(sys.argv[6]), int(sys.argv[7])
try:
    s = json.load(open(path))
except Exception:
    # No summary and no OOM within RAMP_ERROR_SEC: the driver never ran a window, so this step
    # measured nothing about the machine. Only a driver that died later (or with an OOM kill in
    # the slice) is evidence of saturation.
    if oom == 0 and elapsed < error_sec:
        print(f"DRIVER_ERROR reason=no-summary,driver-rc={rc},elapsed={elapsed}s")
    else:
        print(f"SATURATED reason=no-summary,driver-rc={rc}" + (f",oom_kill={oom}" if oom else ""))
    sys.exit()
why = []
if rc != 0:
    why.append(f"driver-rc={rc}")
if s.get("failed"):
    why.append(f"failed={s['failed']}")
if oom > 0:
    why.append(f"oom_kill={oom}")
# load-driver computes wallSlowdown over CLEAN, non-diverged runs only, and emits null when there
# are none (routine in shared-tree mode, where nearly every run diverges). null is "not measured",
# never 0: print it as `na` so it cannot read as "no slowdown", and always print clean=<n> so a
# slowdown resting on a handful of runs is visibly thin (WI-10005448).
slow = s.get("wallSlowdown")
slow_txt = "na" if slow is None else f"{slow:.2f}"
if slow is not None and slow > limit:
    why.append(f"wallSlowdown={slow_txt}")
ac = s.get("achievedConcurrency") or {}
achieved = f"{ac.get('mean')}/{ac.get('target')}" if ac else "unknown"
# A saturation is a real signal even if fewer than N ran; otherwise a step that never held N is no verdict.
if why:
    head = "SATURATED reason=" + ",".join(why)
elif not ac or ac.get("fraction", 0) < min_driven:
    head = f"UNDERDRIVEN achieved={achieved}"
else:
    head = "OK"
print(f"{head} runs={s.get('runs')} clean={s.get('clean', 'na')} wallSlowdown={slow_txt} diverged={s.get('diverged')} toolDiverged={s.get('toolDiverged')} achieved={achieved} setupMsP50={(s.get('setupMs') or {}).get('p50')}")
PY
)
  echo "RAMP_STEP_END $run n=$n rc=$rc $verdict $(ts)"
  case "$verdict" in
    DRIVER_ERROR*) echo "RAMP_DRIVER_ERROR $LABEL n=$n see $FP/$run.driver.log"; exit 3 ;;
    SATURATED*) echo "RAMP_SATURATED $LABEL n=$n"; break ;;
    UNDERDRIVEN*) echo "RAMP_UNDERDRIVEN $LABEL n=$n"; break ;;
  esac
done
echo "RAMP_DONE $LABEL $(ts)"
