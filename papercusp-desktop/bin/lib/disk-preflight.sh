#!/usr/bin/env bash
# disk-preflight.sh — refuse a build at second ZERO when the filesystem it will
# stage into lacks headroom, instead of dying three minutes into a multi-GB copy.
#
# WHY (EI-20090527288494606, 2026-08-10): build-desktop-sidecar.sh failed with
#   cp: error copying ... No space left on device
# while staging node_modules into src-tauri/sidecar.tmp.<pid>, root fs at 100%.
# No build entry point checked free space, so a full disk surfaced as a confusing
# mid-copy `cp` error deep in a log rather than a one-line refusal up front. The
# dangerous outcome is not the failed build — it is the PARTIALLY-staged one: a
# sidecar that looks structurally valid and gets packaged into an installer.
#
# This is the THIRD time this class has been paid for here, which is why it is a
# shared helper and not another inline check:
#   - 0.0.11 (2026-07-15) mac-vm-build.sh: a second role's cold compile ran out of
#     disk MID-BUILD and died with no artifacts and no DONE sentinel — "a mysterious
#     hang/kill" that was ENOSPC. Fixed inline at mac-vm-build.sh:485.
#   - 2026-08-10: the same class, on a different script, rediscovered the same way.
# Source this instead of hand-rolling a fourth `df | awk` (see EI-9905 for the same
# argument about sha256).
#
#   source "$(dirname "$0")/lib/disk-preflight.sh"
#   papercusp_require_free_gb "$STAGING_DIR" 12 "sidecar staging"
#
# WHICH FILESYSTEM: pass the directory the build will WRITE INTO, not $PWD. On this
# box they differ in the way that matters — the repo is on the 1.9T root fs (the
# constrained one) while /tmp is a separate 7.3T volume with ~1.8T free. Checking
# the wrong one answers confidently about a disk you are not filling.
#
# FAIL-OPEN ON MEASUREMENT FAILURE, FAIL-CLOSED ON A REAL SHORTAGE: if `df` cannot
# read the path (missing dir, unusual mount) the build PROCEEDS — a guard that
# cannot measure must not become a new way for builds to die. Only a measured,
# genuine shortage refuses.
#
# CHECK-AND-RESERVE, NOT CHECK-THEN-HOPE (EI-21951384112327922, 2026-08-31): a
# preflight that only READS free space is a TOCTOU race, and on this box the race
# is the normal case — ~100 agents share one filesystem. Two builds that each need
# 12GB both read "20GB free", both pass, and then collectively need 24GB. Measured
# before the fix: two concurrent callers each demanding 75% of free space were BOTH
# admitted, promising 606GB against 404GB free. Both then die mid-copy — which is
# precisely the partially-staged-bundle outcome this file was written to prevent,
# so the guard was reliably absent exactly when contention made it matter.
#
# So admission now subtracts what OTHER live builds have already been promised, and
# the winner records its own claim, under one mutex. Three properties make the
# ledger safe to leave lying around:
#
#   LIVENESS IS THE PID, NOT A TRAP. A reservation is live only while its owning
#   process is. This is deliberate: both callers here (build-desktop-sidecar.sh:676,
#   build-windows-cross.sh:258) install their OWN `trap ... EXIT` well AFTER calling
#   the preflight, so a trap registered in this file would be silently clobbered and
#   the reservation would leak. Binding to the pid also survives SIGKILL, which no
#   trap does.
#   PID RECYCLING IS DEFEATED BY START TIME, not assumed away — pids wrap ~daily
#   here under fleet load, so a dead build's pid is genuinely reachable by a live
#   stranger. `/proc/<pid>/stat` start time is the exact identity check; where it is
#   unreadable (darwin) the TTL is the backstop.
#   UNUSABLE LEDGER == NO LEDGER. Every failure to read, lock, or write it falls
#   back to the pre-existing measure-only behaviour, per the fail-open rule above.
#
# Portable to bash 3.2 (darwin): a mkdir mutex, not flock or a {fd} named fd.

# Free space in whole GB on the filesystem containing $1. Prints an integer, or an
# EMPTY string when it cannot be measured. `df -Pk` is POSIX (portable to darwin,
# where GNU-only flags are absent); -P forces one line per fs so a long device name
# cannot wrap and shift the column.
papercusp_free_gb() {
  local path="$1" out=""
  [ -n "$path" ] || return 0
  # Walk up to the nearest existing ancestor: the staging dir usually does not
  # exist yet at preflight time, and `df` on a missing path reports nothing.
  while [ -n "$path" ] && [ ! -d "$path" ]; do
    local parent
    parent="$(dirname "$path")"
    [ "$parent" = "$path" ] && break
    path="$parent"
  done
  [ -d "$path" ] || return 0
  out="$(df -Pk "$path" 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}')" || true
  printf '%s' "$out"
}

