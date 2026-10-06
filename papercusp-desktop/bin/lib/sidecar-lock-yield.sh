#!/usr/bin/env bash
# Shared bounded writer acquisition for src-tauri/sidecar.lock.
#
# Callers open the lock on fd 9, source this file, then call
# __pc_acquire_sidecar_flock <lock-path>. A long-lived tauri-guarded reader may
# hold a shared lock during startup; after a short grace period the writer asks
# that supervisor to close only its reader fd via SIGUSR1. Other holders are
# never signalled, and every wait remains bounded with holder diagnostics.

# PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC (EI-24961470606265468) is the one knob an
# unattended caller (a systemd-run capacity build, a scheduled gate) sets so the
# sidecar build + publish locks, vite-build-singleflight and the npm install:safe
# fs-mutex all queue behind a peer build instead of dying after 1-5 minutes.
# The specific knob still wins when set.
SIDECAR_LOCK_WAIT="${PAPERCUSP_SIDECAR_LOCK_WAIT_SEC:-${PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC:-60}}"
SIDECAR_READER_YIELD_AFTER="${PAPERCUSP_SIDECAR_READER_YIELD_AFTER_SEC:-5}"
if ! [[ "$SIDECAR_LOCK_WAIT" =~ ^[0-9]+$ ]] || ! [[ "$SIDECAR_READER_YIELD_AFTER" =~ ^[0-9]+$ ]]; then
  echo "FATAL: PAPERCUSP_SIDECAR_LOCK_WAIT_SEC and PAPERCUSP_SIDECAR_READER_YIELD_AFTER_SEC must be non-negative integer seconds" >&2
  return 2 2>/dev/null || exit 2
fi

__pc_sidecar_lock_pids() {
  local lock_path="$1"
  local lockdir="${2:-}"
  if [[ -n "$lockdir" && -f "$lockdir/pid" ]]; then
    cat "$lockdir/pid"
    return 0
  fi
  # fuser splits its output: the bare PID list is stdout and the annotated
  # path line is stderr. Read stdout directly; paths therefore cannot be
  # mistaken for PIDs.
  if command -v fuser >/dev/null 2>&1; then
    local pids
    pids="$(fuser "$lock_path" 2>/dev/null | grep -oE '[0-9]+' || true)"
    if [[ -n "$pids" ]]; then
      printf '%s\n' "$pids"
      return 0
    fi
  fi

  # Fallback for a host without fuser. A flock belongs to an open file
  # description, so /proc/locks may name an exited parent while a descendant
  # still owns the inherited fd. Resolve the live holder from /proc/*/fd.
  local lock_real
  lock_real="$(readlink -f "$lock_path" 2>/dev/null)" || return 0
  [[ -n "$lock_real" ]] || return 0
  timeout 20 ls -l /proc/[0-9]*/fd 2>/dev/null | awk -v t="$lock_real" '
    /^\/proc\/[0-9]+\/fd:/ { split($0, a, "/"); pid = a[3]; next }
    {
      p = index($0, "-> " t)
      if (p > 0 && substr($0, p + 3 + length(t)) == "") print pid
    }
  ' | sort -u
}

__pc_sidecar_lock_holder_lines() {
  local lock_path="$1"
  local lockdir="${2:-}"
  local pid elapsed argv found=0
  while read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$pid" == "$$" ]] && continue
    # Discovery and inspection are separate snapshots; a vanished PID is no
    # longer a holder and must not trip a caller's set -e.
    argv="$(ps -o args= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//')" || continue
    [[ -n "$argv" ]] || continue
    elapsed="$(ps -o etimes= -p "$pid" 2>/dev/null | awk '{$1=$1; print}')"
    printf '       pid %s (running %ss): %s\n' "$pid" "${elapsed:-?}" "$argv" >&2
    found=1
  # Do not let process-substitution helpers inherit either writer lock fd;
  # fuser would otherwise report the helper itself as a transient holder.
  # fd 9 is the reader-facing lock, while fd 8 is the build-only lock used by
  # build-desktop-sidecar.sh. Closing both keeps this diagnostic reusable for
  # either timeout path.
  done < <(exec 8>&- 9>&-; __pc_sidecar_lock_pids "$lock_path" "$lockdir")
  if ((found == 0)); then
    echo "       holder details unavailable (install fuser/procps or inspect /proc/locks)" >&2
  fi
}

