#!/usr/bin/env bash
# local-matrix.sh — ONE-COMMAND local containerized N-node federation matrix
# (2-frame by default; --frames=3 for the standing 3-node coverage gap, P-006
# of p2p-rest-lanes-2026-07-09 / umbrella P-010).
#
# Hetzner access is GONE (owner 2026-07-03; D-001 of
# shared-hive-p2p-release-readiness-2026-07-03). The live federation regression
# matrix (bin/deb-hetzner-matrix.sh + bin/lib/scenarios/*) still runs UNCHANGED —
# this wrapper provisions the frames LOCALLY instead of on Hetzner:
#
#   1. builds a tiny ubuntu-24.04 + sshd docker image (root pubkey login, the
#      same contract a Hetzner VM gives the rig: ssh root@ip, apt, runuser),
#   2. runs 2 (or 3, with --frames=3) frame containers on a dedicated bridge
#      network (fixed IPs),
#   3. starts a host-side hyperdht TESTNET node advertised on the bridge
#      gateway (co-located peers cannot rely on public-DHT NAT hairpinning —
#      same reason the two-instance smokes use PAPERCUSP_DHT_BOOTSTRAP),
#   4. execs bin/deb-hetzner-matrix.sh with RIG_FRAME_IPS + RIG_DHT_BOOTSTRAP +
#      RIG_SSH_IDENTITY set — the WI-1544 BYO-frames seam skips the Hetzner API
#      entirely (no HCLOUD_TOKEN needed; rig_cleanup destroys nothing — THIS
#      script owns the frames' lifecycle and tears them down on exit). With
#      3 BYO ips, deb-hetzner-matrix.sh auto-registers frame 'c' (2nd member)
#      IN ADDITION to a=owner/b=member — the live-Hetzner 2-server cap does not
#      apply here since nothing is provisioned on Hetzner (BYO skips the API).
#
# This is the EXACT mode that produced the 8/8 min-bar matrix run m1783013203
# (2026-07-02, container-grade). For a true kernel/network boundary use the
# tower↔VM rig instead: bin/vm-rig/README.md.
#
# Usage:
#   bin/local-matrix.sh                      # full 8-scenario run (needs a built .deb)
#   bin/local-matrix.sh --frames=3           # 3-node rig (owner + 2 members); the
#                                            #  8-scenario matrix still runs a/b only,
#                                            #  PLUS the membership_churn scenario
#                                            #  which exercises frame c
#   bin/local-matrix.sh --deb=PATH           # explicit artifact (default: newest bundle;
#                                            #  a stale-deb warning prints if it predates HEAD)
#   bin/local-matrix.sh --only=b5_restart,concurrent_lww
#   bin/local-matrix.sh --list               # print registered scenarios, no provision
#   bin/local-matrix.sh --keep-up            # leave frames + DHT up after the run
#   bin/local-matrix.sh --reuse              # reuse frames + DHT from a --keep-up run
#   bin/local-matrix.sh --teardown           # destroy frames + network + DHT and exit
#
# Requirements: docker (daemon running, caller in the docker group), node with
# hyperdht resolvable from apps/operator (the sidecar workspace), gh auth for
# the two frame identities (papercupai + ownerhandle — same as the Hetzner rig), a
# built .deb (bin/build-desktop-sidecar.sh + `npm run build`, or release-local.sh).
#
# Firewall note: frames reach the DHT node on the bridge GATEWAY ip. If ufw is
# active and INPUT-filtering the docker bridge, allow it once:
#   sudo ufw allow from 10.99.0.0/24
set -uo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$DESKTOP_DIR/.." && pwd)"
OPERATOR_DIR="${PAPERCUSP_OPERATOR_DIR:-$ROOT/apps/operator}"

NET="${PCUSP_LOCAL_RIG_NET:-pcusp-local-rig}"
SUBNET="${PCUSP_LOCAL_RIG_SUBNET:-10.99.0.0/24}"
GW="${PCUSP_LOCAL_RIG_GW:-10.99.0.1}"
IP_A="${PCUSP_LOCAL_RIG_IP_A:-10.99.0.11}"
IP_B="${PCUSP_LOCAL_RIG_IP_B:-10.99.0.12}"
IP_C="${PCUSP_LOCAL_RIG_IP_C:-10.99.0.13}"
# Frame/state/lock identity is scoped to the NET (2026-07-03 collision fix):
# fixed container names made the rig ONE-PER-BOX even across separate bridge
# networks — a run on a custom net `docker rm -f`'d the default net's LIVE
# frames BY NAME (and vice versa; the 07-03 cross-lane collision destroyed a
# kept forensic rig this way). Default net keeps the legacy names/paths so
# existing runs/docs are untouched; a CUSTOM net gets its own container names,
# state file, and flock — rigs on distinct nets are independent by construction.
if [ "$NET" = pcusp-local-rig ]; then
  CN_A="${PCUSP_LOCAL_RIG_CN_A:-pcusp-rig-a}"; CN_B="${PCUSP_LOCAL_RIG_CN_B:-pcusp-rig-b}"; CN_C="${PCUSP_LOCAL_RIG_CN_C:-pcusp-rig-c}"
  STATE_FILE="${PCUSP_LOCAL_RIG_STATE:-/tmp/pcusp-local-rig.state}"
  RIG_LOCK_DEFAULT=/tmp/pcusp-local-rig.lock
else
  CN_A="${PCUSP_LOCAL_RIG_CN_A:-$NET-a}"; CN_B="${PCUSP_LOCAL_RIG_CN_B:-$NET-b}"; CN_C="${PCUSP_LOCAL_RIG_CN_C:-$NET-c}"
  STATE_FILE="${PCUSP_LOCAL_RIG_STATE:-/tmp/$NET.state}"
  RIG_LOCK_DEFAULT="/tmp/$NET.lock"
fi

# WI-5631: pin the rig frames' home-harness slug to a synthetic, non-'papercusp' value.
# Left unset, deb-hetzner-rig.sh's RIG_HOME_HARNESS_SLUG stays empty, so every frame's
# operatorHomeHarnessSlug() falls through to LEGACY_DEFAULT_HOME_HARNESS='papercusp' —
# which then matches the `harness_slug` on federated ops carrying the REAL production
# papercusp home-harness backlog, so the engineer-issues projection's own-slug fast path
# (decideMemberContentOp: rowHarnessSlug === opts.harnessSlug → unconditional apply, no
# membership check) admits + writes that entire real backlog into the frame — thousands
# of "EI-13285 id collision" ops/run that starve the frame's event loop and block a clean
# replication_soak pass. One value for the whole rig run is enough (RIG_WORKSPACE_ID is
# likewise a single per-run value shared by every frame) — it only needs to NOT resolve
# to a real registered project. Override with RIG_HOME_HARNESS_SLUG if a scenario
# deliberately wants a specific (non-'papercusp') slug.
RIG_HOME_HARNESS_SLUG="${RIG_HOME_HARNESS_SLUG:-${NET}-home}"
IMAGE_TAG=pcusp-local-frame:ubuntu24
SSH_KEY="${PCUSP_LOCAL_RIG_KEY:-$HOME/.papercusp/local-rig-ssh}"

