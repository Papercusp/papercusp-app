#!/usr/bin/env bash
# two-instance-hive-from-repo-smoke.sh — packaged CREATE-FROM-REPO → DISCOVER →
# JOIN-OFFER → JOIN proof (hive-from-github-url-2026-06-11 P-019).
#
# The from-repo sibling of two-instance-hive-directory-smoke.sh: two isolated
# full-app-stack instances on one box, distinct GitHub identities, local
# testnet DHT (PAPERCUSP_DHT_BOOTSTRAP). The loop proven end-to-end:
#
#   1. A: POST /api/harness/pots/from-repo {githubUrl, visibility:public}
#      → clone + blueprint + hive home + member + AUTO-PUBLISH (P-006/P-007).
#      Asserted: ok:true, created.potSlug/memberSlug (potSlug was hiveSlug pre-rename), publish.announced:true,
#      and bindingUnverified:true — both instances point PAPERCUSP_CUPBOARD_URL
#      at an unreachable port (the LIVE Cupboard worker is NEVER touched), so
#      the create must succeed in the documented degraded directory-only mode
#      (D-004 degradation contract — part of what this smoke proves).
#   2. B: GET /api/discovery/hives until A's hive lists (announce crossed the
#      testnet wire + verified), memberLinks intact. (The HTTP projection does
#      not expose memberRepos — the announce's member_repos leg is proven by
#      step 3 instead, which can ONLY hit via hiveMatchesRepo(memberRepos).)
#   3. B: POST the SAME repo URL to /api/harness/pots/from-repo → must get the
#      JOIN OFFER (existing.kind === 'hive', source === 'directory', NO create,
#      zero side effects) — the paste-time dedup loop (P-005/P-008).
#   4. B: accepts — POST /api/harness/join-link per offered memberLink
#      (slug joined-<repo>) → ok:true + state.steps.clone_repo done.
#
# GitHub footprint: the fixture repo is READ-ONLY (clone + repos.get). No repo
# is created or written. (The join leg self-publishes B's attestation gist —
# the same write-free-admission mechanics every two-instance smoke exercises.)
#
# Fixture repo: HIVE_SMOKE_REPO_URL (default a tiny public GitHub repo).
#
# Modes (HIVE_SMOKE_MODE=auto|deb|sidecar, default auto):
#   deb      — the template path: extract a packaged .deb, launch the desktop
#              binary twice under Xvfb (two-instance-hive-directory-smoke.sh
#              mechanics). REQUIRES a .deb built from a tree with the from-repo
#              backend (pots/from-repo + member_repos) — enforced by a static
#              grep, exactly like the directory smoke's createDirectoryGossip
#              gate.
#   sidecar  — the documented FALLBACK when the on-disk .deb predates the
#              from-repo backend and a full tauri rebuild is too heavy: take a
#              per-run immutable snapshot of the packaged sidecar bundle
#              (src-tauri/sidecar/serve.mjs — the exact artifact the .deb ships;
#              serve.mjs owns embedded-PG + migrations + the Hono host + swarm
#              boot), then run that snapshot twice with isolated HOMEs/ports.
#              Everything the asserts touch is identical; only the Tauri window
#              chrome (webview + Xvfb) is absent. The snapshot prevents a
#              concurrent release build from replacing the release input under
#              the smoke, and prevents smoke cleanup from deleting it.
#   auto     — deb when the .deb exists AND passes the from-repo gate, else
#              sidecar (loudly).
#
# Opt-in live-witness probes (rider blocks after a successful join; each is independent):
#   WITNESS_PROBE=1     — owner-enforcement (AK) + P-008 re-key CUT (needs the rekey flag).
#   A003_MEMBERSHIP_PROBE=1 — hive_settings/hive_members A→B crossing (A-003 gate).
#   MODERATION_PROBE=1  — WI-283 moderation federation: (LEG1) owner takedown crosses A→B
#                         via the owner-signed hive_policy.moderation.takedownList, and
#                         (LEG2) a member report federates B→A into the owner's hive_reports
#                         moderation queue. Rides the SAME rig/helpers; NOT gated on the
#                         re-key flag or C-001/WI-280 (both legs ride hive-home-grained
#                         federated tables, not the epoch-key/content path).
#   ATTESTATION_PROBE=1 — P-008 (shared-hive-p2p-release-readiness) trust-admission live proof:
#                         (LEG1) membership SEEDING — A attests the joiner B AND B's roster seeds
#                         the owner origin=remote (the WI-1585 VM-half symptom was an EMPTY B
#                         roster); (LEG2) SECOND-DEVICE attestation — a 2nd device of the SAME
#                         github user MERGES into B's member row (union by device_pubkey, no
#                         clobber — the WI-1585 leg-A fix) via the owner-admit seam; (LEG3)
#                         WRONG-GH-USER-ID refused-op — B authors a receipt claiming a responder
#                         that is NOT B → A refuses + bumps p2p_refused_op_counters
#                         (receipt-apply:responder_mismatch); (LEG4) UNATTESTED/REMOVED-device
#                         refused-op — after A revokes B, B's receipt can no longer resolve to an
#                         identity → A refuses + bumps the counter again. Proves "refused-op
#                         counters exist AND increment on adversarial probes". Rides the SAME
#                         rig/helpers; independent of the re-key flag (the identity gate is on
#                         the receipt path, not the epoch/content path).
#
# Usage:
#   bin/two-instance-hive-from-repo-smoke.sh [path/to/Papercusp_*.deb]
#   MODERATION_PROBE=1 bin/two-instance-hive-from-repo-smoke.sh   # + the moderation witness
set -uo pipefail
DESKTOP_DIR="${DESKTOP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "$DESKTOP_DIR/bin/lib/federation-asserts.sh"

# Default to the NEWEST built .deb (version-agnostic — the desktop version is
# bumped by the release lanes, so a pinned 0.0.1 path goes stale). An explicit
# $1 still wins.
DEB_DEFAULT="$(ls -t "$DESKTOP_DIR"/src-tauri/target/release/bundle/deb/Papercusp_*_amd64.deb 2>/dev/null | head -1)"
DEB="${1:-${DEB_DEFAULT:-$DESKTOP_DIR/src-tauri/target/release/bundle/deb/Papercusp_0.0.1_amd64.deb}}"
# Resolve to an ABSOLUTE path — resolve_mode (auto) `cd`s into a tmp dir before
# `dpkg-deb --fsys-tarfile "$DEB"`, so a relative $1 silently extracts nothing,
# fails the from-repo gate, and degrades to SIDECAR even when the .deb is fine.
DEB="$(readlink -f "$DEB" 2>/dev/null || echo "$DEB")"
MODE="${HIVE_SMOKE_MODE:-auto}"
SIDECAR_SRC="${PAPERCUSP_SMOKE_SIDECAR_DIR:-$DESKTOP_DIR/src-tauri/sidecar}"
REPO_URL="${HIVE_SMOKE_REPO_URL:-https://github.com/octocat/Hello-World}"
# EI-7045 GOTCHA: this repo's hive identity/anchor persists GITHUB-SIDE (that's
# the whole point of anchoring to a repo) — it survives wiping the LOCAL A_HOME/
# B_HOME instance dirs. So step 1's `d['ok'] and 'created' in d` assertion below
# only passes on the FIRST-EVER successful run against this URL; every run after
# that correctly gets `{existing:...}` back (the from-repo API's intended,
# idempotent behavior — NOT a bug) and the smoke script false-fails. If step 1
# starts failing with "existing" in the body, the fixture repo has already been
# registered by a prior run — either point HIVE_SMOKE_REPO_URL at a disposable
# repo you haven't smoked before, or de-register the prior hive/anchor for this
# URL before re-running; don't "fix" this by loosening the assertion to accept
# `existing` — the downstream publish.announced/bindingUnverified/cupboard
# assertions only exist on the CREATE path's response shape.
# Unreachable on purpose: TCP port 9 (discard) on loopback refuses instantly —
# the live Cupboard worker must never see this smoke (D-004 degraded path).
CUPBOARD_URL="${HIVE_SMOKE_CUPBOARD_URL:-http://127.0.0.1:9}"
P_A_USER="${P_A_USER:-papercupai}"
P_B_USER="${P_B_USER:-ownerhandle}"
MACHINE_IDENTITY_DIR="${PAPERCUSP_FROM_REPO_IDENTITY_DIR:-$HOME/.papercusp/identity}"
# Keep durable attestation state across runs, but isolate each account's
# keychain namespace. A shared identity directory also carries the Hive/Noise
# seed; when A and B use it, the second side can present A's transport identity
# and the live witness fails before admission. Per-account roots preserve each
# account's attestation while preventing cross-instance Hive-key sharing.
A_IDENTITY_DIR="${PAPERCUSP_FROM_REPO_IDENTITY_DIR_A:-$MACHINE_IDENTITY_DIR/$P_A_USER}"
B_IDENTITY_DIR="${PAPERCUSP_FROM_REPO_IDENTITY_DIR_B:-$MACHINE_IDENTITY_DIR/$P_B_USER}"
# Resolve configured roots before any credentialed preflight or process launch;
 # equal roots would reintroduce cross-account Hive/Noise key sharing.
A_IDENTITY_DIR="$(readlink -m -- "$A_IDENTITY_DIR")"
B_IDENTITY_DIR="$(readlink -m -- "$B_IDENTITY_DIR")"
[ "$A_IDENTITY_DIR" != "$B_IDENTITY_DIR" ] || {
  echo "FATAL: A/B identity roots resolve to the same directory ($A_IDENTITY_DIR) — refusing cross-instance key sharing"
  exit 8
}
# Give these same-machine processes stable, distinct transport identities via
# the supported multi-process escape hatch (the content-matrix sibling does the
# same under WI-38088).
FROMREPO_SWARM_ID_A="${PAPERCUSP_FROM_REPO_SWARM_ID_A:-fromrepo-$P_A_USER-a}"
FROMREPO_SWARM_ID_B="${PAPERCUSP_FROM_REPO_SWARM_ID_B:-fromrepo-$P_B_USER-b}"
OPERATOR_DIR="${PAPERCUSP_OPERATOR_DIR:-/home/builduser/papercupai-workspace/papercusp/apps/operator}"
DISPLAY_NUM="${PAPERCUSP_SMOKE_DISPLAY:-151}"
WORK="$(mktemp -d /tmp/hive-fromrepo-smoke.XXXXXX)"
PKG="$WORK/pkg"; BIN="$PKG/usr/bin/papercusp-desktop"
A_HOME="$WORK/inst-a"; B_HOME="$WORK/inst-b"
FED_LOG[a]="$WORK/a.log"; FED_LOG[b]="$WORK/b.log"
SIDECAR_SNAPSHOT=""
log() { fed_log "$@"; }

bank_instance_logs() {
  local dst="${PAPERCUSP_SMOKE_LOG_BANK_DIR:-}" f n=0
  [ -n "$dst" ] || return 0
  mkdir -p "$dst" 2>/dev/null || return 0
  for f in "${FED_LOG[a]}" "${FED_LOG[b]}"; do
    [ -f "$f" ] || continue
    cp -p "$f" "$dst/" 2>/dev/null && n=$((n + 1))
  done
  log "banked $n from-repo instance log(s) -> $dst"
}
cleanup() {
  # WI-40008: several load-bearing failures exit before the final verdict block
  # (boot/readiness/create are examples). The old preservation helper lived only
  # in that final block, so the EXIT cleanup deleted both serve logs precisely
  # when they were needed. Bank at the one exit path every branch shares.
  bank_instance_logs
  log "cleanup (scoped to $WORK)"
  cleanup_rc=0
  fed_cleanup_scoped "$WORK" || cleanup_rc=$?
  # Keep the snapshot only when scoped process cleanup failed: deleting a
  # bundle still used by a surviving sidecar would recreate the same
  # mid-run-destruction class this snapshot is meant to prevent.
  if [ -n "${SIDECAR_SNAPSHOT:-}" ]; then
    if [ "$cleanup_rc" -eq 0 ]; then
      rm -rf -- "$SIDECAR_SNAPSHOT"
    else
      log "preserving sidecar snapshot after cleanup refusal: $SIDECAR_SNAPSHOT"
    fi
  fi
}
trap cleanup EXIT

# ── tokens (distinct identities — same pair as every two-instance smoke) ───────
A_TOKEN="$(gh auth token --user "$P_A_USER" 2>/dev/null)" || true
B_TOKEN="$(gh auth token --user "$P_B_USER" 2>/dev/null)" || true
[ -n "$A_TOKEN" ] && [ -n "$B_TOKEN" ] || { echo "FATAL: need gh tokens for $P_A_USER + $P_B_USER (gh auth login). Every leg needs A's; B's discovery/offer/join legs need B's."; exit 1; }

# WI-40905: the direct witness used to omit live-federation-gate's credentialed
# REST preflight. A quota-exhausted B then stayed local-only, but only after the
# script had booted two sidecars and waited through discovery did it report a
# product-shaped federation red. Reuse the shared gate helper before any DHT or
# sidecar starts; the existing GATE_SKIP_GH_PREFLIGHT escape hatch remains the
# one explicit override for both entrypoints.
if [ "${GATE_SKIP_GH_PREFLIGHT:-0}" != 1 ]; then
  GH_PREFLIGHT_OUTPUT="$(preflight_github_rest_accounts "$REPO_URL" 2>&1)"
  GH_PREFLIGHT_RC=$?
  printf '%s\n' "$GH_PREFLIGHT_OUTPUT"
  if [ "$GH_PREFLIGHT_RC" -ne 0 ]; then
    echo "FATAL: credentialed GitHub REST unhealthy for a smoke identity — refusing a product-shaped federation verdict before rig launch"
    exit 8
  fi
fi

# Prove + persist the exact device bindings the directory verifier will require
# before boot.  Fresh per-run HOMEs otherwise depend on boot-time gist discovery;
# a quota failure there announces UNATTESTED and spends the entire rig on a
# deterministic admission rejection (EI-21239383769017696).
fed_preflight_attestation_account "$P_A_USER" "$A_TOKEN" "$DESKTOP_DIR/.." "$A_IDENTITY_DIR" || exit 8
fed_preflight_attestation_account "$P_B_USER" "$B_TOKEN" "$DESKTOP_DIR/.." "$B_IDENTITY_DIR" || exit 8

# ── from-repo support gate (the directory smoke's static-grep pattern) ─────────
# An older serve.mjs silently 404s POST /harness/pots/from-repo and announces
# without member_repos (B's offer leg can never hit) — fail fast instead.
assert_serve_supports_from_repo() {
  local serve="$1" label="$2"
  for marker in 'pots/from-repo' 'member_repos' 'PAPERCUSP_DHT_BOOTSTRAP' 'createDirectoryGossip'; do
    grep -q "$marker" "$serve" 2>/dev/null || {
      echo "✗ $label serve.mjs lacks '$marker' — built before hive-from-github-url P-003/P-006; rebuild it"
      return 1
    }
  done
  # Re-key witness staleness gate (WITNESS_PROBE / re-key flag only — a plain smoke is
  # unaffected). The join-time grant SEAM (Seam 2 boot.ts open-mode admit) landed AFTER the re-key
  # MODULES, so a build can carry grantEpochKeysToMembers (the function) yet never populate membership
  # at join → a joiner gets 0 epoch keys → K0 fails on a STALE BUILD, not on re-key logic (the
  # 2026-06-20 false-FAIL trap). MARKER MUST SURVIVE BUNDLING: esbuild strips COMMENTS but this build
  # is NOT minified, so a stable function IDENTIFIER survives verbatim too.
  #
  # WI-280 (2026-06-20): the open-mode admit seam was first fixed to route through upsertHiveMember
  # directly (the original marker here was the `open-mode admit upsertHiveMember` string literal from
  # that commit's catch-block log line). WI-639+WI-1585 (landed after) SUPERSEDED that with a proper
  # policy-gated seam — admitAnnouncedPeerAsOwner → ownerAdmitOrPend → upsertHiveMember (open/allowlisted
  # → upsert; approval → federated pending-join; banned → refuse) — and reworded the catch's log line in
  # the process, silently invalidating the old string-literal marker (false-negative discovered 2026-07-02:
  # a freshly-rebuilt, functionally-correct sidecar still failed this gate). The marker is now the
  # `admitAnnouncedPeerAsOwner` function identifier — present only once the WI-280/WI-639/WI-1585
  # admit-seam wiring has landed (the pre-fix code called a bare grantEpochKeysToMembers with no such
  # function in the call chain).
  if [ "${WITNESS_PROBE:-0}" = 1 ] || [ -n "${PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY:-}" ]; then
    if ! grep -qaF 'admitAnnouncedPeerAsOwner' "$serve" 2>/dev/null; then
      echo "✗ $label serve.mjs lacks the WI-280/WI-639/WI-1585 admit-seam membership upsert (identifier 'admitAnnouncedPeerAsOwner') — built before the membership-population fix; rebuild it (cd papercusp-desktop && bin/build-desktop-sidecar.sh) for the re-key witness"
      return 1
    fi
    echo "✓ $label serve.mjs carries the WI-280 join-time membership+grant seam (witness static check)"
    # WI-37144/WI-37195 (2026-08-09): the K2 owner gate must be the TRI-STATE one. Pre-fix,
    # hive-revoke-contributor.ts gated on `loadHivePubkey(...) !== null`, which FLATTENS "no key
    # held" and "a key is here but unreadable" into a single `not_owner` — so a K2 FAIL could not
    # say which, and the two have opposite remediations. Marker: `owner_key_unreadable`, a runtime
    # CODE STRING literal (hive-revoke-contributor.ts:209), so it survives esbuild minification.
    #
    # This guard exists because the failure it prevents ALREADY COST A RUN. The smoke script does
    # NOT build the sidecar — it only asserts serve.mjs EXISTS (see the FATAL below) — so a bundle
    # predating an operator-core fix is used silently. On 2026-08-09 a witness probe ran against a
    # bundle built 02:27Z, ~7h before the fix, and dutifully printed `not_owner`: a well-formed,
    # confident answer measured against code that no longer exists. Nothing looked wrong.
    # An existence check is not a freshness check.
    if ! grep -qaF 'owner_key_unreadable' "$serve" 2>/dev/null; then
      echo "✗ $label serve.mjs lacks the WI-37195 tri-state owner gate (string 'owner_key_unreadable') — built before that fix, so K2 will report a FLATTENED 'not_owner' that cannot distinguish no-key from unreadable-key; rebuild it (cd papercusp-desktop && bin/build-desktop-sidecar.sh) for the re-key witness"
      return 1
    fi
    echo "✓ $label serve.mjs carries the WI-37195 tri-state owner gate (witness static check)"
    # WI-6266: K4b is a CONTENT-UNDECRYPTABILITY witness only when B proves the
    # encrypted F-RKCUT op reached its decrypt gate. A bundle without this trace
    # can prove only content non-arrival, which is a different property.
    if ! grep -qaF 'epoch_gate_seen' "$serve" 2>/dev/null; then
      echo "✗ $label serve.mjs lacks the WI-6266 epoch-gate arrival trace (string 'epoch_gate_seen') — K4b cannot distinguish ciphertext deferral from non-arrival; rebuild it (cd papercusp-desktop && bin/build-desktop-sidecar.sh) for the re-key witness"
      return 1
    fi
    echo "✓ $label serve.mjs carries the WI-6266 epoch-gate arrival trace (witness static check)"
  fi
  # Moderation-witness staleness gate (MODERATION_PROBE only). The EN-3 report backend must be
  # present or LEG 2 false-FAILs on an OLD build (report route absent → no-op). Marker survives
  # minification: 'reporting_not_enabled' is a CODE STRING literal in agent-tools/hive/report.ts
  # (esbuild strips comments but keeps string literals), emitted only once the moderation tools
  # (hive:takedown / hive:report / hive:moderation_queue) landed.
  if [ "${MODERATION_PROBE:-0}" = 1 ]; then
    if ! grep -qaF 'reporting_not_enabled' "$serve" 2>/dev/null; then
      echo "✗ $label serve.mjs lacks the EN-3 moderation report backend (string 'reporting_not_enabled') — built before the moderation tools; rebuild it (cd papercusp-desktop && bin/build-desktop-sidecar.sh) for the moderation witness"
      return 1
    fi
    echo "✓ $label serve.mjs carries the EN-3 moderation backend (witness static check)"
  fi
  echo "✓ $label serve.mjs carries the from-repo backend (static check)"
}

