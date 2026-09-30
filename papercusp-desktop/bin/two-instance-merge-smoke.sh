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
# two-instance-merge-smoke.sh — packaged cross-process federation MERGE proof.
#
# The companion to two-instance-federation-smoke.sh (which proves boot+isolation
# +discovery). This one proves the actual write-free MERGE: a feature written on
# instance A federates into instance B's PG, gated by the REAL write-free
# admission (per-identity attestation gist + signed announce — NO shared-repo
# write), between two SEPARATELY-PACKAGED desktop processes on one box.
#
# This is a thin LOCAL-driver wrapper over bin/lib/federation-asserts.sh — the
# single shared orchestration/assert core (D-003 of
# linux-test-vm-and-federation-2026-06-04) also used by the VM driver
# bin/vm-federation.sh.
#
# Why this became possible (non-collaborator-join-fork-pr-2026-06-02, "A3"):
#   Joining is now WRITE-FREE — admission verifies the device↔github binding from
#   the announced attestation GIST + signed announce, not a contributor file
#   written to the shared repo. So a SYNTHETIC github_repository_id is fine: it
#   only seeds the swarm topic; each peer self-publishes its own gist.
#
# How same-box discovery is made deterministic:
#   Two Hyperswarm instances on ONE box can't reliably holepunch to their own
#   public IP over the PUBLIC DHT (NAT hairpinning) — so this smoke spins a local
#   `hyperdht/testnet` and points BOTH instances at it via PAPERCUSP_DHT_BOOTSTRAP
#   (swarm.ts). *** REQUIRES a .deb built from a tree that includes the swarm.ts
#   PAPERCUSP_DHT_BOOTSTRAP support + the boot.ts [swarm] logs (landed
#   2026-06-02) — now ENFORCED up front by a static grep of the packaged
#   host.mjs (fail-fast instead of a silent public-DHT no-discovery run). ***
#
# Identities: A=papercupai, B=ownerhandle (distinct, via a non-secret per-instance
# PAPERCUSP_GITHUB_LOGIN selector), the
#   same real pair the p079 live test uses. Override with P_A_USER / P_B_USER.
#
# PROVEN GREEN 2026-06-03 (see agent-insight packaged-two-instance-federation-merge):
#   discovery + both merge directions landed on the first poll.
#
# Usage:
#   bin/two-instance-merge-smoke.sh [path/to/Papercusp_*.deb] [synthetic_repo_id]
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/federation-asserts.sh"

DEB="${1:-$(dirname "$0")/../src-tauri/target/release/bundle/deb/Papercusp_0.0.1_amd64.deb}"
SYNTH_REPO_ID="${2:-918273645}"
P_A_USER="${P_A_USER:-papercupai}"
P_B_USER="${P_B_USER:-ownerhandle}"
OPERATOR_DIR="${PAPERCUSP_OPERATOR_DIR:-/home/builduser/papercupai-workspace/papercusp/apps/operator}"
DISPLAY_NUM="${PAPERCUSP_SMOKE_DISPLAY:-148}"
WORK="$(mktemp -d /tmp/merge-smoke.XXXXXX)"
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

# ── extract + clobber pre-check + swarm-support fail-fast (P-011) ──────────────
log "extract $DEB"
fed_extract_deb "$DEB" "$PKG" || exit 1
fed_clobber_check "$PKG" || exit 2
fed_assert_deb_swarm_support "$PKG" || exit 2

# ── headless display (dedicated — never share a peer's :99/:100/...) ───────────
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

# ── wait for boot; capture PG + sidecar ports + admin DSN ──────────────────────
fed_wait_boot a 50 || { echo "A boot failed: $FED_BOOT_ERR"; tail -20 "${FED_LOG[a]}"; exit 4; }
fed_wait_boot b 50 || { echo "B boot failed: $FED_BOOT_ERR"; tail -20 "${FED_LOG[b]}"; exit 4; }
FED_DB[a]="postgresql://harness_admin:harness_admin_pwd@localhost:${FED_PG[a]}/papercusp"
FED_DB[b]="postgresql://harness_admin:harness_admin_pwd@localhost:${FED_PG[b]}/papercusp"
log "A: PG=${FED_PG[a]} sc=${FED_SC[a]} | B: PG=${FED_PG[b]} sc=${FED_SC[b]}"
fed_assert_isolated a b || exit 5