# ── frame CPU reservation (WI-5319 / plan D-003) ─────────────────────────────
# Pin each frame to its own reserved core set so fleet/host load cannot starve the
# frames' node main threads. Run 20260717-174333: rig-b logged 18×"boot timeout after
# 30000ms" + 10 late-adopt cycles with event-loop p99 1.48s under host load 40–100 —
# starved (unpinned) frames read as federation bugs. Defaults take the TOP cores,
# 8 per frame, only on boxes big enough that the reservation can't crowd the host
# (<24 cores ⇒ no pinning). Override per frame with PCUSP_RIG_CPUSET_{A,B,C}
# ('' disables). --cpu-shares=4096 additionally wins scheduler bursts against other
# docker work (default weight 1024) without hard-starving it.
# assert-integrity-ok: NCPU feeds a CONFIG decision, not an assert — nothing is scored off it.
# The fallback is also the CONSERVATIVE direction: an unmeasurable nproc reads as 8, which is
# < 24 and therefore DISABLES cpu pinning entirely. An unmeasured probe here can only forgo an
# optimisation, never make a claim falsely pass.
NCPU="$(nproc 2>/dev/null || echo 8)"
if [ "$NCPU" -ge 24 ]; then
  _def_cpuset_a="$((NCPU-8))-$((NCPU-1))"
  _def_cpuset_b="$((NCPU-16))-$((NCPU-9))"
  _def_cpuset_c="$((NCPU-24))-$((NCPU-17))"
else
  _def_cpuset_a=""; _def_cpuset_b=""; _def_cpuset_c=""
fi
CPUSET_A="${PCUSP_RIG_CPUSET_A-$_def_cpuset_a}"
CPUSET_B="${PCUSP_RIG_CPUSET_B-$_def_cpuset_b}"
CPUSET_C="${PCUSP_RIG_CPUSET_C-$_def_cpuset_c}"
CPU_ARGS_A="--cpu-shares 4096"; [ -n "$CPUSET_A" ] && CPU_ARGS_A="--cpuset-cpus $CPUSET_A $CPU_ARGS_A"
CPU_ARGS_B="--cpu-shares 4096"; [ -n "$CPUSET_B" ] && CPU_ARGS_B="--cpuset-cpus $CPUSET_B $CPU_ARGS_B"
CPU_ARGS_C="--cpu-shares 4096"; [ -n "$CPUSET_C" ] && CPU_ARGS_C="--cpuset-cpus $CPUSET_C $CPU_ARGS_C"

# ── frame MEMORY reservation (D-003 / EI-13317: genuine memory isolation) ────
# WI-5319 pinned the frame CPUs but left memory UNBOUNDED — so under host memory
# pressure the fleet's page-cache churn reclaims the frames' resident pages and
# their node/PG stall: the same starvation that breaks replication_soak's 90s
# reconnect SLA, on the memory axis. --memory-reservation sets cgroup-v2
# `memory.low` — a PROTECTED floor the kernel will not reclaim below under
# pressure (this is the isolation that matters); --memory is a generous hard cap
# for hygiene; --memory-swap==--memory disables swap growth so the frame stays
# resident (no swap-in latency spikes on the event loop; this box has no working
# --memory-swappiness). Sized way above one operator sidecar + embedded PG on
# this 251G box; override with PCUSP_RIG_MEM_{MAX,LOW} ('' disables that piece).
MEM_MAX="${PCUSP_RIG_MEM_MAX-16g}"
MEM_LOW="${PCUSP_RIG_MEM_LOW-4g}"
MEM_ARGS=""
[ -n "$MEM_MAX" ] && MEM_ARGS="--memory $MEM_MAX --memory-swap $MEM_MAX"
[ -n "$MEM_LOW" ] && MEM_ARGS="$MEM_ARGS --memory-reservation $MEM_LOW"

# ── genuine CPU EXCLUSIVITY (D-003: exclusive cores, not just affinity) ───────
# --cpuset-cpus above is AFFINITY ONLY: it confines the frame TO its cores but
# does NOT evict the host fleet OFF them, so under sustained load (this box idles
# at 40–120) fleet threads pile onto the frame's "reserved" cores and starve its
# node event loop during the restart/reconnect legs — exactly the miss that fails
# replication_soak (passes in ~10s on a quiet frame, misses the 90s SLA on a
# starved one). A cgroup-v2 EXCLUSIVE partition genuinely evicts every other
# cgroup from the frame's cores: we grant the frame cores as exclusively-
# allocatable at system.slice (parent of every docker-*.scope), then promote each
# frame's scope to `cpuset.cpus.partition=root`. Needs cgroup v2 + the cpuset
# controller delegated to system.slice + passwordless sudo; degrades to
# affinity-only with a WARN otherwise (never fails the run). The grant + each
# partition are released on teardown. PCUSP_RIG_EXCLUSIVE=0 opts out.
CGROOT="${PCUSP_CGROUP_ROOT:-/sys/fs/cgroup}"
RIG_EXCLUSIVE="${PCUSP_RIG_EXCLUSIVE:-1}"
RIG_EXCLUSIVE_ACTIVE=0

# Union of the frame cpusets actually in use (respects --frames + '' disables).
rig_exclusive_cores() {
  local list=""
  [ -n "$CPUSET_A" ] && list="$CPUSET_A"
  [ -n "$CPUSET_B" ] && list="${list:+$list,}$CPUSET_B"
  [ "$FRAMES" = 3 ] && [ -n "$CPUSET_C" ] && list="${list:+$list,}$CPUSET_C"
  printf '%s' "$list"
}

# Grant the frame cores as exclusively-allocatable at system.slice. Idempotent;
# returns non-zero (⇒ affinity-only fallback) if the platform can't support it.
rig_enable_exclusive() {
  [ "$RIG_EXCLUSIVE" = 1 ] || return 1
  local cores; cores="$(rig_exclusive_cores)"
  [ -n "$cores" ] || return 1   # no pinning at all (small box) ⇒ nothing to isolate
  [ "$(stat -fc %T "$CGROOT" 2>/dev/null)" = cgroup2fs ] || { log "WARN: not cgroup v2 — frames get CPU affinity only, NOT exclusive cores"; return 1; }
  [ -e "$CGROOT/system.slice/cpuset.cpus.exclusive" ] || { log "WARN: cpuset controller not delegated to system.slice — affinity only"; return 1; }
  sudo -n true 2>/dev/null || { log "WARN: no passwordless sudo — cannot make frame cores exclusive; affinity only"; return 1; }
  if sudo -n sh -c "printf '%s' '$cores' > '$CGROOT/system.slice/cpuset.cpus.exclusive'" 2>/dev/null; then
    RIG_EXCLUSIVE_ACTIVE=1
    return 0
  fi
  log "WARN: could not reserve exclusive cores [$cores] at system.slice — affinity only"
  return 1
}

