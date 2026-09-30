#!/usr/bin/env bash
#
# ⛔ RETIRED 2026-07-03 (P-002 shared-hive-p2p-release-readiness, WI-1839).
# This smoke drives the PER-HARNESS share/finalize wire retired 2026-06-11
# (comb-retire-per-harness-sharing): POST /api/harness/projects +
# /api/harness/<slug>/share/finalize 404 on current builds, so the setup joins
# NO swarm topic and every federation assert times out (no peer_connected).
# Its coverage lives in the CURRENT-flow smokes the standing gate
# (bin/live-federation-gate.sh) runs:
#   - two-instance-hive-from-repo-smoke.sh  (create-from-repo → discover → join;
#     bidir origin=remote merge, A-003 settings/members, AK admission)
#   - two-instance-content-matrix-smoke.sh  (pots/from-repo publish → directory
#     list on B → join-hive; per-table content federation matrix)
# Kept for reference per the retired-surfaces convention — do NOT extend or
# re-green; delete the banner only if the per-harness wire is deliberately
# resurrected. Body below is unreachable.
echo "RETIRED (2026-07-03 P-002): this smoke tests the per-harness share wire retired 2026-06-11 — superseded by two-instance-hive-from-repo-smoke.sh + two-instance-content-matrix-smoke.sh (see header)." >&2
exit 0
# COVERAGE GAP filed on retirement: the B→A SYMMETRIC directory listing
# (B creates a hive; A lists it) is not asserted by the current-flow smokes
# — tracked as a work-item to add a B-side create+list leg to content-matrix.
# two-instance-hive-directory-smoke.sh — packaged P2P HIVE DIRECTORY proof.
#
# The directory sibling of two-instance-merge-smoke.sh: two SEPARATELY-PACKAGED
# desktop instances on one box, distinct GitHub identities, isolated local
# testnet DHT (PAPERCUSP_DHT_BOOTSTRAP) — instance A publishes a hive listing
# (discovery:set_hive → signed announce on the global directory topic) and the
# smoke asserts it appears in instance B's directory (GET /api/discovery/hives)
# with title/owner/member-links intact, and symmetrically B's hive on A.
#
# Includes the JOIN leg (the owner directive's "and can join"): A shares a REAL
# harness (throwaway public GitHub repo under the A account, deleted in cleanup),
# carries the REAL join link in its hive announce; B extracts the link FROM ITS
# DIRECTORY LISTING, joins via POST /api/harness/join-link, and a feature written
# on A must federate into B's PG (origin=remote) — browse → join → federate.
#
# This is the FULL-APP-STACK version of the in-process live E2E
# (hive-directory-live-two-peer.test.ts): real per-instance identity resolution
# + attestation gists, the real boot-join (boot-all → wireHiveDirectoryForWorkspace,
# with the lazy ensureHiveDirectoryWired fallback), the real MCP tool + HTTP
# endpoint — everything short of two physical machines on the public DHT
# (same-host holepunch never completes; the testnet DHT is the documented
# substitute — see agent-insights/standalone-hyperswarm-discovery-driver).
#
# REQUIRES a .deb built from a tree that includes the directory transport fixes
# (createDirectoryGossip — p2p-hive-directory D-007); enforced by a static grep.
#
# Usage:
#   bin/two-instance-hive-directory-smoke.sh [path/to/Papercusp_*.deb]
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/federation-asserts.sh"

DEB="${1:-$(dirname "$0")/../src-tauri/target/release/bundle/deb/Papercusp_0.0.1_amd64.deb}"
P_A_USER="${P_A_USER:-papercupai}"
P_B_USER="${P_B_USER:-ownerhandle}"
OPERATOR_DIR="${PAPERCUSP_OPERATOR_DIR:-/home/builduser/papercupai-workspace/papercusp/apps/operator}"
DISPLAY_NUM="${PAPERCUSP_SMOKE_DISPLAY:-149}"
WORK="$(mktemp -d /tmp/hive-dir-smoke.XXXXXX)"
PKG="$WORK/pkg"; BIN="$PKG/usr/bin/papercusp-desktop"
A_HOME="$WORK/inst-a"; B_HOME="$WORK/inst-b"
FED_LOG[a]="$WORK/a.log"; FED_LOG[b]="$WORK/b.log"
log() { fed_log "$@"; }

