#!/usr/bin/env bash
# bin/reap-leaked-webviews.sh
#
# Reap runaway WebKitWebProcess / papercusp-desktop instances from
# leaked/crashed test desktop sessions (WI-345 F12).
#
# WHY: Multiple papercusp-desktop Tauri instances are spawned by agents doing
# UI verification (agent-e2e playbook). When they're killed abruptly (SIGKILL
# from an agent exiting, a crash, or the tauri-dev watcher rebuilding), their
# WebKitWebProcess children (spawned by WebKitGTK) get reparented to PID 1 as
# orphans. Those orphans continue spinning at 99% CPU on dead connections.
# No automatic cleanup existed. This script is the missing reaper.
#
# Safety contract:
#   - The NEWEST papercusp-desktop process (by start time) is treated as
#     the active user desktop and is NEVER killed.  All older instances
#     running > DESKTOP_STALE_SECS are stale test instances → reap them
#     and their WebKitWebProcess children.
#   - Orphaned WebKitWebProcess (ppid=1, Tauri parent dead) older than
#     ORPHAN_THRESHOLD_SECS are always safe to kill — their parent is gone.
#   - WebKitWebProcess under the newest papercusp-desktop are NEVER touched.
#   - Zombie (defunct) processes: we SIGCHLD their live parents to prompt
#     waitpid(); we never kill the parent itself.
#   - We do NOT call waitpid(-1, WNOHANG) from Rust because GLib uses
#     signalfd for SIGCHLD on Linux — a global waitpid() from a background
#     thread would race with GLib's per-child watchers, potentially stealing
#     zombie exit status before GLib can record it.
#
# Run every 5 min via the papercup-webkit-reaper.timer systemd user timer.
# Deliberately a systemd timer, NOT a DBOS scheduled workflow (d-004).
#
# Environment overrides:
#   WEBKIT_REAPER_ORPHAN_THRESHOLD   seconds before an orphaned WebKitWebProcess
#                                    is eligible for reaping (default: 300 = 5 min)
#   WEBKIT_REAPER_DESKTOP_STALE      seconds before a non-newest papercusp-desktop
#                                    is treated as stale (default: 1800 = 30 min)
#   WEBKIT_REAPER_DRY_RUN            set to 1 to log without killing anything

set -uo pipefail

ORPHAN_THRESHOLD_SECS="${WEBKIT_REAPER_ORPHAN_THRESHOLD:-300}"
DESKTOP_STALE_SECS="${WEBKIT_REAPER_DESKTOP_STALE:-1800}"
DRY_RUN="${WEBKIT_REAPER_DRY_RUN:-0}"

log() { echo "[webkit-reaper] $(date -Iseconds) $*"; }

do_kill() {
    local pid="$1" sig="${2:-TERM}" label="${3:-}"
    if [ "$DRY_RUN" = "1" ]; then
        log "  DRY-RUN: kill -$sig $pid  [$label]"
        return 0
    fi
    kill -"$sig" "$pid" 2>/dev/null && log "  killed (SIG$sig) pid=$pid [$label]" || true
}

# Read elapsed seconds for a PID from /proc (more reliable than ps for scripting).
proc_etimes() {
    local pid="$1"
    local stat_file="/proc/$pid/stat"
    local uptime_file="/proc/uptime"
    [ -f "$stat_file" ] && [ -f "$uptime_file" ] || return 1

    local uptime_secs
    uptime_secs=$(awk '{print int($1)}' "$uptime_file") || return 1

    # /proc/pid/stat field 22 = starttime in clock ticks since boot.
    # The process name (field 2) is enclosed in parens and may contain spaces/parens,
    # so we must parse from the right: strip everything up to and including ") " to
    # remove the name field safely, then grab field 20 (starttime after the name strip).
    local starttime_ticks
    starttime_ticks=$(sed 's/.*) //' "$stat_file" | awk '{print $20}') || return 1
    [ -n "$starttime_ticks" ] || return 1

    local clk_tck
    clk_tck=$(getconf CLK_TCK 2>/dev/null || echo 100)

    local starttime_secs
    starttime_secs=$(( starttime_ticks / clk_tck ))
    echo $(( uptime_secs - starttime_secs ))
}

proc_ppid() {
    local pid="$1"
    local stat_file="/proc/$pid/stat"
    [ -f "$stat_file" ] || return 1
    # After stripping the name field (pid comm → everything up to ") "), ppid is field 2.
    sed 's/.*) //' "$stat_file" | awk '{print $2}'
}

# ── Step 1: papercusp-desktop instances ─────────────────────────────────────
# Collect all PIDs and their elapsed times; protect the newest (smallest etimes).

declare -A desktop_et  # pid → elapsed seconds
declare -a desktop_by_age  # sorted: oldest first (descending etimes)

while IFS= read -r dpid; do
    [ -z "$dpid" ] && continue
    et=$(proc_etimes "$dpid") || continue
    desktop_et[$dpid]=$et
done < <(pgrep -x papercusp-desktop 2>/dev/null || true)

# Sort by etimes descending (oldest first).
mapfile -t desktop_by_age < <(
    for pid in "${!desktop_et[@]}"; do
        printf '%s %s\n' "${desktop_et[$pid]}" "$pid"
    done | sort -rn | awk '{print $2}'
)

