#!/bin/bash
# Install the as-cut Papercusp Server .deb on a capacity-test VM and start it headless.
#
# Plan agent-capacity-and-cost-gcp-2026-09-30, S7 (WI-10004395). Runs ON the VM (Ubuntu
# 24.04 GCE image) as the default ssh user with sudo. The VM is private: the Server is not
# joined to any hive here (D-008: S7 is "free anytime", never shared).
#
#   install-server.sh <gs://.../server.deb> <expected-sha256>
#
# Prints lines the caller greps: SERVER_CGROUP=<path>, SERVER_PORT=<port>, SERVER_HEALTH=<json>,
# and timing lines T_*=<seconds>. Exits non-zero with a reason on any failure.
set -euo pipefail

OBJ="${1:?usage: install-server.sh <gs-uri> <sha256> [KEY=VAL ...]}"
WANT_SHA="${2:?usage: install-server.sh <gs-uri> <sha256> [KEY=VAL ...]}"
shift 2
EXTRA_ENV=()
for kv in "$@"; do
  [[ "$kv" =~ ^[A-Z_][A-Z0-9_]*=[^[:space:]]*$ ]] || { echo "BAD_ENV_ARG $kv (want KEY=VAL, no spaces)"; exit 2; }
  EXTRA_ENV+=("$kv")
