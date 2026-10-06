#!/usr/bin/env bash
# Time a Papercusp Server restart on a test VM while sampling its cgroup every 2 s
# (plan agent-capacity-and-cost-gcp-2026-09-30, S7 / WI-10004395).
#
# Runs ON the VM, as the login user with sudo. The server runs as a USER service of
# $SERVER_USER, so it is restarted through that user's manager. Page cache is warm (binaries
# already read once), so this measures a service restart, not a first boot of a fresh VM.
#
#   bash time-restart.sh [--user pcsrv] [--port 18640] [--sample-sec 420] [--out /tmp/fp-restart.jsonl]
#
# Prints RESTART_TIMING restart_s=<systemctl restart returned> healthy_s=<first 200 from
# /api/health>, both measured from just before the restart command.
set -euo pipefail
SERVER_USER=pcsrv
PORT=18640
SAMPLE_SEC=420
OUT=/tmp/fp-restart.jsonl
SAMPLER=${SAMPLER:-/tmp/sample-footprint.py}
while [ $# -gt 0 ]; do
  case "$1" in
    --user) SERVER_USER=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --sample-sec) SAMPLE_SEC=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
uid=$(id -u "$SERVER_USER")
CG=${SERVER_CGROUP:-/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/app.slice/papercusp-server.service}
[ -d "$CG" ] || { echo "no server cgroup at $CG" >&2; exit 1; }
[ -f "$SAMPLER" ] || { echo "sampler missing: $SAMPLER" >&2; exit 1; }

nohup python3 "$SAMPLER" --cgroup "$CG" --interval 2 --duration "$SAMPLE_SEC" --out "$OUT" --label restart >/tmp/restart-sampler.log 2>&1 &
sleep 6 # three samples of the running server before the restart

t0=$(date +%s.%N)
sudo -u "$SERVER_USER" XDG_RUNTIME_DIR=/run/user/$uid systemctl --user restart papercusp-server.service
t1=$(date +%s.%N)
healthy=""
for _ in $(seq 1 1200); do
  if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health"; then healthy=$(date +%s.%N); break; fi
  sleep 0.5
done
restart_s=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')
if [ -n "$healthy" ]; then
  healthy_s=$(awk -v a="$t0" -v b="$healthy" 'BEGIN{printf "%.1f", b-a}')
else
  healthy_s=never
fi
echo "RESTART_TIMING t0=$(date -u -d @"${t0%.*}" +%FT%TZ) restart_s=$restart_s healthy_s=$healthy_s"
curl -s --max-time 5 "http://127.0.0.1:$PORT/api/health" || true
echo
