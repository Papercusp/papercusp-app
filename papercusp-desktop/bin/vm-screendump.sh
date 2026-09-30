#!/usr/bin/env bash
# Run on the HOST. One-shot QEMU **HMP monitor** screendump — the safe counterpart
# to mac-vm-screenshot.sh (which speaks QMP to the macOS VM). Default target is the
# Windows dev VM (-name papercusp-win11); --vm points it at any HMP-monitor VM,
# including the linux-test-vm rig.
#
# ── WHY THIS EXISTS (EI-20093096699900811) ───────────────────────────────────
# There was no helper, so every agent hand-rolled the raw form — and the raw form
# has a trap that DESTROYS THE VM:
#
#     printf 'screendump /tmp/out.ppm\nquit\n' | socat - UNIX-CONNECT:qemu-monitor.sock
#                                       ^^^^ ← exits the EMULATOR, not the monitor
#
# `quit` on the HMP monitor is not "close my connection", it is "exit qemu". It is
# a natural thing to append because the documented form (no timeout) otherwise
# appears to HANG on the still-open socket — so the obvious repair for the hang is
# the one that kills the VM. Measured 2026-08-10: the .ppm was written, exit was 0,
# nothing in the command's own output said anything was wrong, and the Windows VM
# had taken an unclean power-off (state Zl, :2223 refusing, qcow2 lock released).
#
# This script fixes the hang WITHOUT the trap: `socat -T` half-close timeout plus an
# outer `timeout` backstop. It sends EXACTLY ONE monitor command, `screendump`, and
# nothing else — that is the invariant apps/operator/lib/vm-screendump-no-quit.test.ts
# pins, so it cannot regress back into the dangerous form.
#
# Two further traps this avoids, both measured in the same session:
#
#   * THE SOCKET PATH IS RIG-SPECIFIC, and the tree already spells it two ways. The
#     launcher opens "$PWD/qemu-monitor.sock", so the path depends on where the VM was
#     booted from: vm-preflight.sh hardcodes /mnt/data/offload/windows-vm/..., the
#     agent-insights doc says ~/windows-vm/... . Those happen to be the same inode
#     TODAY only because ~/windows-vm is a symlink (measured 2026-09-05) — which is a
#     coincidence of this box, not a contract. Deriving the path from the running
#     qemu's own -monitor argv cannot drift with either spelling, and needs no default
#     to be maintained (--socket still overrides for an unusual rig).
#
#   * THE LAUNCHER'S $! IS NOT QEMU'S PID. The windows launcher backgrounds a wrapper,
#     so polling $! returns empty uptime and reads as "the VM died" while it is healthy.
#     We resolve the process by NAME PATTERN instead, and report it, so a failed capture
#     says which of "no VM" / "no socket" / "monitor refused" actually happened.
#
# Usage:
#   vm-screendump.sh [output.png]
#   vm-screendump.sh --out shot.png --vm 'qemu-system.*papercusp-win11'
#   vm-screendump.sh --socket /path/to/qemu-monitor.sock
#
#   --out PATH        output PNG (default /tmp/vm-screendump-<vm>-<timestamp>.png)
#   --vm PATTERN      pgrep -f pattern selecting the qemu process
#                     (default 'qemu-system.*papercusp-win11' — the Windows dev VM)
#   --socket PATH     explicit HMP monitor socket; skips process/argv derivation
#   --ppm-dir DIR     where the intermediate .ppm is written (default /tmp).
#                     ⚠ QEMU ITSELF writes this file, so it must be writable by the
#                     qemu process, not merely by you.
#   --keep-ppm        keep the intermediate .ppm beside the .png
#   --timeout SEC     hard backstop for the monitor exchange (default 15)
#   --settle SEC      socat half-close/inactivity timeout (default 3) — this is what
#                     makes the common case return in ~3s instead of hanging
#
# Env equivalents: VM_SCREENDUMP_VM_PATTERN, VM_MONITOR_SOCKET, PC_SOCAT.
#
# Exit codes: 0 captured · 1 usage/dependency error · 2 no VM process ·
#             3 no monitor socket · 4 monitor exchange produced no image.

