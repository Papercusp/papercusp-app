#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-signup.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for /signup.
#
# /signup has no content of its own: apps/operator-vite/src/routes/signup.tsx
# unconditionally throw-redirects (`beforeLoad`) to `/login?mode=signup`
# before any component renders. The regression-catching assertion is
# therefore that the redirect actually fires (location leaves /signup) and
# the app settles somewhere coherent with no console errors — if the
# beforeLoad throw were ever removed/broken, this would instead observe a
# stuck blank/loading page at /signup forever. Whether it lands on the
# create-user form (`h1` = "Create a user", unauthenticated) or is further
# redirected to /adv (authenticated — the same auth-gate behavior verified
# for /login in scripts/tauri-surface-verify-p007-login.sh) is not this
# surface's own concern; both are legitimate downstream outcomes.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-signup.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_SIGNUP_OUT:-/tmp/pcv-p007-signup-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/2] /signup: redirect fires (leaves /signup), console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /signup --json >/dev/null
sleep 1.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "location.pathname !== '/signup'" \
  --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/signup-redirect-check.json" \
  || fail "signup: the beforeLoad redirect never fired — app stuck on /signup"
"$TOOL" eval --pid "$VERIFY_TAURI_PID" "'landed on: ' + location.pathname + location.search" \
  | tee "$OUT_DIR/signup-landing.txt" >/dev/null

echo "=== [2/2] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=signup output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=signup output=$OUT_DIR"
