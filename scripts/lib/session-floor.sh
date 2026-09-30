#!/usr/bin/env bash
# session-floor.sh — the PID set that NO agent teardown may ever signal.
#
# WHY THIS EXISTS (WI-36926). On 2026-08-08 the owner was logged out of their
# GNOME desktop TWICE, both times by agent process-teardown code that computed a
# victim PID set and signalled it with no floor underneath:
#
#   1. 11:52:49 EDT — a Tauri rig teardown walked its app's ancestor chain with
#      `while [ "$P" != "1" ]` and SIGTERM'd every ancestor. That stops AT pid 1
#      but INCLUDES `systemd --user`, whose PPID *is* 1. A user systemd manager
#      that receives SIGTERM activates exit.target — i.e. it logs the user out.
#      The script's own comment said "stopping before systemd": the guard was off
#      by exactly one layer. This is not an exotic mistake — a backgrounded agent
#      job REPARENTS to `systemd --user`, so an ancestor walk from one reaches the
#      user manager in a single hop.
#
#   2. 20:32:15 EDT — `fed_cleanup_scoped` ran
#      `ps -eo pid,args | grep -F "$work" | ... | kill -9` with $work="a" (a fuzz
#      harness had called it with placeholder args). 1,896 SIGKILLs in one second,
#      including gnome-session-binary. The user manager survived only by luck:
#      `/usr/lib/systemd/systemd --user` happens to contain no letter "a".
#
# The two calling bugs were unrelated. The missing floor was the same. This file
# is that floor: a small, exact, cheap oracle every kill path consults, so that
# being wrong about WHICH processes to kill can no longer cost the owner their
# desktop session.
#
# DESIGN CONSTRAINTS, each earned:
#   * EXACT comm matching only (`pgrep -x`), NEVER `pgrep -f`. A `-f` match reads
#     the full command line, so it matches any peer agent's shell that merely
#     MENTIONS the name — including the very probe you are running. Measured while
#     writing this file: `pgrep -af gnome-session-binary` matched this script's own
#     `bash -c`. A floor that self-matches is worse than none.
#   * FAIL CLOSED. If the floor cannot be computed, callers must treat every pid as
#     protected rather than proceed. An oracle that fails open is decorative.
#   * NO dependency on the operator, node, or the network. This runs on the kill
#     path, including during teardown when those may already be gone.
#
# Usage (library):
#   source scripts/lib/session-floor.sh
#   session_floor_is_protected "$pid" && continue        # skip it
#   printf '%s\n' $pids | session_floor_filter           # safe pids on stdout
#
# Usage (CLI): scripts/session-floor.sh list|check <pid...>|filter <pid...>

# Processes that ARE the owner's login session. Killing any of them ends it.
# Matched against /proc/<pid>/comm exactly — not against argv.
SESSION_FLOOR_COMMS="${SESSION_FLOOR_COMMS:-systemd gnome-session-binary gnome-shell gnome-session-ctl Xorg Xwayland gdm-x-session gdm-wayland-session gdm3 gdm plasmashell sddm ksmserver}"

# THE KERNEL TRUNCATES comm TO 15 CHARACTERS (TASK_COMM_LEN 16, incl. NUL), and
# `pgrep -x` matches comm — so a longer name matches NOTHING and pgrep says so on
# stderr while still exiting cleanly. That is a silent false negative in the one
# direction that matters here: measured while building this file,
# `pgrep -x gnome-session-binary` returned zero rows, i.e. an unnormalised floor
# would have reported "safe to kill" for the EXACT process whose death ended the
# owner's session in incident #2 (its real comm is `gnome-session-b`). Three of
# the names above truncate. Normalise every comparison through this function so a
# name added later cannot silently fall off the floor.
_sf_trunc() { printf '%.15s' "$1"; }

_sf_floor_comms() {
  local c
  for c in $SESSION_FLOOR_COMMS; do _sf_trunc "$c"; printf '\n'; done | sort -u
}

