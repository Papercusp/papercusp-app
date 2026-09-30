#!/usr/bin/env bash
# spawn-request.sh — P-009 matrix scenario: cross-machine spawn-request
# federation, FAIL-CLOSED leg (agent-allocation-framework-2026-07-03 P-009;
# rides the mig-490 offer store like seat-offer.sh).
#
# What it proves: the fleet OWNER frame (a) authors a SIGNED 'spawn_request'
# against the seat-offer the MEMBER frame (b) delegated (real product path:
# MCP fleet:request_remote_spawn → p2p/spawn-request-publish.ts), the new
# record KIND rides the hive peer-log and MATERIALIZES on b as an
# origin='remote' row (sig-verified by projections/work-offers.ts — presence IS
# the verify assert), and — the load-bearing half — b's ACCEPT_DELEGATED_SEATS
# gate is OFF on a fresh frame, so the honor hook does NOTHING AT ALL:
# no local_disposition, no seat consumption, no refusal receipt, no spawn
# (delegated-spawn-honor.ts gate 1 is a silent skip by design). The HONOR leg
# (gate ON → real member terminals) deliberately rides the P-010 live 2-box
# drill, not the matrix: a matrix run must not boot LLM sessions.
#
# Composes with fleet-directory.sh (55) + seat-offer.sh (56): reuses
# _fdir_mcp_call and _soffer_row_present, and runs right after them.
# NON-INVASIVE (one throwaway fleet + two offer rows, MATRIX_RUN_ID-suffixed).

scn_spawn_request() {
  if ! declare -f _fdir_mcp_call >/dev/null || ! declare -f _soffer_row_present >/dev/null; then
    echo "spawn-request FAIL — _fdir_mcp_call/_soffer_row_present missing (scenarios 55/56 not loaded)"
    return 1
  fi

  local slug="mx-spawnreq-${MATRIX_RUN_ID}" out
  slug="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]')"

  # 1. OWNER (a): create the fleet — the caller becomes its leader (the
  #    request tool enforces leader-only).
  out="$(_fdir_mcp_call a 'fleet:create' "{\"name\":\"$slug\",\"description\":\"matrix spawn-request probe $MATRIX_RUN_ID\"}")"
  if printf '%s' "$out" | tr -d '\\' | grep -Eq '"isError" *: *true|"ok" *: *false|MCP_ERROR|FDIR_NO_TOKEN'; then
    echo "spawn-request FAIL — fleet:create on frame a errored: $(printf '%s' "$out" | tail -c 300)"
    return 1
  fi

  # 2. MEMBER (b): delegate 2 haiku·low seats → publishes the seat-offer.
  out="$(_fdir_mcp_call b 'resource:delegate' "{\"fleetSlug\":\"$slug\",\"kind\":\"agent_slot\",\"model\":\"haiku\",\"effort\":\"low\",\"count\":2}")"
  if printf '%s' "$out" | tr -d '\\' | grep -Eq '"isError" *: *true|"ok" *: *false|MCP_ERROR|FDIR_NO_TOKEN'; then
    echo "spawn-request FAIL — resource:delegate on frame b errored: $(printf '%s' "$out" | tail -c 300)"
    return 1
  fi

  # 3. The seat-offer must reach a (origin='remote') BEFORE a can author the
  #    request — publishSpawnRequest validates the target from the local store.
  if [ "$(_soffer_row_present a "fleet_slug='$slug' AND offer_kind='seat' AND origin='remote'")" != 1 ]; then
    echo "spawn-request FAIL — b's seat-offer for $slug never materialized on frame a (prerequisite leg; see seat-offer scenario)"
    return 1
  fi

  # 4. OWNER (a): author the spawn-request through the real product path.
  #    Auto-picks the single open seat-offer; the plan slug is a throwaway
  #    (the tool validates fleet+seat-offer, the plan is honored on spawn only).
  out="$(_fdir_mcp_call a 'fleet:request_remote_spawn' "{\"fleet\":\"$slug\",\"plan\":\"mx-plan-$slug\",\"count\":1}")"
  if printf '%s' "$out" | tr -d '\\' | grep -Eq '"isError" *: *true|"ok" *: *false|MCP_ERROR|FDIR_NO_TOKEN'; then
    echo "spawn-request FAIL — fleet:request_remote_spawn on frame a errored: $(printf '%s' "$out" | tail -c 400)"
    return 1
  fi

  # 5. The signed request must exist locally on a…
  if [ "$(_soffer_row_present a "fleet_slug='$slug' AND offer_kind='spawn_request' AND status='open'")" != 1 ]; then
    echo "spawn-request FAIL — no local spawn_request row on frame a for $slug (author leg failed silently)"
    return 1
  fi

  # 6. …and MATERIALIZE on b as origin='remote' — the projection verified the
  #    signature on the NEW kind before applying (the P-009 federation proof).
  #    P-014 hardened bar: also require the receiver-stamped 64-hex substrate
  #    author_pubkey (unforgeable attribution; a side-writer leaves it NULL/b64).
  if [ "$(_soffer_row_present b "fleet_slug='$slug' AND offer_kind='spawn_request' AND origin='remote' AND author_pubkey ~ '^[0-9a-f]{64}\$'")" != 1 ]; then
    echo "spawn-request FAIL — spawn_request for $slug never materialized origin='remote' with substrate attribution on frame b (new-kind federation/verify leg broken)"
    return 1
  fi

  # 7. FAIL-CLOSED: b's accept-delegated-seats gate is OFF on a fresh frame, so
  #    the honor hook must have done NOTHING — un-disposed row, zero seat
  #    consumptions, zero refusal receipts (a receipt would mean the gate
  #    evaluated past its silent-skip contract).
  local disp cons rcpt
  disp="$(drv_psql b "SELECT count(*) FROM harness_shared.p2p_work_offers WHERE fleet_slug='$slug' AND offer_kind='spawn_request' AND local_disposition IS NOT NULL;" 2>/dev/null | tr -d '[:space:]')"
  if [ "$disp" != "0" ]; then
    echo "spawn-request FAIL — gate is OFF yet the request on b carries a local_disposition (honor hook acted; fail-closed contract broken)"
    return 1
  fi
  cons="$(drv_psql b "SELECT count(*) FROM harness_shared.agent_seat_consumptions WHERE fleet_slug='$slug';" 2>/dev/null | tr -d '[:space:]')"
  if [ "$cons" != "0" ]; then
    echo "spawn-request FAIL — gate is OFF yet frame b consumed a seat for $slug (something spawned; fail-closed contract broken)"
    return 1
  fi
  rcpt="$(drv_psql b "SELECT count(*) FROM harness_shared.p2p_receipts WHERE action='delegated-seat:spawn' AND offer_id IN (SELECT offer_id FROM harness_shared.p2p_work_offers WHERE fleet_slug='$slug' AND offer_kind='spawn_request');" 2>/dev/null | tr -d '[:space:]')"
  if [ "$rcpt" != "0" ]; then
    echo "spawn-request FAIL — gate is OFF yet frame b emitted a spawn refusal receipt for $slug (gate must be a SILENT skip)"
    return 1
  fi

  echo "spawn-request federated a→b fail-closed (signed request authored on a; sig-verified remote apply of the new kind on b; gate-OFF honor hook stayed perfectly silent — no disposition, no consumption, no receipt)"
  return 0
}

matrix_register spawn_request 57 "spawn-request federation, fail-closed leg (P-009)" scn_spawn_request
