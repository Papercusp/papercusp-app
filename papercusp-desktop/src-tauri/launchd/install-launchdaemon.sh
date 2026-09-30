#!/bin/bash
# Papercusp Server — install the macOS LaunchDaemon (WI-475896).
#
# Makes the Server peer start at boot with NO login of any kind, which the
# shipped LaunchAgent cannot do: an agent lives in launchd's gui/<uid> domain,
# and that domain does not exist while the Mac sits at the login window. This is
# the macOS counterpart of the Linux deb postinstall enabling
# papercusp-server.service for the user manager.
#
#   sudo ./install-launchdaemon.sh                 # install for the invoking user
#   sudo ./install-launchdaemon.sh --user alice    # install for a named account
#   sudo ./install-launchdaemon.sh --uninstall     # remove it
#   sudo ./install-launchdaemon.sh --current-payload /Users/alice/rig-sidecar-current \
#     --current-launcher /Users/alice/.papercusp/vm-rig/boot-headless-current.sh
#                                                   # supervise a composed payload
#   sudo ./install-launchdaemon.sh --current-payload /Users/alice/rig-sidecar-current \
#     --build-sha <immutable-source-sha> --build-version <version>
#                                                   # bind launchd health identity explicitly
#   sudo ./install-launchdaemon.sh --bootout-only   # quiesce before an atomic deploy
#
# Idempotent: re-running replaces the plist and re-bootstraps cleanly.

set -euo pipefail

LABEL="com.papercusp.server"
PLIST_DEST="/Library/LaunchDaemons/${LABEL}.plist"
APP_ROOT="/Applications/Papercusp Server.app"
BINARY="${APP_ROOT}/Contents/MacOS/papercusp-server"
SIDECAR_DIR="${APP_ROOT}/Contents/Resources/sidecar"
LAUNCHD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${LAUNCHD_DIR}/${LABEL}.plist.template"

SERVICE_USER=""
MODE="install"
CURRENT_PAYLOAD=""
CURRENT_LAUNCHER=""
CURRENT_PORT="${PAPERCUSP_HONO_PORT:-3070}"
CURRENT_BUILD_SHA=""
CURRENT_BUILD_VERSION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --user) SERVICE_USER="${2:?--user needs an account name}"; shift 2 ;;
    --uninstall) MODE="uninstall"; shift ;;
    --bootout-only) MODE="bootout-only"; shift ;;
    --current-payload) CURRENT_PAYLOAD="${2:?--current-payload needs an absolute directory}"; shift 2 ;;
    --current-launcher) CURRENT_LAUNCHER="${2:?--current-launcher needs an absolute executable}"; shift 2 ;;
    --port) CURRENT_PORT="${2:?--port needs a port number}"; shift 2 ;;
    --build-sha) CURRENT_BUILD_SHA="${2:?--build-sha needs an immutable source sha}"; shift 2 ;;
    --build-version) CURRENT_BUILD_VERSION="${2:?--build-version needs a release version}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "FATAL: this installer is macOS-only; Linux uses papercusp-server.service" >&2
  exit 2
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "FATAL: a LaunchDaemon lives in the system domain — re-run with sudo" >&2
  exit 2
fi

# `launchctl bootout` exits non-zero when the label is not loaded, which is the
# normal first-install case. Never let that abort the script.
unload_if_present() {
  launchctl bootout "system/${LABEL}" 2>/dev/null || true
}

if [ "$MODE" = "uninstall" ]; then
  unload_if_present
  rm -f "$PLIST_DEST"
  echo "removed ${LABEL}"
  exit 0
fi

if [ "$MODE" = "bootout-only" ]; then
  unload_if_present
  echo "quiesced system/${LABEL}; plist left installed"
  exit 0
fi

# Resolve the account that owns the Papercusp state tree. Running the daemon as
# root would create a root-owned state tree the desktop app can no longer read.
if [ -z "$SERVICE_USER" ]; then
  SERVICE_USER="${SUDO_USER:-}"
fi
if [ -z "$SERVICE_USER" ] || [ "$SERVICE_USER" = "root" ]; then
  echo "FATAL: could not determine a non-root service account — pass --user <account>" >&2
  exit 2
fi

SERVICE_HOME="$(dscl . -read "/Users/${SERVICE_USER}" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
if [ -z "$SERVICE_HOME" ] || [ ! -d "$SERVICE_HOME" ]; then
  echo "FATAL: no home directory for '${SERVICE_USER}' — is that account real?" >&2
  exit 2
fi

case "$CURRENT_PORT" in ''|*[!0-9]*) echo "FATAL: --port must be numeric" >&2; exit 2 ;; esac

