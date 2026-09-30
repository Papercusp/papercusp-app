#!/usr/bin/env bash
# scripts/verify-cloud-workspaces-rail.sh — plan cloud-workspaces-guided-rail-2026-08-28, P-010.
#
# Live verification of the Cloud Workspaces guided rail inside a REAL Tauri
# desktop shell. Run it through the isolated-instance wrapper, never against the
# owner's window:
#
#   scripts/verify-tauri-headless.sh -- bash scripts/verify-cloud-workspaces-rail.sh
#
# ⚠️ READ-ONLY BY CONSTRUCTION — KEEP IT THAT WAY.
#   verify-tauri-headless.sh does NOT isolate the database or the workspace
#   unless you pass VERIFY_TAURI_ISOLATED_DB=1, so the sidecar this runs against
#   talks to the SAME live Postgres as the running system. Every write would be a
#   real write. Nothing here clicks a lifecycle control (Provision / Start / Stop
#   / Destroy) or submits a form: the only state it touches is URL query params,
#   which the page reads through nuqs. If you extend this file, keep that
#   property — a lifecycle click here really provisions a cloud host.
#
# DATA-DEPENDENT BY DESIGN. These assertions describe the page's behaviour
# GIVEN the live fixture, and they say so out loud rather than asserting
# something vacuously true of an empty install:
#   - >=1 workspace_host  => the landing step must be Operate (R3) and the
#     Operate step is reachable.
#   - >=1 workspace_host_connections => Configure is reachable.
#   - a host whose desired_state != observed_state => the drift chip must render
#     its divergent "observed → desired" form (R4).
# The preflight below READS those facts from the page itself and skips (loudly,
# and only the affected assertion) when the fixture cannot exercise one — a
# skipped assertion is reported as SKIP, never silently passed.
#
# ENV
#   CW_HOST_ID   host id to expand (default: the first host the page renders)
#   CW_SHOT_DIR  screenshot directory (default /tmp/cw-verify-shots)
set -uo pipefail

P="${VERIFY_TAURI_PID:?VERIFY_TAURI_PID not exported — run me under scripts/verify-tauri-headless.sh}"
PORT="${VERIFY_TAURI_PORT:?VERIFY_TAURI_PORT not exported}"
POLL="${VERIFY_TAURI_POLL:?VERIFY_TAURI_POLL not exported}"
TAT="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
SHOTS="${CW_SHOT_DIR:-/tmp/cw-verify-shots}"

mkdir -p "$SHOTS" || exit 1
export VERIFY_TAURI_DOM_TIMEOUT="${VERIFY_TAURI_DOM_TIMEOUT:-90}"

RAIL='nav[aria-label="Cloud workspace setup"]'
CURRENT="${RAIL} button[aria-current=\"step\"]"
# The host detail tablist is scoped by its own accessible name. Scoping matters:
# the shell and the hosted-session plane can render tablists of their own, so a
# bare [role="tab"] count is a different — and wrong — question.
TABLIST='[role="tablist"][aria-label^="Detail for"]'

failures=0
passes=0
skips=0
passed_labels=""
CURRENT_NONCE=0
pass() {
  passes=$((passes + 1))
  passed_labels="${passed_labels}${passed_labels:+$'\n'}$*"
  printf 'PASS  %s\n' "$*"
}
skip() { skips=$((skips  + 1)); printf 'SKIP  %s\n' "$*"; }
fail() { failures=$((failures + 1)); printf 'FAIL  %s\n' "$*" >&2; }

# Raw one-shot evaluation; prints the pretty-printed result.
ev() { "$TAT" eval --pid "$P" "$1" 2>&1; }

