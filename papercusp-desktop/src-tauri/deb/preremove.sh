#!/bin/sh
# Stop the packaged Papercusp process tree before dpkg removes the binary.
#
# Debian runs prerm as root, while the GUI/Server and its sidecar run as the
# logged-in user. Do not use $HOME here: it is root's home during removal.
# Instead, find the package-owned desktop process, read its own HOME (or the
# explicit PAPERCUSP_HOME) and use the sidecar's operator.json as the narrow
# discovery record for the process group it owns.
#
# This script is intentionally best-effort. A stale or malformed discovery
# record must never make an unrelated PID a kill target, but it must also never
# make dpkg uninstall fail. The GUI PID is still stopped when discovery is
# absent; its parent-death watch is the fallback for a sidecar with no record.
set -u

PROC_ROOT=${PAPERCUSP_PREREMOVE_PROC_ROOT:-/proc}
HOME_ROOT=${PAPERCUSP_PREREMOVE_HOME_ROOT:-/home}
WAIT_SEC=${PAPERCUSP_PREREMOVE_WAIT_SEC:-8}

# Both products inherit this script, so package identity must select the exact
# executable and lifecycle authority before we inspect /proc. Only the Server
# owns the operator process group and discovery records. Removing the GUI may
# stop its own shell, but must leave the independently installed Server alive.
case "${DPKG_MAINTSCRIPT_PACKAGE:-}" in
  papercusp-gui)
    DESKTOP_EXEC=/usr/bin/papercusp-desktop
    OWNS_OPERATOR=0
    ;;
  papercusp-server)
    DESKTOP_EXEC=/usr/bin/papercusp-server
    OWNS_OPERATOR=1
    ;;
  *)
    # dpkg always supplies DPKG_MAINTSCRIPT_PACKAGE. Refuse an unknown caller
    # rather than widening process ownership to a guessed legacy identity.
    exit 0
    ;;
esac

# A package removal must tell systemd that this is an intentional stop BEFORE
# the binary disappears or the fallback PID cleanup runs.  Otherwise the
# package-owned unit's Restart=on-failure policy races prerm: systemd observes
# the killed Server as a crash, retries every five seconds, and keeps retrying
# the now-missing executable after dpkg removes it.  Use Debian's user-service
# helper so every live user manager is addressed; preserve the existing upgrade
# behavior, where the running unit is allowed to restart onto the replacement
# binary during the package transaction.
SERVER_USER_UNIT=papercusp-server.service
if [ "$OWNS_OPERATOR" = 1 ] \
  && [ "${1:-}" = "remove" ] \
  && [ -z "${DPKG_ROOT:-}" ] \
  && command -v deb-systemd-invoke >/dev/null 2>&1; then
  deb-systemd-invoke --user stop "$SERVER_USER_UNIT" >/dev/null || true
fi

log() {
  echo "[papercusp-prerm] $*" >&2
}

is_pid() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    0) return 1 ;;
  esac
  return 0
}

proc_cmdline() {
  # The process may disappear between the ownership check and the post-stop
  # recheck. Read through cat so a vanished /proc entry cannot leak the shell's
  # input-redirection diagnostic from the maintainer script.
  cat "$PROC_ROOT/$1/cmdline" 2>/dev/null | tr '\000' ' '
}

proc_env_value() {
  key=$2
  tr '\000' '\n' < "$PROC_ROOT/$1/environ" 2>/dev/null \
    | sed -n "s/^${key}=//p" | sed -n '1p'
}

# Fields after the final ')' are /proc stat fields 3 onward. awk's greedy
# match handles a process comm containing spaces or ')' like the Rust and Node
# identity readers do.
proc_stat_field() {
  field=$2
  awk -v field="$field" '{ sub(/^.*\) /, ""); print $field; exit }' \
    "$PROC_ROOT/$1/stat" 2>/dev/null
}

proc_identity() {
  pid=$1
  boot_id=$(cat "$PROC_ROOT/sys/kernel/random/boot_id" 2>/dev/null || true)
  start_ticks=$(proc_stat_field "$pid" 20)
  [ -n "$boot_id" ] || return 1
  case "$start_ticks" in ''|*[!0-9]*) return 1 ;; esac
  printf 'linux:%s:%s\n' "$boot_id" "$start_ticks"
}

proc_pgid() {
  # After the comm, field 3 is state, field 4 ppid, field 5 pgrp. The target
  # is valid only when the serve PID is its own group ID; that is the
  # process_group(0) contract in the Tauri launcher.
  proc_stat_field "$1" 3
}

is_protected_cmdline() {
  case "$1" in
    *"systemd --user"*|*gnome-shell*|*gdm-session-worker*|*plasmashell*|\
    *loginwindow*|*WindowServer*|*/launchd*|*" launchd"*) return 0 ;;
  esac
  return 1
}