# ── resolve mode ────────────────────────────────────────────────────────────────
resolve_mode() {
  case "$MODE" in
    deb) echo deb ;;
    sidecar) echo sidecar ;;
    auto)
      if [ -f "$DEB" ]; then
        # Peek at the packaged serve.mjs without a full extract.
        mkdir -p "$WORK/debpeek"
        ( cd "$WORK/debpeek" && dpkg-deb --fsys-tarfile "$DEB" 2>/dev/null | tar -x --wildcards 'usr/lib/*/sidecar/serve.mjs' 2>/dev/null ) || true
        if assert_serve_supports_from_repo "$(find "$WORK/debpeek/usr/lib" -name serve.mjs 2>/dev/null | head -1)" ".deb" >/dev/null 2>&1; then
          rm -rf "$WORK/debpeek"; echo deb; return
        fi
        rm -rf "$WORK/debpeek"
        echo "auto: on-disk .deb predates the from-repo backend → SIDECAR-BUNDLE FALLBACK (same serve.mjs artifact, no Tauri window)" >&2
      else
        echo "auto: no .deb at $DEB → SIDECAR-BUNDLE FALLBACK" >&2
      fi
      echo sidecar ;;
    *) echo "FATAL: HIVE_SMOKE_MODE must be auto|deb|sidecar" >&2; exit 1 ;;
  esac
}
RUN_MODE="$(resolve_mode)" || exit 1
echo "mode=$RUN_MODE  repo=$REPO_URL  cupboard=$CUPBOARD_URL (isolated)"

# ── sidecar-mode launcher (the fed_local_launch analog for `node serve.mjs`) ───
# Mirrors what Tauri main.rs spawns (serve.mjs owns embedded-PG + migrations +
# the Hono host): isolated HOME, shared gh config (announce identity), bundled
# node + gh first on PATH, explicit per-instance ports. SIDECAR_SRC is rewritten
# to the per-run snapshot below before this launcher is called. The trailing
# "$WORK" argv is the cleanup marker (serve.ts ignores unknown args;
# fed_cleanup_scoped greps ps args for $WORK — same trick as fed_start_testnet_dht).
SC_NODE="$SIDECAR_SRC/bin/node"; [ -x "$SC_NODE" ] || SC_NODE="$(command -v node)"
sc_launch() {
  local home="$1" logf="$2" hono_port="$3" pg_port="$4"; shift 4
  mkdir -p "$home/.config" "$home/.papercusp"
  ln -sf "$HOME/.config/gh" "$home/.config/gh"
  ln -sf "$HOME/.gitconfig" "$home/.gitconfig" 2>/dev/null || true
  # This local launcher is headless and intentionally detaches from its
  # short-lived shell; opt out of the real-desktop parent-death watch so
  # expected reparenting cannot self-terminate the witness.
  ( cd "$SIDECAR_SRC"
    # r7 fix (EI-13590/WI-953, 2026-07-17): this local sc_launch had drifted from
    # the canonical fed_local_launch_sidecar() in federation-asserts.sh in two
    # ways that BOTH matter here — (1) it never forced PAPERCUSP_BACKGROUND_WORKERS=1,
    # so an ambient PAPERCUSP_BACKGROUND_WORKERS=0 in the CALLING shell (present on
    # this box) leaks through `env` (unlisted vars are inherited, not cleared) and
    # makes requestOnlyHost() true for BOTH instances — wireHiveDirectoryForWorkspace
    # then silently no-ops (background-workers.ts / hive-directory-boot.ts:436), so
    # setHiveDirectoryTransport() NEVER runs and every announce throws "device
    # keychain not wired" (hive-directory-deps.ts:68). This is the CONFIRMED root
    # cause of r5's and r6's identical announced:false — decisively fingerprinted via
    # the publish.error diagnostic added earlier this session, NOT a swarm-timing
    # race. (2) it never scrubbed the shared-native-PG env vars the canonical helper
    # scrubs (-u DATABASE_URL etc, the WI-1666 leak class) — also present ambiently
    # on this box; scrubbing defensively even though today's failure didn't trace to it.
    # r8 fix (2026-07-17, same leak CLASS as EI-13590/(1) above, third instance):
    # neither this local sc_launch NOR the canonical fed_local_launch_sidecar()
    # ever scrubbed PAPERCUSP_HOME. Every su/dev session on this box has
    # PAPERCUSP_HOME set ambiently (its own per-workspace operator home, e.g.
    # ~/.papercusp-workspaces/<ws>/.papercusp) — `env` inherits any var not
    # explicitly listed, so it leaked straight through HOME="$home" below.
    # serve.ts's PAPERCUSP_DIR = process.env.PAPERCUSP_HOME || homedir()+".papercusp"
    # (apps/operator/bin/serve.ts:96) prefers PAPERCUSP_HOME OVER the isolated
    # HOME override, so BOTH instances A and B silently shared the calling
    # session's REAL, LIVE operator home instead of their own isolated $home —
    # defeating isolation entirely (the exact "half isolation" class the
    # PAPERCUSP_DIR docblock at serve.ts:85-95 warns about, EI-13917's sibling
    # incident). Confirmed live: A's cold-start wrote operator.lock +
    # operator-port.json{port:18071} into the SHARED ambient PAPERCUSP_HOME dir;
    # B's resolveStickyPort (serve.ts:423, gated on PAPERCUSP_DESKTOP=1, which
    # this launch sets) then read that shared port back and tried to re-bind
    # onto A's already-live port/lock in the SAME shared dir — "another `serve`
    # holds the cold-start lock; aborting". 100% reproducible (2 independent r8
    # attempts, byte-identical failure) until -u PAPERCUSP_HOME below; verified
    # fixed via a standalone single-instance manual repro (same env, add the -u,
    # the spurious "re-binding remembered operator port" log + lock collision
    # both vanish). This is genuinely UNRELATED to WI-5061/not_owner_swarm — it
    # is a boot-level isolation leak that stops the smoke before it ever reaches
    # the moderation legs, not a semantic moderation-federation failure.
    env -u DATABASE_URL -u PAPERCUSP_DATABASE_URL \
        -u HARNESS_DATABASE_URL -u HARNESS_ADMIN_DATABASE_URL \
        -u PAPERCUSP_HOME \
        HOME="$home" \
        PATH="$SIDECAR_SRC/bin:$(dirname "$(command -v node)"):$PATH" \
        NODE_ENV=production PAPERCUSP_DESKTOP=1 \
        PAPERCUSP_PARENT_DEATH_WATCH=0 \
        PAPERCUSP_BIND_HOST=127.0.0.1 HOSTNAME=127.0.0.1 \
        PAPERCUSP_BACKGROUND_WORKERS=1 \
        PAPERCUSP_DHT_HOST= \
        PAPERCUSP_DHT_BOOTSTRAP= \
        PAPERCUSP_HONO_PORT="$hono_port" PAPERCUSP_PG_PORT="$pg_port" \
        PAPERCUSP_PG_DATA_DIR="$home/.papercusp/embedded-pg-data" \
        PAPERCUSP_PG_SQL_DIR="$SIDECAR_SRC/db-sql" \
        PAPERCUSP_HARNESS_DIR="$SIDECAR_SRC/harness" \
        PAPERCUSP_PROMPTS_DIR="$SIDECAR_SRC/prompts" \
        PAPERCUSP_DOCS_ROOT="$SIDECAR_SRC/internal-docs" \
        PAPERCUSP_SPA_DIST="$SIDECAR_SRC/spa" \
        PAPERCUSP_SERVE_UI=0 \
        "$@" \
        setsid nohup "$SC_NODE" "$SIDECAR_SRC/serve.mjs" "$WORK" >"$logf" 2>&1 < /dev/null ) &
  FED_KILL_PIDS+=("$!")
}
pick_free_port() { fed_pick_free_port "$@"; }   # canonical impl lives in federation-asserts.sh (WI-754)

# ── stage the instances (per mode) ──────────────────────────────────────────────
if [ "$RUN_MODE" = deb ]; then
  log "extract $DEB"
  fed_extract_deb "$DEB" "$PKG" || exit 1
  fed_clobber_check "$PKG" || exit 2
  fed_assert_deb_swarm_support "$PKG" || exit 2
  assert_serve_supports_from_repo "$(fed_sidecar_dir "$PKG")/serve.mjs" ".deb" || exit 2
  fed_fresh_display "$DISPLAY_NUM" "$WORK" || exit 1
else
  SIDECAR_SOURCE="$SIDECAR_SRC"
  SIDECAR_SNAPSHOT_PARENT="${PAPERCUSP_SMOKE_SIDECAR_SNAPSHOT_PARENT:-$(dirname "$DESKTOP_DIR")/.papercusp-smoke-snapshots}"
  if ! mkdir -p "$SIDECAR_SNAPSHOT_PARENT" 2>/dev/null; then
    SIDECAR_SNAPSHOT_PARENT="$WORK"
    log "sidecar snapshot parent is not writable; falling back to per-run work dir: $SIDECAR_SNAPSHOT_PARENT"
  fi
  SIDECAR_SNAPSHOT="$SIDECAR_SNAPSHOT_PARENT/${WORK##*/}"
  log "sidecar-bundle fallback: snapshot $SIDECAR_SOURCE under its reader lock (the artifact the .deb ships, minus the Tauri window)"
  [ -f "$SIDECAR_SOURCE/serve.mjs" ] || { echo "FATAL: $SIDECAR_SOURCE/serve.mjs missing — run bin/build-desktop-sidecar.sh"; exit 2; }
  if ! fed_snapshot_sidecar_bundle "$SIDECAR_SOURCE" "$SIDECAR_SNAPSHOT" \
      "${PAPERCUSP_SMOKE_SIDECAR_LOCK:-}" \
      "${PAPERCUSP_SMOKE_SIDECAR_LOCKDIR:-}" \
      "${PAPERCUSP_SMOKE_SIDECAR_LOCK_WAIT_SEC:-3600}"; then
    echo "FATAL: could not establish an immutable per-run sidecar snapshot from $SIDECAR_SOURCE" >&2
    exit 2
  fi
  SIDECAR_SRC="$SIDECAR_SNAPSHOT"
  SC_NODE="$SIDECAR_SRC/bin/node"; [ -x "$SC_NODE" ] || SC_NODE="$(command -v node)"
  log "sidecar-bundle snapshot ready: $SIDECAR_SRC"
  [ -f "$SIDECAR_SRC/serve.mjs" ] || { echo "FATAL: snapshot $SIDECAR_SRC/serve.mjs missing"; exit 2; }
  [ -d "$SIDECAR_SRC/node_modules/@papercusp/embedded-postgres-server" ] || { echo "FATAL: sidecar bundle lacks embedded-postgres-server — incomplete build"; exit 2; }
  assert_serve_supports_from_repo "$SIDECAR_SRC/serve.mjs" "sidecar" || exit 2
fi

# ── local testnet DHT (deterministic same-box discovery) ───────────────────────
BOOTSTRAP="$(fed_start_testnet_dht "$OPERATOR_DIR" "$WORK")" || exit 3
echo "PAPERCUSP_DHT_BOOTSTRAP=$BOOTSTRAP"

# Witness: propagate the re-key flag to BOTH instances when set in this rig's env (per-flag
# override, wins; no global PostHog flip → no fleet blip). Empty array ⇒ no-op when unset
# (the rig stays a plain smoke). Required for the P-008 re-key cut + the live AK content leg.
REKEY_ENV=(); [ -n "${PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY:-}" ] && REKEY_ENV=(PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY="$PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY")

# ── launch two isolated instances with distinct identities ─────────────────────
log "launch A ($P_A_USER) + B ($P_B_USER) [$RUN_MODE]"
if [ "$RUN_MODE" = deb ]; then
  fed_local_launch "$A_HOME" "${FED_LOG[a]}" "$BIN" "$DISPLAY_NUM" GH_TOKEN="$A_TOKEN" PAPERCUSP_GITHUB_LOGIN="$P_A_USER" PAPERCUSP_IDENTITY_DIR="$A_IDENTITY_DIR" PAPERCUSP_SWARM_IDENTITY_ID="$FROMREPO_SWARM_ID_A" PAPERCUSP_DHT_BOOTSTRAP="$BOOTSTRAP" PAPERCUSP_CUPBOARD_URL="$CUPBOARD_URL" "${REKEY_ENV[@]}"
  fed_local_launch "$B_HOME" "${FED_LOG[b]}" "$BIN" "$DISPLAY_NUM" GH_TOKEN="$B_TOKEN" PAPERCUSP_GITHUB_LOGIN="$P_B_USER" PAPERCUSP_IDENTITY_DIR="$B_IDENTITY_DIR" PAPERCUSP_SWARM_IDENTITY_ID="$FROMREPO_SWARM_ID_B" PAPERCUSP_DHT_BOOTSTRAP="$BOOTSTRAP" PAPERCUSP_CUPBOARD_URL="$CUPBOARD_URL" "${REKEY_ENV[@]}"
else
  A_HONO="$(pick_free_port 18071)"; A_PG="$(pick_free_port 18532)"
  sc_launch "$A_HOME" "${FED_LOG[a]}" "$A_HONO" "$A_PG" GH_TOKEN="$A_TOKEN" PAPERCUSP_GITHUB_LOGIN="$P_A_USER" PAPERCUSP_IDENTITY_DIR="$A_IDENTITY_DIR" PAPERCUSP_SWARM_IDENTITY_ID="$FROMREPO_SWARM_ID_A" PAPERCUSP_DHT_BOOTSTRAP="$BOOTSTRAP" PAPERCUSP_CUPBOARD_URL="$CUPBOARD_URL" "${REKEY_ENV[@]}"
  B_HONO="$(pick_free_port $((A_HONO + 1)))"; B_PG="$(pick_free_port $((A_PG + 100)))"
  sc_launch "$B_HOME" "${FED_LOG[b]}" "$B_HONO" "$B_PG" GH_TOKEN="$B_TOKEN" PAPERCUSP_GITHUB_LOGIN="$P_B_USER" PAPERCUSP_IDENTITY_DIR="$B_IDENTITY_DIR" PAPERCUSP_SWARM_IDENTITY_ID="$FROMREPO_SWARM_ID_B" PAPERCUSP_DHT_BOOTSTRAP="$BOOTSTRAP" PAPERCUSP_CUPBOARD_URL="$CUPBOARD_URL" "${REKEY_ENV[@]}"
fi

fed_wait_boot a 60 || { echo "A boot failed: $FED_BOOT_ERR"; tail -20 "${FED_LOG[a]}"; exit 4; }
fed_wait_boot b 60 || { echo "B boot failed: $FED_BOOT_ERR"; tail -20 "${FED_LOG[b]}"; exit 4; }
log "A: PG=${FED_PG[a]} sc=${FED_SC[a]} | B: PG=${FED_PG[b]} sc=${FED_SC[b]}"
fed_assert_isolated a b || exit 5
# WI-5641: don't override fed_wait_api's own default (60 tries*2s=120s, EI-521 —
# embedded-PG init + ~500 migrations + owner-bootstrap can exceed a 60s budget).
# A hardcoded 30 here re-introduces the exact boot-readiness flake EI-521 fixed.
fed_wait_api a || { echo "A sidecar API never came up"; exit 4; }
fed_wait_api b || { echo "B sidecar API never came up"; exit 4; }

