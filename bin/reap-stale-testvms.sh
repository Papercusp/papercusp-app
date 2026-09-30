#!/usr/bin/env bash
# bin/reap-stale-testvms.sh
#
# Reap stale `papercusp-testvm-*` QEMU VMs (EI-18792610532592319).
#
# WHY: papercusp-desktop/scripts/linux-test-vm/boot-vm.sh launches each VM
# `-daemonize`'d — it detaches from its own launcher immediately on boot, by
# design, whether the run that started it later tears down cleanly or not.
# vm-federation.sh / fed.sh DO already `trap cleanup EXIT` (fed_cleanup_scoped),
# but a trap cannot fire if the launching process is SIGKILLed (a harness
# timeout, an admission-guard abort, an agent session ending mid-run) — the
# daemonized qemu process is simply orphaned, reparented to this host's
# subreaper, and burns real CPU/RAM indefinitely with nothing to stop it.
# Measured 2026-07-27: two `papercusp-testvm-fed-{a,b}` frames alive 13.6h and
# 16.6h, ~1300% combined CPU, contributing to a sustained load1 ~85-90 that
# made `test:affected` auto-degrade into flake-absorbing retry fleet-wide
# (EI-9103) — a correctness cost to the whole fleet's verification, not just a
# speed cost. Mirrors bin/reap-orphaned-vitest-workers.sh's posture for the
# same underlying class of problem (a process-spawning workflow that doesn't
# guarantee teardown on an abrupt parent death) and
# papercup-vitest-orphan-reaper.{service,timer}'s installation shape.
#
# SCOPE: only qemu processes launched with `-name papercusp-testvm-<X>` (the
# exact marker boot-vm.sh stamps on every VM it boots — vmctl's "clean",
# "fed-a", "fed-b", "updater" instances plus any ad-hoc name). This can NEVER
# match the persistent mac (:2222) / Windows (:2223) build-and-test VMs
# (papercup-vm-mac.service / the Windows VM service) — those are launched by a
# different script with no `-name` flag at all, and are explicitly
# owner-sanctioned to stay running indefinitely (memory 648ac99a, [owner
# 2026-07-20]: "wants BOTH VMs to KEEP EXISTING for actually TESTING the
# app" — do not delete images, do not uninstall their services). This reaper
# is deliberately silent on that VM class; it does not even inspect it.
#
# Safety contract:
#   - A VM is a REAP CANDIDATE only if its cmdline carries
#     `-name papercusp-testvm-<X>`.
#   - LIVE-ORCHESTRATOR CHECK: before reaping anything, scan for a live
#     process whose cmdline names one of the known orchestrator scripts
#     (vm-federation.sh, scripts/linux-test-vm/fed.sh,
#     bin/live-federation-gate.sh, bin/two-instance-federation-smoke.sh). If
#     ANY is alive, the WHOLE sweep is skipped this tick and logged — an
#     active run may legitimately hold a VM open past the age threshold (the
#     gate's own systemd unit bounds a single run to 4h via TimeoutStartSec,
#     but an ad-hoc developer-driven session can run longer). The next timer
#     tick re-checks; this errs toward never touching another agent's
#     in-flight infrastructure (the same caution the filing issue itself
#     named for not killing anything on the spot).
#   - AGE THRESHOLD: a candidate younger than MAX_AGE_SECS (default 21600s =
#     6h — well past the gate's own 4h TimeoutStartSec bound, so a single
#     legitimate run should already have completed and torn itself down) is
#     skipped.
#   - Reap via `vmctl down <name>` first — the existing graceful-shutdown path
#     (in-guest `systemctl poweroff`, bounded wait, THEN escalate to SIGTERM
#     then SIGKILL, then clears the pidfile/monitor socket) — wrapped in a
#     hard `timeout` so a wedged guest can never hang this reaper. If vmctl
#     itself cannot be found/run for some reason, fall back to a direct
#     SIGTERM → (3s) → SIGKILL on the qemu pid, mirroring
#     reap-orphaned-vitest-workers.sh's own escalation.
#
# Run every 15 min via the papercup-testvm-reaper.timer systemd user timer
# (see apps/operator/scripts/systemd/README.md). Deliberately a systemd timer,
# NOT a DBOS scheduled workflow / in-process operator tick — this is a dev-box
# host-level process leak (infra hygiene, not product), the same reasoning as
# papercup-vitest-orphan-reaper.service / papercup-webkit-reaper.service.
#
# Environment overrides:
#   TESTVM_REAPER_MAX_AGE_SECS   seconds before a candidate VM is eligible for
#                                reaping (default: 21600 = 6h)
#   TESTVM_REAPER_DRY_RUN        set to 1 to log without killing/shutting
#                                anything down
#   TESTVM_REAPER_VMCTL_TIMEOUT  hard bound in seconds on the `vmctl down`
#                                attempt before falling back to a direct kill
#                                (default: 90)

set -uo pipefail