# The newest is the last element (smallest etimes = started most recently).
newest_desktop_pid=""
if [ "${#desktop_by_age[@]}" -gt 0 ]; then
    newest_desktop_pid="${desktop_by_age[-1]}"
    log "Protected (newest) papercusp-desktop: pid=$newest_desktop_pid (running ${desktop_et[$newest_desktop_pid]}s)"
fi

killed_desktops=0
for dpid in "${desktop_by_age[@]}"; do
    [ "$dpid" = "$newest_desktop_pid" ] && continue

    et="${desktop_et[$dpid]}"
    if [ "$et" -lt "$DESKTOP_STALE_SECS" ]; then
        log "SKIP old desktop pid=$dpid (running ${et}s, below ${DESKTOP_STALE_SECS}s threshold)"
        continue
    fi

    log "REAP stale papercusp-desktop pid=$dpid (running ${et}s > ${DESKTOP_STALE_SECS}s)"

    # Kill its WebKitWebProcess children first so they don't briefly orphan.
    while IFS= read -r child_pid; do
        [ -z "$child_pid" ] && continue
        child_comm=$(cat "/proc/$child_pid/comm" 2>/dev/null || true)
        [[ "$child_comm" == WebKitWebProces* ]] || continue
        log "  REAP child WebKitWebProcess pid=$child_pid (parent stale desktop $dpid)"
        do_kill "$child_pid" TERM "child WebKitWebProcess of stale desktop"
        sleep 0.5
        kill -0 "$child_pid" 2>/dev/null && do_kill "$child_pid" KILL "child WebKitWebProcess (escalated)" || true
    done < <(ps --ppid "$dpid" -o pid= 2>/dev/null || true)

    do_kill "$dpid" TERM "stale papercusp-desktop"
    sleep 3
    if kill -0 "$dpid" 2>/dev/null; then
        do_kill "$dpid" KILL "stale papercusp-desktop (escalated)"
    fi
    killed_desktops=$(( killed_desktops + 1 ))
done

# ── Step 2: Orphaned WebKitWebProcess instances (ppid=1) ────────────────────
# These are children of dead Tauri processes; their parent is definitively gone.

killed_webkit=0
skipped_webkit=0

while IFS= read -r wpid; do
    [ -z "$wpid" ] && continue

    ppid=$(proc_ppid "$wpid" 2>/dev/null) || { skipped_webkit=$(( skipped_webkit + 1 )); continue; }
    et=$(proc_etimes "$wpid" 2>/dev/null) || { skipped_webkit=$(( skipped_webkit + 1 )); continue; }

    # Never touch children of the protected (newest) desktop.
    if [ "$ppid" = "$newest_desktop_pid" ]; then
        skipped_webkit=$(( skipped_webkit + 1 ))
        continue
    fi

    # If the parent is any still-alive process (other than the killed stale desktops),
    # skip — we only target definitively orphaned processes here.
    if [ -n "$ppid" ] && [ "$ppid" != "1" ] && kill -0 "$ppid" 2>/dev/null; then
        log "SKIP WebKitWebProcess pid=$wpid (parent $ppid still alive)"
        skipped_webkit=$(( skipped_webkit + 1 ))
        continue
    fi

    # Age check: don't reap freshly orphaned instances — give them time to
    # self-terminate if they notice the connection is gone.
    if [ "$et" -lt "$ORPHAN_THRESHOLD_SECS" ]; then
        log "SKIP orphaned WebKitWebProcess pid=$wpid (too young: ${et}s < ${ORPHAN_THRESHOLD_SECS}s)"
        skipped_webkit=$(( skipped_webkit + 1 ))
        continue
    fi

    log "REAP orphaned WebKitWebProcess pid=$wpid (ppid=$ppid, running=${et}s)"
    do_kill "$wpid" TERM "orphaned WebKitWebProcess"
    sleep 1
    if kill -0 "$wpid" 2>/dev/null; then
        do_kill "$wpid" KILL "orphaned WebKitWebProcess (escalated)"
    fi
    killed_webkit=$(( killed_webkit + 1 ))
done < <(
    # Find WebKitWebProcess PIDs via /proc/*/comm (15-char comm is "WebKitWebProces").
    for comm_file in /proc/[0-9]*/comm; do
        comm=$(cat "$comm_file" 2>/dev/null) || continue
        [[ "$comm" == WebKitWebProces* ]] || continue
        pid="${comm_file%/comm}"; pid="${pid#/proc/}"
        echo "$pid"
    done
)

# ── Step 3: Zombie reporting + SIGCHLD nudge ────────────────────────────────
# We cannot kill zombie processes (they're already exited), but we can nudge
# their live parents to call waitpid() and harvest the exit status.

zombie_count=0
declare -A nudged_parents  # avoid sending SIGCHLD twice to the same parent

while IFS=' ' read -r zpid zppid zstat; do
    [[ "$zstat" == Z* ]] || continue
    zombie_count=$(( zombie_count + 1 ))
    if [ -z "${nudged_parents[$zppid]+x}" ]; then
        log "ZOMBIE pid=$zpid ppid=$zppid — nudging parent $zppid with SIGCHLD"
        kill -CHLD "$zppid" 2>/dev/null || true
        nudged_parents[$zppid]=1
    fi
done < <(ps -eo pid=,ppid=,stat= 2>/dev/null | awk '{gsub(/[[:space:]]+/, " "); print}')

log "Summary: killed_desktops=$killed_desktops killed_webkit=$killed_webkit skipped=$skipped_webkit zombies=$zombie_count"