# (re-key witness, su-9140a 2026-06-19): the env recipe PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY=1 does NOT
# engage getFlag(HIVE_REKEY) on the packaged binary (verified: owner had 0 hive_epoch_keys). Flip the
# flag for real via the loopback /api/flags/set route (persists an override getFlag reads + publishes the
# change) on BOTH instances, BEFORE the create so the owner's epoch initializes with the re-key on. Gated
# on the same env so non-rekey runs are untouched.
if [ -n "${PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY:-}" ]; then
  for inst in a b; do
    r="$(curl -s -m 10 -X POST "http://127.0.0.1:${FED_SC[$inst]}/api/flags/set" -H 'content-type: application/json' -d '{"key":"papercusp-hive-rekey","enabled":true}' || true)"
    echo "  [rekey-flag] $inst /api/flags/set papercusp-hive-rekey=true → $r"
  done
fi

# ── helpers ─────────────────────────────────────────────────────────────────────
dir_list() { curl -s -m 10 "http://127.0.0.1:${FED_SC[$1]}/api/discovery/pots"; }

# from_repo <inst> [extra-json-fields] — POST the create/lookup composition.
# shallow + runTests:false keep the create light; route timeoutSec is 600.
from_repo() {
  local inst="$1"
  curl -s -m 610 -X POST "http://127.0.0.1:${FED_SC[$inst]}/api/harness/pots/from-repo" \
    -H 'content-type: application/json' \
    -d "{\"githubUrl\":\"$REPO_URL\",\"visibility\":\"public\",\"runTests\":false,\"shallow\":true}"
}