# nav <nonce> <extra-query|"">
# A navigation NONCE is pinned in every settle condition below: location.href= is
# a full reload, and for a moment the OUTGOING document is still live, so a wait
# on a selector the previous stage also matched is satisfied instantly and the
# assertion lands on a half-torn-down page (EI-18812301452864060).
nav() {
  local nonce="$1" extra="${2:-}" qs
  CURRENT_NONCE="$nonce"
  qs="vnonce=${nonce}"
  [ -n "$extra" ] && qs="${extra}&${qs}"
  "$TAT" eval --pid "$P" \
    "location.href='http://127.0.0.1:${PORT}/cloud-workspaces?${qs}'; 'go'" >/dev/null 2>&1 \
    || { fail "navigation eval failed (nonce=${nonce} extra=${extra})"; return 1; }
}

# settle <nonce> <require-css> <require-min> <eval-expr> <label>
# --require fuses a presence guard into the SAME evaluation, so nothing can slip
# between "the subject rendered" and "the claim about it holds".
settle() {
  local nonce="$1" req="$2" min="$3" expr="$4" label="$5"
  if "$POLL" --require "$req" --require-min "$min" \
       --eval "location.href.indexOf('vnonce=${nonce}')>=0 && (${expr})" >/dev/null 2>&1; then
    pass "$label"
    return 0
  fi
  fail "$label"
  # A failing assertion that does not say what it saw costs another whole boot
  # (~5 min here) to re-diagnose, so spend the one extra eval now.
  printf '      observed: %s\n' "$(ev "JSON.stringify({
    href: location.href,
    stage: (document.querySelector('[data-stage]')||{}).dataset && document.querySelector('[data-stage]').dataset.stage,
    railSteps: document.querySelectorAll('${RAIL} button').length,
    current: (document.querySelector('${CURRENT}')||{getAttribute:function(){return null}}).getAttribute('aria-label'),
    tablists: document.querySelectorAll('[role=\"tablist\"]').length,
    hostTabs: document.querySelectorAll('${TABLIST} [role=\"tab\"]').length,
    selectedTabId: (document.querySelector('${TABLIST} [role=\"tab\"][aria-selected=\"true\"]')||{}).id || null,
    rovingZero: document.querySelectorAll('${TABLIST} [role=\"tab\"][tabindex=\"0\"]').length,
    expandedRows: document.querySelectorAll('[data-expanded=\"true\"]').length
  })" | tr '\n' ' ')"
  return 1
}

shot() { "$TAT" screenshot --pid "$P" --output "$SHOTS/$1.png" >/dev/null 2>&1 || true; }

echo "== cloud-workspaces guided rail :: live verification (pid=$P port=$PORT) =="

# ── Preflight: what can this fixture actually exercise? ───────────────────────
nav 0 "" || exit 1
if ! "$POLL" --require "$RAIL" --require-min 1 \
     --eval "location.href.indexOf('vnonce=0')>=0 && document.querySelectorAll('${RAIL} button').length===3" \
     >/dev/null 2>&1; then
  echo "FATAL: /cloud-workspaces never rendered its three-step rail — nothing below is measurable." >&2
  exit 1
fi

# A rail can render before its sync-backed hosts arrive. When a caller names
# a host, that host is required coverage, never an optional fixture skip.
if [ -n "${CW_HOST_ID:-}" ]; then
  if ! "$POLL" --require "ul[aria-label=\"Managed workspace hosts\"] button[aria-controls=\"host-panel-${CW_HOST_ID}\"]" \
       --require-min 1 --eval "location.href.indexOf('vnonce=0')>=0" >/dev/null 2>&1; then
    echo "FATAL: requested host ${CW_HOST_ID} did not render; refusing to skip required host acceptance." >&2
    exit 1
  fi
else
  if ! bash "${VERIFY_TAURI_SETTLE:?VERIFY_TAURI_SETTLE not exported}" >/dev/null 2>&1; then
    echo "FATAL: workspace data did not settle; host absence is not measurable." >&2
    exit 1
  fi
fi

