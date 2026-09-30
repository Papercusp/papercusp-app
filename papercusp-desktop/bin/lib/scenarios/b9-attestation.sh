# b9-attestation.sh — P-413 residual (WI-5779) matrix scenario: attestation +
# refused-op-counter witness across a GENUINE second frame.
#
# Sourced by bin/deb-hetzner-matrix.sh (also reached via bin/local-matrix.sh's BYO-frames
# exec). Self-contained: the matrix has ALREADY sourced federation-asserts.sh +
# deb-hetzner-rig.sh and populated RIG_FRAMES=(a b) / FRAME_*/FED_*/FRAME_MEMBER_SLUG/
# RIG_HIVE_*/MATRIX_RUN_ID, and published+joined the hive with a↔b peer_connected. Do NOT
# re-source those and do NOT provision/teardown. `return`, never `exit`. See README.md.
#
# WHY THIS SCENARIO EXISTS (WI-5766/P-413 finding, 2026-07-25): every attestation/
# refused-op-counter witness ever run (WI-5136, WI-1730's closure, the ATTESTATION_PROBE
# rider on two-instance-hive-from-repo-smoke.sh) is SAME-BOX — both HIVE_SMOKE_MODE=deb
# and =sidecar run two isolated instances on ONE machine (loopback + testnet DHT, isolated
# HOMEs/ports). local-matrix.sh's docker-frame rig (pcusp-rig-a / pcusp-rig-b, or the real
# Hetzner BYO frames) is the only vehicle in this repo with a genuine container/machine
# boundary between the two identities, and it had ZERO attestation coverage. This file
# ports the ATTESTATION_PROBE legs from two-instance-hive-from-repo-smoke.sh onto that
# real boundary, using the matrix's own MCP-over-SSH pattern (fleet-directory.sh's
# `_fdir_mcp_call` precedent) instead of a same-box curl to 127.0.0.1.
#
# TWO scenarios, split by the order convention (see README "Order convention"):
#   attestation_membership (60) — LEG1 membership seeding + LEG2 second-device merge +
#     LEG3 wrong-gh-user-id refused-op. All three are ADDITIVE (approve a pending join,
#     union a 2nd device, insert one throwaway mis-attributed receipt that gets refused)
#     and leave both frames HEALTHY for downstream scenarios — safe in the 10-70 band.
#   attestation_unattested_device (89) — LEG4 unattested-device refused-op. TERMINAL: it
#     permanently STRIPS member B's device_attestations on frame a (simulating an author
#     device that resolves to no member) to trigger 'identity_unresolved'. This mutates
#     admission-relevant state for the rest of the run, so it belongs in the terminal band,
#     AFTER the restorative churn legs (restart_durability/reconnect_catchup/
#     replication_soak) — but it MUST run BEFORE revocation_kcut(90). See the ordering
#     invariant at the scenario body below: this leg needs B able to SEND, and the ban
#     revokes exactly that. It also needs a real 35s sleep
#     to wait out the receiver's comms-tier device→user cache TTL (PAPERCUSP_COMMS_TIER_
#     CACHE_MS, default 30_000ms) — acceptable at the very end of a run, not mid-matrix.
#
# LANDING NOTE (do NOT skip): bin/deb-hetzner-matrix.sh sources every bin/lib/scenarios/*.sh
# unconditionally, so dropping this file into that directory makes it part of EVERY future
# full matrix run, including the standing hourly release gate (P-402/P-405). Land it only
# once the current in-flight gate run (P-402 first-green push, 2026-07-25) has completed —
# an untested new scenario landing mid-verification risks turning a hard-won genuine green
# into a red for an unrelated reason. `bash -n` this file and confirm registration via
# `bin/deb-hetzner-matrix.sh --list` (free, no provision) before moving it into place.

# Bounded on-frame MCP tools/call as the pcusp user (fleet-directory.sh's _fdir_mcp_call
# precedent: sidecar superuser bearer from ~/.papercusp/superuser-token, streamable-HTTP
# single-shot, workspace resolved via rig_resolve_ws so the call hits the right partition).
_att_mcp_call() {
  local inst="$1" tool="$2" args="$3" ws
  if ! ws="$(rig_resolve_ws "$inst")"; then
    echo '{"isError":true,"error":"MCP_ERROR: could not resolve a real workspace_id for the mcp call (D-050/WI-5399 class)"}'
    return 1
  fi
  rig_pcusp_run "$inst" <<EOS
f="\$HOME/.papercusp/superuser-token"
[ -s "\$f" ] || { mkdir -p "\$HOME/.papercusp"; head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40 > "\$f"; chmod 600 "\$f"; }
TOK="\$(cat "\$f" 2>/dev/null)"
if [ -z "\$TOK" ]; then echo "ATT_NO_TOKEN"; exit 1; fi
curl -s -m 60 -X POST "http://127.0.0.1:${FED_SC[$inst]}/api/mcp?superuser=1&client=mx-attestation&workspace=${ws}" \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -H "authorization: Bearer \$TOK" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${tool}","arguments":${args}}}'
EOS
}

