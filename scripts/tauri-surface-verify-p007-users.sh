#!/usr/bin/env bash
# scripts/tauri-surface-verify-p007-users.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-007 — live, Tauri-driven,
# regression-failing verification for the "users" surface.
#
# RE-TARGETED per plan Decision D-010: bare `/users` has NO index route —
# only `/users/$login` (apps/operator-vite/src/routes/users/$login.tsx, a
# client-side redirect to the canonical numeric route after an
# `/api/users/by-login/:login` lookup) and `/users/github/$id`
# (apps/operator-vite/src/routes/users/github/$id.tsx, fetches
# `/api/users/github/:id` directly).
#
# This dev box's DB has no github-user data at all (confirmed: no
# `*github*` relation exists), so BOTH routes deterministically hit their
# own graceful error path rather than a real profile — which is exactly
# what this leg asserts, and is real regression coverage: it proves each
# route's OWN error UI renders (distinguishable from the SPA's generic
# NotFound "This page slipped past the cusp", the D-004/D-005/D-006 failure
# signature) rather than crashing or 404ing.
#
# Both routes are read-only GETs; no interaction beyond navigation is
# needed or available on either error state.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_POLL into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p007-users.sh
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
: "${VERIFY_TAURI_POLL:?missing VERIFY_TAURI_POLL}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P007_USERS_OUT:-/tmp/pcv-p007-users-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P007_FAIL $*" >&2; FAIL=1; }

BOGUS_LOGIN="pcv-nonexistent-user-verify-p007"

echo "=== [1/3] /users/github/1: real route content-checks (own error UI, not the SPA 404) ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" /users/github/1 --json >/dev/null
if VERIFY_TAURI_DOM_TIMEOUT=30 "$VERIFY_TAURI_POLL" \
  --eval "document.body.textContent?.includes('Could not load profile') || document.querySelector('h1, h2')?.textContent?.length > 0" \
  --no-errors; then
  :
else
  fail "users/github/1: route never settled into a rendered state"
fi
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "!document.body.textContent?.includes('slipped past the cusp')" \
  --json | tee "$OUT_DIR/users-github-not-404-check.json" \
  || fail "users/github/1: hit the SPA's generic NotFound instead of the route's own render"

echo "=== [2/3] primary interaction (navigation): /users/<bogus login>, confirm the exact resolved-404 message ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" "/users/$BOGUS_LOGIN" --json >/dev/null
if VERIFY_TAURI_DOM_TIMEOUT=30 "$VERIFY_TAURI_POLL" \
  --eval "document.body.textContent?.includes('No profile found for @$BOGUS_LOGIN')" \
  --no-errors; then
  :
else
  fail "users/\$login: bogus login never resolved to the expected 'No profile found' message"
fi
"$TOOL" check --pid "$VERIFY_TAURI_PID" \
  --eval "document.body.textContent?.includes('No profile found for @$BOGUS_LOGIN.')" \
  --json | tee "$OUT_DIR/users-login-notfound-check.json" \
  || fail "users/\$login: exact 'No profile found for @$BOGUS_LOGIN.' message did not render"

echo "=== [3/3] negative control: prove the check tool actually fails on a broken/missing selector ==="
if "$TOOL" check --pid "$VERIFY_TAURI_PID" --selector ".pc-does-not-exist-sentinel" --json; then
  fail "negative control did not fail as expected — the check tool is not falsifiable here"
else
  echo "negative control confirmed (missing-selector check correctly failed)"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=users output=$OUT_DIR" >&2
  exit 1
fi
echo "P007_TAURI_SURFACE_VERIFY_OK leg=users output=$OUT_DIR"