# jget <json> <python-expr over d> — tiny JSON probe (template's python3 style).
jget() { printf '%s' "$1" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
try: print($2)
except Exception: pass
" 2>/dev/null; }

# mcp_call <inst> <tool> <json-args> — MCP-over-HTTP tool call to an instance (JSON-RPC;
# superuser=1 needs loopback + a valid bearer). The sidecar ensures
# $HOME/.papercusp/superuser-token (mode 0600) on boot (desktop-install/papercusp-files.ts),
# so each isolated instance HOME carries its own. Shared by the WITNESS_PROBE + MODERATION_PROBE
# rider blocks below.
mcp_call() {
  local inst="$1" tool="$2" args="$3" home tok
  [ "$inst" = a ] && home="$A_HOME" || home="$B_HOME"
  tok="$(cat "$home/.papercusp/superuser-token" 2>/dev/null || true)"
  curl -s -m 60 -X POST "http://127.0.0.1:${FED_SC[$inst]}/api/mcp?superuser=1&client=witness" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    ${tok:+-H "Authorization: Bearer $tok"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
}

# boot_history_get <inst> <comma-separated-kinds> — authenticated read
# of the instance-local epoch trace. Under SUBSTRATE_SIDECAR the admin route
# proxies to that sidecar's in-memory ring, which is where the decrypt gate runs.
boot_history_get() {
  local inst="$1" kinds="$2" home tok
  [ "$inst" = a ] && home="$A_HOME" || home="$B_HOME"
  tok="$(cat "$home/.papercusp/superuser-token" 2>/dev/null || true)"
  [ -n "$tok" ] || return 1
  curl -sS -m 30 \
    "http://127.0.0.1:${FED_SC[$inst]}/api/admin/dogfood-substrate-boot-history?kinds=$kinds&limit=500" \
    -H "Authorization: Bearer $tok"
}

# ── 0. pre-create A↔B swarm peering gate (EI-13590 r6 fix, 2026-07-17) ──────────
# r5 found create=PASS / announced=FAIL (reachablePeers:0): this smoke goes
# fed_wait_boot → fed_wait_api → from_repo with NO peering wait, so A's swarm can
# still be mid-dial to the DHT when the create-time announce flush runs (0 peers
# to announce to). Every other federation smoke waits for [swarm] peer_connected
# before its first assert (two-instance-hive-directory-smoke.sh ~90s,
# deb-hetzner-federation.sh ~210s) — this one never did. Bounded wait (~120s,
# same fed_wait_discovery primitive those use); a miss is LOUD (both swarm-log
# tails) but NON-FATAL — firing create on a still-unpeered swarm anyway is itself
# the datapoint under test (does create-time announce ever retry product-side?
# tracked separately, not fixed in this script).
log "wait: A↔B swarm peering BEFORE create (≤120s) — r5 exposed this race unguarded"
prepeer_ok="$(fed_wait_discovery a b strict 40 || true)"
if [ "$prepeer_ok" = 1 ]; then
  echo "✓ A↔B peered before create"
elif [ "$prepeer_ok" = skip ]; then
  # EI-18687938054040755: skip = this build predates the peer_data_path_up emitter,
  # so pre-peering was never MEASURED. Reporting that as "did NOT peer" narrates an
  # UNMEASURED leg as a failure. Non-fatal either way — prepeer_ok is deliberately
  # NOT part of OVERALL (the create-time announce race is what this rig tests), so
  # this is an honesty fix to the report, not a scoring fix. (leader, WI-6012)
  echo "⊘ A↔B pre-peering N/A — this build predates the peer_data_path_up emitter, so it was never measured (EI-18687938054040755) — proceeding (non-fatal, not part of OVERALL)"
else
  echo "⚠ A↔B did NOT peer within ~120s before create — proceeding anyway (the create-time announce race is what r6 is testing)"
  echo "--- A [swarm] tail ---"; grep -aE '\[swarm\]' "${FED_LOG[a]}" 2>/dev/null | tail -15
  echo "--- B [swarm] tail ---"; grep -aE '\[swarm\]' "${FED_LOG[b]}" 2>/dev/null | tail -15
fi

# ── 1. A creates a PUBLIC hive from the fixture repo ────────────────────────────
log "A ($P_A_USER): POST /api/harness/pots/from-repo ($REPO_URL, public, runTests:false, shallow)"
a_resp="$(from_repo a)"
echo "A create → $(echo "$a_resp" | head -c 600)"
A_OK="$(jget "$a_resp" "d['ok'] and 'created' in d")"
HIVE_SLUG="$(jget "$a_resp" "d['created'].get('potSlug') or d['created'].get('hiveSlug') or ''")"  # renamed hiveSlug→potSlug; accept both for skew
MEMBER_SLUG="$(jget "$a_resp" "d['created']['memberSlug']")"
# WI-5472: thread the pot's home slug through as RIG_HIVE_ID so fed_hive_merge_probe /
# fed_coord_merge_probe use the pot_home_slug-scoped workspace_id lookup (works on BOTH
# owner and joiner frames) instead of the origin='local' fallback heuristic, which
# structurally can never match a JOINER's own membership row (authored by the owner,
# federates in as 'remote') — without this, every B→A merge probe below fails loud with
# "could not resolve a real workspace_id", not because federation is broken but because
# this script (unlike the deb-hetzner-rig.sh family) never set RIG_HIVE_ID.
export RIG_HIVE_ID="$HIVE_SLUG"
A_ANNOUNCED="$(jget "$a_resp" "d['publish']['announced']")"
A_UNVERIFIED="$(jget "$a_resp" "d['bindingUnverified']")"
# WI-953 checkpoint + EI-13590 both flagged that the head -c 600 echo above cuts
# off BEFORE the publish.error field (hive-publish-from-repo.ts:558 surfaces a
# thrown-and-caught announce exception there — for a PUBLIC hive that's the ONLY
# way announced comes back false) — so a bare 'announced=FAIL' never told anyone
# WHY. Pull it explicitly.
A_ANNOUNCE_ERR="$(jget "$a_resp" "(d.get('publish') or {}).get('error') or ''")"
if [ "$A_ANNOUNCED" != "True" ] && [ -n "$A_ANNOUNCE_ERR" ]; then
  echo "  [announce-error] publish.error = $A_ANNOUNCE_ERR"
fi
create_ok=0; [ "$A_OK" = "True" ] && [ -n "$HIVE_SLUG" ] && [ -n "$MEMBER_SLUG" ] && create_ok=1
if [ "$create_ok" = 1 ]; then
  echo "✓ A created hive='$HIVE_SLUG' member='$MEMBER_SLUG' from $REPO_URL"
else
  # EI-7045/EI-7083: 'existing' in the response (instead of 'created') means the
  # from-repo API took the JOIN-OFFER path, not a hard failure — the fixture repo's
  # hive is already announced, either by (a) a PRIOR run of this smoke against the
  # same URL (the anchor persists GitHub-side across local instance-home wipes —
  # see the REPO_URL comment above), or (b) ANOTHER REACHABLE RIG on the same
  # testnet DHT running this same fixture concurrently (repeatable whenever ≥2
  # rigs smoke the same repo on the same box at once). Either way the fix is the
  # same: point HIVE_SMOKE_REPO_URL at a distinct/disposable repo, not to loosen
  # this assertion — the downstream publish.announced/bindingUnverified/cupboard
  # checks below only exist on the CREATE path's response shape, so a join-offer
  # genuinely can't continue this smoke.
  EXISTING_KIND="$(jget "$a_resp" "(d.get('existing') or {}).get('kind')")"
  if [ -n "$EXISTING_KIND" ]; then
    echo "✗ A create returned an EXISTING '$EXISTING_KIND' (join-offer), not a fresh create — body above"
    echo "  → this repo's hive is already announced (a prior run of this smoke against $REPO_URL, or another concurrent rig on the same DHT)."
    echo "  → fix: re-run with HIVE_SMOKE_REPO_URL=<a repo you have not smoked before / no other rig is using>."
  else
    echo "✗ A create failed (ok/created missing) — body above"
  fi
fi
announce_ok=0; [ "$A_ANNOUNCED" = "True" ] && announce_ok=1
[ "$announce_ok" = 1 ] && echo "✓ A publish.announced=true (signed announce on the directory topic, testnet transport)" \
                       || echo "✗ A publish.announced != true (got: $A_ANNOUNCED)"
degraded_ok=0; [ "$A_UNVERIFIED" = "True" ] && degraded_ok=1
[ "$degraded_ok" = 1 ] && echo "✓ A bindingUnverified=true (Cupboard at $CUPBOARD_URL unreachable → documented directory-only degradation, create still succeeded)" \
                       || echo "✗ A bindingUnverified != true (got: $A_UNVERIFIED) — the live Cupboard may have been reached!"
echo "  (cupboard leg outcome: $(jget "$a_resp" "json.dumps(d['publish'].get('cupboard'))") — rows must NOT have been created on the live worker)"
[ "$create_ok" = 1 ] || { echo "cannot continue without a created hive"; exit 6; }

# ── 2. B discovers A's hive via the directory (announce over the testnet) ──────
log "B ($P_B_USER): poll GET /api/discovery/hives for '$HIVE_SLUG' (≤$(( ${DISCOVERY_RETRIES:-40} * 3 ))s)"
discover_ok=0; links_ok=0; B_ROW=""
for i in $(seq 1 ${DISCOVERY_RETRIES:-40}); do
  body="$(dir_list b)"
  B_ROW="$(jget "$body" "json.dumps(next(r for r in d['rows'] if r['potId']=='$HIVE_SLUG'))")"  # row key renamed hiveId→potId (discovery-hive-rows.ts)
  [ -n "$B_ROW" ] && { discover_ok=1; break; }
  sleep 3
done
if [ "$discover_ok" = 1 ]; then
  echo "✓ B discovered '$HIVE_SLUG' in its directory: $(echo "$B_ROW" | head -c 300)"
  N_LINKS="$(jget "$B_ROW" "len(d.get('memberLinks') or [])")"
  [ -n "$N_LINKS" ] && [ "$N_LINKS" -ge 1 ] && links_ok=1
  [ "$links_ok" = 1 ] && echo "✓ B's listing carries $N_LINKS memberLink(s)" \
                      || echo "✗ B's listing has no memberLinks"
  echo "  (note: the /api/discovery/hives projection does not expose memberRepos — the announce's member_repos leg is proven by the join-offer below, which matches via hiveMatchesRepo(memberRepos))"
else
  echo "✗ '$HIVE_SLUG' never appeared in B's directory (~120s). B directory: $(dir_list b | head -c 400)"
fi

# ── 3. B pastes the SAME repo URL → must get the JOIN OFFER, not a create ───────
offer_ok=0; offer_dir_ok=0; OFFER_LINKS_JSON="[]"
if [ "$discover_ok" = 1 ]; then
  log "B ($P_B_USER): POST the SAME repo URL → expect existing.kind='hive' (join offer, zero side effects)"
  b_resp="$(from_repo b)"
  echo "B from-repo → $(echo "$b_resp" | head -c 600)"
  B_KIND="$(jget "$b_resp" "d['existing']['kind']")"
  B_CREATED="$(jget "$b_resp" "'created' in d")"
  B_SOURCE="$(jget "$b_resp" "d['existing']['source']")"
  B_OFFER_HIVE="$(jget "$b_resp" "d['existing']['hive']['potId']")"  # offer key renamed hiveId→potId (lookup-hive-for-repo.ts HiveHit)
  OFFER_LINKS_JSON="$(jget "$b_resp" "json.dumps(d['existing']['hive'].get('memberLinks') or [])")"
  [ "$B_KIND" = "hive" ] && [ "$B_CREATED" != "True" ] && offer_ok=1
  [ "$offer_ok" = 1 ] && echo "✓ B got the JOIN OFFER (existing.kind='hive', no create)" \
                      || echo "✗ B did not get a join offer (kind=$B_KIND created=$B_CREATED)"
  [ "$B_SOURCE" = "directory" ] && [ "$B_OFFER_HIVE" = "$HIVE_SLUG" ] && offer_dir_ok=1
  [ "$offer_dir_ok" = 1 ] && echo "✓ offer resolved from the DIRECTORY announce for '$HIVE_SLUG' (member_repos repo-id match proven end-to-end)" \
                          || echo "✗ offer source/hive mismatch (source=$B_SOURCE hive=$B_OFFER_HIVE)"
fi

# ── 4. B accepts: the REAL hive Join (POST /api/discovery/join-pot) ──────────────
# This is what the directory panel's "Join" drives — joinHiveAsView, which
# composes the per-member join-link mechanic AND materializes the joiner-side
# hive VIEW (the remote_hive registry entry + hive_slug on every member + the
# remote hive identity row). That materialization is what re-keys the joiner
# onto the OWNER's Hive-pubkey topic so federation actually crosses. Joining the
# bare per-member /api/harness/join-link directly (the old smoke) skips the view,
# leaving the member on the gh:<repo_id> topic while the owner sits on the
# Hive-pubkey topic — different topics, no merge (EI-681).
join_ok=0; clone_ok=0
N_OFFER_LINKS="$(jget "$OFFER_LINKS_JSON" "len(d)")"
if [ "$offer_ok" = 1 ] && [ -n "$N_OFFER_LINKS" ] && [ "$N_OFFER_LINKS" -ge 1 ]; then
  echo "✓ offer carries $N_OFFER_LINKS memberLink(s)"
  log "B ($P_B_USER): JOIN the hive '$HIVE_SLUG' via /api/discovery/join-pot ($N_OFFER_LINKS link(s))"
  join_resp="$(curl -s -m 610 -X POST "http://127.0.0.1:${FED_SC[b]}/api/discovery/join-pot" \
    -H 'content-type: application/json' \
    -d "{\"potId\":\"$HIVE_SLUG\",\"memberLinks\":$OFFER_LINKS_JSON}")"  # body field renamed hiveId→potId (join-pot.ts requires potId)
  echo "B join-hive → $(echo "$join_resp" | head -c 500)"
  J_OK="$(jget "$join_resp" "d.get('ok')")"
  N_MEM="$(jget "$join_resp" "len(d.get('members') or [])")"
  N_MEM_OK="$(jget "$join_resp" "sum(1 for m in (d.get('members') or []) if m.get('ok'))")"
  if [ "$J_OK" = "True" ] && [ -n "$N_MEM_OK" ] && [ "$N_MEM_OK" -ge 1 ]; then
    join_ok=1; clone_ok=1
    echo "✓ join-pot ok:true — $N_MEM_OK/$N_MEM member(s) joined (view materialized: remote_hive + hive_slug + identity)"
  else
    echo "✗ join-pot failed (ok=$J_OK members_ok=$N_MEM_OK/$N_MEM)"
  fi
elif [ "$offer_ok" = 1 ]; then
  echo "✗ offer carries no memberLinks — join leg cannot run"
fi

# ── 5. POST-JOIN MERGE probe (hive-federation-cross-machine-merge P-001) ──────────
# The open question: does a write FEDERATE after a hive join? (No existing test goes
# past join.) Write a feature on A's member harness; poll B for it (origin=remote, any
# slug — the hive model may remap harness_slug across peers). Same-box answers it for $0.
hive_merge_ok=0; hive_rev_ok=0; hive_cont_ok=0; landed_slug=""
if [ "$join_ok" = 1 ]; then
  # (5a) FORWARD owner→joiner: write F-HIVE1 on A, poll B (origin=remote, any
  # slug — the hive model may remap harness_slug across peers).
  log "POST-JOIN MERGE (A→B): write F-HIVE1 on A (member='$MEMBER_SLUG') → poll B (origin=remote)"
  probe="$(fed_hive_merge_probe a b "$MEMBER_SLUG" F-HIVE1 ${MERGE_PROBE_SEC:-40} || true)"
  if [ "${probe%% *}" = 1 ]; then hive_merge_ok=1; landed_slug="${probe#* }"; fi
  if [ "$hive_merge_ok" = 1 ]; then
    echo "✓ A→B: F-HIVE1 federated owner→joiner (landed under harness_slug='$landed_slug')"
  else
    echo "✗ A→B: F-HIVE1 never reached B — the hive merge does NOT apply a peer's writes after join (probe=$probe)"
    echo "===== DIAG: localize the post-join merge failure ====="
    echo "--- A: was F-HIVE1 DRAINED to the log? (drained_at) ---"; drv_psql a "SELECT key||' drained='||(drained_at IS NOT NULL)::text FROM harness_shared.substrate_outbox WHERE table_name='harness_features_consolidated';" 2>/dev/null | tr '\n' ' '; echo
    echo "--- B: any features at all? (did ANYTHING replicate) ---"; drv_psql b "SELECT harness_slug,feature_id,origin FROM harness_shared.harness_features_consolidated;" 2>/dev/null | head
    echo "--- A [swarm]: joined topic / peer_connected (is A on the hive topic?) ---"; grep -aE '\[swarm\] (joined topic|peer_connected|join FAILED)' "${FED_LOG[a]}" 2>/dev/null | tail -6
    echo "--- B [swarm]: joined topic / peer_connected (same topic as A?) ---"; grep -aE '\[swarm\] (joined topic|peer_connected|join FAILED)' "${FED_LOG[b]}" 2>/dev/null | tail -6
    echo "--- B re-key state: hives identity row + remote_hive (did join-pot 2b/2c run?) ---"
    echo "  B hives identity: $(drv_psql b "SELECT pot_home_slug||':'||octet_length(public_key)||'b' FROM harness_shared.pots;" 2>/dev/null | tr '\n' ' ')"
    echo "  B registry remote_hive: $(drv_psql b "SELECT payload::text FROM harness_shared.harness_registry;" 2>/dev/null | grep -oE 'remote_hive[^,]{0,12}' | head -3 | tr '\n' ' ')"
    echo "===== /DIAG ====="
  fi

  # (5b) REVERSE joiner→owner: write F-HIVE2 on B, poll A. Proves the hive
  # federates BIDIRECTIONALLY. The EI-681 re-key fix made the OWNER serve its
  # log core to the joiner; this confirms the JOINER also serves its log to the
  # owner (no residual asymmetry — both sides serve after the in-place re-key).
  log "POST-JOIN MERGE (B→A): write F-HIVE2 on B → poll A (origin=remote)"
  rprobe="$(fed_hive_merge_probe b a "$MEMBER_SLUG" F-HIVE2 40 || true)"
  if [ "${rprobe%% *}" = 1 ]; then hive_rev_ok=1; fi
  [ "$hive_rev_ok" = 1 ] \
    && echo "✓ B→A: F-HIVE2 federated joiner→owner (bidirectional)" \
    || echo "✗ B→A: F-HIVE2 never reached A — federation is one-directional (probe=$rprobe)"

  # (5c) CONTINUOUS: a SECOND forward write must also cross — federation is a
  # LIVE stream, not a one-shot replay at join time.
  log "POST-JOIN MERGE (A→B #2): write F-HIVE3 on A → poll B (continuous federation)"
  cprobe="$(fed_hive_merge_probe a b "$MEMBER_SLUG" F-HIVE3 40 || true)"
  if [ "${cprobe%% *}" = 1 ]; then hive_cont_ok=1; fi
  [ "$hive_cont_ok" = 1 ] \
    && echo "✓ A→B #2: F-HIVE3 federated (continuous — federation is live, not one-shot)" \
    || echo "✗ A→B #2: F-HIVE3 never reached B — federation stalls after the first op (probe=$cprobe)"
else
  echo "· POST-JOIN MERGE probes skipped (join did not complete)"
fi

# ── 5.5 A-003 MEMBERSHIP-CROSSING witness (opt-in: A003_MEMBERSHIP_PROBE=1) ────────
# The signal steps 5a–5c MISS: do the hive-HOME-grained tables (hive_settings /
# hive_members) federate to the joiner? Every prior content-matrix A-003 witness
# showed "28 content types PASS but hive_settings/hive_members cross in ZERO
# directions" — the live release blocker. This is the gate for the C-001 re-key
# (shared-hive-rekey-2026-06-19): the epoch + epoch-key-distribution rows ride
# exactly this hive-home→joiner path. PASS here = A-003 GREEN on the real binary.
if [ "${A003_MEMBERSHIP_PROBE:-0}" = 1 ] && [ "$join_ok" = 1 ]; then
  log "A-003 MEMBERSHIP witness (hive-home='$HIVE_SLUG')"
  a003_ws="$(drv_psql a "SELECT workspace_id FROM harness_shared.pot_settings WHERE harness_slug='$HIVE_SLUG' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$a003_ws" ] && a003_ws="$(drv_psql a "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$a003_ws" ] && a003_ws="default"
  echo "  A hive_settings: $(drv_psql a "SELECT setting_key||'/'||origin FROM harness_shared.pot_settings WHERE harness_slug='$HIVE_SLUG';" 2>/dev/null | tr '\n' ' ')"
  echo "  A hive_members:  $(drv_psql a "SELECT github_user_id||'/'||origin FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG';" 2>/dev/null | tr '\n' ' ')"
  bf_set="$(drv_psql b "SELECT count(*) FROM harness_shared.pot_settings WHERE harness_slug='$HIVE_SLUG' AND origin='remote';" 2>/dev/null | tr -d '[:space:]')"
  bf_mem="$(drv_psql b "SELECT count(*) FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' AND origin='remote';" 2>/dev/null | tr -d '[:space:]')"
  echo "A003-BACKFILL: hive_settings_remote_on_B=${bf_set:-0}  hive_members_remote_on_B=${bf_mem:-0}"
  a003_ts="$(date +%s)000"; a003_key="a003-witness-$a003_ts"
  drv_psql a "INSERT INTO harness_shared.pot_settings (workspace_id,harness_slug,setting_key,value,origin,created_at,updated_at) VALUES ('$a003_ws','$HIVE_SLUG','$a003_key','\"probe\"','local',$a003_ts,$a003_ts);" >/dev/null 2>&1
  log "A-003 incremental: wrote hive_settings[$a003_key] on A (ws=$a003_ws) → poll B for origin=remote (<=60s)"
  a003_cross=0
  for i in $(seq 1 20); do
    r="$(drv_psql b "SELECT origin FROM harness_shared.pot_settings WHERE harness_slug='$HIVE_SLUG' AND setting_key='$a003_key';" 2>/dev/null | tr -d '[:space:]')"
    [ "$r" = "remote" ] && { a003_cross=1; break; }
    sleep 3
  done
  if [ "$a003_cross" = 1 ]; then
    echo "A003-HIVE-SETTINGS-CROSS=PASS  (incremental hive_settings federated owner->joiner — A-003 GREEN on the binary)"
  else
    echo "A003-HIVE-SETTINGS-CROSS=FAIL  (A's new hive_settings row never reached B as origin=remote — A-003 RED)"
    echo "  DIAG A outbox(pot_settings,$a003_key): $(drv_psql a "SELECT 'drained='||(drained_at IS NOT NULL)::text FROM harness_shared.substrate_outbox WHERE table_name='pot_settings' AND key='$a003_key';" 2>/dev/null | tr '\n' ' ')"
    echo "  DIAG B settings: $(drv_psql b "SELECT setting_key||'/'||origin FROM harness_shared.pot_settings WHERE harness_slug='$HIVE_SLUG';" 2>/dev/null | tr '\n' ' ' | head -c 300)"
    echo "  DIAG B [A-003] admit: $(grep -aE '\[A-003\] slug-filter' "${FED_LOG[b]}" 2>/dev/null | grep -iF "$HIVE_SLUG" | tail -4 | tr '\n' '|')"
  fi
fi

# ── 5.7 ATTESTATION + REFUSED-OP witness (opt-in: ATTESTATION_PROBE=1) ─────────────
# P-008 live proof of the trust-admission surface on the 2-node rig (see the header). Four legs,
# all read-asserting on real federated substrate; independent of WITNESS_PROBE/MODERATION_PROBE.
# NB hive_members is keyed by pot_home_slug (NOT harness_slug); the refused-op counters live in
# harness_shared.p2p_refused_op_counters (M15, mig 468) keyed by (workspace_id, harness_slug=hive
# home, reason) and are bumped by projections/p2p-receipts.ts's receiver-side identity gate.
# WI-37222: the SUBSET probes (WITNESS / MODERATION / ATTESTATION) each publish their own
# `<NAME> OVERALL:` line and are scored as SEPARATE gate legs (live-federation-gate.sh:1166-1173),
# so they deliberately do NOT gate this script's core exit verdict — that separation is what keeps
# "core federation broke" distinguishable from "re-key broke". What was MISSING is that a subset
# failure also skipped the failure branch entirely, so the instance logs were never preserved.
# This accumulator lets a subset failure (a) preserve those logs and (b) put an unmissable warning
# on the artifact's LAST line, without touching the core verdict. See the report block at EOF.
FAILED_SUBSETS=""
att_seed_A_ok=0; att_seed_B_ok=0; att_2dev_ok=0; att_wrong_ok=0; att_removed_ok=0; attestation_ran=0
att_removed_reason=""
if [ "${ATTESTATION_PROBE:-0}" = 1 ] && [ "$join_ok" = 1 ]; then
  attestation_ran=1
  log "═══ ATTESTATION + REFUSED-OP witness (P-008, hive='$HIVE_SLUG') ═══"
  ATT_WS="$(drv_psql a "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$ATT_WS" ] && ATT_WS="$(drv_psql a "SELECT workspace_id FROM harness_shared.pot_settings WHERE harness_slug='$HIVE_SLUG' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$ATT_WS" ] && ATT_WS="default"
  ATT_B_GH_ID="$(drv_psql a "SELECT github_user_id FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' AND github_username ILIKE '$P_B_USER' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$ATT_B_GH_ID" ] && ATT_B_GH_ID="$(gh api "users/$P_B_USER" --jq .id 2>/dev/null | tr -d '[:space:]')"
  ATT_A_GH_ID="$(drv_psql a "SELECT github_user_id FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' AND github_username ILIKE '$P_A_USER' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$ATT_A_GH_ID" ] && ATT_A_GH_ID="$(gh api "users/$P_A_USER" --jq .id 2>/dev/null | tr -d '[:space:]')"
  echo "  att vars: WS=$ATT_WS  A_GH_ID=$ATT_A_GH_ID  B_GH_ID=$ATT_B_GH_ID"

  # (setup) Under approval mode the from-repo join leaves the OWNER with a PENDING B (no member row
  # → no device to attest). Approve B first so A carries B's member row + device (the LEG1/2 subject).
  echo "  [att-setup] PRE A members=$(drv_psql a "SELECT count(*) FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG';" 2>/dev/null|tr -d '[:space:]')  pending=$(drv_psql a "SELECT count(*) FROM harness_shared.pot_pending_joins WHERE harness_slug='$HIVE_SLUG';" 2>/dev/null|tr -d '[:space:]')"
  dec="$(mcp_call a "pot:membership_decide" "{\"pot\":\"$HIVE_SLUG\",\"githubUserId\":$ATT_B_GH_ID,\"decision\":\"approve\"}")"
  echo "  [att-setup] membership_decide(approve B=$ATT_B_GH_ID) -> $(echo "$dec" | head -c 200)"
  sleep 4

  # ── LEG1 — MEMBERSHIP SEEDING ─────────────────────────────────────────────────────
  a_bdev="$(drv_psql a "SELECT jsonb_array_length(device_attestations) FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' AND github_user_id=$ATT_B_GH_ID;" 2>/dev/null | tr -d '[:space:]')"
  { [ -n "$a_bdev" ] && [ "$a_bdev" -ge 1 ]; } 2>/dev/null && att_seed_A_ok=1
  echo "  LEG1a A ATTESTS B (hive_members row, ≥1 device): $([ "$att_seed_A_ok" = 1 ] && echo "PASS (B devices on A=$a_bdev)" || echo "FAIL (A B-row devices=$a_bdev)")"
  b_seed=0
  for i in $(seq 1 20); do
    b_seed="$(drv_psql b "SELECT count(*) FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' AND origin='remote';" 2>/dev/null | tr -d '[:space:]')"
    { [ -n "$b_seed" ] && [ "$b_seed" -ge 1 ]; } 2>/dev/null && break
    sleep 3
  done
  { [ -n "$b_seed" ] && [ "$b_seed" -ge 1 ]; } 2>/dev/null && att_seed_B_ok=1
  echo "  LEG1b B ROSTER SEEDED (owner federates a hive_members row to B origin=remote): $([ "$att_seed_B_ok" = 1 ] && echo "PASS (remote members on B=$b_seed)" || echo "FAIL (B remote members=$b_seed — WI-1585 VM-half empty-roster class)")"

  # ── LEG2 — SECOND-DEVICE ATTESTATION (merge, no clobber; WI-1585 leg-A) ────────────
  # Seed a pending-join for user-B carrying a FRESH 2nd device, then owner-approve → approvePendingJoin
  # → upsertHiveMember MERGES it into B's existing row (union by device_pubkey; device-1 preserved).
  D1="$(drv_psql a "SELECT (device_attestations->0->>'device_pubkey') FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' AND github_user_id=$ATT_B_GH_ID;" 2>/dev/null | tr -d '[:space:]')"
  D2="att2dev-$(date +%s)-$RANDOM"
  n_before="$(drv_psql a "SELECT jsonb_array_length(device_attestations) FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' AND github_user_id=$ATT_B_GH_ID;" 2>/dev/null | tr -d '[:space:]')"
  now_ms="$(date +%s)000"
  drv_psql a "INSERT INTO harness_shared.pot_pending_joins (workspace_id,harness_slug,github_user_id,github_username,device_attestations,status,requested_at,created_at,updated_at) VALUES ('$ATT_WS','$HIVE_SLUG',$ATT_B_GH_ID,'$P_B_USER','[{\"device_pubkey\":\"$D2\",\"gist_id\":\"att-2dev-probe\",\"gist_url\":\"\",\"device_label\":\"$P_B_USER-dev2\",\"created_at\":$now_ms,\"signature_by_device\":\"\"}]'::jsonb,'pending',$now_ms,$now_ms,$now_ms) ON CONFLICT (workspace_id,harness_slug,github_user_id) DO UPDATE SET device_attestations=EXCLUDED.device_attestations,status='pending',updated_at=EXCLUDED.updated_at;" >/dev/null 2>&1
  dec2="$(mcp_call a "pot:membership_decide" "{\"pot\":\"$HIVE_SLUG\",\"githubUserId\":$ATT_B_GH_ID,\"decision\":\"approve\"}")"
  echo "  [LEG2] approve 2nd-device pending (D2=${D2:0:16}…) -> $(echo "$dec2" | head -c 160)"
  sleep 3
  n_after="$(drv_psql a "SELECT jsonb_array_length(device_attestations) FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' AND github_user_id=$ATT_B_GH_ID;" 2>/dev/null | tr -d '[:space:]')"
  has_d1=1; [ -n "$D1" ] && has_d1="$(drv_psql a "SELECT count(*) FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' AND github_user_id=$ATT_B_GH_ID AND device_attestations @> jsonb_build_array(jsonb_build_object('device_pubkey','$D1'));" 2>/dev/null | tr -d '[:space:]')"
  has_d2="$(drv_psql a "SELECT count(*) FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' AND github_user_id=$ATT_B_GH_ID AND device_attestations @> jsonb_build_array(jsonb_build_object('device_pubkey','$D2'));" 2>/dev/null | tr -d '[:space:]')"
  { [ -n "$n_after" ] && [ "$n_after" -ge 2 ] && [ "$has_d1" = 1 ] && [ "$has_d2" = 1 ]; } 2>/dev/null && att_2dev_ok=1
  echo "  LEG2 SECOND-DEVICE MERGE (B row unions D1+D2, no clobber): $([ "$att_2dev_ok" = 1 ] && echo "PASS (devices $n_before→$n_after; D1 kept=$has_d1 D2 added=$has_d2)" || echo "FAIL (n=$n_before→$n_after D1=$has_d1 D2=$has_d2 — WI-1585 leg-A clobber?)")"

  # ── LEG3 — WRONG-GH-USER-ID refused-op counter ────────────────────────────────────
  # B authors a receipt claiming responder=A (not B). It federates to A, whose receipts projection
  # resolves B's attested device→B's gh-id, sees responder-mismatch, REFUSES (row absent) and bumps
  # p2p_refused_op_counters(reason 'receipt-apply:responder_mismatch').
  # WI-5788 (P-411 residual): an UNMEASURED baseline scores as FAIL — it is NEVER coerced to 0.
  # An empty read means the probe never ran (frame a down / psql refused), not "the counter is
  # 0"; a 0 baseline let ANY pre-existing nonzero count satisfy `rc_after -gt rc_before`, so
  # this leg could print PASS on a run where its own refusal never fired. Mirrors
  # rig_assert_absent's contract (bin/lib/deb-hetzner-rig.sh): unmeasurable ⇒ fail.
  rc_before="$(drv_psql a "SELECT COALESCE(sum(count),0) FROM harness_shared.p2p_refused_op_counters WHERE harness_slug='$HIVE_SLUG' AND reason='receipt-apply:responder_mismatch';" 2>/dev/null | tr -d '[:space:]')"
  att_wrong_unmeasured=0
  [ -n "$rc_before" ] || { att_wrong_unmeasured=1; echo "  [LEG3] ✗ baseline responder_mismatch probe on A returned EMPTY — counter UNMEASURED; scoring LEG3 FAIL (cannot distinguish 'counter is 0' from 'probe never ran')"; }
  RID_WRONG="att-wrong-$(date +%s)-$RANDOM"; now_ms="$(date +%s)000"
  drv_psql b "INSERT INTO harness_shared.p2p_receipts (workspace_id,harness_slug,receipt_id,kind,action,detail,responder_github_user_id,receipt_ts,origin) VALUES ('$ATT_WS','$HIVE_SLUG','$RID_WRONG','refusal','work-offer:claim','att wrong-gh probe',${ATT_A_GH_ID:-999999999},$now_ms,'local');" >/dev/null 2>&1
  echo "  [LEG3] B authored receipt $RID_WRONG claiming responder=A($ATT_A_GH_ID) — federating to A…"
  rc_after=""; rc_after_measured=0
  for i in $(seq 1 ${DISCOVERY_RETRIES:-40}); do
    [ "$att_wrong_unmeasured" = 1 ] && break
    rc_after="$(drv_psql a "SELECT COALESCE(sum(count),0) FROM harness_shared.p2p_refused_op_counters WHERE harness_slug='$HIVE_SLUG' AND reason='receipt-apply:responder_mismatch';" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$rc_after" ]; then
      rc_after_measured=1
      { [ "$rc_after" -gt "$rc_before" ]; } 2>/dev/null && break
    fi
    sleep 3
  done
  rid_on_a="$(drv_psql a "SELECT count(*) FROM harness_shared.p2p_receipts WHERE harness_slug='$HIVE_SLUG' AND receipt_id='$RID_WRONG';" 2>/dev/null | tr -d '[:space:]')"
  # PASS requires BOTH endpoints actually measured — an unmeasured probe can no longer score.
  { [ "$att_wrong_unmeasured" = 0 ] && [ "$rc_after_measured" = 1 ] && [ "$rc_after" -gt "$rc_before" ] && [ "$rid_on_a" = 0 ]; } 2>/dev/null && att_wrong_ok=1
  echo "  LEG3 WRONG-GH REFUSED-OP (A refuses B's mis-attributed receipt; counter++, row absent): $([ "$att_wrong_ok" = 1 ] && echo "PASS (responder_mismatch $rc_before→$rc_after, row-on-A=$rid_on_a)" || echo "FAIL (counter ${rc_before:-UNMEASURED}→${rc_after:-UNMEASURED}, row-on-A=${rid_on_a:-UNMEASURED})")"

  # ── LEG4 — UNATTESTED-device refused-op counter ───────────────────────────────────
  # The receipts identity gate is ANTI-SPOOF (author must == the claimed responder) — a member
  # authoring a receipt AS THEMSELVES always passes it, even after revocation (revocation gates
  # ADMISSION/read, not an immutable self-authored INSERT fact). The "unattested device" adversarial
  # probe therefore targets the gate's OTHER refusal: an author DEVICE that resolves to NO member
  # identity → 'identity_unresolved'. Rig affordance: strip B's device attestation on A's hive_members
  # (B's source-log device is now attested to no member — the unattested-device case), WAIT OUT the
  # comms-tier device→user cache TTL (30s, PAPERCUSP_COMMS_TIER_CACHE_MS), then B authors a VALID
  # receipt (responder=B). A resolves the source-log device but it maps to no member → the projection
  # REFUSES (identity_unresolved), bumps p2p_refused_op_counters, and the row stays absent on A.
  # WI-5788 (P-411 residual): UNMEASURED baseline ⇒ FAIL, never coerced to 0. This leg is the
  # most exposed of the four: it runs LAST, after the roster mutation + a 35s cache wait, so a
  # frame-a blip during the baseline read is entirely plausible — and a coerced-0 baseline on a
  # LIKE 'receipt-apply:%' TOTAL (already bumped by LEG3) makes a false PASS near-certain.
  tot_before="$(drv_psql a "SELECT COALESCE(sum(count),0) FROM harness_shared.p2p_refused_op_counters WHERE harness_slug='$HIVE_SLUG' AND reason LIKE 'receipt-apply:%';" 2>/dev/null | tr -d '[:space:]')"
  att_removed_unmeasured=0
  [ -n "$tot_before" ] || { att_removed_unmeasured=1; echo "  [LEG4] ✗ baseline receipt-apply:% total probe on A returned EMPTY — counter UNMEASURED; scoring LEG4 FAIL (cannot distinguish 'counter is 0' from 'probe never ran')"; }
  # Strip B's attestation on A (simulate an author device attested to no member) — union preserved for
  # LEG2's assert already recorded; this is the LAST leg so mutating A's roster is safe.
  drv_psql a "UPDATE harness_shared.pot_members SET device_attestations='[]'::jsonb WHERE pot_home_slug='$HIVE_SLUG' AND github_user_id=$ATT_B_GH_ID;" >/dev/null 2>&1
  echo "  [LEG4] stripped B's device attestation on A (B's author device now maps to no member); waiting out the 30s comms-tier cache TTL…"
  sleep 35   # PAPERCUSP_COMMS_TIER_CACHE_MS default = 30_000; ensure the next resolve rebuilds the device→user map WITHOUT B
  RID_REM="att-unatt-$(date +%s)-$RANDOM"; now_ms="$(date +%s)000"
  drv_psql b "INSERT INTO harness_shared.p2p_receipts (workspace_id,harness_slug,receipt_id,kind,action,detail,responder_github_user_id,receipt_ts,origin) VALUES ('$ATT_WS','$HIVE_SLUG','$RID_REM','refusal','work-offer:claim','att unattested-device probe',${ATT_B_GH_ID:-999999999},$now_ms,'local');" >/dev/null 2>&1
  echo "  [LEG4] B authored valid receipt $RID_REM (responder=B) with its device now unattested on A — federating…"
  tot_after=""; tot_after_measured=0
  for i in $(seq 1 ${DISCOVERY_RETRIES:-40}); do
    [ "$att_removed_unmeasured" = 1 ] && break
    tot_after="$(drv_psql a "SELECT COALESCE(sum(count),0) FROM harness_shared.p2p_refused_op_counters WHERE harness_slug='$HIVE_SLUG' AND reason LIKE 'receipt-apply:%';" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$tot_after" ]; then
      tot_after_measured=1
      { [ "$tot_after" -gt "$tot_before" ]; } 2>/dev/null && break
    fi
    sleep 3
  done
  rem_on_a="$(drv_psql a "SELECT count(*) FROM harness_shared.p2p_receipts WHERE harness_slug='$HIVE_SLUG' AND receipt_id='$RID_REM';" 2>/dev/null | tr -d '[:space:]')"
  att_removed_reason="$(drv_psql a "SELECT reason||'='||count FROM harness_shared.p2p_refused_op_counters WHERE harness_slug='$HIVE_SLUG' AND reason LIKE 'receipt-apply:%' ORDER BY updated_at DESC LIMIT 3;" 2>/dev/null | tr '\n' ' ')"
  { [ "$att_removed_unmeasured" = 0 ] && [ "$tot_after_measured" = 1 ] && [ "$tot_after" -gt "$tot_before" ] && [ "$rem_on_a" = 0 ]; } 2>/dev/null && att_removed_ok=1
  echo "  LEG4 UNATTESTED-DEVICE REFUSED-OP (author device attested to no member → A refuses; counter++, row absent): $([ "$att_removed_ok" = 1 ] && echo "PASS (receipt-apply total $tot_before→$tot_after; reasons: $att_removed_reason; row-on-A=$rem_on_a)" || echo "FAIL (counter $tot_before→$tot_after row-on-A=$rem_on_a reasons: $att_removed_reason)")"
