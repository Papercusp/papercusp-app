#!/usr/bin/env bash
# Diagnostic-only, throwaway: isolate WHY the coord content-check failed.
set -uo pipefail
: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"

"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /coord --json >/dev/null
sleep 2
echo "--- h1 text (--text substring check) ---"
"$TOOL" check --pid "$VERIFY_TAURI_PID" --text "Coordination" --json
echo "--- h1 present at all? ---"
"$TOOL" check --pid "$VERIFY_TAURI_PID" --eval "!!document.querySelector('h1')" --json
echo "--- nav button count === 4 ? ---"
"$TOOL" check --pid "$VERIFY_TAURI_PID" --eval "document.querySelectorAll('nav button').length === 4" --json
echo "--- nav present at all? ---"
"$TOOL" check --pid "$VERIFY_TAURI_PID" --eval "!!document.querySelector('nav')" --json
echo "--- dom dump of nav ---"
"$TOOL" dom --pid "$VERIFY_TAURI_PID" nav 2>&1 | head -40
echo "--- raw h1 textContent via eval (no --json, plain stdout) ---"
"$TOOL" eval --pid "$VERIFY_TAURI_PID" "document.querySelector('h1')?.textContent ?? 'NO_H1'"
echo "--- raw url ---"
"$TOOL" eval --pid "$VERIFY_TAURI_PID" "location.href"
