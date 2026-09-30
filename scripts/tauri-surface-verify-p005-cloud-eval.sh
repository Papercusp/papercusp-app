#!/usr/bin/env bash
# scripts/tauri-surface-verify-p005-cloud-eval.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-005 — live, Tauri-driven,
# regression-failing verification for /cloud-workspaces and /adv?tab=evals
# (eval-viz). /project-docs is a documented exclusion (see plan Decision
# D-006): the operator-core `CHROMELESS_PREFIXES` list declares it a
# chromeless surface on par with /pi, /el-min, /quick-panel, but unlike
# those three it has NO registered TanStack route anywhere in the repo
# (grep for `createFileRoute('/project-docs'` returns zero hits repo-wide,
# with `createFileRoute('/cloud-workspaces'` as a positive control that DOES
# hit) and zero references in the built routeTree.gen.ts (17 hits for
# quick-panel as a positive control, 0 for project-docs). Confirmed live
# below: navigating there lands on __root.tsx's notFoundComponent, same
# class of orphaned-declaration finding as D-004 (fleet-status/weather) and
# D-005 (wiki-missing).
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p005-cloud-eval.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P005_OUT:-/tmp/pcv-p005-cloud-eval-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P005_FAIL $*" >&2; FAIL=1; }

validate_screenshot() {
  local file="$1"
  [ -s "$file" ] || { fail "screenshot missing/empty: $file"; return 1; }
  local sig
  sig="$(head -c 8 "$file" | od -An -tx1 | tr -d ' \n')"
  [ "$sig" = "89504e470d0a1a0a" ] || { fail "screenshot not a PNG: $file (sig=$sig)"; return 1; }
  return 0
}

echo "=== [1/3] /cloud-workspaces: content rendered, console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /cloud-workspaces --json >/dev/null
sleep 1.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('h1')?.textContent?.trim() === 'Cloud Workspaces'" \
  --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/cloud-workspaces-check.json" \
  || fail "cloud-workspaces: h1 'Cloud Workspaces' render / no-errors check failed"
"$TOOL" screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT_DIR/cloud-workspaces.png" >/dev/null \
  && validate_screenshot "$OUT_DIR/cloud-workspaces.png" \
  || fail "cloud-workspaces: screenshot capture failed"

echo "=== [2/3] /adv?tab=evals (eval-viz): content rendered, console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" "/adv?tab=evals" --json >/dev/null
sleep 1.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-evals" --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/eval-viz-check.json" \
  || fail "eval-viz: .pc-evals render / no-errors check failed"
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelectorAll('.pc-evals__subnav [role=tab]').length > 0" \
  --json | tee "$OUT_DIR/eval-viz-subnav-check.json" \
  || fail "eval-viz: subnav tabs not present"
"$TOOL" screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT_DIR/eval-viz.png" >/dev/null \
  && validate_screenshot "$OUT_DIR/eval-viz.png" \
  || fail "eval-viz: screenshot capture failed"

echo "=== [3/3] /project-docs: confirm documented exclusion (D-006) — must 404, not silently render ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /project-docs --json >/dev/null
sleep 1.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.getElementById('not-found-title') !== null" \
  --json | tee "$OUT_DIR/project-docs-404-check.json" \
  || fail "project-docs: expected notFoundComponent (#not-found-title) did not render — the D-006 exclusion premise may be stale, re-investigate before trusting this exclusion"

echo "=== negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P005_TAURI_SURFACE_VERIFY_FAIL leg=cloud-workspaces+eval-viz output=$OUT_DIR" >&2
  exit 1
fi
echo "P005_TAURI_SURFACE_VERIFY_OK leg=cloud-workspaces+eval-viz output=$OUT_DIR"
