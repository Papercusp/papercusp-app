#!/usr/bin/env bash
# scenario-coord-p008-custody.sh — the RIG-CUSTODY legs of P-008:
# reconnect / catch-up / restart behavior, against the REAL tower <-> Mac VM rig.
#
# THIRD AND LAST SCENARIO IN THE P-008 SET
# ----------------------------------------
#   scenario-coord-control-plane.sh    CC-1..CC-5  bidirectional, handoff/escalation, scope negatives
#   scenario-coord-p008-remainder.sh   CR-1..CR-4  conversation visibility, directed reply, trust negative
#   scenario-coord-p008-custody.sh     CD-1..CD-7  reconnect / catch-up / restart   ← this file
#
# A COMPLETE P-008 witness is all three green. The split is by CUSTODY, per D-028
# (plan p2p-coordination-public-release-2026-08-26): CC/CR need no daemon lifecycle
# event and run any time; the legs HERE bootout and kickstart com.papercusp.server
# on the VM, so they need the rig custodian's release.
#
# WHY NOT PORT bin/deb-hetzner-reconnect.sh INSTEAD
# -------------------------------------------------
# That scenario is the Brief-4 proof for the HETZNER FRAME rig. Its assertions are
# right, but every seam under them is frame-shaped: rig_kill_sidecar/rig_restart_sidecar
# drive `runuser -u pcusp` + pkill 'serve.mjs' + a SysV shm reap, rig_write_content /
# rig_read_content / rig_read_roster speak harness_features_consolidated through
# ${FRAME_IP[...]}, and FRAME_MEMBER_SLUG is populated by the matrix's own provision.
# Sourcing it here would silently retarget frames that do not exist on this rig — the
# exact failure the load-bearing source-order note in the CC/CR drivers warns about.
#
# So this file asserts THE SAME PROPERTIES over the seams already PROVEN on this rig
# by CC-1..CC-5 and CR-1..CR-4: drv_psql plus harness_shared.coord_event_log, whose
# federation contract is declared on the column itself ("NULL = operator-scope/
# workspace-global (stays local); harness-scoped rows federate over that harness's
# peer-log") and whose table is in OUTBOX_PRIORITY_TABLES
# (packages/operator-core/lib/sync/hyperbee/outbox-drain.ts).
#
# ⚠ INVASIVE — THIS IS THE ONE THAT TOUCHES THE DAEMON.
# CD-1 boots out system/com.papercusp.server on the VM; CD-2 kickstarts it. It does
# NOT install, deploy, or wipe anything: no app swap, no pgdata removal, no plist
# edit. The VM comes back on the SAME pinned build it went down on.
#
# EVERY NEGATIVE/ABSENCE ASSERTION CARRIES A POSITIVE CONTROL.
# A broken positive leg cries wolf; a broken negative leg goes QUIET and reports a
# boundary holding that was never tested. CD-1 asserts the VM is UNREACHABLE — which
# is trivially true of a VM that was already down, of a bad ssh target, of a typo in
# the DSN. So CD-1 proves reachability FIRST and only then takes it away.
#
# CONTRACT (same as the CC/CR scenarios; the driver supplies all of it):
#   drv_psql <inst> <sql>    the SQL seam
#   RIG_HIVE_ID              pot_home_slug
#   FRAME_MEMBER_SLUG[...]   harness slug per instance
#   cd_vm_down / cd_vm_up    VM daemon lifecycle  (driver supplies — see the driver)
#   cd_vm_healthy            VM readiness probe   (driver supplies)
#   scenario_coord_p008_custody a b  → prints CD-* PASS/FAIL; returns 0 iff all pass

# ── shared helpers ────────────────────────────────────────────────────────────
# _cd_ws / _cd_insert mirror _cr_ws / _cr_insert from the remainder scenario. They
# are redefined rather than sourced so this file composes with a driver that loads
# only this scenario, and so a change here can never alter what a green CR run meant.

