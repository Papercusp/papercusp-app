#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-res.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "res" surface.
#
# /res is the Resources page (workspace-scoped resource -> fleet allocation,
# apps/operator/app/res/page.tsx). Root `.res-page`, header `.res-head`, tree
# `.res-tree` with expandable `.res-branch`/`.res-node` rows (plain CSS
# classes, not CSS-modules, so directly selectable — no eval/textContent
# workaround needed here, unlike coord). Gated by FLAGS.RES_ALLOCATION
# (default ON). Already covered by a WRONG-TRANSPORT Playwright spec per
# D-001.
#
# READ-ONLY: toggling a hive-node's expand/collapse (aria-expanded) is pure
# client-side UI state; nothing here mutates an allotment/delegation.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-res.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_RES_OUT:-/tmp/pcv-p007-res-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/3] /res: page shell + resource tree rendered, console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /res --json >/dev/null
sleep 1.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "!!document.querySelector('.res-page') && !!document.querySelector('.res-head') && !!document.querySelector('.res-board')" \
  --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/res-content-check.json" \
  || fail "res: expected .res-page/.res-head/.res-board shell did not render cleanly"

echo "=== [2/3] primary interaction: click the first hive node, confirm aria-expanded flips ==="
# NOTE: `check --eval` only reports pass/fail of a TRUTHY expression (--json
# gives {"passed":...}, never the actual returned value) — so the before/after
# string can't be read back into this shell. Stash "before" on `window` and
# assert the CHANGE itself as one truthy check after the click, instead of
# diffing two separately-parsed reads.
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "(window.__pcvResBefore = document.querySelector('.res-node')?.getAttribute('aria-expanded')) !== undefined" \
  --json | tee "$OUT_DIR/res-before-expand.json" \
  || fail "res: no .res-node found to read an initial aria-expanded from"
"$TOOL" click --pid "$VERIFY_TAURI_PID" '.res-node' --json >/dev/null \
  || fail "res: click on the first .res-node failed"
sleep 1
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('.res-node')?.getAttribute('aria-expanded') !== window.__pcvResBefore" \
  --json | tee "$OUT_DIR/res-after-expand.json" \
  || fail "res: clicking the first .res-node did not flip aria-expanded"

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=res output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=res output=$OUT_DIR"