# ── attestation_membership (60): LEG1 seeding + LEG2 2nd-device + LEG3 wrong-gh refusal ──
scn_attestation_membership() {
  local rid="$MATRIX_RUN_ID" oslug="${FRAME_MEMBER_SLUG[a]:-}" mslug="${FRAME_MEMBER_SLUG[b]:-}"
  [ -n "$oslug" ] && [ -n "$mslug" ] || { echo "attestation: frames not joined (owner='$oslug' member='$mslug')"; return 1; }
  [ -n "${RIG_HIVE_ID:-}" ] || { echo "attestation FAIL — RIG_HIVE_ID unset (hive not published?)"; return 1; }

  local ws b_gh_id a_gh_id
  ws="$(rig_resolve_ws a)" || { echo "attestation FAIL — could not resolve workspace_id on frame a"; return 1; }
  b_gh_id="$(rig_github_id "${FRAME_USER[b]}")"
  a_gh_id="$(rig_github_id "${FRAME_USER[a]}")"
  [ -n "$b_gh_id" ] || { echo "attestation FAIL — could not resolve github id for member '${FRAME_USER[b]:-?}'"; return 1; }

  # (setup) Approve B if the join left a pending row (approval-mode rigs) — idempotent
  # no-op if B is already an admitted member with a device row.
  _att_mcp_call a "pot:membership_decide" "{\"pot\":\"$RIG_HIVE_ID\",\"githubUserId\":$b_gh_id,\"decision\":\"approve\"}" >/dev/null
  sleep 4

  # ── LEG1 — MEMBERSHIP SEEDING: A attests B (≥1 device on A's row) AND B's own roster
  # seeds the owner as origin='remote' (the WI-1585 VM-half symptom was an EMPTY B roster
  # — this is the "genuine second frame" version of that same assert).
  local a_bdev
  a_bdev="$(drv_psql a "SELECT jsonb_array_length(device_attestations) FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" 2>/dev/null | tr -d '[:space:]')"
  { [ -n "$a_bdev" ] && [ "$a_bdev" -ge 1 ]; } 2>/dev/null || { echo "attestation FAIL — LEG1a A does not attest B across the container boundary (B devices on A=$a_bdev)"; return 1; }
  local b_seed=0 i
  for i in $(seq 1 20); do
    b_seed="$(drv_psql b "SELECT count(*) FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND origin='remote';" 2>/dev/null | tr -d '[:space:]')"
    { [ -n "$b_seed" ] && [ "$b_seed" -ge 1 ]; } 2>/dev/null && break
    sleep 3
  done
  { [ -n "$b_seed" ] && [ "$b_seed" -ge 1 ]; } 2>/dev/null || { echo "attestation FAIL — LEG1b B's roster never seeded owner origin=remote across the container boundary (remote members=$b_seed — WI-1585 VM-half empty-roster class)"; return 1; }

  # ── LEG2 — SECOND-DEVICE MERGE (union by device_pubkey, no clobber — WI-1585 leg-A) ──
  local d1 d2 n_before n_after has_d1 has_d2 now_ms
  d1="$(drv_psql a "SELECT (device_attestations->0->>'device_pubkey') FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" 2>/dev/null | tr -d '[:space:]')"
  d2="att2dev-${rid}-$RANDOM"
  n_before="$a_bdev"
  now_ms="$(date +%s)000"
  drv_psql a "INSERT INTO harness_shared.pot_pending_joins (workspace_id,harness_slug,github_user_id,github_username,device_attestations,status,requested_at,created_at,updated_at) VALUES ('$ws','$RIG_HIVE_ID',$b_gh_id,'${FRAME_USER[b]}','[{\"device_pubkey\":\"$d2\",\"gist_id\":\"att-2dev-probe-$rid\",\"gist_url\":\"\",\"device_label\":\"${FRAME_USER[b]}-dev2\",\"created_at\":$now_ms,\"signature_by_device\":\"\"}]'::jsonb,'pending',$now_ms,$now_ms,$now_ms) ON CONFLICT (workspace_id,harness_slug,github_user_id) DO UPDATE SET device_attestations=EXCLUDED.device_attestations,status='pending',updated_at=EXCLUDED.updated_at;" >/dev/null 2>&1
  _att_mcp_call a "pot:membership_decide" "{\"pot\":\"$RIG_HIVE_ID\",\"githubUserId\":$b_gh_id,\"decision\":\"approve\"}" >/dev/null
  sleep 3
  n_after="$(drv_psql a "SELECT jsonb_array_length(device_attestations) FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" 2>/dev/null | tr -d '[:space:]')"
  has_d1=1
  [ -n "$d1" ] && has_d1="$(drv_psql a "SELECT count(*) FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id AND device_attestations @> jsonb_build_array(jsonb_build_object('device_pubkey','$d1'));" 2>/dev/null | tr -d '[:space:]')"
  has_d2="$(drv_psql a "SELECT count(*) FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id AND device_attestations @> jsonb_build_array(jsonb_build_object('device_pubkey','$d2'));" 2>/dev/null | tr -d '[:space:]')"
  { [ -n "$n_after" ] && [ "$n_after" -ge 2 ] && [ "$has_d1" = 1 ] && [ "$has_d2" = 1 ]; } 2>/dev/null || { echo "attestation FAIL — LEG2 second-device merge across the container boundary (devices $n_before→$n_after; D1 kept=$has_d1 D2 added=$has_d2 — WI-1585 leg-A clobber?)"; return 1; }

  # ── LEG3 — WRONG-GH-USER-ID refused-op counter (non-destructive: one throwaway receipt
  # that MUST be refused, never applied) ──
  local rc_before rc_after rid_wrong rid_on_a rc_after_measured
  # WI-5788 (P-411 residual): an UNMEASURED baseline must FAIL, never coerce to 0. An empty
  # read here means the probe never ran (frame a down, psql refused, wrong DSN) — it does NOT
  # mean "the counter is 0". Coercing it to 0 made ANY later nonzero reading satisfy
  # `rc_after -gt rc_before`, so this leg could report PASS on a run where its own refusal
  # never fired and the counter had simply been nonzero all along. Same shape as
  # rig_assert_absent (bin/lib/deb-hetzner-rig.sh): score UNMEASURED as FAIL.
  rc_before="$(drv_psql a "SELECT COALESCE(sum(count),0) FROM harness_shared.p2p_refused_op_counters WHERE harness_slug='$RIG_HIVE_ID' AND reason='receipt-apply:responder_mismatch';" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$rc_before" ] || { echo "attestation FAIL — LEG3 baseline UNMEASURED: the responder_mismatch counter probe on frame a returned nothing, so 'counter is 0' and 'probe never ran' are indistinguishable; refusing to score this leg"; return 1; }
  rid_wrong="att-wrong-${rid}-$RANDOM"; now_ms="$(date +%s)000"
  drv_psql b "INSERT INTO harness_shared.p2p_receipts (workspace_id,harness_slug,receipt_id,kind,action,detail,responder_github_user_id,receipt_ts,origin) VALUES ('$ws','$RIG_HIVE_ID','$rid_wrong','refusal','work-offer:claim','att wrong-gh probe ($rid)',${a_gh_id:-999999999},$now_ms,'local');" >/dev/null 2>&1
  # WI-6046: record whether the probe actually landed on b — DIAGNOSTIC ONLY (see the LEG4
  # note below for why this must not hard-fail: a federated receipt may legitimately leave b).
  # Surfaced in the scoring message so a silently-failed INSERT stops reading as "the feature
  # did not bump the counter".
  local wrong_on_b
  wrong_on_b="$(drv_psql b "SELECT count(*) FROM harness_shared.p2p_receipts WHERE harness_slug='$RIG_HIVE_ID' AND receipt_id='$rid_wrong';" 2>/dev/null | tr -d '[:space:]')"
  # WI-40549: report AT the measurement point. The scoring message below is only
  # reached on ONE of this leg's exit paths; the post-probe-UNMEASURED bail
  # returns without ever printing this, and that is precisely the path where
  # "did the probe land on b?" decides rig-fault vs product-fault.
  rig_reading "LEG3.probe-on-b" "$wrong_on_b"
  rc_after=""; rc_after_measured=0
  for i in $(seq 1 40); do
    rc_after="$(drv_psql a "SELECT COALESCE(sum(count),0) FROM harness_shared.p2p_refused_op_counters WHERE harness_slug='$RIG_HIVE_ID' AND reason='receipt-apply:responder_mismatch';" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$rc_after" ]; then
      rc_after_measured=1
      { [ "$rc_after" -gt "$rc_before" ]; } 2>/dev/null && break
    fi
    sleep 3
  done
  # A poll that NEVER got a reading is a dead probe, not "no bump" — distinguish them so the
  # failure message names the real fault instead of blaming the feature under test.
  [ "$rc_after_measured" = 1 ] || { echo "attestation FAIL — LEG3 post-probe UNMEASURED: all 40 responder_mismatch reads on frame a returned empty (the probe never ran — this is NOT evidence the counter failed to bump)"; return 1; }
  rid_on_a="$(drv_psql a "SELECT count(*) FROM harness_shared.p2p_receipts WHERE harness_slug='$RIG_HIVE_ID' AND receipt_id='$rid_wrong';" 2>/dev/null | tr -d '[:space:]')"
  { [ "$rc_after" -gt "$rc_before" ] && [ "$rid_on_a" = 0 ]; } 2>/dev/null || { echo "attestation FAIL — LEG3 wrong-gh-user refused-op across the container boundary (responder_mismatch $rc_before→$rc_after, row-on-a=$rid_on_a, probe-on-b=${wrong_on_b:-<unmeasured>} [WI-6046: probe-on-b=0/<unmeasured> means the probe receipt may never have been emitted — suspect the rig, not the feature])"; return 1; }

  echo "attestation OK on a GENUINE second frame (container boundary, not same-box): LEG1 A attests B + B roster seeded origin=remote, LEG2 second-device merge no-clobber, LEG3 wrong-gh-user refused-op counter $rc_before→$rc_after"
  return 0
}
matrix_register attestation_membership 60 "attestation membership seeding + 2nd-device + wrong-gh refused-op, on a GENUINE 2nd frame (P-413/WI-5779)" scn_attestation_membership