SERVICE_KIND="packaged"
if [ -n "$CURRENT_PAYLOAD" ] || [ -n "$CURRENT_LAUNCHER" ]; then
  SERVICE_KIND="current"
  case "$CURRENT_PAYLOAD" in /*) ;; *) echo "FATAL: --current-payload must be an absolute directory" >&2; exit 2 ;; esac
  if [ -z "$CURRENT_LAUNCHER" ]; then
    CURRENT_LAUNCHER="${SERVICE_HOME}/.papercusp/vm-rig/boot-headless-current.sh"
  fi
  case "$CURRENT_LAUNCHER" in /*) ;; *) echo "FATAL: --current-launcher must be an absolute path" >&2; exit 2 ;; esac
  TEMPLATE="${LAUNCHD_DIR}/${LABEL}.current.plist.template"
  [ -x "$CURRENT_LAUNCHER" ] || { echo "FATAL: ${CURRENT_LAUNCHER} is missing or not executable" >&2; exit 1; }
  [ -f "${CURRENT_PAYLOAD}/serve.mjs" ] || { echo "FATAL: ${CURRENT_PAYLOAD}/serve.mjs is missing" >&2; exit 1; }
  # EI-21840249871617777: current-payload mode never executes the native Tauri
  # binary. Its plist runs CURRENT_LAUNCHER, which execs the bundle's Node
  # runtime against CURRENT_PAYLOAD/serve.mjs. The vm-rig legitimately carries
  # those sidecar resources without Contents/MacOS/papercusp-server; requiring
  # that unrelated binary made the persistent repair impossible after reboot
  # and left the old direct-node LaunchDaemon serving a stale schema instead.
  [ -x "${SIDECAR_DIR}/bin/node" ] || { echo "FATAL: ${SIDECAR_DIR}/bin/node is missing or not executable" >&2; exit 1; }

  # A generated sidecar is intentionally identity-less unless its launcher
  # receives PAPERCUSP_BUILD_SHA. Prefer explicit deploy input; otherwise the
  # composed payload's BUILD-STAMP.txt is the writer's immutable source pin.
  # Never accept an empty/unknown stamp: /api/health sha:null would make a
  # healthy process indistinguishable from the wrong bytes (EI-22368205971185543).
  if [ -z "$CURRENT_BUILD_SHA" ] && [ -f "${CURRENT_PAYLOAD}/BUILD-STAMP.txt" ]; then
    CURRENT_BUILD_SHA="$(sed -n 's/^sha=\([^[:space:]]*\).*/\1/p' "${CURRENT_PAYLOAD}/BUILD-STAMP.txt" | head -1)"
  fi
  case "$CURRENT_BUILD_SHA" in
    ''|unknown|*[!A-Za-z0-9._-]*)
      echo "FATAL: current-payload mode requires an explicit or stamped build SHA" >&2
      exit 2
      ;;
  esac
  if [ -z "$CURRENT_BUILD_VERSION" ] && [ -f "${CURRENT_PAYLOAD}/build-provenance.json" ]; then
    CURRENT_BUILD_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${CURRENT_PAYLOAD}/build-provenance.json" | head -1)"
  fi
  case "$CURRENT_BUILD_VERSION" in
    ''|*[!A-Za-z0-9._-]*) CURRENT_BUILD_VERSION="0.0.0" ;;
  esac
else
  [ -x "$BINARY" ] || { echo "FATAL: ${BINARY} is missing or not executable — install Papercusp Server first" >&2; exit 1; }
fi

[ -d "$SIDECAR_DIR" ] || { echo "FATAL: ${SIDECAR_DIR} is missing — the app bundle is incomplete" >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "FATAL: ${TEMPLATE} is missing" >&2; exit 1; }

# The LaunchAgent and this daemon both start the Server. Leaving both armed
# double-launches on the next GUI login; the singleton guard would close one,
# but only after two embedded-Postgres boots race for the same state tree.
AGENT_PLIST="${SERVICE_HOME}/Library/LaunchAgents/${LABEL}.plist"
if [ -f "$AGENT_PLIST" ]; then
  SERVICE_UID="$(id -u "$SERVICE_USER")"
  launchctl bootout "gui/${SERVICE_UID}/${LABEL}" 2>/dev/null || true
  mv "$AGENT_PLIST" "${AGENT_PLIST}.superseded-by-launchdaemon"
  echo "note: retired the login-scoped LaunchAgent (kept as ${AGENT_PLIST}.superseded-by-launchdaemon)"
fi

TMP_PLIST="$(mktemp -t papercusp-server-plist)"
trap 'rm -f "$TMP_PLIST"' EXIT