# ── register a harness + share write-free on BOTH (same synthetic repo id) ──────
TOPIC=$(printf 'papercusp-substrate-v1:gh:%s' "$SYNTH_REPO_ID" | sha256sum | cut -d' ' -f1)
SLUG=mergesmoke
STATE="{\"topic\":\"$TOPIC\",\"github_repository_id\":$SYNTH_REPO_ID,\"github_remote\":\"https://github.com/$P_A_USER/$SLUG\",\"privacy\":\"shared-private\"}"
log "register + share write-free on both (topic=${TOPIC:0:16}…)"
fed_register_project a "$SLUG" "$WORK" proj-a
fed_register_project b "$SLUG" "$WORK" proj-b
echo "A: $(fed_share_finalize a "$SLUG" "$STATE" | grep -oE '"bindingPublished":[a-z]+|"state":"[a-z-]+"')"
echo "B: $(fed_share_finalize b "$SLUG" "$STATE" | grep -oE '"bindingPublished":[a-z]+|"state":"[a-z-]+"')"

# ── wait for mutual swarm admission ([swarm] peer_connected — always logged) ────
log "wait for swarm peer discovery + admission (~90s)"
disc="$(fed_wait_discovery a b strict 30 || true)"
case "$disc" in
  1)    echo "✓ data path proven between instances (bytes crossed)" ;;
  skip) echo "⊘ discovery SKIPPED — this build predates the peer_data_path_up emitter (N/A, not a failure; EI-18687938054040755)" ;;
  *)    echo "⚠ no data path proven in ~90s" ;;
esac

# ── A→B MERGE: write a feature on A, assert it federates into B's PG ────────────
log "A→B: INSERT feature on A (origin=local) → expect origin=remote in B"
ab="$(fed_merge_assert a b "$SLUG" F-A2B "from $P_A_USER" todo 30 || true)"
[ "$ab" = 1 ] && echo "✓ A→B MERGE: F-A2B federated into B as origin=remote" || echo "✗ A→B: F-A2B not in B after ~90s"

# ── B→A MERGE (symmetric) ───────────────────────────────────────────────────────
log "B→A: INSERT feature on B → expect origin=remote in A"
ba="$(fed_merge_assert b a "$SLUG" F-B2A "from $P_B_USER" in-progress 30 || true)"
[ "$ba" = 1 ] && echo "✓ B→A MERGE: F-B2A federated into A as origin=remote" || echo "✗ B→A: F-B2A not in A after ~90s"

# ── report ───────────────────────────────────────────────────────────────────────
log "RESULT"
# EI-18687938054040755: fed_wait_discovery echoes 1|0|skip. `skip` = this build
# predates the peer_data_path_up emitter, so NO discovery verdict exists — that is
# N/A, not a failure, and it must not sink OVERALL (scoring "not measured" as FAIL
# is a false-FAIL indistinguishable from a real product break). The merge legs are
# themselves proof that bytes crossed, so a run MAY pass with discovery unmeasured
# — it just has to SAY so, never render as an unqualified green.
disc_label() { case "$1" in 1) echo PASS ;; skip) echo SKIP ;; *) echo FAIL ;; esac; }
echo "discovery=$(disc_label "$disc")  A→B-merge=$([ "$ab" = 1 ] && echo PASS || echo FAIL)  B→A-merge=$([ "$ba" = 1 ] && echo PASS || echo FAIL)"
if { [ "$disc" = 1 ] || [ "$disc" = skip ]; } && [ "$ab" = 1 ] && [ "$ba" = 1 ]; then
  if [ "$disc" = skip ]; then
    echo "OVERALL: PASS (⊘ discovery SKIPPED — build predates the peer_data_path_up emitter, EI-18687938054040755; the merges are the wire proof) — write-free packaged merge proven"
  else
    echo "OVERALL: PASS — write-free packaged merge proven"
  fi
  exit 0
fi
echo "OVERALL: INCOMPLETE — see [swarm] log lines in ${FED_LOG[a]} / ${FED_LOG[b]}"; exit 6
