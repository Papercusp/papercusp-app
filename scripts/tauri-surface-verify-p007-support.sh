#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-support.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "support" surface.
#
# /support (apps/operator/app/support/page.tsx) — static help page: h1
# "Support", action buttons (.pc-support-actions), and a Radix Collapsible
# FAQ list (.pc-support-faqs > .pc-support-faq, trigger
# .pc-support-faq-summary, content .pc-support-faq-answer). These are plain
# string classNames (not CSS-modules), so directly selectable — no
# textContent workaround needed, unlike coord.
#
# GOTCHA (learned on coord, applies everywhere): don't assert an exact join
# over a bare `nav button` / unscoped selector — ChromeShell's global header
# <nav aria-label="Primary navigation"> also renders real buttons
# (NotificationCenter etc.) on every page. Not used here since /support has
# no page-local <nav>, but keep it in mind for future surfaces.
#
# READ-ONLY: expanding a Radix Collapsible FAQ item is pure client-side UI
# state; nothing here mutates data.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-support.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_SUPPORT_OUT:-/tmp/pcv-p007-support-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/3] /support: h1 + FAQ list rendered, console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /support --json >/dev/null
sleep 1.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('h1')?.textContent === 'Support' && !!document.querySelector('.pc-support-faqs') && document.querySelectorAll('.pc-support-faq').length > 0" \
  --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/support-content-check.json" \
  || fail "support: expected h1 'Support' + non-empty .pc-support-faq list did not render cleanly"

echo "=== [2/3] primary interaction: click the first FAQ trigger, confirm its Collapsible opens ==="
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "(window.__pcvSupportBefore = document.querySelector('.pc-support-faq')?.querySelector('[data-state]')?.getAttribute('data-state')) !== undefined" \
  --json | tee "$OUT_DIR/support-before-expand.json" \
  || fail "support: no [data-state] element found on the first .pc-support-faq to read an initial state from"
"$TOOL" click --pid "$VERIFY_TAURI_PID" '.pc-support-faq-summary' --json >/dev/null \
  || fail "support: click on the first .pc-support-faq-summary failed"
sleep 1
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('.pc-support-faq')?.querySelector('[data-state]')?.getAttribute('data-state') !== window.__pcvSupportBefore" \
  --json | tee "$OUT_DIR/support-after-expand.json" \
  || fail "support: clicking the first FAQ trigger did not flip its Collapsible data-state"

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=support output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=support output=$OUT_DIR"
