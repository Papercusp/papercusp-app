#!/usr/bin/env bash
# rig-bank-logs.selftest.sh — regression test for rig_bank_logs() in
# deb-hetzner-rig.sh, specifically the EI-18660101091813036 (2026-07-26) fix:
# an optional `tag` arg so a FAILING scenario can bank serve.log MID-RUN
# (deb-hetzner-matrix.sh's scenario loop now calls `rig_bank_logs "$id"` on
# every FAIL), not only once at the very end via the EXIT trap. Guards the
# regression this issue exists to prevent: a killed/never-clean-exit run, or
# an investigation into scenario N's failure after scenario N+3 already
# overwrote the frame's (cumulative) serve.log picture, silently loses its
# evidence again.
#
# Lives in bin/lib/ (not bin/lib/scenarios/) for the same reason
# rig-wait-converged.selftest.sh does: deb-hetzner-matrix.sh's
# source_scenarios() sources every bin/lib/scenarios/*.sh at the top of a
# real run, so a selftest living there would be swept in and its stubbed
# drv_exec/fed_log would silently clobber the real ones for the whole run.
#
# Sources the REAL rig lib (the shipping code, not a copy) and exercises
# rig_bank_logs() against STUBBED drv_exec/drv_applog/fed_log, so this never
# touches a real rig/docker/SSH — purely local, <1s.
#
#   bash bin/lib/rig-bank-logs.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$DIR/deb-hetzner-rig.sh"
[ -f "$LIB" ] || { echo "SKIP: rig lib not found at $LIB"; exit 0; }

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

fed_log() { : ; }

# shellcheck disable=SC1090
source "$LIB" >/dev/null 2>&1 || true

# ── stubs MUST come after the source: the rig lib defines the real drv_*. ──
drv_exec() {  # <inst> — reads the remote "command" off stdin, ignored; returns
              # deterministic fake content keyed by frame so we can assert on it.
  local inst="$1" cmd; cmd="$(cat)"
  case "$cmd" in
    *loadavg*) echo "FAKE-LOADAVG-$inst" ;;
    *)         echo "FAKE-SERVE-LOG-CONTENT-$inst" ;;
  esac
}
drv_applog() { echo "/home/pcusp/serve.log"; }
fed_log() { : ; }
# WI-6070: rig_bank_logs' host-load capture runs `command -v docker && docker
# stats --no-stream`. On a box that HAS docker that is a real ~4s call against
# the live daemon, once per bank — which made this "purely local, <1s" selftest
# take 40s AND quietly depend on the host's docker state (it would report other
# agents' containers, or hang if the daemon were wedged). `command -v` resolves
# a shell function, so stubbing it here keeps the code path exercised while
# cutting the runtime ~40x and making the test genuinely hermetic. Runtime is
# not cosmetic here: a 40s test is one nobody wires into a gate, which is how
# these selftests ended up dark in the first place (EI-18725214765732588).
docker() { echo "FAKE-DOCKER-STATS"; }

BANK_TMP="$(mktemp -d)"
WORK_TMP="$(mktemp -d)"
trap 'rm -rf "$BANK_TMP" "$WORK_TMP"' EXIT

reset_env() {
  RIG_BANK_DIR="$BANK_TMP/bank-$RANDOM"; mkdir -p "$RIG_BANK_DIR"
  RIG_BANK_KEEP=200
  RIG_WORK=""
  declare -ga RIG_FRAMES=(a b)
  declare -gA FRAME_IP=([a]=10.99.0.11 [b]=10.99.0.12)
}

# ── 1. no tag (the original end-of-run call shape) → stamp has NO trailing tag ─
reset_env
rig_bank_logs
files="$(ls "$RIG_BANK_DIR"/serve-a-*.log 2>/dev/null)"
if [ -n "$files" ] && ! grep -qE '^serve-a-[0-9]{6}-.+\.log$' <<<"$(basename "$files")"; then
  ok "no-tag call → plain HHMMSS stamp, no trailing tag in the filename"
else
  bad "no-tag call produced unexpected filename(s): $files"
fi

