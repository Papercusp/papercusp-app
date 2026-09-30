#!/usr/bin/env bash
# two-instance-interactive.sh — launch TWO packaged desktop instances that SHARE
# a harness, on a VISIBLE display, and LEAVE THEM RUNNING for you to click around.
#
# The interactive companion to bin/two-instance-hive-from-repo-smoke.sh: same
# proven core (bin/lib/federation-asserts.sh — extract .deb, local testnet DHT,
# two isolated instances with distinct GitHub identities + PAPERCUSP_DHT_BOOTSTRAP,
# hive create-from-repo on A → directory-discover + join on B — the CURRENT hive
# flow; the per-harness share wire was retired 2026-06-11), but it (a) targets a
# REAL display so you see
# two windows, (b) skips the INSERT-merge asserts, and (c) does NOT tear down at
# the end — both desktops stay up until you run the printed stop command.
#
# Why a local testnet DHT: two Hyperswarm instances on ONE box can't holepunch
# over the PUBLIC DHT (NAT hairpinning), so both peers join a local
# hyperdht/testnet via PAPERCUSP_DHT_BOOTSTRAP — same as the smoke.
#
# Requires: a .deb whose serve.mjs honors PAPERCUSP_DHT_BOOTSTRAP (fail-fast
# checked), gh tokens for both identities, and a reachable X display.
#
# Usage: bin/two-instance-interactive.sh [path/to/Papercusp_*.deb]
#   PAPERCUSP_INTERACTIVE_DISPLAY=N   X display to show the windows on (default 0 = your screen)
#   P_A_USER / P_B_USER               GitHub identities (default papercupai / ownerhandle)
#   PAPERCUSP_FED_REPO_URL            public repo A's hive is created from (default octocat/Hello-World)
set -uo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DESKTOP_DIR/bin/lib/federation-asserts.sh"

DEB="${1:-$DESKTOP_DIR/src-tauri/target/release/bundle/deb/Papercusp_0.0.1_amd64.deb}"
DISP="${PAPERCUSP_INTERACTIVE_DISPLAY:-0}"
P_A_USER="${P_A_USER:-papercupai}"
P_B_USER="${P_B_USER:-ownerhandle}"
OPERATOR_DIR="${PAPERCUSP_OPERATOR_DIR:-/home/builduser/papercupai-workspace/papercusp/apps/operator}"
# Real PUBLIC repo for the hive create-from-repo step (the retired share/finalize
# path used a synthetic repo id; the hive model clones a real repo).
REPO_URL="${PAPERCUSP_FED_REPO_URL:-https://github.com/octocat/Hello-World}"

# Stable work dir (NOT mktemp) so the stop command can always find the processes.
WORK="$HOME/.papercusp-interactive-fed"
rm -rf "$WORK" 2>/dev/null; mkdir -p "$WORK"
PKG="$WORK/pkg"; BIN="$PKG/usr/bin/papercusp-desktop"
A_HOME="$WORK/inst-a"; B_HOME="$WORK/inst-b"
declare -A FED_LOG=( [a]="$WORK/inst-a.log" [b]="$WORK/inst-b.log" )

log() { echo -e "\n=== $* ==="; }

# ── identities ─────────────────────────────────────────────────────────────────
A_TOKEN="$(gh auth token --user "$P_A_USER" 2>/dev/null)" || true
B_TOKEN="$(gh auth token --user "$P_B_USER" 2>/dev/null)" || true
[ -n "$A_TOKEN" ] && [ -n "$B_TOKEN" ] || { echo "FATAL: need gh tokens for $P_A_USER + $P_B_USER (gh auth login)"; exit 1; }

# ── display check ──────────────────────────────────────────────────────────────
DISPLAY=":$DISP" xdpyinfo >/dev/null 2>&1 || { echo "FATAL: X display :$DISP not reachable. Set PAPERCUSP_INTERACTIVE_DISPLAY to a live one (xdpyinfo -display :N)."; exit 1; }
echo "windows will appear on DISPLAY :$DISP"

# ── extract + swarm-support fail-fast ──────────────────────────────────────────
log "extract $DEB"
fed_extract_deb "$DEB" "$PKG" || exit 1
fed_assert_deb_swarm_support "$PKG" || exit 2

# ── local testnet DHT (deterministic same-box discovery) ───────────────────────
BOOTSTRAP="$(fed_start_testnet_dht "$OPERATOR_DIR" "$WORK")" || exit 3
echo "PAPERCUSP_DHT_BOOTSTRAP=$BOOTSTRAP"

# ── launch two isolated packaged instances with distinct identities, ON :$DISP ──
log "launch A ($P_A_USER) + B ($P_B_USER) on :$DISP"
fed_local_launch "$A_HOME" "${FED_LOG[a]}" "$BIN" "$DISP" GH_TOKEN="$A_TOKEN" PAPERCUSP_DHT_BOOTSTRAP="$BOOTSTRAP"
fed_local_launch "$B_HOME" "${FED_LOG[b]}" "$BIN" "$DISP" GH_TOKEN="$B_TOKEN" PAPERCUSP_DHT_BOOTSTRAP="$BOOTSTRAP"