HOSTS="$(ev "document.querySelectorAll('ul[aria-label=\"Managed workspace hosts\"] li').length" | tr -dc '0-9')"
HOSTS="${HOSTS:-0}"
DRIFTING="$(ev "document.querySelectorAll('[data-drifting=\"true\"]').length" | tr -dc '0-9')"
DRIFTING="${DRIFTING:-0}"
CONNECTABLE="$(ev "document.querySelectorAll('${RAIL} button:not([disabled])').length" | tr -dc '0-9')"
CONNECTABLE="${CONNECTABLE:-0}"
echo "   fixture: hosts=${HOSTS} drifting=${DRIFTING} reachableSteps=${CONNECTABLE}"

# ── R1/R3: the rail, and Operate as the landing step ─────────────────────────
if [ "$HOSTS" -gt 0 ]; then
  settle 0 "$CURRENT" 1 \
    "document.querySelectorAll('${RAIL} button').length===3 \
     && /^03 Operate/.test(document.querySelector('${CURRENT}').getAttribute('aria-label')||'') \
     && !!document.querySelector('[data-stage=\"operate\"]')" \
    "R3 a fresh visit lands on Operate once a workspace exists"
else
  skip "R3 landing step is Operate — no workspace_hosts in this fixture"
fi
shot 01-landing

# R1: the rail is a status column — every step carries a status word AND an
# evidence sentence in its accessible name, so the collapsed rail stays lossless.
settle 0 "${RAIL} button" 3 \
  "Array.from(document.querySelectorAll('${RAIL} button')).every(b=>/^0[1-3] [A-Za-z]+: [^.]+\\. .+/.test(b.getAttribute('aria-label')||'')) \
   && !!document.querySelector('section[aria-label=\"Fleet posture\"]') \
   && !!document.querySelector('section[aria-label=\"Recent activity\"]')" \
  "R1 every rail step states status + evidence; posture and activity panels render"

# ── R4: drift is stated, not implied ─────────────────────────────────────────
if [ "$DRIFTING" -gt 0 ]; then
  settle 0 'ul[aria-label="Managed workspace hosts"] li' 1 \
    "(function(){var c=document.querySelector('[data-drifting=\"true\"]'); \
       return !!c && /\\S+\\s*\\u2192\\s*\\S+/.test(c.textContent||''); })()" \
    "R4 a diverging host renders ONE chip in the 'observed → desired' form"
elif [ "$HOSTS" -gt 0 ]; then
  settle 0 'ul[aria-label="Managed workspace hosts"] li' 1 \
    "Array.from(document.querySelectorAll('[data-drifting]')).every(c=>!/\\u2192/.test(c.textContent||''))" \
    "R4 an aligned host renders the bare observed state, with no → form"
else
  skip "R4 drift chip — no workspace_hosts in this fixture"
fi

# ── R2: step routing, and unreachable steps degrading rather than blanking ───
# Still on the nav-0 document here — no navigation has happened since, so this
# reuses nonce 0. (Pinning a nonce that was never navigated to is unfalsifiable:
# the condition can never become true and the assertion just burns its timeout.)
settle 0 '[data-stage]' 1 \
  "(function(){ \
     var reachable=!!document.querySelector('${RAIL} button:not([disabled])[aria-current=\"step\"]'); \
     var stage=document.querySelector('[data-stage]').getAttribute('data-stage'); \
     var cur=document.querySelector('${CURRENT}').getAttribute('aria-label')||''; \
     return reachable && cur.indexOf(stage.charAt(0).toUpperCase()+stage.slice(1))>0; })()" \
  "R2 the rendered stage and the rail's current step always agree"
nav 3 "step=configure"
settle 3 '[data-stage]' 1 \
  "(function(){ \
     var stage=document.querySelector('[data-stage]').getAttribute('data-stage'); \
     return stage==='configure' \
       ? /^02 Configure/.test(document.querySelector('${CURRENT}').getAttribute('aria-label')||'') \
       : /^0[13] (Connect|Operate)/.test(document.querySelector('${CURRENT}').getAttribute('aria-label')||''); })()" \
  "R2 ?step=configure routes to Configure, or degrades to the landing step when unreachable"

