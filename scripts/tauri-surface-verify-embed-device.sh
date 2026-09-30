#!/usr/bin/env bash
# Isolated desktop acceptance for memory-reduction-2026-09-24 P-008.
#
# Run only through scripts/verify-tauri-headless.sh with an isolated, ready DB:
#
#   VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready \
#     scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-embed-device.sh
#
# The database isolation is part of the contract: this verifier changes the
# workspace embedding preference and must never write the owner's real row.
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
: "${VERIFY_TAURI_POLL:?missing VERIFY_TAURI_POLL — run via scripts/verify-tauri-headless.sh}"
: "${VERIFY_TAURI_ISOLATED_DB:?set VERIFY_TAURI_ISOLATED_DB=1 for this write-path verifier}"

if [ "$VERIFY_TAURI_ISOLATED_DB" != "1" ]; then
  echo "P008_TAURI_SURFACE_VERIFY_FAIL leg=embed-device reason=isolated-db-required" >&2
  exit 2
fi

TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_EMBED_DEVICE_OUT:-/tmp/pcv-embed-device-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() {
  echo "P008_TAURI_SURFACE_VERIFY_FAIL leg=embed-device $*" >&2
  FAIL=1
}

TRIGGER='[aria-label="Embedding device"]'

echo "=== [1/4] shipped Memory route renders the control ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /settings/user/memory --json \
  >"$OUT_DIR/navigate.json" \
  || fail "step=navigate"
"$VERIFY_TAURI_POLL" \
  --selector '[data-testid="embed-device-section"]' \
  --text 'Embedding device' \
  --no-errors \
  || fail "step=render"
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('$TRIGGER')?.textContent?.includes('Auto') === true" \
  --json >"$OUT_DIR/initial-choice.json" \
  || fail "step=initial-choice expected=Auto"

echo "=== [2/4] native Radix interaction selects CPU ==="
"$TOOL" click --pid "$VERIFY_TAURI_PID" "$TRIGGER" --wait 3000 --json \
  >"$OUT_DIR/open-select.json" \
  || fail "step=open-select"
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "(() => { const option = [...document.querySelectorAll('[role=option]')].find((node) => node.textContent?.trim() === 'CPU'); if (!option) return false; option.setAttribute('data-e2e-embed-device', 'cpu'); return true; })()" \
  --json >"$OUT_DIR/mark-cpu-option.json" \
  || fail "step=find-cpu-option"
"$TOOL" click --pid "$VERIFY_TAURI_PID" '[data-e2e-embed-device="cpu"]' --wait 3000 --json \
  >"$OUT_DIR/select-cpu.json" \
  || fail "step=select-cpu"
"$VERIFY_TAURI_POLL" \
  --require "$TRIGGER" \
  --eval "document.querySelector('$TRIGGER')?.textContent?.includes('CPU') === true && document.querySelector('$TRIGGER')?.getAttribute('data-disabled') !== ''" \
  || fail "step=choice-applied expected=CPU"

echo "=== [3/4] persisted route state reports CPU ==="
"$TOOL" eval --pid "$VERIFY_TAURI_PID" \
  "(async () => { const response = await fetch('/api/user/embed-device'); const body = await response.json(); return JSON.stringify({ status: response.status, preference: body.setting, host: body.host?.kind }); })()" \
  >"$OUT_DIR/api-state.txt" \
  || fail "step=api-read"
grep -qE '"status"[[:space:]]*:[[:space:]]*200' "$OUT_DIR/api-state.txt" \
  || fail "step=api-status expected=200"
grep -qE '"preference"[[:space:]]*:[[:space:]]*"cpu"' "$OUT_DIR/api-state.txt" \
  || fail "step=api-preference expected=cpu"

echo "=== [4/4] negative control + screenshot ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --selector '[data-testid="embed-device-section-DOES-NOT-EXIST"]' --json \
  >"$OUT_DIR/negative-control.json" 2>&1; then
  fail "step=negative-control missing-selector-unexpectedly-passed"
fi
"$TOOL" screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT_DIR/embed-device-cpu.png" \
  >/dev/null \
  || fail "step=screenshot"

if [ "$FAIL" -ne 0 ]; then
  echo "P008_TAURI_SURFACE_VERIFY_FAIL leg=embed-device output=$OUT_DIR" >&2
  exit 1
fi

echo "P008_TAURI_SURFACE_VERIFY_OK leg=embed-device output=$OUT_DIR"