# Resolve a REAL workspace_id for an instance, or fail loudly (D-050/WI-5399): never
# silently write under 'default', because a probe that writes to the wrong workspace
# passes or fails for reasons that have nothing to do with federation.
_cd_ws() {
  local inst="$1" ws=""
  if [ -n "${RIG_HIVE_ID:-}" ]; then
    ws="$(drv_psql "$inst" "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  fi
  [ -n "$ws" ] || ws="$(drv_psql "$inst" "SELECT workspace_id FROM harness_shared.pot_members WHERE coalesce(origin,'local')='local' ORDER BY joined_at LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$ws" ] || return 1
  printf '%s' "$ws"
}

# Run a probe's own INSERT and REFUSE to continue if the write itself was rejected.
# A probe whose SETUP failure is indistinguishable from its FINDING is the false-verdict
# class this rig exists to refuse (measured during CR authoring: a rejected INSERT
# reported as "did NOT federate", which reads exactly like a product defect).
# Both signals are checked — exit status AND an ERROR: line — because the vm leg
# crosses ssh, where a psql exit code can be masked.
_cd_insert() {
  local inst="$1" label="$2" sql="$3" out st
  out="$(drv_psql "$inst" "$sql" 2>&1)"; st=$?
  if [ "$st" -ne 0 ] || printf '%s' "$out" | grep -q '^ERROR:'; then
    echo "$label SETUP FAIL — this probe's own INSERT was REJECTED on $inst, so nothing below is a federation verdict:"
    printf '%s\n' "$out" | grep -E '^(ERROR|DETAIL):' | head -3 | sed 's/^/    /'
    return 1
  fi
  return 0
}

# Author one coord row on <inst>. Harness-scoped, so it is a FEDERATING row.
_cd_write() {
  local inst="$1" label="$2" ws="$3" slug="$4" mid="$5" text="$6"
  _cd_insert "$inst" "$label" "INSERT INTO harness_shared.coord_event_log
      (workspace_id,surface,writer_key,msg_id,body,harness_slug,origin)
    VALUES ('$ws','messages','ccp-probe','$mid',
      '{\"kind\":\"message\",\"text\":\"$text\"}'::jsonb,'$slug','local');"
}

# Poll <inst> until <mid> is present with origin='remote'. Echoes 1/0.
_cd_arrives() {
  local inst="$1" mid="$2" tries="${3:-40}" i row
  for i in $(seq 1 "$tries"); do
    row="$(drv_psql "$inst" "SELECT msg_id FROM harness_shared.coord_event_log WHERE msg_id='$mid' AND origin='remote' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$row" ] && { echo 1; return 0; }
    sleep 3
  done
  echo 0; return 1
}

# Exactly-one-row assertion (no duplicate re-fold on the cold re-open).
_cd_single() {
  local inst="$1" mid="$2" label="$3" n
  n="$(drv_psql "$inst" "SELECT count(*) FROM harness_shared.coord_event_log WHERE msg_id='$mid';" 2>/dev/null | tr -d '[:space:]')"
  if [ "${n:-0}" = "1" ]; then echo "    ✓ no-dup: $label present exactly once on $inst"; return 0; fi
  echo "    ✗ NO-DUP FAIL: $label has '${n:-?}' rows on $inst (expected 1)"; return 1
}

# ── P-504 storm tripwire ──────────────────────────────────────────────────────
# A VM (re)join is EXACTLY what used to trigger the tower federation storm that
# P-504 (= WI-2141418, done) root-caused and fixed: ~2k announce_admitted/min
# re-admissions of already-admitted same-hive members, a one-shot re-capture of
# 142k engineer_issues rows into substrate_outbox, and a ~76/min pot_epoch_keys /
# pot_members re-grant churn. The strict FIFO drain then queued every coordination
# row hours behind the bulk.
#
# So this run is not merely "safe to do now" — it is the live VALIDATION P-504
# earned. The tripwire samples the tower outbox depth BEFORE the bootout and again
# after the rejoin settles. A storm shows up as a large POSITIVE delta.
_cd_outbox_depth() {
  drv_psql "$1" "SELECT count(*) FROM harness_shared.substrate_outbox;" 2>/dev/null | tr -d '[:space:]'
}

