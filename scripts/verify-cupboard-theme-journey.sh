#!/usr/bin/env bash
# Isolated Tauri acceptance for cupboard-themes-2026-09-05 P-006.
#
# The wrapper owns a throwaway PAPERCUSP_HOME/workspace/WebView profile and an
# optional throwaway migrated database. This assertion seeds a representative
# theme only through the real HTTP route, then drives the shipped Tauri SPA with
# real pointer clicks. It never writes the owner's desktop profile.
#
#   VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready \
#     scripts/verify-tauri-headless.sh -- bash scripts/verify-cupboard-theme-journey.sh
set -euo pipefail

: "${VERIFY_TAURI_PID:?run through scripts/verify-tauri-headless.sh}"
: "${VERIFY_TAURI_POLL:?missing verifier DOM poll helper}"
: "${VERIFY_TAURI_SETTLE:?missing verifier page-settle helper}"
: "${VERIFY_TAURI_AGENT_TOOLS_BIN:?missing verifier bridge CLI}"

THEME_TAURI_PID="$VERIFY_TAURI_PID"
THEME_TAURI_TOOL="$VERIFY_TAURI_AGENT_TOOLS_BIN"
THEME_TAURI_POLL="$VERIFY_TAURI_POLL"
THEME_TAURI_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
THEME_TAURI_OUT="${VERIFY_CUPBOARD_THEME_OUTPUT:-/tmp/papercusp-theme-tauri-${THEME_TAURI_STAMP}}"
mkdir -p "$THEME_TAURI_OUT"

theme_eval() {
  "$THEME_TAURI_TOOL" eval --pid "$THEME_TAURI_PID" "$1"
}

theme_put_expression() {
  local accent="$1"
  printf '%s' "(async () => {
    const theme = {
      id: 'tauri-aurora',
      label: 'Tauri Aurora',
      tokens: {
        'bg': '#101820', 'bg-1': '#172430', 'bg-popover': '#1d2d3a',
        'fg': '#f7f7f2', 'fg-dim': '#c9d6df', 'fg-mute': '#9db0bd',
        'border': '#3b5363', 'border-strong': '#5b7485',
        'accent': '$accent', 'accent-strong': '#ffa45f',
        'accent-cool': '#65d6ce', 'accent-ink': '#201208',
        'good': '#52b788', 'warn': '#ffca3a', 'bad': '#ff595e'
      }
    };
    const response = await fetch('/api/themes/tauri-aurora', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme })
    });
    const body = await response.json().catch(() => null);
    return JSON.stringify({ status: response.status, body });
  })()"
}

theme_delete_expression() {
  printf '%s' "(async () => {
    const response = await fetch('/api/themes/tauri-aurora', { method: 'DELETE' });
    return JSON.stringify({ status: response.status });
  })()"
}

cleanup_fixture() {
  kill -0 "$THEME_TAURI_PID" 2>/dev/null || return 0
  theme_eval "$(theme_delete_expression)" >/dev/null 2>&1 || true
}
trap cleanup_fixture EXIT

echo '=== [1/8] seed representative theme through the production HTTP validator ==='
CREATE_RESULT="$(theme_eval "$(theme_put_expression '#ff8c42')")"
printf '%s\n' "$CREATE_RESULT" | tee "$THEME_TAURI_OUT/create.json"
grep -Eq '"status"[[:space:]]*:[[:space:]]*200' <<<"$CREATE_RESULT"
grep -Eq '"label"[[:space:]]*:[[:space:]]*"Tauri Aurora"' <<<"$CREATE_RESULT"

echo '=== [2/8] browse the real Cupboard Themes category ==='
"$THEME_TAURI_TOOL" navigate --pid "$THEME_TAURI_PID" '/cupboard?kind=theme' --json >/dev/null
"$THEME_TAURI_POLL" \
  --require '[data-testid="cupboard-results"]' \
  --eval "document.querySelector('[data-testid=\"cupboard-kind-tab-theme\"]')?.getAttribute('aria-pressed') === 'true'" \
  --no-errors