fi

# ── 6. FOLDED LIVE WITNESS — owner-enforcement (AK) + re-key CUT (P-008) ──────────
# Opt-in: WITNESS_PROBE=1. Runs ONLY after a successful join (B is an admitted,
# federating member). flag-on (PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY=1) must be set in
# THIS rig's env so the launchers propagate it to both instances (content then rides
# epoch encrypt/decrypt — required for the K3 cut + the live decrypt→EN-4 order).
#
# ASSUMPTIONS FLAGGED FOR ee7e9 REVIEW (before firing):
#  (a) mcp_call shape: POST /api/mcp?superuser=1&client=<id> JSON-RPC tools/call. The
#      sidecar instance must accept superuser=1 (auth: open in the test sidecar, or a
#      bearer — confirm). Used for hive:ban_member + substrate:revoke_contributor.
#  (b) K2 epoch-advance read: epoch lives in hive_settings setting_key LIKE '%epoch%'
#      (per your spec) — confirm the actual key/column.
#  (c) SCOPE (tight, this run): AK default-off + ban(revoke:false)+unban-teeth + your
#      re-key K0-K3. AK rate/takedown/content = FOLLOW-UP (rate/content need the
#      claim-gated POST /api/hive/:id/policy route; A=papercupai isn't repo-admin on the
#      octocat fixture → seed claim_status or use a papercupai-owned repo for those).
ak_default_ok=0; ak_ban_ok=0; ak_unban_ok=0
rk_keys_ok=0; rk_ctrl_ok=0; rk_revoke_ok=0; rk_cut_ok=0; witness_ran=0
witness_lifecycle_ready=1; witness_cut_ready=0
rk_ctrl_measurable=1  # WI-37144: 0 ⇒ the K1 CONTROL leg could not run at all (empty B_DEV) ⇒ INCONCLUSIVE, not FAIL
# P-008 CONTENT-level cut (the work-item's literal assertion). rk_content_applicable=1 only
# when the K4a pre-revoke content control proves content federation A→B is healthy THIS run
# (else WI-259 stalls content → K4b is INCONCLUSIVE, never a false-RED; the key-level K3 governs).
rk_content_ctrl_ok=0; rk_content_cut_ok=0; rk_content_applicable=0
# WI-40905 lifecycle admission: the core F-HIVE3 control is the baseline
# same-stream canary. Before starting the folded witness, require its
# source row to be drained, B's exact-log cursor active+advanced, both target
# presence topics wired/recovered, and no target boot-timeout/late-adopt or
# exact-log named-stall history. K4a authors a second, fresh F-RKCTRL canary
# after the C-001 setup and AK probes; that exact stream must pass the same
# guard immediately before K2 mutates revocation state. Either failed guard is
# a NON-QUALIFYING witness environment, not a C-001 product verdict.
if [ "${WITNESS_PROBE:-0}" = 1 ] && [ "$join_ok" = 1 ]; then
  if [ "$hive_cont_ok" != 1 ]; then
    witness_lifecycle_ready=0
    echo "LIFECYCLE NOT READY: continuous same-stream canary F-HIVE3 did not materialize on B"
  elif ! fed_assert_hive_lifecycle_ready a b F-HIVE3 "$MEMBER_SLUG" "$HIVE_SLUG"; then
    witness_lifecycle_ready=0
  fi
fi

