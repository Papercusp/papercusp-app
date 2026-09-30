#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-adv.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "adv" surface.
#
# /adv is the main authenticated operator shell (AdvShell,
# apps/operator-vite/src/components/adv/AdvShell.tsx) — a huge multi-tab
# workspace (overview/hud/workflows/conversations/learning/harnesses/health/
# frames/evals/stats/calendar/history/prs/insights/settings/docs/git/testing/
# plans), already covered by ~10 separate WRONG-TRANSPORT Playwright specs
# (apps/operator/e2e/adv-*.spec.ts) per D-001. Replicating all of those in
# Tauri form is its own multi-wake project, not this pass's bar — this script
# matches the depth used for every other P-007 surface: shell content
# rendered (default landing = "overview" tab, per AdvIndexPage), one real
# primary interaction (switch tabs), no console errors, negative control.
#
# GOTCHA (already logged for P-003's quick-panel): AdvShell's tab strip is a
# Radix Tabs.Trigger, which has NO [value] DOM attribute — but here each
# trigger's className embeds its tab id (`pc-advshell__tab--<id>`), which IS
# directly selectable, so this script does NOT need the textContent/eval
# click workaround that quick-panel needed.
#
# READ-ONLY: switching tabs (?tab=harnesses) is a pure client-side nuqs state
# change; nothing here mutates data.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-adv.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_ADV_OUT:-/tmp/pcv-p007-adv-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/3] /adv: default 'overview' tab shell rendered, console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /adv --json >/dev/null
sleep 1.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "!!document.querySelector('[data-testid=\"operator-shell\"]') && !!document.querySelector('.pc-advshell__tab--overview') && !!document.querySelector('.pc-advshell__tab--harnesses')" \
  --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/adv-content-check.json" \
  || fail "adv: expected operator-shell + overview/harnesses tab triggers did not render cleanly"

echo "=== [2/3] primary interaction: click the 'Harnesses' tab, confirm real tab switch (?tab=harnesses) ==="
"$TOOL" click --pid "$VERIFY_TAURI_PID" '.pc-advshell__tab--harnesses' --json >/dev/null \
  || fail "adv: click on Harnesses tab trigger failed"
sleep 1
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "new URLSearchParams(location.search).get('tab') === 'harnesses'" \
  --json | tee "$OUT_DIR/adv-harnesses-tab-check.json" \
  || fail "adv: clicking the Harnesses tab did not switch ?tab= to harnesses"

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=adv output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=adv output=$OUT_DIR"
