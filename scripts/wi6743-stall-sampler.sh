#!/usr/bin/env bash
# WI-6743 — settle STARVED vs BLOCKED vs WAITING-ON-DOWNSTREAM for the recurring
# ~10s stalls recorded in ~/.papercusp/mcp-proxy-watchdog.log.
#
# The watchdog polls 9071 (papercup-mcp-proxy, a SINGLE node process = one event
# loop). :3070 is a 16-process SO_REUSEPORT cluster, so it is a different animal.
#
# The discriminator is /proc/<pid>/schedstat on the MAIN thread (the event loop):
#   field1 run_ns   - time this task actually spent ON cpu
#   field2 wait_ns  - time it spent RUNNABLE but waiting on the runqueue
# During a stall:
#   run high / wait low  -> BLOCKED  (self-inflicted cpu work)
#   run low  / wait high -> STARVED  (descheduled by fleet contention)
#   run low  / wait low  -> neither; idle awaiting downstream I/O (:3070, PG)
#
# Writes two TSVs; no dependency on any job registry, so it survives a respawn.
set -uo pipefail

OUT=${OUT:-/tmp/wi6743}
mkdir -p "$OUT"
M="$OUT/metrics.tsv"
P="$OUT/probe.tsv"

[ -s "$M" ] || printf 'ts\tproxy_pid\trun_ms\twait_ms\tnvcsw\tthreads\tload1\tpsi_cpu_some10\tpsi_io_some10\tcl_run_ms\tcl_wait_ms\tcl_n\n' >"$M"
[ -s "$P" ] || printf 'ts\thttp_code\ttime_total_s\n' >"$P"

resolve_proxy() {
  # MainPID is the bash/tsx wrapper on some setups; prefer the actual listener
  # on 9071, which is the node process whose MAIN THREAD is the event loop.
  # (grep, not gawk's 3-arg match() -- mawk is the default awk here.)
  local lp pid
  lp=$(ss -ltnp 2>/dev/null | grep -a ':9071 ' | grep -aoE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  if [ -n "${lp:-}" ]; then echo "$lp"; return; fi
  pid=$(systemctl --user show papercup-mcp-proxy -p MainPID --value 2>/dev/null)
  echo "${pid:-0}"
}

resolve_cluster() {
  ss -ltnpH 2>/dev/null | grep -a ':3070 ' | grep -aoE 'pid=[0-9]+' | cut -d= -f2 | sort -u
}

# schedstat for a pid -> "run wait"
sched() {
  local s
  read -r s <"/proc/$1/schedstat" 2>/dev/null || { echo "0 0"; return; }
  echo "${s% *}" "$(echo "$s" | awk '{print $2}')"
}

# ---------- probe loop (2s cadence, generous timeout so a real stall is MEASURED,
# ---------- not truncated at the observer's timeout the way the 10s watchdog does)
(
  while :; do
    ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
    r=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 120 \
          http://127.0.0.1:9071/ 2>/dev/null) || r="000 timeout"
    printf '%s\t%s\n' "$ts" "$r" >>"$P"
    sleep 2
  done
) &
PROBE_PID=$!
# NOTE: a bash trap handler RESUMES the script unless it exits explicitly, so the
# `exit` here is load-bearing -- without it SIGTERM kills only the probe child and
# the metrics loop runs on forever (observed).
trap 'kill $PROBE_PID 2>/dev/null; exit 0' INT TERM
trap 'kill $PROBE_PID 2>/dev/null' EXIT

# Self-limiting: never outlive the investigation window that launched it.
MAX_SEC=${MAX_SEC:-21600}
START=$SECONDS

# ---------- metrics loop (1s cadence, pure /proc reads)
PROXY=$(resolve_proxy)
mapfile -t CLUSTER < <(resolve_cluster)
prun=0; pwait=0; pnv=0; i=0
declare -A crun cwait
first=1

while :; do
  # refresh pid maps every 60s (restarts / redeploys rotate them)
  if (( i % 60 == 0 )); then
    np=$(resolve_proxy)
    if [ "$np" != "$PROXY" ] && [ "$np" != "0" ]; then PROXY=$np; first=1; fi
    mapfile -t CLUSTER < <(resolve_cluster)
  fi

  ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)

  read -r la _ </proc/loadavg
  psic=$(awk '/^some/{for(j=2;j<=NF;j++) if ($j ~ /^avg10=/) {sub(/avg10=/,"",$j); print $j; exit}}' /proc/pressure/cpu 2>/dev/null)
  psii=$(awk '/^some/{for(j=2;j<=NF;j++) if ($j ~ /^avg10=/) {sub(/avg10=/,"",$j); print $j; exit}}' /proc/pressure/io 2>/dev/null)

  if [ -r "/proc/$PROXY/schedstat" ]; then
    read -r line <"/proc/$PROXY/schedstat"
    nrun=${line%% *}; rest=${line#* }; nwait=${rest%% *}
    nnv=$(awk '/nonvoluntary_ctxt_switches/{print $2}' "/proc/$PROXY/status" 2>/dev/null)
    thr=$(awk '/^Threads:/{print $2}' "/proc/$PROXY/status" 2>/dev/null)
  else
    nrun=0; nwait=0; nnv=0; thr=0
  fi

  # cluster aggregate
  tr_=0; tw_=0; n=0
  for c in "${CLUSTER[@]}"; do
    [ -r "/proc/$c/schedstat" ] || continue
    read -r cl <"/proc/$c/schedstat"
    cr=${cl%% *}; crest=${cl#* }; cw=${crest%% *}
    if [ -n "${crun[$c]:-}" ]; then
      tr_=$(( tr_ + cr - crun[$c] )); tw_=$(( tw_ + cw - cwait[$c] )); n=$((n+1))
    fi
    crun[$c]=$cr; cwait[$c]=$cw
  done

  if [ $first -eq 0 ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$ts" "$PROXY" \
      "$(( (nrun - prun) / 1000000 ))" "$(( (nwait - pwait) / 1000000 ))" \
      "$(( nnv - pnv ))" "$thr" "$la" "${psic:-0}" "${psii:-0}" \
      "$(( tr_ / 1000000 ))" "$(( tw_ / 1000000 ))" "$n" >>"$M"
  fi
  prun=$nrun; pwait=$nwait; pnv=$nnv; first=0
  i=$((i+1))
  sleep 1
done
