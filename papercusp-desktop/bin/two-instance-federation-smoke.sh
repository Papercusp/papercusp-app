#!/usr/bin/env bash
# two-instance-federation-smoke.sh — packaged cross-process federation smoke (#3)
#
# Launches the PACKAGED desktop (.deb) TWICE, fully isolated, headless under
# Xvfb, and verifies: (1) both instances boot (embedded-PG + sidecar + substrate),
# (2) they are mutually isolated (own HOME → own ~/.papercusp, embedded-PG port,
# corestore, dynamically-picked sidecar port), (3) both join ONE synthetic
# shared-harness swarm topic and DISCOVER each other over Hyperswarm.
#
# This is a thin LOCAL-driver wrapper over bin/lib/federation-asserts.sh — the
# single shared orchestration/assert core (D-003 of
# linux-test-vm-and-federation-2026-06-04) also used by two-instance-merge-smoke.sh
# and the VM driver bin/vm-federation.sh.
#
# SCOPE / what this does NOT prove:
#   The federation MERGE. That ceiling moved: after the write-free join
#   (non-collaborator-join-fork-pr-2026-06-02 "A3") a synthetic repo id CAN merge —
#   bin/two-instance-merge-smoke.sh is the packaged merge proof. This smoke remains
#   the cheaper boot+isolation+discovery check (no identities, no DHT override —
#   discovery rides the public DHT and may be INCONCLUSIVE on one box: NAT
#   hairpinning; see the merge smoke for the deterministic testnet-DHT variant).
#
# VALIDATION STATUS (2026-06-02, full run): ran end-to-end against a freshly
#   rebuilt CLEAN .deb (real 2.4G sidecar; 687M .deb). RESULT: clobber pre-check
#   PASS, both packaged instances booted embedded-PG + sidecar and were ISOLATED
#   (distinct PG + sidecar ports) → "boot + isolation: PASS". Peer DISCOVERY was
#   INCONCLUSIVE: the synthetic share 404s in a fresh workspace (no registered
#   harness), so the two instances never join the same topic. To exercise
#   discovery, scaffold/select a harness with slug "sheets" in EACH instance
#   before the share step (see dogfood docs).
#   Gotcha that bites every rebuild: plain `npm run build` (tauri build) does NOT
#   build the sidecar (beforeBuildCommand is "") and reuses a STALE 0-byte
#   target/release/sidecar copy on an incremental cargo build. For a clean .deb:
#   build-desktop-sidecar.sh first, then `cargo clean -p papercusp-desktop` (forces
#   a fresh resource recopy), then tauri build — and copy the .deb out of the tree
#   immediately (a concurrent peer build-desktop-sidecar.sh rm -rf's the source).
#
# Usage:
#   bin/two-instance-federation-smoke.sh [path/to/Papercusp_*.deb] [synthetic_repo_id]
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/federation-asserts.sh"

DEB="${1:-$(dirname "$0")/../src-tauri/target/release/bundle/deb/Papercusp_0.0.1_amd64.deb}"
SYNTH_REPO_ID="${2:-999000777}"      # a github_repository_id that does NOT exist (synthetic topic)
DISPLAY_NUM="${PAPERCUSP_SMOKE_DISPLAY:-99}"
WORK="$(mktemp -d /tmp/p3-smoke.XXXXXX)"
PKG="$WORK/pkg"; BIN="$PKG/usr/bin/papercusp-desktop"
A_HOME="$WORK/inst-a"; B_HOME="$WORK/inst-b"
FED_LOG[a]="$WORK/a.log"; FED_LOG[b]="$WORK/b.log"
STARTED_XVFB=0

log() { fed_log "$@"; }
cleanup() {
  log "cleanup"
  fed_cleanup_scoped "$WORK"
  [ "$STARTED_XVFB" = "1" ] && pkill -f "Xvfb :$DISPLAY_NUM" 2>/dev/null || true
}
trap cleanup EXIT

# ── 1. extract + assert the bundle is NOT clobbered ────────────────────────────
log "extract $DEB"
fed_extract_deb "$DEB" "$PKG" || exit 1
log "clobber pre-check (the build-clobber defect ships 0-byte sidecar files)"
fed_clobber_check "$PKG" || exit 2

# ── 2. headless display ────────────────────────────────────────────────────────
STARTED_XVFB="$(fed_ensure_display "$DISPLAY_NUM" "$WORK")"

# ── 3. launch two isolated packaged instances ──────────────────────────────────
# two-role split (2026-07-03, P-002): the GUI binary no longer boots a sidecar in an
# extracted-pkg smoke — launch the PACKAGED sidecar directly (fed_local_launch_sidecar).
# staggered per-instance ports (WI-754 pattern): an ARGLESS fed_pick_free_port
# returns 18000 for EVERY pre-bind call, so hono==pg and A==B all collided
# (found 2026-07-03 P-002 rerun r2 — all four smokes EADDRINUSE'd at boot).
SMK_A_HONO="$(fed_pick_free_port 18071)"; SMK_A_PG="$(fed_pick_free_port 18532)"
SMK_B_HONO="$(fed_pick_free_port $((SMK_A_HONO + 1)))"; SMK_B_PG="$(fed_pick_free_port $((SMK_A_PG + 100)))"
log "launch instance A ($A_HOME)"; fed_local_launch_sidecar "$A_HOME" "${FED_LOG[a]}" "$(fed_sidecar_dir "$PKG")" "$SMK_A_HONO" "$SMK_A_PG"
log "launch instance B ($B_HOME)"; fed_local_launch_sidecar "$B_HOME" "${FED_LOG[b]}" "$(fed_sidecar_dir "$PKG")" "$SMK_B_HONO" "$SMK_B_PG"

fed_wait_boot a 40 || { echo "instance A boot failed: $FED_BOOT_ERR"; tail -20 "${FED_LOG[a]}"; exit 3; }
fed_wait_boot b 40 || { echo "instance B boot failed: $FED_BOOT_ERR"; tail -20 "${FED_LOG[b]}"; exit 3; }
log "instance A: PG=${FED_PG[a]} sidecar=${FED_SC[a]} | instance B: PG=${FED_PG[b]} sidecar=${FED_SC[b]}"
fed_assert_isolated a b || exit 4

# ── 4. (REMOVED 2026-07-03 P-002) share + discovery steps ──────────────────────
# The old step-4 POSTed the per-harness share/finalize wire RETIRED 2026-06-11
# (comb-retire-per-harness-sharing) — it 404s on current builds, so no topic was
# ever joined and the follow-on discovery poll was a guaranteed-INCONCLUSIVE ⚠.
# Peer discovery + merge on the CURRENT hive flow are proven by
# two-instance-hive-from-repo-smoke.sh + two-instance-content-matrix-smoke.sh
# (both run by bin/live-federation-gate.sh). THIS smoke's value is the packaged
# BOOT + ISOLATION proof.

# ── 5. report ───────────────────────────────────────────────────────────────────
log "RESULT"
echo "Packaged two-instance boot + isolation: PASS (PG A=${FED_PG[a]} B=${FED_PG[b]}, sidecar A=${FED_SC[a]} B=${FED_SC[b]})"
echo "OVERALL: PASS — packaged two-instance boot + isolation proven"
echo "Federation MERGE/discovery: not exercised here — see two-instance-hive-from-repo-smoke.sh + two-instance-content-matrix-smoke.sh (current hive flow)."
echo "(cleanup runs on exit)"
