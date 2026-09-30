#!/usr/bin/env bash
# scripts/shrink-swapfile.sh
#
# Shrink an oversized swapfile to reclaim its allocated disk, WITHOUT the OOM
# that a naive `swapoff` causes on this box (EI-20589765301078360).
#
# THE PROBLEM THIS SOLVES
# ----------------------
# /mnt/data/swapfile is allocated 2.0 TiB while only ~175 GiB is in use, on a
# volume that is 97% full. Reclaiming it requires `swapoff`, which must fault
# every swapped page back into RAM. Measured 2026-09-05: 175.2 GiB swapped vs
# 90 GiB available RAM — a bare `swapoff` OOMs the box and takes ~69 agents'
# uncommitted work with it.
#
# The original filing (2026-08-16) said "wait for a genuine quiet window". That
# is why it sat unexecuted for three weeks, and it rests on a false premise:
#
#   *** SWAP USAGE DOES NOT DECAY ON ITS OWN. ***
#
# Pages stay swapped until something touches them. An idle box can sit at
# 175 GiB swapped indefinitely, so the "quiet window" where swap_used naturally
# falls below available RAM may never arrive by luck. Waiting is not a plan.
#
# THE APPROACH
# ------------
# Do not wait for headroom — CREATE it. Bring a second swap device online on a
# volume with room (/mnt/backup, ext4, 1.1 TiB free) at a HIGHER priority, then
# swapoff the target. Pages faulted in by swapoff are re-reclaimed onto the
# staging device instead of piling up in RAM. The old file is then removed
# (reclaiming its full allocation), a right-sized swapfile is created in its
# place, and the staging device is drained back out and deleted.
#
# Net effect on the target volume: +~1.6 TiB (2.0 TiB removed, 384 GiB re-added).
#
# SAFETY CONTRACT (binding — do not weaken without a plan Decision)
# -----------------------------------------------------------------
#   - Dry-run by default. Nothing is created, removed or swapped off without
#     --execute.
#   - HARD PRECONDITION GATE, re-measured immediately before every destructive
#     phase (never once at startup — this box's memory state moves under you):
#       * staging free space  >= swap_used * STAGING_FACTOR   (default 1.5)
#       * available RAM       >= max(MIN_RAM_HEADROOM_G, swap_used * RAM_FACTOR)
#       * PSI memory full avg60 <= PSI_MAX
#     The gate is MEMORY-shaped, not load-shaped, because OOM is a memory
#     event. Load is reported and gated only advisorily (--max-load), because
#     a 69-agent box is never "quiet" by loadavg and gating on it reproduces
#     exactly the three-week stall this script exists to end.
#   - The gate FAILS CLOSED. Any measurement that cannot be read aborts.
#   - Resumable. Every phase is idempotent and the current phase is derived
#     from live system state (which swap devices are on, which files exist),
#     never from a stored cursor, so an interrupted run is safe to re-run.
#   - Test overrides (SWAPSHRINK_TEST_*) FORCE dry-run. Synthetic measurements
#     can never drive a destructive action.
#
# Usage:
#   scripts/shrink-swapfile.sh                 # dry-run: measure + report verdict
#   scripts/shrink-swapfile.sh --check         # gate verdict only, exit 0/1
#   scripts/shrink-swapfile.sh --execute       # do it (requires gate to pass)
#
# Exit codes: 0 ok/gate-open · 1 gate CLOSED (named reason) · 2 misuse/unreadable

set -uo pipefail

TARGET_SWAP="/mnt/data/swapfile"
STAGING_DIR="/mnt/backup"
STAGING_SWAP="${STAGING_DIR}/swapfile.shrink-staging"
NEW_SIZE_G=384
STAGING_MIN_G=256
STAGING_RESERVE_G=100   # never consume the staging volume below this
STAGING_FACTOR=15       # tenths: 1.5x swap_used
# RAM_FACTOR / MIN_RAM_HEADROOM_G are CALIBRATED, not guessed. An earlier draft
# used 25% / 16 GiB and the falsifiability controls caught it green-lighting the
# exact conditions this item filed as "would OOM the box (measured)" — 160.5 GiB
# swapped against 66 GiB available. A gate that passes the known-hazardous case
# is worse than no gate, so the floor is set to refuse it:
#   need = max(64 GiB, swap_used * 50%)  ->  filed case needs 80.2 GiB, had 66.0 -> CLOSED
# Do not loosen these without replaying that control (see the test file).
RAM_FACTOR=50           # percent of swap_used that must be free as RAM headroom
MIN_RAM_HEADROOM_G=64
PSI_MAX=20
MAX_LOAD=0              # 0 = advisory only
REQUIRE_STABLE_MIN=10   # gate must hold this long before a non-abortable migration
STABLE_INTERVAL_S=30
EXECUTE=0
CHECK_ONLY=0

