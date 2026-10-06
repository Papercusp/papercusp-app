#!/usr/bin/env bash
# Tauri's `beforeDevCommand` runs unconditionally on every `npm run dev`.
#
# release-pipeline-resilience P-010 (owner-approved OWN-PORT option,
# 2026-06-10): `npm run dev` must load the LOCAL working tree, not whatever
# happens to own the shared dev-box ports. The systemd operators own
# :3070 (green release) and :3170 (fleet staging — restarted by agents at
# will), so the desktop session gets its OWN working-tree Hono operator on
# a dedicated port (:3270 by default, PTY WS on :3274) that nothing else
# restarts. Mirrors papercup-staging-api's invocation (.env.local sourced,
# background workers/DBOS routines OFF — the green :3070 owns those).
#
# If :3270 is already bound (an earlier `tauri dev` session's operator),
# starting a second one fails with EADDRINUSE and aborts the Tauri build —
# this wrapper skips the spawn and the running process becomes the operator
# backend for this Tauri session.
#
# EI-142 (P-054): when this wrapper DOES spawn the dev stack, it must also
# reap it. tauri-cli only kills THIS wrapper process on exit — the
# npm → node → tsx tree it spawned used to be orphaned to PID 1,
# leaving stale dev servers behind after every `tauri dev` session.
# The stack now runs in its own process group (setsid) with two layers of
# reaping:
#   1. an EXIT/INT/TERM/HUP trap (covers a clean wrapper shutdown), and
#   2. a detached watchdog that survives even a SIGKILL'd wrapper: it polls
#      the wrapper PID and TERM-then-KILLs the dev-stack group once the
#      wrapper is gone.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/resolve-dev-operator-port.sh"

PORT="$(resolve_dev_operator_port "${OPERATOR_DEV_PORT:-3270}")"
in_use() { dev_operator_port_in_use "${1:-$PORT}"; }

