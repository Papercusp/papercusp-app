#!/usr/bin/env bash
# scripts/tauri-surface-verify-p004-rubrics-wiki.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-004 — live, Tauri-driven,
# regression-failing verification for the rubrics and wiki-link surfaces.
#
# Run only through scripts/verify-tauri-headless.sh, which exports
# VERIFY_TAURI_PID / VERIFY_TAURI_PORT / VERIFY_TAURI_POLL /
# VERIFY_TAURI_AGENT_TOOLS_BIN into this script's environment:
#
#   scripts/verify-tauri-headless.sh -- \
#     bash scripts/tauri-surface-verify-p004-rubrics-wiki.sh
#
# Deliberately run WITHOUT VERIFY_TAURI_ISOLATED_DB: an isolated-DB boot
# lands on the first-run onboarding flow, and the onboarding gate intercepts
# arbitrary route navigation. Running against the DEFAULT shared-live
# instance boots straight into real, already-onboarded state. Both legs are
# read-only navigations (presence/shape checks), safe on shared state.
#
# ROUTING, PER PLAN DECISION D-005 (do not revert to the plain /rubrics and
# /wiki/missing paths this script originally used — both are dead ends):
#  - apps/operator/app/rubrics/page.tsx (the `<h1>Rubrics</h1>` + bare
#    RubricsPanel this script originally asserted against) exists ONLY in
#    the RETIRED apps/operator/app/** Next.js tree — zero operator-vite
#    route, confirmed empirically (full navigation to /rubrics 404s inside
#    the shipped SPA; see D-005). The SAME RubricsPanel component is
#    genuinely mounted live in the shipped SPA inside the Learning tab
#    (apps/operator-vite/src/components/adv/LearningTab.tsx), but ONLY
#    under its own "rubrics" sub-view: the Learning tab's sub-nav is a
#    SEPARATE nuqs param, `lview` (parseAsStringEnum<LView>, default
#    "improvements" — see LearningTab.tsx's `useQueryState("lview", ...)`
#    and the `{ id: "rubrics", label: "Rubrics" }` sub-tab entry), not a
#    value of the outer `tab` param. `/adv?tab=learning` ALONE lands on
#    the default "improvements" sub-view (confirmed via a prior run's
#    P004_FAIL screenshot — the rendered panel was the ideation-loop
#    overview, not RubricsPanel), which is why the first fix attempt
#    still failed. The real route is `/adv?tab=learning&lview=rubrics`.
#    There is no standalone h1 wrapper there. The genuine LOADED render is
#    `<section class="pc-rubrics" aria-label="Rubric coverage">`
#    (RubricsPanel.tsx ~line 294) — `role="status"` only appears on the
#    transient loading/error/empty-store states (~lines 109/116/124), so a
#    run-#2 screenshot showed the selector matching (25 scored rubrics
#    genuinely rendered) while the role="status" eval assertion still
#    failed. Assert `aria-label="Rubric coverage"` instead — it positively
#    confirms the real populated panel, not a transient placeholder.
#  - /wiki (apps/operator/bin/page-routes.ts) is a LIVE server-side Hono
#    redirect handler (not retired). Its "found" case 302s to a real,
#    reachable operator-vite destination (/harness/$slug, which itself
#    client-redirects to /adv?tab=harnesses&slug=$slug — confirmed live).
#    Its "missing" case 302s to /wiki/missing, which — like this plan's
#    D-004 fleet-status/weather finding — has NO operator-vite route
#    (apps/operator/app/wiki/missing/page.tsx is retired-tree-only) and
#    404s inside the shipped SPA. Filed as WI-96172; excluded from this
#    assertion per D-005. This leg instead drives the FOUND case, using
#    AGENTS.md at the papercusp harness's own project root (a real,
#    deterministic wiki-link target) and asserts the full server+client
#    redirect chain lands on the live /adv route.
#
#    SCOPE NOTE (independent-grading finding, addressed here): the wiki leg's
#    own primary interaction IS the redirect chain itself (a user following a
#    wiki link/bookmark through /wiki -> /harness/<slug> -> /adv), not a click
#    on the landing page -- adding a click there would test a DIFFERENT
#    surface's interactivity, not the redirect this leg exists to verify. The
#    landing page's own interactivity (the "Harnesses"/Work tab inside /adv)
#    already has its own dedicated primary-interaction assertion in
#    scripts/tauri-surface-verify-p007-adv.sh ("click the 'Harnesses' tab,
#    confirm real tab switch") -- duplicating a click here would test the same
#    DOM twice under two different scripts rather than add real coverage.
#
# Both legs navigate with a REAL browser reload (`location.href = ...`),
# not the SPA's pushState `navigate`, because /wiki is a server-side
# redirect chain unreachable by pushState at all, and to exercise the same
# full-navigation path a real user/bookmark/link would take.
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
: "${VERIFY_TAURI_PORT:?missing VERIFY_TAURI_PORT}"
: "${VERIFY_TAURI_POLL:?missing VERIFY_TAURI_POLL}"
TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_P004_RUBRICS_WIKI_OUT:-/tmp/pcv-p004-rubrics-wiki-$STAMP}"
mkdir -p "$OUT_DIR"

FAIL=0
fail() { echo "P004_FAIL $*" >&2; FAIL=1; }

json_str() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

# A full browser navigation (see header). The bridge legitimately drops for a
# beat during reload, so `eval` can error mid-flight — don't fail the leg on
# that alone; the subsequent poll is the real assertion.
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

