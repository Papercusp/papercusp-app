#!/usr/bin/env bash
# mac-vm-fresh-state.sh — reversible isolation for the macOS fresh-install rig.
#
# MAC_E2E_FRESH_STATE is an explicit request to exercise first-run provisioning
# without the operator inheriting the host's Papercusp state.  The live roots
# are moved (not copied) to reserved sibling paths, and an EXIT trap restores
# them after PASS, FAIL, VOID, or a trapped signal.  A pre-existing backup is
# ambiguous — it may be a half-finished earlier run — so preparation refuses to
# touch either root until the operator resolves it.

MAC_E2E_FRESH_STATE_BACKUP_SUFFIX="${MAC_E2E_FRESH_STATE_BACKUP_SUFFIX:-.mac-e2e-fresh-state-backup}"
MAC_E2E_FRESH_STATE_ACTIVE=0
MAC_E2E_FRESH_STATE_RESTORE_RUNNING=0
MAC_E2E_FRESH_STATE_LIVE_ROOTS=()
MAC_E2E_FRESH_STATE_BACKUPS=()
MAC_E2E_FRESH_STATE_ORIGINAL_PRESENT=()
MAC_E2E_FRESH_STATE_ISOLATED=()

mac_e2e_fresh_state_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

mac_e2e_fresh_state_configure() {
  local home_root="${1:-${HOME:-}}"
  if [ -z "$home_root" ]; then
    echo "FATAL: cannot configure fresh-state isolation without a home root" >&2
    return 2
  fi

  MAC_E2E_FRESH_STATE_LIVE_ROOTS=(
    "$home_root/.papercusp"
    "$home_root/.papercusp-workspaces"
  )
  MAC_E2E_FRESH_STATE_BACKUPS=(
    "${MAC_E2E_FRESH_STATE_LIVE_ROOTS[0]}${MAC_E2E_FRESH_STATE_BACKUP_SUFFIX}"
    "${MAC_E2E_FRESH_STATE_LIVE_ROOTS[1]}${MAC_E2E_FRESH_STATE_BACKUP_SUFFIX}"
  )
  MAC_E2E_FRESH_STATE_ORIGINAL_PRESENT=(0 0)
  MAC_E2E_FRESH_STATE_ISOLATED=(0 0)
  MAC_E2E_FRESH_STATE_ACTIVE=0
  MAC_E2E_FRESH_STATE_RESTORE_RUNNING=0
}

mac_e2e_fresh_state_install_traps() {
  # The EXIT trap captures the status before cleanup and explicitly re-exits
  # with it.  This keeps FAIL/VOID and signal statuses meaningful to callers.
  trap 'mac_e2e_fresh_state_on_exit "$?"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

mac_e2e_fresh_state_prepare() {
  local i live backup

  if [ "${#MAC_E2E_FRESH_STATE_LIVE_ROOTS[@]}" -ne 2 ] ||
     [ "${#MAC_E2E_FRESH_STATE_BACKUPS[@]}" -ne 2 ]; then
    echo "FATAL: fresh-state isolation was not configured with both state roots" >&2
    return 2
  fi

  # Complete the ambiguity check BEFORE moving either root.  This prevents a
  # half-isolated home when one root has a stale backup from an older run.
  for i in 0 1; do
    live="${MAC_E2E_FRESH_STATE_LIVE_ROOTS[$i]}"
    backup="${MAC_E2E_FRESH_STATE_BACKUPS[$i]}"
    if [ -z "$live" ] || [ -z "$backup" ] || [ "$live" = "/" ] || [ "$backup" = "/" ]; then
      echo "FATAL: refusing unsafe empty/root fresh-state path (live='$live' backup='$backup')" >&2
      return 2
    fi
    if mac_e2e_fresh_state_exists "$backup"; then
      echo "FATAL: refusing ambiguous pre-existing fresh-state backup: $backup" >&2
      return 2
    fi
    if mac_e2e_fresh_state_exists "$live"; then
      MAC_E2E_FRESH_STATE_ORIGINAL_PRESENT[$i]=1
    else
      MAC_E2E_FRESH_STATE_ORIGINAL_PRESENT[$i]=0
    fi
  done

  MAC_E2E_FRESH_STATE_ACTIVE=1
  for i in 0 1; do
    live="${MAC_E2E_FRESH_STATE_LIVE_ROOTS[$i]}"
    backup="${MAC_E2E_FRESH_STATE_BACKUPS[$i]}"
    if [ "${MAC_E2E_FRESH_STATE_ORIGINAL_PRESENT[$i]}" = 0 ]; then
      # There is no original directory to move, but the root is still isolated:
      # any directory the app creates here must be removed during restoration.
      MAC_E2E_FRESH_STATE_ISOLATED[$i]=1
      continue
    fi
    if ! mv "$live" "$backup"; then
      echo "FATAL: could not move $live to its fresh-state backup $backup" >&2
      mac_e2e_fresh_state_restore
      return 1
    fi
    MAC_E2E_FRESH_STATE_ISOLATED[$i]=1
  done
  return 0
}

mac_e2e_fresh_state_restore() {
  local i live backup restore_failed=0
  [ "$MAC_E2E_FRESH_STATE_ACTIVE" = 1 ] || return 0
  [ "$MAC_E2E_FRESH_STATE_RESTORE_RUNNING" = 0 ] || return 0
  MAC_E2E_FRESH_STATE_RESTORE_RUNNING=1

  # Restore in reverse order so a partial cleanup can be retried safely and the
  # last root moved is the first root put back.
  for i in 1 0; do
    [ "${MAC_E2E_FRESH_STATE_ISOLATED[$i]:-0}" = 1 ] || continue
    live="${MAC_E2E_FRESH_STATE_LIVE_ROOTS[$i]}"
    backup="${MAC_E2E_FRESH_STATE_BACKUPS[$i]}"

    # The isolated run owns anything created at the live path.  Remove it before
    # moving the original back, otherwise mv would merge or fail ambiguously.
    if mac_e2e_fresh_state_exists "$live" && ! rm -rf "$live"; then
      echo "ERROR: could not remove isolated fresh-state root $live" >&2
      restore_failed=1
      continue
    fi

    if [ "${MAC_E2E_FRESH_STATE_ORIGINAL_PRESENT[$i]}" = 1 ]; then
      if ! mac_e2e_fresh_state_exists "$backup"; then
        echo "ERROR: original fresh-state backup disappeared before restore: $backup" >&2
        restore_failed=1
        continue
      fi
      if ! mv "$backup" "$live"; then
        echo "ERROR: could not restore $backup to $live" >&2
        restore_failed=1
        continue
      fi
    fi
    MAC_E2E_FRESH_STATE_ISOLATED[$i]=0
  done

  MAC_E2E_FRESH_STATE_RESTORE_RUNNING=0
  if [ "$restore_failed" = 0 ]; then
    MAC_E2E_FRESH_STATE_ACTIVE=0
    return 0
  fi
  return 1
}

mac_e2e_fresh_state_on_exit() {
  local rc="${1:-0}" restore_rc
  # Prevent recursion when this function explicitly exits after cleanup.
  trap - EXIT HUP INT TERM
  mac_e2e_fresh_state_restore
  restore_rc=$?
  if [ "$restore_rc" -ne 0 ] && [ "$rc" -eq 0 ]; then
    rc=1
  fi
  exit "$rc"
}
