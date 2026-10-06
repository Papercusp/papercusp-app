#!/usr/bin/env bash
# VM-side probes for sidecar-idle-soak.sh (copied to /tmp on the capacity VM). Measurement only.
# Moved from .papercusp/scratch/p532f/vm-probe.sh by WI-10006497 (plan agent-capacity-and-cost-gcp-2026-09-30).
#   bash sidecar-idle-probe.sh census "<tenants>"          one TENANT line per tenant
#   bash sidecar-idle-probe.sh ports  <label> "<tenants>"  every TCP listener with uid + process
#   bash sidecar-idle-probe.sh envops "<tenants>"          WI-10006420: env-switcher operator listeners
# The driver writes /tmp/cg-<tenant> (the Server's cgroup) and /tmp/port-<tenant> (its own port).
set -uo pipefail
cmd=${1:?census|ports|envops}
# The local env-switcher operators a desktop provisions (env-operator-launcher.ts
# PROVISIONABLE_ENV_OPERATORS: dev 3270, prod 3070, staging 3170, local Vite 3055). A headless
# Server must start none of them (WI-10006420).
ENV_OPERATOR_PORTS=${ENV_OPERATOR_PORTS:-"3270 3070 3170 3055"}
# Where the driver leaves cg-<tenant> / port-<tenant>; overridable so the tests never write /tmp.
STATE=${PROBE_STATE_DIR:-/tmp}

census() {
  local tenants=$1
  tail -n 1 /tmp/host.log 2>/dev/null
  for u in $tenants; do
    local cg uid anon cur sc=0 scpids='' scrss='' log tr idlex died real probes lastreal
    cg=$(cat "$STATE/cg-$u" 2>/dev/null); uid=$(id -u "$u")
    anon=$(awk '/^anon /{printf "%.2f", $2/1073741824}' "$cg/memory.stat" 2>/dev/null)
    cur=$(awk '{printf "%.2f", $1/1073741824}' "$cg/memory.current" 2>/dev/null)
    # P-532e (WI-10005932): mainOnnxMaps = .onnx mappings in NON-sidecar processes. Must stay 0:
    # a non-zero count is the in-process model a timed-out sidecar start used to leave behind.
    local monnx=0 manon=0 a m
    for p in $(cat "$cg/cgroup.procs" 2>/dev/null); do
      if sudo cat "/proc/$p/environ" 2>/dev/null | tr '\0' '\n' | grep -qx 'PAPERCUSP_EMBED_SIDECAR_MODE=1'; then
        sc=$((sc + 1)); scpids="$scpids$p,"
        scrss="$scrss$(awk '/^VmRSS:/{printf "%.2f", $2/1048576}' "/proc/$p/status" 2>/dev/null)G,"
      else
        m=$(sudo grep -c '\.onnx' "/proc/$p/maps" 2>/dev/null); monnx=$((monnx + ${m:-0}))
        a=$(sudo awk '/^RssAnon:/{print int($2/1024)}' "/proc/$p/status" 2>/dev/null); [ "${a:-0}" -gt "$manon" ] && manon=${a:-0}
      fi
    done
    log=/home/$u/.papercusp/logs/serve.log
    idlex=$(sudo grep -c 'exited idle; the next embed re-launches it' "$log" 2>/dev/null)
    died=$(sudo grep -c '\[embed-sidecar\] died' "$log" 2>/dev/null)
    tr=/tmp/embtrace-$uid.log
    real=$(sudo grep '^EMBED_CALL' "$tr" 2>/dev/null | grep -vc probeEmbedSidecar)
    probes=$(sudo grep '^EMBED_CALL' "$tr" 2>/dev/null | grep -c probeEmbedSidecar)
    lastreal=$(sudo grep '^EMBED_CALL' "$tr" 2>/dev/null | grep -v probeEmbedSidecar | tail -n 1 | grep -oE 't=[^ ]+' | cut -c14-21)
    local stimeouts
    stimeouts=$(sudo grep -c 'Embed sidecar startup timeout' "$log" 2>/dev/null)
    echo "TENANT $u uid=$uid anonG=${anon:-?} curG=${cur:-?} sidecarProcs=$sc sidecarPids=${scpids:-none} sidecarRss=${scrss:-none} idleExits=${idlex:-0} died=${died:-0} realEmbeds=${real:-0} probes=${probes:-0} lastReal=${lastreal:-none} startTimeouts=${stimeouts:-0} mainOnnxMaps=$monnx mainMaxAnonM=$manon"
  done
}

# "<addr:port> <process> pid=<pid> uid=<uid>" per LISTEN socket.
listeners() {
  # LISTEN 0 511 127.0.0.1:8788 0.0.0.0:* users:(("node",pid=123,fd=20)) uid:1001 ino:..
  sudo ss -ltnpHe | sed -nE 's/^LISTEN +[0-9]+ +[0-9]+ +([^ ]+) +[^ ]+ +users:\(\("([^"]+)",pid=([0-9]+)[^ ]* +(uid:([0-9]+))?.*/\1 \2 pid=\3 uid=\5/p'
}

ports() {
  local label=$1 tenants=$2
  for u in $tenants; do echo "UID $u=$(id -u "$u")"; done
  sudo ss -ltnpHe > "/tmp/ports-$label.txt"
  listeners | sort -k4 -k1
}

# WI-10006420. One ENV_OPERATORS line per tenant: its listeners on an env-operator port OTHER than
# its own Server port. ENV_OPERATORS_TOTAL counts every such listener on the host whatever its uid:
# on a shared host the second tenant used to adopt the first tenant's operators as its own.
envops() {
  local tenants=$1 all own total=0 u uid sp n list p
  all=$(listeners)
  own=" "
  for u in $tenants; do own="$own$(cat "$STATE/port-$u" 2>/dev/null) "; done
  for u in $tenants; do
    uid=$(id -u "$u"); sp=$(cat "$STATE/port-$u" 2>/dev/null)
    n=0; list=''
    for p in $ENV_OPERATOR_PORTS; do
      [ "$p" = "$sp" ] && continue
      if printf '%s\n' "$all" | grep -qE ":$p [^ ]+ pid=[0-9]+ uid=$uid\$"; then n=$((n + 1)); list="$list$p,"; fi
    done
    echo "ENV_OPERATORS $u uid=$uid serverPort=${sp:-?} listeners=$n ports=${list:-none}"
  done
  for p in $ENV_OPERATOR_PORTS; do
    case "$own" in *" $p "*) continue ;; esac
    printf '%s\n' "$all" | grep -qE ":$p [^ ]+ pid=" && total=$((total + 1))
  done
  echo "ENV_OPERATORS_TOTAL listeners=$total"
}

case "$cmd" in
  census) census "${2:?tenants}" ;;
  ports) ports "${2:?label}" "${3:?tenants}" ;;
  envops) envops "${2:?tenants}" ;;
  *) echo "unknown $cmd"; exit 2 ;;
esac
