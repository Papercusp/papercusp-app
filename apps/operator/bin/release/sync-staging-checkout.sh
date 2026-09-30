#!/usr/bin/env bash
# sync-staging-checkout.sh — isolated-staging-tier-2026-06-21 (su, session e24ec9b4).
#
# Auto-advances the ISOLATED staging checkout ($PAPERCUSP_STAGING_ROOT) to the
# latest COMMITTED `staging` HEAD and restarts the :3170 operator — ONLY when the
# branch actually moved. This is what makes :3170 a clean, always-current staging
# tier (vs today's second-snapshot-of-the-live-working-tree behaviour).
#
# Reuses the release system's standalone setup-release-checkout.sh (worktree +
# git-archive submodules + hardlinked node_modules + SPA build) — no parallel
# checkout machinery. Driven by papercup-staging-sync.timer (systemd --user).
#
# Fail-safe by construction:
#   - HEAD-moved gate: no move → no rebuild, no restart (cheap no-op).
#   - relevance gate (WI-5710): the branch moving is NOT the same thing as the
#     RUNNING process's code changing — skip the restart when every changed
#     path is provably not server code.
#   - live-session deferral (WI-5710): don't cut a live :3170 session's legs
#     out from under it just because the timer ticked; wait for it to go idle,
#     bounded by a staleness ceiling.
#   - flock: never overlaps itself or a manual run.
#   - setup-release-checkout.sh aborts NON-ZERO (workspace-resolution gate /
#     SPA-build failure) BEFORE any restart, so a bad staging commit can never
#     cut :3170 over to a tree that would crash-loop — the previous good
#     checkout keeps serving.
#   - post-restart source readiness is verified with a bounded wall-clock
#     budget, long enough for request-only startup migrations but never an
#     unbounded wait.
#
# Reverse the whole tier: stop+disable papercup-staging-sync.timer, delete the
# 50-staging-checkout.conf drop-in, daemon-reload, restart papercusp-staging-api.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sync-staging-checkout.sh

Advance the isolated staging checkout to the committed staging HEAD and,
when needed, request a coordinated :3170 restart.

Options:
  -h, --help  Show this help and exit without inspecting or mutating staging.

Configuration is supplied through the PAPERCUSP_* environment variables used
by the staging sync timer; this command accepts no positional arguments.

PAPERCUSP_STAGING_SYNC_READINESS_TIMEOUT_SEC controls the bounded health
readiness wait after a coordinated restart (default: 300 seconds).
USAGE
}

# Parse arguments before any repository, service, network, or lock inspection.
# This script is also used for usage discovery, so --help must be a genuinely
# side-effect-free operation rather than an argument that falls through into
# the live sync workflow.
if [ "$#" -gt 0 ]; then
  case "$1" in
    -h|--help)
      if [ "$#" -ne 1 ]; then
        printf 'sync-staging-checkout.sh: --help does not accept additional arguments\n' >&2
        usage >&2
        exit 2
      fi
      usage
      exit 0
      ;;
    *)
      printf 'sync-staging-checkout.sh: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
fi

# Default to the checkout this script actually lives in — never one box's path
# (WI-4419: a hardcoded /home/<user>/… default is wrong on every other machine
# AND ships the owner's identity inside the release source drop).
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_REPO_DEFAULT="$(git -C "$_HERE" rev-parse --show-toplevel 2>/dev/null || (cd "$_HERE/../../../.." && pwd))"
INTEGRATION_ROOT="${PAPERCUSP_INTEGRATION_ROOT:-$_REPO_DEFAULT}"
STAGING_ROOT="${PAPERCUSP_STAGING_ROOT:-$(dirname "$INTEGRATION_ROOT")/papercusp-staging}"
UNIT="${PAPERCUSP_STAGING_UNIT:-papercusp-staging-api.service}"
HEALTH_URL="${PAPERCUSP_STAGING_HEALTH_URL:-http://127.0.0.1:3170/api/health}"
BRANCH="${PAPERCUSP_INTEGRATION_BRANCH:-staging}"
STAGING_BUNDLE_SCRIPT="${PAPERCUSP_STAGING_BUNDLE_SCRIPT:-$STAGING_ROOT/apps/operator/bin/bundle-host.sh}"

# WI-5710. The port we watch for live client connections — derived from
# HEALTH_URL so the two can never disagree, overridable for tests.
STAGING_PORT="${PAPERCUSP_STAGING_PORT:-$(printf '%s' "$HEALTH_URL" | sed -n 's#.*://[^:/]*:\([0-9]\{1,\}\).*#\1#p')}"
[ -n "$STAGING_PORT" ] || STAGING_PORT=3170
# How stale the code :3170 serves may get while we wait for a live session to
# finish. Past this, the restart lands even with clients attached — a deferral
# is a courtesy, never an indefinite freeze.
MAX_STALE_SEC="${PAPERCUSP_STAGING_SYNC_MAX_STALE_SEC:-1800}"