# Promote one frame's cgroup scope to an exclusive partition root (evicts the
# host fleet off its cores). Best-effort: logs + continues on any failure.
rig_frame_exclusive() {  # $1=container name  $2=cpuset
  local cn="$1" cores="$2" id scope st
  { [ "$RIG_EXCLUSIVE_ACTIVE" = 1 ] && [ -n "$cores" ]; } || return 0
  id="$(docker inspect -f '{{.Id}}' "$cn" 2>/dev/null)" || return 0
  scope="$CGROOT/system.slice/docker-$id.scope"
  [ -d "$scope" ] || { log "WARN: no cgroup scope for frame $cn — cores $cores stay affinity-only"; return 0; }
  if sudo -n sh -c "printf '%s' '$cores' > '$scope/cpuset.cpus.exclusive' && echo root > '$scope/cpuset.cpus.partition'" 2>/dev/null; then
    st="$(cat "$scope/cpuset.cpus.partition" 2>/dev/null || echo '?')"
    case "$st" in
      root) log "frame $cn: EXCLUSIVE cores $cores — host fleet evicted (cgroup-v2 partition)" ;;
      *)    log "WARN: frame $cn partition=[$st] not exclusive — cores $cores stay affinity-only" ;;
    esac
  else
    log "WARN: could not make frame $cn cores $cores exclusive — affinity only"
  fi
}

# Release the system.slice exclusive grant (teardown, after the frame scopes are
# gone — removing the containers already dissolved their partitions). Also cleans
# a grant left by a hard-killed prior run. Unconditional beyond platform support
# so `--teardown` repairs a stale grant; writing empty over empty is a no-op.
rig_disable_exclusive() {
  [ "$(stat -fc %T "$CGROOT" 2>/dev/null)" = cgroup2fs ] || return 0
  [ -e "$CGROOT/system.slice/cpuset.cpus.exclusive" ] || return 0
  sudo -n sh -c "echo > '$CGROOT/system.slice/cpuset.cpus.exclusive'" 2>/dev/null || true
}

# ── args ──────────────────────────────────────────────────────────────────────
DEB=""; ONLY=""; KEEP_UP=0; REUSE=0; MODE=run; FRAMES=2
for arg in "$@"; do case "$arg" in
  --deb=*)     DEB="${arg#--deb=}" ;;
  --only=*)    ONLY="${arg#--only=}" ;;
  --frames=*)  FRAMES="${arg#--frames=}" ;;
  --keep-up)   KEEP_UP=1 ;;
  --reuse)     REUSE=1 ;;
  --list)      MODE=list ;;
  --teardown)  MODE=teardown ;;
  -h|--help)   sed -n '2,52p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown arg: $arg (try --help)" >&2; exit 2 ;;
esac; done
case "$FRAMES" in 2|3) : ;; *) echo "FATAL: --frames must be 2 or 3 (got '$FRAMES')" >&2; exit 2 ;; esac

log() { echo "[local-matrix] $*" >&2; }

[ "$MODE" = list ] && exec bash "$DESKTOP_DIR/bin/deb-hetzner-matrix.sh" --list

# ── single-tenant lock (per-NET since the 07-03 collision fix) ───────────────
# The rig is ONE-PER-NET: fixed container names + IPs, a shared bridge network,
# and a gateway DHT. Without a lock, two concurrent runs mutually destroy each
# other: provisioning `docker rm -f`s the other run's LIVE frames, and the EXIT
# trap tears down the shared net/DHT mid-run (2026-07-03 P-004×P-002 collision:
# a peer's teardown killed a soak's freshly provisioned frames inside its
# wait-sshd window — surfaced as a phantom "FATAL ssh"). flock serializes runs
# AND --teardown (tearing down under a live run is the same destructive op):
# a second invocation WAITS up to RIG_LOCK_WAIT_S (default 7200s), logging the
# holder; RIG_LOCK_WAIT_S=0 fails fast (exit 3). The lock releases on process
# exit (flock fd semantics) — after a --keep-up run the frames stay up but the
# rig becomes claimable, on purpose (--reuse re-enters; a full run replaces).
RIG_LOCK="${PCUSP_LOCAL_RIG_LOCK:-$RIG_LOCK_DEFAULT}"
exec 9>>"$RIG_LOCK" || { echo "FATAL: cannot open rig lock $RIG_LOCK" >&2; exit 1; }
if ! flock -n 9; then
  RIG_LOCK_HOLDER="$(cat "$RIG_LOCK.holder" 2>/dev/null || echo 'unknown holder')"
  RIG_LOCK_WAIT="${RIG_LOCK_WAIT_S:-7200}"
  if [ "$RIG_LOCK_WAIT" = 0 ]; then
    echo "FATAL: rig busy — held by: $RIG_LOCK_HOLDER (single-tenant; RIG_LOCK_WAIT_S=0 ⇒ fail-fast)" >&2
    exit 3
  fi
  log "rig busy — held by: $RIG_LOCK_HOLDER; waiting up to ${RIG_LOCK_WAIT}s (RIG_LOCK_WAIT_S=0 to fail fast)"
  flock -w "$RIG_LOCK_WAIT" 9 || { echo "FATAL: rig still busy after ${RIG_LOCK_WAIT}s — held by: $RIG_LOCK_HOLDER" >&2; exit 3; }
fi
printf '%s pid=%s %s\n' "$(date -Is)" "$$" "${RIG_LOCK_LABEL:-${USER:-?}:local-matrix $*}" >"$RIG_LOCK.holder"

