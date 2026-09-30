#!/usr/bin/env bash
# Live Tauri-shell verification for the conversation popup's TURN RAIL
# (chat-popup-turn-rail-2026-08-31 P-007).
#
# Run it as:
#   scripts/verify-tauri-headless.sh -- scripts/verify-turn-rail.sh
#
# WHY THIS EXISTS SEPARATELY FROM THE VITEST SUITE. TurnRail.test.tsx already
# proves the click contract, the densities and the fallbacks — in jsdom, which
# applies NO CSS and where ChatConversation's virtualizer is mocked. Three of
# this feature's real failure modes are invisible there by construction:
#
#   1. WebKitGTK ignores `display:flex` on a <button>. The vitest guard is a
#      SOURCE assertion (it greps the stylesheet); only a real webview can say
#      what the browser actually COMPUTED and whether the row laid out.
#   2. The jump lands through a REAL virtualizer. A mocked one renders every
#      message, so "scrolled to the answer" is trivially satisfiable in jsdom
#      and says nothing about the shipping path.
#   3. The rail↔transcript agreement is a scroll-driven feedback loop, and
#      nothing in jsdom scrolls.
#
# EVIDENCE DISCIPLINE. Every assertion below runs through $VERIFY_TAURI_POLL,
# which pins the verified PID and EXITS NONZERO when the assertion stays false
# (`dom`, `eval`, `click` and `screenshot` all exit 0 regardless of what
# happened, so they appear here only to set up or to narrate). Every assertion
# with a negative clause carries a `--require` guard naming the subject that
# must be PRESENT, because "no rows" and "not stacked" are both trivially true
# of an empty document — the vacuous green of EI-18781011720418569.
set -euo pipefail

TAT="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
PID="${VERIFY_TAURI_PID:?verify-tauri-headless.sh must export VERIFY_TAURI_PID}"
POLL="${VERIFY_TAURI_POLL:?verify-tauri-headless.sh must export VERIFY_TAURI_POLL}"

# A real session with a real multi-turn transcript. Read-only: this script
# clicks rail rows (which only scroll) and never touches the composer.
SESSION="${TURN_RAIL_SESSION:-su-8c533785-2657-4229-a19a-68b19c5cca3f}"
URL="/adv?tab=hud&hudtab=sessions&hudsession=${SESSION}&chatTurns=true"

say() { printf '\n=== %s ===\n' "$1"; }

# ── FINDING A TRANSCRIPT, AND SAYING WHICH ONE ──────────────────────────────
# A boot costs ~3 minutes and one of this box's scarce verifier slots, so the
# script must not burn one per guess. It walks candidate scopes in ONE boot and
# reports which produced a transcript.
#
# ⚠ The verifier boots into whatever pot is default (observed: oddsmith-ops),
# which is NOT necessarily the pot the target session belongs to. A cross-pot
# session yields an EMPTY transcript, and an empty transcript yields zero turns
# — at which point the rail correctly renders its empty state and a naive
# `wait --selector turn-rail-row` times out. That timeout looks exactly like a
# broken rail and is not one. Hence: measure the transcript, then decide.
diag() {
  # `data-message-index` is the attribute ChatConversation actually writes
  # (ChatConversation.tsx:635) — and it is the attribute its own top-index
  # probe reads at :993. An earlier revision of this script queried
  # `data-msg-index`, which matches NOTHING, so it reported msgs:0 for a
  # perfectly populated transcript: a wrong selector is indistinguishable from
  # an empty one, and the natural next move is to go debug the wrong subsystem.
  "$TAT" eval --pid "$PID" '
    (() => {
      const q = s => document.querySelector(s);
      const conv = q("[data-testid=session-chat-conversation]");
      // SCOPED to the popup transcript. A document-wide count also picks up the
      // operator chat SIDEBAR, which renders the same [data-message-index] —
      // so an unscoped number can report a populated transcript while the
      // popup is empty, which is the opposite of the truth and points straight
      // at the wrong subsystem. (Same unscoped-query family as the
      // SessionChatModal getByText this feature already had to fix.)
      const msgs = conv ? [...conv.querySelectorAll("[data-message-index]")] : [];
      // Roles come from the rendered class (`oracle-msg-${role}`,
      // ChatConversation.tsx:638). deriveSessionTurns opens a turn ONLY on a
      // role==="user" message, so a transcript of pure assistant output has
      // ZERO turns CORRECTLY — the rail is right and its empty state is honest.
      const roles = {};
      for (const m of msgs) {
        const r = [...m.classList].find(c => c.startsWith("oracle-msg-") && c !== "oracle-msg-avatar")
          ?.replace("oracle-msg-", "") ?? "unknown";
        roles[r] = (roles[r] || 0) + 1;
      }
      return JSON.stringify({
        href: location.href,
        modal: !!conv,
        railZone: !!q("[data-testid=session-chat-turn-rail]"),
        density: q("[data-testid=turn-rail]")?.getAttribute("data-density") ?? null,
        rows: document.querySelectorAll("[data-testid=turn-rail-row]").length,
        emptyState: !!q("[data-testid=turn-rail-empty]"),
        messagesInPopup: msgs.length,
        rolesInPopup: roles,
        messagesAnywhere: document.querySelectorAll("[data-message-index]").length,
        innerWidth: window.innerWidth,
        // WHY it is empty, in the popup'"'"'s own words. "unknown session",
        // "starting up", a stream error and "no questions yet" are four very
        // different diagnoses that all present as zero rows, and guessing
        // between them costs a ~3-minute boot each.
        popupText: conv ? (conv.innerText || "").replace(/\s+/g, " ").slice(0, 240) : null,
        // Owner ids the app itself is offering in this scope — so the next
        // candidate can be a session this instance actually knows about
        // instead of one pinned from outside it.
        offeredSessions: [...new Set(
          [...document.querySelectorAll("[data-owner-id],[data-ownerid]")]
            .map(e => e.getAttribute("data-owner-id") || e.getAttribute("data-ownerid"))
            .filter(Boolean)
        )].slice(0, 8),
      });
    })()' 2>/dev/null || true
}

