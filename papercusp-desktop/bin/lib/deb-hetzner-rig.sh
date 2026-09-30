#!/usr/bin/env bash
# deb-hetzner-rig.sh — REUSABLE Hetzner cross-machine federation rig lib.
#
# Extracted from bin/deb-hetzner-federation.sh (the 2-frame .deb federation proof)
# so the live-matrix scenarios (federation-release-hardening Briefs 2-7) can each be
# a SMALL scenario script that `source`s this lib + bin/lib/federation-asserts.sh,
# provisions N frames, joins them to ONE hive, then drives + asserts — WITHOUT
# copy-pasting the ~250 lines of provision/install/join machinery or colliding on a
# single shared file.
#
# Topology: this lib generalizes the old hardcoded a=owner + b=joiner to an
# ARBITRARY frame array RIG_FRAMES=(a b c …). Frame `a` is the OWNER (it runs
# pots/from-repo + surfaces the hiveId/hivePubkey/memberLink); every frame
# (owner included) then JOINs the SAME hive via POST /api/discovery/join-pot
# (joinHiveAsView re-keys it onto the owner's hive-pubkey topic — EI-681). A
# scenario picks the frame count + per-frame gh identity + region.
#
# ── COST-SAFETY (the load-bearing invariant — read before editing) ────────────
# A leaked Hetzner server BILLS REAL MONEY, so the teardown is belt-and-braces and
# MUST hold for ANY frame count:
#   • EVERY provisioned server id is appended to $RIG_SERVERS_FILE INSIDE
#     rig_create_server, BEFORE the create returns and BEFORE any install — so even
#     a crash between "POST /servers succeeded" and "frame fully set up" still
#     leaves a destroyable record on disk.
#   • rig_install_exit_trap installs an EXIT trap (rig_cleanup) that reads
#     $RIG_SERVERS_FILE line-by-line and DELETEs every id, retrying up to 6× and
#     confirming each is GONE (HTTP 404). It does NOT depend on RIG_FRAMES, the
#     FRAME_* arrays, or how far setup got — purely the on-disk id list. So N
#     frames cannot leak: each create wrote its id before doing anything billable,
#     and the trap destroys the whole file regardless of where a failure happened.
#   • A scenario MUST call rig_install_exit_trap EXACTLY ONCE, right after
#     rig_init, BEFORE rig_provision. (rig_init creates the empty servers file;
#     the trap is then armed before the first create can run.)
#
# ── nounset (`set +u`) regime ─────────────────────────────────────────────────
# The consuming rigs run under `set +u` (federation-asserts.sh + the dynamic
# assoc arrays are nounset-hostile). This lib is written to be SAFE under either
# -u or +u: every assoc-array read that might be unset uses ${arr[$k]:-}, and the
# globals are `declare`d up front. Do not introduce a bare ${arr[$k]} on a key that
# may be absent.
#
# ── What a scenario uses ──────────────────────────────────────────────────────
#   source common.sh; source federation-asserts.sh; source deb-hetzner-rig.sh
#   rig_init                              # creds, work dir, servers file, frame map
#   rig_install_exit_trap                 # ARM auto-destroy (once, before provision)
#   rig_gate_artifact "$DEB"             # extract + clobber + swarm-support gates
#   rig_set_identity a papercupai         # per-frame gh identity (resolves GH_TOKEN)
#   rig_set_identity b ownerhandle
#   rig_set_identity c ownerhandle
#   rig_provision                         # create all RIG_FRAMES servers (records ids)
#   rig_setup_frame <inst>                # install .deb + launch headless sidecar
#   rig_wait_frame_ready <inst>           # embedded-PG + sidecar API up
#   rig_owner_publish_hive a "$REPO_URL" # owner from-repo → RIG_HIVE_ID/PUBKEY/LINK
#   rig_join_hive <inst>                  # join a frame to the hive (sets MEMBER_SLUG)
#   rig_driver_run <inst> -- <cmd…>       # arbitrary SSH command on a frame
#   rig_write_content / rig_read_content / rig_read_roster
#   rig_kill_sidecar / rig_restart_sidecar
#   rig_assert_absent  (NEGATIVE assert: a row does NOT arrive within a timeout)
#   … plus the fed_* asserts from federation-asserts.sh (merge / plan-part / coord).
#
# This lib does NOT call rig_cleanup directly and never decides overall pass/fail —
# the scenario owns its exit code (behavior parity with the pre-refactor rigs).

# ── re-source guard (WI-5380, NARROWED after the 2026-07-18 orders-10-30 red) ──
# This lib holds LIVE rig state (RIG_FRAMES/FRAME_*), so a re-source must never
# REINITIALIZE that state — but it MUST still re-run the declares and function
# definitions. v1 of this guard `return 0`ed out of the whole lib on re-source;
# that broke every 00-base bidir probe from the 12:21 gate run onward (orders
# 10-30 RED, psql "Connection refused", runs 122147/142153/162155): the matrix
# re-sources transitively (source_scenarios → scenario shims b5/b6/b7/b8/
# reconnect_catchup → the standalone deb-hetzner-*.sh rigs → this lib), the
# standalone rigs override shared functions/vars for THEIR local-lane topology,
# and the full re-source of THIS lib at the end of that chain was what restored
# the matrix's definitions. Skipping the whole lib left the standalone overrides
# live. So: guard ONLY the destructive state resets (RIG_FRAMES / the quota lock
# id — WI-5380's actual bug was the RIG_FRAMES wipe that made rig_bank_logs bank
# zero serve-*.log) and let everything else re-run. `declare -gA/-ga` never
# clears an existing array, so re-running the declares is safe.

# ── globals (declared once; safe under set -u) ────────────────────────────────
declare -gA FRAME_ID FRAME_IP FRAME_USER FRAME_TOKEN FRAME_MEMBER_SLUG
declare -ga RIG_FRAMES
declare -g RIG_TOKEN RIG_SSH_KEY_ID RIG_SSH_IDENTITY
declare -g RIG_STYPE RIG_IMAGE RIG_HONO_PORT RIG_PG_PORT RIG_ANNOUNCE_REFLUSH_MS
declare -g RIG_WORK RIG_PKG RIG_SLUG RIG_SERVERS_FILE RIG_KEEP_UP
declare -g RIG_HIVE_ID RIG_HIVE_PUBKEY RIG_HIVE_LINK RIG_REPO_URL
declare -g RIG_QUOTA_LOCK_ID
# EI-18657462128167571: a monotonic "were frames EVER registered this run"
# counter, separate from RIG_FRAMES itself. RIG_FRAMES is legitimately empty
# in TWO different situations that rig_bank_logs must tell apart: (a) this run
# never got as far as rig_set_identity (e.g. rig_gate_artifact exited early on
# a stale/invalid .deb) — nothing was ever registered, so "zero frames banked"
# is the CORRECT, expected outcome, not a bug; (b) frames WERE registered and
# something later wiped RIG_FRAMES mid-run — the genuine WI-5380 state-loss
# signal. Same re-source discipline as RIG_FRAMES/RIG_QUOTA_LOCK_ID above: only
# reset on a FRESH source, never on a re-source (a re-source must not erase
# that frames were already registered earlier in this same run).
declare -g RIG_FRAMES_EVER_REGISTERED
if [ -z "${__RIG_LIB_SOURCED:-}" ]; then
  RIG_FRAMES=()
  RIG_QUOTA_LOCK_ID=""
  RIG_FRAMES_EVER_REGISTERED=0
fi
declare -g __RIG_LIB_SOURCED=1
RIG_KEEP_UP="${RIG_KEEP_UP:-0}"

# EI-21150371868241728: the shared Cargo admission reaper may inspect a rig
# workdir after its shell is gone. Pair the marker with PID start ticks so a
# reused PID cannot make an abandoned run look live; an unreadable marker is
# treated as unowned by the reaper, while the servers ledger remains the hard
# cost-safety fence for any run that provisioned real frames.
rig_write_run_marker() {
  local pid="${1:-$$}" start_ticks marker_tmp
  start_ticks="$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)"
  marker_tmp="$RIG_WORK/.papercusp-run.tmp.$$"
  umask 077
  {
    printf 'pid=%s\n' "$pid"
    [ -n "$start_ticks" ] && printf 'start_ticks=%s\n' "$start_ticks"
  } >"$marker_tmp" 2>/dev/null || return 1
  mv -f "$marker_tmp" "$RIG_WORK/.papercusp-run" 2>/dev/null || {
    rm -f "$marker_tmp" 2>/dev/null || true
    return 1
  }
}

# ── rig_init [STYPE] [IMAGE] ──────────────────────────────────────────────────
# Resolve creds + ports, make the run work dir, create the (empty) servers file.
# Idempotent fields default to the historical rig values. Must run before anything
# else; rig_install_exit_trap must run immediately after (before rig_provision).
rig_init() {
  RIG_STYPE="${1:-${RIG_STYPE:-cpx31}}"
  # IMAGE must match the .deb's target ABI: bundled embedded-PG pgvector vector.so
  # needs GLIBC_2.38 → ubuntu-24.04 (ubuntu-22.04/glibc-2.35 fails embedded-PG init
  # with "type public.vector does not exist"). EI-503.
  RIG_IMAGE="${2:-${RIG_IMAGE:-ubuntu-24.04}}"
  RIG_HONO_PORT="${RIG_HONO_PORT:-39070}"
  RIG_PG_PORT="${RIG_PG_PORT:-39532}"
  # Concrete-workspace pin (default: MINT a per-run concrete id — the production-
  # faithful path since WI-5321). No real install runs under the literal 'default'
  # workspace id anymore (fresh installs mint workspace-<hex> in Rust
  # ensure_initialized; 'default' is the DEFAULT_COORD_WORKSPACE sentinel WI-1564's
  # allotment guard fail-closes on). But rig frames launch serve.mjs HEADLESS — the
  # Rust mint never executes — so an UNPINNED frame still resolves 'default' and
  # seat_offer/spawn_request deterministically red with `workspace_unresolved`
  # (the exact false-RED of gate run 20260717-211750). The old reason this seam
  # defaulted OFF — a concrete ws regressing the substrate a→b apply
  # (fleet_directory card missing on the peer) — is FIXED: RUN-2 m1784334810
  # (2026-07-17, WI-5321 completion evidence) passed seat_offer + spawn_request +
  # fleet_directory 3/3 under RIG_WORKSPACE_ID=workspace-fedcba98. Override with a
  # specific id to pin it, or RIG_WORKSPACE_ID=default to force the retired
  # legacy baseline (archaeology only — the seat legs can never pass under it).
  RIG_WORKSPACE_ID="${RIG_WORKSPACE_ID:-workspace-rig$(openssl rand -hex 4 2>/dev/null || printf '%08x' $((RANDOM * 32768 + RANDOM)))}"
  # Operator-home harness slug (operatorHomeHarnessSlug ← PAPERCUSP_POT_HOME_SLUG,
  # else 'papercusp'). NOTE: on a fresh frame NO slug resolves at BOOT (projects are
  # created/joined post-boot), so the checkHomeHarnessResolves boot-validation warns
  # regardless — non-fatal (a red herring for the apply regression above).
  #
  # WI-5631: this MUST be a non-'papercusp' value on every rig run. When unset, the
  # frame's home-harness slug falls through to the app's LEGACY_DEFAULT_HOME_HARNESS
  # ('papercusp') — which then matches the `harness_slug` the frame's own engineer-issues
  # projection guard (decideMemberContentOp) sees on federated ops carrying the REAL
  # production papercusp home-harness backlog, so that guard's own-slug fast path
  # (`rowHarnessSlug === opts.harnessSlug` → unconditional 'apply', no membership check)
  # admits + writes the whole real backlog into the frame — the id-collision storm
  # (8068+ "EI-13285 id collision" ops/run) that starves the frame's event loop and
  # blocks a clean replication_soak pass. local-matrix.sh sets a synthetic default so
  # this is never empty on the local (BYO-frames) path; a genuine Hetzner-provisioned
  # run should set it too.
  RIG_HOME_HARNESS_SLUG="${RIG_HOME_HARNESS_SLUG:-}"

  # WI-5634: boot-all.ts's connected_never_replicated (WI-183 zombie-socket)
  # DETECTION grace defaults to 180s (DEFAULT_LIVENESS_GRACE_MS) — structurally
  # larger than replication_soak's 90s per-cycle SLA, so whenever a genuine
  # zombie connection occurs during the soak's kill/restart churn the cycle
  # fails BY CONSTRUCTION regardless of how quickly the repair-on-detect path
  # runs once it fires (live-evidenced: gate run 20260720-054709, cycles 3/4
  # both legs FAIL at "204s"/"217s connected-but-dead" — the escalation itself
  # was prompt <1s, the DETECTION wasn't). boot-all.ts already threads a
  # PAPERCUSP_REPLICATION_STALL_GRACE_MS env override for exactly this
  # (production default left unchanged at 180s) but nothing wired it into this
  # rig's frame launch — that's the missing piece. 15s is well under the 60s
  # SWARM_CHURN_TOLERANCE_MS reset window's neighbourhood but comfortably
  # inside the 90s SLA with ~75s of margin for repair + feature-landing to
  # complete; it only changes behavior for logs that are GENUINELY
  # connected-but-never-replicated (a cycle whose replicator attaches
  # normally, however long the end-to-end feature landing itself takes, never
  # enters this axis and is unaffected). Override with
  # RIG_REPLICATION_GRACE_MS if a scenario needs the production value (or a
  # different test value) — threaded to the frames below as PAPERCUSP_
  # REPLICATION_STALL_GRACE_MS via RIG_GRACE.
  RIG_REPLICATION_GRACE_MS="${RIG_REPLICATION_GRACE_MS:-15000}"

  # WI-38376: the SAME reasoning, one axis further along — and this is the axis
  # that actually matters for replication_soak's residual failure mode.
  #
  # The override above deliberately reaches ONLY the zombie
  # (connected_never_replicated) axis, which arms exactly when peersCount === 0.
  # That leaves `frozen` — the ONLY axis covering "a replicator IS attached and
  # the writer IS ahead, but nothing is arriving" — sharing the 180s production
  # default, i.e. 2x this scenario's 90s SLA. Consequence, measured on full-matrix
  # run m1786592636: the cycle-3 A→B leg missed its SLA and produced ZERO
  # detector events on ANY of the three frames for the whole 90s window. The
  # scenario's own fire-path pin still passed, because it is scoped to the whole
  # soak and matched cycle 2's expected restart stall — so the run LOOKED like
  # "the detector saw it" while the detector had in fact been silent throughout.
  # Three prior items (WI-5448/WI-5634/WI-5639) chased host load for a mechanism
  # signal that was never going to be emitted.
  #
  # 45s: comfortably inside the 90s SLA (leaving ~45s for the episode to fire,
  # repair-on-detect to run, and the feature to land) and far above the ~3s
  # healthy end-to-end landing time, so a normal cycle never approaches it.
  # Shortening THIS axis does not re-open the WI-5672/WI-5686 false-positive
  # class: that came from a cold restart legitimately holding 0 peers past a
  # short grace, and `frozen` cannot arm at 0 peers by construction.
  # Set RIG_FROZEN_GRACE_MS=0 to leave the production 180s in place.
  RIG_FROZEN_GRACE_MS="${RIG_FROZEN_GRACE_MS:-45000}"

  # WI-38376 P-002: SignedAnnounce.log_length is the writer-progress heartbeat,
  # so the replication_soak rig must re-flush it comfortably inside its 90s SLA.
  # Keep this RIG-ONLY: swarm.ts's production default remains five minutes.
  # Fifteen seconds leaves several independent heartbeat opportunities before
  # the 45s frozen detector fires, while still being negligible traffic (one
  # small signed frame per local log). Override for diagnostics; 0 preserves the
  # runtime kill-switch semantics.
  RIG_ANNOUNCE_REFLUSH_MS="${RIG_ANNOUNCE_REFLUSH_MS:-15000}"

  RIG_TOKEN="${HCLOUD_TOKEN:-$(cat ~/.papercusp/hcloud-token 2>/dev/null)}"
  # BYO-frames mode (RIG_FRAME_IPS set) never touches the Hetzner API, so no token
  # is required. Hetzner access was gone 2026-07-03→2026-07-09 (D-001 of
  # shared-hive-p2p-release-readiness-2026-07-03); a NEW Hetzner account is live
  # since 2026-07-09 — token at ~/.papercusp/hcloud-token, SSH key
  # 'papercusp-frame-deploy' id 114898429. bin/local-matrix.sh remains the
  # one-command LOCAL bring-up (no spend).
  if [ -z "$RIG_TOKEN" ] && [ -z "${RIG_FRAME_IPS:-}" ]; then
    echo "FATAL: no HCLOUD_TOKEN (or ~/.papercusp/hcloud-token); for LOCAL frames set RIG_FRAME_IPS (one-command: bin/local-matrix.sh)" >&2; return 1
  fi
  RIG_SSH_KEY_ID="${HETZNER_SSH_KEY_ID:-114898429}"
  # BYO seam: an inherited RIG_SSH_IDENTITY (bin/local-matrix.sh exports the
  # local frames' key ~/.papercusp/local-rig-ssh) WINS — rig_init must NOT
  # clobber it back to the Hetzner default. The old unconditional overwrite +
  # IdentitiesOnly=yes in rig_ssh made every BYO run offer ONLY the wrong key
  # → auth-fail → "FATAL ssh" at the first rig_setup_frame (2026-07-03, P-004
  # soak runs #2/#3; masked before the IdentitiesOnly fix by a loaded ssh-agent
  # offering its whole keyring first).
  RIG_SSH_IDENTITY="${RIG_SSH_IDENTITY:-${HETZNER_SSH_IDENTITY:-$HOME/.ssh/papercusp-latitude-frame}}"

  RIG_WORK="$(mktemp -d /tmp/deb-hzfed.XXXXXX)"
  RIG_PKG="$RIG_WORK/pkg"
  RIG_SLUG="hzdeb${RIG_WORK##*.}"
  RIG_SERVERS_FILE="$RIG_WORK/servers"; : > "$RIG_SERVERS_FILE"
  RIG_KEEP_UP="${RIG_KEEP_UP:-0}"
  rig_write_run_marker "$$" || { echo "FATAL: could not write rig ownership marker under $RIG_WORK" >&2; return 1; }
  if [ "$RIG_KEEP_UP" = 1 ]; then
    : > "$RIG_WORK/.papercusp-keep"
  fi
  # WI-1442 fix (c) / WI-1628: stamp every server this run creates with the
  # CREATING AGENT's owner id (a Hetzner label — see rig_create_server below) so
  # the orphan-frame reaper can resolve whose coord:presence to check before ever
  # destroying a frame a hard-killed agent left running. Sanitized to Hetzner's
  # label-value charset ([a-zA-Z0-9_.-], <=63 chars) — PAPERCUSP_SID (su-<uuid>)
  # already fits; the fallback keeps rig_create_server working (unlabeled) for a
  # shell that isn't a papercusp agent session, at the cost of the reaper skipping
  # those frames (no owner to verify — see hetzner-orphan-frame-reaper.ts's safety model).
  RIG_OWNER_LABEL="$(printf '%s' "${PAPERCUSP_SID:-}" | tr -c 'a-zA-Z0-9_.-' '-' | cut -c1-63)"
  # Hetzner recycles the same public IPs run-to-run, so a persisted mux master
  # from a DESTROYED frame would poison the new frame's connections — start clean.
  rm -f /tmp/deb-hzfed-mux-* 2>/dev/null || true
  echo "rig_init: work=$RIG_WORK slug=$RIG_SLUG type=$RIG_STYPE image=$RIG_IMAGE" >&2
}

