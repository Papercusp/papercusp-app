#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-dev.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "dev" surface.
#
# /dev (apps/operator/app/dev/page.tsx) — cross-harness developer console:
# left rail workspace picker + tab nav (.pc-dev-nav, plain string classes —
# NOT CSS-modules), main content (.pc-dev-main), default tab 'api'
# (URL-backed via ?tab=). Tab buttons are `.pc-dev-tab` with an `.is-active`
# class marking the current one.
#
# GOTCHA (learned on coord, applies everywhere): don't assert an exact join
# over a bare `nav button` / any unscoped selector — ChromeShell's global
# header <nav aria-label="Primary navigation"> also renders real buttons
# (NotificationCenter etc.) on every page. Not an issue here since we select
# by the specific `.pc-dev-tab` class, not a bare `nav button`.
#
# READ-ONLY: switching the dev-console tab is pure client-side nuqs state;
# nothing here mutates data (we do NOT touch the SQL/terminal/backups tabs).
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-dev.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_DEV_OUT:-/tmp/pcv-p007-dev-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/3] /dev: shell + tab nav + main content rendered, console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /dev --json >/dev/null
sleep 2
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "!!document.querySelector('.pc-dev-shell') && !!document.querySelector('.pc-dev-nav') && document.querySelectorAll('.pc-dev-tab').length > 5 && !!document.querySelector('.pc-dev-main')" \
  --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/dev-content-check.json" \
  || fail "dev: expected .pc-dev-shell/.pc-dev-nav (>5 tabs)/.pc-dev-main did not render cleanly"

echo "=== [2/3] primary interaction: click the 'Sessions' tab, confirm ?tab=sessions + is-active moves ==="
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "(() => { const b = Array.from(document.querySelectorAll('.pc-dev-tab')).find(x => x.textContent?.includes('Sessions')); if (!b) return false; b.click(); return true; })()" \
  --json | tee "$OUT_DIR/dev-sessions-click.json" \
  || fail "dev: could not find/click the 'Sessions' tab button by textContent"
sleep 1
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "new URLSearchParams(location.search).get('tab') === 'sessions' && Array.from(document.querySelectorAll('.pc-dev-tab')).find(x => x.textContent?.includes('Sessions'))?.classList.contains('is-active')" \
  --json | tee "$OUT_DIR/dev-sessions-active.json" \
  || fail "dev: clicking the Sessions tab did not switch ?tab= or mark it is-active"

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=dev output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=dev output=$OUT_DIR"