__pc_request_cooperative_reader_yield() {
  local lock_path="$1"
  local lockdir="${2:-}"
  local pid argv
  while read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$pid" == "$$" ]] && continue
    argv="$(ps -o args= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//')" || continue
    # Only tauri-guarded installs the SIGUSR1 yield handler. Sending SIGUSR1
    # to cargo, sccache, or an unrelated process could terminate it.
    if [[ "$argv" == *tauri-guarded* ]]; then
      if kill -USR1 "$pid" 2>/dev/null; then
        echo "→ requested tauri-guarded pid $pid to yield its startup sidecar reader lock" >&2
      fi
    fi
  done < <(exec 8>&- 9>&-; __pc_sidecar_lock_pids "$lock_path" "$lockdir")
}

__pc_report_sidecar_lock_timeout() {
  local lock_path="$1"
  local lockdir="${2:-}"
  local wait_sec="${3:-$SIDECAR_LOCK_WAIT}"
  echo "FATAL: timed out after ${wait_sec}s waiting for the sidecar lock ($lock_path)." >&2
  echo "       A live reader or build still owns it; holder context follows." >&2
  __pc_sidecar_lock_holder_lines "$lock_path" "$lockdir"
  echo "       If the holder is tauri-guarded, it should yield on SIGUSR1; otherwise stop the holder or choose an isolated sidecar output." >&2
}

__pc_acquire_sidecar_read_lock() {
  local lock_path="$1"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$lock_path"
    if flock -s -n 9; then
      return 0
    fi
    echo "→ sidecar writer is active; waiting before reading $lock_path"
    if flock -s -w "$SIDECAR_LOCK_WAIT" 9; then
      return 0
    fi
    __pc_report_sidecar_lock_timeout "$lock_path" "" "$SIDECAR_LOCK_WAIT"
    return 5
  fi

  # macOS has no shared flock mode. Use the same mutex directory as writers;
  # this serializes readers there, but still prevents a package from copying a
  # half-published sidecar member.
  local lockdir="${lock_path}dir"
  local deadline=$(( $(date +%s) + SIDECAR_LOCK_WAIT ))
  local holder
  while ! mkdir "$lockdir" 2>/dev/null; do
    holder="$(cat "$lockdir/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$lockdir"
      continue
    fi
    if (( $(date +%s) >= deadline )); then
      __pc_report_sidecar_lock_timeout "$lock_path" "$lockdir" "$SIDECAR_LOCK_WAIT"
      return 5
    fi
    sleep 1
  done
  echo "$$" > "$lockdir/pid"
  SIDECAR_READ_LOCKDIR="$lockdir"
}

__pc_release_sidecar_read_lock() {
  if command -v flock >/dev/null 2>&1; then
    flock -u 9 || true
    exec 9>&-
  elif [[ -n "${SIDECAR_READ_LOCKDIR:-}" ]]; then
    rm -rf "$SIDECAR_READ_LOCKDIR"
    SIDECAR_READ_LOCKDIR=""
  fi
}

__pc_acquire_sidecar_flock() {
  local lock_path="$1"
  if flock -n 9; then
    return 0
  fi

  echo "→ sidecar lock is busy; allowing readers ${SIDECAR_READER_YIELD_AFTER}s to finish startup before requesting a cooperative yield"
  ((SIDECAR_READER_YIELD_AFTER == 0)) || sleep "$SIDECAR_READER_YIELD_AFTER"
  __pc_request_cooperative_reader_yield "$lock_path"
  if flock -w "$SIDECAR_LOCK_WAIT" 9; then
    return 0
  fi

  __pc_report_sidecar_lock_timeout "$lock_path"
  return 5
}
