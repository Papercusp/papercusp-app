#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-settings.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "settings" surface.
#
# /settings itself is a layout route (apps/operator-vite/src/routes/settings.tsx,
# translated from apps/operator/app/settings/layout.tsx) with NO index page of
# its own — it just wraps <Outlet/> in SettingsLayout. There is no default
# redirect to a specific sub-route (confirmed: no settings/index.tsx, no
# beforeLoad redirect in settings.tsx). Per the P-002 census methodology
# (verify a sensible representative entry point for a surface that is really a
# family of sub-routes), this script verifies /settings/profile — the first
# settings page a user reaches from nav and the simplest content-bearing one
# (apps/operator/app/settings/profile/page.tsx): a plain form with email /
# display-name / default-project-dir fields, no exotic async chrome.
#
# READ-ONLY CAUTION: this script types into the "Display name" field to prove
# the controlled input works, but NEVER clicks the Save/submit button, so it
# cannot mutate the live profile record.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-settings.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_SETTINGS_OUT:-/tmp/pcv-p007-settings-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/3] /settings/profile: content rendered (h1 'Profile' + email input present), console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /settings/profile --json >/dev/null
sleep 1.5

# settings/profile does a GET /api/profile on mount and shows only a bare
# "Profile" h1 + "Loading..." until that resolves (the form, incl. the email
# input, is absent until then) -- unlike /login and /signup this surface has
# a real network round trip, whose latency varies with box contention. Poll
# for the loaded form (bounded) instead of a fixed sleep so the eval check
# below isn't racing the fetch under load.
LOADED=0
for _ in $(seq 1 20); do
  READY="$("$TOOL" eval --pid "$VERIFY_TAURI_PID" "!!document.querySelector('input[type=email].pc-input')" 2>/dev/null)"
  if [ "$READY" = "true" ]; then LOADED=1; break; fi
  sleep 0.5
done
[ "$LOADED" -eq 1 ] || fail "settings/profile: /api/profile fetch never resolved (email input still absent after ~11.5s) — likely a real regression, not a timing fluke"

"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('h1')?.textContent?.trim() === 'Profile' && !!document.querySelector('input[type=email].pc-input')" \
  --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/settings-profile-content-check.json" \
  || fail "settings/profile: expected h1 'Profile' + email input did not render cleanly"

echo "=== [2/3] primary interaction: type into the Display name field via the native React input setter ==="
SENTINEL="p007settings$(date -u +%s | tail -c 6)"
RESULT="$("$TOOL" eval --pid "$VERIFY_TAURI_PID" \
  "(() => { const el = document.querySelector('input[placeholder=\"Your name\"]'); if (!(el instanceof HTMLInputElement)) throw new Error('display name input not found'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, '${SENTINEL}'); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()")"
if [ "$RESULT" != "$SENTINEL" ]; then
  fail "settings/profile: display-name field did not accept typed input (got '$RESULT', want '$SENTINEL')"
else
  echo "display-name field accepted controlled input ('$SENTINEL') — form is interactive"
fi
echo "(read-only: Save button intentionally never clicked — no live profile mutation)"

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=settings output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=settings output=$OUT_DIR"
