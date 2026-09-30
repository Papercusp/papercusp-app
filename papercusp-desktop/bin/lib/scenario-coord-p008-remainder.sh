#!/usr/bin/env bash
# scenario-coord-p008-remainder.sh — the coordination-only P-008 legs that
# `scenario-coord-control-plane.sh` (CC-1..CC-5) does NOT cover.
#
# WHY A SECOND SCENARIO INSTEAD OF EXTENDING THE FIRST
# ----------------------------------------------------
# CC-1..CC-5 are consumed by the 2-frame matrix runner (bin/deb-hetzner-matrix.sh)
# and are cited BY NAME as plan evidence. Appending legs to that function changes
# what an existing green matrix run means. So the remaining legs live here, in a
# function with its own name and its own CR-* probe labels, and the two compose:
# a full P-008 coordination-only witness is CC-1..CC-5 PASS **and** CR-1..CR-4 PASS.
#
# WHAT P-008 ASKS FOR, AND WHERE EACH LEG LANDS
# ---------------------------------------------
# P-008 (plan p2p-coordination-public-release-2026-08-26, item text on WI-42225):
#   "bidirectional messages, directed reply/report to origin, handoff/escalation/
#    conversation visibility, reconnect/catch-up/restart behavior, and trust/scope
#    negatives. Bank immutable artifacts and treat any silent or skipped leg as
#    failure."
#
#   bidirectional messages ................ CC-1/CC-2 (a→b) + CC-3 (b→a)   [covered]
#   handoff/escalation visibility ......... CC-1 / CC-2                     [covered]
#   scope negatives ....................... CC-4 / CC-5                     [covered]
#   conversation visibility ............... CR-1 (conversations) + CR-2 (threads/posts)
#   directed reply/report to origin ....... CR-3
#   trust negative ........................ CR-4
#   reconnect/catch-up/restart ............ NOT HERE — rig-custody, blocked on the
#                                           P-203 window per D-028 (those legs
#                                           SIGTERM/kickstart the VM daemon).
#
# The federation contract these probes assert is the one declared on the column
# itself (harness_shared.coord_event_log.harness_slug):
#   "NULL = operator-scope/workspace-global (stays local). Harness-scoped rows
#    federate over that harness's peer-log."
# and the outbox priority set (packages/operator-core/lib/sync/hyperbee/outbox-drain.ts,
# OUTBOX_PRIORITY_TABLES) which federates coord_event_log, coord_conversations,
# coord_threads and coord_thread_posts. CR-1/CR-2 are POSITIVE legs because those
# tables are declared federating there — not because a probe happened to pass once.
#
# PROVISIONS NOTHING, TEARS DOWN NOTHING. Reads, plus INSERTs of rows tagged
# `ccp-probe`. No daemon lifecycle event of any kind, so it is safe to run while a
# build's evidence window is open.
#
# CONTRACT (identical to scenario_coord_control_plane):
#   drv_psql <inst> <sql>    the SQL seam         (driver supplies)
#   RIG_HIVE_ID              pot_home_slug        (driver exports)
#   FRAME_MEMBER_SLUG[...]   harness slug         (driver declares)
#   scenario_coord_p008_remainder a b   → prints CR-* PASS/FAIL; returns 0 iff all pass

# Resolve a REAL workspace_id for an instance, or fail loudly. Mirrors
# fed_coord_merge_probe's D-050/WI-5399 handling: never silently write under
# 'default', because a probe that writes to the wrong workspace passes or fails
# for reasons that have nothing to do with federation.
_cr_ws() {
  local inst="$1" ws=""
  if [ -n "${RIG_HIVE_ID:-}" ]; then
    ws="$(drv_psql "$inst" "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  fi
  [ -n "$ws" ] || ws="$(drv_psql "$inst" "SELECT workspace_id FROM harness_shared.pot_members WHERE coalesce(origin,'local')='local' ORDER BY joined_at LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$ws" ] || return 1
  printf '%s' "$ws"
}