done
# SVC_USER (env, default pcsrv) names the Linux user whose systemd --user manager runs the
# Server. One user = one tenant: the package installs once, and each additional user started
# with linger gets its own Server, Postgres and ports (P-011 multi-tenant density, WI-10004383).
SVC_USER="${SVC_USER:-pcsrv}"
[[ "$SVC_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "BAD_SVC_USER $SVC_USER (want a lowercase Linux user name)"; exit 2; }
DEB=/var/tmp/papercusp-server.deb
t0=$(date +%s)

# A re-run on a VM that already holds this exact package skips the ~5 min fetch + install.
# The marker records the sha of the .deb that was installed, so a different artifact reinstalls.
MARKER=/var/lib/papercusp-capacity-installed.sha256
if [ "$(sudo cat "$MARKER" 2>/dev/null)" = "$WANT_SHA" ] && dpkg-query -W papercusp-server >/dev/null 2>&1; then
  echo "== already installed ($WANT_SHA), skipping fetch + apt"
else
  echo "== fetch $OBJ"
  gcloud storage cp "$OBJ" "$DEB" --no-user-output-enabled
  got=$(sha256sum "$DEB" | cut -d' ' -f1)
  [ "$got" = "$WANT_SHA" ] || { echo "SHA_MISMATCH got=$got want=$WANT_SHA"; exit 3; }
  echo "T_FETCH=$(( $(date +%s) - t0 ))"

  echo "== apt install"
  t1=$(date +%s)
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$DEB" >/tmp/apt-install.log 2>&1 \
    || { tail -30 /tmp/apt-install.log; exit 4; }
  sudo rm -f "$DEB"
  echo "$WANT_SHA" | sudo tee "$MARKER" >/dev/null
  echo "T_APT=$(( $(date +%s) - t1 ))"
fi

# postinst launches a detached apt job that installs a terminal (ghostty). Let it finish so
# it does not pollute the measurement window; record how long it held dpkg.
t2=$(date +%s)
for _ in $(seq 1 180); do
  if ! pgrep -x apt-get >/dev/null && ! pgrep -x dpkg >/dev/null; then break; fi
  sleep 5
done
echo "T_POSTINST_BG=$(( $(date +%s) - t2 ))"

echo "== service user + linger"
id "$SVC_USER" >/dev/null 2>&1 || sudo useradd -m -s /bin/bash "$SVC_USER"
uid=$(id -u "$SVC_USER")
# Extra KEY=VAL arguments become a systemd drop-in, written BEFORE the user manager exists.
# The capacity baseline passes PAPERCUSP_DISABLE_DOGFOOD_HIVE=1: without it a fresh install
# auto-joins the dogfood `papercusp` hive and spends its first hour folding that hive's seed
# into Postgres (WI-10004421), which is not customer idle.
# ORDER MATTERS: the package's postinst enables the unit for EVERY user (deb-systemd-helper
# --user enable -> /etc/systemd/user/default.target.wants), so `loginctl enable-linger` below
# starts the server immediately. Writing the drop-in after linger lost the race by one second
# on cap-s7-b (2026-09-30 21:19:49 start vs 21:19:50 drop-in) and the first boot ran without it.
if [ ${#EXTRA_ENV[@]} -gt 0 ]; then
  svc_home="${SVC_HOME:-/home/$SVC_USER}"
  dropin="$svc_home/.config/systemd/user/papercusp-server.service.d"
  sudo install -d -o "$SVC_USER" -g "$SVC_USER" "$svc_home/.config" "$svc_home/.config/systemd" \
    "$svc_home/.config/systemd/user" "$dropin"
  { echo '[Service]'; for kv in "${EXTRA_ENV[@]}"; do echo "Environment=$kv"; done; } \
    | sudo -u "$SVC_USER" tee "$dropin/capacity-env.conf" >/dev/null
  for kv in "${EXTRA_ENV[@]}"; do echo "SERVER_ENV=$kv"; done
fi
t3=$(date +%s)
sudo loginctl enable-linger "$SVC_USER"
# /run/user/<uid> is mode 0700 and owned by the service user, so test it with sudo: an
# unprivileged test reads "permission denied" as "absent".
for _ in $(seq 1 60); do sudo test -S "/run/user/$uid/bus" && break; sleep 1; done
sudo test -S "/run/user/$uid/bus" || { echo "USER_MANAGER_NOT_UP uid=$uid"; exit 5; }
as_user() { sudo -u "$SVC_USER" XDG_RUNTIME_DIR="/run/user/$uid" "$@"; }
as_user systemctl --user daemon-reload
as_user systemctl --user enable --now papercusp-server.service

# Verify the RUNNING process carries every requested variable. A drop-in on disk (or in
# `systemctl show -p Environment`) proves nothing about a process that started before it.
main_env() {
  local pid
  pid=$(as_user systemctl --user show -p MainPID --value papercusp-server.service || true)
  # Always succeed (set -e): an unreadable process reads as "carries nothing", which the
  # caller reports as SERVER_ENV_NOT_APPLIED rather than dying silently mid-assignment.
  if [ -n "$pid" ] && [ "$pid" != 0 ]; then sudo cat "/proc/$pid/environ" 2>/dev/null | tr '\0' '\n' || true; fi
}
env_missing() {
  local have kv
  have=$(main_env)
  for kv in "${EXTRA_ENV[@]}"; do grep -qxF "$kv" <<<"$have" || echo "$kv"; done
}
if [ ${#EXTRA_ENV[@]} -gt 0 ]; then
  missing=$(env_missing)
  if [ -n "$missing" ]; then
    # Already running without them (a re-run, or a start we did not order). Restart once;
    # the first boot already happened without them, so say so rather than hide it.
    echo "SERVER_RESTARTED_FOR_ENV (first start lacked: $(echo $missing)) - state from that start may persist"
    as_user systemctl --user restart papercusp-server.service
    missing=$(env_missing)
  fi
  if [ -n "$missing" ]; then
    for kv in $missing; do echo "SERVER_ENV_NOT_APPLIED=$kv"; done
    exit 7
  fi
  for kv in "${EXTRA_ENV[@]}"; do echo "SERVER_ENV_VERIFIED=$kv"; done
fi
cg_rel=$(as_user systemctl --user show -p ControlGroup --value papercusp-server.service)
echo "SERVER_CGROUP=/sys/fs/cgroup${cg_rel}"

echo "== wait for operator health"
# The journal's operator_hint is only the port the supervisor OFFERED; also try every TCP
# port a process in the service's cgroup is listening on.
svc_log() { sudo journalctl --user-unit=papercusp-server.service "_UID=$uid" --no-pager -o cat 2>/dev/null; }
candidate_ports() {
  svc_log | sed -n 's/.*operator_hint=\([0-9]*\).*/\1/p' | tail -1
  local pids
  pids=$(cat $(sudo find "/sys/fs/cgroup${cg_rel}" -name cgroup.procs) 2>/dev/null | tr '\n' '|' | sed 's/|$//')
  [ -n "$pids" ] && sudo ss -ltnpH 2>/dev/null | grep -E "pid=($pids)," \
    | awk '{print $4}' | sed 's/.*://' | sort -u
}
for _ in $(seq 1 180); do
  for port in $(candidate_ports | sort -u); do
    if body=$(curl -fsS -m 3 "http://127.0.0.1:$port/api/health" 2>/dev/null); then
      echo "SERVER_PORT=$port"
      echo "SERVER_HEALTH=$body"
      echo "T_BOOT_TO_HEALTH=$(( $(date +%s) - t3 ))"
      exit 0
    fi
  done
  sleep 5
done
echo "HEALTH_TIMEOUT"
svc_log | tail -40
exit 6