# Read /proc/<pid>/comm. Empty when the pid is gone (a dead pid is not protected —
# it is simply not there — but callers must still re-verify identity before
# signalling, because pid wrap happens ~daily on this box under fleet load).
_sf_comm() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  [ -r "/proc/$pid/comm" ] || return 1
  tr -d '\n' < "/proc/$pid/comm" 2>/dev/null
}

# The logind Leader pid of every seat-attached (i.e. real, human) login session.
# A headless box legitimately has none; that is not an error.
_sf_session_leaders() {
  command -v loginctl >/dev/null 2>&1 || return 0
  local s id class seat leader
  for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
    id=""; class=""; seat=""; leader=""
    # shellcheck disable=SC2046
    eval "$(loginctl show-session "$s" -p Id -p Class -p Seat -p Leader 2>/dev/null |
            sed -n 's/^\(Id\|Class\|Seat\|Leader\)=\(.*\)$/\L\1\E="\2"/p')"
    [ "${class:-}" = "user" ] || continue
    [ -n "${seat:-}" ] || continue          # seat-less = ssh/service, not a desktop
    [ -n "${leader:-}" ] && printf '%s\n' "$leader"
  done
}

# Every process running as THIS uid whose comm is session-critical, plus pid 1,
# plus every graphical session leader. Printed one pid per line, deduped.
session_floor_pids() {
  local uid comm pid
  uid="$(id -u 2>/dev/null)" || return 1
  {
    printf '1\n'                                  # init: SIGKILL-immune, but never target it
    _sf_session_leaders
    for comm in $(_sf_floor_comms); do
      # -x = match the executable NAME exactly; argv is never consulted, so this
      # cannot match a peer agent's shell that merely mentions the name.
      pgrep -x "$comm" -u "$uid" 2>/dev/null || true
      # gdm runs as its own uid; a kill of it drops the greeter and the seat.
      pgrep -x "$comm" -u gdm 2>/dev/null || true
    done
  } | grep -E '^[0-9]+$' | sort -un
}

# True (exit 0) iff <pid> must never be signalled.
session_floor_is_protected() {
  local pid="$1" comm leaders
  [ -n "$pid" ] || return 0                       # empty/garbage -> treat as protected
  case "$pid" in ''|*[!0-9]*) return 0;; esac      # non-numeric -> protected (fail closed)
  [ "$pid" -eq 1 ] 2>/dev/null && return 0

  comm="$(_sf_comm "$pid")" || return 1           # no such pid -> not protected
  [ -n "$comm" ] || return 1

  # Compare truncated-to-truncated: /proc/<pid>/comm is ALREADY 15-char clipped by
  # the kernel, so the configured names must be clipped the same way or a long
  # name silently never matches (see _sf_trunc). The user systemd MANAGER is
  # `systemd` running as a real user — the process whose SIGTERM *is* a logout.
  case " $(_sf_floor_comms | tr '\n' ' ') " in
    *" $(_sf_trunc "$comm") "*) return 0;;
  esac

  # Also protect any seat-attached session leader whose comm we do not enumerate
  # (a non-GNOME desktop, a future compositor).
  leaders="$(_sf_session_leaders)"
  case "
$leaders
" in
    *"
$pid
"*) return 0;;
  esac
  return 1
}

# stdin/args: candidate pids. stdout: the pids that are SAFE to signal.
# stderr: one line per refusal, with the reason — a silent floor teaches nobody.
session_floor_filter() {
  local pid comm
  { [ "$#" -gt 0 ] && printf '%s\n' "$@" || cat; } | while read -r pid; do
    [ -n "$pid" ] || continue
    if session_floor_is_protected "$pid"; then
      comm="$(_sf_comm "$pid" 2>/dev/null || true)"
      printf 'session-floor: REFUSED pid=%s comm=%s — this is part of the owner login session (WI-36926)\n' \
        "$pid" "${comm:-?}" >&2
      continue
    fi
    printf '%s\n' "$pid"
  done
}