# ── bank the frames' evidence BEFORE destroying them (EI-18660101091813036) ───
# This wrapper's teardown `docker rm -f`s the frames, and each frame's
# /home/pcusp/serve.log is the primary diagnostic every scenario failure line
# points at ("see [swarm] diagnostics + /home/pcusp/serve.log on each frame").
# Destroying it unbanked is how a FAIL verdict routinely outlived its own
# explanation — and why four separate agents hand-rolled the same ad-hoc
# scp-on-a-timer rescue script (/tmp/bank-serve-logs-*.sh, one of them "-v3").
#
# WHY THIS EXISTS ALONGSIDE rig_bank_logs() (lib/deb-hetzner-rig.sh), which
# already banks per-scenario-FAIL and at the matrix's own EXIT — it does NOT
# cover the two cases this one is for, and both are the cases where evidence is
# scarcest:
#   • MATRIX-SCOPED. Every failure BEFORE the matrix starts — provision, the
#     wait-sshd window, DHT bootstrap, the ufw preflight — and every kill of
#     THIS wrapper (a gate leg budget, `timeout`, ^C) reaches teardown without
#     the matrix banker ever having run. That is the EI's "a run that never
#     reaches a clean EXIT banks NOTHING at all".
#   • SSH-SCOPED. rig_bank_logs reads each frame over ssh (`drv_exec … cat`), so
#     a frame that is wedged, OOM-killed or never finished booting answers
#     nothing and banks the string "(bank fetch failed …)" in place of the log
#     that would have explained it. `docker cp` reads the container filesystem
#     off the daemon: no key, no IP parsing, no ConnectTimeout — and it works on
#     a STOPPED container, which is exactly the frame you most need to read.
#
# GAP-FILL, NOT A SECOND BANKER (PCUSP_LOCAL_RIG_BANK=auto, the default): if the
# matrix already banked a serve-*.log for THIS run, this returns without writing.
# Re-banking the same cumulative log would inflate the file/starved counts the
# gate's own _frame_lag_scan() reports, and would add another nested snapshot to
# the pile the lib's bank header explicitly warns readers about
# (EI-18687774064705397). `=always` banks regardless (useful when a run got far
# enough to bank early but the frames wedged later); `=never` disables it.
#
# Files land in the SAME dir and the SAME serve-*.log naming the gate's
# _frame_lag_scan()/check_local_matrix_frame_starvation() already read, so a
# killed run's frames now feed the starvation detector too instead of reading as
# "no frame serve.log banked for this run". Retention is the lib's existing FIFO
# over serve-*.log; the DHT bundle carries its own (its name is outside that
# glob on purpose — it is not a frame, and must not be counted as one).
#
# Best-effort throughout: never fatal, never masks the run's verdict.
RIG_BANK_DIR="${RIG_BANK_DIR:-$HOME/.papercusp/live-fed-gate/triage}"
RIG_BANK_KEEP="${RIG_BANK_KEEP:-200}"
RIG_LOCAL_T0="$(date +%s 2>/dev/null || echo 0)"

# True iff a frame serve.log was already banked since this run started — the
# same mtime-marker idiom live-federation-gate.sh's _frame_lag_scan uses to scope
# banked files to a run.
_rig_local_run_already_banked() {
  local marker rc=1
  [ -d "$RIG_BANK_DIR" ] || return 1
  marker="$(mktemp -u 2>/dev/null || echo "/tmp/.local-matrix-bank-marker.$$")"
  touch -d "@$RIG_LOCAL_T0" "$marker" 2>/dev/null || return 1
  [ -n "$(find "$RIG_BANK_DIR" -maxdepth 1 -name 'serve-*.log' -newer "$marker" -print -quit 2>/dev/null)" ] && rc=0
  rm -f "$marker" 2>/dev/null
  return "$rc"
}

rig_local_bank_logs() {
  local mode="${PCUSP_LOCAL_RIG_BANK:-auto}" stamp inst cn f state first last banked=0
  case "$mode" in
    never) log "bank: skipped (PCUSP_LOCAL_RIG_BANK=never)"; return 0 ;;
    auto)  if _rig_local_run_already_banked; then
             log "bank: frame serve.logs for this run are already banked in $RIG_BANK_DIR (matrix banker) — not re-banking (PCUSP_LOCAL_RIG_BANK=always to force)"
             return 0
           fi ;;
  esac
  command -v docker >/dev/null 2>&1 || { log "bank: docker unavailable — nothing banked"; return 0; }
  mkdir -p "$RIG_BANK_DIR" 2>/dev/null || { log "bank: cannot mkdir $RIG_BANK_DIR — skipping (best-effort)"; return 0; }
  stamp="$(date +%H%M%S 2>/dev/null || echo now)-teardown"

  for inst in a b c; do
    case "$inst" in a) cn="${CN_A:-}" ;; b) cn="${CN_B:-}" ;; c) cn="${CN_C:-}" ;; esac
    [ -n "$cn" ] || continue
    # Never provisioned (the usual case for c on a 2-frame run), or already gone.
    state="$(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} started={{.State.StartedAt}}' "$cn" 2>/dev/null)" || state=""
    [ -n "$state" ] || continue
    f="$RIG_BANK_DIR/serve-$inst-$stamp.log"
    docker cp "$cn:/home/pcusp/serve.log" "$f" 2>/dev/null \
      || printf '(no /home/pcusp/serve.log could be copied out of container %s — the frame may never have started the sidecar)\n' "$cn" >"$f" 2>/dev/null
    [ -f "$f" ] || continue
    banked=$((banked + 1))
    # Same coverage-window + absent-subject-id caveats the ssh banker stamps
    # (EI-18687774064705397 / EI-18744109084137549) — a reader hits the identical
    # traps here, and a bank file that omits them is the one they read first.
    first="$(grep -m1 -oE '^\[[0-9TZ:.+-]+\]' "$f" 2>/dev/null || true)"
    last="$(grep -oE '^\[[0-9TZ:.+-]+\]' "$f" 2>/dev/null | tail -1 || true)"
    { printf '=== bank %s: frame %s (container %s) — banked by local-matrix.sh via `docker cp` AT TEARDOWN, i.e. this run reached destroy without the matrix banker running (pre-matrix failure, or the run was killed). Container state at bank time: %s. serve.log is CUMULATIVE for the whole rig session, NOT scoped to one scenario/run; this snapshot spans %s .. %s — check whether another bank file'"'"'s first timestamp matches before treating the two as independent runs. ⚠ This log format records NO scenario/subject ids for ANY scenario, so an id being ABSENT here is not evidence its operation never happened — confirm with a known-PASSING leg'"'"'s id from the same run before concluding anything from a miss. ===\n' \
        "$stamp" "$inst" "$cn" "$state" "${first:-?}" "${last:-?}"
      cat "$f"
    } >"$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f" || rm -f "$f.tmp" 2>/dev/null
  done

  # The gateway DHT's container log. A DHT bootstrap failure is one of the
  # pre-matrix failures above, and it is diagnosable ONLY from here — the frames'
  # serve.log shows a bootstrap timeout, never why. Deliberately NOT named
  # serve-*.log: it is not a frame, and the gate's frame scan must not count it.
  local dht_note=""
  if docker inspect "$NET-dht" >/dev/null 2>&1; then
    docker logs "$NET-dht" >"$RIG_BANK_DIR/dht-$stamp.log" 2>&1 && dht_note=" + the DHT container log" || true
    ( cd "$RIG_BANK_DIR" 2>/dev/null && ls -t dht-*.log 2>/dev/null \
        | tail -n "+$((RIG_BANK_KEEP + 1))" | xargs -r rm -f -- ) 2>/dev/null || true
  fi

  if [ "$banked" -gt 0 ]; then
    log "bank: $banked frame serve.log(s)$dht_note → $RIG_BANK_DIR (stamp=$stamp) before destroy"
  else
    log "bank: no rig containers existed at teardown — nothing to bank (expected for a run that failed before provisioning)"
  fi
  # Same bounded FIFO the lib applies, so a killed-run bank can never grow this
  # dir without limit. fail/<stamp>/ bundles are non-recursive-globbed away.
  ( cd "$RIG_BANK_DIR" 2>/dev/null && ls -t serve-*.log 2>/dev/null \
      | tail -n "+$((RIG_BANK_KEEP + 1))" | xargs -r rm -f -- ) 2>/dev/null || true
}

