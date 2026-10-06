# shellcheck shell=bash
# smoke-endpoints.sh — the default SSH endpoint of each NATIVE installed-upgrade
# smoke target, sourced by bin/install-and-relaunch-verify.sh (the smoke) and
# bin/smoke-target-preflight.sh (the pre-build target check, WI-10004346), so the
# two can never dial different machines. Linux is derived from vmctl by the
# verifier itself and is not a native-rig target here.
#
# smoke_endpoint_defaults <windows|mac> — fills SSH_PORT / SSH_KEY / SSH_HOST
# only where the caller left them empty (flags and env still win).
smoke_endpoint_defaults() {
  case "$1" in
    windows)
      SSH_PORT="${SSH_PORT:-2223}"
      SSH_KEY="${SSH_KEY:-$HOME/.ssh/papercup-vm-win}"
      SSH_HOST="${SSH_HOST:-user@127.0.0.1}"
      ;;
    mac)
      SSH_PORT="${SSH_PORT:-2222}"
      SSH_KEY="${SSH_KEY:-$HOME/.ssh/papercup-vm-mac}"
      SSH_HOST="${SSH_HOST:-${MAC_VM_SSH_HOST:-macuser@127.0.0.1}}"
      ;;
    *) return 1 ;;
  esac
}

# The host systemd --user unit that boots the Windows rig. It is normally
# STOPPED (the unit is disabled to free RAM), so "port 2223 refused" usually
# means "not booted", not "rig broken" — the WI-10004346 false premise.
SMOKE_WINDOWS_VM_UNIT="${SMOKE_WINDOWS_VM_UNIT:-papercup-vm-win.service}"
