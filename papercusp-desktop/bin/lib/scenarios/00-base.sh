#!/usr/bin/env bash
# 00-base.sh — Brief 13 REFERENCE scenarios (content / plan-part / coord, A↔B).
#
# Sourced by bin/deb-hetzner-matrix.sh. These mirror exactly what the 2-frame base
# (deb-hetzner-federation.sh) already proves, so they give the matrix immediate teeth
# AND serve as copy-templates for the brief 3-8 scenario authors. See README.md for
# the full contract. Each scn_* returns 0=PASS / non-0=FAIL and echoes one result line.
#
# NOTE: not executable on its own — it relies on the matrix having sourced
# federation-asserts.sh + deb-hetzner-rig.sh and populated FRAME_*/FED_*/RIG_HIVE_*.

# ── content A↔B: a feature INSERTed origin='local' lands origin='remote' both ways ─
scn_content_bidir() {
  local oslug="${FRAME_MEMBER_SLUG[a]}" mslug="${FRAME_MEMBER_SLUG[b]}" rid="$MATRIX_RUN_ID"
  local ab ba
  ab="$(fed_hive_merge_probe a b "$oslug" "F-A2B-$rid" 60 || true)"
  [ "${ab%% *}" = 1 ] || { echo "content A→B FAIL (probe=$ab)"; return 1; }
  ba="$(fed_hive_merge_probe b a "$mslug" "F-B2A-$rid" 60 || true)"
  [ "${ba%% *}" = 1 ] || { echo "content B→A FAIL (probe=$ba)"; return 1; }
  echo "content bidir OK (A→B landed='${ab#* }', B→A landed='${ba#* }')"
}
matrix_register content_bidir 10 "feature content A↔B" scn_content_bidir

# ── plan-part A↔B: per-part plan federation (flag papercusp-plan-part-federation) ──
scn_planpart_bidir() {
  local oslug="${FRAME_MEMBER_SLUG[a]}" mslug="${FRAME_MEMBER_SLUG[b]}"
  local ab ba
  ab="$(fed_plan_part_merge_assert a b "$oslug" 60 || true)"
  # WI-5768 (scenario-assert integrity audit): fed_plan_part_merge_assert's own
  # contract (federation-asserts.sh) is explicit — "skip" (the harness_plan_parts
  # table absent, a pre-mig-270/271 .deb) means N/A, NOT a failure; a caller that
  # treats it like any other non-1 value CAN-NEVER-PASS against such a .deb (it
  # would report FAIL forever for a condition the scenario itself can't avoid).
  # Mirror the correct handling already in deb-hetzner-federation.sh's pp_label.
  case "$ab" in 1|skip) : ;; *) echo "plan-part A→B FAIL (probe=$ab)"; return 1 ;; esac
  ba="$(fed_plan_part_merge_assert b a "$mslug" 60 || true)"
  case "$ba" in 1|skip) : ;; *) echo "plan-part B→A FAIL (probe=$ba)"; return 1 ;; esac
  if [ "$ab" = skip ] || [ "$ba" = skip ]; then
    echo "plan-part bidir OK (SKIPPED — harness_plan_parts absent, this .deb predates the plan-parts migration, EI-505)"
  else
    echo "plan-part bidir OK (item:P-001 both directions, origin=remote)"
  fi
}
matrix_register planpart_bidir 20 "plan-part A↔B" scn_planpart_bidir

# ── coord A↔B: the coord_event_log feed federates over the same peer-log wire ──────
scn_coord_bidir() {
  local oslug="${FRAME_MEMBER_SLUG[a]}" mslug="${FRAME_MEMBER_SLUG[b]}" rid="$MATRIX_RUN_ID"
  local ab ba
  ab="$(fed_coord_merge_probe a b "$oslug" "A2B-$rid" 60 || true)"
  [ "$ab" = 1 ] || { echo "coord A→B FAIL (probe=$ab)"; return 1; }
  ba="$(fed_coord_merge_probe b a "$mslug" "B2A-$rid" 60 || true)"
  [ "$ba" = 1 ] || { echo "coord B→A FAIL (probe=$ba)"; return 1; }
  echo "coord comms bidir OK (coord_event_log both directions, origin=remote)"
}
matrix_register coord_bidir 30 "coord comms A↔B" scn_coord_bidir
