#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-installed.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "installed" surface.
#
# RE-TARGETED per plan Decision D-010: bare `/installed` has NO index route
# (apps/operator-vite/src/routeTree.gen.ts has no `/installed` entry, only
# `/installed/kpis`, `/installed/harnesses`, `/installed/plugins`) — it was
# only ever a directory name under the retired `apps/operator/app/` component
# tree, not a real TanStack Router path. This leg targets the simplest real
# child route, `/installed/kpis` (apps/operator/app/installed/kpis/page.tsx,
# read-only cross-harness KPI dashboard fed by the `kpis.all` sync
# projection).
#
# READ-ONLY: the only interaction is clicking "Refresh", which calls the
# sync layer's own invalidate() — no mutation, no side effect beyond
# re-fetching the same read-only projection.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_POLL into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-installed.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
: "${VERIFY_TAURI_POLL:?missing VERIFY_TAURI_POLL}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_INSTALLED_OUT:-/tmp/pcv-p007-installed-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/3] /installed/kpis: dashboard shell rendered (h1 + 6 stat cards), console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /installed/kpis --json >/dev/null
if VERIFY_TAURI_DOM_TIMEOUT=30 "$VERIFY_TAURI_POLL" --selector '.pc-kpi-shell' \
  --eval "document.querySelector('.pc-kpi-shell h1')?.textContent === 'Substrate KPIs' && document.querySelectorAll('.pc-kpi-stat-card').length === 6" \
  --no-errors; then
  :
else
  fail "installed/kpis: expected h1 'Substrate KPIs' + 6 stat cards did not render cleanly"
fi
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('.pc-kpi-shell h1')?.textContent === 'Substrate KPIs' && document.querySelectorAll('.pc-kpi-stat-card').length === 6" \
  --json | tee "$OUT_DIR/installed-content-check.json" \
  || fail "installed/kpis: content check failed"

echo "=== [2/3] primary interaction: click 'Refresh' (calls the read-only sync invalidate(), no mutation) ==="
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "(() => { const b = Array.from(document.querySelectorAll('.pc-kpi-refresh-button')).find(x => x.textContent?.trim() === 'Refresh'); if (!b) return false; b.click(); return true; })()" \
  --json | tee "$OUT_DIR/installed-refresh-click.json" \
  || fail "installed/kpis: could not find/click the Refresh button"
sleep 1
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('.pc-kpi-shell h1')?.textContent === 'Substrate KPIs'" \
  --json | tee "$OUT_DIR/installed-post-refresh-check.json" \
  || fail "installed/kpis: dashboard did not survive a Refresh click"

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=installed output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=installed output=$OUT_DIR"