cleanup() { log "cleanup (scoped to $WORK)"; fed_cleanup_scoped "$WORK"; }
trap cleanup EXIT

# ── tokens (distinct identities) ───────────────────────────────────────────────
A_TOKEN="$(gh auth token --user "$P_A_USER" 2>/dev/null)" || true
B_TOKEN="$(gh auth token --user "$P_B_USER" 2>/dev/null)" || true
[ -n "$A_TOKEN" ] && [ -n "$B_TOKEN" ] || { echo "FATAL: need gh tokens for $P_A_USER + $P_B_USER (gh auth login)"; exit 1; }

# ── extract + clobber pre-check + swarm/directory support fail-fast ────────────
log "extract $DEB"
fed_extract_deb "$DEB" "$PKG" || exit 1
fed_clobber_check "$PKG" || exit 2
fed_assert_deb_swarm_support "$PKG" || exit 2
if ! grep -rqs "createDirectoryGossip" "$(fed_sidecar_dir "$PKG")/serve.mjs" 2>/dev/null \
  && ! grep -rqls "createDirectoryGossip" "$(fed_sidecar_dir "$PKG")" 2>/dev/null | head -1 | grep -q .; then
  echo "FATAL: packaged sidecar lacks the directory transport (createDirectoryGossip) — rebuild the .deb from a tree with p2p-hive-directory D-007"
  exit 2
fi

# ── headless display (dedicated — never share a peer's :99/:100/:148) ──────────
fed_fresh_display "$DISPLAY_NUM" "$WORK" || exit 1

# ── local testnet DHT (deterministic same-box discovery) ───────────────────────
BOOTSTRAP="$(fed_start_testnet_dht "$OPERATOR_DIR" "$WORK")" || exit 3
echo "PAPERCUSP_DHT_BOOTSTRAP=$BOOTSTRAP"

# ── launch two isolated packaged instances with distinct identities ────────────
log "launch A ($P_A_USER) + B ($P_B_USER)"
# two-role split (2026-07-03, P-002): the GUI binary no longer boots a sidecar in an
# extracted-pkg smoke — launch the PACKAGED sidecar directly (fed_local_launch_sidecar).
# staggered per-instance ports (WI-754 pattern): an ARGLESS fed_pick_free_port
# returns 18000 for EVERY pre-bind call, so hono==pg and A==B all collided
# (found 2026-07-03 P-002 rerun r2 — all four smokes EADDRINUSE'd at boot).
SMK_A_HONO="$(fed_pick_free_port 18071)"; SMK_A_PG="$(fed_pick_free_port 18532)"
SMK_B_HONO="$(fed_pick_free_port $((SMK_A_HONO + 1)))"; SMK_B_PG="$(fed_pick_free_port $((SMK_A_PG + 100)))"
fed_local_launch_sidecar "$A_HOME" "${FED_LOG[a]}" "$(fed_sidecar_dir "$PKG")" "$SMK_A_HONO" "$SMK_A_PG" PAPERCUSP_GITHUB_LOGIN="$P_A_USER" PAPERCUSP_DHT_BOOTSTRAP="$BOOTSTRAP"
fed_local_launch_sidecar "$B_HOME" "${FED_LOG[b]}" "$(fed_sidecar_dir "$PKG")" "$SMK_B_HONO" "$SMK_B_PG" PAPERCUSP_GITHUB_LOGIN="$P_B_USER" PAPERCUSP_DHT_BOOTSTRAP="$BOOTSTRAP"

fed_wait_boot a 50 || { echo "A boot failed: $FED_BOOT_ERR"; tail -20 "${FED_LOG[a]}"; exit 4; }
fed_wait_boot b 50 || { echo "B boot failed: $FED_BOOT_ERR"; tail -20 "${FED_LOG[b]}"; exit 4; }
FED_DB[a]="postgresql://harness_admin:harness_admin_pwd@localhost:${FED_PG[a]}/papercusp"
FED_DB[b]="postgresql://harness_admin:harness_admin_pwd@localhost:${FED_PG[b]}/papercusp"
log "A: PG=${FED_PG[a]} sc=${FED_SC[a]} | B: PG=${FED_PG[b]} sc=${FED_SC[b]}"
fed_assert_isolated a b || exit 5
fed_wait_api a 30 || { echo "A sidecar API never came up"; exit 4; }
fed_wait_api b 30 || { echo "B sidecar API never came up"; exit 4; }