# ── reservation ledger ────────────────────────────────────────────────────────
# Small, dependency-free, and shared with the Node-side reader in
# scripts/lib/disk-reservations.mjs — keep the on-disk format in step with it.
# One file per live claim: pid=, start=, gb=, expires=, label=.

papercusp_reservation_dir() {
  printf '%s' "${PAPERCUSP_DISK_RESERVATION_DIR:-${TMPDIR:-/tmp}/papercusp-disk-reservations}"
}

# Reservations are per-FILESYSTEM: a claim against /tmp must not shrink the budget
# for /. Key on the mount point df reports, so two paths on one volume share a
# ledger and paths on different volumes never interfere.
papercusp_mount_key() {
  local path="$1" mp=""
  [ -n "$path" ] || return 0
  while [ -n "$path" ] && [ ! -d "$path" ]; do
    local parent; parent="$(dirname "$path")"
    [ "$parent" = "$path" ] && break
    path="$parent"
  done
  [ -d "$path" ] || return 0
  mp="$(df -Pk "$path" 2>/dev/null | awk 'NR==2 {print $6}')" || true
  [ -n "$mp" ] || return 0
  printf '%s' "$mp" | tr -c 'A-Za-z0-9' '_'
}

# Process start time (jiffies since boot) — the identity that survives pid reuse.
# comm can contain spaces AND parens, so split after the LAST ')' rather than
# trusting field position; starttime is field 22 overall == field 20 after that.
papercusp_proc_starttime() {
  local pid="$1" line rest
  [ -n "$pid" ] || return 0
  [ -r "/proc/$pid/stat" ] || return 0
  line="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 0
  rest="${line##*) }"
  printf '%s' "$rest" | awk '{print $20}'
}

# Atomic mutex via mkdir (portable to bash 3.2 / darwin, where flock is absent).
# Bounded: the critical section is a handful of small file reads, so failing to
# acquire within ~5s means something is wrong — and we then fail OPEN, per this
# file's contract, rather than inventing a new way for builds to die.
papercusp_ledger_lock() {
  local lockdir="$1/.lock" tries=0 owner=""
  while ! mkdir "$lockdir" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -eq 20 ]; then
      # Steal a lock whose owner is gone (killed mid-section).
      owner="$(cat "$lockdir/owner" 2>/dev/null)" || true
      if [ -z "$owner" ] || ! kill -0 "$owner" 2>/dev/null; then
        rm -rf "$lockdir" 2>/dev/null || true
      fi
    fi
    [ "$tries" -gt 50 ] && return 1
    sleep 0.1
  done
  printf '%s' "$$" > "$lockdir/owner" 2>/dev/null || true
  return 0
}

papercusp_ledger_unlock() { rm -rf "$1/.lock" 2>/dev/null || true; }