# Run a probe's own INSERT and REFUSE to continue if the write itself was rejected.
#
# This exists because of a measured false verdict during authoring: CR-1's INSERT
# violated `coord_conversations_scope_slug_check` (scope defaults to 'operator',
# and that constraint forbids 'operator' together with a non-NULL harness_slug),
# the error was swallowed by `2>/dev/null`, no row was ever written — and the leg
# then reported "conversation row did NOT federate", which reads exactly like a
# product defect. A probe whose SETUP failure is indistinguishable from its FINDING
# is the false-verdict class this rig exists to refuse, so a rejected write is
# reported as SETUP FAIL, never as a federation verdict.
#
# Both signals are checked: the exit status AND an `ERROR:` line in the output,
# because the vm leg crosses ssh, where a psql exit code can be masked.
_cr_insert() {
  local inst="$1" label="$2" sql="$3" out st
  out="$(drv_psql "$inst" "$sql" 2>&1)"; st=$?
  if [ "$st" -ne 0 ] || printf '%s' "$out" | grep -q '^ERROR:'; then
    echo "$label SETUP FAIL — this probe's own INSERT was REJECTED on $inst, so the line below is NOT a federation verdict:"
    printf '%s\n' "$out" | grep -E '^(ERROR|DETAIL):' | head -3 | sed 's/^/    /'
    return 1
  fi
  return 0
}

# Poll dst until a row appears. $1 inst, $2 sql returning one non-empty token,
# $3 tries (default 30, 3s apart = 90s).
_cr_wait_present() {
  local inst="$1" sql="$2" tries="${3:-30}" i row
  for i in $(seq 1 "$tries"); do
    row="$(drv_psql "$inst" "$sql" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$row" ] && { printf '1'; return 0; }
    sleep 3
  done
  printf '0'; return 1
}

# Assert a row is STILL absent after a settle window. A negative needs a window
# long enough that a positive would have landed — the positives above settle well
# inside 90s, so 45s of settle is a real assertion, not an instant "not yet".
_cr_wait_absent() {
  local inst="$1" sql="$2" secs="${3:-45}" waited=0 row
  while [ "$waited" -lt "$secs" ]; do
    row="$(drv_psql "$inst" "$sql" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$row" ] && { printf '0'; return 1; }   # it crossed — negative FAILED
    sleep 5; waited=$((waited + 5))
  done
  printf '1'; return 0
}

