#!/usr/bin/env bash
# local-matrix-bank.selftest.sh — regression test for the teardown evidence
# banking in bin/local-matrix.sh (EI-18660101091813036).
#
# WHY: local-matrix.sh's EXIT trap `docker rm -f`s the frames, and each frame's
# /home/pcusp/serve.log is the primary diagnostic every scenario failure line
# points at. rig_bank_logs() in deb-hetzner-rig.sh banks per-scenario-FAIL and at
# the MATRIX's own exit, but it (a) never runs for a failure that happens before
# the matrix starts (provision / wait-sshd / DHT bootstrap / ufw preflight) or
# for a run that is killed, and (b) reads each frame over SSH, so a wedged or
# OOM-killed frame banks "(bank fetch failed …)" instead of the log. This test
# guards the `docker cp`-based teardown banker that closes both gaps — and, just
# as importantly, guards its GAP-FILL contract: it must NOT re-bank when the
# matrix already banked for this run, or it inflates the file/starved counts the
# gate's own _frame_lag_scan() reports and adds another nested snapshot of one
# cumulative log for readers to mistake for an independent run.
#
# Extracts the banker's functions from the REAL local-matrix.sh with sed and
# evals them (same idiom as local-matrix-starvation.selftest.sh) — sourcing the
# script itself would run arg parsing, flock and docker provisioning. `docker` is
# stubbed, so this never touches a real rig/daemon: purely local, <1s.
#
#   bash bin/lib/local-matrix-bank.selftest.sh   # exit 0 = PASS, 1 = FAIL
#
# Why a bash self-test and not Vitest: the unit under test is bash. Mirrors
# rig-bank-logs.selftest.sh / local-matrix-starvation.selftest.sh — the four
# canonical TS/Cargo/LLM frameworks don't host shell units; the live gate is the
# integration test.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable ONLY so falsifiability can be proven against a MUTATED COPY in
# /tmp: mutating the real local-matrix.sh to prove this test can fail would risk
# git-sync committing the mutant (the sweep commits the whole tree on a timer, so
# a probe that holds a file mutated for the length of a run can be swept even
# when nothing goes wrong and no handler fails). Unset in every normal run.
SCRIPT="${LOCAL_MATRIX_SCRIPT:-$DIR/../local-matrix.sh}"

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

[ -f "$SCRIPT" ] || { echo "SKIP: local-matrix.sh not found at $SCRIPT"; exit 0; }

# ── Extract the banker from the shipping source and eval it. Both functions are
#    named in the presence guard on purpose: if _rig_local_run_already_banked
#    fails to extract, rig_local_bank_logs still evals fine and then dies at call
#    time with "command not found" — whose non-zero status reads as "not yet
#    banked", which would DEGENERATE the gap-fill case below into a false pass.
FN_SRC="$(sed -n '/^_rig_local_run_already_banked() {/,/^}/p;/^rig_local_bank_logs() {/,/^}/p' "$SCRIPT")"
if ! grep -q '_rig_local_run_already_banked()' <<<"$FN_SRC" \
  || ! grep -q 'rig_local_bank_logs()' <<<"$FN_SRC"; then
  echo "FAIL — could not extract the banker functions from $SCRIPT (renamed? reindented?)" >&2
  exit 1
fi
# shellcheck disable=SC2086
eval "$FN_SRC" || { echo "FAIL — extracted banker functions do not eval" >&2; exit 1; }

log() { :; }

BANK_TMP="$(mktemp -d)"
CONTENT_TMP="$(mktemp -d)"
trap 'rm -rf "$BANK_TMP" "$CONTENT_TMP"' EXIT

# ── docker stub: a fake daemon whose containers are declared per-case. ────────
# EXISTING_CONTAINERS lists what `docker inspect` resolves; CP_FAIL lists
# containers whose `docker cp` fails (a frame that never wrote a serve.log).
docker() {
  local verb="$1"; shift
  case "$verb" in
    inspect)
      local name="${*: -1}"
      grep -qw -- "$name" <<<"$EXISTING_CONTAINERS" || return 1
      # -f form asks for the state line; the bare form is the existence probe.
      [[ "$*" == *-f* ]] && echo "exited exit=137 oom=true started=2026-08-11T18:00:00Z"
      return 0 ;;
    cp)
      local src="${1%%:*}" dest="$2"
      grep -qw -- "$src" <<<"$CP_FAIL" && return 1
      printf '[2026-08-11T18:00:01.000Z] FAKE-SERVE-LOG-%s\n[2026-08-11T18:00:09.000Z] [event-loop-lag] maxMs: 2500\n' "$src" >"$dest"
      return 0 ;;
    logs)  echo "FAKE-DHT-LOG"; return 0 ;;
    *)     return 0 ;;
  esac
}
export -f docker 2>/dev/null || true

