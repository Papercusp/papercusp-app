#!/usr/bin/env bash
# scenario-coord-control-plane.sh — Brief 7 scenario FUNCTION for the consolidated
# 2-frame live matrix runner (federation-release-hardening Brief 13,
# bin/deb-hetzner-matrix.sh, owned by su-8b360).
#
# CONTRACT (how the matrix runner consumes this):
#   source bin/lib/federation-asserts.sh
#   source bin/lib/deb-hetzner-rig.sh
#   source bin/lib/scenario-coord-control-plane.sh
#   # … runner provisions 2 frames (a=owner, b=joiner), joins both to ONE hive,
#   #    waits swarm peer_connected, THEN:
#   scenario_coord_control_plane a b   # → prints CC-* PASS/FAIL lines; returns 0 iff all pass
#
# This function PROVISIONS NOTHING and TEARS DOWN NOTHING (the runner owns the 2
# shared VMs + the EXIT-trap servers=0 teardown). It only drives psql/driver probes
# over the already-live frames via the rig primitives.
#
# ── WHY these probes (Brief 7 = the coordination CONTROL plane cross-machine) ──
# Coordination DATA federation (threads/posts/events) is already proven (run33/34 +
# fed_coord_merge_probe, kind=message). Brief 7 characterizes the CONTROL plane. The
# headline, derived from the federation table-registry + the capture-trigger filter,
# is: the control plane is LOCAL-ONLY BY ARCHITECTURE for real-time WAKE/PUSH, but
# DATA-FEDERATES for harness-scoped coord_event_log rows. These live probes CONFIRM
# the two halves that a raw 2-VM psql rig can actually exercise:
#
#   POSITIVE (coord DATA federates, both directions, all event kinds):
#     CC-1  a→b  a harness-scoped coord_event_log HANDOFF row arrives origin='remote'
#     CC-2  a→b  a harness-scoped coord_event_log ESCALATION row arrives origin='remote'
#     CC-3  b→a  a harness-scoped coord_event_log MESSAGE row arrives origin='remote'
#            (bidirectional — extends fed_coord_merge_probe's one-direction kind=message)
#
#   NEGATIVE (the federation BOUNDARY — proves the control plane is gated, not open):
#     CC-4  a→b  a coord_event_log row WITHOUT harness_slug (operator/fanout-shaped)
#            does NOT cross (the capture trigger filters scope!=harness) → stays absent on b
#     CC-5  a→b  a coord WATERMARK row does NOT cross (coord_watermarks → sync:'none',
#            no capture trigger) → read position is per-machine, local-only by design
#
# Real-time WAKE (coord:send wake:'required' → a remote agent = recipient_absent/woken:0;
# events:emit on a does NOT wake events:await on b) is a CODE FACT (the wake resolves
# the recipient's LOCAL session registry only) — asserted in the Brief 7 matrix doc
# with file:line citations, NOT here (it needs a live agent session per frame, which a
# psql/curl rig cannot drive cleanly). Presence/intent visibility federation
# (shared_presence) is proven in production (federated `fed:<gh-id>@<host>` rows show in
# coord:presence) + the in-process cross-peer-coordination tests, so it is documented,
# not re-probed by a fragile raw-INSERT here (shared_presence federates via the app
# write-path ownLog.append, not a PG trigger, so a raw INSERT would not federate).

# ── helpers (scoped to this scenario) ─────────────────────────────────────────

# _ccp_coord_write <inst> <slug> <msg_id> <kind> [text] — INSERT a harness-scoped
# coord_event_log row origin='local' on <inst> (the mig-150 capture trigger federates
# it). Mirrors fed_coord_merge_probe's column shape + the D-050 workspace_id resolve.
_ccp_coord_write() {
  local inst="$1" slug="$2" mid="$3" kind="$4" text="${5:-brief7 control-plane probe}" ws
  # D-050 / WI-5399 iteration 2: pot_home_slug scoping — works on owner AND joiner,
  # unlike origin='local' (structurally never matches a joiner's own membership
  # row). This scenario always runs with deb-hetzner-rig.sh sourced (per the
  # CONTRACT header), so RIG_HIVE_ID is reliably in scope. Fail loudly, never 'default'.
  ws="$(drv_psql "$inst" "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='${RIG_HIVE_ID:-}' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$ws" ]; then
    echo "FATAL _ccp_coord_write($inst,$slug,$mid): could not resolve a real workspace_id for pot '${RIG_HIVE_ID:-<unset>}' — refusing to silently write under 'default' (D-050/WI-5399 class)" >&2
    return 1
  fi
  drv_psql "$inst" "INSERT INTO harness_shared.coord_event_log (workspace_id,surface,writer_key,msg_id,body,harness_slug,origin) VALUES ('$ws','messages','ccp-probe','$mid','{\"kind\":\"$kind\",\"text\":\"$text\"}'::jsonb,'$slug','local');" >/dev/null
}

# _ccp_coord_arrives <dst> <msg_id> [tries] — poll <dst> for the coord row arriving
# origin='remote'. Echoes 1 (federated) / 0. Positive analog of rig_assert_row_absent.
_ccp_coord_arrives() {
  local dst="$1" mid="$2" tries="${3:-30}" i row
  for i in $(seq 1 "$tries"); do
    row="$(drv_psql "$dst" "SELECT msg_id FROM harness_shared.coord_event_log WHERE msg_id='$mid' AND origin='remote' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$row" ] && { echo 1; return 0; }
    sleep 3
  done
  echo 0; return 1
}

