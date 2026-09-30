#!/usr/bin/env bash
# verify-operator-respawn-vm.sh — WI-3170 Phase 2 (P-004) live VM verify.
#
# Verifies the Windows/WSL operator-respawn fix in
# papercusp-desktop/src-tauri/src/main.rs (decide_serve_respawn): when the inner
# WSL node operator dies but the wsl.exe WRAPPER Child outlives it (so
# child_exited stays false), the Papercusp Server app must respawn the operator
# within the ~15s unreachable debounce — instead of leaving it durably dead
# (the owner-reported "operator goes down all the time" bug; VM forensics: down
# ~11 min with no respawn).
#
# ┌─ RUN CONDITIONS (READ FIRST) ───────────────────────────────────────────┐
# │ • Coordinate with the windows-parity fleet leader (su-b0fbf) BEFORE       │
# │   running — the owner may be live-testing; this script KILLS the operator.│
# │ • Run INSIDE the VM's WSL (where serve.mjs runs), with the FIXED Server   │
# │   app (staging ≥ submodule 165451a) installed AND running.                │
# │ • The live port is read from operator.json — never assume :3070/:21533.   │
# └───────────────────────────────────────────────────────────────────────────┘
#
# Exit 0 = PASS (operator respawned + healthy). Non-zero = FAIL / setup error.
set -uo pipefail

DISCOVERY="${PAPERCUSP_OPERATOR_JSON:-${HOME}/.papercusp/operator.json}"
RECOVER_TIMEOUT_S="${RECOVER_TIMEOUT_S:-90}"   # 15s debounce + fresh-boot headroom

read_field() { # $1=field
  node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(o[process.argv[2]]??""))}catch(e){process.exit(1)}' \
    "$DISCOVERY" "$1" 2>/dev/null
}
health() { curl -fsS --max-time 3 "http://127.0.0.1:${1}/api/health" >/dev/null 2>&1; }

echo "[verify] discovery: $DISCOVERY"
[ -f "$DISCOVERY" ] || { echo "SETUP-FAIL: no operator.json — is the Server app running?"; exit 2; }

PORT0="$(read_field port)"; PID0="$(read_field pid)"
echo "[verify] baseline operator: port=${PORT0:-?} pid=${PID0:-?}"
[ -n "$PORT0" ] || { echo "SETUP-FAIL: operator.json has no port"; exit 2; }
if ! health "$PORT0"; then echo "SETUP-FAIL: baseline operator not healthy — start clean before testing"; exit 2; fi
echo "[verify] baseline health OK"

# Reproduce the exact blind spot: kill ONLY the inner WSL node operator; leave
# the wsl.exe wrapper + the Server app alive. This is precisely the case where
# child_exited stays false but the operator is durably gone.
echo "[verify] killing inner serve.mjs operator (pid=${PID0:-none}) …"
[ -n "$PID0" ] && kill "$PID0" 2>/dev/null || true
pkill -f 'serve\.mjs' 2>/dev/null || true
sleep 2
health "$PORT0" && echo "[verify] WARN: still healthy on old port right after kill — the kill may not have landed"

echo "[verify] waiting up to ${RECOVER_TIMEOUT_S}s for the Server to respawn the operator …"
t=0
while [ "$t" -lt "$RECOVER_TIMEOUT_S" ]; do
  sleep 3; t=$((t+3))
  PORT1="$(read_field port)"; PID1="$(read_field pid)"
  if [ -n "$PORT1" ] && health "$PORT1"; then
    echo "[verify] RECOVERED after ~${t}s: port=${PORT1} pid=${PID1:-?} (was port=${PORT0} pid=${PID0:-?})"
    [ "$PID1" = "$PID0" ] && echo "[verify] NOTE: pid unchanged — confirm it is a fresh process, not the one we killed"
    echo "PASS: operator respawned + healthy — WI-3170 Windows/WSL respawn fix works."
    exit 0
  fi
done

echo "FAIL: operator did NOT recover within ${RECOVER_TIMEOUT_S}s — the respawn fix did not engage."
echo "      (Check: is the installed build ≥ submodule 165451a? Server stderr is discarded on Windows —"
echo "       verify via operator.json port rotation + /api/health, not logs.)"
exit 1