# ── Hetzner API + SSH helpers ─────────────────────────────────────────────────
rig_hz()  { curl -s -m 40 -H "Authorization: Bearer $RIG_TOKEN" "$@"; }
# ControlMaster multiplexing: the rig fires DOZENS of short ssh/scp connections
# per run at the same 2 recycled IPs, and 3 consecutive 2026-07-01 runs died on
# transient port-22 connect timeouts mid-run (SYN throttling somewhere on the
# path). One persistent master per frame makes every later call ride an ALREADY-
# OPEN connection; ConnectionAttempts retries the initial TCP connect itself.
RIG_SSH_MUX_OPTS=(-o ControlMaster=auto -o ControlPath=/tmp/deb-hzfed-mux-%r@%h -o ControlPersist=900)
rig_ssh() { local ip="$1"; shift; ssh -i "$RIG_SSH_IDENTITY" -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15 \
  -o ConnectionAttempts=3 "${RIG_SSH_MUX_OPTS[@]}" \
  -o ServerAliveInterval=15 "root@$ip" "$@"; }
# ^ IdentitiesOnly: without it a loaded ssh-agent offers its whole keyring before
# the -i identity and trips the server's MaxAuthTries ("Too many authentication
# failures") — found 2026-07-03 on the local containerized frames (P-002).
# dst spaces are safe UNquoted: OpenSSH ≥9 scp speaks SFTP (no remote shell), so
# the path arrives as one literal — and added quotes become literal characters
# (proven 2026-07-01: "dest open \"'/tmp/…'\"" failed a run). Install roots may
# contain a space since the 'Papercusp GUI' productName rename.
rig_scp() { local ip="$1" src="$2" dst="$3"; scp -i "$RIG_SSH_IDENTITY" -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15 \
  -o ConnectionAttempts=3 "${RIG_SSH_MUX_OPTS[@]}" "$src" "root@$ip:$dst"; }
# rig_ssh_wait <ip> [tries] — re-probe connectivity until an ssh no-op succeeds.
# Fresh Hetzner VMs flap transiently (2026-07-01: a ConnectTimeout at the launch
# step killed a whole Brief-4 run AFTER the 986MB install had succeeded). A probe
# is retry-safe where rig_ssh itself is NOT (stdin-fed `bash -s` calls can't be
# blindly re-run), so callers insert this BEFORE each critical ssh step.
rig_ssh_wait() {
  local ip="$1" tries="${2:-12}" i
  for i in $(seq 1 "$tries"); do rig_ssh "$ip" true 2>/dev/null && return 0; sleep 5; done
  echo "FATAL: ssh $ip unreachable after $tries probes" >&2; return 1
}