# PTY WS data plane: +4, not +1 — :3271..:3273 are squatted by dev-box
# tooling (socat relays); 3274 verified free at authoring.
PTY_PORT="${OPERATOR_DEV_PTY_PORT:-$((PORT + 4))}"
# The working-tree Hono host on the dedicated port. PLAN_RENDER/timers/
# autoloop stay off — the green/staging operators own those. DBOS ROUTINES is
# ON (owner-enabled 2026-06-16): the desktop runs the claim-guarded routines
# tick (hive watchdogs + Queen wake), so the Queen can execute on this HEALTHY
# operator when :3070 is saturated. SAFE because claimDueRoutine's conditional
# next_fire_at advance guarantees single-fire across operators — no double
# git-sync/deploy. AUTOLOOP stays OFF (not claim-guarded → would double-drive
# the pipeline). Revert PAPERCUSP_DBOS_ROUTINES=0 to restore request-only.
# NOTE (WI-3042/WI-41422): no `exec` here — the supervision loop below re-runs
# this command after every child-only exit (including a hard recycle), and an
# `exec` would replace the loop shell on the first iteration, killing the loop.
# NOTE (WI-3556, 2026-07-09): PAPERCUSP_CLUSTER=0 is PINNED. Agent sessions
# inherit the release host's env (PAPERCUSP_CLUSTER=16 on the 128-core box);
# without the pin an agent-launched `tauri dev` forked 16 tsx request workers
# (~500% CPU each → host load >1000). The dev host must be single-process
# anyway: it carries the PTY WS plane, which is incompatible with clustering
# (hono-host.ts P3-2 note).
# NOTE (EI-8817/EI-8818): PAPERCUSP_CLUSTER_WORKERS=0 is ALSO pinned — it takes
# precedence over PAPERCUSP_CLUSTER in resolveClusterWorkers, so an
# inherited/caller-set CLUSTER_WORKERS silently bypasses the CLUSTER=0 pin above
# regardless of its value (that is exactly how the 2026-07-09 storm recurred an
# hour after the CLUSTER=0 pin — a caller had set CLUSTER_WORKERS=1). The '1' ⇒
# AUTO (~15 workers on the tower) semantics that made THAT specific value land on
# a fork storm is now fixed in resolveClusterWorkers itself ('1' means exactly one
# worker) — this explicit =0 pin stays anyway as defense-in-depth: it is still
# correct for CLUSTER_WORKERS to win over CLUSTER, so an agent that sets
# CLUSTER_WORKERS to ANY nonzero value here would still shadow this pin.
#
# NOTE (WI-7344, 2026-08-03): PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR=1 and
# PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR=1 offload the git execs in
# dev-deploy-state.ts (`git()`, the Deploy panel) and system-health/compute.ts
# (`runGit`) to the spawn sidecar instead of fork()ing them from this process.
#
# WHY THIS HOST NEEDS IT MOST, and why it was missing here: fork()'s parent-side
# cost scales with the PARENT's RSS and is charged as SYNCHRONOUS main-thread
# system time (WI-7160, ~40ms of blocked event loop per GB of parent RSS). This
# operator is (a) PINNED single-process by the CLUSTER=0 note above, so there is
# no sibling worker to absorb a stall, and (b) routinely 3-5 GB RSS — i.e. the
# worst case for that mechanism, not the best. Measured 2026-08-03 on the owner's
# live desktop (pid 3129329, 3.68 GB RSS): the trivial /api/health endpoint,
# median 1.7ms, simultaneously returned 2.7-3.2s while a HUD transcript search
# took 13.5s on the same host that answers the same query in ~0.5s when idle.
# The UI symptom was an apparently-hung search; the cause was the whole event
# loop stopping in multi-second chunks around batched git spawns.
#
# WI-7160 shipped this fix as systemd drop-ins on papercup-dev-api.service and
# papercup-staging-api.service ONLY. This operator is spawned by `npm run dev`,
# NOT by systemd, so it inherited nothing and stayed on the unfixed path — the
# one host the owner actually looks at was the one host the rollout skipped.
# Host-level perf env belongs HERE, in the launcher, for exactly that reason.
# `test/dev-operator-perf-env.test.js` fails if either var is dropped again.
#
# Degrades safely: git-via-sidecar falls back to a local spawn on ANY sidecar
# problem (unreachable, stale build, a real git error), so this can only change
# performance, never correctness.
# Preserve explicit caller values across the inner `.env.local` source, which
# runs under `set -a` and would otherwise overwrite them:
#   - PAPERCUSP_BIND_HOST: the isolated Tauri verifier pins loopback here;
#     without this the shared dev file's 0.0.0.0 value wins later and
#     remote-auth-policy correctly crash-loops the private verifier before its
#     desktop can start (EI-21140610191173818).
#   - PAPERCUSP_CUPBOARD_URL: a verifier pointed at a local Cupboard worker
#     (`wrangler dev` on loopback) otherwise talks to whatever origin the dev
#     file names, so the assertions read live listings instead of the seeded
#     ones (EI-24688600845424660).
# No caller value means no override, so ordinary dev launches retain the
# existing `.env.local` contract.
DEV_CALLER_OVERRIDES=""
for DEV_CALLER_KEY in PAPERCUSP_BIND_HOST PAPERCUSP_CUPBOARD_URL; do
  if [ -n "${!DEV_CALLER_KEY:-}" ]; then
    printf -v DEV_CALLER_VALUE_Q '%q' "${!DEV_CALLER_KEY}"
    DEV_CALLER_OVERRIDES+="$DEV_CALLER_KEY=$DEV_CALLER_VALUE_Q "
  fi