# ── teardown (also the EXIT-trap body) ────────────────────────────────────────
rig_local_teardown() {
  rig_local_bank_logs   # EI-18660101091813036 — evidence out BEFORE the destroy
  log "teardown: frames + DHT"
  docker rm -f "$CN_A" "$CN_B" "$CN_C" "$NET-dht" >/dev/null 2>&1 || true
  rig_disable_exclusive   # release the system.slice exclusive-core grant (scopes now gone)
  if [ -f "$STATE_FILE" ]; then
    local pid; pid="$(sed -n 's/^DHT_PID=//p' "$STATE_FILE" | head -1)"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true   # legacy host-pid DHT state
    rm -f "$STATE_FILE"
  fi
  docker network rm "$NET" >/dev/null 2>&1 || true
}
if [ "$MODE" = teardown ]; then rig_local_teardown; echo "torn down."; exit 0; fi

# ── gate-cycle advisory probe (EI-18723401175637819) ──────────────────────────
# THE GAP this closes: the rig lock above only covers the RIG. It does NOT cover
# HOST CORES — and rig_frame_exclusive() below escalates past mere affinity to a
# cgroup-v2 exclusive partition that genuinely EVICTS the host fleet off 16-24
# cores. live-federation-gate.sh runs a multi-phase cycle whose EARLIER phases
# (two-instance-content-matrix-smoke.sh) are HOST-SIDE and take a *different*
# lock ("${WORK}.flock"), reaching the rig lock only at its own local-matrix leg.
# So during those earlier phases the rig lock is legitimately FREE, a targeted
# `--only=...` run acquires it correctly (even with RIG_LOCK_WAIT_S=0), and the
# eviction then lands on a gate phase with no protection from it. `pgrep -f
# 'local-matrix.sh'` is no better: it is empty during exactly that window.
#
# The invariant to respect is "a host-wide core eviction is in effect", which is
# a DIFFERENT and much shorter-lived resource than "the rig" — so this must NOT
# be fixed by making the gate hold the rig lock for its whole ~30min cycle, which
# would starve every agent's targeted run for half of every hour (the gate's own
# §0z block warns about exactly that failure class, EI-18657324526667507).
#
# Instead: a NON-BLOCKING PROBE of the lock the gate ALREADY holds for its WHOLE
# cycle (/tmp/pcusp-live-fed-gate.lock — see live-federation-gate.sh §GATE_SINGLETON).
# Reuse, not a parallel lock; the exact inverse of the gate's own non-blocking rig
# probe. It takes and immediately releases, never holds, never queues, never fails
# the run. When a cycle IS in flight we WARN loudly with the holder and degrade
# THIS run to affinity-only, which costs the gate nothing and costs this run only
# some timing fidelity — the eviction, not the rig, was the harm.
#   PCUSP_RIG_EXCLUSIVE=<n>   set explicitly ⇒ honoured as-is (no auto-degrade)
#   PCUSP_RIG_GATE_PROBE=0    skip the probe entirely (pre-EI behaviour)
#
# ⚠ SELF-EXEMPTION (WI-6133) — the probe MUST NOT fire on the cycle that OWNS this
# run. live-federation-gate.sh holds this same lock for its WHOLE cycle and then
# invokes its local-matrix leg as a CHILD, so a naive probe detects its own parent,
# concludes "a cycle is in flight", and strips THE GATE'S OWN exclusive partition —
# leaving the gate's most timing-sensitive scenarios to run on a shared, heavily
# loaded box. That silently converts the gate into a false-red generator whose
# reds then get misattributed to whatever code change the run happened to carry
# (on 2026-07-26 this nearly caused a correct fix to be reverted).
# So: parse the holder pid (live-federation-gate.sh §GATE_SINGLETON writes
# `pid=$$` into $GATE_LOCK.holder) and skip the degrade when that pid is an
# ANCESTOR of this process. Ancestry is used rather than an env-var handshake
# because it is self-contained here, needs no cooperation from the gate, and
# covers arbitrarily nested spawns; an unparseable holder or a gate that somehow
# is NOT our ancestor still degrades, preserving the original EI's intent.
GATE_LOCK_PATH="${PCUSP_GATE_LOCK:-/tmp/pcusp-live-fed-gate.lock}"

# Echoes the holder's pid, or nothing when the holder line has no parseable pid.
rig_gate_holder_pid() {
  printf '%s' "${1:-}" | sed -n 's/.*[[:space:]]pid=\([0-9][0-9]*\).*/\1/p' | head -1
}

# 0 when $1 is THIS process or one of its ancestors ⇒ the in-flight cycle is our own.
# Walks PPIDs with a hard iteration cap so a pid-reuse cycle can never spin.
rig_pid_is_self_or_ancestor() {
  local target="${1:-}" p="$$" guard=0
  case "$target" in ''|*[!0-9]*) return 1 ;; esac
  while [ -n "$p" ] && [ "$p" != 0 ] && [ "$p" != 1 ] && [ "$guard" -lt 64 ]; do
    [ "$p" = "$target" ] && return 0
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d '[:space:]')"
    guard=$((guard + 1))
  done
  return 1
}

# Echoes the in-flight gate holder and returns 0 when a cycle is running; returns
# non-zero (silently) when idle, unprobeable, or flock is unavailable — an
# undetectable gate must never block or alter the run.
rig_gate_cycle_holder() {
  local gl="$GATE_LOCK_PATH"
  [ -f "$gl" ] || return 1                        # gate never ran here ⇒ nothing in flight
  command -v flock >/dev/null 2>&1 || return 1    # cannot probe ⇒ stay out of the way
  ( exec 8>>"$gl" || exit 0; flock -n 8 || exit 7; ) 2>/dev/null
  [ $? -eq 7 ] || return 1                        # took it (idle) / could not open ⇒ not in flight
  cat "$gl.holder" 2>/dev/null || echo 'unknown holder'
  return 0
}

GATE_CYCLE_HOLDER=""
if [ "${PCUSP_RIG_GATE_PROBE:-1}" = 1 ] && GATE_CYCLE_HOLDER="$(rig_gate_cycle_holder)"; then
  GATE_CYCLE_PID="$(rig_gate_holder_pid "$GATE_CYCLE_HOLDER")"
  if rig_pid_is_self_or_ancestor "$GATE_CYCLE_PID"; then
    # Our OWN cycle (WI-6133). Degrading here would strip the gate's exclusive
    # cores from the very run the gate launched to measure — never do that.
    log "gate-cycle probe: the in-flight cycle (pid=$GATE_CYCLE_PID) is THIS run's own ancestor — it launched us, so it is not a peer to yield to; keeping exclusive cores (WI-6133)"
    GATE_CYCLE_HOLDER=""
  else
  log "WARN: a live-federation-gate CYCLE IS IN FLIGHT — held by: $GATE_CYCLE_HOLDER"
  log "WARN: its host-side phases share this box's cores and take a DIFFERENT lock, so a free rig lock does NOT mean it is safe to evict cores (EI-18723401175637819)"
  if [ -z "${PCUSP_RIG_EXCLUSIVE+set}" ]; then
    RIG_EXCLUSIVE=0
    log "WARN: degrading this run to AFFINITY-ONLY (no cgroup-v2 exclusive partition; host fleet NOT evicted) so the in-flight cycle is not starved — PCUSP_RIG_EXCLUSIVE=1 forces exclusive cores anyway, PCUSP_RIG_GATE_PROBE=0 skips this probe"
  else
    log "WARN: PCUSP_RIG_EXCLUSIVE=$PCUSP_RIG_EXCLUSIVE set explicitly — honouring it; exclusive cores WILL evict the host fleet off that gate cycle's phases"
  fi
  fi
