#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-setup.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "setup" surface (first-run wizard,
# apps/operator/app/_components/SetupWizard/SetupWizard.tsx, translated at
# apps/operator-vite/src/routes/setup.tsx).
#
# `/setup` IS a real bare route (unlike installed/users — see plan Decision
# D-010, which only re-targets those two). It renders `Chromeless` (no
# global nav chrome), so no `nav:not([aria-label])` scoping trick is needed
# here.
#
# READ-ONLY: advancing from the welcome screen to the step list only flips
# local component state (`showWelcome` → the wizard's own `?step=` nuqs
# param) — no server write, no mutation.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_POLL into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-setup.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
: "${VERIFY_TAURI_POLL:?missing VERIFY_TAURI_POLL}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_SETUP_OUT:-/tmp/pcv-p007-setup-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/3] /setup: welcome screen rendered (data-view=welcome + hello heading) ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /setup --json >/dev/null
if VERIFY_TAURI_DOM_TIMEOUT=30 "$VERIFY_TAURI_POLL" --selector '.pc-setup-wizard' \
  --eval "document.querySelector('.pc-setup-wizard')?.getAttribute('data-view') === 'welcome' && document.querySelector('.pc-welcome__hello') !== null" \
  --no-errors; then
  :
else
  fail "setup: welcome screen did not render cleanly"
fi
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('.pc-setup-wizard')?.getAttribute('data-view') === 'welcome' && document.querySelector('.pc-welcome__hello') !== null" \
  --json | tee "$OUT_DIR/setup-welcome-check.json" \
  || fail "setup: welcome content check failed"

echo "=== [2/3] primary interaction: click 'Start setup ->', confirm the step list + sidebar appear ==="
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "(() => { const b = Array.from(document.querySelectorAll('.pc-welcome__actions button')).find(x => x.textContent?.includes('Start setup')); if (!b) return false; b.click(); return true; })()" \
  --json | tee "$OUT_DIR/setup-start-click.json" \
  || fail "setup: could not find/click the 'Start setup' button"
sleep 1
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('.pc-setup-wizard')?.getAttribute('data-view') === 'step' && document.querySelectorAll('.pc-setup-wizard__step-btn').length > 0" \
  --json | tee "$OUT_DIR/setup-step-check.json" \
  || fail "setup: clicking 'Start setup' did not switch to the step view"

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=setup output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=setup output=$OUT_DIR"
