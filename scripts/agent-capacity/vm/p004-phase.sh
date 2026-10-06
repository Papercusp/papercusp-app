#!/usr/bin/env bash
# P-004 calibration phase runner (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10004375).
# Runs ON the calibration VM, from ~/capacity, as the default ssh user (linger enabled).
#
#   bash scripts/agent-capacity/vm/p004-phase.sh n1|n4|n8 [real|replay|both]
#
# real:   records the phase's REAL sessions with record-session.ts --isolation systemd (each in
#         caprec.slice), the CLIs reaching the tower gateway through the reverse tunnel on :8788.
# replay: replays exactly the sessions this phase recorded ON THIS VM with load-driver.ts --sweep
#         (each in capdrv.slice), N at a time.
# Replay uses the PATH captured by the real run: the npx-inherited PATH can differ on this VM and
# has produced a Codex nested-command tool divergence (WI-10004629).
# During each half, vm/sample-footprint.py samples the slice every 5 s for the concurrent time
# series. A placeholder `sleep` unit holds the slice open so the sampler has a cgroup from t=0.
#
# Output: ~/capacity/rec/<phase>/<sessionId>/meta.json (real), ~/capacity/runs/replay-<phase>/
# (replay), ~/capacity/fp/{real,replay}-<phase>.jsonl (time series). Lines to grep: PHASE_*.
#
# P004_CLIS=claude,codex (default) records only the listed CLIs' sessions, so the replay half
# also covers only those. A Codex-only rerun exists because the first calibration's Codex half
# was vacuous: the VM had no working Codex sandbox, so the real sessions ran no tools either
# (plan D-012, WI-10004619), and re-recording Claude would spend inference for nothing.
set -uo pipefail
cd "$HOME/capacity" || exit 1
PHASE=${1:?usage: p004-phase.sh n1|n4|n8 [real|replay|both]}
WHAT=${2:-both}
N=${PHASE#n}
case "$PHASE" in n1|n4|n8) ;; *) echo "PHASE_BAD $PHASE"; exit 2 ;; esac
P004_CLIS=${P004_CLIS:-claude,codex}
[ -n "${P004_CLIS//,/}" ] || { echo "PHASE_BAD_CLIS '$P004_CLIS'"; exit 2; }
for c in ${P004_CLIS//,/ }; do
  case "$c" in claude | codex) ;; *) echo "PHASE_BAD_CLIS '$P004_CLIS'"; exit 2 ;; esac
done
S="scripts/agent-capacity"
uid=$(id -u)
SLROOT=/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service
REC=$HOME/capacity/rec/$PHASE
RUNOUT=$HOME/capacity/runs/replay-$PHASE
FP=$HOME/capacity/fp
mkdir -p "$REC" "$FP" || exit 1
ts() { date -u +%FT%TZ; }

hold() { systemd-run --user --slice="$1" --unit="hold-${1%.slice}-$PHASE" --collect sleep 86400 >/dev/null; }
unhold() { systemctl --user stop "hold-${1%.slice}-$PHASE" 2>/dev/null || true; }
sample_start() { # slice label
  python3 "$S/vm/sample-footprint.py" --cgroup "$SLROOT/$1" --interval 5 --duration 14400 \
    --out "$FP/$2.jsonl" --label "$2" >"$FP/$2.log" 2>&1 &
  echo $! >"$FP/$2.pid"
}
sample_stop() { kill "$(cat "$FP/$1.pid")" 2>/dev/null || true; }
rec() { # cli tasks parallel
  case ",$P004_CLIS," in *",$1,"*) ;; *) echo "PHASE_REC_SKIPPED $1 $2"; return 0 ;; esac
  npx tsx "$S/record-session.ts" --cli "$1" --tasks "$2" --parallel "$3" --out "$REC" \
    --upstream http://127.0.0.1:8788 --isolation systemd
}

if [ "$WHAT" = real ] || [ "$WHAT" = both ]; then
  hold caprec.slice
  sample_start caprec.slice "real-$PHASE"
  echo "PHASE_REAL_START $PHASE $(ts)"
  # Wait on the two recorders' PIDs only: a bare `wait` also waits for the background sampler,
  # whose --duration is hours, so the phase would hang after the sessions finish.
  case "$PHASE" in
    n1) rec claude exc-heavy-1 1; rec codex exc-typical-1 1 ;;
    n4) rec claude exc-typical-2,mea-typical-1 2 & p1=$!
        rec codex exc-light-3,mea-light-3 2 & p2=$!
        wait "$p1" "$p2" ;;
    n8) rec claude exc-typical-1,exc-typical-4,mea-light-2,mea-typical-4 4 & p1=$!
        rec codex exc-typical-2,exc-light-1,mea-light-4,mea-typical-1 4 & p2=$!
        wait "$p1" "$p2" ;;
  esac
  echo "PHASE_REAL_END $PHASE $(ts)"
  sample_stop "real-$PHASE"; unhold caprec.slice
  for m in "$REC"/*/meta.json; do
    node -e 'const m=require(process.argv[1]); console.log("REAL", m.sessionId, "exit="+m.exitCode, "timedOut="+m.timedOut, "cpuUsec="+(m.cpuUsec??"?"), "memPeakBytes="+(m.memPeakBytes??"?"), "wallMs="+m.wallMs)' "$m"
  done
fi

if [ "$WHAT" = replay ] || [ "$WHAT" = both ]; then
  ids=$(cd "$REC" && ls -d */ 2>/dev/null | tr -d / | paste -sd,)
  [ -n "$ids" ] || { echo "PHASE_REPLAY_NOTHING $PHASE"; exit 3; }
  hold capdrv.slice
  sample_start capdrv.slice "replay-$PHASE"
  echo "PHASE_REPLAY_START $PHASE $(ts) sessions=$ids"
  npx tsx "$S/load-driver.ts" --sweep --agents "$N" --corpus "$REC" --sessions "$ids" \
    --out "$RUNOUT" --isolation systemd --path recorded
  echo "PHASE_REPLAY_END $PHASE rc=$? $(ts)"
  sample_stop "replay-$PHASE"; unhold capdrv.slice
fi
echo "PHASE_DONE $PHASE $WHAT $(ts)"