done
# Background workers (routines tick, trigger-run dispatch, DBOS schedules)
# stay OFF on the desktop dev operator: on the shared dev database the bg-host
# on :3270 is their single writer (EI-126), and a second one here would race
# it. An ISOLATED verifier (verify-tauri-headless.sh with its own throwaway
# database, PAPERCUSP_VERIFY_TAURI_ISOLATED=1) has no bg-host at all, so
# without workers nothing routine-driven can be verified there — a signed
# webhook is accepted but its trigger run is never dispatched (WI-10004404).
# Such a verifier opts in with PAPERCUSP_DEV_BACKGROUND_WORKERS=1; the opt-in
# is ignored anywhere else, so it can never add a second writer to shared state.
DEV_BACKGROUND_WORKERS=0
if [ "${PAPERCUSP_VERIFY_TAURI_ISOLATED:-}" = 1 ] && [ "${PAPERCUSP_DEV_BACKGROUND_WORKERS:-}" = 1 ]; then
  DEV_BACKGROUND_WORKERS=1
  echo "[tauri] isolated verifier: background workers ON (PAPERCUSP_DEV_BACKGROUND_WORKERS=1)"
fi
# An isolated verifier supplies PAPERCUSP_DEV_SOURCE_ROOT. Resolve it exactly
# (marker check, no walk-up) and fail closed if it is incomplete: the verifier
# must never silently fall back to the mutable shared checkout. With no
# override, preserve the established ordinary desktop launch unchanged.
DEV_SOURCE_ROOT="${PAPERCUSP_DEV_SOURCE_ROOT:-}"
DEV_OPERATOR_DIR="../apps/operator"
if [ -n "$DEV_SOURCE_ROOT" ]; then
  DEV_SOURCE_ROOT="$(cd "$DEV_SOURCE_ROOT" 2>/dev/null && pwd -P)" || {
    echo "[tauri] FATAL: PAPERCUSP_DEV_SOURCE_ROOT is not a readable directory: ${PAPERCUSP_DEV_SOURCE_ROOT}" >&2
    exit 1
  }
  if [ ! -f "$DEV_SOURCE_ROOT/apps/operator/package.json" ] || [ ! -f "$DEV_SOURCE_ROOT/libs/papercusp/package.json" ]; then
    echo "[tauri] FATAL: PAPERCUSP_DEV_SOURCE_ROOT is missing exact Papercusp markers (apps/operator/package.json and libs/papercusp/package.json): $DEV_SOURCE_ROOT" >&2
    exit 1
  fi
  DEV_OPERATOR_DIR="$DEV_SOURCE_ROOT/apps/operator"
fi

