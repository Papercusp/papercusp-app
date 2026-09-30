#!/usr/bin/env bash
# scripts/tauri-surface-verify-p003-quick-panel.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-003 — live, Tauri-driven,
# regression-failing verification for the /quick-panel surface.
#
# Scope note (plan Decision D-004): P-003 originally also named fleet-status
# and weather, but neither has a route in apps/operator-vite/src/routes (the
# ONLY real route source for the shipped Tauri SPA — apps/operator/app/** is
# the retired Next.js tree). Confirmed live: navigating to /fleet-status and
# /weather in this same instance both land on __root.tsx's notFoundComponent
# (a real 404, not a test bug). D-004 narrows P-003 to /quick-panel only;
# FleetStatusPanel/WeatherWidget are tracked as orphaned code on
# EI-21610745208896793, not as a verification gap here.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p003-quick-panel.sh
#
# EI-21620xxxxxx (filed alongside this script): the FIRST verification
# attempts drove the primary interaction (clicking the Brainstorm tab) via
# `tauri-agent-tools eval` calling the DOM element's `.click()` method
# directly. That produced a false negative — `.click()` dispatches only a
# synthetic `click` event, and this app's Radix UI `Tabs.Trigger` activates
# on the pointer-down sequence, not on a bare `click`. The tab's own
# `data-state` attribute never flipped even though `.click()` reported
# success. Repeating the SAME interaction via `tauri-agent-tools click`
# (which dispatches a real mouse event sequence) passes reliably. This
# script therefore uses the native `click` subcommand, not an eval hack —
# do not "fix" a future selector failure here by reverting to
# `eval ...click()`; that reintroduces the false negative.
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P003_QUICK_PANEL_OUT:-/tmp/pcv-p003-quick-panel-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P003_FAIL $*" >&2; FAIL=1; }

validate_screenshot() {
  local file="$1"
  [ -s "$file" ] || { fail "screenshot missing/empty: $file"; return 1; }
  local sig
  sig="$(head -c 8 "$file" | od -An -tx1 | tr -d ' \n')"
  [ "$sig" = "89504e470d0a1a0a" ] || { fail "screenshot not a PNG: $file (sig=$sig)"; return 1; }
  return 0
}

echo "=== [1/3] quick-panel: content rendered, console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /quick-panel --json >/dev/null
sleep 1.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-qp__tabs" --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/content-check.json" \
  || fail "quick-panel: .pc-qp__tabs render / no-errors check failed"

echo "=== [2/3] primary interaction: click Brainstorm tab (native click, not eval .click()) ==="
BRAINSTORM_SEL='.pc-qp__tab[aria-controls$="-content-brainstorm"]'
"$TOOL" click --pid "$VERIFY_TAURI_PID" "$BRAINSTORM_SEL" --wait 2000 --json \
  | tee "$OUT_DIR/interaction-click.json" \
  || fail "quick-panel: native click on Brainstorm tab failed"
sleep 0.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('${BRAINSTORM_SEL}')?.getAttribute('data-state') === 'active'" \
  --json | tee "$OUT_DIR/interaction-check.json" \
  || fail "quick-panel: Brainstorm tab did not activate (data-state != active) after click"
# Let any lazy-loaded Brainstorm/Excalidraw async work settle before the
# negative control and teardown, so its console/network activity doesn't
# bleed into a later run's own no-errors window (observed empirically).
sleep 3

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-weather-widget-DOES-NOT-EXIST" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

"$TOOL" screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT_DIR/quick-panel-brainstorm.png" >/dev/null \
  && validate_screenshot "$OUT_DIR/quick-panel-brainstorm.png" \
  || fail "quick-panel: screenshot capture failed"

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P003_TAURI_SURFACE_VERIFY_FAIL leg=quick-panel output=$OUT_DIR" >&2
  exit 1
fi
echo "P003_TAURI_SURFACE_VERIFY_OK leg=quick-panel output=$OUT_DIR"