# rig_create_server <name> <loc> → echo "<id> <ip>"
# COST-SAFETY: appends <id> to $RIG_SERVERS_FILE the instant the POST succeeds,
# BEFORE waiting for boot or doing anything billable. The EXIT trap destroys every
# id in that file, so a crash anywhere after this point still cleans up.
rig_create_server() {
  local name="$1" loc="$2" resp id try
  # The create POST can return an EMPTY body while the server IS created
  # (observed 2026-07-02: empty response, then 409 "name is already used" on
  # retry). So: retry the create up to 3×, and on ANY attempt also try to
  # RECOVER the id by name — covering both the transient-empty and the
  # created-but-unreported cases without double-provisioning.
  # WI-1628: label body fragment — empty ({}) when no owner is resolvable (a shell
  # outside a papercusp agent session), so create() behaves exactly as before.
  local labels_json="{}"
  [ -n "${RIG_OWNER_LABEL:-}" ] && labels_json="{\"pcusp-owner\":\"$RIG_OWNER_LABEL\"}"
  for try in 1 2 3; do
    resp="$(rig_hz -X POST 'https://api.hetzner.cloud/v1/servers' -H 'content-type: application/json' \
      -d "{\"name\":\"$name\",\"server_type\":\"$RIG_STYPE\",\"image\":\"$RIG_IMAGE\",\"location\":\"$loc\",\"ssh_keys\":[$RIG_SSH_KEY_ID],\"labels\":$labels_json}")"
    id="$(printf '%s' "$resp" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("server",{}).get("id") or "")' 2>/dev/null)"
    [ -n "$id" ] && break
    id="$(rig_hz "https://api.hetzner.cloud/v1/servers?name=$name" | python3 -c 'import json,sys;s=json.load(sys.stdin).get("servers",[]);print(s[0]["id"] if s else "")' 2>/dev/null)"
    [ -n "$id" ] && { echo "  (recovered $name by name after an empty create response)" >&2; break; }
    [ "$try" = 3 ] && { echo "FATAL create $name: $resp" >&2; return 1; }
    sleep 5
  done
  echo "$id" >> "$RIG_SERVERS_FILE"   # cost-safety: record BEFORE waiting/installing
  local i ip status
  for i in $(seq 1 60); do
    resp="$(rig_hz "https://api.hetzner.cloud/v1/servers/$id")"
    status="$(printf '%s' "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["server"]["status"])' 2>/dev/null)"
    ip="$(printf '%s' "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["server"]["public_net"]["ipv4"]["ip"])' 2>/dev/null)"
    [ "$status" = "running" ] && [ -n "$ip" ] && { echo "$id $ip"; return 0; }
    sleep 5
  done
  echo "FATAL $name not running" >&2; return 1
}
rig_delete_server() { rig_hz -X DELETE "https://api.hetzner.cloud/v1/servers/$1" >/dev/null 2>&1; }
rig_server_gone()   { local code; code="$(rig_hz -o /dev/null -w '%{http_code}' "https://api.hetzner.cloud/v1/servers/$1")"; [ "$code" = "404" ]; }

# ── log banking (WI-5373 STEP 2, 2026-07-18): structural, not manually-armed ──
# Two banking gaps in 24h (run 032603: an ad-hoc, hand-run bank script had an
# early-exit grep bug; run 044437: nothing armed it at all — a timer-fired run has
# no human present to arm a sidecar script) left every anomalous run's per-frame
# serve.log and load state post-hoc unexplainable: rig_cleanup destroys the frames
# (and, absent --keep-up, $RIG_WORK itself) before anyone can read them. Bank
# BEFORE any destructive step, UNCONDITIONALLY — every run, timer-fired or
# manual, pass or fail — so the two recurring triage questions are always
# answerable: (1) what did each frame's own serve.log say at teardown, and
# (2) was the box saturated (a rig-load event) or calm (a real regression)
# during the run. Lands OUTSIDE $RIG_WORK (which rig_cleanup rm -rf's right
# after this, absent --keep-up) so it survives; RIG_BANK_KEEP bounds growth.
# Best-effort throughout (fetch/mkdir/docker failures are logged, never fatal) —
# banking must never abort or mask the run's actual verdict.
RIG_BANK_DIR="${RIG_BANK_DIR:-$HOME/.papercusp/live-fed-gate/triage}"
RIG_BANK_KEEP="${RIG_BANK_KEEP:-200}"
# WI-6070 (2026-07-26): how many FAILURE bundles (fail/<stamp>/ dirs) to keep.
# Counted in DIRECTORIES, not files, and bounded SEPARATELY from RIG_BANK_KEEP
# so that abundant PASS banks can never evict scarce FAIL evidence — see the
# rationale block above the fail-bundle hardlink below.
RIG_BANK_FAIL_KEEP="${RIG_BANK_FAIL_KEEP:-60}"
# EI-18660101091813036 (2026-07-26): this function already banked serve.log once,
# unconditionally, in the EXIT trap — but ONLY once, at run end. serve.log is
# CUMULATIVE across the whole matrix pass (the same "un-time-scoped" limitation
# WI-5715/P-411 already had to work around for the detector ASSERT), so a
# single end-of-run snapshot conflates every scenario in the run, and a run that
# never reaches a clean EXIT (SIGKILL, host OOM) bank NOTHING at all — the exact
# gap that made 4 agents hand-roll ad-hoc rescue scripts (see the EI's evidence).
# Accept an optional `tag` (a scenario id) so the scenario loop in
# deb-hetzner-matrix.sh can call this on EVERY FAIL, not just once at the end —
# each call is still fully best-effort/non-fatal, same contract as before.
rig_bank_logs() {  # [tag] — optional context tag (e.g. a scenario id) folded into the stamp
  local tag="${1:-}" stamp inst path
  mkdir -p "$RIG_BANK_DIR" 2>/dev/null || { fed_log "bank: cannot mkdir $RIG_BANK_DIR — skipping (best-effort)"; return 0; }
  stamp="$(date +%H%M%S 2>/dev/null || echo now)"
  [ -n "$tag" ] && stamp="${stamp}-${tag}"
  fed_log "bank: persisting per-frame serve.log + load markers to $RIG_BANK_DIR (stamp=$stamp)${tag:+ [on-FAIL mid-run bank]}"
  # Empty frame state must be LOUD ONLY when it is genuinely suspicious. Two
  # different situations both show up as "RIG_FRAMES is empty at bank time":
  #   (a) this run never got as far as rig_set_identity (e.g. rig_gate_artifact
  #       exited on a stale/invalid .deb, before any frame was ever registered)
  #       — zero frames banked is the CORRECT, expected outcome; alarming on it
  #       sends the next agent root-causing a "wiped state" bug that never
  #       happened (EI-18657462128167571).
  #   (b) frames WERE registered earlier in this run and RIG_FRAMES is now
  #       empty — the genuine WI-5380 state-loss signal (a lib re-source that
  #       clobbered live state). This one must stay LOUD.
  # RIG_FRAMES_EVER_REGISTERED (bumped once per rig_set_identity call, and
  # itself immune to a re-source — same guard as RIG_FRAMES) is the cheap
  # discriminator between the two.
  if [ "${#RIG_FRAMES[@]}" -eq 0 ]; then
    if [ "${RIG_FRAMES_EVER_REGISTERED:-0}" -gt 0 ]; then
      fed_log "bank: ⚠ RIG_FRAMES is EMPTY at bank time — NOTHING to bank (WI-5380 class: frame state was lost mid-run, e.g. a lib re-source)"
      echo "RIG_FRAMES was empty when rig_bank_logs ran (stamp=$stamp) — zero serve logs banked (WI-5380 class)." \
        >"$RIG_BANK_DIR/BANK-EMPTY-$stamp.txt" 2>/dev/null || true
    else
      fed_log "bank: no frames were ever registered this run — nothing to bank (expected for a run that exited before rig_set_identity, e.g. an early rig_gate_artifact failure; not WI-5380)"
    fi
  fi
  for inst in "${RIG_FRAMES[@]}"; do
    [ -n "${FRAME_IP[$inst]:-}" ] || continue
    # Empty-string bug (verified 2026-07-18, same re-source-drift class as
    # WI-5396): if a scenario shim re-sources federation-asserts.sh AFTER this
    # lib without re-sourcing this lib again, ITS arg-requiring drv_applog
    # (keyed off FED_LOG, which this Hetzner driver never populates) shadows
    # ours — and it SUCCEEDS with empty stdout, so `drv_applog || echo ...`
    # never falls back (the command didn't fail, it just printed nothing).
    # Check emptiness explicitly, not just exit status, and be LOUD about it
    # (same "never silent" precedent as the RIG_FRAMES-empty check above) —
    # this exact silent-empty-bank bug cost a run's entire A-003 forensic
    # evidence (WI-5369) before being caught.
    path="$(drv_applog 2>/dev/null)"
    if [ -z "$path" ]; then
      fed_log "bank: ⚠ drv_applog returned EMPTY for frame $inst (function-override shadow) — falling back to the known default path"
      path="/home/pcusp/serve.log"
    fi
    { drv_exec "$inst" <<<"cat '$path' 2>/dev/null || echo '(no serve.log at $path)'"
      echo "=== bank $stamp: frame $inst /proc/loadavg ==="
      drv_exec "$inst" <<<"cat /proc/loadavg 2>/dev/null" 2>/dev/null
    } >"$RIG_BANK_DIR/serve-$inst-$stamp.log" 2>/dev/null \
      || echo "(bank fetch failed for frame $inst — ssh/frame may already be gone)" >"$RIG_BANK_DIR/serve-$inst-$stamp.log"
    # EI-18687774064705397 (2026-07-26, "evidence-scoping trap"): serve.log is
    # CUMULATIVE for the whole rig session (grows across every scenario since the
    # last provision/--reuse), not scoped to one scenario or run — so a reader
    # comparing several serve-$inst-*.log bank files can mistake NESTED snapshots
    # of one growing log for independent runs (proven live: three bank files
    # 020217/021834/022802 from one night's session all began at the identical
    # first log line 05:59:08.366Z — one continuous log, not three). Stamp each
    # bank file's OWN first/last in-content timestamp up front, so the nesting
    # risk is visible at read time instead of something the next reader has to
    # re-derive by diffing files. See agent-insights/establish-evidence-scope-before-reading.
    _bank_file="$RIG_BANK_DIR/serve-$inst-$stamp.log"
    if [ -s "$_bank_file" ]; then
      _first_ts="$(grep -m1 -oE '^\[[0-9TZ:.+-]+\]' "$_bank_file" 2>/dev/null || true)"
      _last_ts="$(grep -oE '^\[[0-9TZ:.+-]+\]' "$_bank_file" 2>/dev/null | tail -1 || true)"
      # EI-18744109084137549 (2026-07-27, "manufactured absence" — 3rd instance
      # of this shape in one day): this file's content NEVER records a
      # scenario/subject id (e.g. an offer's mx-<scenario>-<runid> slug) — that
      # is true for EVERY scenario, passing or failing, not just the one that
      # triggered this bank. A reader who greps this file for a failing
      # subject's id and gets zero hits has learned NOTHING, because the same
      # grep against a KNOWN-PASSING leg's id from the same run also returns
      # zero. Say so up front, in the file itself, so the absence a reader
      # finds here can never again look like scoped evidence by default.
      { printf '=== bank %s: frame %s — serve.log is CUMULATIVE for the whole rig session, NOT scoped to one scenario/run. This snapshot'\''s own content spans %s .. %s — before treating this file as an independent run from another bank file, check whether ITS first timestamp matches (same session, nested snapshot) rather than diffing/summing counts between them. ⚠ ALSO: this log format does NOT record scenario/subject ids at all (for any scenario) — an id'\''s ABSENCE here is NOT evidence the corresponding operation never happened. Before concluding that from a grep miss, confirm the format truly carries no subject ids by grepping a KNOWN-GOOD id from a PASSING leg of the SAME run; if that is also absent, this file carries no information about your question and you must look elsewhere (application-level receipts/DB state) to tell arrive-vs-refuse apart. ===\n' \
          "$stamp" "$inst" "${_first_ts:-?}" "${_last_ts:-?}"
        cat "$_bank_file"
      } >"$_bank_file.tmp" 2>/dev/null && mv -f "$_bank_file.tmp" "$_bank_file" || rm -f "$_bank_file.tmp" 2>/dev/null
    fi
  done
  { echo "=== bank $stamp: host /proc/loadavg ==="; cat /proc/loadavg 2>/dev/null || true
    echo "=== bank $stamp: host docker stats (informational — n/a for a pure-Hetzner rig) ==="
    command -v docker >/dev/null 2>&1 && docker stats --no-stream 2>/dev/null || echo "(docker unavailable)"
  } >"$RIG_BANK_DIR/load-$stamp.txt" 2>/dev/null || true
  # WI-5481 gap (2026-07-19): $RIG_WORK/scn.<id>.log holds each scenario's FULL
  # raw stdout (per-cycle detail a scenario's own summary line filters out —
  # see b8-replication-soak.sh) but rig_cleanup rm -rf's $RIG_WORK right after
  # this function returns (absent --keep-up), so that detail was unreachable
  # by any post-hoc/next-wake investigation — only readable in the ~1min window
  # between a scenario finishing and teardown. Bank every scn.*.log here too,
  # same as serve-*.log above, so it survives for as long as RIG_BANK_KEEP.
  if [ -n "${RIG_WORK:-}" ] && [ -d "$RIG_WORK" ]; then
    local f base
    for f in "$RIG_WORK"/scn.*.log; do
      [ -e "$f" ] || continue
      base="$(basename "$f")"
      cp -f "$f" "$RIG_BANK_DIR/${base%.log}-$stamp.log" 2>/dev/null || true
    done
  fi
  # WI-6070 (2026-07-26): FAIL evidence must not compete with PASS noise ───────
  # The retention below is ONE undifferentiated FIFO over every banked pattern.
  # A single bank call writes ~20 files (2 serve + ~17 scn + 1 load) and a run
  # that FAILS banks TWICE (the mid-run on-FAIL call from
  # deb-hetzner-matrix.sh:350 plus the EXIT-trap call in rig_cleanup) — so
  # RIG_BANK_KEEP=200 is only ~5-10 RUNS of history, not the open-ended window
  # the ":394 survives for as long as RIG_BANK_KEEP" comment above implies.
  #
  # That FIFO is backwards for this workload: a PASS bank is regenerated FREE
  # every hour by the gate timer, while a FAIL bank of an INTERMITTENT defect
  # may be the ONLY copy that will ever exist. Treating them as equally
  # disposable lets abundant PASS noise evict irreplaceable FAIL evidence — and
  # it is self-defeating precisely when it matters most, because the more runs
  # an investigation fires hunting an intermittent bug, the faster it evicts
  # the one run that reproduced it. Proven live: the sole banked artifact of
  # the WI-6043 revocation leak (stamp 090342, 13:03Z — the only
  # revocation_kcut FAIL of the day) was GONE by 16:17Z, evicted by ~10
  # subsequent all-PASS generations, while OLDER unrelated files from 00:55
  # survived because they are not in the churning pattern set.
  #
  # A TAGGED bank IS a failure bank: deb-hetzner-matrix.sh:350 is the only
  # caller that passes a tag, and it does so from its on-FAIL branch. So
  # HARDLINK a tagged bank's files into fail/<stamp>/ — the same inodes, ~0
  # extra bytes — and the FIFO below can unlink the flat name without
  # destroying the content. Readers keep using the flat dir exactly as before;
  # the fail/ bundle is the copy that survives, and it groups one failure's
  # evidence into one dir, which is what a triager actually wants. Raising
  # RIG_BANK_KEEP would NOT fix this — it only delays the eviction; the two
  # populations have to stop competing. Best-effort/non-fatal throughout, same
  # contract as the rest of this function.
  if [ -n "$tag" ]; then
    local faildir="$RIG_BANK_DIR/fail/$stamp" bf
    if mkdir -p "$faildir" 2>/dev/null; then
      for bf in "$RIG_BANK_DIR"/serve-*-"$stamp".log \
                "$RIG_BANK_DIR"/load-"$stamp".txt \
                "$RIG_BANK_DIR"/scn.*-"$stamp".log; do
        [ -e "$bf" ] || continue
        # hardlink first (free); fall back to a real copy if the link fails.
        cp -l -f "$bf" "$faildir/" 2>/dev/null || cp -f "$bf" "$faildir/" 2>/dev/null || true
      done
      # EI-18744109084137549: a standalone, impossible-to-miss caveat file (the
      # per-serve-log header above says the same thing, but a triager who opens
      # the bundle and greps every *.log for their subject id before reading any
      # one file's header in full will still walk straight into the trap — this
      # file is the thing `ls "$faildir"` surfaces first).
      cat >"$faildir/README-SCOPE-CAVEAT.txt" <<EOF
This bundle's serve-*.log files are per-frame application logs. They are
CUMULATIVE for the whole rig session (see each file's own header for its
in-content time span) and they do NOT record scenario/subject ids (e.g. an
offer's mx-<scenario>-<runid> slug) AT ALL, for any scenario.

Grepping these files for a failing subject's id and finding zero hits is
NOT evidence that the corresponding operation (offer publish/apply,
membership change, etc.) never happened — the same grep against a
KNOWN-PASSING leg's id from this same run also returns zero. Confirm that
control before drawing any conclusion from an absence here. If the control
id is also absent, these logs carry no information about your question;
look at application-level state (receipts/DB rows) instead.

Background: EI-18744109084137549 (2026-07-27) — the 3rd instance in one day
of a surface manufacturing a misleading absence.
EOF
      fed_log "bank: FAIL evidence bundled (prune-exempt) in $faildir — read THIS once the flat bank dir has rotated (⚠ see $faildir/README-SCOPE-CAVEAT.txt before reasoning from an absence in the serve-*.log files)"
      # Bounded separately, in DIRECTORIES, and far more generously: failures
      # are rare, and these are hardlinks, so many months of them cost ~nothing.
      ( cd "$RIG_BANK_DIR/fail" 2>/dev/null && ls -1dt */ 2>/dev/null \
          | tail -n "+$((RIG_BANK_FAIL_KEEP + 1))" | xargs -r rm -rf -- ) 2>/dev/null || true
    else
      fed_log "bank: ⚠ cannot mkdir $faildir — FAIL evidence stays flat-only and WILL be FIFO-evicted by later passing runs"
    fi
  fi
  # bounded retention — keep the newest RIG_BANK_KEEP files across all patterns.
  # NOTE: this glob is deliberately non-recursive and cd-scoped, so the
  # fail/<stamp>/ bundles above are never candidates for eviction.
  ( cd "$RIG_BANK_DIR" 2>/dev/null && ls -t serve-*.log load-*.txt scn.*-*.log 2>/dev/null \
      | tail -n "+$((RIG_BANK_KEEP + 1))" | xargs -r rm -f -- ) 2>/dev/null || true
}

# ── teardown: the EXIT-trap auto-destroy (N-frame correct) ────────────────────
# Reads ONLY $RIG_SERVERS_FILE — never RIG_FRAMES / the FRAME_* arrays — so it
# destroys every server that was ever created, regardless of how many frames there
# are or where setup failed. Each id is DELETEd (retry ×6) and confirmed GONE (404).
rig_cleanup() {
  rig_bank_logs
  fed_log "cleanup — DESTROY all frames (ends billing)"
  local id i
  if [ "${RIG_KEEP_UP:-0}" = 1 ]; then
    echo "  --keep-up: leaving $(tr '\n' ' ' < "$RIG_SERVERS_FILE" 2>/dev/null)" >&2
  else
    while read -r id; do [ -n "$id" ] || continue
      for i in 1 2 3 4 5 6; do rig_delete_server "$id"; rig_server_gone "$id" && { echo "  destroyed $id"; break; }; sleep 5; done
      rig_server_gone "$id" || echo "  ⚠ $id may still BILL — destroy manually (DELETE /v1/servers/$id)"
    done < "$RIG_SERVERS_FILE"
  fi
  # The matrix summary promises per-scenario logs are "kept if --keep-up" — honor
  # it: an unconditional rm here destroyed the forensics of two failed
  # reconnect_catchup runs (EI-13317) before anyone could read them.
  if [ "${RIG_KEEP_UP:-0}" = 1 ]; then
    echo "  --keep-up: keeping work dir $RIG_WORK (per-scenario logs)" >&2
  else
    rm -rf "$RIG_WORK" 2>/dev/null
  fi
  # EI-5884 / WI-1442 fix (b): release the quota mutex UNCONDITIONALLY (even
  # under --keep-up, and even on a killed run — this runs from the EXIT trap)
  # so the next queued run can attempt its own provision. A real Hetzner
  # server_limit conflict (e.g. --keep-up left both slots occupied) still
  # surfaces as a genuine resource_limit_exceeded from the API — this mutex
  # only serializes the CREATE race, it does not model ongoing server count.
  rig_quota_release
}

# rig_install_exit_trap — ARM the auto-destroy. Call ONCE, right after rig_init,
# BEFORE rig_provision, so the trap is live before the first server is created.
rig_install_exit_trap() { trap rig_cleanup EXIT; }

# ── quota mutex: ops/hetzner-federation-quota (EI-5884 / WI-1442 fix b) ───────
# The Hetzner project's PERMANENT 2-server cap is shared across EVERY live-brief
# rig run. Before this fix the "acquire before provisioning" protocol was PROSE
# ONLY — ops/hetzner-federation-quota was never a registered resource, so
# locks:acquire_resource returned unknown_resource and concurrent runs raced
# rig_provision directly (2026-07-01: Brief 3 checked servers=0, then lost the
# create race to a concurrent run that grabbed both slots in the gap). Now
# registered (packages/locks/src/sql/016-*.sql); rig_provision acquires it
# EXCLUSIVELY (retrying while contended) before creating any server, and
# rig_cleanup releases it unconditionally — a bounded TTL (below) is the
# liveness backstop: even a hard-killed holder's lease lapses on its own
# rather than leaving a phantom hold forever.
RIG_QUOTA_RESOURCE="ops/hetzner-federation-quota"
# RIG_QUOTA_LOCK_ID is initialized in the re-source-guarded state block at the
# top of this lib — a bare reset here would wipe a HELD lock id on re-source.
OPERATOR_MCP_URL="${OPERATOR_MCP_URL:-http://127.0.0.1:3070/api/mcp}"
# SUPERUSER BEARER (2026-07-26, sibling of live-federation-gate.sh's own P-013/WI-1841
# fix): `?superuser=1` alone is NOT sufficient — the handler also requires
# `Authorization: Bearer <token>` matching ~/.papercusp/superuser-token (see
# packages/operator-core/lib/superuser-token.ts). Without it every call here 403s with
# superuser_invalid_bearer, so rig_quota_acquire's `ok` parse always sees "0" (never
# "held") and the WI-1442/EI-5884 quota mutex silently NEVER acquires — every rig run
# burns the full RIG_QUOTA_MAX_WAIT_SEC (default 1800s) "contended or unreachable" retry
# loop before proceeding unlocked, and the 2-server-cap race the mutex exists to prevent
# is back to being prose-only. Found live during the 2026-07-26 Hetzner 2-VM positive
# control run (WI-5863) — holders:[] via locks:list proved zero real contention, only a
# missing header. Missing/short token → empty bearer → same graceful degrade as before
# (rig_quota_acquire's own timeout fallback), never fatal.
RIG_QUOTA_TOKEN_PATH="${RIG_QUOTA_TOKEN_PATH:-$HOME/.papercusp/superuser-token}"
RIG_QUOTA_BEARER="$(cat "$RIG_QUOTA_TOKEN_PATH" 2>/dev/null | tr -d '[:space:]' || true)"

# rig_mcp_call <tool-name> <json-args> → echoes the raw JSON-RPC response.
# Thin curl-JSONRPC helper — same shape live-federation-gate.sh /
# two-instance-hive-*-smoke.sh already use to reach the operator from bash.
rig_mcp_call() {
  local tool="$1" args="$2" client="${RIG_SLUG:-hetzner-rig}-quota"
  curl -s -m 30 -X POST "${OPERATOR_MCP_URL}?superuser=1&client=$client" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    ${RIG_QUOTA_BEARER:+-H "Authorization: Bearer $RIG_QUOTA_BEARER"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" \
    2>/dev/null
}

# rig_quota_acquire — poll (fixed interval) until this run holds
# ops/hetzner-federation-quota exclusively, or give up after
# RIG_QUOTA_MAX_WAIT_SEC (default 30 min — long enough to queue behind a
# couple of concurrent live briefs without hanging a stuck rig forever). Sets
# RIG_QUOTA_LOCK_ID on success. `mode:exclusive` with no `wait` is a no-wait
# check-and-take (locks:acquire_resource's drain-wait is for a SHARED holder
# draining, not another exclusive holder — irrelevant here since this resource
# is never taken shared) — so the retry loop lives in bash, not the tool call.
# BEST-EFFORT: a curl/parse failure logs a WARNING and proceeds unlocked
# rather than hanging the whole rig forever on an operator hiccup — the
# per-create fail-fast + exit-trap teardown remain the hard cost-safety net
# either way.
rig_quota_acquire() {
  local max_wait="${RIG_QUOTA_MAX_WAIT_SEC:-1800}" poll="${RIG_QUOTA_POLL_SEC:-20}" waited=0 resp ok lock_id
  fed_log "quota: acquiring exclusive($RIG_QUOTA_RESOURCE) (queueing behind any concurrent rig run)…"
  while [ "$waited" -lt "$max_wait" ]; do
    resp="$(rig_mcp_call locks:acquire_resource "{\"resource\":\"$RIG_QUOTA_RESOURCE\",\"mode\":\"exclusive\",\"reason\":\"rig run $RIG_SLUG\",\"ttl_sec\":3600}")"
    ok="$(printf '%s' "$resp" | python3 -c '
import json, sys
try:
    env = json.load(sys.stdin)
    d = json.loads(env["result"]["content"][0]["text"])
    print("1" if d.get("ok") and d.get("status") == "held" else "0")
except Exception:
    print("0")' 2>/dev/null)"
    if [ "$ok" = "1" ]; then
      lock_id="$(printf '%s' "$resp" | python3 -c '
import json, sys
env = json.load(sys.stdin)
d = json.loads(env["result"]["content"][0]["text"])
print(d.get("lock_id", ""))' 2>/dev/null)"
      RIG_QUOTA_LOCK_ID="$lock_id"
      fed_log "quota: acquired ($RIG_QUOTA_LOCK_ID)"
      return 0
    fi
    fed_log "quota: contended or unreachable (waited ${waited}s/${max_wait}s) — retrying in ${poll}s…"
    sleep "$poll"
    waited=$((waited + poll))
  done
  fed_log "quota: WARNING — could not acquire $RIG_QUOTA_RESOURCE within ${max_wait}s (operator unreachable, or genuinely contended). Proceeding WITHOUT the mutex."
  return 1
}

# rig_quota_release — best-effort; call from rig_cleanup so it fires even on a
# killed run (the EXIT trap runs it unconditionally). No-ops quietly if we
# never acquired (RIG_QUOTA_LOCK_ID unset — e.g. rig_quota_acquire timed out
# and we proceeded unlocked, or the caller never called it at all).
rig_quota_release() {
  [ -n "$RIG_QUOTA_LOCK_ID" ] || return 0
  rig_mcp_call locks:release_resource "{\"lock_id\":\"$RIG_QUOTA_LOCK_ID\"}" >/dev/null 2>&1
  fed_log "quota: released ($RIG_QUOTA_LOCK_ID)"
  RIG_QUOTA_LOCK_ID=""
}

# ── artifact gates (reuse the assert core) ────────────────────────────────────
# rig_gate_artifact <deb> — extract + clobber + swarm-support; sets RIG_PKG.
rig_gate_artifact() {
  local deb="$1"
  fed_log "artifact: $deb"
  fed_extract_deb "$deb" "$RIG_PKG" || return 2
  fed_clobber_check "$RIG_PKG" || return 2
  fed_assert_deb_swarm_support "$RIG_PKG" || return 2
}

# ── identities ────────────────────────────────────────────────────────────────
# rig_set_identity <inst> <gh-user> — register a frame in RIG_FRAMES (idempotent),
# set its gh identity + resolve its GH_TOKEN. Multiple frames MAY share a gh user
# (e.g. two members both on ownerhandle) — that's a real multi-device topology.
rig_set_identity() {
  local inst="$1" ghuser="$2" tok
  case " ${RIG_FRAMES[*]} " in *" $inst "*) : ;; *) RIG_FRAMES+=("$inst") ;; esac
  RIG_FRAMES_EVER_REGISTERED=$((RIG_FRAMES_EVER_REGISTERED + 1))
  FRAME_USER[$inst]="$ghuser"
  tok="$(gh auth token --user "$ghuser" 2>/dev/null)"
  [ -n "$tok" ] || { echo "FATAL: need a gh token for '$ghuser' (frame $inst)" >&2; return 1; }
  FRAME_TOKEN[$inst]="$tok"
}

# ── provision ─────────────────────────────────────────────────────────────────
# rig_provision <loc1> [loc2 …] — create one server per frame in RIG_FRAMES, in
# order. Each loc maps positionally to RIG_FRAMES[i]; if fewer locs than frames
# are given, the LAST loc is reused for the rest (so `rig_provision ash` puts every
# frame in ash). Records each id (rig_create_server) before doing anything billable.
rig_provision() {
  local locs=("$@") i inst loc out
  [ "${#RIG_FRAMES[@]}" -gt 0 ] || { echo "FATAL: no frames — call rig_set_identity first" >&2; return 1; }
  # BYO-frames seam (WI-1544): RIG_FRAME_IPS="ipA ipB …" maps pre-provisioned
  # hosts (e.g. local sshd containers when Hetzner can't create servers)
  # positionally onto RIG_FRAMES and skips the Hetzner API entirely. Nothing is
  # recorded in RIG_SERVERS_FILE, so rig_cleanup destroys nothing — the caller
  # owns the frames' lifecycle. Pair with RIG_DHT_BOOTSTRAP for same-box frames
  # (public-DHT NAT hairpinning between co-located peers is not reliable).
  if [ -n "${RIG_FRAME_IPS:-}" ]; then
    local ips=($RIG_FRAME_IPS)
    [ "${#ips[@]}" -ge "${#RIG_FRAMES[@]}" ] || { echo "FATAL: RIG_FRAME_IPS has ${#ips[@]} ips for ${#RIG_FRAMES[@]} frames" >&2; return 1; }
    fed_log "provision SKIPPED — BYO frames (${RIG_FRAMES[*]}) ← $RIG_FRAME_IPS"
    for i in "${!RIG_FRAMES[@]}"; do
      inst="${RIG_FRAMES[$i]}"
      FRAME_ID[$inst]="byo"; FRAME_IP[$inst]="${ips[$i]}"
      echo "  $inst=byo@${ips[$i]}"
    done
    return 0
  fi
  [ "${#locs[@]}" -gt 0 ] || locs=("ash")
  # EI-5884 / WI-1442 fix (b): serialize real Hetzner provisioning against every
  # OTHER concurrent rig run via the registered quota mutex — best-effort (a
  # timeout/operator-hiccup logs a WARNING and proceeds unlocked, per
  # rig_quota_acquire; the per-create fail-fast + exit-trap teardown are the
  # unconditional cost-safety net regardless).
  rig_quota_acquire || true
  fed_log "provision ${#RIG_FRAMES[@]} Hetzner $RIG_STYPE (frames: ${RIG_FRAMES[*]})"
  for i in "${!RIG_FRAMES[@]}"; do
    inst="${RIG_FRAMES[$i]}"
    loc="${locs[$i]:-${locs[$(( ${#locs[@]} - 1 ))]}}"
    out="$(rig_create_server "$RIG_SLUG-$inst" "$loc")" || return 3
    read -r FRAME_ID[$inst] FRAME_IP[$inst] <<<"$out"
    echo "  $inst=${FRAME_ID[$inst]}@${FRAME_IP[$inst]} ($loc)"
  done
}

# ── driver vtable: SSH into each frame by public IP ───────────────────────────
# These are the THREE federation-asserts.sh primitives, overridden for the Hetzner
# SSH driver. A scenario sources this lib AFTER federation-asserts.sh so these win.
drv_exec()   { rig_ssh "${FRAME_IP[$1]}" 'bash -s'; }
drv_applog() { echo "/home/pcusp/serve.log"; }
# EI-18687938054040755: where the .deb actually installs the sidecar. NOTE THE
# SPACE — the product is "Papercusp GUI", so the path is
# "/usr/lib/Papercusp GUI/sidecar/serve.mjs". Verified on a live frame
# (10.99.0.11): /usr/lib/Papercusp/sidecar does NOT exist. The capability probe
# also globs /usr/lib/Papercusp*/sidecar as a backstop, so an older-layout .deb
# still resolves.
drv_appbundle() { echo "/usr/lib/Papercusp GUI/sidecar/serve.mjs"; }
drv_psql()   { printf '%s\n' "$2" | rig_ssh "${FRAME_IP[$1]}" \
                 "psql 'postgresql://harness_admin:harness_admin_pwd@localhost:${FED_PG[$1]}/papercusp' -tA"; }

# ── generic SSH "driver" helper (the primitive briefs 2-7 build on) ───────────
# rig_driver_run <inst> -- <cmd> [args…]   run an arbitrary command on a frame as
#   root (the install/system context). Everything after `--` is the command.
# rig_driver_run <inst> <<<'script'       (no `--`) run a bash script from stdin
#   as root (same as drv_exec but explicit). Use rig_pcusp_run for the pcusp user.
rig_driver_run() {
  local inst="$1"; shift
  if [ "${1:-}" = "--" ]; then shift; rig_ssh "${FRAME_IP[$inst]}" "$@";
  else rig_ssh "${FRAME_IP[$inst]}" 'bash -s'; fi
}
# rig_pcusp_run <inst> — run a bash script (stdin) as the pcusp user with the
# sidecar env loaded (HONO/PG ports exported). The faithful context for sidecar ops.
rig_pcusp_run() {
  local inst="$1"
  rig_ssh "${FRAME_IP[$inst]}" "HONO=$RIG_HONO_PORT PG=$RIG_PG_PORT runuser -u pcusp -- bash -s"
}

# ── install .deb + launch the headless sidecar on each frame ──────────────────
# rig_setup_frame <inst> — wait sshd, install the gated .deb + driver prereqs,
# create the pcusp user, write its fed.env (GH_TOKEN), launch serve.mjs headless on
# the PUBLIC DHT (fresh data dir). Identical recipe to the 2-frame rig's setup_frame.
# Requires: rig_gate_artifact ran (the .deb path is the gated DEB); RIG_DEB set.
#
# WI-5672 (2026-07-21): PAPERCUSP_DBOS_ENABLE=1 is REQUIRED here — DBOS is gated
# default-OFF (host-bootstrap.ts: `if (backgroundWorkers && env.PAPERCUSP_DBOS_ENABLE
# === '1')`), and this env block was the ONE launch path in the repo that omitted it
# (every other path — Tauri prod main.rs, boot-headless*.sh, dev-operator-ifneeded.sh —
# sets it). Without it, DBOS (and the fast onMemberApplied-adjacent admission machinery
# it schedules) never boots on the frame at all: red-queen-sentinel's "ENGINE DEATH"
# fires (all 5 routines perpetually overdue, because none ever started), owner-device
# resolution stalls, and new-member admission/epoch-key distribution falls back to the
# slow 10-min in-process periodic reconcile (pot-epoch-key-reconcile) — matching the
# ~19-22min live-fed-gate content_bidir/planpart_bidir/coord_bidir/concurrent_lww
# early-window co-failures (order 10-40, 180-300s timeouts). This IS the same class of
# miss already hit once before in packages/operator-core/lib/deployment/frame-bootstrap.ts
# ("found live 2026-06-06") — do not drop this var again if this block is ever rewritten.
declare -g RIG_DEB
rig_setup_frame() {
  local inst="$1"; local ip="${FRAME_IP[$inst]}"
  [ -n "${RIG_DEB:-}" ] || { echo "FATAL: RIG_DEB unset — set it to the gated .deb path before rig_setup_frame" >&2; return 1; }
  fed_log "[$inst] wait sshd @ $ip"
  local i; for i in $(seq 1 40); do rig_ssh "$ip" true 2>/dev/null && break; sleep 5; done
  # Final probe WITHOUT the stderr swallow — when it fails, the actual ssh error
  # (e.g. "Permission denied (publickey)" vs a timeout) must land in the log;
  # 3 soak runs were mis-diagnosed off a bare "FATAL ssh" (2026-07-03).
  rig_ssh "$ip" true 2>/dev/null \
    || { echo "FATAL ssh $inst (identity=$RIG_SSH_IDENTITY) — last error:"; rig_ssh "$ip" true; return 1; }
  fed_log "[$inst] install .deb (fresh-install dep resolution) + driver prereqs"
  rig_scp "$ip" "$RIG_DEB" /tmp/Papercusp.deb || return 1
  rig_ssh "$ip" "SIDECAR_DIR='$(fed_sidecar_dir)' bash -s" <<'INSTEOF' | grep -q deb-ok || { echo "FATAL install $inst"; return 1; }
export DEBIAN_FRONTEND=noninteractive; apt-get update -qq
apt-get install -y -qq /tmp/Papercusp.deb >/dev/null 2>&1 || apt-get install -y -qq --fix-broken >/dev/null 2>&1
command -v gh >/dev/null && command -v psql >/dev/null && command -v git >/dev/null || apt-get install -y -qq gh postgresql-client git >/dev/null 2>&1
test -f "$SIDECAR_DIR/serve.mjs" && echo deb-ok
INSTEOF
  # RIG_SERVE_HOTPATCH=<local serve.mjs>: overwrite the installed sidecar bundle
  # BEFORE launch — the "live re-verify via rig hotpatch" lever (WI-1378/Brief-3
  # flow): rebuild ONLY serve.mjs from the current tree (bin/build-desktop-sidecar.sh's
  # esbuild step) instead of a full .deb rebuild, and test the fix live.
  if [ -n "${RIG_SERVE_HOTPATCH:-}" ]; then
    fed_log "[$inst] HOTPATCH sidecar serve.mjs ← $RIG_SERVE_HOTPATCH"
    rig_ssh_wait "$ip" || { echo "FATAL ssh $inst (pre-hotpatch)"; return 1; }
    rig_scp "$ip" "$RIG_SERVE_HOTPATCH" "$(fed_sidecar_dir)/serve.mjs" || { echo "FATAL hotpatch $inst"; return 1; }
    # WI-1544 schema-drift guard: a hotpatched serve.mjs runs CURRENT-tree code
    # against the .deb's FROZEN db-sql migrations (the launch pins
    # PAPERCUSP_PG_SQL_DIR at the sidecar's db-sql), so any migration added
    # since the .deb build silently never applies on the frames. Sync the
    # tree's top-level *.sql (the same set build-desktop-sidecar.sh copies)
    # alongside the hotpatched bundle. Override source: RIG_DBSQL_HOTPATCH.
    local dbsql="${RIG_DBSQL_HOTPATCH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/libs/papercusp/libs/db/sql}"
    if [ -d "$dbsql" ]; then
      fed_log "[$inst] HOTPATCH sidecar db-sql ← $dbsql"
      (cd "$dbsql" && tar -cf - ./*.sql) \
        | rig_ssh "$ip" "tar -C \"$(fed_sidecar_dir)/db-sql\" -xf -" \
        || { echo "FATAL db-sql hotpatch $inst"; return 1; }
    else
      fed_log "[$inst] db-sql hotpatch SKIPPED — $dbsql not found"
    fi
  fi
  # EI-18685765921613818: print the DHT bootstrap this launch actually RESOLVED
  # (RIG_DHT_BOOTSTRAP, forwarded to the frame below as DHTB), not a hardcoded
  # "PUBLIC DHT" literal — this path DOES support an isolated bootstrap
  # (local-matrix.sh:449 sets RIG_DHT_BOOTSTRAP for the docker rig), so the old
  # literal actively contradicted the real config on every isolated run. The
  # authoritative runtime signal stays getSharedSwarm's own
  # "[swarm] DHT bootstrap = ISOLATED/PUBLIC" log (swarm.ts) — this is just the
  # launch-time label no longer lying about it ahead of that.
  fed_log "[$inst] launch headless serve.mjs as non-root pcusp (DHT ${RIG_DHT_BOOTSTRAP:-PUBLIC}, identity ${FRAME_USER[$inst]})"
  rig_ssh_wait "$ip" || { echo "FATAL ssh $inst (pre-launch)"; return 1; }
  # embedded-postgres REFUSES to initdb as root (Hetzner's ubuntu image logs in as
  # root); the .deb is a desktop app that runs as a normal user, so launch the
  # sidecar under a dedicated `pcusp` user via runuser — faithful to real usage.
  printf 'GH_TOKEN=%s\n' "${FRAME_TOKEN[$inst]}" \
    | rig_ssh "$ip" 'id pcusp >/dev/null 2>&1 || useradd -m -s /bin/bash pcusp
        umask 077; cat > /home/pcusp/fed.env; chown pcusp:pcusp /home/pcusp/fed.env'
  rig_ssh "$ip" "HONO=$RIG_HONO_PORT PG=$RIG_PG_PORT DHTB='${RIG_DHT_BOOTSTRAP:-}' PGB='${RIG_PGBOUNCER:-0}' SIDE_DIR='$(fed_sidecar_dir)' WSID='$RIG_WORKSPACE_ID' HHSLUG='$RIG_HOME_HARNESS_SLUG' RIG_GRACE='${RIG_REPLICATION_GRACE_MS:-}' RIG_FROZEN_GRACE='${RIG_FROZEN_GRACE_MS:-}' RIG_ANNOUNCE_REFLUSH='${RIG_ANNOUNCE_REFLUSH_MS:-}' runuser -u pcusp -- bash -s" <<'EOF'
set -e
H=/home/pcusp   # explicit — don't trust runuser's HOME handling
# WI-183 class, seen LIVE on a --reuse relaunch (2026-07-17, frame b): a reused frame
# still runs the PREVIOUS run's serve + embedded-PG children, and postgres OUTLIVES
# serve (PARENT_DEATH_WATCH=0) — a serve-only pkill + fixed 1s grace leaves live PG
# writing WAL while rm -rf empties pgdata → 'pg_wal: Directory not empty' aborts the
# launch. Same actually-exited discipline as the restart path below: kill BOTH, WAIT
# until each has exited (escalate to SIGKILL once), reap orphan SysV shm, THEN wipe.
pkill -u pcusp -f 'serve.mjs' 2>/dev/null || true
for i in $(seq 1 15); do pgrep -u pcusp -f 'serve.mjs' >/dev/null || break; sleep 1; done
if pgrep -u pcusp -f 'serve.mjs' >/dev/null; then
  pkill -9 -u pcusp -f 'serve.mjs' 2>/dev/null || true
  for i in $(seq 1 10); do pgrep -u pcusp -f 'serve.mjs' >/dev/null || break; sleep 1; done
fi
pkill -u pcusp -f 'bin/postgres' 2>/dev/null || true
for i in $(seq 1 20); do pgrep -u pcusp -f 'bin/postgres' >/dev/null || break; sleep 1; done
if pgrep -u pcusp -f 'bin/postgres' >/dev/null; then
  pkill -9 -u pcusp -f 'bin/postgres' 2>/dev/null || true
  for i in $(seq 1 10); do pgrep -u pcusp -f 'bin/postgres' >/dev/null || break; sleep 1; done
fi
for id in $(ipcs -m 2>/dev/null | awk '$3=="pcusp" {print $2}'); do ipcrm -m "$id" 2>/dev/null || true; done
for id in $(ipcs -s 2>/dev/null | awk '$3=="pcusp" {print $2}'); do ipcrm -s "$id" 2>/dev/null || true; done
rm -rf "$H/pgdata" "$H/.papercusp" "$H/.papercusp-workspaces"; mkdir -p "$H/pgdata" "$H/fed"
SIDE="${SIDE_DIR:-/usr/lib/Papercusp/sidecar}"
set -a; . "$H/fed.env"; set +a
cd "$SIDE"
env PATH="$SIDE/bin:/usr/bin:/bin" HOME="$H" USERPROFILE="$H" NODE_ENV=production \
  PAPERCUSP_HONO_PORT="$HONO" PAPERCUSP_BIND_HOST=127.0.0.1 HOSTNAME=127.0.0.1 \
  PAPERCUSP_PG_PORT="$PG" PAPERCUSP_PG_DATA_DIR="$H/pgdata" PAPERCUSP_PG_SQL_DIR="$SIDE/db-sql" \
  PAPERCUSP_SERVE_UI=0 PAPERCUSP_DESKTOP=1 \
  PAPERCUSP_PARENT_DEATH_WATCH=0 \
  PAPERCUSP_FLAG_PAPERCUSP_PLAN_PART_FEDERATION=1 PAPERCUSP_A003_TRACE=1 \
  PAPERCUSP_ANNOUNCE_DEBUG=1 \
  PAPERCUSP_DBOS_ENABLE=1 \
  PAPERCUSP_DHT_BOOTSTRAP="${DHTB:-}" \
  PAPERCUSP_PGBOUNCER="${PGB:-0}" \
  PAPERCUSP_HARNESS_DIR="$SIDE/harness" PAPERCUSP_PROMPTS_DIR="$SIDE/prompts" \
  PAPERCUSP_WORKSPACES_ROOT="$H/.papercusp-workspaces" \
  ${WSID:+PAPERCUSP_WORKSPACE_ID="$WSID"} \
  ${HHSLUG:+PAPERCUSP_POT_HOME_SLUG="$HHSLUG"} \
  ${RIG_GRACE:+PAPERCUSP_REPLICATION_STALL_GRACE_MS="$RIG_GRACE"} \
  ${RIG_FROZEN_GRACE:+PAPERCUSP_REPLICATION_FROZEN_GRACE_MS="$RIG_FROZEN_GRACE"} \
  ${RIG_ANNOUNCE_REFLUSH:+PAPERCUSP_ANNOUNCE_REFLUSH_MS="$RIG_ANNOUNCE_REFLUSH"} \
  PAPERCUSP_DISABLE_DOGFOOD_HIVE=1 \
  GH_TOKEN="${GH_TOKEN:-}" \
  PAPERCUSP_PROVISION_ENV_OPERATORS=0 \
  PAPERCUSP_EPOCH_BOOT_DEBUG=1 \
  PAPERCUSP_SWARM_CHURN_DEBUG=1 \
  setsid nohup ./bin/node ./serve.mjs --ensure >> "$H/serve.log" 2>&1 < /dev/null &
sleep 1; echo "launched as pcusp"
EOF
}
# WI-5631 (2nd cause, found by LIVE verification — the RIG_HOME_HARNESS_SLUG fix alone
# cut the "EI-13285 id collision" storm ~99% (8068→58 ops in one replication_soak run)
# but did NOT fully eliminate it): the residual leak is bootstrap-papercusp-hive.ts's
# clone-on-first-boot dogfood auto-join. Its THIRD trigger path
# (hive-directory-boot.ts's maybeTriggerCanonicalJoinOnIngest) is UNGATED — it fires the
# instant this frame overhears the REAL production papercusp hive's announce on the
# shared GLOBAL DIRECTORY topic (which a BYO rig frame on the public DHT, using a real
# papercupai/ownerhandle GH identity, routinely does) and clones/joins it, registering a
# local harness_slug='papercusp' project independent of PAPERCUSP_POT_HOME_SLUG — that
# project then gets its OWN engineer-issues projection whose own-slug fast path
# (member-content-guard.ts decideMemberContentOp) applies every real papercusp op
# unconditionally, same as before the home-harness-slug fix. WI-1423 already documented
# + fixed this EXACT class for other test-boot paths (see gate-sidecar-boots.sh) via the
# hard, flag-independent `PAPERCUSP_DISABLE_DOGFOOD_HIVE=1` kill-switch
# (bootstrap-papercusp-hive.ts's dogfoodHiveDisabled()) — it was just never wired into
# this rig launch path. Set on BOTH launch env blocks above.
# EI-16524: PAPERCUSP_DESKTOP=1 (set above, for faithful desktop-app parity) makes
# host-bootstrap.ts's bg-host DEFAULT-ON provision the env-switcher operator siblings
# (prod:3070/staging:3170/release/…, WI-3285) ~20s after boot — a real-desktop
# convenience with zero purpose on a single-role federation-test frame. LIVE-observed
# on both BYO frames (docker/ssh, 2026-07-19): the spawned "prod" sibling
# (`[env-operators] spawned prod on :3070 (bundled, request-only, pid=…)`) is a full
# second Hono-host process that sustained 200-270% CPU / severe event-loop-lag
# alongside the primary — exactly the "duplicate serve.mjs process" this EI flagged.
# PAPERCUSP_PROVISION_ENV_OPERATORS=0 is the documented opt-out (host-bootstrap.ts's
# own comment: "Never on a non-desktop host" — a rig frame is exactly that in spirit).

# rig_setup_all — rig_setup_frame for EVERY frame in RIG_FRAMES (in order).
rig_setup_all() {
  local inst
  for inst in "${RIG_FRAMES[@]}"; do rig_setup_frame "$inst" || return 4; done
}

# ── kill / restart sidecar (the offline/restart primitives, Briefs 4+5) ───────
# rig_stop_postgres_gracefully <ip> — request the same PostgreSQL fast shutdown
# used by the shipped embedded-postgres client (`pg.stop()` sends SIGINT and
# waits for the postmaster child’s actual exit). Do not replace this with a
# broad `pkill` + short sleep: a fast shutdown can spend minutes in its
# checkpoint on a contended frame, and killing it or deleting postmaster.pid
# before the real exit turns an ordinary restart into unclean recovery.
#
# The timeout is a safety bound for a wedged rig, not a kill deadline. On
# expiry this helper fails closed and leaves pgdata untouched; the caller must
# not relaunch over a still-live postmaster. The default is deliberately above
# the 270s fsync observed in WI-40553’s incident evidence, while remaining
# finite so a genuinely wedged frame is surfaced to the scenario.
rig_stop_postgres_gracefully() {
  local ip="$1"
  local timeout_s="${RIG_POSTGRES_STOP_TIMEOUT_SEC:-600}"
  case "$timeout_s" in
    ''|*[!0-9]*)
      echo "FATAL invalid RIG_POSTGRES_STOP_TIMEOUT_SEC='$timeout_s' (expected integer seconds)"
      return 2
      ;;
  esac
  rig_ssh "$ip" "runuser -u pcusp -- env RIG_PG_STOP_TIMEOUT_SEC='$timeout_s' bash -s" <<'PGEOF'
set -u
H=/home/pcusp
PGDATA="$H/pgdata"
PIDFILE="$PGDATA/postmaster.pid"
MAX_WAIT="${RIG_PG_STOP_TIMEOUT_SEC:-600}"

pg_processes() {
  pgrep -u pcusp -f 'bin/postgres' 2>/dev/null || true
}

pg_pid=""
if [ -r "$PIDFILE" ]; then
  pg_pid="$(awk 'NR == 1 { print $1; exit }' "$PIDFILE" 2>/dev/null | tr -d '[:space:]')"
fi

# Fail closed when the pid file is malformed or missing but a postgres process
# still exists. Guessing a PID here could signal another frame-local process.
if [ -z "$pg_pid" ]; then
  live="$(pg_processes)"
  if [ -n "$live" ]; then
    echo "FATAL postgres is live but $PIDFILE has no usable postmaster PID; refusing restart"
    exit 1
  fi
  rm -f "$PIDFILE"
  echo "postgres already stopped (no live process)"
  exit 0
fi
case "$pg_pid" in
  ''|*[!0-9]*|0)
    live="$(pg_processes)"
    if [ -n "$live" ]; then
      echo "FATAL invalid postmaster PID '$pg_pid' with live postgres process; refusing restart"
      exit 1
    fi
    rm -f "$PIDFILE"
    echo "removed stale postmaster.pid (postgres already stopped)"
    exit 0
    ;;
esac

if ! kill -0 "$pg_pid" 2>/dev/null; then
  live="$(pg_processes)"
  if [ -n "$live" ]; then
    echo "FATAL postmaster PID $pg_pid is gone but postgres descendants remain; refusing restart"
    exit 1
  fi
  rm -f "$PIDFILE"
  echo "removed stale postmaster.pid (postmaster already stopped)"
  exit 0
fi

echo "postgres fast shutdown: SIGINT postmaster pid=$pg_pid; waiting for actual exit (max ${MAX_WAIT}s)"
kill -INT "$pg_pid" 2>/dev/null || true
started_at="$(date +%s)"
while kill -0 "$pg_pid" 2>/dev/null; do
  elapsed=$(( $(date +%s) - started_at ))
  if [ "$elapsed" -ge "$MAX_WAIT" ]; then
    echo "FATAL postgres postmaster pid=$pg_pid did not exit within ${MAX_WAIT}s; refusing SIGKILL and preserving pgdata"
    exit 1
  fi
  sleep 1
done

# The postmaster should reap its children before exit. Give the last backend
# processes a short postmaster-exit settling window, but never kill them here.
for _ in $(seq 1 30); do
  live="$(pg_processes)"
  [ -z "$live" ] && break
  sleep 1
done
live="$(pg_processes)"
if [ -n "$live" ]; then
  echo "FATAL postgres descendants remain after postmaster exit; refusing restart and preserving pgdata"
  exit 1
fi
rm -f "$PIDFILE"
echo "postgres stopped cleanly (postmaster exited; pgdata preserved)"
PGEOF
}

# rig_kill_sidecar <inst> — stop the pcusp serve.mjs WITHOUT wiping pgdata (the
# "take this member offline" primitive: reconnect/catch-up + restart-durability).
rig_kill_sidecar() {
  local inst="$1"; local ip="${FRAME_IP[$inst]}"
  fed_log "[$inst] kill sidecar (preserve pgdata — member goes offline)"
  # Stop the Node wrapper first, then ask the postmaster to perform its own
  # fast shutdown and wait for the actual process exit. This mirrors the
  # shipped `pg.stop()` API rather than orphaning PG behind a wrapper pkill.
  rig_ssh "$ip" "runuser -u pcusp -- bash -lc \"pkill -u pcusp -f 'serve.mjs' 2>/dev/null || true; for i in \\\$(seq 1 15); do pgrep -u pcusp -f 'serve.mjs' >/dev/null || break; sleep 1; done; pgrep -u pcusp -f 'serve.mjs' >/dev/null && pkill -9 -u pcusp -f 'serve.mjs' 2>/dev/null || true; echo 'sidecar wrapper stopped'\"" \
    || return 1
  rig_stop_postgres_gracefully "$ip" || return 1
}

# rig_restart_sidecar <inst> — relaunch serve.mjs WITHOUT wiping pgdata/.papercusp
# (EI-504): boot-all re-reads the registered project + shared.json + the hive join
# and rejoins the swarm. Used after a kill (Brief 4) and as the cold-restart probe
# (Brief 5). Same env block as rig_setup_frame, minus the rm -rf.
# WI-5672: carries the same PAPERCUSP_DBOS_ENABLE=1 fix as rig_setup_frame above —
# see that function's comment for the full root-cause chain.
rig_restart_sidecar() {
  local inst="$1"; local ip="${FRAME_IP[$inst]}"
  fed_log "[$inst] restart sidecar (preserve pgdata) → boot-all reads state → swarm rejoin"
  rig_ssh "$ip" "HONO=$RIG_HONO_PORT PG=$RIG_PG_PORT DHTB='${RIG_DHT_BOOTSTRAP:-}' PGB='${RIG_PGBOUNCER:-0}' SIDE_DIR='$(fed_sidecar_dir)' WSID='$RIG_WORKSPACE_ID' HHSLUG='$RIG_HOME_HARNESS_SLUG' RIG_GRACE='${RIG_REPLICATION_GRACE_MS:-}' RIG_FROZEN_GRACE='${RIG_FROZEN_GRACE_MS:-}' RIG_ANNOUNCE_REFLUSH='${RIG_ANNOUNCE_REFLUSH_MS:-}' runuser -u pcusp -- bash -s" <<'EOF'
set -e
H=/home/pcusp
# serve.mjs needs the same actually-exited discipline as postgres below (WI-183 class):
# SIGTERM + a fixed 1s under-covers a slow graceful shutdown, and a relaunch while the
# old process still holds the Corestore root is the WI-4236 two-process race — the old
# instance's own-log forks and every post-restart write silently strands (the exact
# restart_durability NEW-WRITE/NO-DUP failure seen in gate run 20260716-234524).
pkill -u pcusp -f 'serve.mjs' 2>/dev/null || true
for i in $(seq 1 15); do pgrep -u pcusp -f 'serve.mjs' >/dev/null || break; sleep 1; done
if pgrep -u pcusp -f 'serve.mjs' >/dev/null; then
  pkill -9 -u pcusp -f 'serve.mjs' 2>/dev/null || true
  for i in $(seq 1 10); do pgrep -u pcusp -f 'serve.mjs' >/dev/null || break; sleep 1; done
fi
EOF
  rig_stop_postgres_gracefully "$ip" || return 1
  rig_ssh "$ip" "HONO=$RIG_HONO_PORT PG=$RIG_PG_PORT DHTB='${RIG_DHT_BOOTSTRAP:-}' PGB='${RIG_PGBOUNCER:-0}' SIDE_DIR='$(fed_sidecar_dir)' WSID='$RIG_WORKSPACE_ID' HHSLUG='$RIG_HOME_HARNESS_SLUG' RIG_GRACE='${RIG_REPLICATION_GRACE_MS:-}' RIG_FROZEN_GRACE='${RIG_FROZEN_GRACE_MS:-}' RIG_ANNOUNCE_REFLUSH='${RIG_ANNOUNCE_REFLUSH_MS:-}' runuser -u pcusp -- bash -s" <<'EOF'
set -e
H=/home/pcusp
# shm-race hygiene (WI-183 rig hardening; seen LIVE 2026-07-03 19:46Z frame b):
# the old pkill + sleep 2 + pid-file-clear UNDER-COVERS the class — PG backends
# can outlive the 2s grace still ATTACHED to the old SysV segment, and the
# relaunched postmaster then dies 'pre-existing shared memory block … is still
# in use' (EMBEDDED_PG_FAILED). The helper above now waits for the actual
# postmaster/descendant exit before this cleanup, so reap only truly orphaned
# IPC objects after PG is gone.
for id in $(ipcs -m 2>/dev/null | awk '$3=="pcusp" {print $2}'); do ipcrm -m "$id" 2>/dev/null || true; done
for id in $(ipcs -s 2>/dev/null | awk '$3=="pcusp" {print $2}'); do ipcrm -s "$id" 2>/dev/null || true; done
# stale-lock hygiene: an orphaned/killed PG can leave postmaster.pid behind;
# with no live postgres for this pgdata, clear it or the boot dies EMBEDDED_PG_FAILED
pgrep -u pcusp -f 'bin/postgres' >/dev/null || rm -f "$H/pgdata/postmaster.pid"
SIDE="${SIDE_DIR:-/usr/lib/Papercusp/sidecar}"
set -a; . "$H/fed.env"; set +a
cd "$SIDE"
env PATH="$SIDE/bin:/usr/bin:/bin" HOME="$H" USERPROFILE="$H" NODE_ENV=production \
  PAPERCUSP_HONO_PORT="$HONO" PAPERCUSP_BIND_HOST=127.0.0.1 HOSTNAME=127.0.0.1 \
  PAPERCUSP_PG_PORT="$PG" PAPERCUSP_PG_DATA_DIR="$H/pgdata" PAPERCUSP_PG_SQL_DIR="$SIDE/db-sql" \
  PAPERCUSP_SERVE_UI=0 PAPERCUSP_DESKTOP=1 \
  PAPERCUSP_PARENT_DEATH_WATCH=0 \
  PAPERCUSP_FLAG_PAPERCUSP_PLAN_PART_FEDERATION=1 PAPERCUSP_A003_TRACE=1 \
  PAPERCUSP_ANNOUNCE_DEBUG=1 \
  PAPERCUSP_DBOS_ENABLE=1 \
  PAPERCUSP_DHT_BOOTSTRAP="${DHTB:-}" \
  PAPERCUSP_PGBOUNCER="${PGB:-0}" \
  PAPERCUSP_HARNESS_DIR="$SIDE/harness" PAPERCUSP_PROMPTS_DIR="$SIDE/prompts" \
  PAPERCUSP_WORKSPACES_ROOT="$H/.papercusp-workspaces" \
  ${WSID:+PAPERCUSP_WORKSPACE_ID="$WSID"} \
  ${HHSLUG:+PAPERCUSP_POT_HOME_SLUG="$HHSLUG"} \
  ${RIG_GRACE:+PAPERCUSP_REPLICATION_STALL_GRACE_MS="$RIG_GRACE"} \
  ${RIG_FROZEN_GRACE:+PAPERCUSP_REPLICATION_FROZEN_GRACE_MS="$RIG_FROZEN_GRACE"} \
  ${RIG_ANNOUNCE_REFLUSH:+PAPERCUSP_ANNOUNCE_REFLUSH_MS="$RIG_ANNOUNCE_REFLUSH"} \
  PAPERCUSP_DISABLE_DOGFOOD_HIVE=1 \
  GH_TOKEN="${GH_TOKEN:-}" \
  PAPERCUSP_PROVISION_ENV_OPERATORS=0 \
  PAPERCUSP_EPOCH_BOOT_DEBUG=1 \
  PAPERCUSP_SWARM_CHURN_DEBUG=1 \
  setsid nohup ./bin/node ./serve.mjs --ensure >> "$H/serve.log" 2>&1 < /dev/null &
sleep 1; echo "relaunched as pcusp (no wipe)"
EOF
}

# ── boot / API readiness (thin wrappers over the assert core) ─────────────────
# rig_wait_frame_ready <inst> [boot_tries] — embedded-PG + sidecar up (fed_wait_boot),
# then API answering 2xx (fed_wait_api). fed_wait_boot/fed_wait_api MUST be called
# directly (not in $(…)) so their FED_PG/FED_SC fills survive — this wrapper does so.
rig_wait_frame_ready() {
  local inst="$1" tries="${2:-50}"
  fed_wait_boot "$inst" "$tries" || { echo "✗ $inst boot failed: ${FED_BOOT_ERR:-?}"; drv_exec "$inst" <<<"tail -25 /home/pcusp/serve.log"; return 5; }
  echo "  $inst: PG=${FED_PG[$inst]} sc=${FED_SC[$inst]}"
  fed_wait_api "$inst" || echo "⚠ $inst api not ready"
}
# rig_wait_all_ready [boot_tries] — rig_wait_frame_ready for every frame.
rig_wait_all_ready() {
  local inst; for inst in "${RIG_FRAMES[@]}"; do rig_wait_frame_ready "$inst" "${1:-50}" || return 5; done
}

# rig_arm_hive_rekey <inst> — explicitly ARM the papercusp-hive-rekey (POT_REKEY) flag on
# <inst>'s sidecar via the loopback POST /api/flags/set route (auth:'loopback', same trust
# tier rig_ban_member's bearer-gated revoke route needs 'trusted' for — this route needs
# none). WI-6043 (2026-07-26, live-federation-gate revocation_kcut FAIL — post-ban content
# LEAK to the banned member): although `papercusp-hive-rekey` is DEFAULT-ON in source
# (libs/flags/src/types.ts — graduated 2026-06-29, not in DARK_FLAGS), a live rig run
# (HEAD=bbb4404626) showed the hive epoch NEVER advanced past 0 for the WHOLE run (grepped
# both frames' full banked serve.log — zero "epoch=1" or higher anywhere), which is
# EXACTLY the symptom `advanceEpochOnHiveBoundary` produces when `isHiveRekeyEnabled()`
# resolves false (it early-returns `{applied:false}` with NO throw and, before this same
# WI's boot-history.ts fix, no stdout signal either — see rekey_boundary_skipped below).
# With the epoch stuck at 0, post-ban content stays encrypted (or plaintext) under the
# SAME key the banned member already holds, so of course it "leaks" — there is no
# cryptographic cut-off to test. This is the SAME class of gap
# two-instance-hive-from-repo-smoke.sh already hit and fixed (su-9140a, 2026-06-19): "the
# env recipe PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY=1 does NOT engage getFlag(HIVE_REKEY) on
# the packaged binary (verified: owner had 0 hive_epoch_keys)" — that rig's fix was this
# exact explicit /api/flags/set call, made BEFORE hive creation so the owner's epoch
# initializes with the re-key on from the start. None of the deb-hetzner-*.sh rigs ever
# did this (verified: zero references before this fix), so revocation_kcut's K-cut leg was
# never actually armed on them — the two prior clean 2026-07-25 passes were very likely a
# race (replication lag exceeding the negative-assert window), not a real cut-off, and
# today's other latency fixes (WI-5980/WI-5639) sped propagation up enough to unmask it.
# Best-effort/non-fatal (logs but never aborts the rig on a flags-route hiccup) — the
# scenario's own negative assert is still the real pass/fail signal; this only ensures the
# mechanism it's testing is actually turned on.
rig_arm_hive_rekey() {
  local inst="$1" resp
  resp="$(drv_exec "$inst" <<EOF
curl -s -m 15 -X POST http://127.0.0.1:${FED_SC[$inst]}/api/flags/set -H 'content-type: application/json' -d '{"key":"papercusp-hive-rekey","enabled":true}'
EOF
)"
  fed_log "[$inst] arm papercusp-hive-rekey → $(printf '%s' "$resp" | head -c 160)"
}

# ── owner publishes the hive (from-repo) → resolve hiveId/pubkey/memberLink ───
# rig_owner_publish_hive <owner-inst> <repo_url> — POST pots/from-repo on the
# owner, then resolve the THREE fields /api/discovery/join-pot needs
# ({ hiveId, hivePubkey, memberLinks }) from whichever response shape came back
# (fresh-create vs existing). Sets RIG_HIVE_ID / RIG_HIVE_PUBKEY / RIG_HIVE_LINK.
rig_owner_publish_hive() {
  local owner="$1" repo="${2:-https://github.com/octocat/Hello-World}" a_resp fields try
  RIG_REPO_URL="$repo"
  fed_log "[$owner=OWNER] POST pots/from-repo ($repo, force) → resolve hive memberLink + hiveId + hivePubkey"
  # WI-1331 (Brief 5 live run): force:true is REQUIRED. The test repo
  # (octocat/Hello-World) already has a hive registered in the shared PUBLIC
  # directory from prior runs, so a non-forced from-repo hits the paste-time
  # lookup (_create_from_repo.ts:345 `if (!opts.force) return {existing}`) and
  # returns the `existing` JOIN-OFFER shape. For a source:"directory" hit that
  # shape carries ONLY {hiveId,title,ownerGithubLogin} — NO memberLinks / NO
  # hivePubkey (those come from the owner, not directory gossip) — so a joiner
  # can't join it and the rig FATALs "could not resolve a hive memberLink".
  # force:true skips the early-return and CREATES a FRESH isolated hive per run
  # (own slug + own hivePubkey → own federation topic), returning the
  # {created,publish:{memberLinks,hivePubkey}} shape the parse below expects.
  # WI-6723: this POST performs a LIVE `git clone` of github.com from INSIDE the
  # frame, and it was the only leg here with no retry — while rig_join_hive just
  # below has retried transients since 2026-07-01. One transient
  # `Recv failure: Connection reset by peer` (code clone_network_timeout) returns
  # 6, and all ten callers wire that to `|| exit 6`, so a one-second blip at
  # minute 2 destroys the frames and throws away a whole ~40-min matrix run
  # (observed 2026-08-01 19:51Z — zero of 18 scenarios executed).
  # Retry ONLY on transient network/clone shapes: a genuine API refusal must
  # still fail fast and loud, so this cannot mask a real regression. Safe to
  # retry because force:true creates a FRESH isolated hive per attempt (see the
  # note above), so a retry can never collide with a half-created one.
  for try in 1 2 3; do
    a_resp="$(drv_exec "$owner" <<EOF
curl -s -m 610 -X POST http://127.0.0.1:${FED_SC[$owner]}/api/harness/pots/from-repo -H 'content-type: application/json' -d '{"githubUrl":"$repo","force":true,"visibility":"public","runTests":false,"shallow":true}'
EOF
)"
    case "$a_resp" in
      ''|*clone_network_timeout*|*'Recv failure'*|*'Connection reset'*|*'unable to access'*|*'Could not resolve host'*|*'Operation timed out'*)
        [ "$try" -lt 3 ] || break
        echo "  ⚠ $owner from-repo attempt $try/3 hit a TRANSIENT clone/network failure — retrying in $((try * 20))s: $(printf '%s' "$a_resp" | head -c 160)"
        sleep "$((try * 20))"
        ;;
      *) break ;;
    esac
  done
  echo "[$owner] from-repo → $(printf '%s' "$a_resp" | head -c 200)"
  # The fields live in different shapes:
  #   fresh-create → {created:{potSlug}, publish:{memberLinks,hivePubkey}} (WI-931;
  #                  field renamed hiveSlug→potSlug by cup-lexicon-full-rename-2026-07-09
  #                  — accept both so this still works against an older sidecar build)
  #   existing     → {existing:{hive:{hiveId}}} (directory hit: NO memberLinks —
  #                  unreachable now that we always force-create fresh)
  fields="$(printf '%s' "$a_resp" | python3 -c 'import json,sys
d=json.load(sys.stdin)
ex=d.get("existing",{}).get("hive",{}) or {}
cr=d.get("created",{}) or {}
pub=d.get("publish",{}) or {}
ml=(ex.get("memberLinks") or cr.get("memberLinks") or pub.get("memberLinks") or [])
print(ml[0] if ml else "")
print(ex.get("potId") or ex.get("hiveId") or cr.get("potSlug") or cr.get("hiveSlug") or "")  # offer key renamed hiveId->potId; old key kept for stale-deb runs
print(ex.get("hivePubkey") or pub.get("hivePubkey") or "")
print(cr.get("memberSlug") or "")' 2>/dev/null)"
  { read -r RIG_HIVE_LINK; read -r RIG_HIVE_ID; read -r RIG_HIVE_PUBKEY; read -r RIG_OWNER_MEMBER_SLUG; } <<<"$fields"
  [ -n "$RIG_HIVE_LINK" ] || { echo "✗ $owner could not resolve a hive memberLink — body: $(printf '%s' "$a_resp" | head -c 1200)"; return 6; }
  [ -n "$RIG_HIVE_ID" ]   || { echo "✗ $owner could not resolve hiveId — body: $(printf '%s' "$a_resp" | head -c 1200)"; return 6; }
  echo "✓ $owner resolved hive link ${RIG_HIVE_LINK:0:56}… hiveId=$RIG_HIVE_ID hivePubkey=${RIG_HIVE_PUBKEY:0:12}…"
  [ -n "$RIG_HIVE_PUBKEY" ] || echo "⚠ $owner surfaced NO hivePubkey — joiners will skip identity-materialize (no re-key → no federation)."
}

# join-hive member-slug reader (first ok member's slug).
rig_join_member_slug() {
  printf '%s' "$1" | python3 -c 'import json,sys
d=json.load(sys.stdin)
ms=[m for m in d.get("members",[]) if m.get("ok") and m.get("slug")]
print(ms[0]["slug"] if ms else "")' 2>/dev/null
}

# rig_join_hive <inst> — JOIN <inst> to the published hive via /api/discovery/join-pot
# (joinHiveAsView: boots the member substrate AND re-keys it onto the owner's
# hive-pubkey topic — EI-681). Sets FRAME_MEMBER_SLUG[$inst]. hivePubkey is passed
# EXPLICITLY (a joiner's local discovery is empty). Requires rig_owner_publish_hive.
rig_join_hive() {
  local inst="$1" resp slug try
  [ -n "${RIG_HIVE_ID:-}" ] || { echo "FATAL: no hive published — call rig_owner_publish_hive first" >&2; return 1; }
  fed_log "[$inst] JOIN hive via /api/discovery/join-pot (hiveId=$RIG_HIVE_ID)"
  # 2 attempts with a reconnect probe between: an EMPTY resp means the SSH leg
  # died (transient flap — hit twice on 2026-07-01), not that the API refused.
  # Safe to retry: re-join is idempotent (existing view reused, members skipped,
  # owner self-join is a self_hive no-op).
  for try in 1 2; do
    resp="$(drv_exec "$inst" <<EOF
curl -s -m 610 -X POST http://127.0.0.1:${FED_SC[$inst]}/api/discovery/join-pot -H 'content-type: application/json' -d '{"potId":"$RIG_HIVE_ID","hivePubkey":"$RIG_HIVE_PUBKEY","memberLinks":["$RIG_HIVE_LINK"]}'
EOF
)"
    [ -n "$resp" ] && break
    [ "$try" = 1 ] && { echo "  ⚠ $inst join-hive got an empty response (ssh flap?) — re-probing + retrying once"; rig_ssh_wait "${FRAME_IP[$inst]}" 24 || break; }
  done
  slug="$(rig_join_member_slug "$resp")"
  # WI-1422 self-echo guard: the OWNER's self-join is now a NO-OP
  # ({ok:true, self_hive:true, members:[]}) — the owner's member harness was
  # already created by from-repo. Take its slug from the publish response.
  if [ -z "$slug" ] && printf '%s' "$resp" | grep -q '"self_hive":true'; then
    slug="${RIG_OWNER_MEMBER_SLUG:-}"
    [ -n "$slug" ] && echo "✓ $inst is the hive OWNER (self-join no-op; member=$slug)"
  fi
  FRAME_MEMBER_SLUG[$inst]="$slug"
  if printf '%s' "$resp" | grep -q '"ok":true' && [ -n "$slug" ]; then
    printf '%s' "$resp" | grep -q '"self_hive":true' || echo "✓ $inst joined hive (member=$slug)"
    return 0
  fi
  echo "✗ $inst join-pot failed: $(printf '%s' "$resp" | head -c 300)"; return 1
}

# rig_join_all <owner-inst> — join every NON-owner frame to the hive. The owner
# NEVER self-joins: its member harness already exists from the from-repo publish
# (RIG_OWNER_MEMBER_SLUG), and the old self-join-as-a-VIEW call was exactly the
# WI-1422 self-echo trigger — on a pre-guard .deb it minted a phantom
# '<hive>-2' remote view and rebound the owner's member harness to it, silently
# splitting owner→joiner federation (Brief-3 attempts 1-2, 2026-07-01). On a
# guarded .deb the call is a no-op anyway. Returns non-zero if any join fails.
rig_join_all() {
  local owner="$1" inst rc=0
  FRAME_MEMBER_SLUG[$owner]="${RIG_OWNER_MEMBER_SLUG:-}"
  if [ -n "${FRAME_MEMBER_SLUG[$owner]}" ]; then
    echo "✓ $owner is the hive OWNER (publish-time member=${FRAME_MEMBER_SLUG[$owner]}; no self-join)"
  else
    echo "⚠ $owner: no memberSlug in the publish response — falling back to self-join"
    rig_join_hive "$owner" || rc=1
  fi
  for inst in "${RIG_FRAMES[@]}"; do
    [ "$inst" = "$owner" ] && continue
    rig_join_hive "$inst" || rc=1
  done
  return "$rc"
}

# rig_wait_swarm <instA> <instB> [tries] — wait for [swarm] peer_connected between
# two frames over the resolved DHT (thin fed_wait_discovery strict wrapper). The
# sidecar-process swarm boot adds latency, so the default window is generous.
rig_wait_swarm() {
  local a="$1" b="$2" tries="${3:-70}" disc
  # EI-18685765921613818: same class as the launch-line fix above — this helper
  # is shared by isolated-bootstrap rigs (local-matrix.sh) too, so a hardcoded
  # "PUBLIC DHT" here is equally misleading on those runs.
  fed_log "wait swarm peer discovery $a↔$b over the DHT ${RIG_DHT_BOOTSTRAP:-PUBLIC} (~$(( tries * 3 ))s)"
  disc="$(fed_wait_discovery "$a" "$b" strict "$tries" || true)"
  [ "$disc" = 1 ] && { echo "✓ $a↔$b data path proven across machines (bytes crossed)"; return 0; }
  # EI-18687938054040755: skip = the build predates the peer_data_path_up
  # emitter, so no discovery verdict exists. Return 2 (distinct from 1) so a
  # caller can tell "not measured" apart from "measured and failed".
  [ "$disc" = skip ] && { echo "⊘ $a↔$b discovery N/A — build predates the peer_data_path_up emitter (EI-18687938054040755)"; return 2; }
  echo "⚠ no $a↔$b data path proven in ~$(( tries * 3 ))s"; return 1
}

# rig_wait_converged [joiner] [pot] — the REAL pre-scenario join-convergence barrier.
#
# EI-18661870528779127. rig_wait_swarm (above) asserts on `peer_connected`, which is
# NOT a readiness signal. In gate run 20260725-183831 that event fired ~85x per frame
# because EVERY connection died at a fixed ~13.0s (141/176 frame-a closes and 152/178
# frame-b closes at ageMs 13000-13005, every one `precededByError: 'connection timed
# out'` — POSIX ETIMEDOUT from UDX; a 5ms spread over ~90 samples is a fixed timer,
# not network variance). So the old barrier was satisfied by the FIRST of ~85 doomed
# connections: scenarios 10/20/30/40 started on an unconverged link and failed for
# reasons unrelated to what they test, while orders 50-90 — running later, on a
# by-then-converged link — passed 11 straight, INCLUDING reconnect_catchup(85), which
# exercises the SAME content/plan-part/coord A<->B path that "failed" at 10/20/30.
# Read the ORDER column before the error text: early-fail/late-pass is one readiness
# defect, not N independent ones.
#
# The predicate here is actual a->b STATE ARRIVAL, not connectivity: the joiner must
# hold at least one pot_members row. On a joiner that row is ALWAYS authored by the
# owner and federated IN (origin='remote' — see rig_resolve_ws's WI-5399 note), so its
# presence is direct proof that a->b transfer completed. This is not a new probe: the
# WS-DIAG block in deb-hetzner-matrix.sh already runs this exact query, and in run
# 183831 it printed EMPTY for frame b at the very moment the rig announced "frames
# healthy" — the evidence was on screen, just never gated on.
#
# INSTRUMENT, NOT A MUTE — the ratified WI-5444 rule from restart-settle-barrier.sh:
# "A barrier that silently blocks until convergence would let [scenarios] go green
# over a system that still takes minutes to resync ... hiding the defect instead of
# exposing it." So this ALWAYS emits elapsed as a first-class result line, warns
# loudly past RIG_CONVERGE_WARN_S even when it DOES converge (a visible regression
# signal short of a fail), and hard-fails only past the deliberately generous
# RIG_CONVERGE_FAIL_S. Every knob is env-overridable so recalibration never needs a
# code change.
#
# DO NOT "fix" a slow run by raising RIG_CONVERGE_FAIL_S, and do NOT go back to a bare
# sleep. A converge time creeping toward the deadline IS the product signal this
# barrier exists to surface: under the 13s cap each reconnect commits ZERO merge
# progress (serve-a held `merged to 2` of `writer at 11` for 344s across ~25 reconnect
# cycles, then completed 2->11 in one shot the moment churn paused), i.e.
# time-to-first-useful-progress exceeds the connection lifetime. That is WI-5763's
# product-side question — this barrier must expose it, never mask it.
rig_wait_converged() {
  local j="${1:-b}" pot="${2:-${RIG_HIVE_ID:-}}"
  local warn_s="${RIG_CONVERGE_WARN_S:-60}" fail_s="${RIG_CONVERGE_FAIL_S:-420}"
  local where="" t0 elapsed rows=""
  # No pot slug in scope → count ANY membership row on the joiner; any row at all is
  # owner-authored + federated-in, so it still proves a->b arrival. Never narrow to
  # pot_home_slug='' (which can never match and would hard-fail every run).
  [ -n "$pot" ] && where=" WHERE pot_home_slug='$pot'"
  fed_log "wait a→$j JOIN CONVERGENCE (pot_members visible on the joiner; warn ${warn_s}s / fail ${fail_s}s)"
  t0="$(date +%s)"
  while :; do
    rows="$(drv_psql "$j" "SELECT count(*) FROM harness_shared.pot_members${where};" 2>/dev/null | tr -d '[:space:]')"
    elapsed=$(( $(date +%s) - t0 ))
    case "$rows" in ''|*[!0-9]*) rows=0 ;; esac
    if [ "$rows" -ge 1 ]; then
      if [ "$elapsed" -ge "$warn_s" ]; then
        echo "⚠ a→$j converged in ${elapsed}s (${rows} membership row(s)) — SLOW, past the ${warn_s}s warn threshold; convergence is degrading (cf. WI-5763 / the 13s connection cap)"
      else
        echo "✓ a→$j converged in ${elapsed}s (${rows} membership row(s))"
      fi
      return 0
    fi
    if [ "$elapsed" -ge "$fail_s" ]; then
      echo "✗ a→$j NEVER CONVERGED in ${elapsed}s — 0 membership rows on the joiner."
      echo "  This is a REAL federation failure, not a flaky scenario. Do NOT raise RIG_CONVERGE_FAIL_S to get past it."
      echo "  Triage: the joiner never received owner-authored state. Check each frame's serve.log for a fixed ~13s"
      echo "  connection lifetime — 'swarm-churn close { ageMs: 130xx, precededByError: connection timed out }' in a"
      echo "  tight repeating cycle means every reconnect is committing zero merge progress (EI-18661870528779127)."
      echo "  ── joiner pot_members (final state) ──"
      drv_psql "$j" "SELECT github_username, pot_home_slug, origin, fed_ts FROM harness_shared.pot_members;" 2>&1 || true
      return 1
    fi
    sleep 3
  done
}

# ── scenario content primitives (write / read) ────────────────────────────────
# These give scenario scripts a uniform way to author + read federated rows under
# the operator's REAL workspace (the harness drains WHERE workspace_id = its boot
# workspace — a bare INSERT defaulting to 'default' never drains; D-050).

# rig_resolve_ws [inst] [pot] — echo the REAL workspace_id for <pot> (default
# RIG_HIVE_ID) on <inst> (default "a"), or nothing + FATAL on stderr + return 1.
#
# WI-5399 iteration 2 (D-050 class, joiner side): every probe/write helper in this
# scenario family used to resolve workspace_id via
#   `pot_members WHERE coalesce(origin,'local')='local' ORDER BY joined_at LIMIT 1`
# falling back to the literal string 'default' when that returned NULL. But
# `origin` classifies WRITE PROVENANCE (did THIS db insert the row directly, vs
# receive it via federation-apply), not identity-ownership. A JOINER's own
# membership row is authored by the OWNER and federates IN, so it is ALWAYS
# origin='remote' on the joiner — the old predicate structurally never matched
# there (confirmed live on a failing joiner frame: 0 local rows, 4/4 remote,
# direct psql). Resolve by `pot_home_slug` instead (part of the table's PK, one
# workspace_id per pot on a given frame's DB — uniform on owner AND joiner, no
# origin asymmetry) and FAIL LOUDLY instead of silently falling back to a
# workspace_id the harness never drains (that silent 'default' fallback *is*
# D-050 — this replaces it, it doesn't reinstate it).
rig_resolve_ws() {
  local inst="${1:-a}" pot="${2:-${RIG_HIVE_ID:-}}" ws
  ws="$(drv_psql "$inst" "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='$pot' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$ws" ]; then
    echo "FATAL rig_resolve_ws($inst,$pot): could not resolve a real workspace_id — refusing to silently use 'default' (D-050/WI-5399 class)" >&2
    return 1
  fi
  echo "$ws"
}

# rig_write_content <inst> <harness_slug> <feature_id> [title] [status]
# INSERT a feature row origin='local' on <inst> (the capture trigger federates it).
# Echoes the feature_id only after a confirmed write. The analog the fed_*_merge
# probes also use.
#
# WI-6043 detector-integrity fix: migrations 651/652 reject local feature writes
# under a joined member-repo slug; a federated rig write must be homed to the real
# Pot. RIG_HIVE_ID is that already-resolved identity, shared by every frame, so use
# it whenever it is in scope (the explicit slug remains the fallback for callers
# outside the Pot rig). Also propagate a rejected INSERT: a negative assertion run
# after an unauthored write is vacuous and used to score revocation_kcut PASS.
rig_write_content() {
  local inst="$1" slug="$2" fid="$3" title="${4:-rig write}" status="${5:-todo}" ts ws write_slug
  write_slug="$slug"
  [ -n "${RIG_HIVE_ID:-}" ] && write_slug="$RIG_HIVE_ID"
  ts="$(date +%s)000"
  ws="$(rig_resolve_ws "$inst")" || return 1
  if ! drv_psql "$inst" "INSERT INTO harness_shared.harness_features_consolidated (workspace_id,harness_slug,feature_id,title,summary,status,attempts,origin,ts,created_ts,updated_ts) VALUES ('$ws','$write_slug','$fid','$title','rig write','$status',0,'local',$ts,$ts,$ts);" >/dev/null; then
    echo "FATAL rig_write_content($inst,$fid): source write was rejected (requested slug='$slug', resolved Pot home='$write_slug') — refusing to let a downstream absence assert pass vacuously" >&2
    return 1
  fi
  echo "$fid"
}

# rig_read_content <inst> <feature_id> — echo "<harness_slug>|<origin>" for the
# row with this feature_id on <inst> (empty if absent). origin='remote' = federated.
rig_read_content() {
  local inst="$1" fid="$2"
  drv_psql "$inst" "SELECT harness_slug||'|'||origin FROM harness_shared.harness_features_consolidated WHERE feature_id='$fid' LIMIT 1;" 2>/dev/null | tr -d '[:space:]'
}

# rig_read_roster <inst> [pot] — echo the pot_members roster on <inst>, one row per
# line as "<github_user_id>|<binding_status>|<#device_attestations>". The decisive
# receive-side state (empty roster → decideMemberContentOp drops every peer op).
#
# SCOPED to this run's workspace + pot (EI-18656746187879489: this used to have NO
# workspace_id/pot_home_slug predicate at all, so a frame hosting more than one pot
# — a reused frame across scenario runs, e.g. — could report an unrelated pot's
# members as THIS pot's roster: several callers gate PASS/FAIL directly on
# "roster non-empty" (deb-hetzner-restart.sh, deb-hetzner-reconnect.sh), so an
# unscoped read is a false-PASS available from any other pot on the frame, same
# family as _cl_roster_ids/EI-18656746187879489). `pot` defaults to RIG_HIVE_ID
# (the pot under test); RIG_WORKSPACE_ID is always set by rig_init before this can
# run. Passing an explicit `pot` of '' (empty) intentionally widens to every pot
# in the workspace — no caller does this today, but it stays available.
rig_read_roster() {
  local inst="$1" pot="${2:-${RIG_HIVE_ID:-}}" conds="" where=""
  [ -n "${RIG_WORKSPACE_ID:-}" ] && conds="workspace_id='${RIG_WORKSPACE_ID}'"
  if [ -n "$pot" ]; then
    [ -n "$conds" ] && conds="$conds AND pot_home_slug='$pot'" || conds="pot_home_slug='$pot'"
  fi
  [ -n "$conds" ] && where=" WHERE $conds"
  drv_psql "$inst" "SELECT github_user_id||'|'||binding_status||'|'||COALESCE(jsonb_array_length(device_attestations),0) FROM harness_shared.pot_members${where} ORDER BY github_user_id;" 2>/dev/null
}

# ── revoke / ban (the Brief 3 revocation primitive) ───────────────────────────
# rig_github_id <gh-login> — resolve a GitHub login to its numeric user id via the
# public API (driver-side gh; the rig host is gh-authed). The revoke route keys on
# the STABLE numeric id (not the login), so a scenario turns FRAME_USER[b] into the
# id to ban. Echoes the id, or nothing on failure.
rig_github_id() { gh api "users/$1" --jq '.id' 2>/dev/null; }

# rig_ban_member <owner-inst> <target-github-id> [scope]
#   scope="hive" (DEFAULT) — Hive-wide revoke: POST /api/admin/substrate/revoke-contributor
#         {hiveSlug=RIG_HIVE_ID}. Authority = the Swarm holding the Hive key (the owner
#         frame that ran pots/from-repo). Drives revokeHiveContributor → the
#         revoked_pubkeys admission blocklist AND (once the C-001 re-key advances the
#         epoch EXCLUDING the target) the epoch K-cut READ cut-off. revoke.live is FALSE
#         until the next re-key lands — the owner must WRITE post-ban content to trigger
#         the re-key before the read cut-off bites (see deb-hetzner-revocation.sh).
#   scope="harness" — single-harness revoke {harnessSlug=owner member slug}, authority =
#         repo-admin token.
# Resolves workspaceId from the owner's hive_members. Echoes the raw JSON response
# ({ok:true,revokedPubkeys,live} on success).
#
# AUTH (verified live 2026-07-01): the route is auth:{trust:['verified','trusted']}. A bare
# localhost curl resolves to 'unverified-loopback' and is REJECTED (403 "trust
# unverified-loopback not in allowlist"). principalFromSuperuserToken grants trust:'trusted'
# for a LOOPBACK request carrying `Authorization: Bearer <token>` matching
# ~/.papercusp/superuser-token. The sidecar runs as user pcusp, so we resolve/ensure
# /home/pcusp/.papercusp/superuser-token ON the owner frame (as pcusp; generate one mode 0600
# if absent — the sidecar validates the bearer against the file PER-REQUEST, so a fresh write
# is honored, and an existing token is reused, never clobbered) and present it as the bearer.
# The token is never echoed/logged.
rig_ban_member() {
  local owner="$1" target_id="$2" scope="${3:-hive}" ws field val resp token
  [ -n "$target_id" ] || { echo "FATAL rig_ban_member: no target github id" >&2; return 1; }
  ws="$(rig_resolve_ws "$owner")" || return 1
  if [ "$scope" = "harness" ]; then field="harnessSlug"; val="${FRAME_MEMBER_SLUG[$owner]:-}"
  else field="potSlug"; val="${RIG_HIVE_ID:-}"; fi  # endpoint field renamed hiveSlug→potSlug by cup-lexicon-full-rename-2026-07-09
  [ -n "$val" ] || { echo "FATAL rig_ban_member: no $field resolved (run rig_owner_publish_hive + rig_join_hive first)" >&2; return 1; }
  # trust:'trusted' bearer — read (or generate, as pcusp) the sidecar's superuser token so
  # principalFromSuperuserToken admits the revoke (loopback + matching bearer). Never clobber
  # an existing token; the sidecar re-reads the file per request so a fresh write is honored.
  token="$(rig_pcusp_run "$owner" <<'PCUSP' 2>/dev/null | tr -d '[:space:]'
f=/home/pcusp/.papercusp/superuser-token
[ -s "$f" ] || { mkdir -p /home/pcusp/.papercusp; head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40 > "$f"; chmod 600 "$f"; }
cat "$f"
PCUSP
)"
  [ -n "$token" ] || { echo "FATAL rig_ban_member: could not resolve/create the owner superuser-token (the revoke route needs trust:'trusted')" >&2; return 1; }
  fed_log "[$owner] BAN github_id=$target_id ($scope scope: $field=$val ws=$ws) [su-bearer]"
  resp="$(drv_exec "$owner" <<EOF
curl -s -m 120 -X POST "http://127.0.0.1:${FED_SC[$owner]}/api/admin/substrate/revoke-contributor" -H 'content-type: application/json' -H "Authorization: Bearer $token" -d '{"workspaceId":"$ws","$field":"$val","githubUserId":$target_id}'
EOF
)"
  echo "$resp"
}

# ── NEGATIVE assertion (the Brief 3 revocation / security primitive) ──────────
# rig_reading <label> <value> — emit a measured value AT ITS MEASUREMENT POINT, in
# three DISTINGUISHABLE states, so that no later early-return can discard it.
#
# WI-40549 (the "computed here, reported there" class). A scenario repeatedly
# measures a diagnostic, then reaches its scoring message through one of SEVERAL
# exit paths — and only ONE of those paths interpolates the value. Every other
# path (an UNMEASURED bail, an early PASS) returns having silently thrown the
# reading away. Two live instances in b9-attestation.sh alone: $wrong_on_b is
# measured at L131 but the post-probe-UNMEASURED return at L139 prints it
# nowhere, and $probe_on_b is measured at L394 and discarded by BOTH the L405
# UNMEASURED return and the L443 OK path. The reading is most valuable in
# exactly the paths that dropped it: when a leg bails early, "did the probe ever
# land?" is the question separating a rig fault from a real product failure, and
# it is unrecoverable after the fact because the frames are torn down.
#
# The fix is positional, not per-exit-path: report at the point of MEASUREMENT
# and every exit path inherits it for free. Patching each scoring message
# instead leaves the next added early-return silently broken again.
#
# THREE states, never two — an empty reading is NOT a zero. Collapsing them is
# the same false-negative class rig_assert_absent guards below: "the probe
# returned 0" and "the probe never ran" imply opposite conclusions about whether
# to suspect the rig or the feature.
#
# Writes to stderr: scenario STDOUT is the scored verdict channel (b5-restart.sh
# redirects it to a tmp file), so a diagnostic on stdout could corrupt scoring.
rig_reading() {
  local label="$1" value="${2-}"
  if [ -z "$value" ]; then
    echo "  ⚠ reading[$label]=<unmeasured> — the probe returned nothing, so 'zero' and 'never ran' are indistinguishable here; suspect the rig before the feature" >&2
  elif [ "$value" = "0" ]; then
    echo "  · reading[$label]=0 (genuinely measured as zero)" >&2
  else
    echo "  · reading[$label]=$value (measured)" >&2
  fi
}

# rig_assert_absent <inst> <feature_id> [tries] — assert a feature row does NOT
# arrive on <inst> within tries×3s. The inverse of fed_*_merge_assert: it WAITS
# the full window and PASSES iff the row never shows up (a revoked/banned member
# must NOT receive post-revoke content). Echoes 1 (correctly absent) or 0 (it
# arrived — a leak). Because a negative is only meaningful after enough time, this
# always waits the full window before declaring absence (no early-out on success).
#
# WI-5768 (scenario-assert integrity audit, generalizing the WI-5715 class): a
# negative assert over a REMOTE probe (ssh + psql) can silently score PASS on
# total probe FAILURE, not just genuine absence. drv_psql's pipeline (with
# `pipefail` set by every caller — verified: every deb-hetzner-*.sh/local-matrix.sh
# sources `set -uo pipefail` and never unsets pipefail) exits non-zero on an
# ssh/connection/psql error, but the OLD code only ever inspected $row — which is
# EMPTY both on "confirmed zero rows" AND "the query never ran" (dead frame,
# network partition, wrong port). A banned/unreachable member going fully dark
# for the entire window used to read as "correctly absent" — a false PASS on the
# SECURITY-critical revocation leak check, exactly the CAN-FALSELY-PASS class
# this audit targets ("a probe whose failure to RUN reads as clean"). Fix: track
# each iteration's exit code; only a genuinely-executed (rc=0) empty read counts
# as a real negative signal, and if NOT ONE probe ever actually ran, the assert
# is UNMEASURED and scores FAIL — never a pass. A probe failure is also logged so
# a flaky-but-eventually-successful run stays visible in the log.
rig_assert_absent() {
  local inst="$1" fid="$2" tries="${3:-20}" i row rc measured=0
  for i in $(seq 1 "$tries"); do
    row="$(drv_psql "$inst" "SELECT 1 FROM harness_shared.harness_features_consolidated WHERE feature_id='$fid' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"; rc=$?
    if [ "$rc" -eq 0 ]; then
      measured=$((measured + 1))
      if [ "$row" = "1" ]; then echo 0; return 1; fi   # arrived → negative assert FAILS
    else
      echo "  ⚠ rig_assert_absent($inst,$fid): probe $i/$tries FAILED to run (rc=$rc — ssh/psql error, not a confirmed read)" >&2
    fi
    sleep 3
  done
  if [ "$measured" -eq 0 ]; then
    echo "  ✗ rig_assert_absent($inst,$fid): ALL $tries probes failed to run — the assert is UNMEASURED, never a confirmed absence; scoring FAIL (an unmeasurable probe is not a pass)" >&2
    echo 0; return 1
  fi
  echo 1; return 0   # never arrived within the window (genuinely measured) → correctly absent
}

# rig_assert_row_absent <inst> <sql-predicate> [tries] — generic negative assert:
# PASS iff `SELECT 1 FROM … WHERE <predicate>` stays empty for the full window.
# <predicate> is a complete SQL boolean over any harness_shared table joined inline,
# e.g. "harness_shared.coord_event_log WHERE msg_id='X' AND origin='remote'". Lets
# briefs negative-assert coord/plan-part rows too, not just features.
#
# WI-5768: same fail-closed fix as rig_assert_absent above (see its comment for
# the full rationale) — a probe that never actually ran must never be
# indistinguishable from a confirmed-empty read. Used by
# deb-hetzner-coord-controlplane.sh's presence/watermark/subscription
# non-federation boundary checks, so the same false-PASS risk applied there too.
rig_assert_row_absent() {
  local inst="$1" pred="$2" tries="${3:-20}" i row rc measured=0
  for i in $(seq 1 "$tries"); do
    row="$(drv_psql "$inst" "SELECT 1 FROM $pred LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"; rc=$?
    if [ "$rc" -eq 0 ]; then
      measured=$((measured + 1))
      if [ "$row" = "1" ]; then echo 0; return 1; fi
    else
      echo "  ⚠ rig_assert_row_absent($inst): probe $i/$tries FAILED to run (rc=$rc — ssh/psql error, not a confirmed read)" >&2
    fi
    sleep 3
  done
  if [ "$measured" -eq 0 ]; then
    echo "  ✗ rig_assert_row_absent($inst): ALL $tries probes failed to run — the assert is UNMEASURED, never a confirmed absence; scoring FAIL (an unmeasurable probe is not a pass)" >&2
    echo 0; return 1
  fi
  echo 1; return 0
}
