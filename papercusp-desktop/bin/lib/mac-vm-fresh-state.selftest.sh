#!/usr/bin/env bash
# mac-vm-fresh-state.selftest.sh — hermetic regression guard for
# MAC_E2E_FRESH_STATE=1 (EI-20332777704574867).
#
# The production rig runs on macOS and normally touches /Applications plus the
# operator's real home, so this test drives the REAL helper against temporary
# homes.  Each subprocess installs the shipping EXIT/signal traps, creates
# synthetic fresh state, and then exits through PASS, FAIL, or TERM.  The
# original ~/.papercusp and ~/.papercusp-workspaces roots must be restored in
# every case, with no backup residue.  A pre-existing backup must refuse before
# either live root moves.
#
#   bash bin/lib/mac-vm-fresh-state.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$DIR/mac-vm-fresh-state.sh"
SCRIPT="$DIR/../mac-vm-fresh-install-e2e.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mac-vm-fresh-state.selftest.XXXXXX")"
MAC_E2E_FRESH_STATE_BACKUP_SUFFIX=".mac-e2e-fresh-state-backup"
export MAC_E2E_FRESH_STATE_BACKUP_SUFFIX

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

reset_home() {
  local home="$1"
  rm -rf "$home"
  mkdir -p "$home/.papercusp" "$home/.papercusp-workspaces"
  printf 'original-papercusp\n' >"$home/.papercusp/original.txt"
  printf 'original-workspaces\n' >"$home/.papercusp-workspaces/original.txt"
}

reset_home_with_missing_workspaces() {
  local home="$1"
  rm -rf "$home"
  mkdir -p "$home/.papercusp"
  printf 'original-papercusp\n' >"$home/.papercusp/original.txt"
}

backup_for() {
  printf '%s%s\n' "$1" "$MAC_E2E_FRESH_STATE_BACKUP_SUFFIX"
}

run_trapped_case() {
  local mode="$1" home="$2"
  bash -c '
    set -u
    source "$1"
    mac_e2e_fresh_state_configure "$2"
    mac_e2e_fresh_state_install_traps
    mac_e2e_fresh_state_prepare || exit 90
    mkdir -p "$2/.papercusp" "$2/.papercusp-workspaces"
    printf "fresh-papercusp\n" >"$2/.papercusp/fresh.txt"
    printf "fresh-workspaces\n" >"$2/.papercusp-workspaces/fresh.txt"
    case "$3" in
      success) exit 0 ;;
      failure) exit 7 ;;
      signal) kill -TERM "$$" ;;
      *) exit 91 ;;
    esac
  ' _ "$HELPER" "$home" "$mode" >/dev/null 2>&1
}

assert_restored() {
  local home="$1" expect_workspaces="$2" backup
  backup="$(backup_for "$home/.papercusp")"
  [ -f "$home/.papercusp/original.txt" ] &&
    grep -qx 'original-papercusp' "$home/.papercusp/original.txt" ||
    bad "$home/.papercusp was not restored exactly"
  [ ! -e "$home/.papercusp/fresh.txt" ] || bad "$home/.papercusp retained isolated fresh state"
  [ ! -e "$backup" ] || bad "backup residue remains at $backup"

  backup="$(backup_for "$home/.papercusp-workspaces")"
  if [ "$expect_workspaces" = 1 ]; then
    [ -f "$home/.papercusp-workspaces/original.txt" ] &&
      grep -qx 'original-workspaces' "$home/.papercusp-workspaces/original.txt" ||
      bad "$home/.papercusp-workspaces was not restored exactly"
    [ ! -e "$home/.papercusp-workspaces/fresh.txt" ] ||
      bad "$home/.papercusp-workspaces retained isolated fresh state"
  else
    [ ! -e "$home/.papercusp-workspaces" ] ||
      bad "missing original workspaces root was recreated during restore"
  fi
  [ ! -e "$backup" ] || bad "workspace backup residue remains at $backup"
}

echo "=== MAC_E2E_FRESH_STATE helper integration guard ==="

# Static wiring checks keep the production script from silently bypassing the
# tested helper while retaining a passing helper in isolation.
grep -q 'mac_e2e_fresh_state_prepare' "$SCRIPT" &&
  ok 'production script calls the tested fresh-state prepare helper' ||
  bad 'production script no longer calls fresh-state prepare helper'
grep -q 'mac_e2e_fresh_state_install_traps' "$SCRIPT" &&
  ok 'production script installs restoration traps' ||
  bad 'production script no longer installs restoration traps'
grep -q '\.papercusp-workspaces' "$SCRIPT" &&
  ok 'production script names both isolated state roots' ||
  bad 'production script no longer names the workspace state root'

home="$TMP_ROOT/success"
reset_home "$home"
if run_trapped_case success "$home"; then
  ok 'PASS exit preserves the original state roots'
else
  bad 'PASS exit returned nonzero'
fi
assert_restored "$home" 1

home="$TMP_ROOT/failure"
reset_home "$home"
if [ "$(run_trapped_case failure "$home"; printf '%s' "$?")" = 7 ]; then
  ok 'ordinary FAIL exit status is preserved through restoration'
else
  bad 'ordinary FAIL exit status was changed by restoration'
fi
assert_restored "$home" 1

home="$TMP_ROOT/signal"
reset_home "$home"
if [ "$(run_trapped_case signal "$home"; printf '%s' "$?")" = 143 ]; then
  ok 'TERM exit status is preserved through signal-triggered restoration'
else
  bad 'TERM exit did not preserve the trapped 143 status'
fi
assert_restored "$home" 1

home="$TMP_ROOT/missing-workspaces"
reset_home_with_missing_workspaces "$home"
if run_trapped_case success "$home"; then
  ok 'fresh state also handles an originally absent workspace root'
else
  bad 'missing workspace-root case returned nonzero'
fi
assert_restored "$home" 0

home="$TMP_ROOT/ambiguous"
reset_home "$home"
mkdir -p "$(backup_for "$home/.papercusp")"
printf 'stale-backup\n' >"$(backup_for "$home/.papercusp")/marker.txt"
ambiguous_rc=0
bash -c '
  set -u
  source "$1"
  mac_e2e_fresh_state_configure "$2"
  mac_e2e_fresh_state_install_traps
  mac_e2e_fresh_state_prepare
  exit $?
' _ "$HELPER" "$home" >/dev/null 2>&1 || ambiguous_rc=$?
if [ "$ambiguous_rc" = 2 ] && [ -f "$home/.papercusp/original.txt" ] &&
   [ -f "$(backup_for "$home/.papercusp")/marker.txt" ]; then
  ok 'pre-existing backup is refused without moving either live root'
else
  bad "ambiguous backup guard returned rc=$ambiguous_rc or changed state"
fi

if [ "$FAILS" -gt 0 ]; then
  echo "FAIL — $FAILS assertion(s) failed"
  exit 1
fi
echo "PASS — fresh-state isolation restores both roots across PASS/FAIL/TERM"