try_url() {
  say "trying $1"
  "$TAT" eval --pid "$PID" "window.location.href = '$1'" >/dev/null 2>&1 || true
  "$TAT" wait --pid "$PID" --selector '[data-testid="session-chat-conversation"]' --timeout 45000 \
    >/dev/null 2>&1 || echo "DIAG: conversation region never appeared"
  # Rows, not messages: turns are what this feature is about, and a transcript
  # of pure agent chatter (a loop-fired wake) legitimately has zero questions.
  if "$TAT" wait --pid "$PID" --selector '[data-testid="turn-rail-row"]' --timeout 45000 >/dev/null 2>&1; then
    say "found a transcript with turns"; diag; return 0
  fi
  echo "DIAG: no turn rows here —"; diag; return 1
}

FOUND=0
for candidate in \
  "${URL}&slug=papercusp&ws=papercusp-workspace" \
  "${URL}" \
  "/adv?tab=hud&hudtab=sessions&chatTurns=true&slug=papercusp&ws=papercusp-workspace"
do
  if try_url "$candidate"; then FOUND=1; break; fi
done

if [ "$FOUND" -eq 0 ]; then
  echo
  echo "FATAL: no candidate scope produced a transcript with turns."
  echo "Read the DIAG lines above: 'messages' > 0 with 'rows' == 0 is a REAL turn-rail"
  echo "bug (a populated transcript that produced no turns). 'messages' == 0 is a DATA"
  echo "or POT-SCOPE problem in the verifier, and says nothing about the rail."
  exit 1
fi

say "1. the rail mounts as a SIBLING of the conversation region (D-002 / the P-015 invariant)"
# If the rail ever moves INSIDE the conversation element it inherits the
# transcript's scroll and silently stops being a fixed position indicator.
# Nothing about that would look wrong in a screenshot.
"$POLL" --require '[data-testid="session-chat-turn-rail"]' --eval '
  (() => {
    const rail = document.querySelector("[data-testid=session-chat-turn-rail]");
    const conv = document.querySelector("[data-testid=session-chat-conversation]");
    return !!rail && !!conv && !conv.contains(rail) && rail.parentElement === conv.parentElement;
  })()'

say "2. rows rendered from the REAL transcript, each previewing a real question"
"$POLL" --require '[data-testid="turn-rail-row"]' --eval '
  [...document.querySelectorAll("[data-testid=turn-rail-row]")]
    .every(r => (r.textContent || "").trim().length > 0)'

say "3. THE WEBKITGTK TRAP — what the webview actually COMPUTED, not what the CSS says"
# The vitest guard reads chat-controls.css. This reads getComputedStyle inside
# the only shipping webview: `block` on the button, `flex` on the inner span
# that does the laying out — the exact split EI-18135716653974462 is about.
"$POLL" --require '[data-testid="turn-rail-row"]' --eval '
  (() => {
    const row = document.querySelector("[data-testid=turn-rail-row]");
    const top = row.querySelector(".pc-turn__top");
    return getComputedStyle(row).display === "block"
        && getComputedStyle(top).display === "flex";
  })()'

