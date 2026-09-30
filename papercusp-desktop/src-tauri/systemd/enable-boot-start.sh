#!/bin/bash
# Papercusp Server — make the Linux peer start at BOOT, not at login (WI-479556).
#
# papercusp-server.service is a systemd USER unit (WantedBy=default.target). A
# per-user systemd manager is normally started at login and torn down when the
# user's last session ends, so without lingering the peer is up only while
# somebody is logged in. On a headless box that means the peer is simply absent,
# and — because nothing errors — it looks like a federation fault rather than a
# service that was never started.
#
# This is the Linux counterpart of launchd/install-launchdaemon.sh. Same problem
# (a service bound to a login session), same fix shape (bind it to boot instead),
# different mechanism: macOS needs a system-domain LaunchDaemon, Linux just needs
# the user manager to linger.
#
# It is a separate opt-in script rather than a line in deb/postinstall.sh on
# purpose: a postinstall runs as root with no SUDO_USER and cannot know WHICH
# account should own the peer, and enabling linger for every account with a login
# shell is far too broad.
#
#   sudo ./enable-boot-start.sh                  # for the invoking user
#   sudo ./enable-boot-start.sh --user alice     # for a named account
#   sudo ./enable-boot-start.sh --disable        # stop starting at boot
#
# Idempotent: re-running is a no-op that re-verifies.

set -euo pipefail

UNIT="papercusp-server.service"
SERVICE_USER=""
MODE="enable"

while [ $# -gt 0 ]; do
  case "$1" in
    --user) SERVICE_USER="${2:?--user needs an account name}"; shift 2 ;;
    --disable) MODE="disable"; shift ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Linux" ]; then
  echo "FATAL: Linux-only; macOS uses launchd/install-launchdaemon.sh" >&2
  exit 2
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "FATAL: enabling linger is a system-level change — re-run with sudo" >&2
  exit 2
fi

if [ -z "$SERVICE_USER" ]; then
  SERVICE_USER="${SUDO_USER:-}"
fi
if [ -z "$SERVICE_USER" ] || [ "$SERVICE_USER" = "root" ]; then
  echo "FATAL: could not determine a non-root service account — pass --user <account>" >&2
  exit 2
fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "FATAL: no such account: ${SERVICE_USER}" >&2
  exit 2
fi

command -v loginctl >/dev/null 2>&1 || { echo "FATAL: loginctl not found — is this a systemd host?" >&2; exit 1; }

# Run a systemctl --user command in the target user's own manager. Without
# XDG_RUNTIME_DIR the call silently addresses root's manager instead, which
# reports success while changing nothing for the account that matters.
as_user_systemctl() {
  local uid; uid="$(id -u "$SERVICE_USER")"
  sudo -u "$SERVICE_USER" XDG_RUNTIME_DIR="/run/user/${uid}" systemctl --user "$@"
}

if [ "$MODE" = "disable" ]; then
  as_user_systemctl disable --now "$UNIT" 2>/dev/null || true
  loginctl disable-linger "$SERVICE_USER"
  echo "disabled boot-start for ${SERVICE_USER} (linger off, unit disabled)"
  exit 0
fi

UNIT_PATH="/usr/lib/systemd/user/${UNIT}"
[ -f "$UNIT_PATH" ] || { echo "FATAL: ${UNIT_PATH} is missing — install the papercusp-server package first" >&2; exit 1; }

loginctl enable-linger "$SERVICE_USER"

# Verify rather than assume: enable-linger can appear to succeed while the state
# does not stick (a read-only /var/lib/systemd/linger, for instance).
LINGER="$(loginctl show-user "$SERVICE_USER" --property=Linger --value 2>/dev/null || echo unknown)"
if [ "$LINGER" != "yes" ]; then
  echo "FATAL: linger did not take for ${SERVICE_USER} (Linger=${LINGER})" >&2
  exit 1
fi

as_user_systemctl enable --now "$UNIT"

echo "boot-start enabled for ${SERVICE_USER}: Linger=${LINGER}, ${UNIT} enabled"
echo
as_user_systemctl is-enabled "$UNIT" || true
as_user_systemctl is-active "$UNIT" || true
echo
echo "It now starts at boot with no login. Verify the real property by logging"
echo "fully out (no SSH session, no console) and rebooting, then:"
echo "  loginctl show-user ${SERVICE_USER} --property=Linger"
echo "  systemctl --user -M ${SERVICE_USER}@ status ${UNIT}"
