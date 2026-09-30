#!/usr/bin/env bash
# disk-preflight.selftest.sh — guards lib/disk-preflight.sh (EI-20090527288494606).
#
# THE BUG THIS GUARDS
# -------------------
# build-desktop-sidecar.sh began a multi-GB node_modules stage with no free-space
# precondition and died mid-copy on `cp: No space left on device` with the root fs
# at 100%. The failure mode that matters is not the dead build — it is the
# PARTIALLY-staged sidecar left behind, which still looks structurally valid to
# whatever packages it next.
#
# Two properties are pinned here, because each has already failed once in this repo:
#
#   1. BEHAVIOUR — the helper refuses when short and passes when there is room, and
#      is fail-OPEN when it cannot measure. A guard that dies on an unusual mount
#      would become a new way for builds to fail, which is worse than the bug.
#   2. WIRING — every entry point that stages multi-GB actually CALLS it. This is
#      the property rust-path-remap.selftest.sh exists for too: a shared helper that
#      no caller invokes is indistinguishable from no helper at all, and nothing
#      complains. Asserted structurally, so a new entry point cannot silently skip it.
#
# Hermetic: pure shell + a tmpdir. No network, no docker, no build.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so falsifiability can be proven against a COPY outside the tree
# (scripts/mutation-probe.sh) instead of mutating the shared checkout, where the
# git-sync sweep can commit the mutant even when nothing goes wrong.
LIB="${PAPERCUSP_DISK_PREFLIGHT_LIB:-$DIR/disk-preflight.sh}"
[ -f "$LIB" ] || { echo "FAIL: $LIB not found"; exit 1; }
# shellcheck source=/dev/null
source "$LIB"

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Keep every assertion off the host's real reservation ledger: this selftest runs
# on the same box as live builds, and must neither see their claims nor add its own.
export PAPERCUSP_DISK_RESERVATION_DIR="$TMP/ledger-default"

# ── 1. papercusp_free_gb ──────────────────────────────────────────────────────
FREE="$(papercusp_free_gb "$TMP")"
if [[ "$FREE" =~ ^[0-9]+$ ]]; then
  ok "papercusp_free_gb returns an integer GB for a real dir (${FREE}GB)"
else
  bad "papercusp_free_gb returned a non-integer for a real dir: '$FREE'"
fi

# The staging dir usually does not exist yet when the guard runs, so the helper
# must walk up to the nearest existing ancestor rather than silently answering
# "unmeasurable" — which would make the guard a no-op exactly where it is needed.
DEEP="$(papercusp_free_gb "$TMP/not/created/yet")"
if [[ "$DEEP" =~ ^[0-9]+$ ]]; then
  ok "papercusp_free_gb walks up to an existing ancestor for a not-yet-created path (${DEEP}GB)"
else
  bad "papercusp_free_gb failed on a not-yet-created path ('$DEEP') — the guard would no-op for real staging dirs"
fi

# ── 2. papercusp_require_free_gb ──────────────────────────────────────────────
# Passes when the requirement is trivially satisfiable.
if papercusp_require_free_gb "$TMP" 0 "selftest (no-op requirement)" >/dev/null 2>&1; then
  ok "require_free_gb passes when there is room"
else
  bad "require_free_gb refused a 0GB requirement — it would block every build"
fi

# Refuses, with ENOSPC(28), when the requirement cannot be met. 99999999GB is
# larger than any real filesystem, so this is deterministic on any host.
OUT="$(papercusp_require_free_gb "$TMP" 99999999 "selftest (impossible requirement)" 2>&1)"
RC=$?
if [ "$RC" -eq 28 ]; then
  ok "require_free_gb refuses an impossible requirement with exit 28 (ENOSPC)"
else
  bad "require_free_gb returned $RC for an impossible requirement, expected 28"
fi
case "$OUT" in
  *"insufficient disk"*) ok "the refusal names the problem in its first line" ;;
  *) bad "the refusal message did not say 'insufficient disk': $OUT" ;;