say "4. ...and the row did NOT stack — the visible symptom of that trap"
# Assert the geometry, not the style: the turn number and the timestamp share a
# line, and the question sits BELOW them with real width. A stacked row (the
# WebKitGTK fallback) fails both halves.
"$POLL" --require '[data-testid="turn-rail-row"]' --eval '
  (() => {
    const row = document.querySelector("[data-testid=turn-rail-row]");
    const n = row.querySelector(".pc-turn__n");
    const t = row.querySelector(".pc-turn__time");
    const q = row.querySelector(".pc-turn__q");
    if (!n || !q) return false;
    const nb = n.getBoundingClientRect(), qb = q.getBoundingClientRect();
    const sameLine = !t || Math.abs(nb.top - t.getBoundingClientRect().top) < 6;
    return sameLine && qb.top >= nb.bottom - 2 && qb.width > 40;
  })()'

say "5. THE OWNER'S ASK — clicking a row scrolls the transcript to that turn's ANSWER"
# Through the REAL virtualizer, which is the half jsdom cannot exercise. The
# scroller and its position are captured BEFORE the click, so a rail that
# scrolls nothing FAILS rather than quietly passing.
"$TAT" eval --pid "$PID" '
  (() => {
    const conv = document.querySelector("[data-testid=session-chat-conversation]");
    const sc = [...conv.querySelectorAll("*")].find(e => e.scrollHeight > e.clientHeight + 40);
    window.__turnRailProbe = { el: sc || null, before: sc ? sc.scrollTop : null };
    return String(window.__turnRailProbe.before);
  })()' >/dev/null
# The transcript must actually be scrollable, or step 5 measures nothing.
"$POLL" --require '[data-testid="session-chat-conversation"]' --eval '
  window.__turnRailProbe && window.__turnRailProbe.el && window.__turnRailProbe.before > 0'
# Click the FIRST row: the reader lands at the BOTTOM of a long transcript, so
# turn 1 is the longest possible jump and the least likely to pass by accident.
"$TAT" click --pid "$PID" '[data-testid="turn-rail-row"]'
"$POLL" --require '[data-testid="turn-rail-row"]' --eval '
  (() => {
    const p = window.__turnRailProbe;
    // Scrolled, and scrolled UP. A jump that moved the transcript DOWN would be
    // the "landed on the wrong index" bug passing a mere "it moved" test.
    return !!p && !!p.el && p.el.scrollTop !== p.before && p.el.scrollTop < p.before;
  })()'

say "6. after the jump the rail marks WHERE YOU ARE — exactly one live row"
"$POLL" --require '[data-testid="turn-rail-row"]' --eval '
  document.querySelectorAll("[data-testid=turn-rail-row][data-live=true]").length === 1'

say "7. under width pressure it DEGRADES TO A SPINE instead of overlaying (D-003)"
# The whole point of D-003: an overlay you must open to see where you are
# defeats a position indicator. The `--require` names the TICKS, so the
# `rows.length === 0` half can never pass against an empty document.
"$TAT" eval --pid "$PID" 'window.resizeTo(900, 900)' >/dev/null || true
"$POLL" --require '[data-testid="turn-rail-tick"]' --eval '
  (() => {
    const rail = document.querySelector("[data-testid=turn-rail]");
    return rail.getAttribute("data-density") === "spine"
        && document.querySelectorAll("[data-testid=turn-rail-row]").length === 0;
  })()'

say "8. the tick heights actually VARY — a spine of identical marks is decoration"
"$POLL" --require '[data-testid="turn-rail-tick"]' --require-min 2 --eval '
  (() => {
    const hs = [...document.querySelectorAll("[data-testid=turn-rail-tick] .pc-turn-tick__bar")]
      .map(b => b.getBoundingClientRect().height);
    return hs.length > 1
        && new Set(hs.map(h => Math.round(h))).size > 1
        && Math.min(...hs) >= 11 && Math.max(...hs) <= 45;
  })()'

say "9. no console errors were raised while driving it"
"$POLL" --require '[data-testid="turn-rail"]' --no-errors

say "ALL TURN-RAIL LIVE ASSERTIONS PASSED"