# ── attestation_unattested_device (89, TERMINAL): LEG4 unattested-device refused-op ──
# Permanently strips B's device_attestations on A to simulate an author device that resolves
# to no member, then waits out the comms-tier device→user cache TTL and asserts the
# identity_unresolved refusal + counter bump.
#
# ⚠ ORDERING INVARIANT — TWO CEILINGS, BOTH LOAD-BEARING. This leg runs at **79**:
#   (1) strictly BELOW revocation_kcut(90) — DO NOT "restore" it to 91; that ordering is the
#       WI-5064 defect, not a convention (full argument immediately below); and
#   (2) strictly BELOW the churn legs — restart_durability(80), restart_settle_barrier(82),
#       reconnect_catchup(85), replication_soak(87) — because THIS LEG'S PRECONDITION IS
#       ANTI-MONOTONE AND EVERY RECONNECT UNDOES IT (2026-07-26, the second half of the fix).
#       The leg empties B's device_attestations; both writers of that column put it BACK on an
#       announce, and a reconnect is what triggers an announce:
#         · the PROJECTION (hive-members.ts:145-158) REPLACES the column from a remote op —
#           guarded by fed_order_key >= , which our trigger-stamped strip beats, so only a
#           genuinely NEWER announce can win; and
#         · the ADMISSION path (upsertHiveMember, hive-membership-store.ts:364-393)
#           UNION-merges the column with NO clock guard at all (WI-1585 merge-never-replace),
#           so an announce restores it regardless of how new the strip is.
#       Neither can be beaten by waiting longer, which is why the fix is ordering and never a
#       widened timeout. replication_soak(87) alone performs 5 kill/restart cycles; running
#       after it, the leg failed PRECONDITION UNHOLDABLE with the strip undone TWICE.
#       Matching controlled evidence, churn absent vs present:
#         --only=attestation_membership,attestation_unattested_device → LEG4 PASS
#         full 17-leg matrix with this leg at 89                      → PRECONDITION UNHOLDABLE
#       If it drifts even at 79, the leg now prints a DRIFT FINGERPRINT naming which of the two
#       writers did it (see _att_row_fingerprint) — read that before changing anything else.
#       Blast radius of the earlier slot is self-limiting: the leg restores what it strips, and
#       in exactly the environment where the restore could fail (announces flowing) the same
#       announce that breaks the strip also re-attests B.
#   WHY: this leg's probe requires B to still be able to SEND — B writes a p2p_receipt that
#   must federate b→a so that A applies-and-refuses it with identity_unresolved. revocation_kcut
#   BANS B (b3-revocation.sh:10 "may be unable to receive afterward"), and revocation is
#   STICKY/MONOTONE (hive-membership-store.ts:355, union-never-replace), so once it has run
#   B's pubkey is on A's admission blocklist for the REST OF THE RUN. The probe then never
#   reaches A's apply path, no refusal counter moves, and this leg reports
#   "identity_unresolved 0→0" as though the FEATURE had failed. It red-pinned the standing
#   release gate 3/3 and blocked first-green (WI-5064).
#   PROVEN BY CONTROLLED EXPERIMENT (2026-07-26), one variable, restart/soak absent from both:
#     --only=attestation_membership,attestation_unattested_device                  → LEG4 PASS
#     --only=attestation_membership,revocation_kcut,attestation_unattested_device  → LEG4 FAIL
#   So the ban is the cause; the churn legs are NOT. (Both logs banked under
#   ~/.papercusp/live-fed-gate/triage.)
#   THE OTHER DIRECTION IS NOT FREE — THIS LEG MUST RESTORE WHAT IT STRIPS. Moving it before
#   the ban is necessary but NOT sufficient: revocation_kcut BANS B by revoking B's device
#   PUBKEYS, which it reads out of the very column this leg empties. Verified live (fix-
#   verification run, 2026-07-26 16:23 EDT, order 89): LEG4 PASSED and revocation_kcut then
#   FAILED with {"error":"The target contributor has no known devices"}. So the leg saves
#   device_attestations before the strip and restores them afterwards via a wrapper that runs
#   on every exit path. Do not remove the restore — without it, fixing this leg simply breaks
#   revocation instead, and the gate stays red.
#   (Its baseline CONTENT probe is genuinely unaffected: the stripped row feeds only
#   deviceToUser() → resolveAuthorCommsTier(), bound solely in INBOUND hyperbee projections,
#   whereas that probe is a→b content authored by A and resolved against B's own pot_members
#   copy. The ban step, not the baseline, is what the strip broke.)
# ── WHICH WRITER PUT THE ATTESTATION BACK? (2026-07-26) ──────────────────────────────
# The leg has failed PRECONDITION UNHOLDABLE with a fix DIRECTION but no fix, because the
# message names its suspect ("re-federated from the other replica") without ever measuring
# it. There are exactly TWO writers of pot_members.device_attestations, and they stamp the
# row DIFFERENTLY — so one paired read discriminates them, where no further reading of the
# apply path can (the fingerprint-beats-a-mechanism-story move that settled WI-6210):
#
#   origin='remote', fed_ts NEWER than the strip
#     ⇒ the hyperbee PROJECTION applied a remote pot_members op.
#       hive-members.ts:145-158 REPLACES device_attestations, guarded by
#       fed_order_key(EXCLUDED) >= fed_order_key(existing). Our strip is a local UPDATE on a
#       table carrying stamp_local_federated_write (mig 214 installs it on `hive_members`,
#       renamed `pot_members` by mig 557), so the strip BUMPS fed_ts/fed_hlc — a REPLAYED
#       older op cannot beat it. A remote fingerprint therefore means a genuinely NEWER
#       remote op (B re-announced its device), not a replay.
#
#   origin='local'
#     ⇒ a LOCAL write on this frame put it back — i.e. the ADMISSION path,
#       upsertHiveMember (hive-membership-store.ts:364-393), which UNION-merges
#       device_attestations by device_pubkey with NO clock guard at all (WI-1585: merge,
#       never replace). Every announce/admission therefore re-attests B no matter how new
#       our strip is, and NO ordering change can fix that — only holding the strip, or
#       building the precondition some other way, can.
#
# A SECOND, FREE FINGERPRINT — THE DEVICE COUNT. The two writers restore DIFFERENT-SIZED
# arrays, and the leg already prints both numbers:
#   restored N == saved N (here 2)  ⇒ a wholesale REPLACE — the projection wrote the remote
#                                     row's full attestation array back.
#   restored 1 while saved N>1      ⇒ the ADMISSION UNION merge: every announce admission
#                                     passes only the ANNOUNCING device (see upsertHiveMember's
#                                     own WI-1585 comment), so union-onto-emptied yields exactly
#                                     one entry. Ordering can only remove the announces that
#                                     TRIGGER it; it cannot make the strip hold against one.
# Observed in gate run 184106 at order 89: saved 2 on both frames, drift came back with 1 — the
# admission signature. Recorded here because that number was in the log for three earlier runs
# and nobody read it as a measurement.
#
# Both readings are actionable and they demand OPPOSITE fixes, which is exactly why the leg
# must measure instead of guess. DIAGNOSTIC ONLY — never a verdict input.
# _att_count_verdict <restored-count> — render the DEVICE-COUNT fingerprint together with
# the CONCLUSION it licenses, so the count is never emitted as a bare unlabelled number.
#
# WI-40551. The block above documents that restored-1-of-saved-N IS the admission
# signature, and the first-drift message derives it inline — but the TERMINAL FAIL
# message printed the same number as an unlabelled parenthetical ("$pre_probe
# attestation(s) at the second check") and then left the reader with two origin branches
# demanding OPPOSITE fixes. The number was therefore present and useless at exactly the
# moment it decided the fix.
#
# That is not hypothetical: the comment above records the same number sitting in the log
# across three earlier runs with nobody reading it as a measurement, and a fourth reader
# repeated the mistake while filing this very item. A bare count demonstrably does not
# survive being read. Derive the verdict ONCE and emit it everywhere the count appears —
# the same positional discipline as R7/rig_reading, applied to an interpretation rather
# than a reading.
#
# DIAGNOSTIC ONLY — never a verdict input (same contract as _att_row_fingerprint).
_att_count_verdict() {
  local restored="${1-}" saved
  saved="$(printf '%s' "${_ATT_SAVED_ROW}" | grep -o 'device_pubkey' | wc -l | tr -d '[:space:]')"
  # An unreadable count and a zero count are NOT the same claim; never collapse them.
  if [ -z "$restored" ]; then
    # WI-40549: $saved was measured one line above and this return is the only path that
    # never reports it. The TIEBREAK is genuinely unavailable here (it needs both halves),
    # but the saved count is still a reading in its own right — it says whether the saved
    # set was captured at all, which is what separates "nothing to compare against" from
    # "compared and unreadable". Emit it AT the measurement, in its own three states.
    printf 'restored=<unreadable> of %s saved — the count tiebreak is unavailable (the restored half could not be read), so read the origin fingerprint and do NOT infer a writer from this line' "${saved:-<unreadable>}"
    return 0
  fi
  if ! [ "${saved:-0}" -gt 0 ] 2>/dev/null; then
    printf 'restored %s of <saved-unknown> — the saved set was not captured, so the count tiebreak is unavailable here' "$restored"
    return 0
  fi
  if [ "$restored" = "$saved" ] 2>/dev/null; then
    printf 'restored %s of %s saved ⇒ WHOLESALE REPLACE (the projection wrote the remote row back) ⇒ ordering CAN help: move this leg ahead of the churn legs that trigger reconnect-announces' "$restored" "$saved"
  elif [ "$restored" -lt "$saved" ] 2>/dev/null; then
    printf 'restored %s of %s saved ⇒ ADMISSION signature (WI-1585: upsertHiveMember UNION-merges and an announce carries only the announcing device) ⇒ NO ordering change can hold the strip; stop stripping and build the precondition another way' "$restored" "$saved"
  else
    printf 'restored %s of %s saved — restored EXCEEDS saved, which matches NEITHER documented signature; investigate rather than assuming either fix' "$restored" "$saved"
  fi
}