scenario_coord_p008_remainder() {
  local a="$1" b="$2" rc=0 res
  local sslug_a="${FRAME_MEMBER_SLUG[$a]:-}" sslug_b="${FRAME_MEMBER_SLUG[$b]:-}"
  local stamp; stamp="$(date +%s)"

  printf '\n=== P-008 remainder — coordination legs NOT covered by CC-1..CC-5 (owner=%s member=%s) ===\n' "$a" "$b"

  if [ -z "$sslug_a" ] || [ -z "$sslug_b" ]; then
    echo "CR-SETUP FAIL — no FRAME_MEMBER_SLUG for $a/$b (was the driver's declare -A run?)"
    return 1
  fi

  local ws_a ws_b
  if ! ws_a="$(_cr_ws "$a")"; then
    echo "CR-SETUP FAIL — could not resolve a real workspace_id on $a for pot '${RIG_HIVE_ID:-<unset>}' (D-050/WI-5399 class)"
    return 1
  fi
  if ! ws_b="$(_cr_ws "$b")"; then
    echo "CR-SETUP FAIL — could not resolve a real workspace_id on $b for pot '${RIG_HIVE_ID:-<unset>}' (D-050/WI-5399 class)"
    return 1
  fi

  # ── CR-1 — conversation visibility: a coord_conversations row federates a→b ──
  # state='resolved' deliberately: a probe row must never surface as OPEN work in
  # a live agent's conversation list.
  # `scope` is NOT optional here and does not default usefully: it defaults to
  # 'operator', and coord_conversations_scope_slug_check requires
  #   (scope='harness' AND harness_slug IS NOT NULL) OR (scope='operator' AND harness_slug IS NULL)
  # so a harness-scoped conversation MUST say scope='harness' explicitly. It is
  # also the federating shape — an operator-scope conversation has no harness_slug
  # and therefore, by the same contract CC-4 asserts, stays local by design.
  local cid="CR1-CONV-$stamp"
  if _cr_insert "$a" "CR-1" "INSERT INTO harness_shared.coord_conversations
      (workspace_id,id,kind,scope,harness_slug,asker_id,title,body,state,origin)
    VALUES ('$ws_a','$cid','discussion','harness','$sslug_a','ccp-probe',
      '[ccp-probe] P-008 conversation federation probe',
      'Probe row written by bin/vm-rig/coord-p008-remainder.sh. Safe to ignore.',
      'resolved','local');"; then
    res="$(_cr_wait_present "$b" "SELECT id FROM harness_shared.coord_conversations WHERE id='$cid' AND origin='remote' LIMIT 1;")"
    if [ "$res" = 1 ]; then echo "CR-1 PASS — conversation row federated a→b (origin=remote)"
    else echo "CR-1 FAIL — conversation row did NOT federate a→b within window"; rc=1; fi
  else
    rc=1
  fi

  # ── CR-2 — conversation visibility, thread half: coord_threads + coord_thread_posts ──
  # coord_thread_posts.id has no default (the app assigns it), so the probe picks an
  # id far above the live sequence rather than racing it.
  local tid="CR2-THREAD-$stamp"
  local pmid="CR2-POST-$stamp"
  local post_id=$((9000000000000 + stamp))
  if _cr_insert "$a" "CR-2" "INSERT INTO harness_shared.coord_threads
      (workspace_id,thread_id,parent_kind,parent_ref,title,created_by,harness_slug,origin)
    VALUES ('$ws_a','$tid','conversation','$cid',
      '[ccp-probe] P-008 thread federation probe','ccp-probe','$sslug_a','local');" &&
     _cr_insert "$a" "CR-2" "INSERT INTO harness_shared.coord_thread_posts
      (id,workspace_id,thread_id,author_id,body,harness_slug,origin,post_msg_id)
    VALUES ($post_id,'$ws_a','$tid','ccp-probe',
      '[ccp-probe] P-008 thread post federation probe. Safe to ignore.',
      '$sslug_a','local','$pmid');"; then
    res="$(_cr_wait_present "$b" "SELECT post_msg_id FROM harness_shared.coord_thread_posts WHERE post_msg_id='$pmid' AND origin='remote' LIMIT 1;")"
    if [ "$res" = 1 ]; then echo "CR-2 PASS — conversation thread POST federated a→b (origin=remote)"
    else echo "CR-2 FAIL — thread post did NOT federate a→b within window"; rc=1; fi
  else
    rc=1
  fi

  # ── CR-3 — directed reply/report to ORIGIN (a→b→a) ────────────────────────────
  # The leg CC-3 does not cover: CC-3 proves a row authored on b reaches a. This
  # proves a REPLY authored on b reaches a *with its linkage to a's original
  # intact* — i.e. a directed reply finds its way back to the originating machine,
  # which is what "reply/report to origin" means operationally. The linkage lives
  # in body->>'related_msg_id' (indexed: coord_event_log_related_msg_id_idx).
  local orig="CR3-ORIG-$stamp" reply="CR3-REPLY-$stamp"
  if ! _cr_insert "$a" "CR-3" "INSERT INTO harness_shared.coord_event_log
      (workspace_id,surface,writer_key,msg_id,body,harness_slug,origin)
    VALUES ('$ws_a','messages','ccp-probe','$orig',
      '{\"kind\":\"message\",\"text\":\"[ccp-probe] P-008 directed-reply origin\"}'::jsonb,
      '$sslug_a','local');"; then
    rc=1
  else
    # a→b must land first, or the reply would be a reply to something b has not seen.
    res="$(_cr_wait_present "$b" "SELECT msg_id FROM harness_shared.coord_event_log WHERE msg_id='$orig' AND origin='remote' LIMIT 1;")"
    if [ "$res" != 1 ]; then
      echo "CR-3 FAIL — the ORIGINAL never reached $b, so the reply leg could not be exercised (not a reply-path verdict)"
      rc=1
    elif ! _cr_insert "$b" "CR-3" "INSERT INTO harness_shared.coord_event_log
        (workspace_id,surface,writer_key,msg_id,body,harness_slug,origin)
      VALUES ('$ws_b','messages','ccp-probe','$reply',
        '{\"kind\":\"message\",\"text\":\"[ccp-probe] P-008 directed reply to origin\",\"related_msg_id\":\"$orig\"}'::jsonb,
        '$sslug_b','local');"; then
      rc=1
    else
      res="$(_cr_wait_present "$a" "SELECT msg_id FROM harness_shared.coord_event_log WHERE msg_id='$reply' AND origin='remote' AND body->>'related_msg_id'='$orig' LIMIT 1;")"
      if [ "$res" = 1 ]; then echo "CR-3 PASS — directed reply federated b→a WITH related_msg_id linkage to the origin's message"
      else echo "CR-3 FAIL — the reply did not reach the origin with its related_msg_id intact"; rc=1; fi
    fi
  fi

  # ── CR-4 — TRUST NEGATIVE: a row scoped to a harness b is NOT a member of ─────
  # CC-4 covers the NULL-harness_slug case (operator scope stays local). This covers
  # the other half of the declared contract: a harness-scoped row federates over
  # *that harness's* peer-log, so a harness b does not share must not reach b.
  # The foreign slug is resolved at RUNTIME from the real membership difference —
  # hardcoding one would silently become a no-op the day membership changes.
  local foreign
  foreign="$(drv_psql "$a" "SELECT pot_home_slug FROM harness_shared.pot_members
      WHERE pot_home_slug <> '${RIG_HIVE_ID:-papercusp}'
      GROUP BY pot_home_slug ORDER BY pot_home_slug LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$foreign" ]; then
    echo "CR-4 FAIL — could not resolve a harness on $a that $b is not in; the trust negative could NOT be constructed (P-008 treats a skipped leg as failure)"
    rc=1
  else
    # The insert guard matters MOST on a negative leg: if the write is rejected the
    # row never exists, nothing can cross, and the absence assertion would report a
    # confident PASS for a boundary it never tested — a false GREEN, the worse
    # direction. So a rejected write here fails the leg instead of passing it.
    local fmid="CR4-FOREIGN-$stamp"
    if ! _cr_insert "$a" "CR-4" "INSERT INTO harness_shared.coord_event_log
        (workspace_id,surface,writer_key,msg_id,body,harness_slug,origin)
      VALUES ('$ws_a','messages','ccp-probe','$fmid',
        '{\"kind\":\"message\",\"text\":\"[ccp-probe] P-008 trust negative — must not cross\"}'::jsonb,
        '$foreign','local');"; then
      rc=1
    else
      # Positive control for the negative: the row must actually EXIST on a. Without
      # this, "absent on b" is unfalsifiable — it reads identically whether the
      # boundary held or the probe never wrote anything.
      local planted
      planted="$(drv_psql "$a" "SELECT msg_id FROM harness_shared.coord_event_log WHERE msg_id='$fmid' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
      if [ -z "$planted" ]; then
        echo "CR-4 FAIL — the foreign-harness row is not present on $a after a clean INSERT; the negative could not be tested (not a boundary verdict)"
        rc=1
      else
        res="$(_cr_wait_absent "$b" "SELECT msg_id FROM harness_shared.coord_event_log WHERE msg_id='$fmid' LIMIT 1;")"
        if [ "$res" = 1 ]; then echo "CR-4 PASS — row scoped to foreign harness '$foreign' is present on $a and correctly did NOT cross to $b (trust boundary holds)"
        else echo "CR-4 FAIL — a row scoped to harness '$foreign' LEAKED to $b, which is not a member (trust boundary breach)"; rc=1; fi
      fi
    fi
  fi

  echo
  if [ "$rc" = 0 ]; then
    echo "✓ scenario_coord_p008_remainder: ALL CR probes PASS (owner=$a member=$b)"
  else
    echo "✗ scenario_coord_p008_remainder: one or more CR probes FAILED (owner=$a member=$b)"
  fi
  return "$rc"
}