# Substitute via a bash replacement rather than sed so a home directory
# containing '/' or '&' cannot corrupt the output.
template_body="$(cat "$TEMPLATE")"
template_body="${template_body//__PAPERCUSP_SERVICE_USER__/$SERVICE_USER}"
template_body="${template_body//__PAPERCUSP_SERVICE_HOME__/$SERVICE_HOME}"
template_body="${template_body//__PAPERCUSP_CURRENT_PAYLOAD__/$CURRENT_PAYLOAD}"
template_body="${template_body//__PAPERCUSP_CURRENT_LAUNCHER__/$CURRENT_LAUNCHER}"
template_body="${template_body//__PAPERCUSP_CURRENT_PORT__/$CURRENT_PORT}"
template_body="${template_body//__PAPERCUSP_CURRENT_BUILD_SHA__/$CURRENT_BUILD_SHA}"
template_body="${template_body//__PAPERCUSP_CURRENT_BUILD_VERSION__/$CURRENT_BUILD_VERSION}"
printf '%s\n' "$template_body" > "$TMP_PLIST"

if ! plutil -lint "$TMP_PLIST" >/dev/null; then
  echo "FATAL: rendered plist is not valid — refusing to install" >&2
  exit 1
fi
# A leftover placeholder means the template gained a token this script does not
# substitute. Installing that yields a daemon pointing at a literal path.
if grep -q '__PAPERCUSP_' "$TMP_PLIST"; then
  echo "FATAL: unsubstituted placeholder remains in the rendered plist" >&2
  grep -n '__PAPERCUSP_' "$TMP_PLIST" >&2
  exit 1
fi

unload_if_present
if [ "$SERVICE_KIND" = "current" ]; then
  # The prior service may have been a packaged binary, a current-payload daemon,
  # or the old detached rig launcher.  Quiesce launchd first, then ask the
  # current launcher to stop only the exact PID it can prove it owns.  A held
  # port aborts before bootstrap instead of racing two embedded Postgres boots.
  if ! sudo -u "$SERVICE_USER" env \
    HOME="$SERVICE_HOME" \
    PAPERCUSP_RIG_HOME="$SERVICE_HOME" \
    PAPERCUSP_RIG_SIDECAR_DIR="$CURRENT_PAYLOAD" \
    PAPERCUSP_HONO_PORT="$CURRENT_PORT" \
    "$CURRENT_LAUNCHER" --stop-only; then
    echo "FATAL: could not quiesce the exact current-payload operator" >&2
    exit 1
  fi
fi
install -m 644 -o root -g wheel "$TMP_PLIST" "$PLIST_DEST"
# A persisted disabled override makes bootstrap fail with error 5. Enable the
# named job first; enabling after bootstrap is unreachable on that path.
launchctl enable "system/${LABEL}"
launchctl bootstrap system "$PLIST_DEST"

verify_current_service() {
  local i service_pid operator_pid command health health_sha discovery="${SERVICE_HOME}/.papercusp/operator.json"
  for i in $(seq 1 180); do
    service_pid="$(launchctl print "system/${LABEL}" 2>/dev/null \
      | sed -nE 's/^[[:space:]]*pid = ([0-9]+)$/\1/p' | head -1)"
    operator_pid="$(sed -nE 's/.*"pid"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$discovery" 2>/dev/null | head -1)"
    if [ -n "$service_pid" ] && [ "$operator_pid" = "$service_pid" ]; then
      command="$(ps -o command= -p "$service_pid" 2>/dev/null | sed 's/^[[:space:]]*//')"
      case "$command" in
        "${SIDECAR_DIR}/bin/node"*"${CURRENT_PAYLOAD}/serve.mjs"*--ensure*)
          health="$(curl -fsS -m 2 "http://127.0.0.1:${CURRENT_PORT}/api/health" 2>/dev/null || true)"
          health_sha="$(printf '%s' "$health" | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
          if lsof -nP -a -p "$service_pid" -iTCP:"$CURRENT_PORT" -sTCP:LISTEN >/dev/null 2>&1 \
            && [ "$health_sha" = "$CURRENT_BUILD_SHA" ]; then
            echo "verified current LaunchDaemon pid=${service_pid} owns :${CURRENT_PORT}, exact payload ${CURRENT_PAYLOAD}/serve.mjs, buildSha=${health_sha}"
            return 0
          fi
          ;;
      esac
    fi
    sleep 1
  done
  echo "FATAL: system/${LABEL} never proved exact current-payload PID/port ownership" >&2
  launchctl print "system/${LABEL}" >&2 || true
  unload_if_present
  return 1
}

if [ "$SERVICE_KIND" = "current" ]; then
  verify_current_service || exit 1
fi

echo "installed ${PLIST_DEST} (user=${SERVICE_USER} home=${SERVICE_HOME})"
echo
launchctl print "system/${LABEL}" | sed -n '1,12p'
echo
echo "It now starts at boot with no login. Verify across a reboot with:"
echo "  launchctl print system/${LABEL} | grep -E 'state|pid'"
echo "  log show --predicate 'process == \"papercusp-server\"' --last 10m"
