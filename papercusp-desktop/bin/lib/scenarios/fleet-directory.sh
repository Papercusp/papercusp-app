#!/usr/bin/env bash
# fleet-directory.sh — WI-2006 matrix scenario: fleet-directory card federation
# (p2p-work-distribution P-101/D-006; the sole genuinely CROSS-NODE
# work-distribution surface — every other drill leg is per-machine by design).
#
# What it proves: creating a fleet on the OWNER frame (a) through the real
# product path (MCP fleet:create → agent-fleets-store → the WI-2006 publish leg
# p2p/fleet-directory-publish.ts) authors an OWNER-SIGNED directory record that
# rides the hive peer-log and MATERIALIZES on the member frame (b) as an
# origin='remote' row in harness_shared.p2p_fleet_directory. Presence on b IS
# the signature assert: the member-side projection
# (sync/hyperbee/projections/fleet-directory.ts) verifies the device signature
# + the device→owner attestation BEFORE applying — an unverified record never
# lands. A raw psql INSERT cannot fake this leg, which is why this scenario
# drives the sidecar's MCP endpoint instead of drv_psql (contrast
# b7-coord-controlplane's trigger-stamped probes).
#
# NON-INVASIVE (no sidecar kill/restart; writes one throwaway fleet row +
# directory card, ids suffixed with MATRIX_RUN_ID). Order 55: after the
# non-invasive content/coord scenarios, before the invasive restart(80)+ block.

# Bounded on-frame MCP tools/call as the pcusp user (mirrors scripts/
# mcp-call.mjs's wire shape: superuser bearer from ~/.papercusp/superuser-token,
# streamable-HTTP single-shot). $1=inst $2=tool $3=json-args.
_fdir_mcp_call() {
  local inst="$1" tool="$2" args="$3" ws
  # D-050 / WI-5399 iteration 2: rig_resolve_ws (pot_home_slug scoping) — works on
  # owner AND joiner, unlike origin='local' (structurally never matches a
  # joiner's own membership row). An unresolved/wrong workspace here doesn't
  # just mis-stamp a probe row — it sends the REAL MCP call's ?workspace= param
  # at the wrong (or a nonexistent) partition, surfacing as
  # "workspace_unresolved"/"unresolvable workspace partition" downstream.
  if ! ws="$(rig_resolve_ws "$inst")"; then
    echo '{"isError":true,"error":"MCP_ERROR: could not resolve a real workspace_id for the mcp call (D-050/WI-5399 class)"}'
    return 1
  fi
  rig_pcusp_run "$inst" <<EOS
# Read-or-generate the sidecar superuser token (rig_ban_member precedent: the
# sidecar re-reads the file per request, so a fresh write is honored).
f="\$HOME/.papercusp/superuser-token"
[ -s "\$f" ] || { mkdir -p "\$HOME/.papercusp"; head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40 > "\$f"; chmod 600 "\$f"; }
TOK="\$(cat "\$f" 2>/dev/null)"
if [ -z "\$TOK" ]; then echo "FDIR_NO_TOKEN"; exit 1; fi
curl -s -m 60 -X POST "http://127.0.0.1:${FED_SC[$inst]}/api/mcp?superuser=1&client=mx-fleetdir&workspace=${ws}" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer \$TOK" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${tool}","arguments":${args}}}'
EOS
}

# Bounded row poll: $1=inst $2=predicate → echoes 1 (present) / 0 (absent).
# 120 tries × 2s = 4min: the initial replicator attach on a fresh rig takes
# ~2.8min (measured, run m1783165541) — a 90s window false-REDs on it.
_fdir_row_present() {
  local inst="$1" pred="$2" tries="${3:-120}" n
  for _ in $(seq 1 "$tries"); do
    n="$(drv_psql "$inst" "SELECT count(*) FROM harness_shared.p2p_fleet_directory WHERE $pred;" 2>/dev/null | tr -d '[:space:]')"
    if [ "$n" != "0" ] && [ -n "$n" ]; then echo 1; return; fi
    sleep 2
  done
  echo 0
}

scn_fleet_directory() {
  local slug="mx-fleetdir-${MATRIX_RUN_ID}" out
  # slug must satisfy fleet-directory-schema's ^[a-z0-9][a-z0-9-]*$ — MATRIX_RUN_ID
  # is m<digits>, safe; lowercase defensively anyway.
  slug="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]')"

  # 1. OWNER (a): create the fleet through the real product path. The store's
  #    WI-2006 lifecycle hook authors + signs the directory card best-effort.
  out="$(_fdir_mcp_call a 'fleet:create' "{\"name\":\"$slug\",\"description\":\"matrix fleet-directory probe $MATRIX_RUN_ID\"}")"
  if printf '%s' "$out" | grep -q 'FDIR_NO_TOKEN'; then
    echo "fleet-directory FAIL — frame a has no superuser token for the MCP driver"
    return 1
  fi
  if printf '%s' "$out" | grep -Eq '"isError" *: *true|MCP_ERROR'; then
    echo "fleet-directory FAIL — fleet:create on frame a errored: $(printf '%s' "$out" | tail -c 300)"
    return 1
  fi

  # 2. The card must exist LOCALLY on a (the author leg — catches a silent
  #    publish skip: no shared hive resolved, no gh identity, keychain fault).
  if [ "$(_fdir_row_present a "fleet_slug='$slug'")" != 1 ]; then
    echo "fleet-directory FAIL — no local card on frame a for $slug (publish leg skipped/errored; check no_single_shared_hive / identity / keychain on a)"
    return 1
  fi

  # 3. The card must MATERIALIZE on b as origin='remote' — the cross-node,
  #    sig-verified leg (the projection refuses anything unverified).
  if [ "$(_fdir_row_present b "fleet_slug='$slug' AND origin='remote'")" != 1 ]; then
    echo "fleet-directory FAIL — card for $slug never materialized origin='remote' on frame b (published on a but not verified/applied on b)"
    return 1
  fi

  # 4. Content sanity on b: a live (non-archived) v1+ record WITH substrate
  #    attribution (P-014 hardened bar): author_pubkey must be a receiver-stamped
  #    64-hex substrate LOG key (resolveOpProvenance's remote branch, D-006
  #    unforgeable) — a git-importer/side-writer leaves it NULL/b64, so this
  #    clause kills the masking-importer false-green.
  local live
  live="$(drv_psql b "SELECT count(*) FROM harness_shared.p2p_fleet_directory WHERE fleet_slug='$slug' AND origin='remote' AND archived=false AND record_version>=1 AND author_pubkey ~ '^[0-9a-f]{64}\$';" 2>/dev/null | tr -d '[:space:]')"
  if [ "$live" = "0" ] || [ -z "$live" ]; then
    echo "fleet-directory FAIL — remote card on b is archived/malformed/unattributed (expected live record_version>=1 with a 64-hex substrate author_pubkey)"
    return 1
  fi

  echo "fleet-directory card federated a→b (owner-signed publish on create; sig-verified remote apply; live v1+ substrate-attributed card for $slug)"
  return 0
}

matrix_register fleet_directory 55 "fleet-directory card federation (WI-2006)" scn_fleet_directory