# ── wait for boot; capture sidecar ports ───────────────────────────────────────
fed_wait_boot a 60 || { echo "A boot failed: ${FED_BOOT_ERR:-?}"; tail -20 "${FED_LOG[a]}"; exit 4; }
fed_wait_boot b 60 || { echo "B boot failed: ${FED_BOOT_ERR:-?}"; tail -20 "${FED_LOG[b]}"; exit 4; }
log "A: sidecar=${FED_SC[a]} PG=${FED_PG[a]} | B: sidecar=${FED_SC[b]} PG=${FED_PG[b]}"

# ── hive setup: create-from-repo on A (auto-publish) → B discovers + joins ─────
# The per-harness register+share/finalize wire was RETIRED 2026-06-11
# (comb-retire-per-harness-sharing → the HIVE model; the old helpers now die
# fast, EI-680). Mirrors vm-federation.sh §9: A creates a hive from a real
# PUBLIC repo (clone + blueprint + hive home + member + AUTO-PUBLISH on the
# directory topic), B discovers the announce and JOINS — the join re-keys B
# onto the owner's Hive-pubkey topic so writes actually federate (EI-681).
log "A: create hive from repo (auto-publish)  repo=$REPO_URL"
a_resp="$(fed_hive_create_from_repo a "$REPO_URL")"
echo "A create → $(printf '%s' "$a_resp" | head -c 400)"
SLUG="$(fed_json "$a_resp" "d['created'].get('potSlug') or d['created'].get('hiveSlug') or ''")"  # renamed hiveSlug→potSlug; accept both for skew
MEMBER_SLUG="$(fed_json "$a_resp" "d['created']['memberSlug']")"
if [ -z "$SLUG" ] || [ -z "$MEMBER_SLUG" ]; then
  echo "FATAL: A from-repo create failed — body above"; tail -20 "${FED_LOG[a]}"; exit 6
fi
echo "✓ A created hive='$SLUG' member='$MEMBER_SLUG'"

log "B: poll GET /api/discovery/pots for '$SLUG' → join"
MEMBER_LINKS="[]"; links_via="directory(B)"
for _ in $(seq 1 "${DISCOVERY_RETRIES:-40}"); do
  brow="$(fed_hive_dir_row b "$SLUG")"
  if [ -n "$brow" ]; then
    MEMBER_LINKS="$(fed_json "$brow" "json.dumps(d.get('memberLinks') or [])")"
    [ -n "$MEMBER_LINKS" ] && [ "$MEMBER_LINKS" != "[]" ] && break
  fi
  sleep 3
done
if [ -z "$MEMBER_LINKS" ] || [ "$MEMBER_LINKS" = "[]" ]; then
  # WI-6190: A's own /api/discovery/pots can NEVER list a locally-owned pot
  # (buildHiveDirectoryRows only returns peer-learned + joined-remote rows),
  # so `fed_hive_dir_row a` here always missed. Read memberLinks from the
  # create response's own `publish` outcome instead — from-repo already
  # synthesizes a self-link there when publish succeeded with no memberLinks
  # (WI-3577) — the demo still federates via the join even if B's directory
  # projection lags the announce.
  MEMBER_LINKS="$(fed_json "$a_resp" "json.dumps(d.get('publish', {}).get('memberLinks') or [])")"
  links_via="local(A-create-response)"
fi
if [ -z "$MEMBER_LINKS" ] || [ "$MEMBER_LINKS" = "[]" ]; then
  echo "FATAL: no memberLinks via B's directory or A's local listing — cannot join"; exit 6
fi
echo "✓ memberLinks resolved via $links_via"
j_resp="$(fed_hive_join b "$SLUG" "$MEMBER_LINKS")"
echo "B join → $(printf '%s' "$j_resp" | head -c 400)"

# ── record state + a stop command; LEAVE RUNNING ───────────────────────────────
cat > "$WORK/instances.env" <<EOF
# Two interactive packaged instances sharing hive/pot '$SLUG'.
A_IDENTITY=$P_A_USER   A_SIDECAR=http://127.0.0.1:${FED_SC[a]}   A_PG=${FED_PG[a]}   A_LOG=${FED_LOG[a]}
B_IDENTITY=$P_B_USER   B_SIDECAR=http://127.0.0.1:${FED_SC[b]}   B_PG=${FED_PG[b]}   B_LOG=${FED_LOG[b]}
DHT=$BOOTSTRAP   DISPLAY=:$DISP   WORK=$WORK
EOF
cat > "$WORK/stop.sh" <<EOF
#!/usr/bin/env bash
# Stop the interactive two-instance session (scoped to $WORK — never a broad pkill).
pkill -9 -f "$WORK" 2>/dev/null || true
echo "stopped — interactive session at $WORK torn down"
EOF
chmod +x "$WORK/stop.sh"

cat <<EOF

────────────────────────────────────────────────────────────────────────────
✅ Two desktops are now SHARING hive/pot '$SLUG' on DISPLAY :$DISP.
   A = $P_A_USER (owner)   ·   B = $P_B_USER (joined member)
   A published on the directory topic over a local testnet DHT; B joined.

TRY IT:
  • In window A, open pot '$SLUG' and create a feature / work-item.
  • Watch it appear in window B (federated as origin=remote), and vice-versa.
  • Each is fully independent (own embedded-PG): A=:${FED_PG[a]}  B=:${FED_PG[b]}.

Logs:    tail -f ${FED_LOG[a]}   /   ${FED_LOG[b]}   (grep '[swarm]' for peer events)
Details: cat $WORK/instances.env
STOP:    $WORK/stop.sh
────────────────────────────────────────────────────────────────────────────
EOF