esac
case "$OUT" in
  *"$TMP"*) ok "the refusal names the staging dir it measured" ;;
  *) bad "the refusal did not name the measured dir — the reader cannot tell WHICH fs is full" ;;
esac

# Playwright's browser cache is deliberately not advertised as reclaimable:
# e2e consumers now regenerate it through scripts/ensure-playwright-browsers.mjs.
if grep -q 'npm/playwright caches' "$LIB"; then
  bad "disk preflight still suggests deleting the Playwright cache without a regeneration action"
else
  ok "disk preflight does not suggest deleting the Playwright cache"
fi

# Fail-OPEN when the path cannot be measured at all.
if papercusp_require_free_gb "" 99999999 "selftest (unmeasurable)" >/dev/null 2>&1; then
  ok "require_free_gb fails OPEN when it cannot measure (never a new way for builds to die)"
else
  bad "require_free_gb refused an UNMEASURABLE path — a broken df would now block builds"
fi

# ── 3. concurrent admission must not over-commit (EI-21951384112327922) ───────
# The original guard only READ free space, so two builds each needing 12GB both
# passed on the same 20GB. Measured before the fix: two callers each demanding 75%
# of free space were BOTH admitted, promising 606GB against 404GB free. These pin
# the reservation ledger that closed it — and each one FAILS against that old
# read-only implementation, which is the only reason to trust them.
LEDGER="$TMP/ledger"

# 3a. Seeded and deterministic on any host: a live claim on effectively all free
# space must refuse the next caller, even though the disk itself is not full.
FREE_NOW="$(papercusp_free_gb "$TMP")"
sleep 60 & HOLDER=$!
KEY="$(PAPERCUSP_DISK_RESERVATION_DIR="$LEDGER" papercusp_mount_key "$TMP" 2>/dev/null)"
LDIR="$LEDGER/$KEY"
mkdir -p "$LDIR"
{
  printf 'pid=%s\n' "$HOLDER"
  printf 'start=%s\n' "$(papercusp_proc_starttime "$HOLDER" 2>/dev/null)"
  printf 'gb=%s\n' "$FREE_NOW"
  printf 'expires=%s\n' "$(( $(date +%s) + 3600 ))"
  printf 'label=%s\n' "selftest holder"
} > "$LDIR/seed.res"

OUT="$(PAPERCUSP_DISK_RESERVATION_DIR="$LEDGER" papercusp_require_free_gb "$TMP" 1 "selftest (contended)" 2>&1)"
RC=$?
if [ "$RC" -eq 28 ]; then
  ok "admission refuses when another live build has already reserved the space"
else
  bad "admission returned $RC while ${FREE_NOW}GB was reserved by a live peer — it is over-committing the disk"
fi
case "$OUT" in
  *RESERVED*|*reserved*) ok "the refusal explains that space is reserved, not that the disk is full" ;;
  *) bad "the contended refusal did not mention reservations, so the reader will hunt a full disk that is not full: $OUT" ;;
esac

# 3b. A reservation is live only while its owner is. Killing the holder must
# release it WITHOUT any trap running — both real callers install their own EXIT
# trap after calling us, so a trap here would be clobbered and leak forever.
# Each reap case asserts the stale entry is actually GONE, not merely that
# admission passed: "it passed" is also true of an implementation with no ledger
# at all, so asserting only that would be a control that cannot fail.
reap_case() { # $1 = filename, $2 = what, $3 = why it matters
  local f="$LDIR/$1" what="$2" why="$3"
  if ! PAPERCUSP_DISK_RESERVATION_DIR="$LEDGER" \
       papercusp_require_free_gb "$TMP" 1 "selftest ($what)" >/dev/null 2>&1; then
    bad "$what: admission was refused — $why"
  elif [ -e "$f" ]; then
    bad "$what: the stale reservation was left in the ledger, so nothing reaped it ($why)"
  else
    ok "$what: the stale reservation is reaped out of the ledger"
  fi
}

kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
reap_case seed.res "dead owner" \
  "one SIGKILLed build would otherwise wedge every later build until the TTL"

# 3c. Pid reuse must not resurrect a stale claim: pids wrap ~daily here, so a dead
# build's pid is genuinely reachable by a live stranger. Same pid, wrong start time.
rm -f "$LDIR"/*.res
{
  printf 'pid=%s\n' "$$"
  printf 'start=%s\n' "999999999"
  printf 'gb=%s\n' "$FREE_NOW"
  printf 'expires=%s\n' "$(( $(date +%s) + 3600 ))"
} > "$LDIR/recycled.res"
reap_case recycled.res "recycled pid" \
  "liveness would be trusting the pid alone, which a wrapped pid makes a false positive"

# 3d. TTL backstop for hosts where start time is unreadable (darwin).
rm -f "$LDIR"/*.res
{
  printf 'pid=%s\n' "$$"
  printf 'gb=%s\n' "$FREE_NOW"
  printf 'expires=%s\n' "$(( $(date +%s) - 1 ))"
} > "$LDIR/expired.res"
reap_case expired.res "expired claim" \
  "the TTL is the only backstop where /proc start time is unreadable"

# 3e. The real race, not a seeded one: two concurrent callers each demanding 75%
# of free space cannot both be admitted. This is the exact shape that reproduced.
rm -rf "$LEDGER"
if [ -n "$FREE_NOW" ] && [ "$FREE_NOW" -ge 4 ]; then
  NEED=$(( FREE_NOW * 3 / 4 ))
  PAPERCUSP_DISK_RESERVATION_DIR="$LEDGER" papercusp_require_free_gb "$TMP" "$NEED" "race A" >/dev/null 2>&1 & PA=$!
  PAPERCUSP_DISK_RESERVATION_DIR="$LEDGER" papercusp_require_free_gb "$TMP" "$NEED" "race B" >/dev/null 2>&1 & PB=$!
  wait $PA; RA=$?
  wait $PB; RB=$?
  ADMITTED=0
  [ "$RA" -eq 0 ] && ADMITTED=$((ADMITTED + 1))
  [ "$RB" -eq 0 ] && ADMITTED=$((ADMITTED + 1))
  if [ "$ADMITTED" -eq 1 ]; then
    ok "two concurrent builds each demanding 75% of free space: exactly one admitted"
  else
    bad "$ADMITTED of 2 concurrent builds admitted while each demanded 75% of ${FREE_NOW}GB — the check-and-reserve is not atomic"
  fi
else
  ok "concurrent-admission race skipped (only ${FREE_NOW}GB free — needs >=4GB to be meaningful)"
fi

# 3f. An unusable ledger must degrade to the old measure-only check, never become
# a new way for builds to die (the fail-open rule this file has always had).
if PAPERCUSP_DISK_RESERVATION_DIR=/proc/cannot/create/here \
     papercusp_require_free_gb "$TMP" 0 "selftest (ledger unusable)" >/dev/null 2>&1; then
  ok "an unusable reservation ledger falls back to the measure-only check (fails open)"
else
  bad "an unusable ledger REFUSED a satisfiable build — the ledger became a new failure mode"
fi

# ── 4. wiring: the staging entry points actually call it ──────────────────────
# Structural, for the reason in the header: a helper nothing calls is dark.
for SCRIPT in build-desktop-sidecar.sh build-windows-cross.sh; do
  P="$DIR/../$SCRIPT"
  if [ ! -f "$P" ]; then
    bad "$SCRIPT missing — update this list if it was renamed/removed"
    continue
  fi
  if grep -q 'papercusp_require_free_gb' "$P"; then
    ok "$SCRIPT calls the disk preflight before staging"
  else
    bad "$SCRIPT stages multi-GB but never calls papercusp_require_free_gb (see lib/disk-preflight.sh)"
  fi
done

if [ "$FAILS" -eq 0 ]; then echo "PASS"; exit 0; fi
echo "FAIL ($FAILS)"; exit 1
