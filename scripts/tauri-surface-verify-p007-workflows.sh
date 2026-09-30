#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-workflows.sh
#
# Live, read-only Tauri acceptance for the Workflows "New workflow" popup.
# Run only through scripts/verify-tauri-headless.sh, which supplies the owned
# bridge PID and the bounded DOM poll helper:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-workflows.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID}"
: "${VERIFY_TAURI_POLL:?missing VERIFY_TAURI_POLL}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

FAIL=0
fail() { echo "P007_WORKFLOWS_FAIL $*" >&2; FAIL=1; }

echo "=== [1/4] Workflows frame and New workflow control render ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" '/adv?tab=workflows' --json >/dev/null \
  || fail "navigate to Workflows failed"
if ! VERIFY_TAURI_DOM_TIMEOUT=120 "$VERIFY_TAURI_POLL" \
  --selector '.pc-wf' \
  --eval 'document.querySelector(".pc-wf") !== null && document.body.innerText.includes("Workflows")' \
  --no-errors; then
  fail "Workflows frame did not render"
fi

echo "=== [2/5] Open canonical composer, then enter advanced setup ==="
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval '(() => { const b = Array.from(document.querySelectorAll("button")).find(x => x.textContent?.includes("New workflow")); if (!b) return false; b.click(); return true; })()' \
  --json || fail "New workflow control missing or could not be clicked"

if ! VERIFY_TAURI_DOM_TIMEOUT=30 "$VERIFY_TAURI_POLL" \
  --selector '[role="dialog"]' \
  --eval '(() => { const d = document.querySelector("[role=dialog]"); return !!d && d.textContent?.includes("Advanced manual setup"); })()' \
  --no-errors; then
  fail "workflow composer did not render its advanced setup action"
fi
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval '(() => { const d = document.querySelector("[role=dialog]"); const b = d && Array.from(d.querySelectorAll("button")).find(x => x.textContent?.includes("Advanced manual setup")); if (!b) return false; b.click(); return true; })()' \
  --json || fail "Advanced manual setup action missing or could not be clicked"

echo "=== [3/5] Verify searchable picker + truthful action contract ==="
if ! VERIFY_TAURI_DOM_TIMEOUT=30 "$VERIFY_TAURI_POLL" \
  --selector '[role="dialog"]' \
  --eval '(() => { const d = document.querySelector("[role=dialog]"); return !!d && !!d.querySelector("[role=combobox]") && d.textContent?.includes("Activate a goal") && d.textContent?.includes("Arbitrary tool-name dispatch is not available"); })()' \
  --no-errors; then
  fail "popup searchable/action contract did not render"
fi

echo "=== [4/5] Switch trigger mode and verify target controls remain usable ==="
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval '(() => { const d = document.querySelector("[role=dialog]"); const b = d && Array.from(d.querySelectorAll("button")).find(x => x.textContent?.includes("External event")); if (!b) return false; b.click(); return true; })()' \
  --json || fail "External event trigger control missing"
if ! VERIFY_TAURI_DOM_TIMEOUT=30 "$VERIFY_TAURI_POLL" \
  --selector '[role="dialog"] [role="combobox"]' \
  --eval '(() => { const d = document.querySelector("[role=dialog]"); return !!d?.querySelector("[role=combobox][aria-label=\"Plan to run\"]") && !!Array.from(d.querySelectorAll("button")).find(x => x.textContent?.includes("Activate a goal")); })()' \
  --no-errors; then
  fail "target controls disappeared after selecting an external trigger"
fi

echo "=== [5/5] Falsifiability negative control ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector '.pc-does-not-exist-workflows-sentinel' --json; then
  fail "missing-selector negative control unexpectedly passed"
else
  echo "negative control confirmed"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=workflows" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=workflows"