set -euo pipefail

DEFAULT_VM_PATTERN='qemu-system.*papercusp-win11'

VM_PATTERN="${VM_SCREENDUMP_VM_PATTERN:-$DEFAULT_VM_PATTERN}"
MONITOR_SOCKET="${VM_MONITOR_SOCKET:-}"
SOCAT_BIN="${PC_SOCAT:-socat}"
OUT_PNG=""
PPM_DIR="/tmp"
KEEP_PPM=0
HARD_TIMEOUT=15
SETTLE=3

die() { echo "vm-screendump.sh: $1" >&2; exit "${2:-1}"; }

usage() { sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_PNG="${2:-}"; shift 2 ;;
    --vm) VM_PATTERN="${2:-}"; shift 2 ;;
    --socket) MONITOR_SOCKET="${2:-}"; shift 2 ;;
    --ppm-dir) PPM_DIR="${2:-}"; shift 2 ;;
    --keep-ppm) KEEP_PPM=1; shift ;;
    --timeout) HARD_TIMEOUT="${2:-}"; shift 2 ;;
    --settle) SETTLE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *)
      [[ -n "$OUT_PNG" ]] && die "output path given twice ($OUT_PNG, $1)"
      OUT_PNG="$1"; shift ;;
  esac
done

for dep in "$SOCAT_BIN" timeout; do
  command -v "$dep" >/dev/null 2>&1 || die "$dep not found (needed to speak to the HMP monitor)"
done

# ── resolve the qemu process ─────────────────────────────────────────────────
# Self-match is the trap here: pgrep -f matches the FULL command line, and this
# script's argv contains $VM_PATTERN verbatim (it was passed as an argument), so an
# unguarded pgrep matches ITSELF and reports a VM that is not there.
#
# Excluding $$/$PPID is NOT sufficient — measured 2026-09-05 while building this: a
# COMMAND-SUBSTITUTION SUBSHELL has its own pid, is neither $$ nor $PPID, and sailed
# straight through that guard, so `--vm 'qemu-system.*no-such-vm-xyz'` "found" a VM.
# So filter on IDENTITY instead of on pids: keep only candidates whose argv[0] is
# actually a qemu binary. A bash/pgrep/subshell self-match cannot pass that by
# construction, whatever its pid, and it also survives the race where a matched
# process exits before we can read its /proc entry.
qemu_pid=""
while read -r cand; do
  [[ -n "$cand" && -r "/proc/$cand/cmdline" ]] || continue
  cand_argv0="$(tr '\0' '\n' < "/proc/$cand/cmdline" 2>/dev/null | head -n1 || true)"
  [[ "${cand_argv0##*/}" == qemu-* ]] || continue
  qemu_pid="$cand"
  break
done < <(pgrep -f "$VM_PATTERN" 2>/dev/null || true)

if [[ -z "$MONITOR_SOCKET" ]]; then
  [[ -n "$qemu_pid" ]] || die "no qemu process matches /$VM_PATTERN/ — the VM is not running (override with --vm, or point at a socket with --socket)" 2

  # Derive the monitor socket from the process that actually owns it. `-monitor` and
  # its value are separate argv entries: unix:<path>[,server,nowait]. Match on the
  # POSITION (the entry after -monitor) rather than on the path containing the word
  # "monitor" — a socket named /run/mon.sock is still the monitor socket.
  qemu_argv="$(tr '\0' '\n' < "/proc/$qemu_pid/cmdline" 2>/dev/null || true)"
  MONITOR_SOCKET="$(
    printf '%s\n' "$qemu_argv" |
      awk 'prev=="-monitor" && /^unix:/ { sub(/^unix:/,""); sub(/,.*$/,""); print; exit } { prev=$0 }'
  )"
  # Fallback for rigs that wire the monitor through -chardev socket,path=...,id=mon.
  if [[ -z "$MONITOR_SOCKET" ]]; then
    MONITOR_SOCKET="$(
      printf '%s\n' "$qemu_argv" |
        awk '/^chardev socket/ || /^socket,/ { if (match($0, /path=[^,]+/)) { print substr($0, RSTART+5, RLENGTH-5); exit } }'
    )"
  fi
  [[ -n "$MONITOR_SOCKET" ]] ||
    die "qemu pid $qemu_pid is running but exposes no -monitor unix: socket in its argv — pass --socket explicitly" 3