usage() {
  cat <<'EOF'
Usage: shrink-swapfile.sh [--execute] [--check] [--new-size-g N] [--max-load N]

Shrinks an oversized swapfile by staging swap on another volume, so the
operation does not require waiting for a "quiet window" that may never come.
See the header comment in this file for the binding safety contract.

  --execute        Actually perform the migration. Default is dry-run.
  --check          Print the precondition verdict only; exit 1 if gate closed.
  --new-size-g N   Size of the replacement swapfile (default 384).
  --target PATH    Swapfile to shrink (default /mnt/data/swapfile).
  --staging-dir D  Volume to stage swap on (default /mnt/backup).
  --max-load N     Also refuse if 1-min loadavg exceeds N (default: advisory).
  --require-stable-min N
                   Before committing, require the gate to stay OPEN across N
                   minutes of repeated sampling (default 10). The migration is
                   NON-ABORTABLE and this box's memory state swings ~20% in
                   minutes, so a single point-in-time reading is not sufficient
                   evidence that the window will last. 0 disables (not advised).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --check) CHECK_ONLY=1 ;;
    --new-size-g) NEW_SIZE_G="${2:?}"; shift ;;
    --target) TARGET_SWAP="${2:?}"; shift ;;
    --staging-dir) STAGING_DIR="${2:?}"; STAGING_SWAP="${STAGING_DIR}/swapfile.shrink-staging"; shift ;;
    --max-load) MAX_LOAD="${2:?}"; shift ;;
    --require-stable-min) REQUIRE_STABLE_MIN="${2:?}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# --- test overrides force dry-run: synthetic input can never delete anything ---
SYNTHETIC=0
for v in SWAPSHRINK_TEST_SWAP_USED_KB SWAPSHRINK_TEST_MEM_AVAIL_KB \
         SWAPSHRINK_TEST_STAGING_FREE_KB SWAPSHRINK_TEST_PSI_FULL_AVG60 \
         SWAPSHRINK_TEST_LOAD1; do
  if [ -n "${!v:-}" ]; then SYNTHETIC=1; fi
done
if [ "$SYNTHETIC" = 1 ] && [ "$EXECUTE" = 1 ]; then
  echo "REFUSED: SWAPSHRINK_TEST_* overrides are set; --execute is not permitted with synthetic measurements." >&2
  exit 2
fi

die() { echo "ABORT: $*" >&2; exit 2; }

# ---------------------------------------------------------------- measurement
# Every reader fails closed: an unreadable measurement aborts rather than
# defaulting to a permissive value.

