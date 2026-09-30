#!/usr/bin/env bash
# flake-soak — run a vitest target R times under DETERMINISTIC CPU starvation so
# LOAD-SENSITIVE flakes redden on purpose instead of ambushing whoever runs the
# suite next.
#
# WHY THIS EXISTS (WI-4468 / WI-4481): the MugTab "resets Capacity" flake was
# ~60% red under CPU pressure and 100% green in isolation / unthrottled. A
# single green run cannot disprove that class — which is exactly how it survived
# TWO peer RED reports and the fixing agent's own dismissal ("I re-ran it once,
# it was green"). The detector gap — not the race — was the real lesson. This
# lane closes it: repeat the target under starvation and AGGREGATE, so a
# load-sensitive flake shows up as a red-rate, not a coin flip you happened to
# win.
#
# THE THROTTLE — taskset core-pinning, not systemd/cgroups. The parallel vitest
# suite (many worker processes) is pinned to a SMALL set of cores, so its
# workers timeshare heavily: event loops congest, throttled timers (nuqs URL
# flushes, React effect scheduling, RTL async) fire late, and same-tick
# remount-vs-flush races resolve the losing way — the exact mechanism behind the
# MugTab flake. systemd-run / cgroup delegation is deliberately NOT used: the
# native-scheduler lockout hook (apps/operator/scripts/hooks/cc/pretooluse-
# bash-resource-gate.sh) denies EVERY agent-session `systemd-run` invocation
# that asks for cgroup resource control — `--user --scope -p CPUQuota=...`
# included, not just `--system` (verified live 2026-07-26: both denied
# identically with PAPERCUSP_AGENT_SESSION=1 set; WI-6116). It is an
# AGENT-SESSION guard, not a host-wide one: a non-agent process — e.g.
# green-checkpoint's own `isolate` path — runs outside it and can use
# `systemd-run --user` successfully. This script runs from an agent session,
# so it is squarely in scope either way. taskset needs no scheduler, no root,
# and no daemon, so it works unconditionally regardless of which side of that
# guard is invoking it.
#
# CONTENTION — SOAK A SUITE, NOT A LONE FILE. The starvation only produces the
# race if there is something to contend WITH. Measured on the real pre-fix MugTab
# flake: the fixture soaked ALONE on 2 pinned cores reddened just 1/6, while the
# same flake reddened ~60% inside the full suite. The parallel workers ARE the
# load — pinning a single-file run just makes it slow, not congested. So point
# this lane at a DIRECTORY / suite (the default for --self-test), not one file,
# or you will build a detector that confidently misses the bug it was made for.
#
# USAGE
#   scripts/flake-soak.sh [options] [-- <vitest args...>]
#     --repeats N      run the target N times            (default $FLAKE_SOAK_REPEATS or 6)
#     --cores M        pin the run to M cores            (default $FLAKE_SOAK_CORES or 2)
#     --cwd DIR        package dir holding node_modules  (default $FLAKE_SOAK_CWD or apps/operator-vite)
#     --self-test F    run flakeproof fixture F and PASS iff it reddens (proves the
#                      throttle can actually induce a load-flake — see below).
#                      Runs F alongside its SIBLINGS (its directory) by default,
#                      because the contention that produces the race comes from the
#                      parallel workers — see CONTENTION below.
#     --isolate        with --self-test: run the fixture ALONE (weaker; measured
#                      1/6 red vs the suite's ~60% — kept only for diagnosis)
#     -- <args>        everything after -- is passed through to `vitest run`
#
#   # soak a specific suspect suite 8x on 2 cores:
#   scripts/flake-soak.sh --repeats 8 -- src/components/left-sidebar/MugTab.test.tsx
#
#   # prove the lane discriminates (fixture must be a *.flakeproof.test.tsx):
#   scripts/flake-soak.sh --self-test src/components/left-sidebar/SomeBug.flakeproof.test.tsx
#
# EXIT CODES
#   normal mode:    0 if ALL repeats passed; 1 if ANY repeat failed (the flake
#                   reddened — the point); 2 = usage / setup error.
#   --self-test:    0 if the fixture reddened at least once (throttle works); 1
#                   if it stayed all-green (the throttle FAILED to reproduce a
#                   known load-flake — the lane is not discriminating and must be
#                   fixed before it is trusted); 2 = usage / setup error.
#
# PROVE-IT-DISCRIMINATES. A guard that only ever shows green has proven nothing
# (agent-insights/prove-it-discriminates-before-it-acts). The `.flakeproof.test.tsx`
# naming is a reserved, gitignored, normally-EXCLUDED scratch convention: drop a
# known-flaky fixture next to the code under test, run it through --self-test,
# and watch this lane redden it. Normal `vitest run` never sees the fixture (the
# package vitest.config excludes it unless FLAKE_SOAK_SELFTEST=1), and git-sync
# never commits it (.gitignore), so it is a zero-landmine way to validate the
# lane itself.

