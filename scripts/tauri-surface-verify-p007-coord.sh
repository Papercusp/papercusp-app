#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-coord.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "coord" surface.
#
# /coord is the multi-agent coordination dashboard (CoordDashboard,
# apps/operator/app/coord/CoordDashboard.tsx) — four nuqs-backed panels
# (sessions/inbox/plans/history), default "sessions". Already covered by a
# WRONG-TRANSPORT Playwright spec per D-001.
#
# GOTCHA #1: CoordDashboard's tab buttons use CSS-module classes (styles.tabButton
# etc.), which are content-hashed at build time and NOT selectable by a fixed
# CSS selector. There is no [value]/data-testid on them either. So — like
# quick-panel's Radix workaround — this script finds + clicks the "Inbox" tab
# button by textContent via eval, not by CSS selector.
#
# GOTCHA #2 (found live 2026-08-27): a bare `nav button` selector is NOT scoped
# to CoordDashboard's own <nav> — ChromeShell's global header chrome
# (apps/operator/app/_components/ChromeShell.tsx) renders its OWN
# <nav aria-label="Primary navigation"> on every page, and components inside it
# (NotificationCenter, RecentActionsCenter, ThemeSelector, ...) render real
# <button> elements. `document.querySelectorAll('nav button')` picks up BOTH
# navs, so an exact `.join(',') === 'Sessions,Inbox,Plans,History'` check fails
# even though CoordDashboard rendered correctly (proven by the interaction step
# below still finding+clicking "Inbox" via `.find()`, which tolerates extras).
# Fix: scope to the nav WITHOUT an aria-label — CoordDashboard's own <nav> has
# none; ChromeShell's does (`aria-label="Primary navigation"`).
#
# READ-ONLY: switching panels (?panel=inbox) is a pure client-side nuqs state
# change; nothing here mutates data.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-coord.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
: "${VERIFY_TAURI_POLL:?missing VERIFY_TAURI_POLL — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_COORD_OUT:-/tmp/pcv-p007-coord-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/3] /coord: dashboard shell rendered (title + 4 tab buttons), console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /coord --json >/dev/null
VERIFY_TAURI_DOM_TIMEOUT=30 "$VERIFY_TAURI_POLL" \
  --eval "document.querySelector('h1')?.textContent === 'Coordination' && Array.from(document.querySelectorAll('nav:not([aria-label]) button')).map(b=>b.textContent).join(',') === 'Sessions,Inbox,Plans,History'" \
  --no-errors \
  | tee "$OUT_DIR/coord-content-check.json" \
  || fail "coord: expected title + 4 tab buttons (Sessions,Inbox,Plans,History) did not render cleanly"

echo "=== [2/3] primary interaction: click the 'Inbox' tab (by textContent, no stable CSS selector), confirm ?panel=inbox ==="
# NOTE (tauri-agent-tools gotcha): `eval` does NOT accept --json (only
# check/navigate/probe do) — dispatch the click via `check --eval`, which DOES
# support --json and asserts the click actually found+fired on its target.
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "(() => { const b = Array.from(document.querySelectorAll('nav:not([aria-label]) button')).find(x => x.textContent === 'Inbox'); if (!b) return false; b.click(); return true; })()" \
  --json | tee "$OUT_DIR/coord-inbox-click.json" \
  || fail "coord: could not find/click the 'Inbox' tab button by textContent"
sleep 1
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "new URLSearchParams(location.search).get('panel') === 'inbox'" \
  --json | tee "$OUT_DIR/coord-panel-check.json" \
  || fail "coord: clicking the Inbox tab did not switch ?panel= to inbox"

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=coord output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=coord output=$OUT_DIR"