echo '=== [3/8] select the fixture in Personalization and record computed colors ==='
"$THEME_TAURI_TOOL" navigate --pid "$THEME_TAURI_PID" '/settings/personalization' --json >/dev/null
"$THEME_TAURI_POLL" --selector '[role="radio"][aria-label="Tauri Aurora"]'
"$THEME_TAURI_TOOL" click --pid "$THEME_TAURI_PID" '[role="radio"][aria-label="Tauri Aurora"]' --wait 1200 --json >/dev/null
"$THEME_TAURI_POLL" \
  --require 'html[data-theme="custom:tauri-aurora"]' \
  --eval "(() => { const s = getComputedStyle(document.documentElement); return s.getPropertyValue('--bg').trim() === '#101820' && s.getPropertyValue('--fg').trim() === '#f7f7f2' && s.getPropertyValue('--accent').trim() === '#ff8c42'; })()"
theme_eval "(() => {
  const root = getComputedStyle(document.documentElement);
  const section = document.querySelector('.pc-settings-section');
  const card = document.querySelector('[role=\"radio\"][aria-label=\"Tauri Aurora\"]');
  return JSON.stringify({
    semantic: { bg: root.getPropertyValue('--bg').trim(), fg: root.getPropertyValue('--fg').trim(), accent: root.getPropertyValue('--accent').trim(), popover: root.getPropertyValue('--bg-popover').trim() },
    surfaces: {
      shell: getComputedStyle(document.body).backgroundColor,
      content: section ? getComputedStyle(section).backgroundColor : null,
      card: card ? getComputedStyle(card).backgroundColor : null
    }
  });
})()" | tee "$THEME_TAURI_OUT/computed-colors.json"

echo '=== [4/8] prove the shared quick picker sees the same live catalog ==='
"$THEME_TAURI_TOOL" click --pid "$THEME_TAURI_PID" '[aria-label="Switch theme"]' --wait 500 --json >/dev/null
"$THEME_TAURI_POLL" --selector '[data-testid="theme-selector-option"][data-theme-id="custom:tauri-aurora"]'
theme_eval "(() => {
  const menu = document.querySelector('.pc-theme-menu');
  return JSON.stringify({ menuBackground: menu ? getComputedStyle(menu).backgroundColor : null });
})()" | tee "$THEME_TAURI_OUT/menu-color.json"
"$THEME_TAURI_TOOL" click --pid "$THEME_TAURI_PID" '[data-testid="theme-selector-option"][data-theme-id="frost"]' --wait 500 --json >/dev/null
"$THEME_TAURI_POLL" --selector 'html[data-theme="frost"]'
"$THEME_TAURI_TOOL" click --pid "$THEME_TAURI_PID" '[aria-label="Switch theme"]' --wait 500 --json >/dev/null
"$THEME_TAURI_POLL" --selector '[data-testid="theme-selector-option"][data-theme-id="custom:tauri-aurora"]'
"$THEME_TAURI_TOOL" click --pid "$THEME_TAURI_PID" '[data-testid="theme-selector-option"][data-theme-id="custom:tauri-aurora"]' --wait 500 --json >/dev/null
"$THEME_TAURI_POLL" --selector 'html[data-theme="custom:tauri-aurora"]'

echo '=== [5/8] update in place and observe committed-write invalidation ==='
UPDATE_RESULT="$(theme_eval "$(theme_put_expression '#7c3aed')")"
printf '%s\n' "$UPDATE_RESULT" | tee "$THEME_TAURI_OUT/update.json"
grep -Eq '"status"[[:space:]]*:[[:space:]]*200' <<<"$UPDATE_RESULT"
"$THEME_TAURI_POLL" \
  --require 'html[data-theme="custom:tauri-aurora"]' \
  --eval "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#7c3aed'"