if [ "${WITNESS_PROBE:-0}" = 1 ] && [ "$join_ok" = 1 ] && [ "$witness_lifecycle_ready" = 1 ]; then
  witness_ran=1
  log "═══ FOLDED LIVE WITNESS (AK enforcement + P-008 re-key cut) ═══"
  WS_ID="$(drv_psql a "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$WS_ID" ] && WS_ID="$(drv_psql a "SELECT workspace_id FROM harness_shared.pot_settings WHERE harness_slug='$HIVE_SLUG' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  B_GH_ID="$(drv_psql a "SELECT github_user_id FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' AND github_username ILIKE '$P_B_USER' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$B_GH_ID" ] && B_GH_ID="$(gh api "users/$P_B_USER" --jq .id 2>/dev/null | tr -d '[:space:]')"
  echo "  witness vars: WS=$WS_ID  B_GH_ID=$B_GH_ID  HIVE=$HIVE_SLUG  MEMBER=$MEMBER_SLUG"
  # (mcp_call is defined once in the shared helpers above — used by this block + MODERATION_PROBE.)

  # (su-9140a, C-001 construction) The natural from-repo join leaves the OWNER with NO hive_members row
  # for the joiner → the epoch-key grant (on upsertHiveMember) never fires → no encryption → nothing to cut.
  # Diagnose A's admission state; if a pending-join exists (approval-mode), APPROVE it to fire the grant.
  echo "  [C-001-setup] PRE: A pending_joins=$(drv_psql a "SELECT count(*) FROM harness_shared.pot_pending_joins;" 2>/dev/null|tr -d '[:space:]') members=$(drv_psql a "SELECT count(*) FROM harness_shared.pot_members;" 2>/dev/null|tr -d '[:space:]') epoch_keys=$(drv_psql a "SELECT count(*) FROM harness_shared.pot_epoch_keys;" 2>/dev/null|tr -d '[:space:]')"
  dec="$(mcp_call a "pot:membership_decide" "{\"pot\":\"$HIVE_SLUG\",\"githubUserId\":$B_GH_ID,\"decision\":\"approve\"}")"
  echo "  [C-001-setup] membership_decide(approve B=$B_GH_ID) -> $(echo "$dec" | head -c 240)"
  sleep 5
  echo "  [C-001-setup] POST: A members=$(drv_psql a "SELECT count(*) FROM harness_shared.pot_members;" 2>/dev/null|tr -d '[:space:]') epoch_keys=$(drv_psql a "SELECT count(*) FROM harness_shared.pot_epoch_keys;" 2>/dev/null|tr -d '[:space:]')"

  # AK0 — default-off control: B writes F-AK0 → lands on A (no policy yet).
  ak0="$(fed_hive_merge_probe b a "$MEMBER_SLUG" F-AK0 40 || true)"
  [ "${ak0%% *}" = 1 ] && ak_default_ok=1
  echo "  AK0 default-off control (B→A, no policy): $([ "$ak_default_ok" = 1 ] && echo PASS || echo "FAIL ($ak0)")"

  # AK ban (P-MOD / EN-4, policy-only revoke:false → B stays admitted, ops dropped by ban).
  # WI-5783: pot:ban_member's response used to be discarded (>/dev/null 2>&1), so a
  # SILENT policy-write failure (banMember/mutateHivePolicy → {ok:false, code:'not_owner_swarm'|
  # 'no_owner_pubkey'|'write_failed'} — hive-policy-author.ts) was indistinguishable from a real
  # EN-4 merge/detector bug: either way B's op simply "lands" and the leg reads FAIL. Capture +
  # surface it so a future FAIL is self-diagnosing instead of needing a live rig re-run to tell
  # "the ban was never applied" apart from "the ban was applied but not enforced".
  # NB the tool's JSON is double-encoded (MCP content[].text is itself a JSON string,
  # so its own quotes arrive backslash-escaped, e.g. \"policy\":{\"ok\":false) — unescape
  # before grepping so the pattern matches either encoding depth.
  # su-6bf2d 2026-07-25: the ACTUAL ban_member call went missing when this DIAG capture
  # was added (a `set -u` "ban_resp: unbound variable" on a live re-run proved it — grep
  # for `mcp_call a "pot:ban_member"` here found only the unban call below). Without this
  # call the ban is NEVER applied, so every "AK ban … FAIL" reading since this landed was
  # guaranteed regardless of root cause — restoring it is what makes the DIAG line (and
  # the whole WI-5783 investigation) meaningful again.
  ban_resp="$(mcp_call a "pot:ban_member" "{\"pot\":\"$HIVE_SLUG\",\"githubUserId\":$B_GH_ID,\"revoke\":false}" 2>&1)"
  ban_resp_flat="$(echo "$ban_resp" | sed 's/\\"/"/g')"
  ban_policy_ok="$(echo "$ban_resp_flat" | grep -oE '"policy":\{"ok":(true|false)' | grep -oE '(true|false)$')"
  ban_policy_code="$(echo "$ban_resp_flat" | grep -oE '"code":"[a-zA-Z_]+"' | head -1 | sed 's/"code":"//;s/"$//')"
  echo "  [AK-ban DIAG] pot:ban_member(revoke:false) -> policy.ok=${ban_policy_ok:-<unparsed>}${ban_policy_code:+ code=$ban_policy_code}"
  sleep 3
  banprobe="$(fed_hive_merge_probe b a "$MEMBER_SLUG" F-AKBAN 40 || true)"
  akban_a="$(drv_psql a "SELECT count(*) FROM harness_shared.harness_features_consolidated WHERE feature_id='F-AKBAN' AND origin='remote';" 2>/dev/null | tr -d '[:space:]')"
  [ "${banprobe%% *}" != 1 ] && [ "$akban_a" = 0 ] && ak_ban_ok=1
  if [ "$ak_ban_ok" != 1 ] && [ "$ban_policy_ok" = "false" ]; then
    echo "  AK ban (B's op DROPPED on A, EN-4): FAIL (probe=$banprobe A_count=$akban_a) — NOT a merge/detector bug: the ban WRITE itself failed (policy.ok=false code=${ban_policy_code:-?}), so there was never a ban in force. Fix the ban-write precondition (Swarm must hold the Hive private key), then re-run."
  else
    echo "  AK ban (B's op DROPPED on A, EN-4): $([ "$ak_ban_ok" = 1 ] && echo PASS || echo "FAIL (probe=$banprobe A_count=$akban_a)")"
  fi

  # AK teeth — unban → B's next write lands again (proves the ban gate was load-bearing).
  unban_resp="$(mcp_call a "pot:ban_member" "{\"pot\":\"$HIVE_SLUG\",\"githubUserId\":$B_GH_ID,\"unban\":true}" 2>&1)"
  unban_resp_flat="$(echo "$unban_resp" | sed 's/\\"/"/g')"
  unban_policy_ok="$(echo "$unban_resp_flat" | grep -oE '"ok":(true|false)' | head -1 | grep -oE '(true|false)$')"
  echo "  [AK-unban DIAG] pot:ban_member(unban:true) -> ok=${unban_policy_ok:-<unparsed>}"
  sleep 3
  unbanprobe="$(fed_hive_merge_probe b a "$MEMBER_SLUG" F-AKUNBAN 40 || true)"
  [ "${unbanprobe%% *}" = 1 ] && ak_unban_ok=1
  echo "  AK unban teeth (B's op lands again): $([ "$ak_unban_ok" = 1 ] && echo PASS || echo "FAIL ($unbanprobe)")"

  # ── RE-KEY block (P-008 — DEVICE-FILTERED key-level cut; ee7e9's reframe, su-9140a 2026-06-20) ──
  # The C-001 read-cut is provable from hive_epoch_keys ALONE — that projection is hive-home-grained
  # (A-003-PROVEN to federate A→B), so the cut needs ZERO content federation and is ORTHOGONAL to
  # WI-259 (the from-repo member-harness CONTENT stall). The cut = B's DEVICE has no wrapped key at the
  # post-revoke epoch. NB every hive_epoch_keys row (all members' per-device sealed blobs) federates to
  # B; B just can't UNWRAP the ones not sealed to its device — so the cut is the ABSENCE of a B_DEV row,
  # not the absence of rows. B_DEV (the cut-off device) is derived from A's AUTHORITATIVE member-set
  # diff: A wrapped epoch-CUR to {A,B} but epoch-NEW only to the REMAINING ({A}), so
  # B_DEV = A(epoch=CUR devices) EXCEPT A(epoch=NEW devices). Earlier F-CTRL/F-CUT content probes
  # conflated the cut with WI-259's content stall (false-RED); this is the true, independent proof.

  # K0 — B received join-time epoch keys over the wire (origin=remote ⇒ the grant + federation worked).
  # WI-5828: this used to be a SINGLE-SHOT query with no retry, unlike every OTHER
  # cross-instance assertion in this script (fed_merge_assert/fed_hive_merge_probe
  # all poll tries*3s) — a slightly-slow epoch-key federation under host load then
  # reads as a hard FAIL instead of "hasn't arrived yet". Poll like the rest do.
  for _k0_i in $(seq 1 "${EPOCH_KEY_PROBE_TRIES:-20}"); do
    b_keys="$(drv_psql b "SELECT count(*) FROM harness_shared.pot_epoch_keys WHERE harness_slug='$HIVE_SLUG' AND origin='remote';" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$b_keys" ] && [ "$b_keys" -ge 1 ] && { rk_keys_ok=1; break; }
    sleep 3
  done
  echo "  K0 join-keys (B has wrapped epoch keys origin=remote): $([ "$rk_keys_ok" = 1 ] && echo "PASS ($b_keys)" || echo "FAIL ($b_keys)")"

  # CURRENT (pre-revoke) epoch on A = the max minted epoch (-1 ⇒ the grant never fired = K0 upstream fail).
  CUR_EPOCH="$(drv_psql a "SELECT COALESCE(max(epoch),-1) FROM harness_shared.pot_epoch_keys WHERE harness_slug='$HIVE_SLUG';" 2>/dev/null | tr -d '[:space:]')"

  # ── K4a CONTENT CONTROL (pre-revoke, P-008 CONTENT-level) — the data-plane companion to K1.
  # A authors an ENCRYPTED content feature (F-RKCTRL) under the CURRENT epoch; B — still a member
  # holding the CUR-epoch key (K1) — must MATERIALIZE it origin=remote, i.e. B can READ pre-revoke
  # content at the CONTENT layer (the decrypt gate succeeds). This is also the WI-259 GATE for K4b:
  # the earlier content-based design (findings-K) false-RED'd because the scopedApply cross-member
  # guard (WI-259) silently drops A's member-slug content op, so F-RKCTRL never crossed REGARDLESS of
  # the cut. So we only treat a post-revoke non-arrival (K4b) as a TRUE content cut when THIS control
  # proves content federation A→B is healthy this run; otherwise K4b is INCONCLUSIVE (never false-RED),
  # and the WI-259-orthogonal device-filtered key-level K3-CUT remains the governing release proof.
  rkctrl="$(fed_hive_merge_probe a b "$MEMBER_SLUG" F-RKCTRL ${RKCUT_PROBE_TRIES:-20} || true)"
  [ "${rkctrl%% *}" = 1 ] && rk_content_ctrl_ok=1
  echo "  K4a CONTENT CONTROL (B reads pre-revoke encrypted content F-RKCTRL): $([ "$rk_content_ctrl_ok" = 1 ] && echo "PASS (content federation A→B healthy ⇒ K4b will assert the cut)" || echo "INCONCLUSIVE (content A→B unhealthy this run — WI-259; key-level K3-CUT governs)")"

  # WI-40905: F-HIVE3 is too early to admit the security cut by itself. The
  # C-001 setup and AK probes above can change membership/presence state after
  # that control passed. Treat the just-authored F-RKCTRL as the fresh,
  # immediate pre-K2/K4 same-stream canary and re-run the full lifecycle guard
  # against its exact source log. K2 and every post-revoke assertion are
  # structurally inside this gate so a failed admission cannot mutate the rig
  # or emit a product-shaped cut verdict.
  if [ "$rk_content_ctrl_ok" = 1 ] \
    && fed_assert_hive_lifecycle_ready a b F-RKCTRL "$MEMBER_SLUG" "$HIVE_SLUG"; then
    witness_cut_ready=1
    echo "  PRE-CUT LIFECYCLE ADMISSION: PASS (fresh F-RKCTRL stream drained, materialized, cursor active+advanced, presence/history healthy)"
  else
    witness_cut_ready=0
    echo "  PRE-CUT LIFECYCLE ADMISSION: FAIL — fresh F-RKCTRL did not prove a trustworthy same-stream substrate; K2/K3/K4b skipped without revocation mutation"
  fi

  if [ "$witness_cut_ready" = 1 ]; then
  # K2 REVOKE — A revokes B → epoch advance + re-key the REMAINING members (NOT B).
  # WI-37144: CAPTURE the call's own result. This was `>/dev/null 2>&1`, which discarded the one
  # piece of evidence separating "the revoke ERRORED" from "the revoke succeeded but the epoch did
  # not advance" — the two readings have opposite remediations, and the from-repo witness banks no
  # serve log (unlike the local-matrix rig), so a K2 FAIL was undiagnosable after teardown. Four
  # days of identical reds could not be triaged for exactly this reason.
  # K2 PRE-FLIGHT (WI-37144) — MEASURED 2026-08-09: the captured K2 DIAG below returned
  # `{"ok":false,"code":"not_owner"}`, i.e. the revoke is REJECTED at the OWNER GATE
  # (hive-revoke-contributor.ts:205-215) and never reaches loadTargetPubkeys or the epoch
  # advance. That gate asks loadHiveKeyStatus(workspaceId, potHomeSlug), which RECOMPUTES the
  # keychain id as `hive:${ws}:${slug}` (identity/hive-keypair.ts:49-52) — whereas
  # ensureHiveIdentity (hive-identity.ts:46-63) treats pots.keychain_id as AUTHORITATIVE, and
  # its own comment records that recompute-and-mint is exactly what orphaned the hive key on
  # the 2026-06-19 rename. So print BOTH strings: if they differ, the gate is correctly saying
  # it holds no key under the id it computed and the root cause is UPSTREAM of the gate.
  # Printed BEFORE the revoke on purpose — this rig banks no serve log and destroys its
  # instances at teardown, which is why four days of reds were undiagnosable.
  pots_row="$(drv_psql a "SELECT workspace_id || ' | ' || pot_home_slug || ' | keychain_id=' || COALESCE(keychain_id,'<NULL>') || ' | pub=' || COALESCE(left(public_key::text,12),'<NULL>') FROM harness_shared.pots WHERE pot_home_slug='$HIVE_SLUG';" 2>&1 | tr -d '\r' | sed '/^[[:space:]]*$/d')"
  # ⚠ an EMPTY result here is NOT "no such row" — it is equally "the query never ran". Label it.
  echo "  [K2 PRE] pots row(s) on A       : ${pots_row:-<EMPTY — undetermined: no row OR the query failed; NOT evidence of absence>}"
  echo "  [K2 PRE] gate recomputes id as  : hive:${WS_ID}:${HIVE_SLUG}"
  rk_revoke_out="$(mcp_call a "substrate:revoke_contributor" "{\"workspaceId\":\"$WS_ID\",\"githubUserId\":$B_GH_ID,\"potSlug\":\"$HIVE_SLUG\"}" 2>&1 || true)"  # request field renamed hiveSlug→potSlug (revoke-contributor.ts zod refine accepts only potSlug)
  # WI-37195 landed a TRI-STATE owner gate, so this line now discriminates the two states the old
  # boolean gate collapsed: `not_owner` = no key held under the recomputed id; `owner_key_unreadable`
  # = a key IS there but could not be read (its `detail` names the reason). Widened 500→900 chars so
  # that detail survives the cut — the code alone does not say WHY.
  echo "  [K2 DIAG] revoke_contributor → $(printf '%s' "${rk_revoke_out:-<no output>}" | tr '\n' ' ' | cut -c1-900)"
  # WI-37144: POLL the epoch instead of one read after `sleep 4`. Every other cross-instance
  # assertion here polls (K0/K1 20x/3s); K2 was the last single-shot read, and the K1 comment
  # directly below cites WI-5828 for precisely that asymmetry producing false FAILs. Polling can
  # only remove a FALSE fail: an epoch that genuinely never advances still fails, just later.
  NEW_EPOCH="$CUR_EPOCH"
  for _k2_i in $(seq 1 "${EPOCH_KEY_PROBE_TRIES:-20}"); do
    NEW_EPOCH="$(drv_psql a "SELECT COALESCE(max(epoch),-1) FROM harness_shared.pot_epoch_keys WHERE harness_slug='$HIVE_SLUG';" 2>/dev/null | tr -d '[:space:]')"
    { [ -n "$CUR_EPOCH" ] && [ -n "$NEW_EPOCH" ] && [ "$NEW_EPOCH" -gt "$CUR_EPOCH" ]; } 2>/dev/null && { rk_revoke_ok=1; break; }
    sleep 3
  done
  echo "  K2 REVOKE (A revokes B, epoch advanced $CUR_EPOCH→$NEW_EPOCH): $([ "$rk_revoke_ok" = 1 ] && echo "PASS" || echo "FAIL (epoch did not advance after ${EPOCH_KEY_PROBE_TRIES:-20} polls)")"

  # B_DEV — the cut-off device = A's CUR-epoch member devices EXCEPT A's NEW-epoch (remaining) devices.
  # In a 2-member hive this is exactly B's device (A stays a member ⇒ A_DEV is in both epochs, excluded).
  B_DEV="$(drv_psql a "SELECT member_device_pubkey FROM harness_shared.pot_epoch_keys WHERE harness_slug='$HIVE_SLUG' AND epoch=$CUR_EPOCH EXCEPT SELECT member_device_pubkey FROM harness_shared.pot_epoch_keys WHERE harness_slug='$HIVE_SLUG' AND epoch=$NEW_EPOCH;" 2>/dev/null | head -1 | tr -d '[:space:]')"

  # K1 CONTROL — B's DEVICE held a key at the pre-revoke epoch (it COULD derive current content).
  # WI-5828: poll like K0 above — same single-shot-vs-poll asymmetry against every
  # other cross-instance assertion in this script (2 of 5 live WITNESS_PROBE=1 runs
  # FAILed this leg alongside OTHER unrelated federation-timing flakes in the same
  # run, consistent with a too-eager single-shot read rather than a real cut bug).
  k1_bdev=""; rk_ctrl_measurable=1
  if [ -n "$B_DEV" ]; then
    for _k1_i in $(seq 1 "${EPOCH_KEY_PROBE_TRIES:-20}"); do
      k1_bdev="$(drv_psql b "SELECT count(*) FROM harness_shared.pot_epoch_keys WHERE harness_slug='$HIVE_SLUG' AND epoch=$CUR_EPOCH AND member_device_pubkey='$B_DEV' AND origin='remote';" 2>/dev/null | tr -d '[:space:]')"
      [ -n "$k1_bdev" ] && [ "$k1_bdev" -ge 1 ] && { rk_ctrl_ok=1; break; }
      sleep 3
    done
  else
    # WI-37144: B_DEV is an EXCEPT of the CUR- and NEW-epoch device sets, so it is EMPTY BY
    # CONSTRUCTION whenever K2 did not advance the epoch. The poll above then never ran, `k1_bdev`
    # stayed unset, and `set -u` killed the echo's own subshell — printing an EMPTY verdict while
    # the summary still reported `K1-control=FAIL`. That is a verdict-shaped non-verdict: the
    # CONTROL leg executed zero queries, so its "FAIL" carried no information about the cut, yet
    # read as a fourth independent breakage in every triage of this red.
    rk_ctrl_measurable=0
  fi
  if [ "$rk_ctrl_measurable" = 1 ]; then
    echo "  K1 CONTROL (B's device HAD the pre-revoke epoch-$CUR_EPOCH key): $([ "$rk_ctrl_ok" = 1 ] && echo "PASS (k1=$k1_bdev B_DEV=${B_DEV:0:12}…)" || echo "FAIL (k1=${k1_bdev:-<unread>} B_DEV=${B_DEV:0:12})")"
  else
    echo "  K1 CONTROL (B's device HAD the pre-revoke epoch-$CUR_EPOCH key): INCONCLUSIVE (B_DEV unresolvable — K2 left the epoch at $CUR_EPOCH, so the CUR/NEW device sets are identical and their EXCEPT is empty; this leg ran NO query and is NOT evidence about the cut)"
  fi

  # K3 CUT — B's DEVICE has NO key at the NEW epoch (can't derive post-revoke content = the read-cut),
  # WHILE the NEW epoch DID federate to B for the REMAINING members (so the 0 is a true cut, not a
  # federation miss) and A holds the NEW epoch rows. This IS the C-001 read-cut — key-level, device-filtered.
  #
  # WI-37144 (2026-08-09): `k3_remaining` was a SINGLE-SHOT read fired immediately after K2's
  # epoch-advance poll broke — and K1 above breaks on its FIRST iteration (B's epoch-$CUR_EPOCH row
  # crossed long ago), so B had ~0 seconds to receive the remaining member's epoch-$NEW_EPOCH row.
  # It read 0 every time, and `k3_remaining >= 1` was the SOLE failing conjunct of this six-way AND
  # while both cut conjuncts passed. I previously recorded that as "structurally unsatisfiable at 2
  # members" (the reasoning: after revoking B only A remains, so the only new-epoch row is A's OWN
  # and there is nothing for B to receive). ⛔ THAT WAS WRONG — REFUTED BY MEASUREMENT, do not
  # reinstate it: epoch-key rows federate to B *sealed to the holder's device*, so the remaining
  # member's row is EXPECTED to reach B and be undecryptable there. The adjacent matrix rig
  # (lib/scenarios/b3-revocation.sh, same revoke endpoint — potSlug/hive scope) observes exactly
  # that and says so in its own witness: banked run 232013 has B holding
  # `hello-world-pot|1|sXuPh9DH…|remote` — the OWNER's device row at the NEW epoch — under the note
  # "the epoch-1 row B did receive is sealed to the owner's device, unreadable by B". Run
  # 223519 shows TWO such rows. So the condition is satisfiable at this member count; the smoke was
  # simply measuring before federation had a chance to deliver. The matrix reads the same tables
  # only after its post-ban content probe, i.e. tens of seconds later, which is why it never saw 0.
  #
  # Same single-shot-vs-poll asymmetry WI-5828 fixed for K1 and WI-37144 fixed for K2 — these were
  # the last un-polled cross-instance reads in this script, so the K2 comment above claiming K2 was
  # "the last single-shot read" is now the accurate statement rather than an aspirational one.
  #
  # ⚠ The two reads are polled ASYMMETRICALLY on purpose, because they assert opposite things:
  #   · `k3_remaining` asserts PRESENCE — poll until it appears (a bounded wait can only remove a
  #     FALSE fail; a row that genuinely never crosses still fails, just later).
  #   · `k3_bdev` asserts ABSENCE — polling "until absent" is meaningless, so it is read ONCE, AFTER
  #     the presence loop settles. That is deliberately the LATEST decidable moment, which makes the
  #     cut assertion STRICTLY STRONGER than the old early read: B has now had the full delivery
  #     window in which to wrongly receive a NEW-epoch key for its own device, and still holds none.
  k3_remaining=""
  for _k3_i in $(seq 1 "${EPOCH_KEY_PROBE_TRIES:-20}"); do
    k3_remaining="$(drv_psql b "SELECT count(*) FROM harness_shared.pot_epoch_keys WHERE harness_slug='$HIVE_SLUG' AND epoch=$NEW_EPOCH AND member_device_pubkey<>'$B_DEV' AND origin='remote';" 2>/dev/null | tr -d '[:space:]')"
    { [ -n "$k3_remaining" ] && [ "$k3_remaining" -ge 1 ]; } 2>/dev/null && break
    sleep 3
  done
  # Read the ABSENCE only now — see the asymmetry note above.
  k3_bdev="$(drv_psql b "SELECT count(*) FROM harness_shared.pot_epoch_keys WHERE harness_slug='$HIVE_SLUG' AND epoch=$NEW_EPOCH AND member_device_pubkey='$B_DEV' AND origin='remote';" 2>/dev/null | tr -d '[:space:]')"
  a_new="$(drv_psql a "SELECT count(*) FROM harness_shared.pot_epoch_keys WHERE harness_slug='$HIVE_SLUG' AND epoch=$NEW_EPOCH;" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$B_DEV" ] && [ "$k3_bdev" = 0 ] && [ -n "$k3_remaining" ] && [ "$k3_remaining" -ge 1 ] && [ -n "$a_new" ] && [ "$a_new" -ge 1 ] && rk_cut_ok=1
  # Name WHICH conjunct failed. A six-way AND rendered as the single word FAIL is what let
  # "the anti-confound could not be measured" read as "the revocation cut is broken" for two wakes.
  if [ "$rk_cut_ok" = 1 ]; then
    k3_why="PASS (B_DEV new-keys=0, remaining-on-B=$k3_remaining, A-new=$a_new)"
  elif [ -z "$B_DEV" ]; then
    k3_why="INCONCLUSIVE (B_DEV unresolvable — K2 left the epoch at $CUR_EPOCH; this leg is NOT evidence about the cut)"
  elif [ "${k3_bdev:-x}" != 0 ]; then
    k3_why="FAIL — CUT BROKEN: B's own device HOLDS an epoch-$NEW_EPOCH key (B_DEV-new=${k3_bdev:-<unread>})"
  elif [ -z "$k3_remaining" ] || [ "$k3_remaining" -lt 1 ] 2>/dev/null; then
    k3_why="FAIL — ANTI-CONFOUND UNMEASURABLE, the cut itself is NOT contradicted (B_DEV-new=0 ✓ but remaining-on-B=${k3_remaining:-<unread>} after ${EPOCH_KEY_PROBE_TRIES:-20} polls: no remaining member's epoch-$NEW_EPOCH row ever reached B, so connected-but-cut cannot be separated from disconnected)"
  else
    k3_why="FAIL (A does not hold the new epoch: A-new=${a_new:-<unread>})"
  fi
  echo "  K3 CUT (B's device has NO epoch-$NEW_EPOCH key; remaining DID cross; A holds new epoch): $k3_why"

  # ── K4b CONTENT CUT (post-revoke, P-008 — the work-item's LITERAL assertion) ──────────────────
  # The data-plane consequence of the key-level K3 cut: owner A authors NEW content (F-RKCUT) AFTER
  # the revoke (encrypted under epoch=$NEW_EPOCH). The REMAINING member (owner A) holds it (reads +
  # retains it origin='local'). The cut-off member B — which K3 just proved STILL RECEIVES post-revoke
  # federation (the remaining members' epoch-$NEW_EPOCH key rows crossed to B: remaining-on-B=$k3_remaining)
  # yet holds NO epoch-$NEW_EPOCH key for its OWN device — must NOT be able to read F-RKCUT: the decrypt
  # gate DEFERS the ciphertext forever, so F-RKCUT never materializes origin=remote on B. That is the
  # C-001 read-cut at the CONTENT layer (decrypt-fail) — the inverse of the old live witness where B
  # kept reading. WI-259-safe: only ASSERTED when K4a established healthy content federation A→B this
  # run; else INCONCLUSIVE (the device-filtered key-level K3-CUT is the governing release proof).
  rkcut="$(fed_hive_merge_probe a b "$MEMBER_SLUG" F-RKCUT ${RKCUT_PROBE_TRIES:-20} || true)"
  rkcut_on_b="${rkcut%% *}"   # 1 ⇒ B READ post-revoke content (a C-001 BREACH if K4a passed); else 0
  rkcut_on_a="$(drv_psql a "SELECT count(*) FROM harness_shared.harness_features_consolidated WHERE feature_id='F-RKCUT';" 2>/dev/null | tr -d '[:space:]')"
  # WI-6266: non-materialization alone proves only CONTENT NON-ARRIVAL. Ask B's
  # own decrypt-gate ring whether the exact ciphertext op reached the gate and
  # was deferred for its missing epoch key. The parser emits a leading validity
  # bit so an auth/route/JSON failure can never collapse to four trustworthy 0s.
  rkcut_trace_json="$(boot_history_get b 'epoch_gate_seen,epoch_defer,epoch_decrypt_fail,epoch_applied' 2>/dev/null || true)"
  rkcut_trace_counts="$(printf '%s' "$rkcut_trace_json" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    entries=d["entries"]
    assert isinstance(entries,list)