fi

command -v docker >/dev/null || { echo "FATAL: docker not found — the containerized rig needs it" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "FATAL: docker daemon unreachable (is the caller in the docker group?)" >&2; exit 1; }

# ── firewall preflight (frames→gateway DHT leg; found live 2026-07-03 P-004) ──
# The frames reach the host DHT node on the bridge GATEWAY ip. An active ufw
# with no allow-rule for the rig subnet silently drops exactly that leg (ssh +
# docker still work, so the miss surfaces much later as DHT bootstrap
# timeouts). Check it NOW instead of leaving it to the header comment.
if command -v ufw >/dev/null; then
  UFW_STATUS="$(sudo -n ufw status 2>/dev/null || true)"
  if printf '%s' "$UFW_STATUS" | grep -q '^Status: active'; then
    if ! printf '%s' "$UFW_STATUS" | grep -qF "$SUBNET"; then
      echo "FATAL: ufw is ACTIVE with no allow-rule for the rig subnet $SUBNET — the frames→gateway DHT leg will be dropped. Fix once:" >&2
      echo "  sudo ufw allow from $SUBNET comment 'papercusp local-rig frames'" >&2
      exit 1
    fi
  elif [ -z "$UFW_STATUS" ] && systemctl is-active --quiet ufw 2>/dev/null; then
    log "WARN: ufw service is active but passwordless sudo is unavailable — cannot verify an allow-rule for $SUBNET; if DHT bootstrap times out later, run: sudo ufw allow from $SUBNET"
  fi
fi

# ── host preconditions: validate the whole CLASS before anything expensive ────
# EI-20578660332729593. Three separate host-side inputs have each, in turn, been
# discovered missing only AT THEIR POINT OF USE — every time after this script had
# already built the frame image, provisioned containers, and promoted a cgroup-v2
# exclusive partition (24 cores evicted off the host fleet):
#   • the sidecar node binary — checked at the DHT start, ~130 lines below
#   • the .deb                — resolved inside deb-hetzner-matrix.sh, post-exec
#   • a frame's gh token      — rig_set_identity (lib/deb-hetzner-rig.sh:683),
#                               which runs only once the matrix is already going
# Each of the first two was previously patched with its own bespoke earlier check.
# This is deliberately NOT a fourth point-fix: the recurring defect is not any one
# missing input, it is the CLASS — "a cheap, side-effect-free host-side
# precondition is discovered late, after the expensive and destructive steps".
# Anything the run will need that can be checked with no side effects belongs
# HERE, not at its point of use.
#
# ORDERING CONTRACT: this must stay ABOVE the first state-creating step — the ssh
# keypair, docker network, frame image build, provisioning and core eviction all
# follow it. Modes that provision nothing never reach it (--list execs above,
# --teardown exits above). federation-asserts.selftest.sh asserts that ordering
# by line number, so moving this below provisioning fails the selftest rather
# than silently restoring the bug.
preflight_host_preconditions() {
  local missing=0 u seen="" tok actual_login dht_reused=0 common_sh deb_out deb_rc
  local sidecar_node="$DESKTOP_DIR/src-tauri/sidecar/bin/node"

  # (1) sidecar node binary — needed to start the containerized testnet DHT. A
  #     --reuse run that finds its DHT container already up never starts one, so
  #     mirror exactly that condition rather than over-requiring the binary.
  if [ "$REUSE" = 1 ] && [ -f "$STATE_FILE" ] \
     && [ -n "$(docker ps -q -f "name=^${NET}-dht\$" 2>/dev/null)" ]; then
    dht_reused=1
  fi
  if [ "$dht_reused" = 0 ] && [ ! -x "$sidecar_node" ]; then
    echo "FATAL(preflight): sidecar node binary missing at $sidecar_node" >&2
    echo "  build it once: bin/build-desktop-sidecar.sh" >&2
    missing=$((missing + 1))
  fi

  # (2) the .deb the frames install. An explicit --deb= is the caller's own
  #     choice and only has to EXIST (default_deb's staleness guard deliberately
  #     does not apply to it). An implicit pick is resolved by default_deb(),
  #     which also enforces that staleness guard — run it HERE so its verdict
  #     lands before provisioning instead of after. The subshell is load-bearing:
  #     common.sh sets `set -euo pipefail` at top level and would otherwise leak
  #     those flags into this script.
  common_sh="$DESKTOP_DIR/scripts/linux-test-vm/lib/common.sh"
  if [ -n "$DEB" ]; then
    if [ ! -r "$DEB" ]; then
      echo "FATAL(preflight): --deb=$DEB is not a readable file" >&2
      missing=$((missing + 1))
    fi
  elif [ ! -r "$common_sh" ]; then
    echo "FATAL(preflight): cannot resolve the default .deb — $common_sh is unreadable" >&2
    missing=$((missing + 1))
  else
    deb_out="$(bash -c 'source "$1" >/dev/null 2>&1 || exit 97; default_deb' _ "$common_sh" 2>&1)" && deb_rc=0 || deb_rc=$?
    if [ "$deb_rc" = 97 ]; then
      echo "FATAL(preflight): could not source $common_sh to resolve the default .deb" >&2
      missing=$((missing + 1))
    elif [ "$deb_rc" != 0 ]; then
      echo "FATAL(preflight): no usable .deb — default_deb() refused (exit $deb_rc):" >&2
      printf '%s\n' "$deb_out" | sed 's/^/  | /' >&2
      missing=$((missing + 1))
    fi
  fi

  # (3) a gh token for EVERY identity this run will register. Each scenario calls
  #     rig_set_identity a "$P_A_USER" / b "$P_B_USER" (and c "$P_C_USER" on a
  #     3-frame run), and that helper aborts the run when a token is missing. The
  #     defaults below MUST match the ones those scripts use — the selftest
  #     asserts exactly that, so renaming a default there fails the guard instead
  #     of silently un-checking an identity here. Frames may legitimately share
  #     one gh user (a real multi-device topology), so dedupe before probing.
  if ! command -v gh >/dev/null 2>&1; then
    echo "FATAL(preflight): gh is not installed — no frame identity can be resolved" >&2
    missing=$((missing + 1))
  else
    local frame_users=("${P_A_USER:-papercupai}" "${P_B_USER:-ownerhandle}")
    if [ "$FRAMES" = 3 ]; then frame_users+=("${P_C_USER:-ownerhandle}"); fi
    for u in "${frame_users[@]}"; do
      case " $seen " in *" $u "*) continue ;; esac
      seen="$seen $u"
      tok="$(gh auth token --user "$u" 2>/dev/null || true)"
      if [ -z "$tok" ]; then
        echo "FATAL(preflight): no gh token for '$u' — rig_set_identity would abort this run mid-flight (lib/deb-hetzner-rig.sh:683)" >&2
        echo "  fix: gh auth login -h github.com   (verify with: gh auth token --user $u)" >&2
        missing=$((missing + 1))
      elif ! actual_login="$(GH_TOKEN="$tok" gh api user --jq .login 2>/dev/null)"; then
        echo "FATAL(preflight): gh token for '$u' cannot authenticate GitHub GET /user — refusing to provision frames that cannot join a Hive" >&2
        missing=$((missing + 1))
      elif [ -z "$actual_login" ]; then
        echo "FATAL(preflight): gh token for '$u' returned an empty GitHub identity — refusing to provision frames that cannot join a Hive" >&2
        missing=$((missing + 1))
      elif [[ "${actual_login,,}" != "${u,,}" ]]; then
        echo "FATAL(preflight): gh token requested for '$u' authenticates as '$actual_login' — refusing a wrong-account federation run" >&2
        missing=$((missing + 1))
      fi
    done
  fi

  if [ "$missing" != 0 ]; then
    echo "FATAL(preflight): $missing host precondition(s) unmet — refusing to build the frame image, provision containers or evict cores for a run that cannot reach a scenario (EI-20578660332729593)." >&2
    echo "  PCUSP_RIG_SKIP_PREFLIGHT=1 proceeds anyway — i.e. chooses to discover the miss after the cores are gone." >&2
    return 1
  fi
  log "preflight: host preconditions OK (sidecar node, .deb, authenticated gh identities)"
  return 0
}