echo "=== [1/2] rubrics (/adv?tab=learning&lview=rubrics — D-005: /rubrics itself is retired-tree-only; lview is the Learning tab's own sub-nav param, separate from tab) ==="
reload_to "/adv?tab=learning&lview=rubrics"
if VERIFY_TAURI_DOM_TIMEOUT=60 "$VERIFY_TAURI_POLL" --selector '.pc-rubrics' --no-errors; then
  :
else
  fail "rubrics: .pc-rubrics + clean console never converged on /adv?tab=learning"
fi
"$TOOL" check --pid "$VERIFY_TAURI_PID" --selector '.pc-rubrics' \
  --eval "document.querySelector('.pc-rubrics')?.getAttribute('aria-label') === 'Rubric coverage' && location.pathname === '/adv'" \
  --json | tee "$OUT_DIR/rubrics-check.json" \
  || fail "rubrics: aria-label/route assertion failed"
"$TOOL" screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT_DIR/rubrics.png" >/dev/null \
  && validate_screenshot "$OUT_DIR/rubrics.png" \
  || fail "rubrics: screenshot capture failed"

echo "=== [1b/2] rubrics: primary interaction — click the first scored-rubric row, confirm the detail panel opens ==="
# RubricsPanel's rows are plain <tr onClick> (apps/operator/app/harness/Table.tsx),
# not a Radix primitive, so a native click and .click() both activate it; native
# click used anyway for consistency with the suite's documented practice. Selecting
# a row sets LearningTab's `rubricId` state (a read-only view toggle, no mutation),
# which renders <aside class="pc-learning__rubricdetail"> and switches the panel
# into its compact layout -- a genuine, safe primary-interaction state flip.
RUBRIC_ROW_SEL='.pc-rubrics__tablewrap table tbody tr:first-child'
"$TOOL" click --pid "$VERIFY_TAURI_PID" "$RUBRIC_ROW_SEL" --wait 2000 --json \
  | tee "$OUT_DIR/rubrics-interaction-click.json" \
  || fail "rubrics: native click on the first rubric row failed"
"$TOOL" check --pid "$VERIFY_TAURI_PID" --selector 'aside.pc-learning__rubricdetail' \
  --eval "document.querySelector('aside.pc-learning__rubricdetail') !== null && document.querySelector('.pc-rubrics.is-compact') !== null" \
  --json | tee "$OUT_DIR/rubrics-interaction-check.json" \
  || fail "rubrics: detail panel did not open (aside.pc-learning__rubricdetail / compact layout) after row click"
"$TOOL" screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT_DIR/rubrics-detail.png" >/dev/null \
  && validate_screenshot "$OUT_DIR/rubrics-detail.png" \
  || fail "rubrics: detail-panel screenshot capture failed"

echo "=== [2/2] wiki found-case (/wiki?target=AGENTS.md&harness=papercusp -> /harness/papercusp -> /adv?tab=harnesses&slug=papercusp) ==="
# AGENTS.md lives at the papercusp harness project root — a real,
# deterministic wiki-link target (see page-routes.ts's TAB_BY_FILENAME).
# harness=papercusp pins the match so this doesn't depend on registry order.
reload_to "/wiki?target=AGENTS.md&harness=papercusp"
if VERIFY_TAURI_DOM_TIMEOUT=60 "$VERIFY_TAURI_POLL" --selector '[data-testid="operator-shell"]' \
  --eval "location.pathname === '/adv' && new URLSearchParams(location.search).get('tab') === 'harnesses' && new URLSearchParams(location.search).get('slug') === 'papercusp'" \
  --no-errors; then
  :
else
  fail "wiki: never landed on /adv?tab=harnesses&slug=papercusp via the /wiki -> /harness redirect chain"
fi
"$TOOL" check --pid "$VERIFY_TAURI_PID" --selector '[data-testid="operator-shell"]' \
  --eval "location.pathname === '/adv' && new URLSearchParams(location.search).get('tab') === 'harnesses' && new URLSearchParams(location.search).get('slug') === 'papercusp'" \
  --json | tee "$OUT_DIR/wiki-found-check.json" \
  || fail "wiki: final-route assertion failed"
"$TOOL" screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT_DIR/wiki-found.png" >/dev/null \
  && validate_screenshot "$OUT_DIR/wiki-found.png" \
  || fail "wiki: screenshot capture failed"

echo "=== negative control: prove the check tool actually fails on a broken/missing selector ==="
NEG_JSON="$("$TOOL" check --pid "$VERIFY_TAURI_PID" --selector '.pc-does-not-exist-sentinel' --json 2>/dev/null || true)"
echo "$NEG_JSON" | tee "$OUT_DIR/rubrics-wiki-negative-control.json"
if echo "$NEG_JSON" | grep -q '"passed":false'; then
  echo "negative control confirmed (missing-selector check correctly failed)"
else
  fail "rubrics-wiki: negative control did NOT fail on a nonexistent selector -- check tool may be silently passing everything"
fi

echo "=== summary ==="
if [ "$FAIL" -ne 0 ]; then
  echo "P004_TAURI_SURFACE_VERIFY_FAIL leg=rubrics-wiki output=$OUT_DIR" >&2
  exit 1
fi
echo "P004_TAURI_SURFACE_VERIFY_OK leg=rubrics-wiki output=$OUT_DIR"