is_packaged_desktop() {
  pid=$1
  cmdline=$(proc_cmdline "$pid") || return 1
  case "$cmdline" in
    "$DESKTOP_EXEC"|"$DESKTOP_EXEC "*) return 0 ;;
  esac
  return 1
}

is_operator_authority_valid() {
  pid=$1
  expected_identity=$2
  actual_identity=$(proc_identity "$pid") || return 1
  [ "$actual_identity" = "$expected_identity" ] || return 1
  cmdline=$(proc_cmdline "$pid") || return 1
  is_protected_cmdline "$cmdline" && return 1
  # These are the entrypoints accepted by the desktop's own discovery guard.
  # Keep the check role-specific: a copied operator.json must not authorize a
  # signal to an arbitrary node, shell, or user-session process.
  case "$cmdline" in
    *serve.mjs*|*serve.ts*|*hono-host.mjs*|*hono-host.ts*) ;;
    *) return 1 ;;
  esac
  [ "$(proc_pgid "$pid")" = "$pid" ] || return 1
  return 0
}

json_number() {
  sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$2" \
    | sed -n '1p'
}

json_string() {
  sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$2" \
    | sed -n '1p'
}

wait_for_pid_exit() {
  pid=$1
  i=0
  while [ "$i" -lt "$WAIT_SEC" ]; do
    [ -e "$PROC_ROOT/$pid" ] || return 0
    sleep 1
    i=$((i + 1))
  done
  [ ! -e "$PROC_ROOT/$pid" ]
}

signal_operator_group() {
  discovery=$1
  [ -f "$discovery" ] || return 0
  operator_pid=$(json_number pid "$discovery")
  operator_identity=$(json_string processIdentity "$discovery")
  if ! is_pid "$operator_pid" || [ -z "$operator_identity" ]; then
    log "refusing unverified operator record $discovery"
    return 0
  fi
  if ! is_operator_authority_valid "$operator_pid" "$operator_identity"; then
    log "refusing unverified operator pid=$operator_pid from $discovery"
    return 0
  fi

  log "stopping verified operator pid=$operator_pid process-group=$operator_pid"
  kill -TERM -- "-$operator_pid" 2>/dev/null || \
    kill -TERM "$operator_pid" 2>/dev/null || true
  wait_for_pid_exit "$operator_pid" || true

  # Re-read identity, role, and group before destructive escalation. A
  # recycled PID must never receive the KILL intended for the old sidecar.
  if is_operator_authority_valid "$operator_pid" "$operator_identity"; then
    kill -KILL -- "-$operator_pid" 2>/dev/null || \
      kill -KILL "$operator_pid" 2>/dev/null || true
    wait_for_pid_exit "$operator_pid" || true
  fi
}

stop_packaged_desktop() {
  pid=$1
  is_packaged_desktop "$pid" || return 0

  if [ "$OWNS_OPERATOR" = 1 ]; then
    # Resolve the sidecar record from the Server's environment before stopping
    # the parent. PAPERCUSP_HOME is an already-qualified .papercusp directory.
    papercusp_home=$(proc_env_value "$pid" PAPERCUSP_HOME)
    home=$(proc_env_value "$pid" HOME)
    if [ -n "$papercusp_home" ] && [ -f "$papercusp_home/operator.json" ]; then
      signal_operator_group "$papercusp_home/operator.json"
    elif [ -n "$home" ] && [ -f "$home/.papercusp/operator.json" ]; then
      signal_operator_group "$home/.papercusp/operator.json"
    fi
  fi

  # Never kill the desktop's process group: it may be the user's session
  # group. The exact package-owned executable is the safe direct target.
  if is_packaged_desktop "$pid"; then
    log "stopping packaged desktop pid=$pid"
    kill -TERM "$pid" 2>/dev/null || true
    wait_for_pid_exit "$pid" || true
    if is_packaged_desktop "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
      wait_for_pid_exit "$pid" || true
    fi
  fi
}

# Discover only the executable owned by the package being removed. Reading
# /proc rather than root's HOME is the important Debian maintainer-script seam.
for proc_dir in "$PROC_ROOT"/[0-9]*; do
  [ -d "$proc_dir" ] || continue
  pid=${proc_dir##*/}
  is_pid "$pid" || continue
  stop_packaged_desktop "$pid"
done

# If the Server exited before its environment could be read, or if an older
# build left the parent dead, clean only records that independently pass the
# same identity + role + process-group checks. GUI removal never enters this
# fallback: those discovery records belong to the sibling Server product.
if [ "$OWNS_OPERATOR" = 1 ]; then
  for discovery in \
    "$HOME_ROOT"/*/.papercusp/operator.json \
    "$HOME_ROOT"/.papercusp/operator.json \
    /root/.papercusp/operator.json; do
    [ -f "$discovery" ] || continue
    signal_operator_group "$discovery"
  done
fi

exit 0
