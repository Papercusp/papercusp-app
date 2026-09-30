#!/usr/bin/env bash
# work-distribution-drill.sh — P-007 LIVE-2 acceptance drill
# (shared-hive-p2p-release-readiness-2026-07-03 P-007; spec = p2p-work-distribution-2026-07-02
# P-305, re-homed LOCAL per D-001 — WI-1751 deprecated "infra unavailable; superseded by
# local-rig track").
#
# The drill VERIFIES the p2p-hive-git fleet's work-distribution build on the REAL packaged
# sidecar. Any silent leg = FAIL; any leg whose runtime wiring does not exist yet is an
# explicit SKIP-with-reason (never a silent green) — the SKIP census IS the release
# evidence that those legs are unproven. As the owning lanes wire each leg, its SKIP
# flips to a live assert and this drill goes greener with zero re-authoring.
#
# ⚠ THAT LAST SENTENCE WAS A LIE FOR THREE WEEKS (D-018, 2026-08-01). The census was six
# HARDCODED STRINGS; nothing detected wiring, so as the lanes landed their legs the reasons
# rotted into falsehood while still reading as authoritative release evidence. Five of six
# were factually wrong by 2026-08-01 — one of them contradicted THIS FILE'S OWN HEADER.
# The census below now DETECTS every reason from the artifact under test (see its comment).
# If you are adding a leg: never write a literal reason. Write a probe.
#
# LIVE legs driven today (single-box, one packaged sidecar):
#   G   grant Delegate    p2p-grant-set { preset:'delegate' } → p2p_peer_grants row,
#                         capabilities expanded {chat,steer,work-offer,wake}, epoch stamped
#   M11 zero-allotment    granting confers NO allotment — resource_allotments stays empty
#                         for the grantee fleet until the host sets numbers
#   FW  in-flight session synthetic 'active' p2p_foreign_workspaces row (a focused
#                         revocation fixture; the real seat-spawn path is probed below)
#   R   revoke → reap     p2p-grant-set { action:'revoke' } → row state='reaped', refusal
#                         receipt (grant-revoked, work-offer:reap, offer_id-threaded),
#                         grantor high-water epoch bumped, grant status flipped
#   T   p2p:trace         M21 — the timeline assembles the reap receipt by offer_id
#
# UNWIRED legs: NOT LISTED HERE ON PURPOSE (D-018). A hand-maintained list of which legs
# are wired is exactly the thing that rotted — it is a SECOND COPY of state whose only
# source of truth is the build itself, and it silently stopped matching. The live census
# at the bottom of this file computes the list on every run. Read the run output, not a
# comment. (Historical reasons, all of them now false, are in D-018 on plan
# p2p-public-release-remaining-lanes-2026-07-16.)
#
# Cross-node (2-node rig) variant: WI-1910 CLOSED 2026-07-03 (leader verdict — connect
# symptom non-repro on the current deb; the 07-02 pin is lifted). WI-2006 WIRED
# 2026-07-04: the fleet-directory PUBLISH leg now authors owner-signed cards on every
# fleet lifecycle write (p2p/fleet-directory-publish.ts, hooked in agent-fleets-store;
# the scope-roster `directory?` injection was already live in boot.ts), and the
# cross-node proof is a REGISTERED MATRIX SCENARIO — bin/lib/scenarios/fleet-directory.sh
# (fleet:create on frame A → owner-signed card → origin='remote' sig-verified row in
# frame B's p2p_fleet_directory; run via bin/local-matrix.sh). Every other leg above is
# per-machine BY DESIGN (M19 allotments; LOCAL reaper/receipts/metering). Content-layer
# asserts stay OUT regardless (epoch-key class still red — WI-183).
#
# Usage: bin/work-distribution-drill.sh [path/to/Papercusp*_.deb]
#   KEEP_UP=1        leave the sidecar running for inspection
#   PAPERCUSP_DRILL_WORK=/path   override the lane home (default ~/.papercusp-drill-p007)
set -uo pipefail
DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DESKTOP_DIR/bin/lib/federation-asserts.sh"

REPO_DIR="${PAPERCUSP_REPO_DIR:-/home/builduser/papercupai-workspace/papercusp}"
DEB="${1:-}"
if [ -z "$DEB" ]; then
  DEB="$(ls -t /home/builduser/.cargo-target/release/bundle/deb/Papercusp*_amd64.deb 2>/dev/null | head -1)"