except Exception:
    sys.exit(0)
kinds=("epoch_gate_seen","epoch_defer","epoch_decrypt_fail","epoch_applied")
matched=[e for e in entries if isinstance(e,dict) and "/F-RKCUT" in str(e.get("message",""))]
counts=[sum(1 for e in matched if e.get("kind")==kind) for kind in kinds]
print("1 "+" ".join(map(str,counts)))
' 2>/dev/null)"
  rkcut_trace_ok=0; rkcut_seen=""; rkcut_defer=""; rkcut_decrypt_fail=""; rkcut_applied=""
  read -r rkcut_trace_ok rkcut_seen rkcut_defer rkcut_decrypt_fail rkcut_applied <<< "$rkcut_trace_counts" || true
  rkcut_trace_diag="seen=${rkcut_seen:-<unread>} defer=${rkcut_defer:-<unread>} decrypt-fail=${rkcut_decrypt_fail:-<unread>} applied=${rkcut_applied:-<unread>}"
  if [ "$rk_content_ctrl_ok" = 1 ]; then
    rk_content_applicable=1
    # PASS requires the complete connected-but-cut chain: K3 proved B remains
    # connected while lacking its own new-epoch key; A materialized F-RKCUT; B
    # did not; and B's exact trace says the ciphertext ARRIVED then DEFERRED —
    # never applied and never failed under a wrongly-present key.
    if [ "$rkcut_on_b" = 1 ]; then
      rk_content_cut_why="FAIL — C-001 BREACH: B READ post-revoke content F-RKCUT ($rkcut_trace_diag)"
    elif [ -z "$rkcut_on_a" ] || [ "$rkcut_on_a" -lt 1 ] 2>/dev/null; then
      rk_content_cut_why="FAIL (remaining member A lacks F-RKCUT, A-has=${rkcut_on_a:-<unread>}; $rkcut_trace_diag)"
    elif [ "$rk_cut_ok" != 1 ]; then
      rk_content_cut_why="INCONCLUSIVE (K3 connected-but-cut key witness did not pass; $rkcut_trace_diag)"
    elif [ "${rkcut_trace_ok:-0}" != 1 ]; then
      rk_content_cut_why="INCONCLUSIVE (B boot-history trace unreadable — ciphertext arrival/defer was not measured)"
    elif [ "${rkcut_seen:-0}" -lt 1 ] 2>/dev/null; then
      rk_content_cut_why="INCONCLUSIVE (B never recorded epoch_gate_seen for /F-RKCUT — non-materialization may be non-arrival; $rkcut_trace_diag)"
    elif [ "${rkcut_defer:-0}" -lt 1 ] 2>/dev/null; then
      rk_content_cut_why="INCONCLUSIVE (B saw /F-RKCUT but never recorded epoch_defer for its missing key; $rkcut_trace_diag)"
    elif [ "${rkcut_decrypt_fail:-0}" -gt 0 ] 2>/dev/null; then
      rk_content_cut_why="FAIL (B reached decrypt with a key but failed /F-RKCUT; expected permanent no-key defer; $rkcut_trace_diag)"
    elif [ "${rkcut_applied:-0}" -gt 0 ] 2>/dev/null; then
      rk_content_cut_why="FAIL — C-001 BREACH: B applied post-revoke /F-RKCUT ($rkcut_trace_diag)"
    else
      rk_content_cut_ok=1
      rk_content_cut_why="PASS (B-read=no, A-has=$rkcut_on_a; B ciphertext arrived+deferred; $rkcut_trace_diag)"
    fi
    echo "  K4b CONTENT CUT (B receives but can NO LONGER decrypt post-revoke content F-RKCUT; remaining member A reads it): $rk_content_cut_why"
  else
    echo "  K4b CONTENT CUT: INCONCLUSIVE (K4a did not establish healthy content federation A→B this run — WI-259; device-filtered key-level K3-CUT is the governing release proof)"
  fi
  fi
elif [ "${WITNESS_PROBE:-0}" = 1 ] && [ "$join_ok" = 1 ]; then
  echo "WITNESS LIFECYCLE ADMISSION: FAIL — target boot/presence/merge state is not a trustworthy security-cut substrate; AK/K mutations were not started"
  echo "WITNESS OVERALL: INCOMPLETE — lifecycle admission guard refused this rig before the folded witness"
  FAILED_SUBSETS="$FAILED_SUBSETS witness-lifecycle"
fi