reset_env() {
  RIG_BANK_DIR="$BANK_TMP/bank-$RANDOM-$$"; mkdir -p "$RIG_BANK_DIR"
  RIG_BANK_KEEP=200
  RIG_LOCAL_T0="$(date +%s)"
  CN_A=pcusp-rig-a; CN_B=pcusp-rig-b; CN_C=pcusp-rig-c
  NET=pcusp-local-rig
  EXISTING_CONTAINERS="pcusp-rig-a pcusp-rig-b pcusp-local-rig-dht"
  CP_FAIL=""
  PCUSP_LOCAL_RIG_BANK=auto
}

# ── 1. THE FIX: a run that reaches teardown with nothing banked banks the
#       frames' serve.log via docker cp, before anything is destroyed. ─────────
reset_env
rig_local_bank_logs
a_file="$(ls "$RIG_BANK_DIR"/serve-a-*.log 2>/dev/null | head -1)"
b_file="$(ls "$RIG_BANK_DIR"/serve-b-*.log 2>/dev/null | head -1)"
if [ -f "$a_file" ] && [ -f "$b_file" ] \
  && grep -q 'FAKE-SERVE-LOG-pcusp-rig-a' "$a_file" \
  && grep -q 'FAKE-SERVE-LOG-pcusp-rig-b' "$b_file"; then
  ok "banks every existing frame's serve.log via docker cp when nothing was banked yet"
else
  bad "frame serve.logs were NOT banked at teardown: a='$a_file' b='$b_file'"
fi

# ── 2. A frame that never provisioned (c, on a 2-frame run) is skipped, not
#       banked as an empty/misleading file. ──────────────────────────────────
if [ -z "$(ls "$RIG_BANK_DIR"/serve-c-*.log 2>/dev/null)" ]; then
  ok "a container that does not exist is skipped (no phantom serve-c bank file)"
else
  bad "banked a file for frame c, which was never provisioned"
fi

# ── 3. The bank filename matches the gate's own serve-*.log scan glob, so a
#       killed run's frames feed check_local_matrix_frame_starvation. ─────────
marker="$CONTENT_TMP/marker"; touch -d "@$((RIG_LOCAL_T0 - 5))" "$marker"
scanned="$(find "$RIG_BANK_DIR" -maxdepth 1 -name 'serve-*.log' -newer "$marker" 2>/dev/null | wc -l)"
if [ "$scanned" -eq 2 ]; then
  ok "banked files are found by the gate's 'serve-*.log -newer' scan (2 frames)"
else
  bad "gate scan glob found $scanned banked frame log(s), expected 2"
fi

# ── 4. The DHT container's log is banked too (the ONLY place a bootstrap
#       failure is diagnosable) — and NOT under serve-*, so the gate's frame
#       scan cannot count it as a frame. ─────────────────────────────────────
dht_file="$(ls "$RIG_BANK_DIR"/dht-*.log 2>/dev/null | head -1)"
if [ -f "$dht_file" ] && grep -q 'FAKE-DHT-LOG' "$dht_file" \
  && [ "$scanned" -eq 2 ]; then
  ok "DHT container log is banked, and is excluded from the frame scan glob"
else
  bad "DHT log missing ('$dht_file') or it leaked into the serve-*.log frame scan"
fi

# ── 5. THE GAP-FILL CONTRACT: when the matrix already banked for this run,
#       auto mode writes NOTHING (no duplicate nested snapshot, no inflated
#       gate counts). ──────────────────────────────────────────────────────────
reset_env
printf 'already banked by the matrix\n' >"$RIG_BANK_DIR/serve-a-120000.log"
rig_local_bank_logs
if [ "$(ls "$RIG_BANK_DIR"/serve-*-*-teardown.log 2>/dev/null | wc -l)" -eq 0 ]; then
  ok "auto mode does NOT re-bank when a serve-*.log for this run already exists"