log() { echo "[staging-sync] $(date -Is) $*"; }

# A migration is applied during the next host boot, before :3170 can bind. Run
# the same source lints against the checkout we are about to serve while the old
# process is still alive. In particular, forward-compat catches an unacknowledged
# index change that the host's per-file preapply guard would otherwise discover
# only after the coordinated restart stopped the old process.
preflight_staging_migrations() {
  log "checking staging migration safety before restarting $UNIT"
  if ! (
    cd "$STAGING_ROOT" &&
    node scripts/lint-migrations.mjs &&
    node scripts/check-migration-forward-compat.mjs
  ); then
    log "FATAL: staging migration lint failed; keeping the current $UNIT process"
    return 1
  fi
}

# Complete the pinned target's migrations while the old API is still serving.
# Reuse the guarded boot/candidate runner: a backup-held rendezvous waits HERE,
# not after systemd has stopped the healthy process. A backup beginning after
# this returns is safe too: boot sees the applied target set and takes its
# existing no-pending path without applying new files outside the rendezvous.
prepare_staging_schema() {
  log "preparing the target schema while the current $UNIT process keeps serving"
  if ! (
    cd "$STAGING_ROOT" &&
    PAPERCUSP_INTEGRATION_ROOT="$STAGING_ROOT" \
      TSX_TSCONFIG_PATH="$STAGING_ROOT/apps/operator/tsconfig.json" \
      node --import tsx --input-type=module - <<'JS'
import { resolve } from 'node:path';
import { applyPendingMigrationsNow } from './packages/operator-core/lib/db-boot-migrate.ts';
  try {
    const result = await applyPendingMigrationsNow({
      sqlDir: resolve('libs/papercusp/libs/db/sql'),
      broadcast: false,
    });
    if (!result || result.failed.length > 0) {
      console.error('[staging-sync] target schema preparation failed:', JSON.stringify(result));
      process.exit(1);
    }
    console.log('[staging-sync] target schema prepared:', JSON.stringify(result));
    process.exit(0);
  } catch (error) {
    console.error('[staging-sync] target schema preparation failed:', error);
    process.exit(1);
  }
JS
  ); then
    log "FATAL: staging schema preparation failed; keeping the current $UNIT process"
    return 1
  fi
}

