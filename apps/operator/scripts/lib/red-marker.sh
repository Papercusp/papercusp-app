#!/usr/bin/env bash
# red-marker.sh — state-aware RED dedup markers for the fed-plane detector scripts.
#
# SOURCED, never executed. Consumers: papercup-fedplane-disk-health-check.sh,
# papercup-dht-liveness-check.sh.
#
# WHY (EI-22240553542994017, measured 2026-09-03): every detector deduped its RED
# filings on the marker file's AGE alone. "I filed something inside the window" is
# a strictly weaker claim than "this RED is tracked", and the scripts logged the
# weaker fact using the stronger words:
#
#     RED already tracked (EI filed 8h ago, < DISK_RED_REFILE_H 12h)
#       — skipping duplicate filing. fed-plane host disk usage 95% ...
#
# The item it was deduping against (WI-2143135) had been DROPPED at 04:40:58Z. The
# disk RED was therefore genuinely untracked until the 12h marker aged out and a
# replacement was filed at 15:20:03Z — 10h39m during which the operator journal
# positively asserted the condition was owned. That is worse than silence: an agent
# or human grepping the journal reads "RED already tracked" as confirmation that
# someone has it. Note what triggered the eventual refile: the CLOCK, never the
# state change.
#
# This library makes the suppression conditional on the tracked item still being
# NON-TERMINAL, and — in the cases where it cannot establish that — makes the log
# line say exactly what it does and does not know, instead of claiming tracking it
# has not verified.
#
# Re-filing is safe by construction: work_items:create screens duplicates against
# NON-TERMINAL candidates only (_create-core.ts:419 excludes
# ANY_FAMILY_TERMINAL_STATES), so a re-file against a still-open twin folds into an
# occurrence on that item rather than minting a duplicate, and a re-file after a
# drop correctly mints a fresh item. The age window therefore remains purely a RATE
# LIMIT; this library supplies the CORRECTNESS gate the age window never was.
#
# Marker format: "<epoch-seconds> [work-item-id]" on one line. A legacy marker
# holding only "<epoch>" stays readable — every reader takes field 1 — and degrades
# to the old age-only behaviour with a log line that admits the state is unverified.

# Terminal states, mirroring ANY_FAMILY_TERMINAL_STATES in
# packages/operator-core/lib/work-item-dispatch-states.ts. This is a hand-copy in a
# language that cannot import the constant, which is the exact shape that has
# already drifted in this repo (see that file's own note on hand-copied unions), so
# it is PINNED by apps/operator/scripts/__tests__/red-marker.test.ts — a divergence
# fails the build rather than silently un-suppressing or over-suppressing filings.
RED_TERMINAL_STATES="${RED_TERMINAL_STATES:-passed deprecated done dropped resolved closed}"

red_now_s() { date +%s 2>/dev/null || echo 0; }

# red_marker_age_h <marker-file> — whole hours since the marker was written, or
# 999999 when it is absent/unreadable. Takes FIELD 1, so it reads both the legacy
# "<epoch>" marker and the "<epoch> <item-id>" form written by red_marker_write.
red_marker_age_h() {
  local f="${1:-}" stamp
  [ -n "$f" ] && [ -f "$f" ] || { echo 999999; return; }
  stamp="$(awk 'NR==1{print $1}' "$f" 2>/dev/null || echo 0)"
  case "$stamp" in *[!0-9]* | '') stamp=0 ;; esac
  echo $(( ( $(red_now_s) - stamp ) / 3600 ))
}

# red_marker_item <marker-file> — the work-item id recorded alongside the marker.
# Empty when the marker is absent or is a legacy age-only one.
red_marker_item() {
  local f="${1:-}"
  [ -n "$f" ] && [ -f "$f" ] || return 0
  awk 'NR==1{print $2}' "$f" 2>/dev/null || true
}