# ── R5: readiness is a per-condition checklist, not a joined sentence ────────
if ev "!!document.querySelector('[data-stage=\"configure\"]')" | grep -q true; then
  settle 3 '#provision-readiness li[data-ok]' 1 \
    "Array.from(document.querySelectorAll('#provision-readiness li[data-ok]')) \
       .every(li=>/^(true|false)\$/.test(li.getAttribute('data-ok')||'') && (li.textContent||'').trim().length>0) \
     && document.querySelector('#provision-readiness').getAttribute('role')==='status' \
     && !!document.querySelector('[aria-describedby=\"provision-readiness\"]')" \
    "R5 Configure renders the per-condition readiness checklist, wired to the submit control"
  shot 02-configure
else
  skip "R5 readiness checklist — Configure is unreachable in this fixture"
fi

# ── Connect ──────────────────────────────────────────────────────────────────
nav 4 "step=connect"
settle 4 '[data-stage="connect"]' 1 \
  "/^01 Connect/.test(document.querySelector('${CURRENT}').getAttribute('aria-label')||'') \
   && !!document.querySelector('ul[aria-label=\"Provider connections\"]') \
   && document.querySelectorAll('[data-ready]').length>0" \
  "Connect renders its provider rows"
shot 03-connect

# ── R9: the expanded host panel, its tablist, and URL-driven tab selection ───
if [ "$HOSTS" -gt 0 ]; then
  HOST_ID="${CW_HOST_ID:-}"
  if [ -z "$HOST_ID" ]; then
    nav 5 "step=operate"
    "$POLL" --require 'ul[aria-label="Managed workspace hosts"] li button[aria-controls]' 1 \
      --eval "location.href.indexOf('vnonce=5')>=0 && document.querySelectorAll('ul[aria-label=\"Managed workspace hosts\"] li button[aria-controls]').length>0" \
      >/dev/null 2>&1
    # Read the id the VIEW MODEL uses rather than assuming it equals the DB
    # primary key: the row button controls `host-panel-<workspace.id>`, so the
    # host id is that attribute minus its prefix. No click needed, and no
    # write-shaped interaction on a page wired to live state.
    HOST_ID="$(ev "(document.querySelector('ul[aria-label=\"Managed workspace hosts\"] li button[aria-controls]')||{}).getAttribute('aria-controls').replace(/^host-panel-/,'')" \
      | tr -d '"' | tr -d '[:space:]')"
  fi

  if [ -n "$HOST_ID" ]; then
    echo "   host under test: ${HOST_ID}"
    nav 6 "step=operate&host=${HOST_ID}&tab=resources"
    settle 6 "${TABLIST} [role=\"tab\"]" 4 \
      "!!document.querySelector('[data-expanded=\"true\"]') \
       && (document.querySelector('${TABLIST} [role=\"tab\"][aria-selected=\"true\"]').id||'').endsWith('-tab-resources') \
       && !!document.querySelector('[role=\"tabpanel\"]') \
       && document.querySelectorAll('${TABLIST} [role=\"tab\"][tabindex=\"0\"]').length===1" \
      "R9 ?tab=resources selects Resources; the host tablist keeps exactly one tab stop"

    nav 7 "step=operate&host=${HOST_ID}&tab=cost"
    settle 7 '[role="tabpanel"]' 1 \
      "(document.querySelector('${TABLIST} [role=\"tab\"][aria-selected=\"true\"]').id||'').endsWith('-tab-cost') \
       && !!document.querySelector('section[aria-label^=\"Cost and quota signals\"]')" \
      "R9 ?tab=cost selects Cost and renders its panel"

    nav 8 "step=operate&host=${HOST_ID}&tab=overview"
    settle 8 '[role="tabpanel"]' 1 \
      "(document.querySelector('${TABLIST} [role=\"tab\"][aria-selected=\"true\"]').id||'').endsWith('-tab-overview') \
       && !!document.querySelector('section[aria-label^=\"Drift and connectivity\"]')" \
      "R9 ?tab=overview selects Overview and renders drift/connectivity"
    shot 04-operate-overview

    nav 9 "step=operate&host=${HOST_ID}&tab=desktops"
    settle 9 '[aria-label="Workspace desktops and activity"]' 1 \
      "(function(){ \
        var sidebar=document.querySelector('[aria-label=\"Workspace desktops and activity\"]'); \
        var layout=sidebar.parentElement, main=sidebar.previousElementSibling; \
        var s=sidebar.getBoundingClientRect(), m=main.getBoundingClientRect(); \
        return (document.querySelector('${TABLIST} [role=\"tab\"][aria-selected=\"true\"]').id||'').endsWith('-tab-desktops') \
          && !!sidebar.querySelector('[aria-label=\"Available desktops\"]') \
          && !!sidebar.querySelector('[aria-label=\"Recent desktop activity\"]') \
          && m.width>200 && m.height>200 \
          && layout.scrollWidth<=layout.clientWidth+1 \
          && (layout.clientWidth>860 ? s.left>=m.right : s.top>=m.bottom); \
      })()" \
      "D-062 desktop viewer and adjacent roster/activity adapt without horizontal overflow"
    shot 05-operate-desktops
  else
    fail "could not resolve a host id to expand from the first row's aria-controls"
  fi
