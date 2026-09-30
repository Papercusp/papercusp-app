#!/usr/bin/env bash
# live-federation-gate-reaper.selftest.sh — regression test for the leaked-sidecar
# reaper (EI-14500) in bin/live-federation-gate.sh.
#
# WHY: the gate boots a packaged "Papercusp Server" sidecar (node … serve.mjs --ensure)
# with its OWN isolated PAPERCUSP_HOME + embedded PG. On ANY early / non-zero gate exit that
# setsid-detached sidecar (and its embedded PG) got reparented to systemd --user and ran for
# ~10h as an orphan (EI-14500) — a standing box-hijack hazard (each internal --ensure retry
# could re-trigger the embedded-pg.json hijack class). The fix wired an EXIT-trap reaper
# (reap_gate_sidecars) that SIGTERM→SIGKILLs rig-owned leftover serve.(mjs|ts) + embedded-pg
# processes, gated by the SAME rig-ownership test as the prod-port guard so a REAL (prod/live)
# operator sidecar is NEVER touched. This self-test proves, on the REAL gate functions:
#   1. gate_owns_rig_pid attributes a rig-sandbox process as OWNED and a neutral one as NOT.
#   2. reap_gate_sidecars kills the rig-owned leftover and SPARES the non-rig one
#      plus a concurrently-live FOREIGN rig using the same canonical /tmp prefix.
#   3. the EXIT trap actually wires reap_gate_sidecars (structural — guards trap removal).
# It STUBS pgrep to a controlled fake-pid list, so it NEVER touches a real box process (even
# a concurrent live gate run). Purely local: two backgrounded `sleep` stand-ins, ~1s.
#
#   bash bin/lib/live-federation-gate-reaper.selftest.sh   # exit 0 = PASS, 1 = FAIL
#
# Why a bash self-test and not Vitest: the unit under test is bash. Mirrors
# federation-asserts.selftest.sh / release-artifacts.selftest.sh — the four canonical
# TS/Cargo/LLM frameworks don't host shell units; the live gate is the integration test.
# A Vitest wrapper (packages/operator-core/lib/live-federation-gate-reaper.test.ts)
# runs this in CI.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$DIR/../live-federation-gate.sh"

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

[ -f "$GATE" ] || { echo "SKIP: gate script not found at $GATE"; exit 0; }

# ── Extract the two reaper functions from the REAL gate source and eval them, so this test
#    exercises the shipping code (not a copy) WITHOUT running the gate's top-level
#    load-gate / build / smoke machinery. The closing `}` of each function is at column 0. ──
FN_SRC="$(sed -n '/^gate_owns_rig_pid() {/,/^}/p;/^reap_gate_sidecars() {/,/^}/p' "$GATE")"
if ! grep -q 'gate_owns_rig_pid()' <<<"$FN_SRC" || ! grep -q 'reap_gate_sidecars()' <<<"$FN_SRC"; then
  echo "SKIP: could not extract reaper functions from $GATE (refactored/renamed?)"
  echo "      → if the reaper was intentionally reshaped, update this selftest to match."
  exit 0
fi
log() { :; }                              # the functions log to stderr; silence it here
GATE_SIDECAR_REAP_GRACE_S=1               # short grace: the fakes die on SIGTERM
WORK="/tmp/live-fed-reaper-selftest-nomatch-$$"   # referenced by gate_owns_rig_pid's regex
# shellcheck disable=SC2034
eval "$FN_SRC"

# spawn_fake_serve <cwd> — a backgrounded `sleep` stand-in whose argv looks like the leaked
# sidecar and whose cwd is $cwd (what gate_owns_rig_pid inspects). Echoes its pid.
# stdin/out/err are detached (</dev/null >/dev/null 2>&1): the NEUTRAL fake is deliberately
# NOT reaped, so if it inherited this test's stdout it would hold the caller's capture pipe
# open until it exits (120s) — hanging any harness that reads our output to EOF.
spawn_fake_serve() {
  local cwd="$1" marker="${2:-}"
  ( cd "$cwd" && PAPERCUSP_LIVE_FED_GATE_RUN="$marker" \
      exec -a "node --require sidecar-preload.js serve.mjs --ensure" sleep 120 ) \
    </dev/null >/dev/null 2>&1 &
  echo $!
}

# WI-5701: a rig-owned stand-in for the esbuild BUNDLE step (build-desktop-sidecar.sh's
# `npx esbuild bin/serve.ts --outfile=.../serve.mjs`) — argv matches the SAME `serve\.(mjs|ts)`
# pgrep pattern and its cwd is rig-owned, but it is a BUILD, not a running server, and must
# never be reaped (the live incident: a stray/concurrent gate's exit-trap reap killed a
# DIFFERENT gate's in-flight sidecar build this way, twice in a row).
spawn_fake_build() {
  local cwd="$1" marker="${2:-}"
  ( cd "$cwd" && PAPERCUSP_LIVE_FED_GATE_RUN="$marker" \
      exec -a "node esbuild bin/serve.ts --outfile=$cwd/serve.mjs --bundle" sleep 120 ) \
    </dev/null >/dev/null 2>&1 &
  echo $!
}