else
  bad "auto mode re-banked over the matrix's own bank (duplicate nested snapshot)"
fi

# ── 6. ...but a bank file OLDER than this run does not suppress it (that is a
#       previous run's evidence, not this one's). ─────────────────────────────
reset_env
touch -d "@$((RIG_LOCAL_T0 - 3600))" "$RIG_BANK_DIR/serve-a-110000.log"
rig_local_bank_logs
if [ "$(ls "$RIG_BANK_DIR"/serve-*-*-teardown.log 2>/dev/null | wc -l)" -gt 0 ]; then
  ok "a PREVIOUS run's bank file does not suppress this run's teardown bank"
else
  bad "an older run's bank file wrongly suppressed banking for this run"
fi

# ── 7. =always forces a bank even when this run already has one; =never
#       disables it entirely. ──────────────────────────────────────────────────
reset_env
printf 'already banked\n' >"$RIG_BANK_DIR/serve-a-120000.log"
PCUSP_LOCAL_RIG_BANK=always rig_local_bank_logs
forced="$(ls "$RIG_BANK_DIR"/serve-*-*-teardown.log 2>/dev/null | wc -l)"
reset_env
PCUSP_LOCAL_RIG_BANK=never rig_local_bank_logs
disabled="$(ls "$RIG_BANK_DIR"/serve-*.log 2>/dev/null | wc -l)"
if [ "$forced" -gt 0 ] && [ "$disabled" -eq 0 ]; then
  ok "PCUSP_LOCAL_RIG_BANK=always forces a bank; =never disables banking"
else
  bad "mode overrides wrong: always banked $forced file(s) (want >0), never banked $disabled (want 0)"
fi

# ── 8. THE SSH-SCOPED GAP: a frame whose serve.log cannot be copied still gets
#       a bank file that SAYS SO, plus the container state (exit code /
#       OOMKilled) — which is the whole reason to prefer docker cp over ssh:
#       an unreachable frame is exactly the one you need to read. ─────────────
reset_env
CP_FAIL="pcusp-rig-b"
rig_local_bank_logs
b_file="$(ls "$RIG_BANK_DIR"/serve-b-*.log 2>/dev/null | head -1)"
if [ -f "$b_file" ] && grep -q 'could be copied out of container' "$b_file" \
  && grep -q 'oom=true' "$b_file"; then
  ok "an uncopyable frame banks an explicit note + its container state (exit/OOMKilled)"
else
  bad "a frame with no readable serve.log left no explanatory bank file: '$b_file'"
fi

# ── 9. Every bank file carries the cumulative-log + absent-subject-id caveats,
#       so a reader cannot mistake a nested snapshot for an independent run or
#       read a grep miss as evidence of absence (EI-18687774064705397 /
#       EI-18744109084137549). ─────────────────────────────────────────────────
reset_env
rig_local_bank_logs
a_file="$(ls "$RIG_BANK_DIR"/serve-a-*.log 2>/dev/null | head -1)"
bank_header="$(head -1 "$a_file" 2>/dev/null || true)"
if grep -q 'CUMULATIVE' <<<"$bank_header" \
  && grep -q 'NO scenario/subject ids' <<<"$bank_header" \
  && grep -q '2026-08-11T18:00:01' <<<"$bank_header"; then
  ok "each bank file is stamped with its coverage window + both evidence caveats"
else
  bad "bank file header is missing the cumulative/subject-id caveats or its time span"
fi

# ── 10. Banking is best-effort: an unwritable bank dir must not fail the run
#        (this function is called from the EXIT trap — a non-zero return there
#        would mask the run's real verdict). ─────────────────────────────────
reset_env
RIG_BANK_DIR="/proc/definitely-not-writable/bank"
if rig_local_bank_logs; then
  ok "an unwritable bank dir returns success (never masks the run's verdict)"
else
  bad "banking returned non-zero on an unwritable dir — it can mask the run verdict"
fi

echo
if [ "$FAILS" -gt 0 ]; then
  echo "FAIL — $FAILS local-matrix teardown-banking check(s) failed"
  exit 1
fi
echo "PASS — local-matrix teardown evidence banking (EI-18660101091813036) verified"