# ── 2. content is actually banked per frame (both a and b) ───────────────────
reset_env
rig_bank_logs
a_file="$(ls "$RIG_BANK_DIR"/serve-a-*.log 2>/dev/null | head -1)"
b_file="$(ls "$RIG_BANK_DIR"/serve-b-*.log 2>/dev/null | head -1)"
if [ -f "$a_file" ] && [ -f "$b_file" ] \
  && grep -q "FAKE-SERVE-LOG-CONTENT-a" "$a_file" \
  && grep -q "FAKE-SERVE-LOG-CONTENT-b" "$b_file" \
  && grep -q "FAKE-LOADAVG-a" "$a_file"; then
  ok "banks per-frame serve.log content for every frame in RIG_FRAMES"
else
  bad "missing/empty per-frame bank files: a='$a_file' b='$b_file'"
fi

# ── 3. THE FIX: a tag arg (a scenario id) is folded into the stamp ────────────
reset_env
rig_bank_logs "restart_durability"
tagged="$(ls "$RIG_BANK_DIR"/serve-a-*-restart_durability.log 2>/dev/null | head -1)"
if [ -f "$tagged" ] && grep -q "FAKE-SERVE-LOG-CONTENT-a" "$tagged"; then
  ok "tag arg (scenario id) is folded into the banked filename — mid-run per-scenario bank works"
else
  bad "tagged bank file not found/empty — expected serve-a-<HHMMSS>-restart_durability.log, dir has: $(ls "$RIG_BANK_DIR" 2>/dev/null | tr '\n' ' ')"
fi

# ── 4. two on-FAIL banks in the same run (different scenario ids) both land ───
reset_env
rig_bank_logs "scenario_one"
rig_bank_logs "scenario_two"
n_one="$(ls "$RIG_BANK_DIR"/serve-a-*-scenario_one.log 2>/dev/null | wc -l)"
n_two="$(ls "$RIG_BANK_DIR"/serve-a-*-scenario_two.log 2>/dev/null | wc -l)"
if [ "$n_one" = 1 ] && [ "$n_two" = 1 ]; then
  ok "multiple on-FAIL banks in one run each land as their OWN distinctly-tagged file (no clobber)"
else
  bad "expected exactly 1 file per tag, got scenario_one=$n_one scenario_two=$n_two"
fi

# ── 5. RIG_FRAMES empty AFTER frames were registered → still LOUD (WI-5380 ───
#      regression), tag or not. This is the genuine state-loss case: frames
#      WERE registered earlier in the run (RIG_FRAMES_EVER_REGISTERED>0) and
#      something wiped RIG_FRAMES since.
reset_env
declare -ga RIG_FRAMES=()
RIG_FRAMES_EVER_REGISTERED=1
rig_bank_logs "some_scenario"
empty_marker="$(ls "$RIG_BANK_DIR"/BANK-EMPTY-*.txt 2>/dev/null | head -1)"
if [ -f "$empty_marker" ]; then
  ok "RIG_FRAMES empty AFTER frames were registered (even with a tag) still writes the loud BANK-EMPTY marker — WI-5380 class not silently reintroduced"
else
  bad "no BANK-EMPTY marker written when RIG_FRAMES was empty after frames were registered (genuine WI-5380 case)"
fi

# ── 5b. EI-18657462128167571 fix: RIG_FRAMES empty because NO frame was ever ──
#       registered (e.g. a run that exited before rig_set_identity, such as an
#       early rig_gate_artifact failure) must NOT write the loud BANK-EMPTY
#       alarm — there was never anything to lose.
reset_env
declare -ga RIG_FRAMES=()
RIG_FRAMES_EVER_REGISTERED=0
rig_bank_logs "some_scenario"
empty_marker="$(ls "$RIG_BANK_DIR"/BANK-EMPTY-*.txt 2>/dev/null | head -1)"
if [ -z "$empty_marker" ]; then
  ok "RIG_FRAMES empty with NO frame ever registered stays quiet — no false-positive WI-5380 alarm (EI-18657462128167571)"
else
  bad "BANK-EMPTY marker wrongly written when no frame was ever registered this run: $empty_marker"
fi