# The owned fake carries THIS gate's exact run marker. The foreign fake uses the
# same canonical rig-prefix class with a DIFFERENT marker, while the neutral fake
# carries none — both must be spared.
RIG_DIR="$(mktemp -d /tmp/merge-smoke.XXXXXX)"
FOREIGN_RIG_DIR="$(mktemp -d /tmp/hive-fromrepo-smoke.XXXXXX)"
NEUTRAL_DIR="$(mktemp -d /tmp/reaper-neutral.XXXXXX)"
BUILD_DIR="$(mktemp -d /tmp/merge-smoke.XXXXXX)"
RIG_PID="$(spawn_fake_serve "$RIG_DIR" "$WORK")"
FOREIGN_RIG_PID="$(spawn_fake_serve "$FOREIGN_RIG_DIR" "/tmp/live-fed-gate-foreign-$$")"
NEUTRAL_PID="$(spawn_fake_serve "$NEUTRAL_DIR")"
BUILD_PID="$(spawn_fake_build "$BUILD_DIR" "$WORK")"
cleanup() { kill "$RIG_PID" "$FOREIGN_RIG_PID" "$NEUTRAL_PID" "$BUILD_PID" 2>/dev/null || true; rm -rf "$RIG_DIR" "$FOREIGN_RIG_DIR" "$NEUTRAL_DIR" "$BUILD_DIR"; }
trap cleanup EXIT INT TERM
sleep 0.3   # let the execs settle so /proc/<pid>/cwd resolves

# ── 1. rig-ownership predicate ──────────────────────────────────────────────────
if gate_owns_rig_pid "$RIG_PID"; then
  ok "gate_owns_rig_pid: rig-sandbox cwd → OWNED"
else
  bad "gate_owns_rig_pid: rig-sandbox pid $RIG_PID not recognized as owned (reaper would leak it)"
fi
if gate_owns_rig_pid "$NEUTRAL_PID"; then
  bad "gate_owns_rig_pid: neutral pid $NEUTRAL_PID wrongly claimed as owned — would KILL a real prod/live sidecar"
else
  ok "gate_owns_rig_pid: neutral cwd → NOT owned (a real sidecar is protected)"
fi
if gate_owns_rig_pid "$FOREIGN_RIG_PID"; then
  bad "gate_owns_rig_pid: foreign live rig pid $FOREIGN_RIG_PID wrongly claimed by prefix — one gate EXIT would kill a peer run (WI-40905)"
else
  ok "gate_owns_rig_pid: foreign canonical-prefix rig → NOT owned (exact run marker protects peers)"
fi

# ── 2. reap kills the rig-owned leftover, spares the non-rig one + a rig-owned BUILD ──
# Stub pgrep so reap_gate_sidecars operates ONLY on our controlled pids — it NEVER
# scans / signals a real box process, even during a concurrent live gate run.
pgrep() { printf '%s\n%s\n%s\n%s\n' "$RIG_PID" "$FOREIGN_RIG_PID" "$NEUTRAL_PID" "$BUILD_PID"; }
reap_gate_sidecars
unset -f pgrep
sleep 0.3

if kill -0 "$RIG_PID" 2>/dev/null; then
  bad "reap_gate_sidecars: rig-owned leftover pid $RIG_PID SURVIVED — orphan leak not reaped (EI-14500 regressed)"
else
  ok "reap_gate_sidecars: rig-owned leftover reaped"
fi
if kill -0 "$NEUTRAL_PID" 2>/dev/null; then
  ok "reap_gate_sidecars: non-rig serve.mjs spared"
else
  bad "reap_gate_sidecars: non-rig serve.mjs was KILLED — ownership guard failed (would kill prod/live sidecars)"
fi
if kill -0 "$FOREIGN_RIG_PID" 2>/dev/null; then
  ok "reap_gate_sidecars: foreign concurrently-live rig spared (WI-40905)"
else
  bad "reap_gate_sidecars: foreign live rig was KILLED by shared-prefix fallback (WI-40905)"
fi
if kill -0 "$BUILD_PID" 2>/dev/null; then
  ok "reap_gate_sidecars: rig-owned esbuild BUILD step (no --ensure) spared (WI-5701)"
else
  bad "reap_gate_sidecars: rig-owned esbuild BUILD step $BUILD_PID was KILLED — a concurrent gate's in-flight sidecar build would die mid-bundle (WI-5701 regressed)"
fi

# ── 3. structural: the EXIT trap wires the reaper ───────────────────────────────
# A fix that defines reap_gate_sidecars but never calls it on EXIT still leaks orphans — this
# guards against the trap being dropped in a later edit.
if grep -qE "trap '[^']*reap_gate_sidecars[^']*' EXIT" "$GATE"; then
  ok "EXIT trap wires reap_gate_sidecars"
else
  bad "EXIT trap no longer calls reap_gate_sidecars — orphans leak on early/non-zero exit (EI-14500)"
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "live-federation-gate reaper selftest: PASS"
  exit 0
else
  echo "live-federation-gate reaper selftest: FAIL ($FAILS)"
  exit 1
fi