if [ "${PCUSP_RIG_SKIP_PREFLIGHT:-0}" = 1 ]; then
  log "WARN: PCUSP_RIG_SKIP_PREFLIGHT=1 — host preconditions NOT checked; a missing one will now surface AFTER provisioning and core eviction"
else
  preflight_host_preconditions || exit 1
fi

# ── ssh keypair (the frames' root login — rig contract: ssh -i KEY root@ip) ──
if [ ! -f "$SSH_KEY" ]; then
  log "generate rig ssh key $SSH_KEY"
  mkdir -p "$(dirname "$SSH_KEY")"
  ssh-keygen -q -t ed25519 -N '' -C pcusp-local-rig -f "$SSH_KEY" || exit 1
fi

# ── network ───────────────────────────────────────────────────────────────────
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  log "create network $NET ($SUBNET gw $GW)"
  docker network create --subnet "$SUBNET" --gateway "$GW" "$NET" >/dev/null || exit 1
fi

# ── frame image (ubuntu-24.04 = the .deb's target ABI, EI-503; sshd + root key;
#    gh/psql/git/curl pre-baked = what rig_setup_frame installs anyway; webkit
#    best-effort pre-bake to cut the per-run apt download). git is REQUIRED by
#    the sidecar's pots/from-repo clone (clone_git_missing, found 2026-07-03
#    P-004 run #4 — Hetzner VMs shipped git; a bare ubuntu:24.04 image doesn't).
#    After editing this package list: docker rmi pcusp-local-frame:ubuntu24 so
#    the build-once cache rebuilds (rig_setup_frame's per-run apt also
#    self-heals a stale image, at per-run cost). ─────────────────────────────
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  log "build frame image $IMAGE_TAG (one-time)"
  bctx="$(mktemp -d /tmp/pcusp-frame-img.XXXXXX)"
  cp "$SSH_KEY.pub" "$bctx/authorized_keys"
  cat > "$bctx/Dockerfile" <<'DOCKEREOF'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      openssh-server ca-certificates curl gh git postgresql-client lsof \
 && apt-get install -y -qq libwebkit2gtk-4.1-0 xdg-utils || true
RUN mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh
COPY authorized_keys /root/.ssh/authorized_keys
RUN chmod 600 /root/.ssh/authorized_keys \
 && printf 'PermitRootLogin prohibit-password\nUseDNS no\n' > /etc/ssh/sshd_config.d/pcusp-rig.conf
CMD ["/usr/sbin/sshd","-D","-e"]
DOCKEREOF
  docker build -q -t "$IMAGE_TAG" "$bctx" >/dev/null || { echo "FATAL: frame image build failed" >&2; rm -rf "$bctx"; exit 1; }
  rm -rf "$bctx"
fi

frame_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }

# ── provision / reuse frames ─────────────────────────────────────────────────
REUSE_OK=1
frame_running "$CN_A" && frame_running "$CN_B" || REUSE_OK=0
[ "$FRAMES" = 3 ] && { frame_running "$CN_C" || REUSE_OK=0; }
if [ "$REUSE" = 1 ] && [ "$REUSE_OK" = 1 ]; then
  log "reuse running frames $CN_A@$IP_A $CN_B@$IP_B$( [ "$FRAMES" = 3 ] && echo " $CN_C@$IP_C" )"
else
  REUSE=0
  docker rm -f "$CN_A" "$CN_B" "$CN_C" >/dev/null 2>&1 || true
  log "provision $FRAMES frames $CN_A@$IP_A $CN_B@$IP_B$( [ "$FRAMES" = 3 ] && echo " $CN_C@$IP_C" )"
  # $CPU_ARGS_* / $MEM_ARGS word-split deliberately (frame CPU+memory reservation, defined above).
  docker run -d --name "$CN_A" --hostname rig-a --network "$NET" --ip "$IP_A" $CPU_ARGS_A $MEM_ARGS "$IMAGE_TAG" >/dev/null || exit 1
  docker run -d --name "$CN_B" --hostname rig-b --network "$NET" --ip "$IP_B" $CPU_ARGS_B $MEM_ARGS "$IMAGE_TAG" >/dev/null || exit 1
  if [ "$FRAMES" = 3 ]; then
    docker run -d --name "$CN_C" --hostname rig-c --network "$NET" --ip "$IP_C" $CPU_ARGS_C $MEM_ARGS "$IMAGE_TAG" >/dev/null || exit 1
  fi
fi

# ARM teardown now (frames exist). --keep-up / --reuse leave everything running.
#
# EI-18660101091813036: an EXIT trap alone does NOT run when bash is killed by a
# signal — a `timeout`, a gate leg budget or a ^C would tear the process down
# with the trap never firing, which both LEAKS the frames (and their exclusive
# core grant) and destroys their serve.log unbanked. Handling INT/TERM with a
# plain `exit` is the minimal fix: the handler returns through the normal exit
# path, so the EXIT trap above runs — banking, then destroying — and the
# conventional 128+signo status is preserved for the caller.
if [ "$KEEP_UP" = 1 ]; then :; else
  trap rig_local_teardown EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
fi