echo '=== [6/8] reload the WebView and prove persisted selection + cached CSS ==='
# The bridge's direct `navigate /path` calls above are intentionally soft and
# omit the desktop's ordinary `?ws=` launch identity. Preserve the already-
# verified browser workspace on the URL before the hard reload; otherwise the
# host has no per-window scope to re-inject and legitimately falls back to the
# process-global workspace, turning this into a wrong-tenant test rather than a
# persistence test. Also read the PG-backed profile before reload so the
# assertion proves the canonical write landed instead of passing from the
# WebView cache alone.
PRE_RELOAD_RESULT="$(theme_eval "(async () => {
  const workspace = String(window.__PAPERCUSP_WS__ || '');
  const scopedHeaders = { accept: 'application/json', ...(workspace ? { 'x-papercusp-workspace': workspace } : {}) };
  const [response, catalogResponse] = await Promise.all([
    fetch('/api/profile', { headers: scopedHeaders }),
    fetch('/api/themes', { headers: scopedHeaders })
  ]);
  const [profile, catalog] = await Promise.all([
    response.json().catch(() => null),
    catalogResponse.json().catch(() => null)
  ]);
  const url = new URL(window.location.href);
  if (workspace) {
    url.searchParams.set('ws', workspace);
    window.history.replaceState(window.history.state, '', url);
  }
  return JSON.stringify({
    status: response.status,
    catalogStatus: catalogResponse.status,
    themeId: profile?.theme_id ?? null,
    catalogAccent: catalog?.themes?.find((theme) => theme?.id === 'tauri-aurora')?.tokens?.accent ?? null,
    workspace,
    href: window.location.href
  });
})()")"
printf '%s\n' "$PRE_RELOAD_RESULT" | tee "$THEME_TAURI_OUT/pre-reload.json"
grep -Eq '"status"[[:space:]]*:[[:space:]]*200' <<<"$PRE_RELOAD_RESULT"
grep -Eq '"catalogStatus"[[:space:]]*:[[:space:]]*200' <<<"$PRE_RELOAD_RESULT"
grep -Eq '"themeId"[[:space:]]*:[[:space:]]*"custom:tauri-aurora"' <<<"$PRE_RELOAD_RESULT"
grep -Eq '"catalogAccent"[[:space:]]*:[[:space:]]*"#7c3aed"' <<<"$PRE_RELOAD_RESULT"
grep -Eq '"workspace"[[:space:]]*:[[:space:]]*"[^"]+"' <<<"$PRE_RELOAD_RESULT"
theme_eval 'window.location.reload()' >/dev/null 2>&1 || true
# An eval that initiates a navigation can return before the new document exists.
# Wait for the browser's own Navigation Timing record to prove this is the
# reload document, then wait for its async sync-backed render to quiesce.
VERIFY_TAURI_DOM_TIMEOUT=90 "$THEME_TAURI_POLL" \
  --require 'html' \
  --eval "performance.getEntriesByType('navigation')[0]?.type === 'reload'"
