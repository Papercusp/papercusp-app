#!/usr/bin/env bash
# scripts/tauri-surface-verify-p006-prompt-studio.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-006 — live, Tauri-driven,
# regression-failing verification for /settings/prompt-studio.
#
# editor-demo, el-min, operator-mock are NOT re-verified here: plan Decision
# D-002 already excluded all three (each confirmed, by reading its own
# page.tsx header, to be a visual-comparison/diagnostic/mock stub, not a
# shipped product surface) — this script only delivers that exclusion for
# P-006's completion, it does not re-derive it.
#
# READ-ONLY CAUTION: /settings/prompt-studio's "Save" button writes the
# staging tree for real (per its own header comment: "Saves write the
# staging tree; the change reaches the live render through the
# staging->deploy pipeline"). This script clicks ONLY "Refresh" (recomputes
# the assembled-prompt PREVIEW, a read/compute path per the panel's own
# doc comment) and never clicks Save or edits the textarea.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p006-prompt-studio.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P006_OUT:-/tmp/pcv-p006-prompt-studio-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P006_FAIL $*" >&2; FAIL=1; }

validate_screenshot() {
  local file="$1"
  [ -s "$file" ] || { fail "screenshot missing/empty: $file"; return 1; }
  local sig
  sig="$(head -c 8 "$file" | od -An -tx1 | tr -d ' \n')"
  [ "$sig" = "89504e470d0a1a0a" ] || { fail "screenshot not a PNG: $file (sig=$sig)"; return 1; }
  return 0
}

echo "=== [1/2] /settings/prompt-studio: content rendered, console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /settings/prompt-studio --json >/dev/null
sleep 1.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('h1')?.textContent?.trim() === 'Prompt Studio'" \
  --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/prompt-studio-check.json" \
  || fail "prompt-studio: h1 'Prompt Studio' render / no-errors check failed"

echo "-- primary interaction: click Refresh (read-only preview recompute; never Save) --"
"$TOOL" eval --pid "$VERIFY_TAURI_PID" \
  "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Refresh'); if (!b) throw new Error('Refresh button not found'); b.click(); return 'clicked'; })()" \
  >/dev/null || fail "prompt-studio: Refresh button click failed"
sleep 2
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "/\\d[\\d,]* chars/.test(document.body.textContent || '')" \
  --json | tee "$OUT_DIR/prompt-studio-preview-check.json" \
  || fail "prompt-studio: preview 'N chars' readout never appeared after Refresh"
"$TOOL" screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT_DIR/prompt-studio.png" >/dev/null \
  && validate_screenshot "$OUT_DIR/prompt-studio.png" \
  || fail "prompt-studio: screenshot capture failed"

echo "=== [2/2] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P006_TAURI_SURFACE_VERIFY_FAIL leg=prompt-studio output=$OUT_DIR" >&2
  exit 1
fi
echo "P006_TAURI_SURFACE_VERIFY_OK leg=prompt-studio output=$OUT_DIR"
