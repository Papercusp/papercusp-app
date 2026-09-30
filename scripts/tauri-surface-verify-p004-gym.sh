#!/usr/bin/env bash
# scripts/tauri-surface-verify-p004-gym.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-004 — live, Tauri-driven,
# regression-failing verification for the /dev/gym surface.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_PORT / VERIFY_TAURI_POLL /
# VERIFY_TAURI_AGENT_TOOLS_BIN into this script's environment:
#
#   VERIFY_TAURI_ISOLATED_DB=1 scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p004-gym.sh
#
# VERIFY_TAURI_ISOLATED_DB=1 is REQUIRED here (unlike the sibling
# rubrics-wiki leg): /dev/gym flips the `papercusp-testing` dark flag
# (owner-parked, "cut for V1") via a real write to /api/flags/set, and that
# must never land in shared live state — this leg is kept on its own
# throwaway, fully-migrated isolated instance for that reason alone. (The
# isolated instance's first-run onboarding gate is not a problem for this
# leg specifically because /dev/gym is reached only after the flag flip,
# not via an initial cross-route reload from a cold boot — see the sibling
# script's header for the onboarding-redirect issue this split works
# around.)
#
# Navigates with a REAL browser reload (`location.href = ...`), not the
# SPA's pushState `navigate`: /dev/gym IS a TanStack route, but its flag
# gate (`requireFlag`) caches `loadFlags()` per session — a full reload
# guarantees the freshly-flipped flag is actually re-fetched instead of
# served from a stale pre-flip cache.
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
: "${VERIFY_TAURI_PORT:?missing VERIFY_TAURI_PORT}"
: "${VERIFY_TAURI_POLL:?missing VERIFY_TAURI_POLL}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P004_GYM_OUT:-/tmp/pcv-p004-gym-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P004_FAIL $*" >&2; FAIL=1; }

json_str() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

reload_to() {
  local path_json
  path_json="$(json_str "$1")"
  "$TOOL" eval --pid "$VERIFY_TAURI_PID" "location.href = ${path_json}; 'go'" >/dev/null 2>&1 || true
}

validate_screenshot() {
  local file="$1"
  [ -s "$file" ] || { fail "screenshot missing/empty: $file"; return 1; }
  local sig
  sig="$(head -c 8 "$file" | od -An -tx1 | tr -d ' \n')"
  [ "$sig" = "89504e470d0a1a0a" ] || { fail "screenshot not a PNG: $file (sig=$sig)"; return 1; }
  return 0
}

echo "=== [1/1] /dev/gym (dark-flagged; flip papercusp-testing in THIS isolated instance only) ==="
[ -n "${VERIFY_TAURI_ISOLATED_DB:-}" ] && [ "${VERIFY_TAURI_ISOLATED_DB}" != "0" ] \
  || { fail "gym: refusing to flip papercusp-testing without VERIFY_TAURI_ISOLATED_DB=1 (would write shared live state)"; }
FLAG_RESP="$(curl -s -X POST "http://127.0.0.1:${VERIFY_TAURI_PORT}/api/flags/set" \
  -H 'content-type: application/json' \
  -d '{"key":"papercusp-testing","enabled":true}')"
echo "$FLAG_RESP" | tee "$OUT_DIR/gym-flag-set.json"
node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{let j;try{j=JSON.parse(d)}catch{process.exit(1)};process.exit(j&&j.ok?0:1)})' <<<"$FLAG_RESP" \
  || fail "gym: /api/flags/set did not report ok"
reload_to "/dev/gym"
if VERIFY_TAURI_DOM_TIMEOUT=60 "$VERIFY_TAURI_POLL" --selector '[data-testid="gym-harness-select"]' \
  --eval "document.querySelector('[role=\"tablist\"]') !== null && [...document.querySelectorAll('h1')].some((h) => h.textContent?.trim() === 'Harness Gym')" \
  --no-errors; then
  :
else
  fail "gym: dashboard never rendered (flag flip or route did not take)"
fi
"$TOOL" check --pid "$VERIFY_TAURI_PID" --selector '[data-testid="gym-harness-select"]' \
  --eval "[...document.querySelectorAll('h1')].some((h) => h.textContent?.trim() === 'Harness Gym')" \
  --json | tee "$OUT_DIR/gym-check.json" \
  || fail "gym: h1/testid assertion failed"
"$TOOL" screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT_DIR/gym.png" >/dev/null \
  && validate_screenshot "$OUT_DIR/gym.png" \
  || fail "gym: screenshot capture failed"

echo "=== primary interaction: click the 'prompts' tab (native click), confirm real tab switch ==="
# GymDashboard.tsx's tab strip is a plain onClick handler (not a Radix primitive),
# so a native mouse click and .click() both work here -- native click used anyway
# for consistency with the other legs' documented false-negative avoidance.
"$TOOL" click --pid "$VERIFY_TAURI_PID" '[data-testid="gym-tab-prompts"]' --wait 2000 --json \
  | tee "$OUT_DIR/gym-interaction-click.json" \
  || fail "gym: native click on the 'prompts' tab failed"
# NOTE: no --selector here on purpose. GymDashboard.tsx only mounts the
# per-tab content (PromptsTab et al, including its `gym-prompt-roles` node)
# once a harness `slug` is selected (`{!slug ? <empty> : <main>...}`); the
# isolated throwaway Postgres this leg boots against (VERIFY_TAURI_ISOLATED_DB=1)
# has zero seeded harnesses, so `/harnesses` returns [] and `slug` never gets
# set -- the dashboard legitimately stays on the "Pick a harness to begin"
# empty state for EVERY tab, regardless of which is selected. Requiring
# gym-prompt-roles here previously produced a spurious fail against a real,
# harness-data-dependent DOM node that this isolated environment can never
# populate (verified 2026-08-27: aria-selected/gymTab flipped correctly,
# selector absent only because slug was empty). The eval below is still a
# REAL interaction assertion -- it proves the click flipped BOTH the
# accessibility state (aria-selected on the correct tab button, and only that
# one) and the persisted nuqs URL param -- independent of harness-data seeding.
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('[data-testid=\"gym-tab-prompts\"]')?.getAttribute('aria-selected') === 'true' && document.querySelector('[data-testid=\"gym-tab-proposals\"]')?.getAttribute('aria-selected') === 'false' && new URLSearchParams(location.search).get('gymTab') === 'prompts'" \
  --json | tee "$OUT_DIR/gym-interaction-check.json" \
  || fail "gym: prompts tab did not activate (aria-selected/gymTab param) after click"
"$TOOL" screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT_DIR/gym-prompts-tab.png" >/dev/null \
  && validate_screenshot "$OUT_DIR/gym-prompts-tab.png" \
  || fail "gym: prompts-tab screenshot capture failed"

echo "=== negative control: prove the check tool actually fails on a broken/missing selector ==="
NEG_JSON="$("$TOOL" check --pid "$VERIFY_TAURI_PID" --selector '.pc-does-not-exist-sentinel' --json 2>/dev/null || true)"
echo "$NEG_JSON" | tee "$OUT_DIR/gym-negative-control.json"
if echo "$NEG_JSON" | grep -q '"passed":false'; then
  echo "negative control confirmed (missing-selector check correctly failed)"
else
  fail "gym: negative control did NOT fail on a nonexistent selector -- check tool may be silently passing everything"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P004_TAURI_SURFACE_VERIFY_FAIL leg=gym output=$OUT_DIR" >&2
  exit 1
fi
echo "P004_TAURI_SURFACE_VERIFY_OK leg=gym output=$OUT_DIR"