# Sum live reservations, reaping dead ones. MUST be called holding the lock.
papercusp_reserved_gb() {
  local ldir="$1" total=0 f pid gb start expires now cur live
  now="$(date +%s)"
  for f in "$ldir"/*.res; do
    [ -e "$f" ] || continue
    pid="$(sed -n 's/^pid=//p' "$f" 2>/dev/null)"
    gb="$(sed -n 's/^gb=//p' "$f" 2>/dev/null)"
    start="$(sed -n 's/^start=//p' "$f" 2>/dev/null)"
    expires="$(sed -n 's/^expires=//p' "$f" 2>/dev/null)"
    live=1
    case "$pid$gb" in ''|*[!0-9]*) live=0 ;; esac          # malformed -> reap
    [ "$live" = 1 ] && [ -n "$expires" ] && [ "$now" -gt "$expires" ] && live=0
    [ "$live" = 1 ] && ! kill -0 "$pid" 2>/dev/null && live=0
    if [ "$live" = 1 ] && [ -n "$start" ]; then
      cur="$(papercusp_proc_starttime "$pid")"
      [ -n "$cur" ] && [ "$cur" != "$start" ] && live=0    # pid was recycled
    fi
    if [ "$live" = 0 ]; then rm -f "$f" 2>/dev/null || true; continue; fi
    total=$((total + gb))
  done
  printf '%s' "$total"
}

# Release this shell's own claim early (optional — liveness is the pid, so a build
# that simply exits releases it too).
papercusp_release_disk_reservation() {
  [ -n "${PAPERCUSP_DISK_RESERVATION_FILE:-}" ] || return 0
  rm -f "$PAPERCUSP_DISK_RESERVATION_FILE" 2>/dev/null || true
  PAPERCUSP_DISK_RESERVATION_FILE=""
  return 0
}

# Refuse the build unless $1 has at least $2 GB free *that no other live build has
# already claimed*, and record this build's claim so concurrent callers see it. $3
# is a human label for the message ("sidecar staging", "cold compile"). Exits 28
# (ENOSPC) so a caller's sentinel/DONE handling can distinguish "out of disk" from
# a compile error.
papercusp_require_free_gb() {
  local dir="$1" need_gb="$2" label="${3:-build}"
  local free_gb
  free_gb="$(papercusp_free_gb "$dir")"

  if [ -z "$free_gb" ]; then
    # Unmeasurable -> proceed. Say so, so a later ENOSPC is not a total mystery.
    echo "    (disk preflight SKIPPED for $label — could not measure free space on '$dir')" >&2
    return 0
  fi

  # Check-and-reserve under one mutex, so two callers cannot both pass on the same
  # bytes. Any ledger failure degrades to the measure-only check below.
  local key ldir reserved effective ttl now resfile
  key="$(papercusp_mount_key "$dir")"
  ldir=""
  if [ -n "$key" ]; then
    ldir="$(papercusp_reservation_dir)/$key"
    mkdir -p "$ldir" 2>/dev/null || ldir=""
  fi
  if [ -n "$ldir" ] && papercusp_ledger_lock "$ldir"; then
    reserved="$(papercusp_reserved_gb "$ldir")"
    [ -n "$reserved" ] || reserved=0
    effective=$((free_gb - reserved))
    [ "$effective" -lt 0 ] && effective=0
    if [ "$effective" -lt "$need_gb" ]; then
      papercusp_ledger_unlock "$ldir"
      echo "ERROR: insufficient disk for $label: ${effective}GB effectively free, need ~${need_gb}GB." >&2
      echo "       Staging target: $dir" >&2
      echo "       ${free_gb}GB is free on disk, but ${reserved}GB is already RESERVED by other" >&2
      echo "       in-flight builds on this filesystem, so starting now would over-commit it." >&2
      echo "       Wait for them to finish, or free space (stale cargo target dirs, old builds)." >&2
      return 28
    fi
    ttl="${PAPERCUSP_DISK_RESERVATION_TTL_SEC:-21600}"
    now="$(date +%s)"
    # $RANDOM, not date +%s%N: darwin's date has no %N and prints a literal "N"
    # rather than failing, so the fallback would never fire and names would collide.
    resfile="$ldir/$$.${RANDOM}${RANDOM}.res"
    {
      printf 'pid=%s\n' "$$"
      printf 'start=%s\n' "$(papercusp_proc_starttime "$$")"
      printf 'gb=%s\n' "$need_gb"
      printf 'expires=%s\n' "$((now + ttl))"
      printf 'label=%s\n' "$label"
    } > "$resfile.tmp" 2>/dev/null && mv -f "$resfile.tmp" "$resfile" 2>/dev/null || true
    PAPERCUSP_DISK_RESERVATION_FILE="$resfile"
    papercusp_ledger_unlock "$ldir"
    if [ "$reserved" -gt 0 ]; then
      echo "    (disk preflight ✓ ${effective}GB effectively free on '$dir' — ${free_gb}GB free less ${reserved}GB reserved by other builds; reserved ${need_gb}GB for $label)"
    else
      echo "    (disk preflight ✓ ${free_gb}GB free on '$dir' — ok for $label, reserved ~${need_gb}GB)"
    fi
    return 0
  fi

  if [ -n "$ldir" ]; then
    echo "    (disk reservation ledger unavailable for $label — falling back to a measure-only check)" >&2
  fi

  if [ "$free_gb" -lt "$need_gb" ]; then
    echo "ERROR: insufficient disk for $label: ${free_gb}GB free, need ~${need_gb}GB." >&2
    echo "       Staging target: $dir" >&2
    echo "       This build stages multi-GB trees; starting now would fail MID-COPY and can" >&2
    echo "       leave a PARTIALLY-staged bundle that still looks valid to later steps." >&2
    echo "       Free space first (stale cargo target dirs, old builds), then rerun the build." >&2
    echo "       or point the staging dir at a roomier filesystem." >&2
    return 28 # ENOSPC — callers `|| exit $?` to preserve it
  fi

  echo "    (disk preflight ✓ ${free_gb}GB free on '$dir' — ok for $label, needs ~${need_gb}GB)"
  return 0
}
