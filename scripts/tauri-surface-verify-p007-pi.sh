#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-pi.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "pi" surface (PiTerminalsDock,
# apps/operator/app/harness/PiTerminalsDock.tsx, translated at
# apps/operator-vite/src/routes/pi.tsx).
#
# /pi REQUIRES `?harness=<slug>` (validateSearch-parsed) to render real
# content; without it the route deliberately shows a "Missing ?harness="
# message rather than crashing or 404ing. This leg asserts BOTH states, per
# the surface's own documented caveat (see pi.tsx's own module doc + the
# WI-113495 assignment note).
#
# DELIBERATELY NO CLICK INTERACTION HERE (unlike the sibling P-007 legs):
# PiTerminalsDock's only interactive control, `.pi-dock__add-btn`, spawns a
# REAL pty process (POST /pty/spawn per the component's own `firePrewarmOnce`
# comment) — and per that same comment, simply LOADING /pi with a valid
# harness slug ALREADY fires that prewarm once, unconditionally, regardless
# of any click. There is no side-effect-free interactive element to exercise
# on this surface, so the "primary interaction" leg here is the with-param
# vs without-param content-state DISTINCTION itself (two genuinely different
# render paths, both asserted) rather than a click.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_POLL into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-pi.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
: "${VERIFY_TAURI_POLL:?missing VERIFY_TAURI_POLL}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_PI_OUT:-/tmp/pcv-p007-pi-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/3] /pi (no harness param): graceful 'Missing ?harness=' message, not a crash/404 ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /pi --json >/dev/null
sleep 1
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.body.textContent?.includes('Missing') && document.body.textContent?.includes('harness')" \
  --no-errors --json | tee "$OUT_DIR/pi-missing-harness-check.json" \
  || fail "pi: no-param case did not render the expected 'Missing ?harness=' message"

echo "=== [2/3] /pi?harness=papercusp: real PiTerminalsDock content renders ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" "/pi?harness=papercusp" --json >/dev/null
if VERIFY_TAURI_DOM_TIMEOUT=30 "$VERIFY_TAURI_POLL" --selector '.pi-dock' \
  --eval "document.querySelector('.pi-dock__header') !== null" \
  --no-errors; then
  :
else
  fail "pi: with harness=papercusp, the terminals dock never rendered"
fi
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('.pi-dock') !== null && document.querySelector('.pi-dock__header') !== null" \
  --json | tee "$OUT_DIR/pi-content-check.json" \
  || fail "pi: with-param content check failed"

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=pi output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=pi output=$OUT_DIR"