set -uo pipefail

# MEASURED SENSITIVITY — READ THIS BEFORE TRUSTING A GREEN.
# Against the real pre-fix MugTab flake, this lane reproduces at ~10-17% PER RUN
# (1/6 and 1/10 in two independent soaks), versus ~60% on the genuinely loaded
# 128-core box where the flake was originally found. It is a real detector, not a
# strong one: it recovers a synthetic fraction of the host's ambient chaos.
#
# Consequence for the default: at p≈0.15, 12 repeats gives ~86% detection, 6 gives
# ~62%. So the default is 12, and an ALL-GREEN soak is evidence, NOT proof. Quote
# the red-rate ("0/12 under load"), never "the soak passed, it's fine" — that is
# the same over-claim (a green run treated as a disproof) that let the original
# flake survive two peer reports.
REPEATS="${FLAKE_SOAK_REPEATS:-12}"
# 8 cores + 8 competing hogs + nice 10 is the TUNED window (see start_load /
# classify_run): enough preemption to delay a throttled timer past a remount,
# not so much that vitest's pool times out starting a worker and executes zero
# tests. 2 cores was too weak (1/6); 4 cores + 12 hogs at nice 19 killed the
# runner outright (6/6 "red" with 0 tests run — a lying detector).
CORES="${FLAKE_SOAK_CORES:-8}"
LOAD="${FLAKE_SOAK_LOAD:-8}"
CWD="${FLAKE_SOAK_CWD:-apps/operator-vite}"
NICE="${FLAKE_SOAK_NICE:-10}"
SELFTEST_FIXTURE=""
ISOLATE=0
invalid=0
declare -a VITEST_ARGS=()

# ---- arg parse -------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repeats) REPEATS="$2"; shift 2 ;;
    --cores)   CORES="$2";   shift 2 ;;
    --load)    LOAD="$2";    shift 2 ;;
    --cwd)     CWD="$2";     shift 2 ;;
    --nice)    NICE="$2";    shift 2 ;;
    --self-test) SELFTEST_FIXTURE="$2"; shift 2 ;;
    --isolate)   ISOLATE=1; shift ;;
    --) shift; VITEST_ARGS+=("$@"); break ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    *) VITEST_ARGS+=("$1"); shift ;;
  esac
done

# Resolve repo root so the script works from any CWD.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/$CWD"

# Resolve the vitest binary. In this monorepo it is HOISTED to the repo root
# (apps/operator-vite has no local .bin/vitest), so a package-local-only lookup
# is dead on arrival — check the package first, then fall back to the root.
if [ -x "$PKG_DIR/node_modules/.bin/vitest" ]; then
  VITEST_BIN="$PKG_DIR/node_modules/.bin/vitest"
elif [ -x "$REPO_ROOT/node_modules/.bin/vitest" ]; then
  VITEST_BIN="$REPO_ROOT/node_modules/.bin/vitest"
else
  echo "flake-soak: no vitest binary (looked in $PKG_DIR and $REPO_ROOT)" >&2
  echo "            never run pnpm install in the shared tree (WI-4427)" >&2
  exit 2
fi

# ---- CPU pinning -----------------------------------------------------------
# Pick a core WINDOW rather than always cores 0-1, so concurrent soaks from
# different agents on the shared box don't all hammer the same two cores.
TOTAL_CORES="$(nproc 2>/dev/null || echo 4)"
if [ "$CORES" -lt 1 ]; then CORES=1; fi
if [ "$CORES" -gt "$TOTAL_CORES" ]; then CORES="$TOTAL_CORES"; fi
NWIN=$(( TOTAL_CORES / CORES ))
if [ "$NWIN" -lt 1 ]; then NWIN=1; fi
OFFSET=$(( (RANDOM % NWIN) * CORES ))
CPU_END=$(( OFFSET + CORES - 1 ))
CPUSET="${OFFSET}-${CPU_END}"

TASKSET_BIN="$(command -v taskset || true)"
if [ -z "$TASKSET_BIN" ]; then
  echo "flake-soak: taskset not found — running WITHOUT core-pinning (throttle" >&2
  echo "            weakened; a load-flake may not reproduce). Install util-linux." >&2
fi

