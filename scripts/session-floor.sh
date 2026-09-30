#!/usr/bin/env bash
# session-floor.sh — CLI for the never-signal PID floor (WI-36926).
# See scripts/lib/session-floor.sh for why this exists.
#
#   scripts/session-floor.sh list             # the protected set, with comms
#   scripts/session-floor.sh check <pid...>   # exit 1 if ANY pid is protected
#   scripts/session-floor.sh filter <pid...>  # print only the pids safe to signal
#
# `check` exits 1 on "protected" so it reads naturally as a guard:
#   scripts/session-floor.sh check "$p" || { echo "refusing"; continue; }
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/session-floor.sh
. "$DIR/lib/session-floor.sh"

cmd="${1:-list}"; shift || true

case "$cmd" in
  list)
    session_floor_pids | while read -r p; do
      printf '%s\t%s\n' "$p" "$(_sf_comm "$p" 2>/dev/null || echo '?')"
    done
    ;;
  check)
    [ "$#" -gt 0 ] || { echo "usage: session-floor.sh check <pid...>" >&2; exit 2; }
    rc=0
    for p in "$@"; do
      if session_floor_is_protected "$p"; then
        printf 'PROTECTED %s (%s) — never signal this\n' "$p" "$(_sf_comm "$p" 2>/dev/null || echo '?')"
        rc=1
      else
        printf 'ok        %s (%s)\n' "$p" "$(_sf_comm "$p" 2>/dev/null || echo 'gone')"
      fi
    done
    exit "$rc"
    ;;
  filter)
    session_floor_filter "$@"
    ;;
  *)
    echo "usage: session-floor.sh list|check <pid...>|filter <pid...>" >&2; exit 2
    ;;
esac
