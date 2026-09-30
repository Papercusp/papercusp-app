#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-admin.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "admin" surface.
#
# /admin is a beforeLoad throw-redirect to /admin/run (apps/operator-vite/
# src/routes/admin/index.tsx) — same shape as /signup's redirect. /admin/run
# renders AdminShell (h1 = "Run", a Radix Tabs.Root tablist of real
# TanStack-Router <Link> nav items: Run/Features/Triggers/Recipes/Git/
# Substrate/DBOS/Schedules/Tasks/Cupboard) wrapping AdminOps, which fetches
# GET /api/admin/commands on mount. The shell (h1 + tablist) renders
# synchronously and does NOT depend on that fetch, so unlike settings/profile
# this script does not need a poll-for-ready guard for the content check —
# only AdminOps's own inner content would, and this surface's assertions
# never touch it.
#
# READ-ONLY: the primary interaction clicks the real "Features" nav link
# (ordinary client-side route navigation) and never touches any
# mutating admin control (run/kill/trigger buttons live inside AdminOps and
# are deliberately not exercised here).
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-admin.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_ADMIN_OUT:-/tmp/pcv-p007-admin-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/3] /admin: redirect fires to /admin/run, shell content rendered, console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /admin --json >/dev/null
sleep 1.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "location.pathname === '/admin/run' && document.querySelector('h1')?.textContent?.trim() === 'Run' && !!document.querySelector('a[href=\"/admin/features\"]')" \
  --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/admin-content-check.json" \
  || fail "admin: expected redirect to /admin/run + shell (h1 'Run' + Features nav link) did not render cleanly"

echo "=== [2/3] primary interaction: click the 'Features' nav link, confirm real navigation ==="
"$TOOL" click --pid "$VERIFY_TAURI_PID" 'a[href="/admin/features"]' --json >/dev/null \
  || fail "admin: click on Features nav link failed"
sleep 1
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "location.pathname === '/admin/features'" \
  --json | tee "$OUT_DIR/admin-features-nav-check.json" \
  || fail "admin: clicking the Features tab did not navigate to /admin/features"

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=admin output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=admin output=$OUT_DIR"