# ── 5c. rig_set_identity bumps RIG_FRAMES_EVER_REGISTERED (the discriminator ──
#       itself, not just its downstream effect on rig_bank_logs) ──────────────
reset_env
declare -ga RIG_FRAMES=()
RIG_FRAMES_EVER_REGISTERED=0
gh() { echo "FAKE-GH-TOKEN"; }  # stub: rig_set_identity shells out to `gh auth token`
rig_set_identity a fakeuser >/dev/null 2>&1
if [ "${RIG_FRAMES_EVER_REGISTERED:-0}" -gt 0 ]; then
  ok "rig_set_identity bumps RIG_FRAMES_EVER_REGISTERED"
else
  bad "rig_set_identity did not bump RIG_FRAMES_EVER_REGISTERED (got '$RIG_FRAMES_EVER_REGISTERED')"
fi
unset -f gh

# ── 5d. EI-18687774064705397 fix: banked serve.log gets a coverage-window ─────
#       header (first/last in-content timestamp) so nested/cumulative captures
#       are visible at read time instead of silently read as independent runs.
reset_env
drv_exec() {  # override: emit two bracketed timestamps so first != last
  local inst="$1" cmd; cmd="$(cat)"
  case "$cmd" in
    *loadavg*) echo "FAKE-LOADAVG-$inst" ;;
    *) printf '[2026-07-26T05:59:08.366Z] [serve] boot %s\n[2026-07-26T06:02:16.650Z] [serve] tail %s\n' "$inst" "$inst" ;;
  esac
}
rig_bank_logs
ts_file="$(ls "$RIG_BANK_DIR"/serve-a-*.log 2>/dev/null | head -1)"
bank_header="$(head -1 "$ts_file" 2>/dev/null || true)"
if [ -f "$ts_file" ] \
  && grep -q "CUMULATIVE for the whole rig session" <<<"$bank_header" \
  && grep -qF '05:59:08.366Z' <<<"$bank_header" \
  && grep -qF '06:02:16.650Z' <<<"$bank_header" \
  && grep -q "\[serve\] boot a" "$ts_file"; then
  ok "banked serve.log is stamped with its own first/last content timestamp + a cumulative-log warning, ahead of the real content"
else
  bad "coverage-window header missing/wrong in banked file: $(head -1 "$ts_file" 2>/dev/null)"
fi
# restore the original stub for any later checks in this file
drv_exec() {
  local inst="$1" cmd; cmd="$(cat)"
  case "$cmd" in
    *loadavg*) echo "FAKE-LOADAVG-$inst" ;;
    *)         echo "FAKE-SERVE-LOG-CONTENT-$inst" ;;
  esac
}

# ── 6. RIG_WORK's scn.*.log files are still copied in (untouched by the fix) ──
reset_env
RIG_WORK="$WORK_TMP"
echo "scenario raw output" >"$RIG_WORK/scn.restart_durability.log"
rig_bank_logs "restart_durability"
scn_bank="$(ls "$RIG_BANK_DIR"/scn.restart_durability-*.log 2>/dev/null | head -1)"
if [ -f "$scn_bank" ] && grep -q "scenario raw output" "$scn_bank"; then
  ok "RIG_WORK/scn.*.log per-scenario raw-output banking is unaffected by the tag-arg change"
else
  bad "scn.*.log bank missing/empty: $scn_bank"
fi

# ── 7. WI-6070: a TAGGED (on-FAIL) bank also lands a prune-exempt fail/ bundle ─
reset_env
RIG_WORK="$WORK_TMP"
echo "the leak line" >"$RIG_WORK/scn.revocation_kcut.log"
rig_bank_logs "revocation_kcut"
fail_dir="$(ls -1d "$RIG_BANK_DIR"/fail/*/ 2>/dev/null | head -1)"
if [ -n "$fail_dir" ] \
  && ls "$fail_dir"/serve-a-*.log >/dev/null 2>&1 \
  && grep -rq "the leak line" "$fail_dir" 2>/dev/null; then
  ok "tagged (on-FAIL) bank ALSO bundles its evidence into a prune-exempt fail/<stamp>/ dir"
else
  bad "no fail/<stamp>/ bundle for a tagged bank — dir has: $(ls -R "$RIG_BANK_DIR" 2>/dev/null | tr '\n' ' ')"
fi