measure_swap_used_kb() {
  if [ -n "${SWAPSHRINK_TEST_SWAP_USED_KB:-}" ]; then echo "$SWAPSHRINK_TEST_SWAP_USED_KB"; return; fi
  local v
  v=$(awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{if(t=="")exit 1; print t-f}' /proc/meminfo 2>/dev/null) \
    || die "cannot read swap usage from /proc/meminfo"
  [ -n "$v" ] || die "cannot read swap usage from /proc/meminfo"
  echo "$v"
}

measure_mem_avail_kb() {
  if [ -n "${SWAPSHRINK_TEST_MEM_AVAIL_KB:-}" ]; then echo "$SWAPSHRINK_TEST_MEM_AVAIL_KB"; return; fi
  local v
  v=$(awk '/^MemAvailable:/{print $2; found=1} END{if(!found)exit 1}' /proc/meminfo 2>/dev/null) \
    || die "cannot read MemAvailable from /proc/meminfo"
  echo "$v"
}

measure_staging_free_kb() {
  if [ -n "${SWAPSHRINK_TEST_STAGING_FREE_KB:-}" ]; then echo "$SWAPSHRINK_TEST_STAGING_FREE_KB"; return; fi
  [ -d "$STAGING_DIR" ] || die "staging dir $STAGING_DIR does not exist"
  local v
  v=$(df -P --block-size=1K "$STAGING_DIR" 2>/dev/null | awk 'NR==2{print $4}') \
    || die "cannot stat staging volume $STAGING_DIR"
  [ -n "$v" ] || die "cannot stat staging volume $STAGING_DIR"
  echo "$v"
}

measure_psi_full_avg60() {
  if [ -n "${SWAPSHRINK_TEST_PSI_FULL_AVG60:-}" ]; then echo "$SWAPSHRINK_TEST_PSI_FULL_AVG60"; return; fi
  [ -r /proc/pressure/memory ] || die "cannot read /proc/pressure/memory (PSI unavailable)"
  local v
  v=$(awk '/^full/{for(i=1;i<=NF;i++) if($i ~ /^avg60=/){sub(/^avg60=/,"",$i); print $i; found=1}} END{if(!found)exit 1}' \
        /proc/pressure/memory 2>/dev/null) || die "cannot parse PSI memory full avg60"
  echo "$v"
}

measure_load1() {
  if [ -n "${SWAPSHRINK_TEST_LOAD1:-}" ]; then echo "$SWAPSHRINK_TEST_LOAD1"; return; fi
  awk '{print $1}' /proc/loadavg 2>/dev/null || die "cannot read /proc/loadavg"
}

g() { echo "scale=1; $1 / 1048576" | bc; }   # KiB -> GiB, one decimal

# ------------------------------------------------------------------- the gate
# Returns 0 (open) or 1 (closed). Prints every criterion with its measured
# value, so a refusal always names which precondition failed and by how much.
gate() {
  local swap_used_kb mem_avail_kb staging_free_kb psi load1
  swap_used_kb=$(measure_swap_used_kb) || exit 2
  mem_avail_kb=$(measure_mem_avail_kb) || exit 2
  staging_free_kb=$(measure_staging_free_kb) || exit 2
  psi=$(measure_psi_full_avg60) || exit 2
  load1=$(measure_load1) || exit 2

  local need_staging_kb need_ram_kb min_ram_kb ram_by_factor_kb reserve_kb
  need_staging_kb=$(( swap_used_kb * STAGING_FACTOR / 10 ))
  reserve_kb=$(( STAGING_RESERVE_G * 1048576 ))
  min_ram_kb=$(( MIN_RAM_HEADROOM_G * 1048576 ))
  ram_by_factor_kb=$(( swap_used_kb * RAM_FACTOR / 100 ))
  need_ram_kb=$(( ram_by_factor_kb > min_ram_kb ? ram_by_factor_kb : min_ram_kb ))

  local ok=0
  echo "  swap in use            : $(g "$swap_used_kb") GiB"
  echo "  RAM available          : $(g "$mem_avail_kb") GiB   (need >= $(g "$need_ram_kb") GiB)"
  echo "  staging free ($STAGING_DIR): $(g "$staging_free_kb") GiB   (need >= $(g $((need_staging_kb + reserve_kb))) GiB incl. ${STAGING_RESERVE_G}G reserve)"
  echo "  PSI mem full avg60     : ${psi}   (need <= ${PSI_MAX})"
  echo "  loadavg 1m             : ${load1}$([ "$MAX_LOAD" != 0 ] && echo "   (need <= ${MAX_LOAD})" || echo "   (advisory)")"

  if [ "$mem_avail_kb" -lt "$need_ram_kb" ]; then
    echo "  GATE CLOSED: insufficient RAM headroom to absorb the swapoff burst."; ok=1
  fi
  if [ "$staging_free_kb" -lt $(( need_staging_kb + reserve_kb )) ]; then
    echo "  GATE CLOSED: staging volume cannot hold $(g "$need_staging_kb") GiB of migrated swap."; ok=1
  fi
  if [ "$(echo "$psi > $PSI_MAX" | bc -l)" = 1 ]; then
    echo "  GATE CLOSED: memory pressure (PSI full avg60 ${psi}) above ${PSI_MAX}; the box is already thrashing."; ok=1
  fi
  if [ "$MAX_LOAD" != 0 ] && [ "$(echo "$load1 > $MAX_LOAD" | bc -l)" = 1 ]; then
    echo "  GATE CLOSED: loadavg ${load1} above --max-load ${MAX_LOAD}."; ok=1
  fi

  # Exposure window: the migration holds the box under memory pressure for as
  # long as the staging device takes to absorb swap_used. On a rotational
  # staging device this dominates the risk — measured 241 MB/s sequential on
  # /dev/sda, and swap writeback is random, so treat this as a FLOOR.
  local stg_src rota=0 rate_mbs=241 eta_min
  stg_src=$(findmnt -no SOURCE --target "$STAGING_DIR" 2>/dev/null | sed 's/[0-9]*$//')
  [ -n "$stg_src" ] && rota=$(lsblk -dno ROTA "$stg_src" 2>/dev/null | tr -d ' ' | head -1)
  if [ "${rota:-0}" = 1 ]; then
    eta_min=$(( swap_used_kb / 1024 / rate_mbs / 60 ))
    echo "  ⚠ staging volume is ROTATIONAL (${stg_src}) at ~${rate_mbs} MB/s."
    echo "    Draining $(g "$swap_used_kb") GiB through RAM to it is a >= ${eta_min} min FLOOR"
    echo "    (sequential; random swap writeback is slower). The box stays under"
    echo "    memory pressure for that whole window — schedule accordingly."
  fi

  [ "$ok" = 0 ] && echo "  GATE OPEN."
  return "$ok"
}

# ------------------------------------------------------------- phase detection
# Derived from live state, never a stored cursor, so an interrupted run resumes.
target_is_on()  { swapon --show=NAME --noheadings 2>/dev/null | grep -qxF "$TARGET_SWAP"; }
staging_is_on() { swapon --show=NAME --noheadings 2>/dev/null | grep -qxF "$STAGING_SWAP"; }

report_state() {
  echo "current swap devices:"
  swapon --show 2>/dev/null | sed 's/^/  /'
  echo "target  $TARGET_SWAP : $(target_is_on && echo ACTIVE || echo 'not active')$([ -e "$TARGET_SWAP" ] && echo ', file present' || echo ', file absent')"
  echo "staging $STAGING_SWAP : $(staging_is_on && echo ACTIVE || echo 'not active')$([ -e "$STAGING_SWAP" ] && echo ', file present' || echo ', file absent')"
}

echo "=== shrink-swapfile: measurement ==="
report_state
echo
echo "=== precondition gate ==="
if gate; then GATE_OK=1; else GATE_OK=0; fi

if [ "$CHECK_ONLY" = 1 ]; then
  [ "$GATE_OK" = 1 ] && exit 0 || exit 1
fi

if [ "$EXECUTE" != 1 ]; then
  echo
  echo "DRY RUN — nothing changed. Plan if executed:"
  echo "  1. create ${STAGING_SWAP} sized to hold current swap, swapon at priority 10"
  echo "  2. swapoff ${TARGET_SWAP}   (pages migrate to staging, not to RAM alone)"
  echo "  3. rm ${TARGET_SWAP}        (reclaims its full allocation)"
  echo "  4. create ${NEW_SIZE_G}G ${TARGET_SWAP}, swapon at priority 20"
  echo "  5. swapoff + rm staging     (pages migrate back to the new swapfile)"
  echo
  echo "Re-run with --execute once the gate is OPEN."
  [ "$GATE_OK" = 1 ] && exit 0 || exit 1
fi

[ "$GATE_OK" = 1 ] || { echo "REFUSED: precondition gate is closed (see above)." >&2; exit 1; }

# --- stability requirement -------------------------------------------------
# A point-in-time gate is the WRONG instrument for a long, non-abortable
# operation. Measured 2026-09-05 across ~15 minutes on this box: swap in use
# moved 175 -> 190 -> 181 GiB and available RAM 90 -> 100 GiB, i.e. ~20% swing
# on a timescale SHORTER than the migration itself (>=12 min floor, longer in
# practice on rotational staging). "Open right now" therefore does not imply
# "open for the whole window", and `swapoff` cannot be aborted once started.
# So require the gate to hold across repeated samples before committing.
if [ "$REQUIRE_STABLE_MIN" -gt 0 ]; then
  samples=$(( REQUIRE_STABLE_MIN * 60 / STABLE_INTERVAL_S ))
  echo
  echo "=== stability check: gate must stay OPEN for ${REQUIRE_STABLE_MIN} min (${samples} samples, ${STABLE_INTERVAL_S}s apart) ==="
  i=0
  while [ "$i" -lt "$samples" ]; do
    i=$(( i + 1 ))
    sleep "$STABLE_INTERVAL_S"
    if gate >/dev/null 2>&1; then
      echo "  sample ${i}/${samples}: OPEN"
    else
      echo "  sample ${i}/${samples}: CLOSED — conditions did not hold." >&2
      echo "REFUSED: gate opened then closed within the stability window; the box is" >&2
      echo "         too volatile to start a non-abortable ${REQUIRE_STABLE_MIN}+ min migration." >&2
      exit 1
    fi
  done
  echo "  gate held OPEN across the full window."
fi
[ "$(id -u)" = 0 ] || SUDO="sudo -n"; SUDO="${SUDO:-}"

# Re-measure and re-gate immediately before each destructive phase.
regate() { echo "  re-gating before destructive step..."; gate >/dev/null || { echo "REFUSED mid-run: conditions degraded." >&2; exit 1; }; }

make_swapfile() { # $1=path $2=size_g
  local path="$1" size_g="$2"
  $SUDO rm -f "$path"
  if ! $SUDO fallocate -l "${size_g}G" "$path" 2>/dev/null; then
    echo "  fallocate unavailable; falling back to dd (slower)"
    $SUDO dd if=/dev/zero of="$path" bs=1M count=$(( size_g * 1024 )) status=none || die "dd failed for $path"
  fi
  $SUDO chmod 600 "$path" || die "chmod failed for $path"
  if ! $SUDO mkswap "$path" >/dev/null; then die "mkswap failed for $path"; fi
  if ! $SUDO swapon -p "$3" "$path"; then
    # fallocate'd extents are rejected by some kernels ("swapfile has holes")
    echo "  swapon rejected the fallocated file; rewriting with dd"
    $SUDO swapoff "$path" 2>/dev/null
    $SUDO rm -f "$path"
    $SUDO dd if=/dev/zero of="$path" bs=1M count=$(( size_g * 1024 )) status=none || die "dd failed for $path"
    $SUDO chmod 600 "$path"; $SUDO mkswap "$path" >/dev/null
    $SUDO swapon -p "$3" "$path" || die "swapon failed for $path"
  fi
}

# phase 1 — staging online
if ! staging_is_on; then
  swap_used_kb=$(measure_swap_used_kb)
  staging_g=$(( swap_used_kb * STAGING_FACTOR / 10 / 1048576 + 1 ))
  [ "$staging_g" -lt "$STAGING_MIN_G" ] && staging_g="$STAGING_MIN_G"
  echo "phase 1: creating ${staging_g}G staging swap at ${STAGING_SWAP}"
  regate
  make_swapfile "$STAGING_SWAP" "$staging_g" 10
else
  echo "phase 1: staging already active — skipping"
fi

# phase 2 — drain the target
if target_is_on; then
  echo "phase 2: swapoff ${TARGET_SWAP} (this is the long step; pages migrate to staging)"
  regate
  $SUDO swapoff "$TARGET_SWAP" || die "swapoff of $TARGET_SWAP failed — target left ACTIVE and intact; nothing was removed"
else
  echo "phase 2: target already drained — skipping"
fi

# phase 3 — reclaim
if [ -e "$TARGET_SWAP" ] && ! target_is_on; then
  echo "phase 3: removing ${TARGET_SWAP} (reclaiming its allocation)"
  $SUDO rm -f "$TARGET_SWAP" || die "could not remove $TARGET_SWAP"
else
  echo "phase 3: target file already removed — skipping"
fi

# phase 4 — right-sized replacement
if ! target_is_on; then
  echo "phase 4: creating ${NEW_SIZE_G}G replacement at ${TARGET_SWAP}"
  make_swapfile "$TARGET_SWAP" "$NEW_SIZE_G" 20
else
  echo "phase 4: replacement already active — skipping"
fi

# phase 5 — drain and remove staging
if staging_is_on; then
  echo "phase 5: draining staging back onto the new swapfile"
  $SUDO swapoff "$STAGING_SWAP" || die "could not swapoff staging; leaving it in place (harmless, retry later)"
fi
[ -e "$STAGING_SWAP" ] && { echo "phase 5: removing staging file"; $SUDO rm -f "$STAGING_SWAP"; }

echo
echo "=== done ==="
report_state
df -h "$(dirname "$TARGET_SWAP")" | sed 's/^/  /'
echo
echo "NOTE: /etc/fstab is deliberately NOT modified — the swapfile path is unchanged."
grep -n 'swap' /etc/fstab 2>/dev/null | sed 's/^/  fstab: /' || echo "  fstab: no swap entry (swap will not persist across reboot — pre-existing condition)"
