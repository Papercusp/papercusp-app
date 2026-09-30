#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-cupboard.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "cupboard" surface.
#
# /cupboard (apps/operator-vite/src/routes/cupboard/index.tsx →
# apps/operator/app/cupboard/CupboardClient.tsx) — the Cupboard registry card
# grid. Real `data-testid` attributes throughout (cupboard-results,
# cupboard-kind-tab-<kind>, ...) — no textContent/CSS-module workaround
# needed here. Kind filter tabs use `aria-pressed` for active state.
#
# READ-ONLY: switching the kind filter is pure client-side UI state; nothing
# here mutates an install.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-cupboard.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_CUPBOARD_OUT:-/tmp/pcv-p007-cupboard-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/3] /cupboard: h1 + results grid rendered, console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /cupboard --json >/dev/null
sleep 2
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "!!document.querySelector('h1') && !!document.querySelector('[data-testid=\"cupboard-results\"]')" \
  --no-errors --duration 2500 --json \
  | tee "$OUT_DIR/cupboard-content-check.json" \
  || fail "cupboard: expected h1 + [data-testid=cupboard-results] did not render cleanly"

echo "=== [2/3] primary interaction: click a kind filter tab, confirm aria-pressed flips ==="
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "!!document.querySelector('[data-testid=\"cupboard-kind-tab-tools\"]')" \
  --json | tee "$OUT_DIR/cupboard-tools-tab-present.json" \
  || fail "cupboard: expected a [data-testid=cupboard-kind-tab-tools] filter button"
"$TOOL" click --pid "$VERIFY_TAURI_PID" '[data-testid="cupboard-kind-tab-tools"]' --json >/dev/null \
  || fail "cupboard: click on the 'tools' kind tab failed"
sleep 1
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('[data-testid=\"cupboard-kind-tab-tools\"]')?.getAttribute('aria-pressed') === 'true'" \
  --json | tee "$OUT_DIR/cupboard-tools-pressed.json" \
  || fail "cupboard: clicking the 'tools' kind tab did not set aria-pressed=true"

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=cupboard output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=cupboard output=$OUT_DIR"