# Request-only hono-host startup applies pending migrations before binding :3170.
# A migration can therefore keep the port unbound for several minutes even
# though the coordinated restart succeeded. Keep the readiness wait generous
# enough for that expected boot work, but validate it as a finite positive
# integer so a bad timer environment cannot create an accidental endless loop.
normalize_staging_readiness_timeout_sec() {
  local requested="${1:-}"
  case "$requested" in
    ''|*[!0-9]*) return 1 ;;
  esac
  requested=$((10#$requested))
  [ "$requested" -gt 0 ] || return 1
  printf '%s\n' "$requested"
}

READINESS_TIMEOUT_SEC="$(normalize_staging_readiness_timeout_sec "${PAPERCUSP_STAGING_SYNC_READINESS_TIMEOUT_SEC:-300}")" || {
  log "FATAL: invalid PAPERCUSP_STAGING_SYNC_READINESS_TIMEOUT_SEC; expected a positive integer number of seconds"
  exit 1
}

# EI-19457080109574347 (2026-08-22 recurrence): the shared apps/operator/.env.local
# deliberately carries an off-loopback bind for other operator roles. A staging ExecStart
# sourced that file without overriding the bind, then P-016's correct fail-fast auth policy
# crash-looped :3170. The old process had been healthy; the sync restart created the outage.
#
# Prove the EFFECTIVE command has an explicit final loopback assignment after any .env.local
# source. Checking for the token anywhere is insufficient: an assignment before the source is
# overwritten by the file, and an earlier loopback assignment can be superseded later.
staging_exec_forces_loopback() {
  local exec_start="${1:-}" launch_tail last_bind
  launch_tail="$exec_start"
  if [[ "$exec_start" == *".env.local"* ]]; then
    launch_tail="${exec_start##*.env.local}"
  fi
  last_bind="$(printf '%s\n' "$launch_tail" | grep -oE 'PAPERCUSP_BIND_HOST=[^ ;}]+' | tail -n 1 || true)"
  [ "$last_bind" = "PAPERCUSP_BIND_HOST=127.0.0.1" ]
}

assert_staging_unit_loopback() {
  local exec_start
  if ! exec_start="$(systemctl --user show -p ExecStart --value "$UNIT" 2>/dev/null)"; then
    log "FATAL: refusing staging sync — cannot read $UNIT ExecStart, so the launch bind policy is unverified"
    return 1
  fi
  if staging_exec_forces_loopback "$exec_start"; then
    return 0
  fi
  log "FATAL: refusing staging sync/restart — $UNIT ExecStart does not force PAPERCUSP_BIND_HOST=127.0.0.1 after sourcing .env.local. Repair the unit/drop-in first; otherwise a shared off-loopback bind can crash-loop :3170 under the strict remote-auth boot guard."
  return 1
}

# EI-22636310973765418: the checkout advanced by this service and the checkout
# executed by :3170 must be the SAME tree. On 2026-09-07 both effective
# drop-ins pointed at the canonical shared tree while this script updated the
# isolated papercusp-staging tree; builds and restarts therefore described
# different source. Fail before touching either tree when that contract drifts.
staging_exec_pre_uses_bundle() {
  local exec_pre="${1:-}" expected_workdir="${2:-}" required_prefix
  # systemctl show reports the EFFECTIVE executable in path=, which is flock
  # after the bundle-time checkout lock was added. Pin the complete argv prefix:
  # the same shared lock and the same isolated bundle script must both survive.
  required_prefix="{ path=/usr/bin/flock ; argv[]=/usr/bin/flock -s /tmp/papercup-staging-sync.lock $expected_workdir/bin/bundle-host.sh ; "
  [[ "$exec_pre" == "$required_prefix"* ]]
}

assert_staging_unit_checkout() {
  local expected_root expected_workdir working_dir integration_env exec_pre reuse_env
  expected_root="$(realpath -m "$STAGING_ROOT")"
  expected_workdir="$expected_root/apps/operator"
  working_dir="$(systemctl --user show -p WorkingDirectory --value "$UNIT" 2>/dev/null || true)"
  working_dir="${working_dir#\!}"
  integration_env="$(systemctl --user show -p Environment --value "$UNIT" 2>/dev/null || true)"
  exec_pre="$(systemctl --user show -p ExecStartPre --value "$UNIT" 2>/dev/null || true)"
  reuse_env="PAPERCUSP_BUNDLE_REUSE_FRESH=1"
  if [[ -z "$working_dir" || "$(realpath -m "$working_dir")" != "$expected_workdir" ]]; then
    log "FATAL: $UNIT WorkingDirectory does not resolve to $expected_workdir (got ${working_dir:-<empty>}); refusing to build one checkout and restart another"
    return 1
  fi
  if [[ " $integration_env " != *" PAPERCUSP_INTEGRATION_ROOT=$expected_root "* ]]; then
    log "FATAL: $UNIT PAPERCUSP_INTEGRATION_ROOT does not name $expected_root; refusing cross-checkout staging sync"
    return 1
  fi
  if ! staging_exec_pre_uses_bundle "$exec_pre" "$expected_workdir"; then
    log "FATAL: $UNIT ExecStartPre must take the shared staging-sync lock and build from $expected_workdir/bin/bundle-host.sh"
    return 1
  fi
  if [[ " $integration_env " != *" $reuse_env "* ]]; then
    log "FATAL: $UNIT does not enable $reuse_env; a prebuilt bundle would be rebuilt only after stop"
    return 1
  fi
}

# Return the exact short source SHA baked into the running bundle. A 200 alone
# is not freshness: before this fix :3170 returned 200 from 6370b7fa98 while
# the isolated checkout had advanced far beyond it.
staging_health_source_sha() {
  curl -fsS --max-time 4 "$HEALTH_URL" 2>/dev/null | node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        const sha = JSON.parse(body)?.sha;
        if (typeof sha === "string" && /^[a-f0-9]{7,40}$/.test(sha)) process.stdout.write(sha);
        else process.exitCode = 1;
      } catch { process.exitCode = 1; }
    });
  '
}

health_sha_matches_target() {
  local health_sha="${1:-}" target_sha="${2:-}"
  [[ -n "$health_sha" && -n "$target_sha" && "$target_sha" == "$health_sha"* ]]
}

# A self-targeted :3170 restart can close the HTTP stream before ptool receives
# dev:restart's terminal receipt. Treat it as complete only when systemd's
# MainPID changed and the new listener reports the exact requested source SHA.
staging_restart_is_observed() {
  local before_pid="${1:-}" current_pid="${2:-}" health_sha="${3:-}" target_sha="${4:-}"
  case "$current_pid" in
    ''|0|*[!0-9]*) return 1 ;;
  esac
  if [ -n "$before_pid" ] && [ "$before_pid" != "0" ] && [ "$current_pid" = "$before_pid" ]; then
    return 1
  fi
  health_sha_matches_target "$health_sha" "$target_sha"
}

staging_sync_process_running() {
  local process_state
  process_state="$(ps -o stat= -p "$1" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$process_state" ] && [[ "$process_state" != Z* ]]
}