_att_row_fingerprint() {
  local frame="$1" gh="$2"
  drv_psql "$frame" "SELECT COALESCE(origin,'?')||'|fed_ts='||COALESCE(fed_ts::text,'NULL')||'|fed_hlc='||COALESCE(fed_hlc,'NULL')||'|author='||COALESCE(left(author_pubkey,12),'NULL')||'|devs='||COALESCE(jsonb_array_length(device_attestations),0)::text FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$gh;" 2>/dev/null | tr -d '[:space:]'
}

_scn_attestation_unattested_device_core() {
  local rid="$MATRIX_RUN_ID" oslug="${FRAME_MEMBER_SLUG[a]:-}" mslug="${FRAME_MEMBER_SLUG[b]:-}"
  [ -n "$oslug" ] && [ -n "$mslug" ] || { echo "attestation(unattested-device): frames not joined"; return 1; }
  [ -n "${RIG_HIVE_ID:-}" ] || { echo "attestation(unattested-device) FAIL — RIG_HIVE_ID unset"; return 1; }

  local ws b_gh_id
  ws="$(rig_resolve_ws a)" || { echo "attestation(unattested-device) FAIL — could not resolve workspace_id on frame a"; return 1; }
  b_gh_id="$(rig_github_id "${FRAME_USER[b]}")"
  [ -n "$b_gh_id" ] || { echo "attestation(unattested-device) FAIL — could not resolve github id for member '${FRAME_USER[b]:-?}'"; return 1; }

  # WI-5779 fix (2026-07-25, code-review catch — same class as WI-5715): the assert MUST be
  # scoped to the EXACT reason 'receipt-apply:identity_unresolved', never a loose
  # `LIKE 'receipt-apply:%'` total. LEG3 (attestation_membership, order 60, same run) already
  # bumped 'receipt-apply:responder_mismatch' earlier, AND restart_durability(80)/
  # reconnect_catchup(85)/replication_soak(87) — all invasive scenarios that can trigger
  # re-federation/retries of prior receipts — run BETWEEN leg3 and this scenario(89).
  # A loose total-based `tot_after > tot_before` can therefore go true from a
  # STRAY re-bump of responder_mismatch (or any other receipt-apply reason) without
  # identity_unresolved ever firing — a guaranteed-nonzero baseline plus an unrelated further
  # bump is a false PASS, never actually proving this leg's own claim. Scope to the one reason
  # this leg actually causes.
  local rc_before rc_after rid_rem rem_on_a reasons now_ms rc_after_measured
  # EI-18737225233571148 (2026-07-26): reasons_before/after/moved. The scoring below used to
  # explain its FAIL from `reasons` alone — a hive-wide `ORDER BY updated_at DESC LIMIT 3` read
  # — which cannot distinguish a refusal THIS leg caused from an unrelated leg's retry. That is
  # not a hypothetical: see the diff-based rationale at the reasons_moved computation below.
  local reasons_before reasons_after reasons_moved
  # WI-5788 (P-411 residual): UNMEASURED baseline ⇒ FAIL, never coerce to 0. See the LEG3
  # comment above — and note this leg is MORE exposed to it, because it runs late (order 89)
  # after the invasive churn scenarios (restart_durability/reconnect_catchup/
  # replication_soak) that can leave frame a briefly unreachable. A dead baseline probe there
  # coerces to 0, and then a single real identity_unresolved bump from ANY source reads as
  # this leg's own proof.
  rc_before="$(drv_psql a "SELECT COALESCE(sum(count),0) FROM harness_shared.p2p_refused_op_counters WHERE harness_slug='$RIG_HIVE_ID' AND reason='receipt-apply:identity_unresolved';" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$rc_before" ] || { echo "attestation(unattested-device) FAIL — LEG4 baseline UNMEASURED: the identity_unresolved counter probe on frame a returned nothing, so 'counter is 0' and 'probe never ran' are indistinguishable; refusing to score this leg"; return 1; }

  # WI-5064: SAVE B's device attestations BEFORE the strip so the wrapper can RESTORE them on
  # every exit path. This leg is no longer allowed to leave B device-less: revocation_kcut(90)
  # runs after it and BANS B by revoking B's device PUBKEYS, which it reads out of exactly this
  # column — with the column emptied the ban fails outright ("The target contributor has no
  # known devices"). Verified live: the fix-verification run at 16:23 EDT had LEG4 PASS at
  # order 89 and revocation_kcut FAIL with that exact error. Capture-then-restore is what makes
  # 89 a legal slot; do not drop it.
  _ATT_SAVED_OK=0
  _ATT_SAVED_GH_ID="$b_gh_id"
  _ATT_SAVED_ROW="$(drv_psql a "SELECT COALESCE(device_attestations::text,'[]') FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$_ATT_SAVED_ROW" in
    '['*) _ATT_SAVED_OK=1 ;;
    *) echo "  · attestation(unattested-device): WARN — could not read B's device_attestations before the strip (got '${_ATT_SAVED_ROW:-<empty>}'); will not attempt a restore, so revocation_kcut(90) may fail to find B's pubkeys" ;;
  esac

  # WI-5064 FOLLOW-UP (gate run 164022): ALSO save + strip on frame B. `pot_members` is a
  # FEDERATED table, so stripping only A leaves the value intact on B — and any b→a re-sync
  # during this leg's ~155s window puts it straight back, silently destroying the precondition.
  # That is not hypothetical: this leg runs at 89, immediately after replication_soak(87), which
  # performs 5 kill/restart cycles — every reconnect triggers exactly such a catch-up re-sync.
  # It also explains the otherwise-baffling isolated-vs-matrix split measured on 2026-07-26:
  # `--only=attestation_membership,attestation_unattested_device` PASSES (no soak, no reconnect,
  # nothing to re-federate the row) while the full 17-leg matrix FAILS with the receipt APPLIED
  # instead of refused. Strip BOTH replicas so neither side can restore it.
  _ATT_SAVED_ROW_B="$(drv_psql b "SELECT COALESCE(device_attestations::text,'[]') FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$_ATT_SAVED_ROW_B" in
    '['*) _ATT_SAVED_B_OK=1 ;;
    *) _ATT_SAVED_B_OK=0; echo "  · attestation(unattested-device): WARN — could not read B's device_attestations on frame b before the strip (got '${_ATT_SAVED_ROW_B:-<empty>}'); stripping b anyway would risk an unrestorable member row, so b is left intact and the precondition may be re-federated back (the strip-at-scoring check below will report it)" ;;
  esac

  # Strip B's attestation on A (author device now maps to no member) — and on B when we hold a
  # restorable copy of it, so the row cannot be re-federated back from the other replica.
  drv_psql a "UPDATE harness_shared.pot_members SET device_attestations='[]'::jsonb WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" >/dev/null 2>&1
  [ "${_ATT_SAVED_B_OK:-0}" = 1 ] && drv_psql b "UPDATE harness_shared.pot_members SET device_attestations='[]'::jsonb WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" >/dev/null 2>&1
  # WI-6046 (2026-07-26): the strip above is this leg's ENTIRE precondition, and it swallowed
  # every error (>/dev/null 2>&1, no rc check, no read-back). If frame a's PG is degraded when
  # it runs — likely, since this leg runs LAST after four invasive scenarios, exactly as the
  # WI-5788 comment below already warns — the UPDATE silently no-ops. B's device then still
  # resolves to a member, A correctly does NOT refuse, and the scoring assert at the bottom
  # reports "identity_unresolved 0→0" as though the FEATURE under test had failed.
  # Observed live: gate run 083840 (12:38Z UTC) failed exactly this way while frame a was
  # recovering from 3 SIGTERMs. Verify the setup and fail as SETUP, naming the real fault —
  # the same UNMEASURED⇒FAIL discipline the read path already gets, applied to the write path.
  # Probe with count(*) FIRST: it ALWAYS returns exactly one row, so an empty result means the
  # query never ran (frame a down / psql refused) rather than "no such member". Without that
  # split, a member row that legitimately does not exist on a — a state in which the
  # precondition (B's device resolves to no member) is ALREADY satisfied and this leg passes
  # today — would read as UNVERIFIED and turn a genuine PASS into a FAIL. That would be the
  # mirror image of the bug this change fixes, so it is worth the extra query.
  local member_rows stripped
  member_rows="$(drv_psql a "SELECT count(*) FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$member_rows" ] || { echo "attestation(unattested-device) FAIL — LEG4 SETUP UNVERIFIED: the pot_members probe on frame a returned nothing after the strip (count(*) always returns a row, so this means the query never ran — frame a down / psql refused), leaving 'strip applied' and 'probe never ran' indistinguishable; refusing to score this leg"; return 1; }
  if [ "$member_rows" != 0 ]; then
    stripped="$(drv_psql a "SELECT COALESCE(jsonb_array_length(device_attestations),0) FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$stripped" ] || { echo "attestation(unattested-device) FAIL — LEG4 SETUP UNVERIFIED: the member row exists on frame a but device_attestations could not be read back after the strip; refusing to score this leg"; return 1; }
    [ "$stripped" = 0 ] || { echo "attestation(unattested-device) FAIL — LEG4 SETUP DID NOT APPLY: B still carries $stripped device attestation(s) on frame a after the strip UPDATE (frame a degraded / PG unavailable?). The precondition was never established, so a non-refusal below would NOT be a product defect"; return 1; }
  fi
  # Baseline for the drift fingerprint below: what the row looked like the moment the strip
  # was verified. Without a BEFORE reading, a later `fed_ts=...` is just a number — with one,
  # "newer than the strip" is decidable and the two writers separate.
  local strip_fp_a strip_fp_b
  strip_fp_a="$(_att_row_fingerprint a "$b_gh_id")"
  strip_fp_b="$(_att_row_fingerprint b "$b_gh_id")"

  sleep 35   # PAPERCUSP_COMMS_TIER_CACHE_MS default 30_000ms — wait out the device→user cache

  # WI-5064 FOLLOW-UP: RE-ASSERT the precondition immediately before the probe. The verification
  # above ran 35s ago and the strip is racing federation, so this is the last point at which a
  # re-federated row can be caught BEFORE the probe rather than diagnosed afterwards. One bounded
  # repair attempt (re-strip both replicas + another cache TTL), then give up and say so — a leg
  # that quietly proceeds on a broken precondition is what produced three runs of "identity
  # unresolved 0→0" read as a feature failure.
  local pre_probe
  pre_probe="$(drv_psql a "SELECT COALESCE(jsonb_array_length(device_attestations),0) FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" 2>/dev/null | tr -d '[:space:]')"
  if [ "${pre_probe:-0}" -gt 0 ] 2>/dev/null; then
    local drift_fp_a
    drift_fp_a="$(_att_row_fingerprint a "$b_gh_id")"
    echo "  · attestation(unattested-device): precondition drifted — B carries $pre_probe attestation(s) on a again after the 35s cache wait; re-stripping both frames once and re-waiting the device→user cache"
    echo "  · attestation(unattested-device): DRIFT FINGERPRINT (see _att_row_fingerprint) — a at strip: ${strip_fp_a:-<unreadable>} → a now: ${drift_fp_a:-<unreadable>} (b at strip: ${strip_fp_b:-<unreadable>}). origin=remote+newer fed_ts ⇒ a NEWER remote op re-announced B (projection replace); origin=local ⇒ the admission path's UNION merge (upsertHiveMember) re-attested B and NO ordering change can hold the strip. Cross-check the COUNT: $(_att_count_verdict "$pre_probe")."
    drv_psql a "UPDATE harness_shared.pot_members SET device_attestations='[]'::jsonb WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" >/dev/null 2>&1
    [ "${_ATT_SAVED_B_OK:-0}" = 1 ] && drv_psql b "UPDATE harness_shared.pot_members SET device_attestations='[]'::jsonb WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" >/dev/null 2>&1
    sleep 35
    pre_probe="$(drv_psql a "SELECT COALESCE(jsonb_array_length(device_attestations),0) FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" 2>/dev/null | tr -d '[:space:]')"
    if [ "${pre_probe:-0}" -gt 0 ] 2>/dev/null; then
      local drift_fp_a2 drift_fp_b2
      drift_fp_a2="$(_att_row_fingerprint a "$b_gh_id")"
      drift_fp_b2="$(_att_row_fingerprint b "$b_gh_id")"
      echo "OVERALL: UNMEASURED — attestation(unattested-device) PRECONDITION UNHOLDABLE, so this leg CANNOT score the feature (NOT a product defect): B's device_attestations were stripped on both frames twice and came back on frame a both times. THE COUNT ALREADY DECIDES THIS — $(_att_count_verdict "$pre_probe") [WI-40551: this reading was present but unlabelled for four runs before anyone read it as a measurement; it is the tiebreak between the two branches below, which demand OPPOSITE fixes]. WHICH WRITER — corroborate with the fingerprint, do not guess: a at strip ${strip_fp_a:-<unreadable>} → a now ${drift_fp_a2:-<unreadable>}; b at strip ${strip_fp_b:-<unreadable>} → b now ${drift_fp_b2:-<unreadable>}. origin=remote with a fed_ts NEWER than the strip ⇒ the PROJECTION applied a genuinely newer remote op (hive-members.ts replaces under an LWW guard our strip's stamp would have beaten, so this is a re-announce, not a replay) ⇒ FIX by moving this leg ahead of the churn legs that trigger reconnect-announces (it must stay strictly below revocation_kcut/90). origin=local ⇒ the ADMISSION path re-attested B: upsertHiveMember UNION-merges device_attestations with no clock guard (WI-1585), so every announce restores it and NO ordering change can hold the strip — the leg must then stop stripping and build its precondition another way (author the probe from a device pubkey that was never attested). Either way: do NOT widen a timeout."
      # WI-6046: rc=2, NOT 1. This leg ran and could not hold its own precondition, so
      # it measured NOTHING about the product — returning 1 collapsed that into a
      # product FAIL, which red-pinned the gate on a rig-side setup problem and read as
      # a defect in the unattested-device feature. rc=2 is the rig's ratified
      # "not measured" code (lib/federation-asserts.selftest.sh, WI-6012); the matrix
      # runner maps it to the UNMS row. Still nonzero, so every existing `-ne 0`
      # consumer (e.g. b3-revocation.sh's SCN_RC attribution) is unaffected.
      return 2
    fi
  fi

  rid_rem="att-unatt-${rid}-$RANDOM"; now_ms="$(date +%s)000"
  # EI-18737225233571148: snapshot the FULL per-reason counter vector immediately BEFORE the
  # probe. Sorted by REASON (not updated_at) so it is a stable set, and unbounded (no LIMIT 3)
  # so a reason cannot fall out of the window and read as "new" later. Diffing this against the
  # same read after the probe is what lets the scoring below cite ONLY reasons THIS leg caused.
  reasons_before="$(drv_psql a "SELECT reason||'='||count FROM harness_shared.p2p_refused_op_counters WHERE harness_slug='$RIG_HIVE_ID' AND reason LIKE 'receipt-apply:%' ORDER BY reason;" 2>/dev/null | awk '{gsub(/[ \t]/,""); if($0!="") printf "%s ", $0}')"
  drv_psql b "INSERT INTO harness_shared.p2p_receipts (workspace_id,harness_slug,receipt_id,kind,action,detail,responder_github_user_id,receipt_ts,origin) VALUES ('$ws','$RIG_HIVE_ID','$rid_rem','refusal','work-offer:claim','att unattested-device probe ($rid)',${b_gh_id:-999999999},$now_ms,'local');" >/dev/null 2>&1
  # WI-6046: same class as the strip above — if this INSERT silently fails (frame b degraded),
  # no receipt ever federates, the counter cannot bump, and the scoring assert blames the
  # feature for a probe that was never emitted. Record whether the row landed, DIAGNOSTIC ONLY:
  # deliberately NOT a hard fail, because a receipt may legitimately leave b once it federates,
  # so "absent" here cannot distinguish never-inserted from already-drained. Hard-failing on it
  # would manufacture the very false-FAIL class this change removes. It is surfaced in the
  # scoring message below, where it separates "rig never emitted the probe" from "A failed to refuse".
  local probe_on_b
  probe_on_b="$(drv_psql b "SELECT count(*) FROM harness_shared.p2p_receipts WHERE harness_slug='$RIG_HIVE_ID' AND receipt_id='$rid_rem';" 2>/dev/null | tr -d '[:space:]')"
  # WI-40549: report AT the measurement point. BOTH the post-probe-UNMEASURED
  # bail below and the OK path return without printing this reading, so on a
  # green run and on a dead-probe run alike it was silently discarded — leaving
  # no way to tell "the rig never emitted the probe" from "A behaved correctly".
  rig_reading "LEG4.probe-on-b" "$probe_on_b"
  rc_after=""; rc_after_measured=0
  local i
  for i in $(seq 1 40); do
    rc_after="$(drv_psql a "SELECT COALESCE(sum(count),0) FROM harness_shared.p2p_refused_op_counters WHERE harness_slug='$RIG_HIVE_ID' AND reason='receipt-apply:identity_unresolved';" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$rc_after" ]; then
      rc_after_measured=1
      { [ "$rc_after" -gt "$rc_before" ]; } 2>/dev/null && break
    fi
    sleep 3
  done
  [ "$rc_after_measured" = 1 ] || { echo "attestation(unattested-device) FAIL — LEG4 post-probe UNMEASURED: all 40 identity_unresolved reads on frame a returned empty (the probe never ran — NOT evidence the counter failed to bump)"; return 1; }
  rem_on_a="$(drv_psql a "SELECT count(*) FROM harness_shared.p2p_receipts WHERE harness_slug='$RIG_HIVE_ID' AND receipt_id='$rid_rem';" 2>/dev/null | tr -d '[:space:]')"
  reasons="$(drv_psql a "SELECT reason||'='||count FROM harness_shared.p2p_refused_op_counters WHERE harness_slug='$RIG_HIVE_ID' AND reason LIKE 'receipt-apply:%' ORDER BY updated_at DESC LIMIT 3;" 2>/dev/null | tr '\n' ' ')"
  # WI-5064 FOLLOW-UP (2026-07-26, gate run 164022). The strip is verified ONCE, at
  # line ~256 — then this leg sleeps 35s and polls up to 120s more. `pot_members` is a
  # FEDERATED table and frame b's copy still carries B's attestations, so any re-sync
  # of that row from b during those ~155s silently puts the attestations BACK on a and
  # UNDOES the precondition. Read it again at SCORING time so the verdicts below can
  # say so instead of blaming the feature (used after the PASS check).
  local strip_at_scoring
  strip_at_scoring="$(drv_psql a "SELECT COALESCE(jsonb_array_length(device_attestations),0) FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=$b_gh_id;" 2>/dev/null | tr -d '[:space:]')"
  # EI-18737225233571148: compute which reasons ACTUALLY MOVED during this leg. A token is
  # 'reason=count', so a changed count OR a brand-new reason both surface as a token absent from
  # the before-set — exactly the "moved" set, with no extra bookkeeping.
  #
  # WHY THIS EXISTS. The FAIL explanation below used to key off `reasons` (top-3 by updated_at)
  # and, on seeing responder_mismatch there, declared "RIG/ENVIRONMENTAL ... Do not open a fresh
  # investigation off this signature alone". Observed live in gate run 133957 (2026-07-26): that
  # verdict was WRONG and it suppressed the real investigation for hours. LEG3 (order 60) emits
  # ONE receipt with responder=a_gh_id and bumps responder_mismatch 0->2; the four invasive
  # scenarios that run between LEG3 and this one (restart_durability/reconnect_catchup/
  # replication_soak/revocation_kcut — restart_settle_barrier took 604s that run) then RETRIED
  # that same receipt until the counter read 10, every retry logged with the identical
  # responder=279242982. So responder_mismatch was the most-recently-updated reason at scoring
  # time while THIS leg's probe had caused no refusal at all — none of the 10 carried this leg's
  # own responder. The counter assert above was already hardened against exactly this
  # stale-rebump hazard (see the WI-5779 comment: scope to the ONE reason this leg causes); the
  # hardening simply was never applied to the EXPLANATION. Diffing closes that gap.
  reasons_after="$(drv_psql a "SELECT reason||'='||count FROM harness_shared.p2p_refused_op_counters WHERE harness_slug='$RIG_HIVE_ID' AND reason LIKE 'receipt-apply:%' ORDER BY reason;" 2>/dev/null | awk '{gsub(/[ \t]/,""); if($0!="") printf "%s ", $0}')"
  reasons_moved=""
  local _tok
  for _tok in $reasons_after; do
    case " $reasons_before " in
      *" $_tok "*) ;;
      *) reasons_moved="$reasons_moved$_tok " ;;
    esac
  done
  if { [ "$rc_after" -gt "$rc_before" ] && [ "$rem_on_a" = 0 ]; } 2>/dev/null; then
    echo "unattested-device refused-op OK on a GENUINE second frame: author device attested to no member → A refuses (identity_unresolved $rc_before→$rc_after; all reasons: $reasons; row-on-a=$rem_on_a; strip-at-scoring=${strip_at_scoring:-<unreadable>})"
    return 0
  fi

  # WI-5064 FOLLOW-UP branch (2026-07-26, gate run 164022 — the FIRST run in which this
  # leg's probe actually reached frame a, because the ban-ordering fix landed). It then
  # failed with a BRAND-NEW signature: row-on-a=1 (the receipt was APPLIED, not refused)
  # with identity_unresolved 0→0. Before asserting "the refusal feature is broken", rule
  # out the precondition having been undone underneath us: the strip is verified once at
  # setup, then the leg sleeps 35s and polls up to 120s, and `pot_members` is a FEDERATED
  # table whose copy on b was never stripped — so a re-sync of B's row from b puts the
  # attestations back on a and makes the author device legitimately resolvable at apply
  # time. `strip-verified=yes` elsewhere in these messages refers ONLY to the t0 check.
  # This file has already been burned twice by exactly this shape of stale precondition
  # (WI-6046 setup-unverified; EI-18717083046734203 raw-INSERT authorship), so the
  # measurement goes in the verdict rather than in a reader's head.
  if [ "${strip_at_scoring:-0}" -gt 0 ] 2>/dev/null; then
    echo "attestation(unattested-device) FAIL — PRECONDITION UNDONE MID-LEG, so this leg CANNOT score the feature (and this is NOT evidence of a product defect): B's device_attestations were stripped on frame a and verified empty at setup, but at SCORING time a carries $strip_at_scoring attestation(s) again — pot_members re-federated from b, whose copy is never stripped, during this leg's ~155s probe window. The author device was therefore RESOLVABLE when the receipt applied, which makes a non-refusal the EXPECTED behaviour. Evidence: identity_unresolved $rc_before→$rc_after, row-on-a=$rem_on_a, probe-on-b=${probe_on_b:-<unmeasured>}, reasons that moved during THIS leg: ${reasons_moved:-<none>}. FIX DIRECTION: strip on BOTH frames (or suppress the b→a pot_members re-sync for B) for the duration of the leg, and re-assert emptiness immediately before the probe INSERT."
    return 1
  fi

  # EI-18717083046734203 (WI-6046 follow-up, 2026-07-26): the FAIL message below used to model
  # a BINARY (setup unverified => rig fault; setup verified => genuine feature non-refusal) —
  # but there is a THIRD branch this leg cannot rule out, and asserting "genuine non-refusal"
  # across it is CONFIDENTLY WRONG, worse than no guard at all. This leg's probe receipt is
  # fabricated via a raw drv_psql INSERT straight into p2p_receipts (line ~216), bypassing
  # emitP2pReceipt and the whole production emission path. When frame a's most-recently-bumped
  # refusal reason is responder_mismatch — NOT this leg's own target signal identity_unresolved
  # — that is the self-authoring invariant correctly refusing a fabricated-authorship probe, the
  # SAME already-diagnosed class as WI-5779 (done, 3-agent-verified) / EI-18662963598796485
  # (closed as its duplicate): an a<->b roster-convergence TIMING effect (WI-5763/WI-5715
  # family), environmental (host-CPU/event-loop contention under load), tracked live at WI-5639
  # — not a fresh product defect. Name it as that instead of asserting a feature bug, so the
  # next agent investigating this run doesn't chase a non-refusal that isn't there.
  # EI-18737225233571148 branch 1 — NOTHING MOVED. If no receipt-apply reason changed at all
  # while this leg ran, then A never refused this probe for ANY reason: the receipt never
  # reached the apply path. That is a materially different fault from "A failed to refuse", and
  # it is the single most useful thing this leg can report, so say it plainly and point at the
  # question it raises. Note LEG3 proves the raw-INSERT emission path itself works (it uses the
  # byte-identical drv_psql INSERT and its receipt does federate and get refused), so a silent
  # probe here is NOT explained by "raw INSERT bypasses emitP2pReceipt".
  if [ "$rem_on_a" = 0 ] && [ -z "${reasons_moved// /}" ]; then
    echo "attestation(unattested-device) FAIL — PROBE NEVER REACHED THE APPLY PATH: no receipt-apply refusal reason moved AT ALL while this leg ran (identity_unresolved $rc_before→$rc_after; full before-vector: ${reasons_before:-<empty>}; after: ${reasons_after:-<empty>}), row-on-a=$rem_on_a, probe-on-b=${probe_on_b:-<unmeasured>}, strip-verified=yes. A refused receipt ALWAYS bumps some reason, so this is not 'A failed to refuse' — the receipt never arrived at frame a's receipt-apply. Suspect the b→a link rather than the feature. FIRST CHECK — the known cause (WI-5064): did revocation_kcut run BEFORE this leg? SCN_RC[revocation_kcut]=${SCN_RC[revocation_kcut]:-<did-not-run>}. A value other than <did-not-run> means member B was BANNED earlier in this run, revocation is sticky/monotone, and B's receipts are blocked at A's admission — this leg's ordering invariant (it must run before revocation_kcut/90) has been violated, and this FAIL is that ordering bug rather than a product defect. Otherwise check whether receipt_id '$rid_rem' appears in frame a's logs at all (absent ⇒ never federated; present ⇒ federated then dropped/deduped), and whether any churn leg that actually ran this run (restart_durability/reconnect_catchup/replication_soak — check restart_settle_barrier's settle time) left federation unconverged. Do NOT read a stale responder_mismatch elsewhere in the counters as this leg's own refusal (EI-18737225233571148)."
    return 1
  fi

  # EI-18737225233571148 branch 2 — responder_mismatch ACTUALLY MOVED during this leg. Only now
  # is the self-authoring-invariant reading supported by evidence, because we are looking at a
  # refusal this leg's own probe caused rather than at whatever happened to be most recent.
  # Deliberately NOT phrased as "do not investigate": this leg has been red 3/3 with an
  # identical signature, and a blanket suppression on a deterministic failure is what let that
  # go unexamined for hours. State the hypothesis, name its escalation target, and let the
  # reader judge.
  if [ "$rem_on_a" = 0 ] && printf '%s' "$reasons_moved" | grep -q 'receipt-apply:responder_mismatch='; then
    echo "attestation(unattested-device) FAIL — this leg's probe WAS refused, but as responder_mismatch rather than identity_unresolved (identity_unresolved $rc_before→$rc_after; reasons that moved during THIS leg: $reasons_moved; top-3 by recency: $reasons), row-on-a=$rem_on_a, probe-on-b=${probe_on_b:-<unmeasured>}, strip-verified=yes. Reading: the strip did not make the author device unresolvable, so A resolved it to a DIFFERENT user than the probe's claimed responder — the self-authoring invariant firing ahead of the identity check (product order is no_author_device → identity_unresolved → responder_mismatch, see sync/hyperbee/projections/p2p-receipts.ts). Candidate causes: the device→user map was still cached (PAPERCUSP_COMMS_TIER_CACHE_MS, this leg sleeps 35s against a 30s default), or the strip targeted a member row that is not the one backing the author device. Related class: WI-5779 / EI-18662963598796485, SLA tracked at WI-5639 — but a persistent, byte-identical recurrence is a defect to investigate, not an environmental write-off. CAVEAT, read before trusting this line: the diff narrows attribution to this leg's WINDOW, not to this leg's PROBE. An earlier leg's receipt being retried inside that window (LEG3's was retried ~8x across 13min in run 133957) still lands here. To rule that out, check frame a's serve.log for 'REFUSED inbound receipt op (responder_mismatch)' and compare the logged responder= against THIS probe's responder (${b_gh_id:-?}); a different id means it was not this probe (EI-18737225233571148)."
    return 1
  fi

  # Reaching here with rem_on_a>0 means the probe receipt was APPLIED on frame a, and the
  # strip was STILL empty at scoring time (the branch above already caught re-federation).
  # That combination is the first genuinely feature-level signature this leg has ever
  # produced — say so, with the two facts that make it one, instead of the old flat line.
  if [ "${rem_on_a:-0}" -gt 0 ] 2>/dev/null; then
    echo "attestation(unattested-device) FAIL — APPLIED, NOT REFUSED, with the precondition intact at scoring time: the probe receipt EXISTS on frame a (row-on-a=$rem_on_a) while identity_unresolved did not move ($rc_before→$rc_after) AND B still had ZERO device_attestations on a when scored (strip-at-scoring=${strip_at_scoring:-<unreadable>}). This is the first signature from this leg that is not explained by the ban-ordering bug (WI-5064, fixed: the probe now federates b→a at all), by a re-federated precondition, or by a never-emitted probe (probe-on-b=${probe_on_b:-<unmeasured>}). Candidate readings, in order: (1) receipt-apply does not check author-device→member attestation on this path, so an unattested device's op is accepted — the product defect this leg exists to catch; (2) the raw-INSERT probe (bypasses emitP2pReceipt) federates as a plain row mirror that skips the receipt-apply projection entirely, in which case the leg is measuring the wrong path and needs to emit through the product API. DISCRIMINATOR: check frame a's serve.log for a receipt-apply entry naming '$rid_rem' — present ⇒ reading (1); absent ⇒ reading (2). Reasons that moved during THIS leg: ${reasons_moved:-<none>}; top-3 by recency: $reasons"
    return 1
  fi
  echo "attestation(unattested-device) FAIL — across the container boundary: identity_unresolved $rc_before→$rc_after, row-on-a=$rem_on_a, probe-on-b=${probe_on_b:-<unmeasured>}, strip-verified=yes, strip-at-scoring=${strip_at_scoring:-<unreadable>}, all reasons: $reasons"
  return 1
}
# Restore ONE frame's device_attestations, bounded-retrying until the read-back confirms it.
# Echoes the final read-back count (empty ⇒ unreadable). The single-shot write this replaces
# was tolerable while the leg ran at 89 with only revocation_kcut(90) downstream; at 79 a lost
# restore would silently strand FOUR later legs against a device-less member, so the write now
# has to be verified rather than fired and hoped for. Still best-effort by design — a failed
# restore warns, it never converts this leg's own verdict into a FAIL.
#
# ⚠ RESULT COMES BACK IN THE GLOBAL `_ATT_RESTORE_BACK`, NOT ON STDOUT — deliberately, so the
# caller never has to wrap it in `$(...)`. A command substitution forks a SUBSHELL, and this
# function's whole job is the WRITE side: any bookkeeping the write touches (notably the
# b9-attestation-precondition selftest's per-frame `WROTE[]` stub) would be discarded with that
# subshell, leaving "did we actually write frame a?" unobservable. The selftest's own header
# already documents that trap for the wrapper; the same rule binds every helper it calls.
_ATT_RESTORE_BACK=''
_att_restore_one() {
  local frame="$1" saved="$2" i
  _ATT_RESTORE_BACK=''
  for i in 1 2 3; do
    drv_psql "$frame" "UPDATE harness_shared.pot_members SET device_attestations=\$att\$${saved}\$att\$::jsonb WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=${_ATT_SAVED_GH_ID};" >/dev/null 2>&1
    _ATT_RESTORE_BACK="$(drv_psql "$frame" "SELECT COALESCE(jsonb_array_length(device_attestations),0) FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' AND github_user_id=${_ATT_SAVED_GH_ID};" 2>/dev/null | tr -d '[:space:]')"
    { [ "${_ATT_RESTORE_BACK:-0}" -gt 0 ]; } 2>/dev/null && return 0
    [ "$i" = 3 ] || sleep 2
  done
  return 0
}