# EI-22616267024724225: a frozen verifier snapshot has a unique path on every
# run, so tsx cannot reuse its warm loader path. tsx's module.register worker
# performs synchronous Atomics.wait RPCs for runtime resolutions; concurrent
# cold boots have starved server.listen() past the verifier's owned-origin
# deadline. Let the verifier hand us the plain-Node artifact produced by the
# existing bundle-host.sh recipe while preserving this launcher's env,
# supervision and reaping contract byte-for-byte.
DEV_HOST_COMMAND="npx tsx bin/hono-host.ts"
DEV_HOST_ENTRY="${PAPERCUSP_DEV_HOST_ENTRY:-}"
if [ -n "$DEV_HOST_ENTRY" ]; then
  case "$DEV_HOST_ENTRY" in
    /*) ;;
    *)
      echo "[tauri] FATAL: PAPERCUSP_DEV_HOST_ENTRY must be an absolute path: $DEV_HOST_ENTRY" >&2
      exit 1
      ;;
  esac
  DEV_HOST_ENTRY_DIR="$(cd "$(dirname -- "$DEV_HOST_ENTRY")" 2>/dev/null && pwd -P)" || {
    echo "[tauri] FATAL: PAPERCUSP_DEV_HOST_ENTRY parent is not readable: $DEV_HOST_ENTRY" >&2
    exit 1
  }
  DEV_HOST_ENTRY="$DEV_HOST_ENTRY_DIR/$(basename -- "$DEV_HOST_ENTRY")"
  [ -s "$DEV_HOST_ENTRY" ] || {
    echo "[tauri] FATAL: PAPERCUSP_DEV_HOST_ENTRY is missing or empty: $DEV_HOST_ENTRY" >&2
    exit 1
  }
  if [ -n "$DEV_SOURCE_ROOT" ]; then
    case "$DEV_HOST_ENTRY" in
      "$DEV_SOURCE_ROOT"/apps/operator/*) ;;
      *)
        echo "[tauri] FATAL: PAPERCUSP_DEV_HOST_ENTRY escapes PAPERCUSP_DEV_SOURCE_ROOT: $DEV_HOST_ENTRY" >&2
        exit 1
        ;;
    esac
  fi
  printf -v DEV_HOST_ENTRY_Q '%q' "$DEV_HOST_ENTRY"
  DEV_HOST_COMMAND="node $DEV_HOST_ENTRY_Q"
  # A frozen verifier can stall during module evaluation, before host-level
  # diagnostics are installed. Arm Node itself and retain its exact PID before
  # exec, so the verifier can capture the stall without guessing a peer's PID.
  if [ -n "${PAPERCUSP_DEV_HOST_DIAGNOSTIC_DIR:-}" ]; then
    mkdir -p -- "$PAPERCUSP_DEV_HOST_DIAGNOSTIC_DIR"
    printf -v DEV_HOST_DIAGNOSTIC_DIR_Q '%q' "$PAPERCUSP_DEV_HOST_DIAGNOSTIC_DIR"
    DEV_HOST_RUN="echo \$\$ > $DEV_HOST_DIAGNOSTIC_DIR_Q/node.pid; exec node --report-on-signal --report-signal=SIGUSR2 --report-exclude-env --report-exclude-network --report-directory=$DEV_HOST_DIAGNOSTIC_DIR_Q $DEV_HOST_ENTRY_Q"
    printf -v DEV_HOST_RUN_Q '%q' "$DEV_HOST_RUN"
    DEV_HOST_COMMAND="bash -c $DEV_HOST_RUN_Q"
  fi
  echo "[tauri] using frozen plain-node operator host: $DEV_HOST_ENTRY"
fi
printf -v DEV_OPERATOR_DIR_Q '%q' "$DEV_OPERATOR_DIR"
# MALLOC_ARENA_MAX=2 is the glibc arena cap the systemd operator units get from
# their 40-malloc-arena.conf drop-ins (host-memory-reduction-2026-09-27 D-027:
# this host held 1.8 GB in 64 MiB arenas without it). boot-malloc-arena.ts
# re-execs an uncapped host as a backstop; setting it here skips that exec.
DEFAULT_DEV_CMD="cd $DEV_OPERATOR_DIR_Q && set -a && if [ -f .env.local ]; then . ./.env.local; fi && set +a && env ${DEV_CALLER_OVERRIDES}MALLOC_ARENA_MAX=2 PAPERCUSP_HONO_PORT=$PORT PAPERCUSP_PTY_WS_PORT=$PTY_PORT PAPERCUSP_CLUSTER=0 PAPERCUSP_CLUSTER_WORKERS=0 PAPERCUSP_BACKGROUND_WORKERS=$DEV_BACKGROUND_WORKERS PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR=1 PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR=1 PAPERCUSP_DBOS_ENABLE=1 PAPERCUSP_DBOS_TIMERS=0 PAPERCUSP_DBOS_ROUTINES=1 PAPERCUSP_DBOS_AUTOLOOP=0 PAPERCUSP_DBOS_PLAN_RENDER=0 DBOS__VMID=desktop-dev-$PORT $DEV_HOST_COMMAND"
# hono-host ASSUMES a reachable database (env URL, embedded-pg.json, or native
# :5432 harness_admin), which every developer box has and a fresh clone does
# not. With no configured database and no reachable native fallback, boot
# bin/serve.ts instead: it starts its own
# embedded Postgres + migrations and serves the UI, as the public README says
# (open-source-release-2026-09-29 R-18). A frozen verifier entry or an explicit
# OPERATOR_DEV_CMD always wins; the probe only chooses the default.
DEV_OPERATOR_MODE=external-pg
if [ -z "$DEV_HOST_ENTRY" ] && [ -z "${OPERATOR_DEV_CMD:-}" ]; then
  PROBE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
  probe_status=0
  (cd "$DEV_OPERATOR_DIR" && set -a && if [ -f .env.local ]; then . ./.env.local; fi && set +a && node "$SCRIPT_DIR/dev-operator-pg-probe.mjs" --repo-root "${DEV_SOURCE_ROOT:-$PROBE_ROOT}") || probe_status=$?
  case "$probe_status" in
    0) ;;
    1) DEV_OPERATOR_MODE=embedded-pg ;;
    2) echo "[tauri] configured developer database is unavailable — preserving it; the supervised operator will retry without switching databases" >&2 ;;
    *) echo "[tauri] database probe failed (exit $probe_status) — refusing to choose a different database" >&2; exit "$probe_status" ;;
  esac
fi
if [ "$DEV_OPERATOR_MODE" = embedded-pg ]; then
  echo "[tauri] no reachable developer database — booting bin/serve.ts with its own embedded Postgres"
  # Same .env.local + malloc cap, but serve.ts owns its lifecycle (embedded PG,
  # in-process background workers), so none of the hono-host dev pins apply.
  DEFAULT_DEV_CMD="cd $DEV_OPERATOR_DIR_Q && set -a && if [ -f .env.local ]; then . ./.env.local; fi && set +a && env ${DEV_CALLER_OVERRIDES}MALLOC_ARENA_MAX=2 PAPERCUSP_HONO_PORT=$PORT PAPERCUSP_PTY_WS_PORT=$PTY_PORT PAPERCUSP_SERVE_UI=1 npx tsx bin/serve.ts --ui"
fi
# Test seam: lets the reaper mechanics be exercised with a harmless
# long-running command instead of booting the real dev stack.
DEV_CMD="${OPERATOR_DEV_CMD:-$DEFAULT_DEV_CMD}"

reject_squatter() {
  # Best-effort: find + kill whatever is bound to $PORT, then wait for the
  # port to actually free up. Never fatal — the caller falls back to the
  # warn-and-reuse behavior if this can't complete cleanly (fail open).
  local pids
  if command -v ss >/dev/null 2>&1; then
    pids="$(ss -ltnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)"
  elif command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  [ -z "${pids:-}" ] && return 1
  echo "[tauri] terminating squatter pid(s) on :$PORT: $pids" >&2
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 30); do
    in_use || return 0
    sleep 0.1
  done
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    in_use || return 0
    sleep 0.1
  done
  return 1
}

if in_use; then
  echo "[tauri] operator already serving on :$PORT — reusing"
  # EI-13537: `in_use` only proves the PORT is bound — it does NOT prove the
  # bound process is actually the low-privilege, background-workers-OFF dev
  # operator this wrapper is supposed to guarantee (DEFAULT_DEV_CMD above
  # pins PAPERCUSP_BACKGROUND_WORKERS=0 except for an isolated verifier's
  # DEV_BACKGROUND_WORKERS opt-in). A process bound to :$PORT by some
  # OTHER means (started directly, outside this wrapper, with background
  # workers ON) gets silently and PERMANENTLY adopted by every future
  # `npm run dev` via this exact reuse path — running redundant DBOS
  # machinery against the shared DB (the EI-126 two-hosts-one-DB class of
  # bug) with no supervision/reaper watching it. Confirmed live 2026-07-19
  # (EI-13537) — and AGAIN live 2026-07-20 (EI-18175101264082617): a squatter
  # on :3270 (PAPERCUSP_BACKGROUND_WORKERS=1, full DBOS routines/curation/
  # orchestrator/timers ON, started via a bare `npm exec tsx bin/hono-host.ts`
  # with NO dev-operator-ifneeded.sh ancestry — confirmed via `ps` parent-chain
  # tracing straight to `systemd --user`) ran unsupervised for ~4h and alone
  # held ~46-47 concurrent admin-pool connections (vs. its own
  # PAPERCUSP_DB_POOL_MAX=24 budget) — a major contributor to a server-wide
  # PG connection-saturation regression past its 85% warn budget. The
  # warn-only response below was not enough: nothing ever re-runs this
  # wrapper against a squatter that just sits there silently backing a real
  # session, so the leak persisted for hours. Now: detected mismatch ⇒
  # actively terminate the squatter and fall through to spawn a fresh,
  # wrapper-supervised (reaped) instance in its place, instead of merely
  # logging and adopting it forever.
  #
  # `/api/health/deep` is already PUBLIC + cheap and echoes `dbosEnabled`
  # (dbosLaunchesHere(), which mirrors backgroundWorkersEnabled() —
  # packages/operator-core/lib/background-workers.ts) — reuse it as the
  # identity check instead of trusting the bare port bind. Best-effort:
  # skip silently if curl is unavailable or the probe fails/times out (never
  # block the reuse fast path on a diagnostic — fail OPEN to the old
  # silent-reuse behavior rather than block `npm run dev` on a flaky probe).
  squatter=0
  if command -v curl >/dev/null 2>&1; then
    health="$(curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health/deep" 2>/dev/null || true)"
    # An isolated verifier that opted into background workers (see
    # DEV_BACKGROUND_WORKERS above) EXPECTS dbosEnabled=true from its own
    # operator on its own throwaway database — that is not a squatter.
    case "$health" in
      *'"dbosEnabled":true'*) [ "$DEV_BACKGROUND_WORKERS" = 1 ] || squatter=1 ;;
    esac
  fi
  if [ "$squatter" = "1" ]; then
    echo "[tauri] WARNING: the operator on :$PORT reports dbosEnabled=true — background" >&2
    echo "[tauri] workers are ON, NOT the expected dev-operator config (background workers" >&2
    echo "[tauri] should be OFF on :$PORT). This is a leaked/misconfigured process started" >&2
    echo "[tauri] OUTSIDE this wrapper, running redundant DBOS machinery against the shared" >&2
    echo "[tauri] DB with no reaper watching it. See EI-13537 / EI-18175101264082617." >&2
    if reject_squatter; then
      echo "[tauri] squatter on :$PORT cleared — starting a fresh supervised instance" >&2
      # fall through to the normal spawn path below.
    else
      echo "[tauri] could not clear the squatter on :$PORT (best-effort kill failed or" >&2
      echo "[tauri] port still bound) — reusing it anyway rather than blocking startup." >&2
      echo "[tauri]   Find + kill it by hand: ss -ltnp | grep :$PORT" >&2
      exit 0
    fi
  else
    # `beforeDevCommand` reuse path: exit immediately so Tauri proceeds to
    # spawn its native window pointing at the existing dev server. We did not
    # start that server, so we also don't reap it.
    exit 0
  fi
fi

# A fresh clone has no gitignored dist/ for workspaces whose runtime entry
# points there (@papercusp/sse), so the operator would crash-loop on
# "Cannot find module .../dist/index.js". Build exactly those, once; a no-op
# on a warm tree (open-source-release-2026-09-29 R-18).
RUNTIME_BUILD_ROOT="${DEV_SOURCE_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd -P)}"
node "$SCRIPT_DIR/ensure-runtime-workspace-builds.mjs" "$RUNTIME_BUILD_ROOT" || {
  echo "[tauri] FATAL: could not build runtime workspace outputs under $RUNTIME_BUILD_ROOT" >&2
  exit 1
}

echo "[tauri] starting operator dev server on :$PORT"
# New session + process group so the whole npm → node → tsx tree is a
# single kill target (`kill -- -$GROUP`). Do NOT trust `$!` as the group id:
# util-linux setsid only execs in place when the spawned pid is not already
# a group leader — when it FORKS instead, `$!` is the exited setsid and the
# group kill silently no-ops, orphaning the stack. The inner shell's `$$` IS
# the session leader in both cases, so it reports the true group through a
# pidfile instead of assuming the exec-in-place fast path.
GROUP_FILE="$(mktemp -t dev-operator-group.XXXXXX)"
# Supervision parity with systemd Restart=always (WI-3042): the hono-host
# memory-watchdog recycles a leaked host by EXITING NON-ZERO and expects a
# supervisor to bring up a fresh low-RSS process — systemd does that for
# :3070/:3170, but nothing did here, so a recycle left the desktop dead
# behind a "window will reconnect automatically" recovery page forever.
# Restart after ANY child-only exit (3s backoff); only a stop signal delivered
# to THIS wrapper ends the session (`stopping=1`). WI-41422 measured the real
# npx → tsx chain normalising a signalled Hono child's exit to 0, so treating
# code 0 as an intentional wrapper stop made the sanctioned dev:restart turn
# :3270 off permanently. The wrapper's own TERM/INT/HUP trap is the authoritative
# stop intent; a child cannot declare its supervisor finished by exit code alone.
# Each iteration runs in a subshell so DEV_CMD's `cd` starts from the same cwd.
#
# EI-256 (found while writing the reaper's first hermetic test): reap()/the
# watchdog kill the WHOLE group with `kill -TERM -- "-$GROUP"` — that reaches
# this loop-bash AND its current DEV_CMD child at once. In principle the two
# could race: if the child (a fast-to-signal process, e.g. `sleep`) dies
# before this loop-bash gets around to processing its OWN copy of the same
# signal, `code` comes back non-zero (killed-by-signal) and — with no
# stopping flag — the WI-3042 branch below would fire and RESPAWN DEV_CMD,
# spawning a fresh process the group-kill already broadcast past. `trap ...
# TERM INT HUP` tells "we were asked to stop" apart from "the command
# crashed on its own", closing that narrow theoretical race as cheap
# defense-in-depth.
export -f dev_operator_port_in_use in_use
# EI-18745117818375852: under load, the sidecar this loop just spawned can
# still be alive (mid-shutdown, or the memory-watchdog's own exiting process
# hasn't released its listen socket yet) when the 3s backoff expires — the
# blind restart then dies INSTANTLY on EADDRINUSE against its own still-live
# predecessor, and because that death is itself non-zero, the loop restarts
# again just as fast: a self-sustaining restart storm that squats the port
# with a growing pile of dead-on-arrival children while `verify-tauri-
# headless.sh` (or the Tauri window) sits waiting for a bridge that will
# never come up. Two changes close this:
#   1. Before EVERY restart, wait (bounded) for $PORT to actually be free —
#      not a fixed sleep — so a restart only ever fires once the previous
#      listener is gone.
#   2. If $PORT never frees, or the child keeps dying immediately regardless,
#      abort the loop with a clear diagnosis after a bounded number of
#      consecutive failures instead of restarting forever.
setsid bash -c 'echo "$$" > "$1"; shift
  port="$1"; shift
  stopping=0
  trap "stopping=1" TERM INT HUP
  fails=0
  max_fails=8
  while :; do
    ( eval "$1" ); code=$?
    [ "$stopping" = 1 ] && exit 0
    fails=$((fails + 1))
    if in_use "$port"; then
      echo "[tauri] operator dev server exited code=$code (attempt $fails/$max_fails) — :$port is STILL held (likely by the exiting process itself); waiting up to 30s for it to free before restarting (WI-3042 / EI-18745117818375852)" >&2
      waited=0
      while in_use "$port" && [ "$waited" -lt 30 ]; do
        sleep 1; waited=$((waited + 1))
      done
      if in_use "$port"; then
        echo "[tauri] FATAL: :$port never freed after 30s and the operator dev server has failed $fails time(s) in a row (code=$code) — refusing to keep restarting into EADDRINUSE. Find + kill the squatter by hand: ss -ltnp | grep :$port (WI-3042 / EI-18745117818375852)" >&2
        exit 98
      fi
    fi
    if [ "$fails" -ge "$max_fails" ]; then
      echo "[tauri] FATAL: operator dev server has exited $fails times in a row (code=$code) — aborting instead of restarting forever (WI-3042 / EI-18745117818375852)" >&2
      exit 99
    fi
    echo "[tauri] operator dev server exited code=$code — restarting in 3s (attempt $fails/$max_fails) (WI-3042 supervision)" >&2
    sleep 3
  done' _ "$GROUP_FILE" "$PORT" "$DEV_CMD" &
CHILD=$!
# EI-256 (the REAL root cause found while writing the reaper's first
# hermetic test — the theoretical race above was NOT it; A/B-testing that
# trap alone left the SAME ~25-60% not-reaped rate unchanged on this box).
# `GROUP` used to stay unset — and `reap`/its trap stayed UNDEFINED — for the
# ENTIRE up-to-5s polling loop below that waits for the loop-bash to report
# its real pgid through $GROUP_FILE. A signal (TERM/INT/HUP — exactly what a
# graceful `dev:restart` drain, Ctrl-C, or a deploy's first shutdown attempt
# sends) landing anywhere in that window hit bash's DEFAULT disposition
# (terminate immediately) with NO trap yet installed — the freshly-spawned
# dev stack was orphaned with zero supervision, permanently (confirmed via
# `bash -x` tracing: the wrapper died mid-poll-loop, `$GROUP` still empty,
# `reap` never even defined). Fix: arm the trap NOW, against the safe
# interim target `$CHILD` — `reap` re-reads `$GROUP` at CALL time (bash
# doesn't freeze it at trap-registration time), so once the poll loop below
# corrects `$GROUP` to the real pgid (when setsid forked rather than
# exec'd-in-place — see the note above), a later-firing trap picks up the
# right target for free. Worst case (the loop-bash never reports in time)
# `$GROUP` stays `$CHILD` — still an armed, usable target, instead of no
# supervision at all.
GROUP="$CHILD"
reap() {
  kill -TERM -- "-$GROUP" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 -- "-$GROUP" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL -- "-$GROUP" 2>/dev/null || true
}
trap reap EXIT INT TERM HUP

# Watchdog: its own session too, so nothing that kills our group takes it
# down before it can reap. It exits as soon as the dev-stack group is gone.
#
# EI-256: spawned EARLY (before $GROUP_FILE is even read below) and given
# $CHILD + $GROUP_FILE rather than a pre-resolved $GROUP, for the SAME reason
# the wrapper's own trap moved earlier above — a SIGKILL to the wrapper
# (which the watchdog alone survives; SIGKILL can't be trapped) landing
# before the watchdog existed would orphan the stack just as badly as the
# TERM/INT/HUP case did. It now does its OWN independent refinement against
# $CHILD, run concurrently with the wrapper's identical loop below. Neither
# side removes $GROUP_FILE (that would race the OTHER reader into an early,
# wrong $CHILD fallback in the fork case — measured: it happened) — a
# detached, generously-delayed cleanup below removes it once both have had
# ample time to read it.
setsid bash -c '
  wrapper="$1"; child="$2"; group_file="$3"
  group="$child"
  for _ in $(seq 1 50); do
    g="$(cat "$group_file" 2>/dev/null || true)"
    [ -n "$g" ] && { group="$g"; break; }
    sleep 0.1
  done
  while kill -0 "$wrapper" 2>/dev/null; do sleep 1; done
  kill -TERM -- "-$group" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 -- "-$group" 2>/dev/null || exit 0
    sleep 0.1
  done
  kill -KILL -- "-$group" 2>/dev/null || true
' dev-operator-watchdog "$$" "$CHILD" "$GROUP_FILE" >/dev/null 2>&1 &

for _ in $(seq 1 50); do
  g="$(cat "$GROUP_FILE" 2>/dev/null || true)"
  [ -n "$g" ] && { GROUP="$g"; break; }
  sleep 0.1
done
# Both readers above give up after 5s max; 15s comfortably clears that with
# margin before this tiny (single-line) temp file is removed. Backgrounded
# and left un-awaited on purpose — a harmless orphan by the time this script
# exits either way.
( sleep 15; rm -f "$GROUP_FILE" ) &

# Block for the dev stack's lifetime (tauri-cli treats a long-running
# beforeDevCommand as the dev server and pings devUrl for readiness).
# In the forked-setsid case $CHILD exits immediately while the stack lives
# on in $GROUP — keep blocking on the group so the wrapper's exit (and its
# EXIT-trap reap) only happens once the stack itself is gone.
wait "$CHILD" || true
while kill -0 -- "-$GROUP" 2>/dev/null; do sleep 1; done