# ---- one run ---------------------------------------------------------------
# Returns the vitest exit code. Pins to $CPUSET, nices, bypasses the pc-heavy
# admission gate (this wrapper already self-limits to $CORES cores), and — in
# self-test mode — sets FLAKE_SOAK_SELFTEST=1 so the package config includes the
# flakeproof fixture.
# ---- competing load --------------------------------------------------------
# THE INGREDIENT THAT ACTUALLY REPRODUCES THE RACE. Pinning vitest to N cores is
# NOT starvation — those cores are otherwise idle, so its workers timeshare fairly
# and every event loop still gets scheduled promptly. Measured: pinned-only
# reddened the real MugTab flake 1/6 at 2 cores and 0/6 at 1 core (harsher pinning,
# FEWER reds — the naive theory is simply wrong).
#
# The original repro was vitest NICED (pc-heavy, +10) competing against a box at
# load 150-240. The race needs the runner to be LOW-PRIORITY RELATIVE TO COMPETING
# WORK, so its threads get preempted for long stretches and the throttled nuqs URL
# flush lands after the remount. So: run niced vitest against real competing hogs
# at NORMAL priority on the same cores.
#
# Too much of this and the runner stops running at all (worker start timeout, 0
# tests) — see classify_run. LOAD is therefore a tuned knob, not "as much as
# possible", and the invalid-run guard is what keeps a too-hot config from being
# misread as a flake.
HOG_PIDS=()
start_load() {
  [ "$LOAD" -gt 0 ] || return 0
  local h
  for h in $(seq 1 "$LOAD"); do
    ${TASKSET_BIN:+"$TASKSET_BIN" -c "$CPUSET"} bash -c 'while :; do :; done' &
    HOG_PIDS+=($!)
  done
}
stop_load() {
  [ "${#HOG_PIDS[@]}" -gt 0 ] || return 0
  kill "${HOG_PIDS[@]}" 2>/dev/null
  wait "${HOG_PIDS[@]}" 2>/dev/null
  HOG_PIDS=()
}
# Never leak hogs if the soak is interrupted — they are uncapped busy loops.
trap 'stop_load; exit 130' INT TERM
trap 'stop_load' EXIT

run_once() {
  local extra_env="$1"; shift
  start_load
  (
    cd "$PKG_DIR" || exit 2
    # shellcheck disable=SC2086
    env PC_HEAVY_BYPASS=1 $extra_env \
      ${TASKSET_BIN:+"$TASKSET_BIN" -c "$CPUSET"} \
      nice -n "$NICE" \
      "$VITEST_BIN" run "$@" >/tmp/flake-soak-run.$$.log 2>&1
  )
  local rc=$?
  stop_load
  return $rc
}

# Classify the last run: "pass" | "red" | "invalid".
#
# THIS GUARD IS THE POINT, NOT A NICETY. Turn the load up far enough and vitest
# stops being slow and starts being BROKEN: the pool reports "Failed to start
# forks worker" / "Timeout waiting for worker to respond" and finishes with
# `Test Files  no tests` — a NON-ZERO exit in which ZERO TESTS RAN. Counting that
# as a flake "red" produces a detector that reports 6/6 red having never executed
# the test once (measured, 2026-07-12). A soak lane that cannot tell "the race
# fired" from "the runner died" is worse than no lane: it manufactures evidence.
#
# So a run counts as RED only if tests actually EXECUTED and at least one FAILED.
# An infrastructure error is INVALID — surfaced loudly, never scored.
classify_run() {
  local log="/tmp/flake-soak-run.$$.log" rc="$1"
  if grep -qE "Failed to start .* worker|Timeout waiting for worker to respond|Test Files  no tests|No test files found" "$log" 2>/dev/null; then
    echo "invalid"; return
  fi
  if [ "$rc" -eq 0 ]; then echo "pass"; else echo "red"; fi
}

pass=0; fail=0
declare -a RESULTS=()

banner() {
  echo "──────────────────────────────────────────────────────────────"
  echo " flake-soak: $1"
  echo "   pkg=$CWD  repeats=$REPEATS  cores=$CORES (cpuset $CPUSET)  load=$LOAD hogs  nice=$NICE"
  echo "   target=${*:2}"
  echo "──────────────────────────────────────────────────────────────"
}