# ── the scenario ──────────────────────────────────────────────────────────────
# scenario_coord_control_plane <owner-inst> <member-inst>
# Returns 0 iff every CC-* probe passes; prints one "CC-n PASS|FAIL …" line each.
scenario_coord_control_plane() {
  local a="${1:-a}" b="${2:-b}" rc=0 ts mid res
  ts="$(date +%s)"
  # Harness slug to scope the coord rows under: the owner's resolved member slug
  # (the join binds the federating harness). Fall back to the member's own slug.
  local slug="${FRAME_MEMBER_SLUG[$a]:-${FRAME_MEMBER_SLUG[$b]:-}}"
  if [ -z "$slug" ]; then
    echo "CC-SETUP FAIL — no FRAME_MEMBER_SLUG for $a/$b (was rig_join_hive run?)"
    return 1
  fi
  fed_log "Brief 7 — coordination CONTROL plane cross-machine (owner=$a member=$b slug=$slug)"

  # CC-1 — harness-scoped HANDOFF coord row federates a→b
  mid="CC1-HANDOFF-$ts"
  _ccp_coord_write "$a" "$slug" "$mid" "handoff" "handoff offer a→b"
  res="$(_ccp_coord_arrives "$b" "$mid")"
  if [ "$res" = 1 ]; then echo "CC-1 PASS — handoff coord_event_log row federated a→b (origin=remote)"
  else echo "CC-1 FAIL — handoff row did NOT federate a→b within window"; rc=1; fi

  # CC-2 — harness-scoped ESCALATION coord row federates a→b
  mid="CC2-ESCALATION-$ts"
  _ccp_coord_write "$a" "$slug" "$mid" "escalation" "escalation a→b"
  res="$(_ccp_coord_arrives "$b" "$mid")"
  if [ "$res" = 1 ]; then echo "CC-2 PASS — escalation coord_event_log row federated a→b (origin=remote)"
  else echo "CC-2 FAIL — escalation row did NOT federate a→b within window"; rc=1; fi

  # CC-3 — bidirectional: a harness-scoped MESSAGE coord row federates b→a
  mid="CC3-MSG-REV-$ts"
  _ccp_coord_write "$b" "$slug" "$mid" "message" "reverse message b→a"
  res="$(_ccp_coord_arrives "$a" "$mid")"
  if [ "$res" = 1 ]; then echo "CC-3 PASS — coord row federated b→a (bidirectional control-plane data)"
  else echo "CC-3 FAIL — reverse coord row did NOT federate b→a within window"; rc=1; fi

  # CC-4 — NEGATIVE: a coord_event_log row WITHOUT harness_slug must NOT cross
  # (capture trigger filters scope!=harness). harness_slug NULL = operator/fanout-shaped.
  # NOTE: confirm the exact filter column against the mig-150 capture trigger; the
  # registry contract is "only rows with harness_slug set + non-fanout cross", so a
  # NULL harness_slug is the canonical non-federating case.
  mid="CC4-NOHARNESS-$ts"
  # D-050 / WI-5399 iteration 2: pot_home_slug scoping — see _ccp_coord_write's comment.
  local ws_cc4
  ws_cc4="$(drv_psql "$a" "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='${RIG_HIVE_ID:-}' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$ws_cc4" ]; then
    echo "CC-4 FAIL — could not resolve a real workspace_id for pot '${RIG_HIVE_ID:-<unset>}' on $a (D-050/WI-5399 class)"; rc=1
  else
    drv_psql "$a" "INSERT INTO harness_shared.coord_event_log (workspace_id,surface,writer_key,msg_id,body,harness_slug,origin) VALUES ('$ws_cc4','messages','ccp-probe',\$\$$mid\$\$,'{\"kind\":\"message\",\"text\":\"operator-scope must not cross\"}'::jsonb,NULL,'local');" >/dev/null
    res="$(rig_assert_row_absent "$b" "harness_shared.coord_event_log WHERE msg_id='$mid'")"
    if [ "$res" = 1 ]; then echo "CC-4 PASS — operator/no-harness coord row correctly DID NOT federate to b (boundary holds)"
    else echo "CC-4 FAIL — a non-harness coord row LEAKED to b (capture-trigger filter not gating scope)"; rc=1; fi
  fi

  # CC-5 — NEGATIVE: a coord WATERMARK row must NOT cross (local-only by design).
  # coord_watermarks is coord_-prefixed → sync:'none' (no capture trigger). Read
  # position is per-machine. Insert one on a, assert absent on b.
  local wm_owner="ccp-watermark-$ts" ws_cc5
  ws_cc5="$(drv_psql "$a" "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='${RIG_HIVE_ID:-}' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$ws_cc5" ]; then
    echo "CC-5 FAIL — could not resolve a real workspace_id for pot '${RIG_HIVE_ID:-<unset>}' on $a (D-050/WI-5399 class)"; rc=1
  else
    drv_psql "$a" "INSERT INTO harness_shared.coord_watermarks (workspace_id,owner_id,messages_shown_ts) VALUES ('$ws_cc5','$wm_owner', now()) ON CONFLICT DO NOTHING;" >/dev/null 2>&1
    res="$(rig_assert_row_absent "$b" "harness_shared.coord_watermarks WHERE owner_id='$wm_owner'")"
    if [ "$res" = 1 ]; then echo "CC-5 PASS — coord watermark correctly local-only (did NOT federate to b)"
    else echo "CC-5 FAIL — coord watermark LEAKED to b (unexpected: watermarks should be sync:none)"; rc=1; fi
  fi

  if [ "$rc" = 0 ]; then echo "✓ scenario_coord_control_plane: ALL CC probes PASS (owner=$a member=$b)"
  else echo "✗ scenario_coord_control_plane: one or more CC probes FAILED (owner=$a member=$b)"; fi
  return "$rc"
}