MAX_AGE_SECS="${TESTVM_REAPER_MAX_AGE_SECS:-21600}"
DRY_RUN="${TESTVM_REAPER_DRY_RUN:-0}"
VMCTL_TIMEOUT="${TESTVM_REAPER_VMCTL_TIMEOUT:-90}"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMCTL="$SELF_DIR/../papercusp-desktop/scripts/linux-test-vm/vmctl"

# Keep the strings that the census looks for in data variables rather than in
# the command text of a process-substitution/pipeline.  A shell launched to
# inspect /proc can otherwise expose the very marker it is looking for in its
# own argv, which makes a raw cmdline census report the inspector as a VM.
TESTVM_CMDLINE_MARKER='papercusp-testvm-'
ORCHESTRATOR_MARKERS=(
    'vm-federation.sh'
    'linux-test-vm/fed.sh'
    'live-federation-gate.sh'
    'two-instance-federation-smoke.sh'
)
# Populated lazily per Bash process.  A host-level census can see thousands of
# PIDs; walking the same short parent chain once per PID turns a cheap filter
# into a fork storm under load.
declare -A REAPER_EXCLUDED_PIDS=()
REAPER_ANCESTRY_ROOT=''

log() { echo "[testvm-reaper] $(date -Iseconds) $*"; }

# ── /proc helpers (mirrors reap-orphaned-vitest-workers.sh) ────────────────
proc_etimes() {
    local pid="$1"
    local stat_file="/proc/$pid/stat"
    local uptime_file="/proc/uptime"
    [ -f "$stat_file" ] && [ -f "$uptime_file" ] || return 1
    local uptime_secs
    uptime_secs=$(awk '{print int($1)}' "$uptime_file") || return 1
    local starttime_ticks
    starttime_ticks=$(sed 's/.*) //' "$stat_file" | awk '{print $20}') || return 1
    [ -n "$starttime_ticks" ] || return 1
    local clk_tck
    clk_tck=$(getconf CLK_TCK 2>/dev/null || echo 100)
    local starttime_secs=$(( starttime_ticks / clk_tck ))
    echo $(( uptime_secs - starttime_secs ))
}

proc_cmdline() {
    local pid="$1"
    local f="/proc/$pid/cmdline"
    [ -f "$f" ] || return 1
    local arg out=''
    # Bash can read NUL-delimited argv entries directly.  Spawning `tr` once
    # per /proc entry made the host-level census fork-heavy enough to look
    # stalled under fleet load.
    while IFS= read -r -d '' arg; do
        [ -n "$out" ] && out+=" "
        out+="$arg"
    done < "$f"
    printf '%s\n' "$out"
}

# Read a process's real parent from /proc/<pid>/stat.  The comm field is
# parenthesized and may contain spaces/parens, so strip through the final ") "
# before taking field 2 (the ppid field in the remainder).
proc_ppid() {
    local pid="$1"
    local stat_file="/proc/$pid/stat"
    [ -f "$stat_file" ] || return 1
    awk '{sub(/^.*\) /, ""); print $2}' "$stat_file"
}

# A match in the reaper's own process tree is not external activity.  This is
# the Bash equivalent of scripts/proc-guard.mjs's ancestor-chain exclusion: the
# timer may itself be launched from `bash -c '<command containing the marker>'`,
# and the wrapper's argv is then visible to the census.  Walk by PPID instead of
# relying on a fixed parent (systemd/user subreapers vary between hosts).  The
# result is cached for this Bash process because this predicate runs once per
# /proc entry.
proc_cache_self_ancestry() {
    local root="${BASHPID:-$$}"
    [ "$REAPER_ANCESTRY_ROOT" = "$root" ] && return 0

    REAPER_EXCLUDED_PIDS=()
    local current="$root"
    local hops=0
    while [ -n "$current" ] && [ "$hops" -lt 512 ]; do
        REAPER_EXCLUDED_PIDS["$current"]=1
        [ "$current" = 1 ] && break
        current=$(proc_ppid "$current" 2>/dev/null) || break
        [ -n "$current" ] || break
        hops=$((hops + 1))
    done
    REAPER_ANCESTRY_ROOT="$root"
}

proc_is_self_or_ancestor() {
    local target="$1"
    proc_cache_self_ancestry
    [[ ${REAPER_EXCLUDED_PIDS["$target"]+set} ]]
}

# The marker is intentionally not enough to identify a VM: a peer's shell,
# prompt, or census command can mention it.  The real boot path starts argv[0]
# with qemu-system-* (or qemu-kvm); require that operational identity before
# accepting a -name papercusp-testvm-* token.
is_qemu_testvm_cmdline() {
    local cmd="$1"
    local -a argv=()
    read -r -a argv <<< "$cmd"
    [ "${#argv[@]}" -gt 0 ] || return 1

    local executable="${argv[0]##*/}"
    case "$executable" in
        qemu-system-*|qemu-kvm|qemu) ;;
        *) return 1 ;;
    esac
    [[ "$cmd" == *"$TESTVM_CMDLINE_MARKER"* ]] || return 1
    return 0
}

