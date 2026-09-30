#!/usr/bin/env bash
#
# verify-desktop-ipc.sh — end-to-end verification of the
# endpoint-IPC stack (papercup#sse-typed-events branch +
# papercusp-desktop#sse-typed-events-ipc branch).
#
# Runs the desktop with PAPERCUSP_DESKTOP_IPC=1 and watches for:
#   1. The sidecar's stdout PAPERCUSP_IPC_READY socket=<path> line.
#   2. The Rust IpcClient::connect log line.
#   3. The socket file existing on disk (Linux/macOS) or named pipe
#      existing (Windows).
#
# When all three land, the stack is verified end-to-end. The user can
# then open /dev → IPC tab to interactively exercise dev:ipc_echo.
#
# Usage:
#   ./bin/verify-desktop-ipc.sh                  # foreground; logs to stdout
#   LOG=/tmp/log ./bin/verify-desktop-ipc.sh    # explicit log path
#
# Exit codes:
#   0  — all three signals observed within timeout
#   1  — PAPERCUSP_IPC_READY line never appeared
#   2  — IpcClient::connect log line never appeared
#   3  — socket file/named pipe never materialized
#   4  — build/launch failed

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LOG="${LOG:-/tmp/papercusp-desktop-ipc-verify.log}"
TIMEOUT_SEC="${TIMEOUT_SEC:-60}"

cd "$ROOT"

echo "==> branch check"
BRANCH="$(git -C src-tauri rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
TOPLEVEL_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ "$TOPLEVEL_BRANCH" != "sse-typed-events-ipc" ]]; then
  echo "    WARNING: not on sse-typed-events-ipc (currently on $TOPLEVEL_BRANCH)"
  echo "    The IPC code only exists on that branch. Continuing anyway."
fi

echo "==> building desktop (debug)"
if ! (cd src-tauri && cargo build --quiet) > "$LOG" 2>&1; then
  echo "    BUILD FAILED — see $LOG"
  exit 4
fi
echo "    OK"

echo "==> killing any running papercusp-desktop"
pgrep -af "papercusp-desktop|embedded-postgres-server" \
  | grep -v "$$" | grep -v "pgrep\|grep " | awk '{print $1}' \
  | xargs -r kill 2>/dev/null || true
sleep 2

BIN="$ROOT/src-tauri/target/debug/papercusp-desktop"
if [[ ! -x "$BIN" ]]; then
  echo "    EXPECTED BINARY MISSING: $BIN"
  exit 4
fi

echo "==> launching desktop with PAPERCUSP_DESKTOP_IPC=1 (log=$LOG)"
PAPERCUSP_DESKTOP_IPC=1 nohup "$BIN" > "$LOG" 2>&1 &
DESKTOP_PID=$!
echo "    pid=$DESKTOP_PID, polling $LOG for the three signals..."

trap '
  echo "==> cleanup: killing desktop pid=$DESKTOP_PID"
  kill $DESKTOP_PID 2>/dev/null || true
  sleep 1
  pgrep -af "papercusp-desktop|embedded-postgres-server" \
    | grep -v "$$" | grep -v "pgrep\|grep " | awk "{print \$1}" \
    | xargs -r kill 2>/dev/null || true
' EXIT

deadline=$(( $(date +%s) + TIMEOUT_SEC ))

# Signal 1: PAPERCUSP_IPC_READY line on Node sidecar's stdout
ready_socket=""
while [[ $(date +%s) -lt $deadline ]]; do
  if line=$(grep -m1 "PAPERCUSP_IPC_READY socket=" "$LOG" 2>/dev/null); then
    ready_socket="${line#*socket=}"
    ready_socket="${ready_socket%$'\n'}"
    break
  fi
  sleep 0.5
done
if [[ -z "$ready_socket" ]]; then
  echo "    [FAIL signal 1] never saw PAPERCUSP_IPC_READY line"
  exit 1
fi
echo "    [OK signal 1] sidecar printed: socket=$ready_socket"

# Signal 2: Rust-side log "endpoint-ipc client connected"
client_ready=""
while [[ $(date +%s) -lt $deadline ]]; do
  if grep -q "endpoint-ipc client connected" "$LOG"; then
    client_ready="yes"
    break
  fi
  # Connect-failure also counts (we want the bug surfaced):
  if grep -q "endpoint-ipc client connect failed" "$LOG"; then
    echo "    [FAIL signal 2] Rust IpcClient::connect failed:"
    grep "endpoint-ipc client" "$LOG" | tail -3
    exit 2
  fi
  if grep -q "endpoint-ipc handshake timeout" "$LOG"; then
    echo "    [FAIL signal 2] Rust forwarder thread never received the ready line"
    exit 2
  fi
  sleep 0.5
done
if [[ -z "$client_ready" ]]; then
  echo "    [FAIL signal 2] Rust IpcClient::connect log line never appeared"
  exit 2
fi
echo "    [OK signal 2] Rust client connected"

# Signal 3: socket file exists (Unix) or named pipe (Windows)
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
  # Named pipes don't show up in `ls`. Skip this signal on Windows.
  echo "    [SKIP signal 3] Windows named pipe — can't easily test from bash"
else
  if [[ ! -S "$ready_socket" ]]; then
    echo "    [FAIL signal 3] socket path does not exist as socket: $ready_socket"
    exit 3
  fi
  echo "    [OK signal 3] socket file exists at $ready_socket"
fi

echo ""
echo "==> ALL SIGNALS OBSERVED"
echo "Stack verified end-to-end."
echo ""
echo "Next: open the Tauri window (will appear in foreground) and"
echo "navigate to /dev → IPC tab. Click 'Run dev:ipc_echo'. You should"
echo "see 'Selected transport: IPC' and the delta + done events fire."
echo ""
echo "Desktop pid=$DESKTOP_PID still running. Ctrl-C to stop, or run:"
echo "  kill $DESKTOP_PID"
echo ""

# Don't kill on exit when verifying interactively.
trap - EXIT
wait $DESKTOP_PID