# red_marker_write <marker-file> <work-item-id?> — record the filing. The id may be
# empty (the filing did not confirm an id); the marker then behaves like a legacy one.
red_marker_write() {
  local f="${1:-}" id="${2:-}"
  [ -n "$f" ] || return 0
  printf '%s %s\n' "$(red_now_s)" "$id" >"$f"
}

# red_item_state <work-item-id> — echoes the item's CURRENT state, or NOTHING when it
# could not be determined (no id, no bearer, transport failure, unparseable body).
#
# An empty answer means INDETERMINATE. It must never be read as "open" or as
# "terminal"; red_dedup_check treats it as its own case and says so in the log.
#
# Override with RED_ITEM_STATE_CMD=<cmd> (called with the id as $1, echoing a state)
# to exercise the decision logic without a live operator — used by the tests.
red_item_state() {
  local id="${1:-}" resp
  [ -n "$id" ] || return 0
  if [ -n "${RED_ITEM_STATE_CMD:-}" ]; then
    "$RED_ITEM_STATE_CMD" "$id" 2>/dev/null || true
    return 0
  fi
  [ -n "${GATE_SUPERUSER_BEARER:-}" ] || return 0
  resp="$(curl -s -m 15 -X POST "${OPERATOR_MCP_URL:-http://127.0.0.1:3070/api/mcp?superuser=1}" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -H "authorization: Bearer ${GATE_SUPERUSER_BEARER}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"work_items:get\",\"arguments\":{\"id\":\"${id}\",\"harness\":\"papercusp\",\"threadLimit\":0}}}" 2>/dev/null || true)"
  [ -n "$resp" ] || return 0
  # The tool payload rides inside an escaped JSON string, so quotes can arrive as \"
  # — mirror file_ei's existing id_match idiom. Anchor AFTER the workItem key so a
  # later unrelated "state" field can never be mistaken for the item's own.
  printf '%s' "$resp" \
    | sed 's/.*workItem//' \
    | grep -oaE '\\?"state\\?":\\?"[a-z_-]+' \
    | head -1 \
    | grep -oaE '[a-z_-]+$' || true
}

# red_state_is_terminal <state> — 0 (true) when the state is settled.
# An EMPTY state is not terminal and not open; it is indeterminate, so this
# deliberately returns non-zero rather than guessing.
red_state_is_terminal() {
  local s="${1:-}"
  [ -n "$s" ] || return 1
  case " ${RED_TERMINAL_STATES} " in *" ${s} "*) return 0 ;; esac
  return 1
}

# red_dedup_check <marker-file> <refile-hours>
# Decide whether a RED that is CURRENTLY TRUE should be filed again.
# Echoes exactly one line: "FILE <reason>" or "SUPPRESS <reason>".
# The <reason> is written to be logged verbatim, so the journal states what was
# actually established rather than asserting tracking that was never checked.
red_dedup_check() {
  local marker="${1:-}" refile_h="${2:-12}" age id state
  age="$(red_marker_age_h "$marker")"
  if [ "$age" -ge "$refile_h" ] 2>/dev/null; then
    echo "FILE no unexpired marker (last filing ${age}h ago, >= ${refile_h}h)"
    return 0
  fi
  id="$(red_marker_item "$marker")"
  if [ -z "$id" ]; then
    echo "SUPPRESS filed ${age}h ago, but the marker records NO item id (legacy marker) — tracking UNVERIFIED, suppressing on age alone"
    return 0
  fi
  state="$(red_item_state "$id")"
  if [ -z "$state" ]; then
    echo "SUPPRESS filed ${age}h ago as ${id}, but its state could not be read — tracking UNVERIFIED, suppressing on age alone"
    return 0
  fi
  if red_state_is_terminal "$state"; then
    echo "FILE previously-filed ${id} is now '${state}' — this RED is NOT tracked; refiling despite the ${age}h-old marker"
    return 0
  fi
  echo "SUPPRESS ${id} is still open (state '${state}', filed ${age}h ago) — skipping duplicate filing"
}
