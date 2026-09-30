#!/usr/bin/env bash
# scripts/tauri-surface-verify-p013-pot-drawer-budget.sh
# learning-pot-scope-gate-2026-08-30 P-013 — live, Tauri-driven verification
# that the per-pot learning drawer's SCOUT CYCLE BUDGET fields render, and that
# the JSON textarea they replaced is gone.
#
# WHAT THIS PROVES (D-011). The pot-customization `budget` config is the SOURCE
# the scout cadence rebuilds each `blender:<pot>` governor row from; the lane row
# is a MIRROR the next tick reverts. So the drawer must (a) offer the config as
# real typed fields, (b) make the blender LANE row read-only, and (c) the
# retired JSON textarea must no longer be selectable. Each is checked live.
#
# ⚠ THE ASSERTION THAT MATTERS MOST is unset-vs-zero. An empty box means UNSET
# (the engine default applies); a stored `0` on the cost cap means "no LLM spend
# this cycle" (EI-305). Those are opposite instructions, so this script checks
# that an unset field renders EMPTY with the default as its placeholder, rather
# than rendering a 0 that would read as a hard stop.
#
# READ-ONLY: navigation + reading the DOM only. Nothing here clicks Save, so no
# pot's budget is mutated.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p013-pot-drawer-budget.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

POT="${P013_POT_SLUG:-papercusp}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P013_OUT:-/tmp/pcv-p013-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P013_FAIL $*" >&2; FAIL=1; }

echo "=== [1/6] drawer opens on ?lpot=$POT and renders all three cycle-budget fields ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" "/adv?tab=learning&lpot=$POT" --json >/dev/null
sleep 2.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "['maxCostUsd','maxIdeators','maxCriticsPerIdea'].every(k => !!document.querySelector('.pc-potdraw__field[data-key=\"budget/'+k+'\"] input'))" \
  --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/drawer-config-fields.json" \
  || fail "drawer: the three budget/* config inputs did not all render cleanly"

echo "=== [2/6] each field carries its OWN unit — the two counts are NOT money ==="
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "(() => { const u = k => document.querySelector('.pc-potdraw__field[data-key=\"budget/'+k+'\"] .pc-potdraw__bunit').textContent; return /USD/.test(u('maxCostUsd')) && !/USD/.test(u('maxIdeators')) && !/USD/.test(u('maxCriticsPerIdea')); })()" \
  --json | tee "$OUT_DIR/drawer-units.json" \
  || fail "drawer: units are wrong — a fan-out COUNT must not be labelled in USD"

echo "=== [3/6] UNSET renders EMPTY with the engine default as placeholder (never a 0) ==="
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "(() => { const rows = [...document.querySelectorAll('.pc-potdraw__field[data-key^=\"budget/\"]')]; return rows.length === 3 && rows.every(r => { const i = r.querySelector('input'); const unset = r.dataset.set === '0'; return unset ? (i.value === '' && i.placeholder !== '' && /[Uu]nset/.test(r.textContent)) : i.value !== ''; }); })()" \
  --json | tee "$OUT_DIR/drawer-unset-vs-zero.json" \
  || fail "drawer: an unset field must render EMPTY with the default as placeholder and say so"

echo "=== [4/6] the blender LANE row is READ-ONLY and names the config as the real control ==="
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "(() => { const r = document.querySelector('.pc-potdraw__field[data-key=\"lane/blender:$POT\"]'); if (!r) return 'NO_LANE'; return !r.querySelector('button') && /rewrites this row/i.test(r.textContent); })() !== false" \
  --json | tee "$OUT_DIR/drawer-blender-readonly.json" \
  || fail "drawer: the blender: lane row still offers a write, or does not say why it is read-only"

echo "=== [5/6] pot-customization no longer offers the retired 'budget' JSON section ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" "/settings/pot-customization?hive=$POT&section=budget" --json >/dev/null
sleep 2.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "![...document.querySelectorAll('option')].some(o => o.value === 'budget')" \
  --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/potcustom-no-budget-option.json" \
  || fail "pot-customization: a 'budget' section option is still selectable"

echo "=== [6/6] NEGATIVE CONTROL — the probe can actually fail ==="
# Without this, every green above is indistinguishable from a blind instrument.
if "$TOOL" check --pid "$VERIFY_TAURI_PID" \
     --eval "!!document.querySelector('.pc-potdraw__field[data-key=\"budget/thisKeyDoesNotExist\"]')" \
     --json > "$OUT_DIR/negative-control.json" 2>&1; then
  fail "NEGATIVE CONTROL PASSED — the probe reports success for an element that cannot exist; every other result here is untrustworthy"
else
  echo "negative control correctly failed"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "P013_VERDICT PASS (artifacts: $OUT_DIR)"
else
  echo "P013_VERDICT FAIL (artifacts: $OUT_DIR)"
fi
exit "$FAIL"
