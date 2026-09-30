#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-design.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "design" surface.
#
# NOT A NORMAL SURFACE — deliver an explicit verdict, same treatment as
# P-006's operator-mock/el-min/editor-demo (D-002: not-shippable exclusions).
#
# FLAGS.DESIGN is a DARK flag, deliberately parked: libs/flags/src/types.ts
# `[FLAGS.DESIGN, { case: "parked", reason: "cut for V1." }]`. /design/$slug
# (apps/operator-vite/src/routes/design/$slug.tsx) gates on
# `requireFlag(FLAGS.DESIGN)`, which `throw notFound()`s when the flag is
# off — so with the flag parked, the CORRECT, intended behavior is that
# /design/<anything> renders the root NotFound component
# (apps/operator-vite/src/components/NotFound.tsx: "404?" text + a "Return
# to Mission Control" link), never the DesignDashboard shell. This script
# verifies THAT closed-gate behavior, not a working design workspace — the
# design workspace itself is out of scope for P-007 (not shippable) until
# FLAGS.DESIGN is un-parked, at which point this script should be replaced
# with a real content+interaction check (see the git history of this file
# for a first-draft version written against DesignDashboard.tsx, reverted
# here once the parked-flag 404 was discovered live 2026-08-27).
#
# (Attempted earlier in this same P-007 pass: .d-root/.d-title/.d-pane-tabs
# never appeared — confirmed via source read, not a selector-scoping bug
# like coord's, that this is the parked flag doing its job correctly.)
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-design.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_DESIGN_OUT:-/tmp/pcv-p007-design-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/2] /design/papercusp: FLAGS.DESIGN is parked, so this should 404 gracefully (NOT render the design dashboard), console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /design/papercusp --json >/dev/null
sleep 2
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "!document.querySelector('.d-root') && (document.body.textContent.includes('404') || !!Array.from(document.querySelectorAll('a,button')).find(el => el.textContent.includes('Return to Mission Control')))" \
  --no-errors --duration 2500 --json \
  | tee "$OUT_DIR/design-closed-gate-check.json" \
  || fail "design: expected the parked-flag gate to 404 gracefully (no .d-root, a 404/Return-to-Mission-Control marker) but it did not — either the flag state changed (design may now be shippable — replace this script with a real content check) or the gate is broken"

echo "=== [2/2] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=design output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=design (parked-flag closed-gate verdict) output=$OUT_DIR"
