#!/usr/bin/env bash
# release-local-leg-reaper.selftest.sh — regression test for the orphaned-build-leg
# reaper (EI-17272) in bin/release-local.sh.
#
# WHY: release-local.sh launches its Linux leg (`tauri build` → cargo → rustc, and
# bin/build-appimage.sh's appimagetool/linuxdeploy) as a background subshell of
# itself. If release-local.sh's own process dies before `supervise_legs` reaps that
# subshell (an interrupted/killed terminal or tmux pane, an OOM, a `kill -9` on a
# wedged cut) the leg was silently ORPHANED and kept running forever, pinning a
# full CPU core — observed live: a `tauri build` ran 10h at 99% CPU after its
# cutting session died (EI-17272). The fix wired an EXIT-trap reaper
# (reap_release_legs) that SIGTERM→SIGKILLs cmdline-matching build-tool processes
# whose cwd is rooted under THIS cut's own $ROOT — so a concurrent PEER release
# cut's tauri/cargo build elsewhere on this shared dev box is NEVER touched. This
# self-test proves, on the REAL functions extracted from release-local.sh:
#   1. release_owns_leg_pid attributes a process cwd'd under $ROOT as OWNED, and
#      one cwd'd elsewhere as NOT owned.
#   2. reap_release_legs kills the owned/matching leftover and SPARES the
#      not-owned one (a concurrent peer's build), even though both match the
#      cmdline pattern.
# It uses plain backgrounded `sleep` stand-ins (no real cargo/tauri/appimagetool),
# so it never touches a real box process — ~4s, fully hermetic.
#
#   bash bin/lib/release-local-leg-reaper.selftest.sh   # exit 0 = PASS, 1 = FAIL
#
# Why a bash self-test and not Vitest: the unit under test is bash. Mirrors
# live-federation-gate-reaper.selftest.sh / release-artifacts.selftest.sh — the
# four canonical TS/Cargo/LLM frameworks don't host shell units, and a real
# release cut is the (expensive, ~35min) integration test.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$DIR/../release-local.sh"

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

[ -f "$SCRIPT" ] || { echo "SKIP: release-local.sh not found at $SCRIPT"; exit 0; }

# ── Extract the two reaper functions from the REAL script and eval them, so this
#    test exercises the shipping code (not a copy) without running the ~1300-line
#    script's top-level cut machinery. The closing `}` of each function is at
#    column 0 (matches the live-federation-gate-reaper.selftest.sh idiom). ──
FN_SRC="$(sed -n '/^release_owns_leg_pid() {/,/^}/p;/^reap_release_legs() {/,/^}/p' "$SCRIPT")"
if ! grep -q 'release_owns_leg_pid()' <<<"$FN_SRC" || ! grep -q 'reap_release_legs()' <<<"$FN_SRC"; then
  echo "SKIP: could not extract reaper functions from $SCRIPT (refactored/renamed?)"
  echo "      → if the reaper was intentionally reshaped, update this selftest to match."
  exit 0
fi
RELEASE_LEG_REAP_GRACE_S=1   # short grace: the fakes die on SIGTERM
eval "$FN_SRC"

# spawn_fake_leg <cwd> — a backgrounded `sleep` stand-in whose argv looks like a
# real build-tool process (matches reap_release_legs' pgrep pattern) and whose
# cwd is $cwd (what release_owns_leg_pid inspects). Echoes its pid.
spawn_fake_leg() {
  local cwd="$1"
  ( cd "$cwd" && exec -a "cargo build --release --manifest-path papercusp_desktop/Cargo.toml" sleep 60 ) \
    </dev/null >/dev/null 2>&1 &
  echo $!
}

OWNED_ROOT="$(mktemp -d /tmp/rl-leg-selftest-owned.XXXXXX)"
PEER_ROOT="$(mktemp -d /tmp/rl-leg-selftest-peer.XXXXXX)"
cleanup() {
  kill "$OWNED_PID" "$PEER_PID" 2>/dev/null || true
  rm -rf "$OWNED_ROOT" "$PEER_ROOT"
}
trap cleanup EXIT

# This test's own ROOT is OWNED_ROOT (release_owns_leg_pid closes over $ROOT).
ROOT="$OWNED_ROOT"

echo "release-local-leg-reaper self-test (ROOT=$ROOT)"

OWNED_PID="$(spawn_fake_leg "$OWNED_ROOT")"
PEER_PID="$(spawn_fake_leg "$PEER_ROOT")"
sleep 0.3   # let both fakes actually chdir + exec before we inspect /proc

# 1) ownership predicate: OWNED_PID (cwd under $ROOT) is owned; PEER_PID is not.
if release_owns_leg_pid "$OWNED_PID"; then
  ok "release_owns_leg_pid attributes the \$ROOT-cwd'd process as OWNED"
else
  bad "release_owns_leg_pid did NOT attribute the \$ROOT-cwd'd process as owned"
fi
if release_owns_leg_pid "$PEER_PID"; then
  bad "release_owns_leg_pid incorrectly attributed a PEER cut's process (different cwd) as owned"
else
  ok "release_owns_leg_pid correctly does NOT attribute a peer cut's process as owned"
fi

# 2) reap_release_legs kills the owned leftover and SPARES the peer's.
reap_release_legs
sleep 1.5   # past the 1s grace period above

if kill -0 "$OWNED_PID" 2>/dev/null; then
  bad "reap_release_legs left the OWNED orphaned build process (pid $OWNED_PID) running"
else
  ok "reap_release_legs killed the OWNED orphaned build process"
fi
if kill -0 "$PEER_PID" 2>/dev/null; then
  ok "reap_release_legs SPARED the peer cut's process (pid $PEER_PID, different cwd) — no cross-cut collateral kill"
else
  bad "reap_release_legs incorrectly killed a PEER cut's process — would kill a concurrent release cut on this shared box"
fi

echo
if [[ "$FAILS" -eq 0 ]]; then
  echo "release-local-leg-reaper self-test: ALL PASS"
  exit 0
else
  echo "release-local-leg-reaper self-test: $FAILS FAILED"
  exit 1
fi