else
  skip "R9 expanded host panel and tabs — no workspace_hosts in this fixture"
fi

# ── Nothing raw leaked into the rendered page ────────────────────────────────
# Guarded by the rail, which an empty document does not have: an unguarded
# absence check is trivially true before any data arrives.
settle "$CURRENT_NONCE" "$RAIL" 1 \
  "!/undefined|\\[object Object\\]|NaN/.test((document.querySelector('main')||document.body).innerText)" \
  "no undefined / NaN / [object Object] leaked into the rendered page"

# A machine-readable coverage line, because "exit 0" is NOT the same claim as
# "the redesign was exercised". Every assertion below is fixture-dependent, so a
# run against an empty install can SKIP its way to a green exit and look
# identical to a real verification. Read `skipped` before you cite `exit=0`:
# skips are unverified coverage, not passes. `exercised` names the assertions
# that can only pass against real data, which is what makes the run evidence.
EXERCISED=""
grep_pass() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }
grep_pass "$passed_labels" "R3 a fresh visit lands on Operate once a workspace exists" \
  && EXERCISED="${EXERCISED}landing-operate,"
grep_pass "$passed_labels" "R9 ?tab=resources selects Resources; the host tablist keeps exactly one tab stop" \
  && EXERCISED="${EXERCISED}expanded-host-tabs,"
grep_pass "$passed_labels" "R4 a diverging host renders ONE chip in the 'observed → desired' form" \
  && EXERCISED="${EXERCISED}drift-divergent-form,"
grep_pass "$passed_labels" "D-062 desktop viewer and adjacent roster/activity adapt without horizontal overflow" \
  && EXERCISED="${EXERCISED}desktop-workspace-layout,"
EXERCISED="${EXERCISED%,}"
printf 'CW_RAIL_RESULT passed=%d failed=%d skipped=%d hosts=%d drifting=%d exercised=%s\n' \
  "$passes" "$failures" "$skips" "$HOSTS" "$DRIFTING" "${EXERCISED:-none}"

if [ "$failures" -gt 0 ]; then
  echo "== ${failures} assertion(s) FAILED =="
  exit 1
fi
if [ "$skips" -gt 0 ]; then
  echo "== ${passes} passed, ${skips} SKIPPED (fixture could not exercise them) =="
  echo "   A skipped assertion is UNVERIFIED. Do not cite this run as full coverage." >&2
  exit 0
fi
echo "== all ${passes} live assertions passed, nothing skipped =="