# ── 6.5 MODERATION FEDERATION witness (opt-in: MODERATION_PROBE=1) ─────────────────
# WI-283 — the moderation surface's live 2-peer DELIVERY witness (takedown + report), the
# moderation analogue of the A-003 settings/content crossing. Runs ONLY after a successful
# join (B is a federating member). Independent of WITNESS_PROBE and of C-001/WI-280: BOTH legs
# ride HIVE-HOME-grained federated tables (hive_policy — the A-003-proven class — and
# hive_reports), NOT the epoch-key/content path, so neither needs the re-key flag.
#   LEG 1 TAKEDOWN (owner A → joiner B, hive_policy): A hive:takedown a content ref → B must
#     receive the RE-SIGNED owner policy origin=remote, policy_version BUMPED, and the ref
#     present in policy_json.moderation.takedownList. hive:takedown rides the hive KEY
#     (mutateHivePolicy) — NO claim gate — so it works on the octocat fixture.
#   LEG 2 REPORT (member B → owner A, hive_reports): with moderation.reportable enabled (owner-
#     authored + federated), B hive:report the ref → it must federate to A's moderation queue
#     (hive_reports on A gains the row origin=remote). Enabling reportable is the ONE claim-gated
#     step (POST /api/hive/:id/policy); papercupai isn't repo-admin on the octocat fixture, so we
#     SEED the local claim (rig affordance — su-9140a note (c)) then author via the real signed route.
# Content-free discipline (mirrors the C-001 witness): the takedown PROOF is the SIGNED-LIST delta
# (policy_version + list membership), not any content payload; BEFORE versions are captured so the
# federation delta is unambiguous.
moderation_ran=0; mod_reportable_ok=0; mod_takedown_ok=0; mod_report_ok=0
if [ "${MODERATION_PROBE:-0}" = 1 ] && [ "$join_ok" = 1 ]; then
  moderation_ran=1
  log "═══ MODERATION FEDERATION witness (WI-283: takedown + report, hive='$HIVE_SLUG') ═══"
  # Witness vars — resolved independently of the WITNESS_PROBE block so this stands alone.
  MOD_WS="$(drv_psql a "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$MOD_WS" ] && MOD_WS="$(drv_psql a "SELECT workspace_id FROM harness_shared.pot_settings WHERE harness_slug='$HIVE_SLUG' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$MOD_WS" ] && MOD_WS="$(drv_psql a "SELECT workspace_id FROM harness_shared.pot_policy WHERE harness_slug='$HIVE_SLUG' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  MOD_A_GH_ID="$(gh api "users/$P_A_USER" --jq .id 2>/dev/null | tr -d '[:space:]')"
  MOD_B_GH_ID="$(drv_psql a "SELECT github_user_id FROM harness_shared.pot_members WHERE pot_home_slug='$HIVE_SLUG' AND github_username ILIKE '$P_B_USER' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$MOD_B_GH_ID" ] && MOD_B_GH_ID="$(gh api "users/$P_B_USER" --jq .id 2>/dev/null | tr -d '[:space:]')"
  CR="F-MODTEST-$(date +%s)"
  echo "  mod vars: WS=$MOD_WS  A_GH_ID=$MOD_A_GH_ID  B_GH_ID=$MOD_B_GH_ID  contentRef=$CR"

  # ── owner-key diag (WI-5061 not_owner_swarm): the policy route recomputes the keychain id as
  # 'hive:<activeWorkspaceId()>:<urlSlug>' (hive-keypair.ts hiveKeychainId), while the mint stored
  # under the id now recorded AUTHORITATIVELY in pots.keychain_id. Dumping the row + the file-keychain
  # dir + the ws registry pins which (ws,slug) the key actually lives under vs what the route computes.
  mod_owner_diag() {
    # NULL/zero-row-safe (WI-5061): a bare a||b||NULL collapses to NULL in Postgres and a
    # zero-row SELECT prints nothing — BOTH previously rendered an EMPTY DIAG line that hid
    # the very key-custody state we need. Aggregate+coalesce guarantees one non-empty row;
    # 2>&1 (not 2>/dev/null) surfaces a schema error INLINE instead of silently swallowing it.
    echo "    DIAG A pots row (kc=pots.keychain_id, the MINT's AUTHORITATIVE id): $(drv_psql a "SELECT 'n='||count(*)||' '||COALESCE(string_agg(coalesce(workspace_id,'?ws')||'|'||coalesce(pot_home_slug,'?slug')||'|kc='||coalesce(keychain_id,'NULL-KC')||'|pk='||coalesce(left(encode(public_key,'base64'),12),'nopk'),' , '),'<no row>') FROM harness_shared.pots WHERE pot_home_slug='$HIVE_SLUG';" 2>&1 | tr '\n' ' ')"
    # C1 discriminant: loadHivePubkey/signWithHiveKey RECOMPUTE hive:<activeWs>:<slug>, while
    # ensureHiveIdentity treats pots.keychain_id as AUTHORITATIVE. If those diverge, the recompute
    # misses the on-disk key -> not_owner_swarm even though the owner holds a valid hive key.
    local aws diag_kc computed safe slugsafe d
    aws="$(grep -o '"activeWorkspaceId":"[^"]*"' "${A_HOME:-}/.papercusp-workspaces/registry.json" 2>/dev/null | head -1 | sed 's/.*:"//;s/"$//')"; aws="${aws:-default}"
    diag_kc="$(drv_psql a "SELECT keychain_id FROM harness_shared.pots WHERE pot_home_slug='$HIVE_SLUG';" 2>/dev/null | tr -d '[:space:]')"
    computed="hive:${aws}:${HIVE_SLUG}"; safe="$(printf '%s' "$computed" | sed 's/[^a-zA-Z0-9_-]/_/g')"
    slugsafe="$(printf '%s' "$HIVE_SLUG" | sed 's/[^a-zA-Z0-9_-]/_/g')"
    echo "    DIAG A key-resolve: computed='$computed' authoritative(pots.kc)='${diag_kc:-<none>}' MATCH=$([ -n "$diag_kc" ] && [ "$diag_kc" = "$computed" ] && echo yes || echo 'NO->not_owner_swarm(C1)')"
    for d in "${A_HOME:-}/.papercusp/identity" "${HOME:-}/.papercusp/identity"; do
      [ -d "$d" ] || continue
      echo "    DIAG A idir[$d]: computed-key-file=$([ -f "$d/keypair-${safe}.enc" ] && echo EXISTS || echo MISSING) slug-keys='$(ls "$d" 2>/dev/null | grep -i "$slugsafe" | tr '\n' ' ')'"
    done
    echo "    DIAG A ws registry raw: $(tr -d '[:space:]' < "${A_HOME:-}/.papercusp-workspaces/registry.json" 2>/dev/null | head -c 160 || echo 'MISSING->activeWorkspaceId()=default')"
    echo "    DIAG A serve.log key errs: $(grep -aoE 'not_owner_swarm|hive private key not held by this Swarm|pot identity mint failed[^\"]{0,120}|auth tag mismatch[^\"]{0,60}|epoch_decrypt_fail' "${FED_LOG[a]:-${A_HOME:-}/serve.log}" 2>/dev/null | sort | uniq -c | tr '\n' ' ')"
  }

  # ── PREREQ for LEG 2 — enable reporting on the owner-signed policy (done BEFORE the takedown so
  # the takedown's read-mutate-resign PRESERVES reportable). Seed A's local claim, then author via
  # the real claim-gated signed route (re-signs + federates). A soft prereq: if it fails, LEG 1
  # still runs and LEG 2 degrades to INCONCLUSIVE (never a false-FAIL).
  # WI-1918: binding rows are MEMBER-slug-keyed (hive-publish-from-repo step 6) — the hive
  # HOME slug has no row, so the old WHERE harness_slug='$HIVE_SLUG' matched 0 rows and the
  # gate 403'd hive_unclaimed. The route now accepts claimed MEMBER bindings on the hive
  # topic (topic-fallback gate); claim ALL binding rows of this hermetic instance (fresh
  # PG — only this hive's member rows exist), which the fallback finds.
  claimed="$(drv_psql a "UPDATE harness_shared.shared_repo_binding_cache SET claim_status='claimed', claimed_by_github_user_ids=ARRAY[${MOD_A_GH_ID:-0}]::bigint[], claimed_at=now() RETURNING claim_status;" 2>/dev/null | tr -d '[:space:]')"
  echo "  [reportable] seed A claim (claim_status=${claimed:-<no-binding-row>}, claimant=$MOD_A_GH_ID)"
  pol="$(curl -s -m 30 -X POST "http://127.0.0.1:${FED_SC[a]}/api/pot/$HIVE_SLUG/policy" -H 'content-type: application/json' -d '{"policy":{"moderation":{"reportable":true}}}')"
  echo "  [reportable] A POST /api/pot/$HIVE_SLUG/policy reportable=true -> $(echo "$pol" | head -c 220)"  # route renamed hive→pot (pot/policy-set.ts)
  echo "$pol" | grep -q '"ok":true' && mod_reportable_ok=1
  echo "  reportable authored on A (owner-signed): $([ "$mod_reportable_ok" = 1 ] && echo yes || echo "no — LEG 2 will be INCONCLUSIVE (report gate stays off)")"
  [ "$mod_reportable_ok" != 1 ] && mod_owner_diag

  # ── LEG 1 — TAKEDOWN (owner A → joiner B; hive_policy, hive-home-grained, A-003 class) ─────────
  M0_VER="$(drv_psql a "SELECT COALESCE(max(policy_version),-1) FROM harness_shared.pot_policy WHERE harness_slug='$HIVE_SLUG';" 2>/dev/null | tr -d '[:space:]')"
  B0_VER="$(drv_psql b "SELECT COALESCE(max(policy_version),-1) FROM harness_shared.pot_policy WHERE harness_slug='$HIVE_SLUG';" 2>/dev/null | tr -d '[:space:]')"
  echo "  [takedown] BEFORE: A policy_version=$M0_VER  B policy_version=$B0_VER"
  td="$(mcp_call a "pot:takedown" "{\"pot\":\"$HIVE_SLUG\",\"contentRef\":\"$CR\",\"workspace\":\"$MOD_WS\"}")"
  echo "  [takedown] A pot:takedown($CR) -> $(echo "$td" | head -c 240)"
  # POLL B for the federated signed-list delta: origin=remote, version bumped past M0_VER, ref present.
  for i in $(seq 1 ${DISCOVERY_RETRIES:-40}); do
    hit="$(drv_psql b "SELECT count(*) FROM harness_shared.pot_policy WHERE harness_slug='$HIVE_SLUG' AND origin='remote' AND policy_version > $M0_VER AND (policy_json::jsonb->'moderation'->'takedownList') @> to_jsonb('$CR'::text);" 2>/dev/null | tr -d '[:space:]')"
    [ "$hit" = 1 ] && { mod_takedown_ok=1; break; }
    sleep 3
  done
  B1_VER="$(drv_psql b "SELECT COALESCE(max(policy_version),-1) FROM harness_shared.pot_policy WHERE harness_slug='$HIVE_SLUG';" 2>/dev/null | tr -d '[:space:]')"
  echo "  MOD-LEG1 TAKEDOWN (B receives owner-signed takedownList origin=remote, v$M0_VER→v$B1_VER, ref present): $([ "$mod_takedown_ok" = 1 ] && echo PASS || echo "FAIL — B did not receive '$CR' on the signed takedownList as origin=remote")"
  if [ "$mod_takedown_ok" != 1 ]; then
    echo "    DIAG A policy: $(drv_psql a "SELECT 'n='||count(*)||' '||COALESCE(string_agg(policy_version||'/'||origin||' td='||COALESCE((policy_json::jsonb->'moderation'->'takedownList')::text,'null'),' , '),'<no policy row>') FROM harness_shared.pot_policy WHERE harness_slug='$HIVE_SLUG';" 2>&1 | tr '\n' ' ')"
    echo "    DIAG B policy: $(drv_psql b "SELECT 'n='||count(*)||' '||COALESCE(string_agg(policy_version||'/'||origin||' td='||COALESCE((policy_json::jsonb->'moderation'->'takedownList')::text,'null'),' , '),'<no policy row>') FROM harness_shared.pot_policy WHERE harness_slug='$HIVE_SLUG';" 2>&1 | tr '\n' ' ')"
    echo "    DIAG A outbox(pot_policy): $(drv_psql a "SELECT 'n='||count(*)||' '||COALESCE(string_agg(key||' drained='||(drained_at IS NOT NULL)::text,' , '),'<no outbox row>') FROM (SELECT key,drained_at FROM harness_shared.substrate_outbox WHERE table_name='pot_policy' ORDER BY id DESC LIMIT 3) t;" 2>&1 | tr '\n' ' ')"
    echo "    DIAG takedown err: $(echo "$td" | grep -oaE '"error":"[^"]{0,80}"|not_owner_swarm|no_owner_pubkey|hive_unclaimed' | head -2 | tr '\n' ' ')"
    mod_owner_diag
  fi

  # ── LEG 2 — REPORT (member B → owner A; hive_reports, member→owner federation, key=report_id) ──
  # Wait for reportable=true to FEDERATE to B (hive:report reads B's LOCAL federated policy).
  b_reportable=0
  if [ "$mod_reportable_ok" = 1 ]; then
    for i in $(seq 1 ${DISCOVERY_RETRIES:-40}); do
      r="$(drv_psql b "SELECT (policy_json::jsonb->'moderation'->>'reportable') FROM harness_shared.pot_policy WHERE harness_slug='$HIVE_SLUG' AND origin='remote';" 2>/dev/null | tr -d '[:space:]')"
      [ "$r" = "true" ] && { b_reportable=1; break; }
      sleep 3
    done
    echo "  [report] reportable federated to B: $([ "$b_reportable" = 1 ] && echo yes || echo "no (report will no-op → INCONCLUSIVE)")"
  fi
  rep="$(mcp_call b "pot:report" "{\"pot\":\"$HIVE_SLUG\",\"targetKind\":\"content\",\"targetRef\":\"$CR\",\"reason\":\"witness-report\",\"workspace\":\"$MOD_WS\"}")"
  echo "  [report] B hive:report($CR) -> $(echo "$rep" | head -c 220)"
  # POLL A's moderation queue (hive_reports) for the federated row origin=remote.
  for i in $(seq 1 ${DISCOVERY_RETRIES:-40}); do
    hit="$(drv_psql a "SELECT count(*) FROM harness_shared.pot_reports WHERE harness_slug='$HIVE_SLUG' AND origin='remote' AND target_ref='$CR' AND reporter_github_user_id=${MOD_B_GH_ID:-0};" 2>/dev/null | tr -d '[:space:]')"
    [ "$hit" = 1 ] && { mod_report_ok=1; break; }
    sleep 3
  done
  # Secondary confirmation via the owner tool surface (the witness shape's "queue shows it").
  q="$(mcp_call a "pot:moderation_queue" "{\"pot\":\"$HIVE_SLUG\",\"workspace\":\"$MOD_WS\"}")"
  if [ "$mod_report_ok" = 1 ]; then
    echo "  MOD-LEG2 REPORT (B's report federates to A's moderation queue origin=remote): PASS"
  elif [ "$b_reportable" = 1 ]; then
    echo "  MOD-LEG2 REPORT (B's report federates to A's moderation queue origin=remote): FAIL — report never reached A as origin=remote"
  else
    echo "  MOD-LEG2 REPORT: INCONCLUSIVE — reporting was not enabled/federated to B this run (report no-op'd; NOT a federation miss). Enable moderation.reportable (claim + policy route) and re-run."
  fi
  echo "    A hive:moderation_queue -> $(echo "$q" | head -c 240)"
  if [ "$mod_report_ok" != 1 ] && [ "$b_reportable" = 1 ]; then
    echo "    DIAG A reports: $(drv_psql a "SELECT report_id||'/'||origin||'/'||target_ref FROM harness_shared.pot_reports WHERE harness_slug='$HIVE_SLUG';" 2>/dev/null | tr '\n' ' ')"
    echo "    DIAG B reports(local): $(drv_psql b "SELECT report_id||'/'||origin||'/'||target_ref FROM harness_shared.pot_reports WHERE harness_slug='$HIVE_SLUG';" 2>/dev/null | tr '\n' ' ')"
    echo "    DIAG B outbox(pot_reports): $(drv_psql b "SELECT key||' drained='||(drained_at IS NOT NULL)::text FROM harness_shared.substrate_outbox WHERE table_name='pot_reports' ORDER BY id DESC LIMIT 3;" 2>/dev/null | tr '\n' ' ')"
  fi
fi

# ── report ──────────────────────────────────────────────────────────────────────
log "RESULT"
echo "pre-peered=$(case "$prepeer_ok" in 1) echo PASS ;; skip) echo SKIP ;; *) echo FAIL ;; esac)  create=$([ "$create_ok" = 1 ] && echo PASS || echo FAIL)  announced=$([ "$announce_ok" = 1 ] && echo PASS || echo FAIL)  degraded-cupboard=$([ "$degraded_ok" = 1 ] && echo PASS || echo FAIL)  discovered=$([ "$discover_ok" = 1 ] && echo PASS || echo FAIL)  member-links=$([ "$links_ok" = 1 ] && echo PASS || echo FAIL)  join-offer=$([ "$offer_ok" = 1 ] && echo PASS || echo FAIL)  offer-from-directory=$([ "$offer_dir_ok" = 1 ] && echo PASS || echo FAIL)  join=$([ "$join_ok" = 1 ] && echo PASS || echo FAIL)  join-clone=$([ "$clone_ok" = 1 ] && echo PASS || echo FAIL)  federate-A→B=$([ "$hive_merge_ok" = 1 ] && echo PASS || echo FAIL)  federate-B→A=$([ "$hive_rev_ok" = 1 ] && echo PASS || echo FAIL)  federate-continuous=$([ "$hive_cont_ok" = 1 ] && echo PASS || echo FAIL)"
if [ "$witness_ran" = 1 ]; then
  CONTENT_CUT_REPORT="$([ "$rk_content_applicable" = 1 ] && { [ "$rk_content_cut_ok" = 1 ] && echo PASS || echo FAIL; } || echo INCONCLUSIVE)"
  echo "WITNESS (AK + P-008): AK0-default-off=$([ "$ak_default_ok" = 1 ] && echo PASS || echo FAIL)  AK-ban=$([ "$ak_ban_ok" = 1 ] && echo PASS || echo FAIL)  AK-unban-teeth=$([ "$ak_unban_ok" = 1 ] && echo PASS || echo FAIL)  K0-join-keys=$([ "$rk_keys_ok" = 1 ] && echo PASS || echo FAIL)  K1-control=$([ "$rk_ctrl_ok" = 1 ] && echo PASS || { [ "${rk_ctrl_measurable:-1}" = 1 ] && echo FAIL || echo INCONCLUSIVE; })  K2-revoke=$([ "$rk_revoke_ok" = 1 ] && echo PASS || echo FAIL)  K3-CUT=$([ "$rk_cut_ok" = 1 ] && echo PASS || echo FAIL)  K4-CONTENT-CUT=$CONTENT_CUT_REPORT"
  # The CONTENT cut gates OVERALL only when APPLICABLE (K4a established healthy content federation):
  # applicable+pass strengthens the proof; applicable+fail is a C-001 BREACH (must fail); not-applicable
  # (WI-259 stalled content this run) never blocks — the device-filtered key-level K3-CUT governs.
  if [ "$ak_default_ok" = 1 ] && [ "$ak_ban_ok" = 1 ] && [ "$ak_unban_ok" = 1 ] && [ "$rk_keys_ok" = 1 ] && [ "$rk_ctrl_ok" = 1 ] && [ "$rk_revoke_ok" = 1 ] && [ "$rk_cut_ok" = 1 ] && { [ "$rk_content_applicable" != 1 ] || [ "$rk_content_cut_ok" = 1 ]; }; then
    echo "WITNESS OVERALL: PASS — owner-enforcement (ban + unban-teeth) + the C-001 re-key CUT (key-level, device-filtered: B's device HAD the pre-revoke epoch key, has NO post-revoke epoch key while remaining members were re-keyed)$([ "$rk_content_applicable" = 1 ] && echo " + the CONTENT-level cut (B read pre-revoke content, can NO LONGER read post-revoke content; remaining member A reads it)" || echo "") proven on the binary"
  else
    echo "WITNESS OVERALL: INCOMPLETE — see the per-leg results + the inline K-stage/AK/K4 diagnostics above"
    FAILED_SUBSETS="$FAILED_SUBSETS witness"
  fi
fi
if [ "$moderation_ran" = 1 ]; then
  MOD_REPORT_LINE="$([ "$mod_report_ok" = 1 ] && echo PASS || { [ "$mod_reportable_ok" = 1 ] && echo FAIL || echo INCONCLUSIVE; })"
  echo "MODERATION (WI-283): takedown-federates(A→B)=$([ "$mod_takedown_ok" = 1 ] && echo PASS || echo FAIL)  reportable-authored=$([ "$mod_reportable_ok" = 1 ] && echo PASS || echo FAIL)  report-federates(B→A)=$MOD_REPORT_LINE"
  # LEG 1 (takedown) is the release-governing proof (rides hive_policy, no claim/reportable dep);
  # LEG 2 (report) only strengthens it, and is INCONCLUSIVE — never a false-FAIL — when reporting
  # could not be enabled/federated this run (the claim-gated reportable prereq).
  if [ "$mod_takedown_ok" = 1 ] && [ "$mod_report_ok" = 1 ]; then
    echo "MODERATION OVERALL: PASS — takedown (owner-signed takedownList crosses A→B origin=remote) + report (member report federates B→A into the owner moderation queue) proven live on the 2-instance rig"
  elif [ "$mod_takedown_ok" = 1 ] && [ "$mod_reportable_ok" != 1 ]; then
    echo "MODERATION OVERALL: PARTIAL — takedown federation PROVEN (A→B); report leg INCONCLUSIVE (moderation.reportable could not be enabled this run — see the [reportable] diagnostics)"
  else
    echo "MODERATION OVERALL: INCOMPLETE — see the per-leg MOD-LEG results + diagnostics above"
    FAILED_SUBSETS="$FAILED_SUBSETS moderation"
  fi
fi
if [ "$attestation_ran" = 1 ]; then
  echo "ATTESTATION (P-008): seed-A-attests-B=$([ "$att_seed_A_ok" = 1 ] && echo PASS || echo FAIL)  seed-B-roster=$([ "$att_seed_B_ok" = 1 ] && echo PASS || echo FAIL)  2nd-device-merge=$([ "$att_2dev_ok" = 1 ] && echo PASS || echo FAIL)  wrong-gh-refused-op=$([ "$att_wrong_ok" = 1 ] && echo PASS || echo FAIL)  removed-device-refused-op=$([ "$att_removed_ok" = 1 ] && echo PASS || echo FAIL)"
  # Release-governing subset: membership seeding (both directions) + second-device merge + the two
  # adversarial refused-op counters. LEG4 counter-vs-blocklist nuance is folded into att_removed_ok.
  if [ "$att_seed_A_ok" = 1 ] && [ "$att_seed_B_ok" = 1 ] && [ "$att_2dev_ok" = 1 ] && [ "$att_wrong_ok" = 1 ] && [ "$att_removed_ok" = 1 ]; then
    echo "ATTESTATION OVERALL: PASS — second-device attestation + membership seeding proven on the 2-node rig; refused-op counters increment on BOTH adversarial probes (wrong gh-user-id, removed/unattested device)"
  else
    echo "ATTESTATION OVERALL: INCOMPLETE — see the per-leg ATTESTATION/LEG results + diagnostics above"
    FAILED_SUBSETS="$FAILED_SUBSETS attestation"
  fi
fi
# ── final verdict ───────────────────────────────────────────────────────────────
# SCOPE (WI-37222): the condition below covers the TWELVE CORE federation legs ONLY. The WITNESS
# (C-001 re-key), MODERATION and ATTESTATION subsets are scored as SEPARATE gate legs off their own
# `<NAME> OVERALL:` lines — do NOT fold them into this condition, or a witness-only failure would
# also report the core leg red and the two would stop being distinguishable.
#
# What WAS broken, and why it was expensive: a subset failure with green core legs took the `exit 0`
# branch, so the log preservation below NEVER RAN. $WORK is a mktemp cleaned on exit, so the frame
# serve.log went with it — and that file holds the ONLY copy of the rekey_boundary_skipped /
# rekey_boundary_applied boot events (boot-history is in-memory only, EI-18655247267756605). Those
# events were built by WI-280 + WI-6043's reopen precisely so a K2 `epoch advanced 0→0` names its own
# cause. The harness was deleting the evidence for the breach it had just detected, which is why
# WI-37195 (a live C-001 read-plane breach) survived 5 consecutive gate reds un-root-caused.
# Two rules follow, and both matter independently:
#   (1) preserve instance logs whenever ANYTHING failed — core legs OR any subset that ran;
#   (2) never let the artifact's LAST line be reassuring when the run was not. A subset failure now
#       emits a trailing ⚠ line, the inverse of the EI-19940993365684927 shape (a ✓ sub-assertion
#       BELOW a verdict, which made a failed scenario's last line read as a pass).
# `OVERALL: PASS` stays at line-start and keeps meaning CORE-LEGS-PASS: that is the string the gate
# greps for this leg. Note the gate discards this script's exit code entirely (`|| true` at
# live-federation-gate.sh:899), so the exit codes here serve STANDALONE/human runs — which is exactly
# why a subset failure must not exit 0 and read as success to someone running this by hand.
DBG="/tmp/hive-fromrepo-smoke-debug-$$"
preserve_instance_logs() {
  mkdir -p "$DBG" \
    && cp "${FED_LOG[a]}" "$DBG/a.log" 2>/dev/null
  cp "${FED_LOG[b]}" "$DBG/b.log" 2>/dev/null
}
if [ "$create_ok" = 1 ] && [ "$announce_ok" = 1 ] && [ "$degraded_ok" = 1 ] && [ "$discover_ok" = 1 ] && [ "$links_ok" = 1 ] && [ "$offer_ok" = 1 ] && [ "$offer_dir_ok" = 1 ] && [ "$join_ok" = 1 ] && [ "$clone_ok" = 1 ] && [ "$hive_merge_ok" = 1 ] && [ "$hive_rev_ok" = 1 ] && [ "$hive_cont_ok" = 1 ]; then
  echo "OVERALL: PASS — create-from-repo → discover → join → BIDIRECTIONAL + continuous hive federation proven end-to-end ($RUN_MODE mode)"
  if [ -n "${FAILED_SUBSETS:-}" ]; then
    preserve_instance_logs
    echo "⚠ SUBSET FAILURES —${FAILED_SUBSETS} — the OVERALL line above covers the TWELVE CORE federation legs ONLY and is NOT a clean-run verdict. Read the <NAME> OVERALL lines above. Instance logs (incl. the rekey_boundary_* boot events that diagnose a K2 epoch 0→0) preserved at $DBG"
    exit 7
  fi
  exit 0
else
  preserve_instance_logs
  echo "OVERALL: INCOMPLETE — instance logs preserved at $DBG"
  grep -iE "hive-directory|\[swarm\]|from-repo|publish|error" "${FED_LOG[a]}" 2>/dev/null | tail -12
  grep -iE "hive-directory|\[swarm\]|join" "${FED_LOG[b]}" 2>/dev/null | tail -8
  [ -n "${FAILED_SUBSETS:-}" ] && echo "⚠ SUBSET FAILURES ALSO —${FAILED_SUBSETS} — see the <NAME> OVERALL lines above; instance logs preserved at $DBG"
  exit 6
fi