if [ -n "$SELFTEST_FIXTURE" ]; then
  # -------- self-test mode: the fixture MUST redden ------------------------
  case "$SELFTEST_FIXTURE" in
    *.flakeproof.test.tsx|*.flakeproof.test.ts) : ;;
    *) echo "flake-soak: --self-test fixture must be a *.flakeproof.test.tsx file" >&2; exit 2 ;;
  esac
  # Sibling contention was a THEORY THAT DIDN'T SURVIVE MEASUREMENT: running the
  # fixture alongside its whole directory on pinned cores reddened it 0/6. What
  # actually reproduces the race is the competing-hog load above (being niced
  # relative to normal-priority work), which is orthogonal to how many test files
  # run. So the default stays on the DIRECTORY (a real soak should cover the suite
  # you care about anyway), but --isolate is a first-class, fully-supported mode —
  # it is faster and reddens the fixture just as well (1/10, 0 invalid).
  local_target="$SELFTEST_FIXTURE"
  if [ "$ISOLATE" -eq 0 ]; then
    local_target="$(dirname "$SELFTEST_FIXTURE")"
  fi
  banner "SELF-TEST (expect RED) $SELFTEST_FIXTURE" "$local_target"
  for i in $(seq 1 "$REPEATS"); do
    run_once "FLAKE_SOAK_SELFTEST=1" "$local_target"; rc=$?
    case "$(classify_run "$rc")" in
      pass)    pass=$((pass+1));       printf "  run %2d/%d  PASS\n" "$i" "$REPEATS" ;;
      red)     fail=$((fail+1));       printf "  run %2d/%d  \033[31mRED\033[0m (real test failure)\n" "$i" "$REPEATS"
               # Keep the log: a red is only trustworthy if you can read WHY it
               # reddened. An unexamined red is how a congestion artifact gets
               # mistaken for the race it was supposed to prove.
               cp /tmp/flake-soak-run.$$.log "/tmp/flake-soak-selftest-red-${i}.$$.log" 2>/dev/null || true ;;
      invalid) invalid=$((invalid+1)); printf "  run %2d/%d  \033[33mINVALID\033[0m (runner died — 0 tests ran; NOT scored)\n" "$i" "$REPEATS" ;;
    esac
  done
  echo "──────────────────────────────────────────────────────────────"
  echo " self-test: $fail RED / $pass PASS / $invalid INVALID  over $REPEATS runs"
  if [ "$invalid" -gt 0 ]; then
    echo " ⚠️  $invalid run(s) never executed a test (worker start timeout) — the"
    echo "    load is so heavy the RUNNER dies instead of the race firing. Those are"
    echo "    NOT flake evidence. Lower --load / raise --cores before trusting this."
  fi
  if [ "$fail" -ge 1 ]; then
    echo " ✅ throttle DISCRIMINATES — the lane reddened a known load-flake for real."
    exit 0
  fi
  echo " ❌ fixture never reddened for a real reason — the lane failed to"
  echo "    reproduce a known load-flake. Do NOT trust it until fixed."
  exit 1
fi

# -------- normal mode: the target must stay ALL-green --------------------
banner "SOAK (expect all PASS)" "${VITEST_ARGS[*]:-<whole $CWD suite>}"
for i in $(seq 1 "$REPEATS"); do
  run_once "" "${VITEST_ARGS[@]}"; rc=$?
  case "$(classify_run "$rc")" in
    pass)    pass=$((pass+1));       printf "  run %2d/%d  PASS\n" "$i" "$REPEATS" ;;
    red)     fail=$((fail+1));       printf "  run %2d/%d  \033[31mRED\033[0m (real test failure)\n" "$i" "$REPEATS"
             cp /tmp/flake-soak-run.$$.log "/tmp/flake-soak-fail-${i}.$$.log" 2>/dev/null || true ;;
    invalid) invalid=$((invalid+1)); printf "  run %2d/%d  \033[33mINVALID\033[0m (runner died — 0 tests ran; NOT scored)\n" "$i" "$REPEATS" ;;
  esac
done

SCORED=$(( pass + fail ))
echo "──────────────────────────────────────────────────────────────"
if [ "$SCORED" -eq 0 ]; then
  echo " ⚠️  NO VALID RUNS ($invalid invalid) — every run died before executing a"
  echo "    test. This is a verdict about the LOAD, not about the code. Lower"
  echo "    --load / raise --cores and re-run; do not read this as green OR red."
  exit 2
fi
RED_RATE=$(( fail * 100 / SCORED ))
echo " soak result: $pass PASS / $fail RED over $SCORED valid runs  (red-rate ${RED_RATE}%)${invalid:+  [$invalid invalid, not scored]}"
if [ "$fail" -eq 0 ]; then
  echo " ✅ stable under load ($CORES cores, $LOAD competing hogs)."
  exit 0
fi
echo " ❌ FLAKY under load — failing-run logs at /tmp/flake-soak-fail-*.$$.log"
exit 1