# WI-5064 RESTORE HELPER. Puts B's device_attestations back on frame A after the leg has taken
# its measurements. Dollar-quoted so the stored JSON needs no escaping. Best-effort by design:
# a failed restore must NOT turn this leg's real verdict into a false FAIL — it warns instead,
# and revocation_kcut(90) will then fail loudly on its own with a message that names the cause.
_att_restore_b_devices() {
  # Restore frame B first when we stripped it (WI-5064 follow-up): b is the replica that
  # legitimately owns B's own member row, so putting it back there lets normal federation
  # re-converge a even if a's direct UPDATE below were to lose an LWW race.
  if [ "${_ATT_SAVED_B_OK:-0}" = 1 ]; then
    local back_b
    _att_restore_one b "${_ATT_SAVED_ROW_B}"; back_b="$_ATT_RESTORE_BACK"
    if [ "${back_b:-0}" -gt 0 ] 2>/dev/null; then
      echo "  · attestation(unattested-device): restored B's device_attestations on frame b ($back_b attestation(s))"
    else
      echo "  · attestation(unattested-device): WARN — restore of B's device_attestations on frame b did NOT take after 3 attempts (read back '${back_b:-<empty>}'); B's own replica is left device-less, which can affect EVERY leg after this one (79) — restart_durability/80, reconnect_catchup/85, replication_soak/87 and revocation_kcut/90"
    fi
    _ATT_SAVED_B_OK=0
  fi
  [ "${_ATT_SAVED_OK:-0}" = 1 ] || return 0
  local back
  _att_restore_one a "${_ATT_SAVED_ROW}"; back="$_ATT_RESTORE_BACK"
  if [ "${back:-0}" -gt 0 ] 2>/dev/null; then
    echo "  · attestation(unattested-device): restored B's device_attestations on frame a ($back attestation(s)) — revocation_kcut(90) needs them to resolve B's pubkeys"
  else
    echo "  · attestation(unattested-device): WARN — restore of B's device_attestations did NOT take (read back '${back:-<empty>}'). revocation_kcut(90) will likely fail with 'target contributor has no known devices'; that is THIS leg's fault, not a revocation regression."
  fi
  _ATT_SAVED_OK=0
  return 0
}

# WI-5064 WRAPPER — the ONLY entry point the matrix registers. The core returns from a dozen
# places (setup-unverified, probe-unmeasured, four scoring branches); restoring inline at each
# would silently rot the moment someone adds a seventh. Wrapping guarantees the restore runs on
# EVERY path, including one added later, while preserving the core's exact return code.
scn_attestation_unattested_device() {
  local rc=0
  _scn_attestation_unattested_device_core || rc=$?
  _att_restore_b_devices || true
  return "$rc"
}
matrix_register attestation_unattested_device 79 "unattested-device refused-op witness, on a GENUINE 2nd frame (P-413/WI-5779, TERMINAL — must precede the churn legs/80+ AND revocation_kcut/90)" scn_attestation_unattested_device