scenario_coord_p008_custody() {
  local a="${1:-tower}" b="${2:-vm}"
  local ts; ts="$(date +%s)"
  local rc=0
  local slug_a="${FRAME_MEMBER_SLUG[$a]:-papercusp}" slug_b="${FRAME_MEMBER_SLUG[$b]:-papercusp}"
  local ws_a ws_b

  echo "═══ P-008 RIG-CUSTODY legs (CD-1..CD-7) — owner=$a member=$b ═══"
  echo "    INVASIVE: this boots out and kickstarts com.papercusp.server on $b."

  ws_a="$(_cd_ws "$a")" || { echo "CD-* SETUP FAIL — could not resolve a real workspace_id on $a (D-050/WI-5399 class)"; return 2; }
  ws_b="$(_cd_ws "$b")" || { echo "CD-* SETUP FAIL — could not resolve a real workspace_id on $b (D-050/WI-5399 class)"; return 2; }

  local BASE="ccp-cd-base-$ts"
  local OFF1="ccp-cd-off1-$ts" OFF2="ccp-cd-off2-$ts" OFF3="ccp-cd-off3-$ts"
  local VMOWN="ccp-cd-vmown-$ts"
  local POST="ccp-cd-post-$ts"

  # ── storm tripwire: BEFORE sample ───────────────────────────────────────────
  local depth_before; depth_before="$(_cd_outbox_depth "$a")"
  echo "    P-504 tripwire: tower substrate_outbox depth BEFORE = ${depth_before:-?}"

  # ── CD-0 baseline: the link is healthy BEFORE the partition ─────────────────
  # Without this, a catch-up "pass" could just be a link that was never broken, and
  # a catch-up "fail" could be a link that was already dead before we touched it.
  echo "[0] baseline — prove the link works BEFORE taking anything down"
  if ! _cd_write "$a" "CD-0" "$ws_a" "$slug_a" "$BASE" "[ccp-probe] P-008 custody baseline"; then
    echo "CD-0 FAIL — could not author the baseline row; nothing below would be a custody verdict"; return 2
  fi
  if [ "$(_cd_arrives "$b" "$BASE")" = 1 ]; then
    echo "CD-0 PASS — baseline row federated $a→$b BEFORE the partition (link confirmed healthy)"
  else
    echo "CD-0 FAIL — the link was ALREADY not federating before any daemon action; aborting rather than reporting a custody verdict"
    return 2
  fi

  # ── CD-6 setup: a row the VM ITSELF authored, BEFORE its restart ─────────────
  # Read back after the restart to prove the member's OWN durable state survived a
  # cold re-open, and that its re-open did not RE-EMIT it as a duplicate on the tower.
  if ! _cd_write "$b" "CD-6" "$ws_b" "$slug_b" "$VMOWN" "[ccp-probe] P-008 vm-authored pre-restart"; then
    echo "CD-6 SETUP FAIL — could not author the VM-side row before the restart"; rc=1
  else
    [ "$(_cd_arrives "$a" "$VMOWN")" = 1 ] \
      && echo "    ✓ CD-6 setup: VM-authored row reached the tower before the restart" \
      || { echo "    ✗ CD-6 SETUP FAIL: VM-authored row never reached the tower pre-restart"; rc=1; }
  fi

  # ── CD-1: the partition must be REAL, with a positive control ────────────────
  echo "[1] take $b OFFLINE — bootout com.papercusp.server (no install, no pgdata wipe)"
  if ! drv_psql "$b" "SELECT 1;" >/dev/null 2>&1; then
    echo "CD-1 SETUP FAIL — $b was ALREADY unreachable before the bootout, so an 'offline' assertion would be vacuous"
    return 2
  fi
  echo "    ✓ positive control: $b was reachable immediately before the bootout"

  # A bootout that did not actually unload the job is a SETUP failure: the later
  # bootstrap would race the half-torn-down job and the VM would not come back.
  cd_vm_down || { echo "CD-1 SETUP FAIL — the job did not unload cleanly; refusing to proceed into a bootstrap race"; cd_vm_up || true; return 2; }

  local down=0 i
  for i in 1 2 3 4 5 6 7 8; do
    if ! drv_psql "$b" "SELECT 1;" >/dev/null 2>&1; then down=1; break; fi
    sleep 2
  done
  if [ "$down" = 1 ]; then
    echo "CD-1 PASS — $b is genuinely offline (operator/PG unreachable), so any later arrival is real CATCH-UP, not live delivery"
  else
    echo "CD-1 FAIL — $b still answering after bootout; a live delivery would make every catch-up assertion below vacuous"
    cd_vm_up || true
    return 1
  fi

  # ── CD-2 setup: author offline-window ops while the member is DOWN ───────────
  echo "[2] author offline-window ops on $a while $b is down"
  local m
  for m in "$OFF1" "$OFF2" "$OFF3"; do
    _cd_write "$a" "CD-2" "$ws_a" "$slug_a" "$m" "[ccp-probe] P-008 offline-window op" || rc=1
  done
  local owncount
  owncount="$(drv_psql "$a" "SELECT count(*) FROM harness_shared.coord_event_log WHERE msg_id IN ('$OFF1','$OFF2','$OFF3') AND origin='local';" 2>/dev/null | tr -d '[:space:]')"
  if [ "${owncount:-0}" = "3" ]; then
    echo "    ✓ 3 offline-window ops authored locally on $a while $b was down"
  else
    echo "    ✗ CD-2 SETUP FAIL: $a has '${owncount:-?}'/3 offline-window ops local"; rc=1
  fi

  # ── bring the member BACK ───────────────────────────────────────────────────
  echo "[3] bring $b BACK — kickstart → boot re-reads state → swarm rejoin → CATCH-UP"
  # ⚠ A FAILED BRING-BACK IS A SETUP FAILURE, NOT A CD VERDICT.
  # If $b never comes back, NO catch-up probe was exercised — so reporting "CD-2 FAIL"
  # would describe a product defect that was never tested. Measured 2026-09-02T19:43Z:
  # a bootout/bootstrap race left the daemon unloaded and this printed "CD-2 FAIL — vm
  # did not come back", which reads as a catch-up failure. Exit 2 (no verdict), never 1.
  if ! cd_vm_up; then
    echo "CD-* SETUP FAIL — could not bring $b back up; NO catch-up probe ran, so this is NOT a federation verdict."
    echo "    The rig may be LEFT DOWN. Restore it before anything else:"
    echo "      ssh <vm> 'sudo -n launchctl bootstrap system /Library/LaunchDaemons/com.papercusp.server.plist'"
    return 2
  fi
  if cd_vm_healthy 240; then
    echo "    ✓ $b came back healthy after the bring-back"
  else
    echo "CD-* SETUP FAIL — $b did not become healthy in time. NO catch-up probe ran, so this is NOT a federation verdict."
    echo "    Check the VM before re-running; do not re-run blind."
    return 2
  fi

  # ── CD-2: catch-up of every offline-window op ───────────────────────────────
  local caught=0
  for m in "$OFF1" "$OFF2" "$OFF3"; do
    if [ "$(_cd_arrives "$b" "$m" 60)" = 1 ]; then caught=$((caught + 1)); else
      echo "    ✗ catch-up MISS: $m never arrived on $b after reconnect"; fi
  done
  if [ "$caught" = 3 ]; then
    echo "CD-2 PASS — all 3 ops written during the offline window CAUGHT UP on $b after reconnect (origin=remote)"
  else
    echo "CD-2 FAIL — only $caught/3 offline-window ops caught up on $b"; rc=1
  fi

  # ── CD-3: NO LOSS — the pre-partition baseline survived the member restart ───
  local base_post
  base_post="$(drv_psql "$b" "SELECT msg_id FROM harness_shared.coord_event_log WHERE msg_id='$BASE' AND origin='remote' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$base_post" ]; then
    echo "CD-3 PASS — no loss: the pre-partition baseline row is still on $b after the restart"
  else
    echo "CD-3 FAIL — the pre-partition baseline row is MISSING on $b after the restart (cold re-open lost durable state)"; rc=1
  fi

  # ── CD-4: NO DUP — the cold re-open re-fold must not double any row ──────────
  echo "[4] no-dup after cold re-open"
  _cd_single "$b" "$BASE" "baseline" || rc=1
  _cd_single "$b" "$OFF1" "offline-1" || rc=1
  _cd_single "$b" "$OFF2" "offline-2" || rc=1
  _cd_single "$b" "$OFF3" "offline-3" || rc=1
  if [ "$rc" = 0 ]; then echo "CD-4 PASS — every row present exactly once on $b (no duplicate re-emission on re-open)"
  else echo "CD-4 FAIL — see the ✗ no-dup lines above"; fi

  # ── CD-5: LINK HEALED — ongoing federation resumed, not a one-time drain ─────
  echo "[5] link-healed — a NEW write after reconnect must still federate"
  if ! _cd_write "$a" "CD-5" "$ws_a" "$slug_a" "$POST" "[ccp-probe] P-008 post-reconnect"; then
    rc=1
  elif [ "$(_cd_arrives "$b" "$POST" 60)" = 1 ]; then
    echo "CD-5 PASS — a NEW $a→$b write federated after reconnect (ongoing federation resumed, not just a catch-up drain)"
    _cd_single "$b" "$POST" "post-reconnect" || rc=1
  else
    echo "CD-5 FAIL — federation did not resume after reconnect: the catch-up drained but the live link stayed dead"; rc=1
  fi

  # ── CD-6: RESTART DURABILITY of the member's OWN authored row ────────────────
  echo "[6] restart durability — the member's OWN pre-restart row"
  local vmown_post
  vmown_post="$(drv_psql "$b" "SELECT msg_id FROM harness_shared.coord_event_log WHERE msg_id='$VMOWN' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$vmown_post" ]; then
    echo "    ✓ the VM's own pre-restart row survived its cold restart"
    _cd_single "$a" "$VMOWN" "vm-authored (tower side)" || rc=1
    _cd_single "$b" "$VMOWN" "vm-authored (vm side)" || rc=1
    echo "CD-6 PASS — restart durability: the member's own row survived, and its re-open re-emitted nothing"
  else
    echo "CD-6 FAIL — the VM's own pre-restart row is GONE after its restart (durable loss)"; rc=1
  fi

  # ── CD-7: P-504 storm tripwire — AFTER sample ───────────────────────────────
  echo "[7] P-504 recurrence guard — did the rejoin re-trigger the federation storm?"
  sleep 20
  local depth_after delta
  depth_after="$(_cd_outbox_depth "$a")"
  if [ -z "${depth_before:-}" ] || [ -z "${depth_after:-}" ]; then
    echo "CD-7 INCONCLUSIVE — could not sample tower substrate_outbox depth on both sides (before='${depth_before:-?}' after='${depth_after:-?}'). This is NOT a pass."
    rc=1
  else
    delta=$((depth_after - depth_before))
    echo "    tower substrate_outbox depth: before=$depth_before after=$depth_after delta=$delta"
    # The storm P-504 fixed re-captured 142k rows in one shot. A healthy rejoin moves
    # this by the handful of rows this scenario itself authored. 5000 sits far above
    # the probe's own footprint and far below the failure it is watching for.
    if [ "$delta" -lt 5000 ]; then
      echo "CD-7 PASS — no join-storm recurrence: outbox grew by $delta rows across the rejoin (P-504's fix holds on a real VM rejoin)"
    else
      echo "CD-7 FAIL — JOIN STORM RECURRENCE: outbox grew by $delta rows across the rejoin. This is the P-504 signature; do NOT prune the outbox and do NOT restart bg-host to 'reset' it."
      rc=1
    fi
  fi

  echo "─────────────────────────────────────────────────────────────────────────"
  if [ "$rc" = 0 ]; then
    echo "OVERALL: PASS — P-008 rig-custody legs green (partition real, full catch-up, no loss, no dup, link resumed, member restart durable, no P-504 storm)"
    return 0
  fi
  echo "OVERALL: INCOMPLETE — one or more custody legs failed (see ✗ / FAIL lines above)"
  return 1
}