# Promote the reserved frame cores to genuine EXCLUSIVE cgroup-v2 partitions so
# the host fleet cannot starve them (D-003). Runs for both fresh + --reuse frames
# (idempotent), after the teardown trap so a partial setup is still released.
if rig_enable_exclusive; then
  rig_frame_exclusive "$CN_A" "$CPUSET_A"
  rig_frame_exclusive "$CN_B" "$CPUSET_B"
  [ "$FRAMES" = 3 ] && rig_frame_exclusive "$CN_C" "$CPUSET_C"
fi

# wait sshd
sshprobe() { ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o ConnectTimeout=5 "root@$1" true 2>/dev/null; }
RIG_IPS=("$IP_A" "$IP_B"); [ "$FRAMES" = 3 ] && RIG_IPS+=("$IP_C")
for ip in "${RIG_IPS[@]}"; do
  ok=0
  for i in $(seq 1 20); do sshprobe "$ip" && { ok=1; break; }; sleep 2; done
  [ "$ok" = 1 ] || { echo "FATAL: sshd on frame $ip never answered" >&2; exit 1; }
done
log "frames ssh-ready"

# ── testnet DHT: 3 nodes IN A CONTAINER on the rig bridge (WI-1910 root fix) ──
# A single-node testnet is broken-BY-CONSTRUCTION for discovery: dht-rpc never
# COMMITS announces to bootstrap nodes, so a 1-node "DHT" stores nothing and no
# peer can ever find another — every containerized-rig run failed peer_connect
# REGARDLESS of deb (WI-1910, root-caused by 85300, thread post 49998). A
# host-side multi-node testnet is also wrong: on a multi-homed host the
# non-bootstrap nodes advertise the LAN ip (192.168.x.x), unreachable from the
# frames (probe: /tmp/wi1910-audit/dht99x3.log). Fix: createTestnet(3,{host})
# INSIDE a container ON the rig bridge with a static ip — all three nodes bind
# + advertise that bridge ip, announces commit to the two storage nodes, and
# frames reach everything as same-bridge c2c traffic (no ufw INPUT dependency).
DHT_IP="${PCUSP_LOCAL_RIG_DHT_IP:-${GW%.*}.5}"
DHT_CN="$NET-dht"
SIDECAR_NODE="$DESKTOP_DIR/src-tauri/sidecar/bin/node"
BOOTSTRAP=""
if [ "$REUSE" = 1 ] && [ -f "$STATE_FILE" ]; then
  if [ -n "$(docker ps -q -f "name=^${DHT_CN}\$")" ]; then
    BOOTSTRAP="$(sed -n 's/^BOOTSTRAP=//p' "$STATE_FILE" | head -1)"
    log "reuse DHT container $DHT_CN bootstrap=$BOOTSTRAP"
  else
    # stale state (legacy host-pid DHT or dead container) — clean, fall through
    pid="$(sed -n 's/^DHT_PID=//p' "$STATE_FILE" | head -1)"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  fi
fi
if [ -z "$BOOTSTRAP" ]; then
  [ -x "$SIDECAR_NODE" ] || { echo "FATAL: sidecar node binary missing at $SIDECAR_NODE (build once: bin/build-desktop-sidecar.sh)" >&2; exit 1; }
  dhtjs="$(mktemp /tmp/pcusp-local-rig-dht.XXXXXX.cjs)"
  cat >"$dhtjs" <<'DHTJS'
const createTestnet = require('/opt/app/node_modules/hyperdht/testnet.js');
(async () => {
  const t = await createTestnet(3, { host: process.env.GW });
  console.log('BOOTSTRAP=' + t.bootstrap.map(b => b.host + ':' + b.port).join(','));
  for (const n of t.nodes) console.log('node: ' + n.host + ':' + n.port + ' ephemeral=' + n.ephemeral);
  process.stdin.resume();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
DHTJS
  log "start testnet DHT (3 nodes, containerized @ $DHT_IP — WI-1910 fix)"
  docker rm -f "$DHT_CN" >/dev/null 2>&1 || true
  docker run -d -i --name "$DHT_CN" --network "$NET" --ip "$DHT_IP" \
    -e GW="$DHT_IP" \
    -v "$ROOT":/opt/app:ro \
    -v "$SIDECAR_NODE":/usr/local/bin/pcusp-node:ro \
    -v "$dhtjs":/dht.cjs:ro \
    --entrypoint /usr/local/bin/pcusp-node \
    "$IMAGE_TAG" /dht.cjs >/dev/null || { echo "FATAL: DHT container failed to start" >&2; exit 1; }
  for i in $(seq 1 30); do
    BOOTSTRAP="$(docker logs "$DHT_CN" 2>/dev/null | sed -n 's/^BOOTSTRAP=//p' | head -1)"
    [ -n "$BOOTSTRAP" ] && break; sleep 1
  done
  [ -n "$BOOTSTRAP" ] || { echo "FATAL: containerized testnet DHT did not start:" >&2; docker logs "$DHT_CN" 2>&1 | tail -20 >&2; exit 1; }
  printf 'DHT_CONTAINER=%s\nBOOTSTRAP=%s\n' "$DHT_CN" "$BOOTSTRAP" > "$STATE_FILE"
  log "DHT up container=$DHT_CN bootstrap=$BOOTSTRAP"
fi

# ── ufw hint (frames → gateway DHT is INPUT-chain traffic on the bridge) ──────
if command -v ufw >/dev/null 2>&1 && sudo -n ufw status 2>/dev/null | grep -q 'Status: active'; then
  sudo -n ufw status 2>/dev/null | grep -q "${SUBNET%/*}" \
    || log "⚠ ufw is ACTIVE with no rule for $SUBNET — if scenarios stall on peer_connect: sudo ufw allow from $SUBNET"
fi

# ── run the matrix through the BYO-frames seam ────────────────────────────────
ARGS=()
[ -n "$DEB" ]  && ARGS+=("--deb=$DEB")
[ -n "$ONLY" ] && ARGS+=("--only=$ONLY")
[ "$KEEP_UP" = 1 ] && ARGS+=("--keep-up")
FRAME_IPS="$IP_A $IP_B"; [ "$FRAMES" = 3 ] && FRAME_IPS="$IP_A $IP_B $IP_C"
log "exec deb-hetzner-matrix.sh ${ARGS[*]:-} (BYO frames: $FRAME_IPS, home-harness-slug: $RIG_HOME_HARNESS_SLUG)"
RIG_FRAME_IPS="$FRAME_IPS" \
RIG_DHT_BOOTSTRAP="$BOOTSTRAP" \
RIG_SSH_IDENTITY="$SSH_KEY" \
RIG_HOME_HARNESS_SLUG="$RIG_HOME_HARNESS_SLUG" \
bash "$DESKTOP_DIR/bin/deb-hetzner-matrix.sh" ${ARGS[@]+"${ARGS[@]}"}
rc=$?
[ "$KEEP_UP" = 1 ] && log "--keep-up: frames + DHT left running (re-enter with --reuse; destroy with --teardown)"
exit $rc