# ── helpers: per-instance MCP tool call + directory listing ─────────────────────

# dir_set_hive <inst> <home> <hiveId> <title> [memberLink] — publish a public
# hive listing on one instance via its own MCP surface (superuser bearer is
# self-provisioned at boot under that instance's HOME). Echoes the tool's JSON
# result text. memberLink (when given) rides the announce for one-click join.
dir_set_hive() {
  local inst="$1" home="$2" hive_id="$3" title="$4" link="${5:-}" tok links_json
  tok="$(cat "$home/.papercusp/superuser-token" 2>/dev/null)" || true
  [ -n "$tok" ] || { echo '{"error":"no superuser-token under instance HOME"}'; return 1; }
  links_json=""
  [ -n "$link" ] && links_json=",\"memberLinks\":[\"$link\"]"
  curl -s -m 30 -X POST "http://127.0.0.1:${FED_SC[$inst]}/api/mcp?superuser=1" \
    -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"discovery:set_hive\",\"arguments\":{\"hiveId\":\"$hive_id\",\"title\":\"$title\",\"description\":\"packaged two-instance directory smoke\",\"visibility\":\"public\"$links_json}}}" \
    | grep -o '"text":"{[^}]*}*"' | head -1
}

# dir_list <inst> — the instance's discovered-hive list (loopback HTTP route).
dir_list() {
  local inst="$1"
  curl -s -m 10 "http://127.0.0.1:${FED_SC[$inst]}/api/discovery/pots"
}

# dir_wait_listed <inst> <hiveId> <owner> [tries] — poll an instance's directory
# until the hive appears (verified announce ingested over the testnet wire).
dir_wait_listed() {
  local inst="$1" hive_id="$2" owner="$3" tries="${4:-40}" i body
  for i in $(seq 1 "$tries"); do
    body="$(dir_list "$inst")"
    if echo "$body" | grep -q "\"hiveId\":\"$hive_id\"" && echo "$body" | grep -q "\"owner\":\"$owner\""; then
      echo 1; return 0
    fi
    sleep 3
  done
  echo 0; return 1
}

# ── A: create a REAL throwaway public repo + share a harness on it ──────────────
# The join leg needs a clonable repo (join's clone_repo step hard-fails on a
# synthetic id). Public → B (a different GitHub identity) can clone it. Deleted
# in cleanup (best-effort — needs delete_repo scope; a lingering empty public
# smoke repo is harmless).
SLUG="hivejoinsmoke"
REPO_NAME="hive-join-smoke-$RANDOM"
log "A ($P_A_USER): create throwaway public repo $REPO_NAME"
repo_json="$(curl -s -m 30 -X POST https://api.github.com/user/repos \
  -H "Authorization: Bearer $A_TOKEN" -H 'Accept: application/vnd.github+json' \
  -d "{\"name\":\"$REPO_NAME\",\"private\":false,\"auto_init\":true}")"
REPO_ID="$(echo "$repo_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)"
FULL_NAME="$(echo "$repo_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("full_name",""))' 2>/dev/null)"
[ -n "$REPO_ID" ] && [ -n "$FULL_NAME" ] || { echo "FATAL: repo create failed: $(echo "$repo_json" | head -c 200)"; exit 7; }
echo "repo: $FULL_NAME (id=$REPO_ID)"
cleanup_repo() {
  curl -s -m 30 -X DELETE "https://api.github.com/repos/$FULL_NAME" \
    -H "Authorization: Bearer $A_TOKEN" -H 'Accept: application/vnd.github+json' -o /dev/null \
    && echo "repo $FULL_NAME deleted" || echo "repo $FULL_NAME NOT deleted (token may lack delete_repo) — harmless, delete by hand"
}
trap 'cleanup_repo; cleanup' EXIT

