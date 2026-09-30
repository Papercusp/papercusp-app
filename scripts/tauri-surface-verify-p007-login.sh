#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-login.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for /login (one of the 17 surfaces D-001
# ruled need NEW Tauri-driven assertions: existing Playwright coverage is
# wrong-transport regardless of assertion depth, per plan Decision D-001).
#
# READ-ONLY CAUTION: this script types into the username field to prove the
# controlled input works, but never submits the form (no Enter/submit click)
# and never touches any GitHub/OAuth sign-in control, so it cannot start a
# real auth flow or mutate session state.
#
# AUTH-GATED ROUTE (discovered empirically 2026-08-27): the standard
# verifier boots against the LIVE SHARED database/workspace (see the
# verify-tauri-headless.sh banner), which is normally already authenticated.
# Navigating to /login from an authenticated session immediately redirects
# to /adv (confirmed live: location.pathname lands on `/adv`, h1 is null) —
# this is CORRECT auth-gate behavior, not a bug, so this script treats
# "redirected away from /login while authenticated" as a PASS for the
# content leg and skips the username-field interaction leg in that case
# (there is no login form to interact with). Only when the instance is
# genuinely unauthenticated (VERIFY_TAURI_ISOLATED_DB=1, or a future
# logged-out fixture) does the interaction leg run and get asserted.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_DISPLAY into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-login.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_LOGIN_OUT:-/tmp/pcv-p007-login-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

echo "=== [1/2] /login: content rendered (login form OR correct auth-gate redirect), console clean ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /login --json >/dev/null
sleep 1.5
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.querySelector('h1')?.textContent?.trim() === 'Sign in' || !location.pathname.startsWith('/login')" \
  --no-errors --duration 2000 --json \
  | tee "$OUT_DIR/login-content-check.json" \
  || fail "login: neither the login form rendered NOR did an authenticated session redirect away — likely a real regression"

IS_LOGIN_FORM="$("$TOOL" eval --pid "$VERIFY_TAURI_PID" "document.querySelector('h1')?.textContent?.trim() === 'Sign in'")"
if [ "$IS_LOGIN_FORM" != "true" ]; then
  echo "-- authenticated session: redirected away from /login as expected; skipping the login-form interaction leg (nothing to interact with) --"
else
  echo "-- primary interaction: type into the username field via the native React input setter --"
  SENTINEL="p007login$(date -u +%s | tail -c 6)"
  "$TOOL" eval --pid "$VERIFY_TAURI_PID" \
    "(() => { const el = document.querySelector('input[autocomplete=username]'); if (!(el instanceof HTMLInputElement)) throw new Error('username input not found'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, '${SENTINEL}'); el.dispatchEvent(new Event('input', { bubbles: true })); return 'set:' + el.value; })()" \
    >/dev/null || fail "login: username field type failed"
  sleep 0.3
  "$TOOL" check --pid "$VERIFY_TAURI_PID" \
    --eval "document.querySelector('input[autocomplete=username]')?.value === '${SENTINEL}'" \
    --json | tee "$OUT_DIR/login-interaction-check.json" \
    || fail "login: username field did not retain the typed value"
fi

echo "=== [2/2] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=login output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=login output=$OUT_DIR"
