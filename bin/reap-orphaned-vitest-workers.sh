#!/usr/bin/env bash
# bin/reap-orphaned-vitest-workers.sh
#
# Reap orphaned vitest fork-pool worker processes (EI-18686031108193522).
#
# WHY: vitest's default 'forks'/'vmForks' pool spawns each worker as a
# SEPARATE OS process (node_modules/vitest/dist/workers/{forks,vmForks}.js),
# not a worker_thread. When the vitest CLI process that owns them is
# SIGKILLed — a harness/heavy-command timeout, an admission-guard abort, a
# `run_in_background` task reaped, or an agent session ending mid-suite — the
# workers are never signaled (SIGKILL cannot be trapped, so the parent gets no
# chance to tear them down) and are reparented to whatever this host's
# subreaper is (measured here: `systemd --user`, not always PID 1 — see the
# ppid-liveness check below, which is why this does NOT hardcode ppid==1 the
# way the webkit reaper does). Measured 2026-07-26: 8 such workers alive 24h+,
# up to 6.7 days, holding ~600MB combined RSS with 0.0% CPU each (a pure
# leak, NOT a load contributor — see the filed issue for why that distinction
# matters and should not be re-litigated here).
#
# Mirrors bin/reap-leaked-webviews.sh's posture for the same underlying class
# of problem (a 3rd-party process-spawning library that doesn't clean up after
# an abrupt parent death) and papercup-webkit-reaper.{service,timer}'s
# installation shape. Detection + reaping only — this does not (and cannot)
# patch vitest's own worker entrypoints to self-exit on parent death
# (PR_SET_PDEATHSIG): those files live in node_modules and get overwritten by
# every `npm install`, so any patch would be silently lost — a sweeper is the
# durable side of this fix, mirroring the webkit reaper's own precedent of
# reaping rather than patching a vendored dependency's internals.
#
# Safety contract:
#   - A worker is a REAP CANDIDATE only if its cmdline names a
#     node_modules/vitest/dist/workers/{forks,vmForks}.js entrypoint.
#   - LIVE-PARENT CHECK (not a bare ppid==1/PID-1 check — this host's
#     subreaper is `systemd --user`, confirmed via /proc walk, and could
#     differ on another box): read the worker's real PPID from
#     /proc/<pid>/stat, then read THAT process's own cmdline. If the parent
#     is alive AND its cmdline itself mentions "vitest" (the CLI/pool
#     director that legitimately owns this worker), the worker is left alone
#     — no exceptions, regardless of age. Only when the parent is dead, or
#     alive but NOT a vitest process (i.e. reparented to the subreaper), is
#     the worker considered orphaned.
#   - AGE THRESHOLD: an orphaned worker younger than ORPHAN_THRESHOLD_SECS
#     (default 300s = 5 min) is skipped — the same grace window the webkit
#     reaper gives, in case of a benign reparenting race right at process
#     exit.
#   - TERM first, KILL only if it's still alive after a short grace period
#     (mirrors reap-leaked-webviews.sh).
#
# Run every 5 min via the papercup-vitest-orphan-reaper.timer systemd user
# timer (see apps/operator/scripts/systemd/README.md). Deliberately a systemd
# timer, NOT a DBOS scheduled workflow / in-process operator tick — this is a
# dev-box host-level process leak (infra hygiene, not product), the same
# reasoning as papercup-webkit-reaper.service.
#
# Environment overrides:
#   VITEST_REAPER_ORPHAN_THRESHOLD   seconds before an orphaned worker is
#                                    eligible for reaping (default: 300 = 5 min)
#   VITEST_REAPER_DRY_RUN            set to 1 to log without killing anything

set -uo pipefail

ORPHAN_THRESHOLD_SECS="${VITEST_REAPER_ORPHAN_THRESHOLD:-300}"
DRY_RUN="${VITEST_REAPER_DRY_RUN:-0}"

log() { echo "[vitest-orphan-reaper] $(date -Iseconds) $*"; }

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

    # /proc/pid/stat field 22 = starttime in clock ticks since boot. The comm
    # field (2) is parenthesized and may itself contain spaces/parens, so
    # parse from the right: strip through ") " to drop it safely, then field
    # 20 of what remains (starttime after the 2-field strip).
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
    sed 's/.*) //' "$stat_file" | awk '{print $2}'
}

proc_cmdline() {
    local pid="$1"
    local f="/proc/$pid/cmdline"
    [ -f "$f" ] || return 1
    tr '\0' ' ' < "$f"
}

killed=0
skipped_young=0
skipped_live_parent=0
checked=0

# Find candidate worker PIDs via /proc/*/cmdline (avoids depending on `ps`
# column widths/truncation for a long node invocation).
while IFS= read -r wpid; do
    [ -z "$wpid" ] && continue
    checked=$(( checked + 1 ))

    ppid=$(proc_ppid "$wpid" 2>/dev/null) || continue
    et=$(proc_etimes "$wpid" 2>/dev/null) || continue

    parent_cmd=""
    if [ -n "$ppid" ] && kill -0 "$ppid" 2>/dev/null; then
        parent_cmd=$(proc_cmdline "$ppid" 2>/dev/null || true)
    fi

    # A live parent whose OWN cmdline mentions vitest is the legitimate
    # CLI/pool director — this worker is not orphaned, no matter its age.
    if [ -n "$parent_cmd" ] && [[ "$parent_cmd" == *vitest* ]]; then
        skipped_live_parent=$(( skipped_live_parent + 1 ))
        continue
    fi

    if [ "$et" -lt "$ORPHAN_THRESHOLD_SECS" ]; then
        log "SKIP orphaned vitest worker pid=$wpid ppid=$ppid (too young: ${et}s < ${ORPHAN_THRESHOLD_SECS}s)"
        skipped_young=$(( skipped_young + 1 ))
        continue
    fi

    log "REAP orphaned vitest worker pid=$wpid (ppid=$ppid, running=${et}s, parent_alive=$([ -n "$parent_cmd" ] && echo yes || echo no))"
    do_kill "$wpid" TERM "orphaned vitest worker"
    sleep 1
    if kill -0 "$wpid" 2>/dev/null; then
        do_kill "$wpid" KILL "orphaned vitest worker (escalated)"
    fi
    killed=$(( killed + 1 ))
done < <(
    for cmdline_file in /proc/[0-9]*/cmdline; do
        # Check readability BEFORE opening — a PID can exit between the glob
        # expanding and the read, and `< file` failing prints bash's own
        # "No such file" straight to stderr (its redirection is set up before
        # the trailing `2>/dev/null` on the same line takes effect), so a
        # bare `2>/dev/null` on the read does not suppress that race noise.
        [ -r "$cmdline_file" ] || continue
        cmd=$(tr '\0' ' ' < "$cmdline_file" 2>/dev/null) || continue
        [[ "$cmd" == *"node_modules/vitest/dist/workers/forks.js"* || "$cmd" == *"node_modules/vitest/dist/workers/vmForks.js"* ]] || continue
        pid="${cmdline_file%/cmdline}"; pid="${pid#/proc/}"
        echo "$pid"
    done
)

log "Summary: checked=$checked killed=$killed skipped_live_parent=$skipped_live_parent skipped_young=$skipped_young"