TOPIC=$(printf 'papercusp-substrate-v1:gh:%s' "$REPO_ID" | sha256sum | cut -d' ' -f1)
JOIN_LINK="papercusp://harness?topic=$TOPIC&github=$FULL_NAME&repo_id=$REPO_ID"
STATE="{\"topic\":\"$TOPIC\",\"github_repository_id\":$REPO_ID,\"github_remote\":\"https://github.com/$FULL_NAME\",\"privacy\":\"shared-private\"}"
log "A: register + share $SLUG write-free on the real repo (topic=${TOPIC:0:16}…)"
fed_register_project a "$SLUG" "$WORK" proj-a
# Inline share (not fed_share_finalize): the route allows 300s (timeoutSec) so
# the client must too, and we want the FULL response for diagnosis.
share_resp="$(curl -s -m 310 -X POST "http://127.0.0.1:${FED_SC[a]}/api/harness/$SLUG/share/finalize" \
  -H 'content-type: application/json' \
  -d "{\"state\":$STATE}")"
echo "A share → $(echo "$share_resp" | head -c 400)"
echo "$share_resp" | grep -q '"bindingPublished":true' || echo "⚠ A share did not report bindingPublished:true"

# ── A publishes (carrying the REAL join link) → B lists; B publishes → A lists ──
log "A ($P_A_USER): publish hive-from-a to the directory (memberLink = real join link)"
resA="$(dir_set_hive a "$A_HOME" hive-from-a "Alpha live hive ($P_A_USER)" "$JOIN_LINK")"
echo "A set_hive → $resA"
log "B ($P_B_USER): publish hive-from-b to the directory"
resB="$(dir_set_hive b "$B_HOME" hive-from-b "Beta live hive ($P_B_USER)")"
echo "B set_hive → $resB"

log "wait: B's directory lists hive-from-a (announce crossed the wire + verified)"
ab="$(dir_wait_listed b hive-from-a "$P_A_USER" 40 || true)"
[ "$ab" = 1 ] && echo "✓ A→B: hive-from-a listed on B (owner=$P_A_USER)" || { echo "✗ A→B: hive-from-a never listed on B"; echo "B directory: $(dir_list b | head -c 400)"; }

log "wait: A's directory lists hive-from-b (reverse direction)"
ba="$(dir_wait_listed a hive-from-b "$P_B_USER" 40 || true)"
[ "$ba" = 1 ] && echo "✓ B→A: hive-from-b listed on A (owner=$P_B_USER)" || { echo "✗ B→A: hive-from-b never listed on A"; echo "A directory: $(dir_list a | head -c 400)"; }

# The REAL join link must survive the announce → ingest → HTTP projection
# round-trip — B extracts it FROM ITS OWN DIRECTORY LISTING (no out-of-band copy).
links_ok=0
B_LINK="$(dir_list b | python3 -c '
import json,sys
d=json.load(sys.stdin)
for r in d.get("rows",[]):
    if r.get("hiveId")=="hive-from-a" and r.get("memberLinks"):
        print(r["memberLinks"][0]); break
' 2>/dev/null)"
if [ "$B_LINK" = "$JOIN_LINK" ]; then links_ok=1; fi
[ "$links_ok" = 1 ] && echo "✓ member-link intact on B's listing ($B_LINK)" || echo "✗ member-link missing/mismatched on B (got: $B_LINK)"

