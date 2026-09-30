#!/usr/bin/env bash
# scripts/tauri-surface-verify-suite.sh
# gui-e2e-tauri-surface-verification-2026-08-27 P-008 — aggregate runner for
# every P-003..P-007 live, Tauri-driven, regression-failing surface leg, so
# the suite can run UNATTENDED on a schedule (see
# packages/operator-core/lib/system-health/gui-e2e-surface-scheduled-run.ts,
# registered in packages/operator-core/lib/dbos/periodic-workflows.ts) rather
# than only being invoked by hand, one leg at a time.
#
# Runs each leg SEQUENTIALLY, each through its OWN
# scripts/verify-tauri-headless.sh boot — never concurrently. The legs
# already documented real GPU/Xvfb contention when run by hand at the same
# time as a peer's verification (see tauri-surface-verify-p004-gym.sh's own
# "contention: N live verifier instance(s)" log line); serializing here is
# deliberate, not an oversight.
#
# Each leg's own PASS/FAIL line (`P0\d\d_TAURI_SURFACE_VERIFY_(OK|FAIL)
# leg=<name> output=<dir>`) is captured verbatim in this script's stdout —
# that is the machine-parseable contract the scheduled producer greps for.
# This script's own summary line (`P008_TAURI_SURFACE_SUITE_(OK|FAIL)
# legs=... output=<dir>`) additionally names the run as a whole.
#
# Exit code is nonzero iff at least one leg failed. Per the scheduled
# producer's own module doc, a nonzero exit here is a FOUND REGRESSION to
# escalate (via the shared alarm-attention rail), never a producer-tick
# failure. This script does not read or write anything the release /
# green-checkpoint gate consults — WI-40086 owns that gate, and P-008
# deliberately never touches it (plan Decision, gui-e2e-tauri-surface-
# verification-2026-08-27).
#
# Manual invocation (from the repo root, or from anywhere — cwd is fixed
# below): bash scripts/tauri-surface-verify-suite.sh
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_SUITE_OUT:-/tmp/pcv-suite-$STAMP}"
mkdir -p "$OUT_DIR"

# "<leg name>:<needs VERIFY_TAURI_ISOLATED_DB=1>:<script path>"
# `gym` and `embed-device` need isolation — both make real API writes and must
# never touch shared live state (see their script headers). `embed-device`
# additionally needs the ready seed because its target is a post-onboarding
# Settings route; the runner handles that one special seed below.
# `rubrics-wiki` explicitly must run WITHOUT isolation (an isolated-DB boot's
# first-run onboarding redirect defeats its cross-route reload assertions —
# see that script's own header). Every other leg is indifferent and runs
# against the live shared workspace like an ordinary agent verification pass.
LEGS=(
  "quick-panel:0:scripts/tauri-surface-verify-p003-quick-panel.sh"
  "rubrics-wiki:0:scripts/tauri-surface-verify-p004-rubrics-wiki.sh"
  "gym:1:scripts/tauri-surface-verify-p004-gym.sh"
  "cloud-eval:0:scripts/tauri-surface-verify-p005-cloud-eval.sh"
  "prompt-studio:0:scripts/tauri-surface-verify-p006-prompt-studio.sh"
  "login:0:scripts/tauri-surface-verify-p007-login.sh"
  "settings:0:scripts/tauri-surface-verify-p007-settings.sh"
  "embed-device:1:scripts/tauri-surface-verify-embed-device.sh"
  "signup:0:scripts/tauri-surface-verify-p007-signup.sh"
  # Added post-P-007-expansion (gui-e2e-tauri-surface-verification-2026-08-27
  # D-012): the P-007 spec-upgrade item grew to cover 14 surfaces total, but
  # this suite's LEGS array was written before that expansion landed and only
  # ever ran the first 8. Backfilling the rest here so the scheduled/CI suite
  # actually matches everything P-007 verified — none of these need isolation,
  # same as every leg above except `gym`.
  "admin:0:scripts/tauri-surface-verify-p007-admin.sh"
  "adv:0:scripts/tauri-surface-verify-p007-adv.sh"
  "coord:0:scripts/tauri-surface-verify-p007-coord.sh"
  "cupboard:0:scripts/tauri-surface-verify-p007-cupboard.sh"
  "design:0:scripts/tauri-surface-verify-p007-design.sh"
  "dev:0:scripts/tauri-surface-verify-p007-dev.sh"
  "installed:0:scripts/tauri-surface-verify-p007-installed.sh"
  "pi:0:scripts/tauri-surface-verify-p007-pi.sh"
  "res:0:scripts/tauri-surface-verify-p007-res.sh"
  "setup:0:scripts/tauri-surface-verify-p007-setup.sh"
  "support:0:scripts/tauri-surface-verify-p007-support.sh"
  "users:0:scripts/tauri-surface-verify-p007-users.sh"
)

OK_LEGS=()
FAILED_LEGS=()

for entry in "${LEGS[@]}"; do
  IFS=: read -r leg needs_isolated script <<<"$entry"
  echo "=== leg: $leg ($script) ==="
  if [ ! -f "$script" ]; then
    echo "P0XX_TAURI_SURFACE_VERIFY_FAIL leg=$leg (script not found: $script)"
    FAILED_LEGS+=("$leg")
    continue
  fi
  log_file="$OUT_DIR/$leg.log"
  if [ "$leg" = "embed-device" ]; then
    VERIFY_TAURI_ISOLATED_DB=1 \
      VERIFY_TAURI_ISOLATED_SEED=ready \
      VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS='Embedding device' \
      scripts/verify-tauri-headless.sh -- bash "$script" >"$log_file" 2>&1
  elif [ "$needs_isolated" = "1" ]; then
    VERIFY_TAURI_ISOLATED_DB=1 scripts/verify-tauri-headless.sh -- bash "$script" >"$log_file" 2>&1
  else
    scripts/verify-tauri-headless.sh -- bash "$script" >"$log_file" 2>&1
  fi
  rc=$?
  tail -n 8 "$log_file"
  if [ "$rc" -eq 0 ]; then
    OK_LEGS+=("$leg")
  else
    FAILED_LEGS+=("$leg")
  fi
done

echo "=== SUITE SUMMARY ==="
for leg in "${OK_LEGS[@]}"; do echo "  OK   $leg"; done
for leg in "${FAILED_LEGS[@]}"; do echo "  FAIL $leg"; done
echo "ok=${#OK_LEGS[@]} failed=${#FAILED_LEGS[@]} output=$OUT_DIR"

if [ "${#FAILED_LEGS[@]}" -gt 0 ]; then
  echo "P008_TAURI_SURFACE_SUITE_FAIL legs=${FAILED_LEGS[*]} output=$OUT_DIR"
  exit 1
fi
echo "P008_TAURI_SURFACE_SUITE_OK legs=${#OK_LEGS[@]} output=$OUT_DIR"