fi

[[ -S "$MONITOR_SOCKET" ]] || die "no HMP monitor socket at $MONITOR_SOCKET" 3
[[ -d "$PPM_DIR" && -w "$PPM_DIR" ]] || die "ppm directory is not writable: $PPM_DIR"

stamp="$(date +%Y%m%d-%H%M%S)"
OUT_PNG="${OUT_PNG:-/tmp/vm-screendump-$stamp.png}"
TMP_PPM="$(mktemp "$PPM_DIR/vm-screendump-$stamp-XXXXXX.ppm")"
# QEMU must be able to overwrite this path; mktemp creates it 0600 under our uid,
# which is right for the same-user case and the reason --ppm-dir exists otherwise.
cleanup() { [[ "$KEEP_PPM" == "1" ]] || rm -f "$TMP_PPM"; }
trap cleanup EXIT

# ── the one and only monitor command ─────────────────────────────────────────
# ONLY `screendump`. Never `quit` (exits the emulator), never `cont`/`stop`/`system_*`
# — a capture is a READ, and mutating monitor commands belong in an explicitly
# supervised operation, not a screenshot helper.
#
# Bounding is what removes the temptation to append `quit`: -T closes the half-open
# connection $SETTLE seconds after our stdin EOF, and `timeout` is the hard backstop
# if the monitor never answers at all.
monitor_rc=0
printf 'screendump %s\n' "$TMP_PPM" |
  timeout "$HARD_TIMEOUT" "$SOCAT_BIN" -T "$SETTLE" - "UNIX-CONNECT:$MONITOR_SOCKET" \
  >/dev/null 2>&1 || monitor_rc=$?

# The ARTIFACT is authoritative, not socat's exit status: some QEMU builds hold the
# monitor connection open, so socat legitimately exits non-zero on the -T half-close
# after a perfectly successful capture (vm-preflight.sh reaches the same conclusion).
if [[ ! -s "$TMP_PPM" ]]; then
  echo "vm-screendump.sh: monitor produced no image (socat rc=$monitor_rc) via $MONITOR_SOCKET" >&2
  if [[ -n "$qemu_pid" ]]; then
    echo "  qemu pid $qemu_pid IS running and matched /$VM_PATTERN/ — the monitor, not the VM, is the problem." >&2
  else
    echo "  no qemu process matched /$VM_PATTERN/ — the socket file is most likely a leftover from a VM" >&2
    echo "  that has already exited (the file outlives the process). Check with --vm, or drop --socket to" >&2
    echo "  let this script derive the live VM's own monitor path." >&2
  fi
  exit 4
fi

# ── ppm -> png ───────────────────────────────────────────────────────────────
if command -v convert >/dev/null 2>&1 && convert "$TMP_PPM" "$OUT_PNG" >/dev/null 2>&1 && [[ -s "$OUT_PNG" ]]; then
  :
elif command -v pnmtopng >/dev/null 2>&1 && pnmtopng "$TMP_PPM" >"$OUT_PNG" 2>/dev/null && [[ -s "$OUT_PNG" ]]; then
  :
else
  KEEP_PPM=1
  rm -f "$OUT_PNG"
  echo "vm-screendump.sh: captured $TMP_PPM but no usable PPM->PNG converter (install ImageMagick 'convert' or netpbm 'pnmtopng')" >&2
  echo "$TMP_PPM"
  exit 0
fi

[[ "$KEEP_PPM" == "1" ]] && echo "vm-screendump.sh: kept $TMP_PPM" >&2
echo "vm-screendump.sh: wrote $OUT_PNG (vm pid ${qemu_pid:-unknown}, monitor $MONITOR_SOCKET)" >&2
echo "$OUT_PNG"
