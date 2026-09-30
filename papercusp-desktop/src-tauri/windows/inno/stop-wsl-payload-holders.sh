#!/bin/bash
# WI-10003665 — run by the Windows installer (PrepareToInstall, via
# stop-wsl-payload-holders.ps1) as root inside the papercup-runtime distro.
#
# Arguments: the WINDOWS paths of the role's payload roots ({app}\sidecar,
# {app}\resources, {app}\seed). BeginPayloadUpgrade renames those roots aside,
# and Windows refuses to rename a directory while any file under it is open.
# The WSL-side operator is a detached daemon that outlives the role's .exe
# (which CloseRoleScopedRunningApplication stops) and keeps DrvFs handles into
# the install — measured: node serve.mjs held sidecar\source.tar.zst open, so a
# 0.0.22 Server install over a running 0.0.19 operator exited 7 ("cannot retain
# ...\sidecar") and silently left the old version installed.
#
# Stops exactly the processes holding an fd, mapping, cwd, root or executable
# under those roots: SIGTERM first (serve's handler closes the host and
# pg_ctl-stops embedded PG, the same graceful path the in-app updater uses),
# SIGKILL whatever outlives the grace. Exit 0 = nothing holds the payload now;
# non-zero = the installer reports why. Output is the installer log's evidence.
set -u

TERM_GRACE_SEC="${PAPERCUSP_STOP_TERM_GRACE_SEC:-30}"
KILL_GRACE_SEC="${PAPERCUSP_STOP_KILL_GRACE_SEC:-5}"

roots=()
for windows_path in "$@"; do
  if [[ "$windows_path" == /* ]]; then
    linux_path="$windows_path"                    # already a Linux path (tests)
  else
    linux_path="$(wslpath -u "$windows_path" 2>/dev/null)" || linux_path=""
  fi
  if [[ -z "$linux_path" || "$linux_path" != /* ]]; then
    echo "stop-wsl-payload-holders: cannot translate '$windows_path' to a Linux path" >&2
    exit 64
  fi
  roots+=("${linux_path%/}")
done
if (( ${#roots[@]} == 0 )); then
  echo "stop-wsl-payload-holders: no payload roots given" >&2
  exit 64
fi

under_root() {
  local target="$1" root
  for root in "${roots[@]}"; do
    [[ "$target" == "$root" || "$target" == "$root/"* ]] && return 0
  done
  return 1
}

skip_pid() {
  # Pid 1 (the distro init) and this script's own process tree never qualify.
  [[ "$1" == 1 || "$1" == "$$" || "$1" == "$BASHPID" || "$1" == "$PPID" ]]
}

# Print "<pid> <evidence>" once per process with a handle under a root. One
# `find` lists every cwd/root/exe/fd link target (no per-fd fork: a busy
# distro has thousands), then each maps file is parsed with `read` alone.
holders() {
  local entry target pid seen=" " path
  while IFS=$'\t' read -r entry target; do
    pid="${entry#/proc/}"
    pid="${pid%%/*}"
    skip_pid "$pid" && continue
    [[ "$seen" == *" $pid "* ]] && continue
    if under_root "${target% (deleted)}"; then
      echo "$pid ${entry#/proc/"$pid"/}=$target"
      seen+="$pid "
    fi
  done < <(find /proc/[0-9]*/cwd /proc/[0-9]*/root /proc/[0-9]*/exe /proc/[0-9]*/fd \
             -maxdepth 1 -type l -printf '%p\t%l\n' 2>/dev/null)
  # Mappings: one grep over every maps file (a bash `read` loop over each line
  # was measured far too slow on a busy host). maps pads before the path, so
  # " <root>/" matches only a path that STARTS at the root, never a sibling
  # like "<root>-old/".
  local patterns=() root
  for root in "${roots[@]}"; do patterns+=(-e " $root/"); done
  while IFS= read -r path; do
    pid="${path#/proc/}"
    pid="${pid%%/*}"
    skip_pid "$pid" && continue
    [[ "$seen" == *" $pid "* ]] && continue
    echo "$pid maps"
    seen+="$pid "
  done < <(grep -lF "${patterns[@]}" /proc/[0-9]*/maps 2>/dev/null)
}

pids_of() { awk '{print $1}' <<<"$1" | sort -u; }

wait_clear() {
  local deadline=$((SECONDS + $1)) current
  while :; do
    current="$(holders)"
    [[ -z "$current" ]] && return 0
    (( SECONDS >= deadline )) && { printf '%s\n' "$current"; return 1; }
    sleep 0.5
  done
}

found="$(holders)"
if [[ -z "$found" ]]; then
  echo "stop-wsl-payload-holders: nothing in the distro holds ${roots[*]}"
  exit 0
fi
echo "stop-wsl-payload-holders: holders found:"
while read -r pid evidence; do
  echo "  pid $pid ($evidence): $(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-200)"
done <<<"$found"

for pid in $(pids_of "$found"); do kill -TERM "$pid" 2>/dev/null; done
if remaining="$(wait_clear "$TERM_GRACE_SEC")"; then
  echo "stop-wsl-payload-holders: all holders exited after SIGTERM"
  exit 0
fi
echo "stop-wsl-payload-holders: still holding after ${TERM_GRACE_SEC}s SIGTERM grace; sending SIGKILL"
for pid in $(pids_of "$remaining"); do kill -KILL "$pid" 2>/dev/null; done
if remaining="$(wait_clear "$KILL_GRACE_SEC")"; then
  echo "stop-wsl-payload-holders: all holders exited after SIGKILL"
  exit 0
fi
echo "stop-wsl-payload-holders: processes still hold the payload after SIGKILL:" >&2
printf '  %s\n' "$remaining" >&2
exit 75