# --- WI-5710 gate 1: is a process restart actually REQUIRED? ----------------
#
# The original script gated everything on `target != current`, i.e. it used
# "the branch moved" as a proxy for "the code the running process holds
# changed". Under a fleet where git-sync auto-commits the whole tree every few
# minutes, that proxy decoupled from what it proxies.
#
# The SPA needs no restart at all: apps/operator/bin/host-spa.ts serves the
# dist FROM DISK PER REQUEST (existsSync + serveFile per asset; index.html read
# per request with cache-control:no-store), so once setup-release-checkout.sh
# --build-spa has run, the new SPA is already live. Restarting for an SPA-only
# commit is pure downtime.
#
# FAIL-SAFE DIRECTION, and never invert it: a restart is required UNLESS
# *every* changed path matches the conservative allowlist below. An unknown or
# newly-introduced path shape falls through to a restart — today's behaviour.
# The inverse ("skip unless known-server") would mean a new server directory
# silently stops being picked up, which is a far worse failure than an extra
# restart.
path_needs_no_restart() {
  case "$1" in
    # SPA sources. apps/operator/app/** is compiled INTO the Vite bundle via
    # vite.config.ts's `@` → operator-root alias; verified tree-wide that no
    # server module imports from it.
    apps/operator-vite/src/*) return 0 ;;
    apps/operator/app/*) return 0 ;;
    # The Tauri desktop shell submodule. It EMBEDS the operator as a sidecar;
    # the :3170 server loads nothing from it, so its pointer bumps are inert here.
    papercusp-desktop) return 0 ;;
    # Prose: docs, plans, insights. Served from disk; never executed.
    *.md|*.mdx) return 0 ;;
    docs/*|*/docs/*) return 0 ;;
    # Tests never run inside the operator process.
    *.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) return 0 ;;
    */e2e/*|*/__tests__/*) return 0 ;;
  esac
  return 1
}

# Reads newline-separated changed paths on stdin.
# Exit 0 = a restart IS required (the fail-safe default, matching
# need_node_modules()'s "0 means the work is needed" convention in the sibling
# setup-release-checkout.sh). Exit 1 = every path is provably restart-exempt.
paths_require_restart() {
  local p seen=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    seen=1
    path_needs_no_restart "$p" || return 0
  done
  # An EMPTY path list means we could not establish what changed (a failed or
  # unavailable diff), not "nothing changed" — the caller no-ops on an
  # unmoved HEAD long before this. Fail safe: restart.
  [ "$seen" = 1 ] || return 0
  return 1
}

# --- WI-5710 gate 2: is anyone actually USING :3170 right now? --------------
#
# Long-lived SSE/sync connections from a live operator window show as
# ESTABLISHED inbound sockets on the staging port. Best-effort by design: any
# probe failure (no `ss`, no permission) reports 0 and falls through to the
# normal restart, matching this script's fail-soft contract everywhere else.
staging_live_client_count() {
  local port="${1:-$STAGING_PORT}" n
  n="$(ss -tn state established "( sport = :$port )" 2>/dev/null | tail -n +2 | grep -c . || true)"
  [ -n "$n" ] || n=0
  echo "$n"
}

# Read a dev:restart JSON result from stdin. Exit 0 only when the coordinated
# restart actually fired, was verified-coalesced with a recent peer restart, or
# returned the explicitly supported asynchronous staging-start state. The last
# case is still followed by this script's exact-source readiness loop below.
restart_result_is_accepted() {
  node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        const result = JSON.parse(body);
        const asyncStarting =
          result?.ok === true &&
          result?.restartScheduled === true &&
          result?.restartObserved === true &&
          result?.stagingReadiness?.ready === false &&
          result?.stagingReadiness?.outcome === "starting";
        process.exit(result?.ok === true && (result?.restarted === true || result?.coalesced === true || asyncStarting) ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  '
}

restart_result_is_pre_dispatch_refusal() {
  printf '%s' "${1:-}" | grep -Eiq 'authorization_denied|no-launch-record|restart_withheld'
}

# A scheduled restart can still be stopping the old process when dev:restart's
# observation window ends. This permits ONLY the bounded verification below,
# never a success verdict or another restart request.
restart_result_is_pending() {
  node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        const result = JSON.parse(body);
        process.exit(result?.target === "staging" &&
          result?.restartScheduled === true && result?.restartObserved === false &&
          result?.stagingReadiness?.outcome === "not-observed" &&
          result?.stagingReadiness?.activeState !== "failed" ? 0 : 1);
      } catch { process.exit(1); }
    });
  '
}

# True when a dev:restart refusal is a TRANSIENT git-sync coordination refusal
# (EI-22102474093310851). dev:restart derives these reasons with a stable prefix —
# `git_sync_collision_${kind}` and `git_sync_barrier_${reason}` (agent-tools/dev/
# restart.ts) — so match the PREFIX the code owns, never a hand-copied list of
# suffixes: the suffix vocabulary is a `.replace(/-/g,'_')` of an open enum and
# would drift silently the moment a new kind is added.
restart_refusal_is_transient_git_sync() {
  node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        const result = JSON.parse(body);
        const reason = typeof result?.reason === "string" ? result.reason : "";
        process.exit(/^git_sync_(collision|barrier)_/.test(reason) ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  '
}

# Seconds since the commit the staging checkout is CURRENTLY serving. Bounds
# the deferral: we only ever defer while the served code is still reasonably
# fresh. An unresolvable sha reports a huge age ⇒ forces the restart.
current_commit_age_sec() {
  local sha="$1" ct now
  [ -n "$sha" ] && [ "$sha" != none ] || { echo 999999; return 0; }
  ct="$(git -C "$INTEGRATION_ROOT" show -s --format=%ct "$sha" 2>/dev/null || echo '')"
  [ -n "$ct" ] || { echo 999999; return 0; }
  now="$(date +%s)"
  echo $(( now - ct ))
}

# Single-flight: a second timer tick (or a manual run) waits/skips rather than
# racing two setups on the same checkout. A release cut whose orchestrator is this
# checkout also holds the lock SHARED for its whole run (WI-10003515,
# release-cut-launch.ts wrapWithStagingSyncLock), so re-cloning submodules in place
# cannot delete scripts out from under an in-flight cut.
exec 9>"/tmp/papercup-staging-sync.lock"
if ! flock -n 9; then
  cut_note=""
  active_cuts="$(systemctl --user list-units --state=active --no-legend --plain 'papercup-release-cut*' 2>/dev/null | awk '{print $1}' | paste -sd, -)"
  if [[ -n "$active_cuts" ]]; then
    cut_note=" (release cut running: ${active_cuts} — it holds the lock shared until it exits)"
  fi
  log "staging-sync lock is held — another staging-sync, a staging restart, or a release cut${cut_note} — skipping this tick"
  exit 0
fi

[ -d "$INTEGRATION_ROOT/.git" ] || { log "FATAL: integration root not a git repo: $INTEGRATION_ROOT"; exit 1; }

# Fail BEFORE even the no-op/advance decision: a drifted launch command must be visible on the
# next timer tick, and it must never reach a restart that replaces a healthy old process with a
# predictably rejected off-loopback boot.
assert_staging_unit_loopback || exit 1
assert_staging_unit_checkout || exit 1

target="$(git -C "$INTEGRATION_ROOT" rev-parse --verify "${BRANCH}^{commit}")"
current="$(git -C "$STAGING_ROOT" rev-parse --verify HEAD 2>/dev/null || echo none)"
health_sha="$(staging_health_source_sha || true)"
served_sha="${health_sha:-$current}"
checkout_needs_advance=0

if [ "$target" = "$current" ]; then
  if health_sha_matches_target "$health_sha" "$target"; then
    log "staging checkout and running :3170 bundle already at ${target:0:10} — no-op"
    exit 0
  fi
  # A prior tick may have advanced the checkout before dev:restart was
  # refused/coalesced. Retrying from runtime SHA closes the old permanent
  # no-op: checkout equality alone cannot prove the process loaded that tree.
  log "staging checkout is at ${target:0:10}, but running :3170 reports ${health_sha:-no valid source SHA} — restart still required"
  changed_count=0
  restart_required=1
else
  checkout_needs_advance=1
  # WI-5710 gate 1 — decide BEFORE doing any work whether the running process
  # actually needs to be replaced, or only the on-disk SPA refreshed.
  changed_count="$(git -C "$INTEGRATION_ROOT" diff --name-only "$current" "$target" 2>/dev/null | grep -c . || true)"
  [ -n "$changed_count" ] || changed_count=0
  if [ "$current" = none ]; then
    log "fresh staging checkout — full sync + restart"
    restart_required=1
  elif git -C "$INTEGRATION_ROOT" diff --name-only "$current" "$target" 2>/dev/null | paths_require_restart; then
    restart_required=1
  else
    restart_required=0
  fi
fi

# WI-5710 gate 2 — a restart IS required, but someone is using :3170 right now.
# Defer the ENTIRE sync (not just the restart): advancing the checkout while
# holding the old process would serve a NEW SPA against an OLD server, and that
# skew is worse than a few minutes of staleness. Keeping the whole checkout
# pinned leaves the live session on a fully consistent build until it goes idle.
if [ "$restart_required" = 1 ]; then
  live_clients="$(staging_live_client_count "$STAGING_PORT")"
  if [ "$live_clients" -gt 0 ] 2>/dev/null; then
    age="$(current_commit_age_sec "$served_sha")"
    if [ "$age" -lt "$MAX_STALE_SEC" ] 2>/dev/null; then
      log "deferring sync — $live_clients live client connection(s) on :$STAGING_PORT and the served build is only ${age}s old (< ${MAX_STALE_SEC}s ceiling); staying on ${current:0:8} so the live session keeps a consistent build. Will advance to ${target:0:8} once idle, or at the ceiling."
      exit 0
    fi
    log "staleness ceiling reached (${age}s ≥ ${MAX_STALE_SEC}s) — advancing despite $live_clients live client connection(s) on :$STAGING_PORT"
  fi
fi

# EI-21461712128132271: the timer used to bypass the platform's coordinated
# restart seam with a raw `systemctl restart`. On 2026-08-25 it crossed the
# staleness ceiling with nine live :3170 clients, then cut a Personal Vault
# acceptance probe into a 27-second connection-refused window. The ceiling is
# still required (otherwise persistent SSE clients can pin staging forever),
# but the restart itself must drain resource users, coalesce with peer
# restarts, and write the ordinary restart audit. Fail BEFORE advancing the
# checkout when that mechanism is unavailable; serving a new SPA from disk
# against an old in-memory server is worse than staying wholly stale.
PTOOL_BIN="${PAPERCUSP_PTOOL_BIN:-$(command -v ptool || true)}"
if [ "$restart_required" = 1 ] && [ -z "$PTOOL_BIN" ]; then
  log "FATAL: refusing staging sync — ptool is unavailable, so the coordinated dev:restart seam cannot run"
  exit 1
fi

if [ "$checkout_needs_advance" = 1 ]; then
  log "advancing staging checkout ${current:0:8} → ${target:0:8} (${changed_count} changed path(s), restart_required=${restart_required})"
  PAPERCUSP_INTEGRATION_ROOT="$INTEGRATION_ROOT" PAPERCUSP_RELEASE_ROOT="$STAGING_ROOT" \
    bash "$INTEGRATION_ROOT/apps/operator/scripts/systemd/papercusp-script-snapshot.sh" \
      "$INTEGRATION_ROOT/apps/operator/bin/release/setup-release-checkout.sh" \
      --ref "$BRANCH" --release "$STAGING_ROOT" --node-modules auto --build-spa
else
  log "isolated checkout already at ${target:0:10}; repairing only the stale running generation"
fi

# WI-5710 — SPA-only advance: the dist is now refreshed on disk and host-spa.ts
# serves it per request, so :3170 is ALREADY current. Restarting here would be
# a ~10-13s outage for zero freshness gain.
if [ "$restart_required" = 0 ]; then
  log "✅ skipping restart — all ${changed_count} changed path(s) are restart-exempt (SPA/docs/tests); the rebuilt SPA is already live on :$STAGING_PORT at ${target:0:8}"
  exit 0
fi

# The checkout and its submodules are complete. Downgrade the single-flight
# lock to shared before any host bundle read: :3170's ExecStartPre takes a
# shared lock on this same file, so a peer restart cannot bundle a half-cloned
# submodule while setup-release-checkout holds the exclusive lock. Keep our
# shared lock through prebuild/restart so another sync still cannot mutate it.
flock -s 9

preflight_staging_migrations

# Build the expensive host graph while the old process is still serving.
# The staging-only freshness proof lets systemd's later ExecStartPre verify
# and reuse these exact bytes in milliseconds; any source/output drift falls
# back to the ordinary full rebuild before start.
if [[ ! -f "$STAGING_BUNDLE_SCRIPT" ]]; then
  log "FATAL: staging bundle script not found at $STAGING_BUNDLE_SCRIPT"
  exit 1
fi
log "prebuilding proof-bound host bundle before stopping $UNIT"
PAPERCUSP_BUNDLE_REUSE_FRESH=1 bash "$STAGING_BUNDLE_SCRIPT"

prepare_staging_schema

# EI-13221: skip a REDUNDANT restart when $UNIT's current MainPID already came
# up within the last RECENT_RESTART_GRACE_SEC — most likely a peer's `dev:restart`
# (or a previous sync tick) cycled it moments ago, already serving fresh-enough
# code. Restarting again here would just double the ~10-13s connection-refused
# outage window for zero freshness benefit (the checkout we just fast-forwarded
# stays on disk and is picked up by whichever restart — ours next tick, or
# anyone else's dev:restart — actually fires next). Best-effort: any probe
# failure (no systemd, no live MainPID, etc.) falls through to the normal
# restart, matching probeServiceStart's own fail-soft contract
# (systemd-service-probe.ts) that this mirrors for a bash caller.
RECENT_RESTART_GRACE_SEC="${PAPERCUSP_STAGING_SYNC_RESTART_GRACE_SEC:-45}"
main_pid="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
seconds_since_start=""
if [ -n "$main_pid" ] && [ "$main_pid" -gt 0 ] 2>/dev/null; then
  seconds_since_start="$(ps -o etimes= -p "$main_pid" 2>/dev/null | tr -d ' ')"
fi
if [ -n "$seconds_since_start" ] && [ "$seconds_since_start" -lt "$RECENT_RESTART_GRACE_SEC" ] 2>/dev/null; then
  log "skipping restart — $UNIT's MainPID ($main_pid) already started ${seconds_since_start}s ago (< ${RECENT_RESTART_GRACE_SEC}s grace) — a peer restart likely already landed; the fast-forwarded checkout will be picked up by that or the next tick"
  exit 0
fi

# EI-22102474093310851: WAIT for the git-sync barrier instead of one-shotting it.
# dev:restart's own guidance: "git-sync fires hold the barrier only ~5-10s, so a
# short drain usually succeeds where a one-shot attempt always fails" — and a
# one-shot is exactly what this call used to be, which is why 13 of this timer's
# runs in 24h died on git_sync_barrier_/git_sync_collision_ refusals (ZERO of them
# a build error, despite the filed title). Bounded well under both the tool's
# The currently deployed staging operator (build 6e898b6cf8, observed
# 2026-09-04) accepts at most 45s for this argument, while newer source may
# advertise a larger ceiling. Keep this automated caller within the smallest
# live schema so a stale staging operator cannot reject the sync before it
# restarts itself. User overrides are clamped to the compatibility ceiling.
normalize_git_sync_drain_sec() {
  local requested="${1:-45}"
  case "$requested" in
    ''|*[!0-9]*) return 1 ;;
  esac
  requested=$((10#$requested))
  if [ "$requested" -gt 45 ]; then
    requested=45
  fi
  printf '%s\n' "$requested"
}

GIT_SYNC_DRAIN_SEC="$(normalize_git_sync_drain_sec "${PAPERCUSP_STAGING_SYNC_GIT_SYNC_DRAIN_SEC:-45}")" || {
  log "FATAL: invalid PAPERCUSP_STAGING_SYNC_GIT_SYNC_DRAIN_SEC; expected a non-negative integer"
  exit 1
}

# The systemd oneshot has no psu launch record. ptool otherwise falls back to
# su-loopback, which the identity kernel cannot authorize for dev:restart.
# Reuse the installer's persistent machine client identity for this first-party
# service; preserve a real session SID when one was explicitly supplied.
resolve_ptool_client_sid() {
  if [ -n "${PAPERCUSP_SID:-}" ]; then
    printf '%s\n' "$PAPERCUSP_SID"
    return 0
  fi
  [ -n "${HOME:-}" ] || return 1
  local identity_file="$HOME/.papercusp/su-agent-id" machine_sid
  [ -f "$identity_file" ] && [ -r "$identity_file" ] || return 1
  machine_sid="$(<"$identity_file")"
  [[ "$machine_sid" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || return 1
  printf '%s\n' "$machine_sid"
}

PTOOL_CLIENT_SID="$(resolve_ptool_client_sid)" || {
  log "FATAL: coordinated dev:restart requires PAPERCUSP_SID or the installer's valid machine identity at \$HOME/.papercusp/su-agent-id"
  exit 1
}

# The ptool result may be lost when this request restarts its own :3170 server.
log "requesting coordinated restart of $UNIT via dev:restart (git_sync_drain_sec=${GIT_SYNC_DRAIN_SEC})"
restart_result_file="$(mktemp)"
restart_diagnostics_file="$(mktemp)"
restart_tool_timeout_sec=350
restart_tool_started_at="$(date +%s)"
restart_tool_status=0
restart_verified=0
restart_pending=0
# The default ptool endpoint is the older background operator (:9071),
# whose identity kernel may not yet admit the installer's machine client.
# The staging operator owns this target and accepts that same static client.
# Run ptool in the background so this service can observe :3170 restarting. The
# handler restarts the server that owns its HTTP stream, so a lost receipt is
# resolved by MainPID + exact-source proof instead of waiting out ptool's 345s
# client deadline or retrying the mutation.
(
  cd "$INTEGRATION_ROOT"
  exec env PAPERCUSP_SID="$PTOOL_CLIENT_SID" "$PTOOL_BIN" dev:restart --url="http://127.0.0.1:${STAGING_PORT}" --json -
) >"$restart_result_file" 2>"$restart_diagnostics_file" <<JSON &
{"target":"staging","confirm":true,"authorize":true,"git_sync_drain_sec":${GIT_SYNC_DRAIN_SEC},"reason":"staging-sync advanced ${current:0:8} to ${target:0:8}"}
JSON
restart_tool_pid=$!

while staging_sync_process_running "$restart_tool_pid"; do
  observed_main_pid="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
  observed_health_sha="$(staging_health_source_sha || true)"
  if staging_restart_is_observed "$main_pid" "$observed_main_pid" "$observed_health_sha" "$target"; then
    # Give the CLI a short chance to flush a normal receipt before closing the
    # stale client stream. The exact PID + SHA pair is the independent proof.
    sleep 2
    if staging_sync_process_running "$restart_tool_pid"; then
      restart_verified=1
      log "dev:restart stream stayed open after :$STAGING_PORT restarted; MainPID $observed_main_pid serves exact source $observed_health_sha, so terminating only the ptool client"
      kill -TERM "$restart_tool_pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$restart_tool_pid" 2>/dev/null || true
      break
    fi
  fi

  restart_tool_elapsed_sec=$(( $(date +%s) - restart_tool_started_at ))
  if [ "$restart_tool_elapsed_sec" -ge "$restart_tool_timeout_sec" ]; then
    log "dev:restart client exceeded $restart_tool_timeout_sec s without exact target proof; terminating the ptool client"
    kill -TERM "$restart_tool_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$restart_tool_pid" 2>/dev/null || true
    break
  fi
  sleep 2
done

if wait "$restart_tool_pid"; then
  restart_tool_status=0
else
  restart_tool_status=$?
fi
restart_result="$(cat "$restart_result_file" 2>/dev/null || true)"
restart_diagnostics="$(cat "$restart_diagnostics_file" 2>/dev/null || true)"
rm -f "$restart_result_file" "$restart_diagnostics_file"

# Close the race where ptool exits as the new listener becomes ready.
if [ "$restart_verified" -ne 1 ]; then
  observed_main_pid="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
  observed_health_sha="$(staging_health_source_sha || true)"
  if staging_restart_is_observed "$main_pid" "$observed_main_pid" "$observed_health_sha" "$target"; then
    restart_verified=1
  fi
fi

# ptool exits successfully for a business-level refusal, so inspect the result
# rather than treating process status as the verdict. A verified coalesce is a
# success: another recent restart already cycled the same service and the
# cooldown prevents a redundant outage.
if [ "$restart_verified" -eq 1 ]; then
  log "coordinated dev:restart independently verified: MainPID $observed_main_pid serves exact source $observed_health_sha"
elif [ "$restart_tool_status" -ne 0 ] && restart_result_is_pre_dispatch_refusal "$restart_result $restart_diagnostics"; then
  log "FATAL: coordinated dev:restart was refused before dispatch: ${restart_result:0:250} ${restart_diagnostics:0:250}"
  exit 1
elif [ "$restart_tool_status" -ne 0 ]; then
  log "coordinated dev:restart returned no terminal receipt (exit $restart_tool_status); waiting for exact target health before deciding"
elif printf '%s' "$restart_result" | restart_result_is_pending; then
  restart_pending=1
  log "coordinated dev:restart is scheduled but not yet observed; waiting for a new MainPID and exact target health"
elif ! printf '%s' "$restart_result" | restart_result_is_accepted; then
  # EI-22102474093310851: a git-sync coordination refusal that OUTLASTS the drain
  # above is still transient — git-sync runs continuously on this tree, so the very
  # next 5-minute tick usually gets through. The checkout is ALREADY fast-forwarded
  # at this point; only the restart is outstanding. Treat it the way this script
  # already treats its other transient blocks (the flock skip, the recent-restart
  # grace, the live-client deferral): log and exit 0 instead of failing the unit.
  #
  # BOUNDED, so this can never hide a genuinely stuck barrier: it defers only while
  # the build :3170 is SERVING is younger than MAX_STALE_SEC — the same ceiling and
  # the same current_commit_age_sec() the live-client deferral uses. Past it the
  # refusal is FATAL again and the unit fails loudly, which is the whole point: a
  # persistent barrier means :3170 is silently serving stale code and somebody must
  # look. An unresolvable sha reports a huge age, so it escalates rather than defers.
  if printf '%s' "$restart_result" | restart_refusal_is_transient_git_sync; then
    age="$(current_commit_age_sec "$served_sha")"
    if [ "$age" -lt "$MAX_STALE_SEC" ] 2>/dev/null; then
      log "deferring restart — dev:restart refused on a transient git-sync barrier/collision that outlasted the ${GIT_SYNC_DRAIN_SEC}s drain, and the served build is only ${age}s old (< ${MAX_STALE_SEC}s ceiling). The checkout is already fast-forwarded to ${target:0:8}; the next tick will restart. Refusal: ${restart_result:0:300}"
      exit 0
    fi
    log "staleness ceiling reached (${age}s ≥ ${MAX_STALE_SEC}s) with dev:restart STILL refused on a git-sync barrier/collision — escalating instead of deferring again"
  fi
  log "FATAL: coordinated dev:restart was refused or returned an invalid result: ${restart_result:0:500}"
  exit 1
else
  log "coordinated dev:restart accepted: ${restart_result:0:500}"
fi

last_health_sha=""
readiness_started_at="$(date +%s)"
readiness_elapsed_sec=0
while [ "$readiness_elapsed_sec" -lt "$READINESS_TIMEOUT_SEC" ]; do
  last_health_sha="$(staging_health_source_sha || true)"
  observed_main_pid="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
  if health_sha_matches_target "$last_health_sha" "$target" &&
     { [ "$restart_pending" -eq 0 ] || staging_restart_is_observed "$main_pid" "$observed_main_pid" "$last_health_sha" "$target"; }; then
    log "✅ :3170 healthy on exact staging source ${last_health_sha}"
    exit 0
  fi
  readiness_elapsed_sec=$(( $(date +%s) - readiness_started_at ))
  [ "$readiness_elapsed_sec" -lt "$READINESS_TIMEOUT_SEC" ] || break
  sleep 2
done
log "⚠ :3170 did not report target source ${target:0:10} within ${READINESS_TIMEOUT_SEC}s after restart (last=${last_health_sha:-unavailable}) — check the operator journal"
exit 1