# ── 7b. THE REGRESSION WI-6070 EXISTS TO PREVENT: later PASSING runs trip the ─
#       flat FIFO and unlink the flat names — the FAIL evidence must SURVIVE
#       that, because it is hardlinked into fail/. This is exactly what
#       destroyed the only banked artifact of the WI-6043 revocation leak.
reset_env
RIG_WORK="$WORK_TMP"
RIG_BANK_KEEP=1               # tiny, so the very next bank prunes almost everything
echo "the leak line" >"$RIG_WORK/scn.revocation_kcut.log"
rig_bank_logs "revocation_kcut"                     # the FAIL bank
rm -f "$RIG_WORK"/scn.*.log                          # later runs have their own scn logs
rig_bank_logs                                        # a PASSING run banks + prunes
rig_bank_logs                                        # ...and another
flat_left="$(ls "$RIG_BANK_DIR"/scn.revocation_kcut-*.log 2>/dev/null | wc -l)"
if grep -rq "the leak line" "$RIG_BANK_DIR"/fail/ 2>/dev/null; then
  ok "FAIL evidence survives later PASSING runs tripping the flat FIFO (flat copies left: $flat_left) — WI-6070 regression guarded"
else
  bad "FAIL evidence was destroyed by subsequent passing runs — WI-6070 has regressed (this is the exact WI-6043 evidence loss)"
fi

# ── 7c. an UNTAGGED (end-of-run) bank must NOT create a fail/ bundle ──────────
reset_env
rig_bank_logs
if [ ! -d "$RIG_BANK_DIR/fail" ]; then
  ok "untagged (ordinary end-of-run) bank creates no fail/ bundle — only FAIL banks are prune-exempt"
else
  bad "untagged bank wrongly created a fail/ bundle: $(ls -1d "$RIG_BANK_DIR"/fail/*/ 2>/dev/null | tr '\n' ' ')"
fi

# ── 7d. the fail/ bundles are themselves bounded (in DIRS, by ─────────────────
#       RIG_BANK_FAIL_KEEP) so this can never grow without limit.
reset_env
RIG_BANK_FAIL_KEEP=2
rig_bank_logs "scn_one"; rig_bank_logs "scn_two"; rig_bank_logs "scn_three"
n_fail_dirs="$(ls -1d "$RIG_BANK_DIR"/fail/*/ 2>/dev/null | wc -l)"
if [ "$n_fail_dirs" -le 2 ] && [ "$n_fail_dirs" -ge 1 ]; then
  ok "fail/ bundles are bounded separately by RIG_BANK_FAIL_KEEP dirs (kept $n_fail_dirs of 3)"
else
  bad "RIG_BANK_FAIL_KEEP=2 did not bound the fail/ bundles — got $n_fail_dirs dirs"
fi

# ── 8. EI-18744109084137549: a FAIL bundle must be HONEST about the fact that ─
#      serve-*.log carries no scenario/subject ids — both as a standalone
#      README a triager finds by `ls`, and inline in every serve-*.log's own
#      header (so the caveat travels with the file even if it's copied out of
#      the bundle on its own).
reset_env
rig_bank_logs "seat_offer"
fail_dir="$(ls -1d "$RIG_BANK_DIR"/fail/*/ 2>/dev/null | head -1)"
if [ -n "$fail_dir" ] \
  && [ -f "$fail_dir/README-SCOPE-CAVEAT.txt" ] \
  && grep -qi "do not record scenario/subject ids" "$fail_dir/README-SCOPE-CAVEAT.txt" 2>/dev/null; then
  ok "FAIL bundle carries a standalone README-SCOPE-CAVEAT.txt warning that serve-*.log has no subject ids"
else
  bad "FAIL bundle is missing (or has a wrong) README-SCOPE-CAVEAT.txt — dir has: $(ls "$fail_dir" 2>/dev/null | tr '\n' ' ')"
fi
serve_bank="$(ls "$RIG_BANK_DIR"/serve-a-*.log 2>/dev/null | head -1)"
if [ -f "$serve_bank" ] && grep -q "ABSENCE here is NOT evidence" "$serve_bank" 2>/dev/null; then
  ok "every banked serve-*.log's own header carries the subject-id-absence caveat (survives being copied out of the fail/ bundle alone)"
else
  bad "serve-*.log header is missing the subject-id-absence caveat: $serve_bank"
fi

echo
if [ "$FAILS" = 0 ]; then echo "PASS — rig_bank_logs selftest"; exit 0; fi
echo "FAIL — $FAILS check(s) failed"; exit 1