bash "$VERIFY_TAURI_SETTLE" --timeout 90
POST_RELOAD_RESULT="$(theme_eval "(async () => {
  const workspace = String(window.__PAPERCUSP_WS__ || '');
  const scopedHeaders = { accept: 'application/json', ...(workspace ? { 'x-papercusp-workspace': workspace } : {}) };
  const [response, catalogResponse] = await Promise.all([
    fetch('/api/profile', { headers: scopedHeaders }),
    fetch('/api/themes', { headers: scopedHeaders })
  ]);
  const [profile, catalog] = await Promise.all([
    response.json().catch(() => null),
    catalogResponse.json().catch(() => null)
  ]);
  const nav = performance.getEntriesByType('navigation')[0];
  const style = document.getElementById('pc-custom-themes');
  const cachedCss = localStorage.getItem('pc:ws:' + workspace + ':papercusp.customThemesCss') || '';
  return JSON.stringify({
    status: response.status,
    catalogStatus: catalogResponse.status,
    themeId: profile?.theme_id ?? null,
    catalogAccent: catalog?.themes?.find((theme) => theme?.id === 'tauri-aurora')?.tokens?.accent ?? null,
    injectedThemeId: window.__PAPERCUSP_PREFS__?.theme_id ?? null,
    workspace,
    href: window.location.href,
    navigationType: nav?.type ?? null,
    dataTheme: document.documentElement.dataset.theme ?? null,
    computedAccent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    cachedCssMounted: Boolean(style?.textContent?.includes('custom:tauri-aurora')),
    mountedCssHasUpdatedAccent: Boolean(style?.textContent?.includes('#7c3aed')),
    cachedCssHasUpdatedAccent: cachedCss.includes('#7c3aed')
  });
})()")"
printf '%s\n' "$POST_RELOAD_RESULT" | tee "$THEME_TAURI_OUT/post-reload.json"
grep -Eq '"navigationType"[[:space:]]*:[[:space:]]*"reload"' <<<"$POST_RELOAD_RESULT"
grep -Eq '"catalogStatus"[[:space:]]*:[[:space:]]*200' <<<"$POST_RELOAD_RESULT"
grep -Eq '"themeId"[[:space:]]*:[[:space:]]*"custom:tauri-aurora"' <<<"$POST_RELOAD_RESULT"
grep -Eq '"catalogAccent"[[:space:]]*:[[:space:]]*"#7c3aed"' <<<"$POST_RELOAD_RESULT"
grep -Eq '"injectedThemeId"[[:space:]]*:[[:space:]]*"custom:tauri-aurora"' <<<"$POST_RELOAD_RESULT"
grep -Eq '"dataTheme"[[:space:]]*:[[:space:]]*"custom:tauri-aurora"' <<<"$POST_RELOAD_RESULT"
grep -Eq '"cachedCssMounted"[[:space:]]*:[[:space:]]*true' <<<"$POST_RELOAD_RESULT"
grep -Eq '"mountedCssHasUpdatedAccent"[[:space:]]*:[[:space:]]*true' <<<"$POST_RELOAD_RESULT"
grep -Eq '"cachedCssHasUpdatedAccent"[[:space:]]*:[[:space:]]*true' <<<"$POST_RELOAD_RESULT"
"$THEME_TAURI_POLL" \
  --require 'html[data-theme="custom:tauri-aurora"]' \
  --eval "String(window.__PAPERCUSP_WS__ || '') !== '' && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#7c3aed'" \
  --no-errors

echo '=== [7/8] remove the active theme and verify canonical fallback ==='
REMOVE_RESULT="$(theme_eval "$(theme_delete_expression)")"
printf '%s\n' "$REMOVE_RESULT" | tee "$THEME_TAURI_OUT/remove.json"
grep -Eq '"status"[[:space:]]*:[[:space:]]*204' <<<"$REMOVE_RESULT"
"$THEME_TAURI_POLL" --selector 'html[data-theme="frost"]'

echo '=== [8/8] invalid input is rejected without disturbing the fallback ==='
INVALID_RESULT="$(theme_eval "(async () => {
  const response = await fetch('/api/themes/tauri-invalid', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme: { id: 'tauri-invalid', label: 'Invalid', tokens: { bg: 'red; } html {' } } })
  });
  return JSON.stringify({ status: response.status, body: await response.json().catch(() => null), active: document.documentElement.dataset.theme });
})()")"
printf '%s\n' "$INVALID_RESULT" | tee "$THEME_TAURI_OUT/invalid.json"
grep -Eq '"status"[[:space:]]*:[[:space:]]*400' <<<"$INVALID_RESULT"
grep -Eq '"active"[[:space:]]*:[[:space:]]*"frost"' <<<"$INVALID_RESULT"

if "$THEME_TAURI_TOOL" check --pid "$THEME_TAURI_PID" --selector '.pc-theme-acceptance-negative-control' --json; then
  echo 'THEME_TAURI_FAIL negative control unexpectedly passed' >&2
  exit 1
fi

"$THEME_TAURI_TOOL" screenshot --pid "$THEME_TAURI_PID" --output "$THEME_TAURI_OUT/fallback.png" >/dev/null
test -s "$THEME_TAURI_OUT/fallback.png"

echo "THEME_TAURI_OK output=$THEME_TAURI_OUT"