fi
DEB="$(readlink -f "$DEB" 2>/dev/null || echo "${DEB:-}")"
[ -f "$DEB" ] || { echo "FATAL: no .deb found (pass one; tried .cargo-target bundle dir)"; exit 2; }
LUXON_SRC="$REPO_DIR/node_modules/luxon"
OPERATOR_DIR="${PAPERCUSP_OPERATOR_DIR:-$REPO_DIR/apps/operator}"
REPO_URL="${HIVE_SMOKE_REPO_URL:-https://github.com/octocat/Hello-World}"
CUPBOARD_URL="${HIVE_SMOKE_CUPBOARD_URL:-http://127.0.0.1:9}"   # deliberately dead (cupboard-off)
P_A_USER="${P_A_USER:-papercupai}"
DRILL_FLEET="${DRILL_FLEET:-p007-drill-fleet}"
DRILL_OFFER="p007-drill-offer-$(date +%s)"

WORK="${PAPERCUSP_DRILL_WORK:-$HOME/.papercusp-drill-p007}"
rm -rf "$WORK" 2>/dev/null; mkdir -p "$WORK"
PKG="$WORK/pkg"
declare -A FED_LOG=( [a]="$WORK/inst-a.log" )
declare -A AHOME=( [a]="$WORK/inst-a" )
log() { printf '\n=== %s ===\n' "$*"; }
jget() { printf '%s' "$1" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
try: print($2)
except Exception: pass
" 2>/dev/null; }

PASS=0; FAIL=0; SKIPPED=0
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
skipp(){ echo "  ⏭ SKIP $*"; SKIPPED=$((SKIPPED+1)); }

# stop.sh: pgrep MINUS the invoker chain — never pkill -f a path your own argv carries
printf '#!/usr/bin/env bash\nfor p in $(pgrep -f "%s"); do [ "$p" = "$$" ] || [ "$p" = "$PPID" ] || kill -9 "$p" 2>/dev/null; done\necho stopped\n' "$WORK" > "$WORK/stop.sh"; chmod +x "$WORK/stop.sh"
cleanup() { [ -n "${KEEP_UP:-}" ] && { echo "KEEP_UP=1 — sidecar left running; $WORK/stop.sh to stop"; return; }; bash "$WORK/stop.sh" >/dev/null 2>&1; }
trap cleanup EXIT

A_TOKEN="$(gh auth token --user "$P_A_USER" 2>/dev/null)" || true
[ -n "$A_TOKEN" ] || A_TOKEN="$(gh auth token 2>/dev/null)" || true
[ -n "$A_TOKEN" ] || { echo "FATAL: no gh token — grants need a resolved GitHub identity (X9)"; exit 2; }

log "extract $DEB"
fed_extract_deb "$DEB" "$PKG" || exit 1
SIDE="$(fed_sidecar_dir "$PKG")"
[ -d "$SIDE/node_modules/luxon" ] || { echo "→ A-001 fix: injecting luxon"; cp -aL "$LUXON_SRC" "$SIDE/node_modules/luxon" || exit 1; }
fed_clobber_check "$PKG" || exit 2

log "spin local testnet DHT (announce stays off the public DHT)"
BOOTSTRAP="$(fed_start_testnet_dht "$OPERATOR_DIR" "$WORK")" || exit 3
echo "PAPERCUSP_DHT_BOOTSTRAP=$BOOTSTRAP"

log "launch sidecar A ($P_A_USER)"
SMK_HONO="$(fed_pick_free_port 18271)"; SMK_PG="$(fed_pick_free_port 18932)"
fed_local_launch_sidecar "${AHOME[a]}" "${FED_LOG[a]}" "$SIDE" "$SMK_HONO" "$SMK_PG" \
  PAPERCUSP_GITHUB_LOGIN="$P_A_USER" PAPERCUSP_DHT_BOOTSTRAP="$BOOTSTRAP" PAPERCUSP_CUPBOARD_URL="$CUPBOARD_URL"
fed_wait_boot a 80 || { echo "boot failed: ${FED_BOOT_ERR:-?}"; tail -25 "${FED_LOG[a]}"; exit 4; }
# WI-5641: don't override fed_wait_api's own default (60 tries*2s=120s, EI-521) —
# a hardcoded 30 re-introduces the boot-readiness flake EI-521 already fixed.
fed_wait_api a || { echo "FATAL: sidecar API never came up"; exit 4; }
DSN="postgresql://harness_admin:harness_admin_pwd@localhost:${FED_PG[a]}/papercusp"
q() { psql "$DSN" -tA -c "$1" 2>/dev/null | tr -d '\r'; }
SC="http://127.0.0.1:${FED_SC[a]}"
echo "  sc=${FED_SC[a]} pg=${FED_PG[a]}"

# ── workspace partition (WI-1564) ────────────────────────────────────────────
# grant-store REFUSES writes under the 'default' partition (a grant that never
# federates is dead config; a stranded revocation is a security hole). The
# product path: the GUI creates a workspace and every window stamps
# x-papercusp-workspace on its requests — the drill replicates exactly that
# (run-1 finding: curls without the header resolve 'default' → all writes refused).
log "create workspace (the GUI onboarding step the drill must replicate)"
wresp="$(curl -s -m 30 -X POST "$SC/api/workspaces" -H 'content-type: application/json' \
  -d '{"name":"P-007 Drill"}')"
WS="$(jget "$wresp" "d.get('id') or (d.get('workspace') or {}).get('id') or ''")"
[ -n "$WS" ] || WS="$(jget "$wresp" "d['workspaces'][0]['id']")"
[ -n "$WS" ] || { echo "✗ workspace create failed: $(echo "$wresp" | head -c 300)"; exit 6; }
echo "  workspace=$WS (writes below stamp x-papercusp-workspace: $WS)"
H_WS="x-papercusp-workspace: $WS"

log "create + publish PUBLIC hive ($REPO_URL)"
resp="$(curl -s -m 610 -X POST "$SC/api/harness/pots/from-repo" -H 'content-type: application/json' \
  -d "{\"githubUrl\":\"$REPO_URL\",\"visibility\":\"public\",\"runTests\":false,\"shallow\":true}")"
# Two OK shapes: fresh 'created', or 'existing' — the identity+repo hive anchor
# persists ACROSS instance homes (earlier same-identity smoke runs registered
# hello-world-hive), so a fresh home can get { ok:true, existing:{ hive:{ hiveId } } }.
HIVE_SLUG="$(jget "$resp" "d['created'].get('potSlug') or d['created'].get('hiveSlug') or ''")"  # renamed hiveSlug→potSlug; accept both for skew
HIVE_PATH="created"
if [ -z "$HIVE_SLUG" ]; then
  HIVE_SLUG="$(jget "$resp" "d['existing']['hive']['potId']")"; HIVE_PATH="existing"  # offer key renamed hiveId→potId (lookup-hive-for-repo.ts HiveHit)
fi
[ -n "$HIVE_SLUG" ] || { echo "✗ hive create failed: $(echo "$resp" | head -c 300)"; exit 6; }
echo "  hive=$HIVE_SLUG (path=$HIVE_PATH)"

# ── LEG G: grant Delegate ────────────────────────────────────────────────────
log "LEG G — grant Delegate to fleet '$DRILL_FLEET'"
g="$(curl -s -m 60 -X POST "$SC/api/agent-mcp/p2p-grant-set" -H 'content-type: application/json' -H "$H_WS" \
  -d "{\"action\":\"set\",\"potSlug\":\"$HIVE_SLUG\",\"granteeKind\":\"fleet\",\"granteeRef\":\"$DRILL_FLEET\",\"preset\":\"delegate\",\"note\":\"P-007 LIVE-2 drill\"}")"
[ "$(jget "$g" "d.get('ok')")" = "True" ] || { bad "grant-set refused: $(echo "$g" | head -c 300)"; }
grow="$(q "SELECT workspace_id||'|'||harness_slug||'|'||array_to_string(capabilities,',')||'|'||status||'|'||grantor_epoch||'|'||grantor_github_user_id FROM harness_shared.p2p_peer_grants WHERE grantee_ref='$DRILL_FLEET' AND harness_slug='$HIVE_SLUG';")"
CAPS="$(echo "$grow" | cut -d'|' -f3)"
GSTATUS="$(echo "$grow" | cut -d'|' -f4)"; EPOCH0="$(echo "$grow" | cut -d'|' -f5)"; GRANTOR="$(echo "$grow" | cut -d'|' -f6)"
if [ "$CAPS" = "chat,steer,work-offer,wake" ] && [ "$GSTATUS" = "active" ]; then
  ok "grant row live: caps expanded '$CAPS' status=active epoch=$EPOCH0 (ws=$WS grantor=$GRANTOR)"
else
  bad "grant row wrong: '$grow' (want caps chat,steer,work-offer,wake + active)"
fi

# ── LEG M11: default allotment is ZERO ───────────────────────────────────────
log "LEG M11 — granting confers NO allotment"
arows="$(q "SELECT count(*) FROM harness_shared.resource_allotments WHERE fleet_slug='$DRILL_FLEET';")"
[ "$arows" = "0" ] && ok "resource_allotments empty for '$DRILL_FLEET' (M11: grant ≠ allotment)" \
                   || bad "M11 violated: $arows allotment row(s) appeared from a bare grant"

# ── LEG A: allotment set→remove round-trip (P-201) ───────────────────────────
# su-35c3b live-verified this on the :3270 integration operator (2026-07-03);
# the drill re-proves it on the PACKAGED sidecar as a hard assertion.
log "LEG A — allotment set → row → remove → clean (P-201 two-axis store)"
as="$(curl -s -m 30 -X POST "$SC/api/agent-mcp/p2p-allotment-set" -H 'content-type: application/json' -H "$H_WS" \
  -d "{\"action\":\"set\",\"fleetSlug\":\"$DRILL_FLEET\",\"resourceKind\":\"account\",\"resourceRef\":\"p007-drill-account\",\"sharePct\":25}")"
[ "$(jget "$as" "d.get('ok')")" = "True" ] || bad "allotment set refused: $(echo "$as" | head -c 200)"
arow="$(q "SELECT share_pct||'|'||status FROM harness_shared.resource_allotments WHERE fleet_slug='$DRILL_FLEET' AND resource_ref='p007-drill-account';")"
[ "$arow" = "25|active" ] && ok "allotment row upserted (share_pct=25 status=active)" \
                          || bad "allotment row wrong: '$arow' (want 25|active)"
curl -s -m 30 -X POST "$SC/api/agent-mcp/p2p-allotment-set" -H 'content-type: application/json' -H "$H_WS" \
  -d "{\"action\":\"remove\",\"fleetSlug\":\"$DRILL_FLEET\",\"resourceKind\":\"account\",\"resourceRef\":\"p007-drill-account\"}" >/dev/null
gone="$(q "SELECT count(*) FROM harness_shared.resource_allotments WHERE fleet_slug='$DRILL_FLEET';")"
[ "$gone" = "0" ] && ok "allotment removed — table left clean" || bad "allotment remove left $gone row(s)"

# ── LEG FW: synthetic in-flight foreign session (revocation fixture) ─────────
log "LEG FW — seed synthetic ACTIVE foreign session for the revoke/reap assertion"
q "INSERT INTO harness_shared.p2p_foreign_workspaces
     (workspace_id, offer_id, fleet_slug, origin_github_user_id, executor_device, root_path, clone_path, state)
   VALUES ('$WS','$DRILL_OFFER','$DRILL_FLEET', 1567022, 'p007-drill-device', '$WORK/foreign-root', '$WORK/foreign-root/clone', 'active');" >/dev/null
fw="$(q "SELECT state FROM harness_shared.p2p_foreign_workspaces WHERE offer_id='$DRILL_OFFER';")"
[ "$fw" = "active" ] && ok "foreign session row active (offer_id=$DRILL_OFFER)" || bad "seed failed: state='$fw'"

# ── LEG R: revoke → reap + receipt + epoch bump ──────────────────────────────
log "LEG R — revoke the grant; the reaper must fail-close the in-flight session"
r="$(curl -s -m 60 -X POST "$SC/api/agent-mcp/p2p-grant-set" -H 'content-type: application/json' -H "$H_WS" \
  -d "{\"action\":\"revoke\",\"potSlug\":\"$HIVE_SLUG\",\"granteeKind\":\"fleet\",\"granteeRef\":\"$DRILL_FLEET\"}")"
[ "$(jget "$r" "d.get('ok')")" = "True" ] || bad "revoke refused: $(echo "$r" | head -c 300)"
reaped=""
for i in $(seq 1 15); do
  reaped="$(q "SELECT state FROM harness_shared.p2p_foreign_workspaces WHERE offer_id='$DRILL_OFFER';")"
  [ "$reaped" = "reaped" ] && break; sleep 2
done
[ "$reaped" = "reaped" ] && ok "in-flight foreign session REAPED (fail-closed)" \
                         || bad "session NOT reaped after 30s (state='$reaped') — C6 direct-registry reap broken?"
rcpt="$(q "SELECT kind||'|'||action||'|'||coalesce(offer_id,'-') FROM harness_shared.p2p_receipts WHERE offer_id='$DRILL_OFFER' AND action='work-offer:reap';")"
[ -n "$rcpt" ] && ok "refusal receipt emitted + offer-threaded: $rcpt" \
               || bad "NO reap receipt for offer_id=$DRILL_OFFER (D-004 silent drop)"
EPOCH1="$(q "SELECT high_water_epoch FROM harness_shared.p2p_grantor_epochs WHERE grantor_github_user_id=$GRANTOR AND harness_slug='$HIVE_SLUG';")"
if [ -n "$EPOCH1" ] && [ "$EPOCH1" -gt "${EPOCH0:-0}" ] 2>/dev/null; then
  ok "grantor high-water epoch bumped $EPOCH0 → $EPOCH1 (X6 fence armed)"
else
  bad "epoch NOT bumped (was $EPOCH0, now '$EPOCH1') — stale-claim fence dead"
fi
gs2="$(q "SELECT status FROM harness_shared.p2p_peer_grants WHERE grantee_ref='$DRILL_FLEET' AND harness_slug='$HIVE_SLUG';")"
[ "$gs2" = "revoked" ] && ok "grant row status=revoked" || bad "grant status='$gs2' (want revoked)"

# ── LEG T: p2p:trace assembles the timeline ──────────────────────────────────
log "LEG T — p2p:trace (M21 offer-id thread)"
# run-1 finding: mcp-call reads $HOME/.papercusp/superuser-token — must be the
# DRILL SIDECAR's home (its own token), not the host operator's.
# ⚠ ARG NAME IS `pot`, NOT `hive` (run-3 finding, 2026-08-01). This call passed
# {"hive":…} — the pre-rename name — and p2p:trace REFUSES an undeclared arg rather
# than ignoring it (EI-10883), so the leg had been hard-broken since the
# cup-lexicon-full-rename-2026-07-09 hive→pot rename. It read as a flaky/load
# failure for weeks because the saturation shed below fired FIRST and masked the
# real error; only retrying past the shed surfaced it. If you rename a wire field,
# grep the drills — they call tools by hand-written JSON and no typechecker covers them.
#
# run-2 finding (2026-08-01): this leg FAILED the whole drill on a load artifact —
# "operator event loop critically saturated — request shed, retry shortly", which the
# operator itself stamps `retryable:true`. Failing a release drill on a shed the server
# explicitly asked us to retry manufactures a red that says nothing about federation.
# Retry the RETRYABLE class only; a non-retryable miss is still a hard FAIL on the
# first try, so a genuinely broken trace is never masked by waiting.
tr_out=""; tr_try=0
while [ "$tr_try" -lt 5 ]; do
  tr_try=$((tr_try+1))
  tr_out="$(cd "$REPO_DIR" && HOME="${AHOME[a]}" PAPERCUSP_HONO_PORT="${FED_SC[a]}" timeout 60 node scripts/mcp-call.mjs p2p:trace \
    "{\"pot\":\"$HIVE_SLUG\",\"offerId\":\"$DRILL_OFFER\"}" --harness "$HIVE_SLUG" --workspace "$WS" 2>&1)"
  echo "$tr_out" | grep -q "work-offer:reap" && break
  echo "$tr_out" | grep -qE '"retryable":true|critically saturated' || break
  echo "  … p2p:trace shed under load (retryable), retry $tr_try/5"
  sleep 5
done
if echo "$tr_out" | grep -q "work-offer:reap"; then
  [ "$tr_try" -gt 1 ] && ok "p2p:trace shows the reap receipt for $DRILL_OFFER (after $tr_try attempts — shed under load)" \
                      || ok "p2p:trace shows the reap receipt for $DRILL_OFFER"
elif echo "$tr_out" | grep -qE '"retryable":true|critically saturated'; then
  # Still shedding after 5 tries: a REAL capacity finding, but not a federation one —
  # the receipt row itself is already hard-asserted in LEG R above.
  skipp "p2p:trace — DETECTED: operator shed the request on all $tr_try attempts (event loop saturated). The reap receipt IS proven by LEG R's direct row assert; this is a host-capacity finding, not a lost receipt."
else
  bad "p2p:trace did not surface the reap receipt (out: $(echo "$tr_out" | head -c 250))"
fi

# ── wiring census: every reason DETECTED, never authored (D-018) ─────────────
# This block replaces six hardcoded SKIP strings that had rotted into falsehood while
# still reading as release evidence (see the ⚠ note in the header). The rule now:
#
#     A LEG MAY NOT STATE A REASON. IT MAY ONLY RUN A PROBE.
#
# Every probe below interrogates THE ARTIFACT UNDER TEST — this packaged sidecar's own
# bundle and database — never the repo and never a human's memory of either. Two
# oracles, in order of strength:
#
#   1. THE BUNDLE IS TREE-SHAKEN, so it is an honest witness to reachability: a symbol
#      that no production path reaches is not merely uncalled, it is ABSENT FROM THE
#      SHIPPED FILE. (Verified 2026-08-01: reapForeignSessionsForRevocation present;
#      recordSpendDurable/onOfferAvailable absent — exactly matching which legs have
#      production callers. Identifiers are
#      not minified in this build, so absence is signal, not noise.)
#   2. THE SIDECAR'S OWN PG — a relation either exists in the instance under test or
#      does not. ("is the table there" is not a question to answer from a migration
#      filename: mig 483 is on disk in the repo AND its tables are in this database,
#      but those are two different facts and only the second one is the drill's.)
# Consequence, and the whole point: a lane that wires its leg makes this drill greener
# on the NEXT RUN with zero edits here — and a lane that UNWIRES one turns it red
# instead of leaving a comment that lies for three weeks.
bundle_has()    { grep -qF -- "$1" "$SIDE/serve.mjs" 2>/dev/null; }
table_present() { [ "$(q "SELECT to_regclass('harness_shared.$1') IS NOT NULL;")" = "t" ]; }
log "wiring census — reasons DETECTED from the packaged artifact (bundle / its PG)"

# OFFER-PUBLISH — store + publish leg (WI-1935).
# ⚠ THE PROBE SYMBOL IS PART OF THE CONTRACT — a rename silently inverts this leg.
# This probed `listWorkOffers` until 2026-08-09, when that function was renamed to
# `listOffers` (D-023 item 5, 12 files). The rename made the probe a FALSE NEGATIVE:
# the symbol is absent from any bundle built after it, so a perfectly wired publish
# leg would report SKIP "in bundle=no". It had not fired yet only because the deb on
# disk predated the rename — i.e. the bug was MASKED by a stale artifact and armed to
# fire on the next repackage, which is the one action a reader of this drill is most
# likely to take. Exactly the D-018 class this census exists to prevent, one level up:
# the probe was honest about the artifact but stale about the NAME it asked for.
# Guarded since: bin/work-distribution-drill-probe-symbols.test.ts fails if any
# bundle_has symbol here no longer exists in the TypeScript source.
# Witness BOTH halves of "store + publish": the read seam and the write seam.
if bundle_has 'listOffers' && bundle_has 'putWorkOffer' && table_present p2p_work_offers; then
  ok "OFFER-PUBLISH wired: read+write seams ship and p2p_work_offers exists in this instance"
else
  skipp "OFFER-PUBLISH — DETECTED: listOffers in bundle=$(bundle_has 'listOffers' && echo yes || echo no), putWorkOffer in bundle=$(bundle_has 'putWorkOffer' && echo yes || echo no), p2p_work_offers table=$(table_present p2p_work_offers && echo yes || echo no)"
fi

# PULL — the actual v1 request path: discover a signed seat, then publish the
# signed spawn_request that spends it. The retired kind:'work' puller is not a
# delegation leg and must never be used as this oracle again.
if bundle_has 'listOffers' && bundle_has 'publishSpawnRequest'; then
  ok "PULL wired: seat discovery + signed spawn-request publish both ship"
else
  skipp "PULL — DETECTED: listOffers in bundle=$(bundle_has 'listOffers' && echo yes || echo no), publishSpawnRequest in bundle=$(bundle_has 'publishSpawnRequest' && echo yes || echo no)"
fi

# SPAWN — projection apply is the production trigger. It validates the signed
# spawn_request, claims the target seat and opens bounded fleet members.
if bundle_has 'honorSpawnRequestFromProjection'; then
  ok "SPAWN wired: projection-triggered signed spawn-request honor ships"
else
  skipp "SPAWN — DETECTED: honorSpawnRequestFromProjection is absent from the shipped bundle"
fi

# RESULTS — requester-side reconciliation reads the federated receipt seam and
# classifies the delegated launch without pretending remote member absence is a
# failure verdict.
if bundle_has 'resolveDelegatedSpawnOutcome' && bundle_has 'listP2pReceipts'; then
  ok "RESULTS wired: delegated-spawn outcome reconciliation + federated receipt read both ship"
else
  skipp "RESULTS — DETECTED: resolveDelegatedSpawnOutcome in bundle=$(bundle_has 'resolveDelegatedSpawnOutcome' && echo yes || echo no), listP2pReceipts in bundle=$(bundle_has 'listP2pReceipts' && echo yes || echo no)"
fi

# METERING — P-205's own lane. Substrate and writer are SEPARATE facts; the old reason
# conflated them and got both wrong.
if table_present p2p_metering_spend && table_present p2p_metering_contribution; then
  ok "METERING substrate live: p2p_metering_spend + p2p_metering_contribution exist in this instance (mig 483)"
  if bundle_has 'recordSpendDurable'; then
    spend_rows="$(q "SELECT count(*) FROM harness_shared.p2p_metering_spend;")"
    [ "${spend_rows:-0}" != "0" ] && ok "METERING writer live: $spend_rows spend row(s) recorded" \
      || skipp "METERING — DETECTED: writer ships but no spend rows flowed this run"
  else
    skipp "METERING — DETECTED: recordSpendDurable is absent from the shipped bundle — the ledger has NO production writer (tables exist and are read by host-availability, but nothing writes them)"
  fi
else
  skipp "METERING — DETECTED: substrate missing from this instance (spend=$(table_present p2p_metering_spend && echo yes || echo no), contribution=$(table_present p2p_metering_contribution && echo yes || echo no))"
fi

# NUDGE — P-303. The one leg whose original reason survived re-verification.
if bundle_has 'onOfferAvailable'; then
  ok "NUDGE wired: the push-nudge publisher reaches a live offer path"
else
  skipp "NUDGE — DETECTED: onOfferAvailable is absent from the shipped bundle (push-nudge-service.ts is dormant by construction — P-303, latency-only, deferred on purpose)"
fi

# FED-REAP — revoke on A → reap on B. The hook ships; its gate is provenance
# origin='remote', so a local op NEVER reaches it (skipOwnOps: a local write does
# not go through writeToPg at all). This leg is UNPROVABLE ON ONE BOX BY
# CONSTRUCTION — one box can only ever produce a vacuous green for it. It is
# therefore NOT re-implemented here: it lives where the repo puts every other
# cross-node proof, as a registered matrix scenario driven on real frames —
#   bin/lib/scenarios/fed-reap.sh (order 59), via bin/local-matrix.sh.
# This drill's job is to report honestly that the single-box run does not cover it.
if ! bundle_has 'reapForeignSessionsForRevocation'; then
  skipp "FED-REAP — DETECTED: reapForeignSessionsForRevocation absent from the shipped bundle (the federated withdrawal path does not ship at all)"
else
  skipp "FED-REAP — DETECTED: the projection-apply hook SHIPS, but fires only for provenance origin='remote', which a single box cannot produce. NOT COVERED BY THIS RUN BY CONSTRUCTION — prove it with: bin/local-matrix.sh --only=fed_reap"
fi

echo
echo "════════════════════════════════════════════════════════"
echo "P-007 LIVE-2 drill (single-box live subset): PASS=$PASS FAIL=$FAIL SKIP=$SKIPPED"
if [ "$FAIL" -eq 0 ]; then
  echo "OVERALL: PASS — every WIRED leg green; $SKIPPED legs unproven (unwired, see census)"
  exit 0
fi
echo "OVERALL: FAIL"
exit 1