# ── THE JOIN LEG: B joins A's harness from the DISCOVERED link, then federates ──
join_ok=0; fed_ok=0
if [ "$links_ok" = 1 ]; then
  log "B ($P_B_USER): join via the discovered link"
  join_resp="$(curl -s -m 310 -X POST "http://127.0.0.1:${FED_SC[b]}/api/harness/join-link" \
    -H 'content-type: application/json' \
    -d "{\"slug\":\"$SLUG\",\"harnessLinkUrl\":\"$B_LINK\"}")"
  echo "B join → $(echo "$join_resp" | head -c 300)"
  echo "$join_resp" | grep -q '"ok":true' && join_ok=1
  # The join-link HTTP response can come back blank/spurious for a slow join
  # (gist publish + git clone + substrate boot + DHT announce, routinely >30s —
  # see join-link.ts timeoutSec comment) even though the substrate JOINED
  # server-side. Don't gate the merge on that fragile single response: fall back
  # to the ground truth — did B's substrate actually join the harness topic?
  if [ "$join_ok" != 1 ]; then
    log "join-link HTTP response not ok:true — polling B's [swarm] join ground-truth for $SLUG"
    for _i in $(seq 1 40); do
      if grep -qE "\[swarm\] joined topic .* harness=$SLUG" "${FED_LOG[b]}" 2>/dev/null; then
        join_ok=1; echo "✓ B substrate joined the harness topic for $SLUG (HTTP response was blank/slow — see join-link.ts)"; break
      fi
      sleep 3
    done
  fi
  if [ "$join_ok" = 1 ]; then
    log "wait for swarm discovery between A and B on the harness topic"
    disc="$(fed_wait_discovery a b strict 60 || true)"
    case "$disc" in
      1)    echo "✓ data path proven between instances (bytes crossed)" ;;
      skip) echo "⊘ discovery SKIPPED — this build predates the peer_data_path_up emitter (N/A, not a failure; EI-18687938054040755)" ;;
      *)    echo "⚠ no data path proven in ~90s" ;;
    esac
    log "A→B: INSERT feature on A → expect origin=remote in B (federation through a directory-discovered join)"
    fed_ok="$(fed_merge_assert a b "$SLUG" F-DIR2B "joined via directory" todo 100 || true)"
    # EI-681 diagnostics: localize a federation stall (capture vs workspace_id-stamp vs drain vs apply).
    echo "  [diag] A feature row : $(drv_psql a "SELECT origin||'|ws='||COALESCE(workspace_id,'<empty>')||'|fed_ts='||COALESCE(fed_ts::text,'NULL') FROM harness_shared.harness_features_consolidated WHERE harness_slug='$SLUG' AND feature_id='F-DIR2B';" 2>/dev/null | tr -d '\n')"
    echo "  [diag] A outbox row  : $(drv_psql a "SELECT 'ws='||COALESCE(workspace_id,'<empty>')||'|drained='||(drained_at IS NOT NULL)::text FROM harness_shared.substrate_outbox WHERE table_name='harness_features_consolidated' AND key='F-DIR2B';" 2>/dev/null | tr -d '\n')"
    echo "  [diag] A booted-harness ws: $(drv_psql a "SELECT DISTINCT workspace_id FROM harness_shared.harness_features_consolidated WHERE harness_slug='$SLUG';" 2>/dev/null | tr -d '\n')"
    echo "  [diag] B feature row : $(drv_psql b "SELECT COALESCE(origin,'?')||'|ws='||COALESCE(workspace_id,'<empty>') FROM harness_shared.harness_features_consolidated WHERE harness_slug='$SLUG' AND feature_id='F-DIR2B';" 2>/dev/null | tr -d '\n' | head -c 80)"
    echo "  [diag] B undrained-outbox(any): $(drv_psql b "SELECT count(*) FROM harness_shared.substrate_outbox WHERE drained_at IS NULL;" 2>/dev/null | tr -d '\n')"
    [ "$fed_ok" = 1 ] && echo "✓ FEDERATED: F-DIR2B landed in B as origin=remote" || echo "✗ F-DIR2B not in B after ~300s"
  fi
fi

# ── report ───────────────────────────────────────────────────────────────────────
log "RESULT"
echo "A→B-listed=$([ "$ab" = 1 ] && echo PASS || echo FAIL)  B→A-listed=$([ "$ba" = 1 ] && echo PASS || echo FAIL)  member-link=$([ "$links_ok" = 1 ] && echo PASS || echo FAIL)  join=$([ "$join_ok" = 1 ] && echo PASS || echo FAIL)  federate=$([ "$fed_ok" = 1 ] && echo PASS || echo FAIL)"
if [ "$ab" = 1 ] && [ "$ba" = 1 ] && [ "$links_ok" = 1 ] && [ "$join_ok" = 1 ] && [ "$fed_ok" = 1 ]; then
  echo "OVERALL: PASS — browse → join → federate proven end-to-end in the packaged app"
  exit 0
else
  DBG="/tmp/hive-join-smoke-debug-$$"
  mkdir -p "$DBG" && cp "${FED_LOG[a]}" "$DBG/a.log" 2>/dev/null; cp "${FED_LOG[b]}" "$DBG/b.log" 2>/dev/null
  echo "OVERALL: INCOMPLETE — instance logs preserved at $DBG"
  grep -iE "hive-directory|\[swarm\]|share|finalize|error" "${FED_LOG[a]}" 2>/dev/null | tail -12
  grep -iE "hive-directory|\[swarm\]" "${FED_LOG[b]}" 2>/dev/null | tail -6
  exit 6
fi
