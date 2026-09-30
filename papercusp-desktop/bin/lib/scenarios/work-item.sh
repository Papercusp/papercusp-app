#!/usr/bin/env bash
# work-item.sh — P-014 green-acceptance matrix scenario: work_item (engineer_issue)
# federation (shared-hive-p2p-release-readiness-2026-07-03; su-17c98's sign bar —
# the 4th kind alongside fleet_directory/seat_offer/spawn_request).
#
# What it proves: creating a work_item on the OWNER frame (a) through the real
# product path (MCP work_items:create → _create-core → the engineer_issues
# fanoutForObject federation registration, register-all.ts 'engineer-issues')
# rides the hello-world HARNESS peer-log and MATERIALIZES on the member frame (b)
# as an origin='remote' row in harness_shared.engineer_issues (the P-010-unified
# work_items base table). The member-side projection
# (sync/hyperbee/projections/engineer-issues.ts) applies the remote op with
# origin='remote' AFTER the LWW/echo-guard — presence on b IS the federation
# assert; a raw psql INSERT cannot fake the provenance columns.
#
# This is the HARNESS-log (9ef56d55) counterpart to fleet_directory's
# HIVE-HOME-log (a3d05d5e) leg — both hit the same WI-183 connected_never_replicated
# ATTACH gap pre-fix, so this scenario is RED now and expected GREEN once
# su-16e4c's attach fix lands. Composes with fleet-directory.sh (55): reuses its
# _fdir_mcp_call MCP driver (sourced before any scenario runs) and a bounded
# engineer_issues poll. NON-INVASIVE (one throwaway work_item, title suffixed with
# MATRIX_RUN_ID). Order 58: right after the P-009 work-distribution block (55-57).

# Bounded engineer_issues row poll: $1=inst $2=predicate → echoes 1 (present)/0.
# 120 tries × 2s = 4min: covers the ~2.8min initial replicator attach (measured,
# run m1783165541) that a 90s window false-REDs on.
_wi_row_present() {
  local inst="$1" pred="$2" tries="${3:-120}" n
  for _ in $(seq 1 "$tries"); do
    n="$(drv_psql "$inst" "SELECT count(*) FROM harness_shared.engineer_issues WHERE $pred;" 2>/dev/null | tr -d '[:space:]')"
    if [ "$n" != "0" ] && [ -n "$n" ]; then echo 1; return; fi
    sleep 2
  done
  echo 0
}

scn_work_item() {
  # _fdir_mcp_call lives in fleet-directory.sh — both files are sourced by the
  # runner before any scenario executes, so this reuse is load-order-safe.
  if ! declare -f _fdir_mcp_call >/dev/null; then
    echo "work-item FAIL — _fdir_mcp_call missing (fleet-directory.sh not loaded)"
    return 1
  fi

  local title="mx-wi-${MATRIX_RUN_ID}" out
  title="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]')"

  # 1. OWNER (a): create a work_item through the real product path. The create's
  #    engineer_issues fanout registers it for federation best-effort (the publish
  #    is fire-and-forget behind the synchronous store write; polled below).
  out="$(_fdir_mcp_call a 'work_items:create' "{\"kind\":\"task\",\"title\":\"$title\",\"harness\":\"hello-world\",\"summary\":\"matrix work-item federation probe $MATRIX_RUN_ID\"}")"
  if printf '%s' "$out" | grep -q 'FDIR_NO_TOKEN'; then
    echo "work-item FAIL — frame a has no superuser token for the MCP driver"
    return 1
  fi
  if printf '%s' "$out" | tr -d '\\' | grep -Eq '"isError" *: *true|MCP_ERROR'; then
    echo "work-item FAIL — work_items:create on frame a errored: $(printf '%s' "$out" | tail -c 300)"
    return 1
  fi

  # 2. The row must exist LOCALLY on a (the author leg — catches a silent create
  #    skip: hive-scope gate refusal, no gh identity, keychain fault).
  if [ "$(_wi_row_present a "title='$title'")" != 1 ]; then
    echo "work-item FAIL — no local engineer_issues row on frame a for $title (create leg skipped/errored; check hive-scope gate / identity / keychain on a)"
    return 1
  fi

  # 3. The row must MATERIALIZE on b as origin='remote' — the cross-node,
  #    sig-verified leg (the projection refuses anything unverified).
  if [ "$(_wi_row_present b "title='$title' AND origin='remote'")" != 1 ]; then
    echo "work-item FAIL — work_item $title never materialized origin='remote' on frame b (authored on a but not replicated/applied on b — WI-183 reverse-leg)"
    return 1
  fi

  # 4. Content sanity on b: a real workspace-scoped issue with provenance — a live
  #    remote row carrying an issue_id + created_by (a fake INSERT lacks both from
  #    the verified op). P-014 hardened bar: author_pubkey must be the
  #    receiver-stamped 64-hex substrate LOG key (unforgeable, D-006) — kills a
  #    masking-importer false-green.
  local ok
  ok="$(drv_psql b "SELECT count(*) FROM harness_shared.engineer_issues WHERE title='$title' AND origin='remote' AND issue_id IS NOT NULL AND created_by IS NOT NULL AND author_pubkey ~ '^[0-9a-f]{64}\$';" 2>/dev/null | tr -d '[:space:]')"
  if [ "$ok" = "0" ] || [ -z "$ok" ]; then
    echo "work-item FAIL — remote work_item on b is malformed/unattributed (expected a live row with issue_id + created_by + 64-hex substrate author_pubkey)"
    return 1
  fi

  echo "work-item federated a→b (work_items:create authored on a; engineer_issues remote apply origin='remote' for $title on b — the harness-log work-queue reverse-leg)"
  return 0
}

matrix_register work_item 58 "work_item (engineer_issue) federation (P-014 green bar)" scn_work_item