any_orchestrator_alive() {
    local cmdline_file cmd
    for cmdline_file in /proc/[0-9]*/cmdline; do
        [ -r "$cmdline_file" ] || continue
        local opid="${cmdline_file%/cmdline}"; opid="${opid#/proc/}"
        # The invoking shell (and any bash -c wrapper above it) is inspection
        # context, not evidence of a live federation run.
        proc_is_self_or_ancestor "$opid" && continue
        cmd=$(proc_cmdline "$opid" 2>/dev/null) || continue
        local marker
        for marker in "${ORCHESTRATOR_MARKERS[@]}"; do
            case "$cmd" in
                *"$marker"*)
                log "live orchestrator detected: pid=$opid cmd=${cmd:0:120}"
                return 0
                ;;
            esac
        done
    done
    return 1
}

# ── candidate discovery ──────────────────────────────────────────────────
# Extract "<X>" from a cmdline containing "-name papercusp-testvm-<X>".
vm_name_from_cmdline() {
    local cmd="$1" tok found=0
    for tok in $cmd; do
        if [ "$found" = 1 ]; then
            case "$tok" in
                papercusp-testvm-*) echo "${tok#papercusp-testvm-}"; return 0 ;;
                *) return 1 ;;
            esac
        fi
        [ "$tok" = "-name" ] && found=1
    done
    return 1
}

# Emit candidate PIDs for the reaper.  The marker is held in a variable and the
# helper excludes its own process/ancestor chain, so even when Bash implements
# this call through a process-substitution shell, inspection context cannot be
# reported as external VM activity.
candidate_vm_pids() {
    local cmdline_file cmd pid
    for cmdline_file in /proc/[0-9]*/cmdline; do
        [ -r "$cmdline_file" ] || continue
        pid="${cmdline_file%/cmdline}"; pid="${pid#/proc/}"
        proc_is_self_or_ancestor "$pid" && continue
        cmd=$(proc_cmdline "$pid" 2>/dev/null) || continue
        is_qemu_testvm_cmdline "$cmd" || continue
        echo "$pid"
    done
}

do_reap() {
    local pid="$1" name="$2"
    if [ "$DRY_RUN" = "1" ]; then
        log "  DRY-RUN: would reap $name (pid=$pid) via vmctl down"
        return 0
    fi
    if [ -x "$VMCTL" ] || [ -f "$VMCTL" ]; then
        log "  vmctl down $name (pid=$pid, bounded to ${VMCTL_TIMEOUT}s)"
        if timeout "$VMCTL_TIMEOUT" bash "$VMCTL" down "$name" 2>&1 | while IFS= read -r l; do log "    $l"; done; then
            if ! kill -0 "$pid" 2>/dev/null; then
                log "  $name down cleanly"
                return 0
            fi
        fi
        log "  vmctl down did not clear pid=$pid within ${VMCTL_TIMEOUT}s — escalating directly"
    else
        log "  vmctl not found at $VMCTL — falling back to direct kill"
    fi
    kill -TERM "$pid" 2>/dev/null && log "  sent SIGTERM to pid=$pid" || true
    sleep 3
    if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null && log "  sent SIGKILL to pid=$pid" || true
    fi
}

# ── main ─────────────────────────────────────────────────────────────────
# Wrapped so this file can be `source`d (functions only, no sweep) by a
# selftest — see reap-stale-testvms.selftest.sh.
main() {
    if any_orchestrator_alive; then
        log "a federation orchestrator script is live — skipping this sweep entirely (may legitimately hold VMs past the age threshold)"
        return 0
    fi

    local checked=0 reaped=0 skipped_young=0

    while IFS= read -r pid; do
        [ -z "$pid" ] && continue
        checked=$(( checked + 1 ))

        local cmd name et
        cmd=$(proc_cmdline "$pid" 2>/dev/null) || continue
        name=$(vm_name_from_cmdline "$cmd") || { log "SKIP pid=$pid — could not parse instance name from cmdline"; continue; }

        et=$(proc_etimes "$pid" 2>/dev/null) || continue
        if [ "$et" -lt "$MAX_AGE_SECS" ]; then
            skipped_young=$(( skipped_young + 1 ))
            continue
        fi

        log "REAP candidate: $name (pid=$pid, running=${et}s >= ${MAX_AGE_SECS}s, no live orchestrator)"
        do_reap "$pid" "$name"
        reaped=$(( reaped + 1 ))
    done < <(candidate_vm_pids)

    log "Summary: checked=$checked reaped=$reaped skipped_young=$skipped_young max_age_secs=$MAX_AGE_SECS"
}

# Only run the sweep when EXECUTED directly — a selftest sources this file to
# unit-test the functions above without triggering a live sweep.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main
fi
