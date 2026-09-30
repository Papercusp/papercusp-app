#!/usr/bin/env bash
# b9-attestation-precondition.selftest.sh — guards the WI-5064 precondition
# machinery in scenarios/b9-attestation.sh (LEG4, attestation_unattested_device).
#
# WHY THIS EXISTS. LEG4's entire assertion rests on a precondition it establishes
# by hand: B's device_attestations must be EMPTY on frame a so the author device
# resolves to no member. That precondition has now failed in three different ways,
# each time producing a confident verdict about the FEATURE instead of about the
# rig:
#   WI-6046                  the strip UPDATE silently no-opped (frame a degraded)
#   EI-18717083046734203     the probe's authorship was refused for a different reason
#   WI-5064 / run 164022     the strip was UNDONE mid-leg by federation, and the
#                            receipt was APPLIED — read as the refusal feature failing
# The third one is structural: pot_members is a FEDERATED table, the leg strips
# only frame a, and then waits ~155s while frame b still holds the value — so any
# reconnect/catch-up sync (replication_soak(87) runs 5 kill/restart cycles right
# before this leg at 89) restores it. The fix strips BOTH replicas, re-asserts
# immediately before the probe, and re-reads the strip at SCORING time so every
# verdict can distinguish "rig precondition broke" from "product did not refuse".
#
# WHAT IT ASSERTS. The restore helper's real behaviour under a stubbed drv_psql
# (both-frames restore, read-back verification, and the deliberate WARN-not-fail
# semantics), plus static wiring asserts for the parts that live inside the
# monolithic core function and cannot be called in isolation. Hermetic: no docker,
# no ssh, no PG, no network.
#
#   bash bin/lib/b9-attestation-precondition.selftest.sh   # exit 0 = PASS
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCN="$DIR/scenarios/b9-attestation.sh"

fails=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fails=$((fails + 1)); }

[ -f "$SCN" ] || { echo "FAIL — cannot find $SCN"; exit 1; }

matrix_register() { :; }
# shellcheck disable=SC1090
source "$SCN"

declare -f _att_restore_b_devices >/dev/null \
  || { echo "FAIL — _att_restore_b_devices missing from $SCN (WI-5064 restore wrapper removed?)"; exit 1; }

echo "── b9-attestation-precondition.selftest: WI-5064 precondition + restore ──"

RIG_HIVE_ID='mx-selftest-pot'
# The stub records every UPDATE it is asked to run, per frame, and answers the
# read-back from CASE_BACK_<frame>. That is enough to assert both WHICH frames the
# helper writes and how it reports the read-back.
declare -A WROTE=()
drv_psql() {
  local inst="$1" sql="$2"
  case "$sql" in
    UPDATE*) WROTE[$inst]=$(( ${WROTE[$inst]:-0} + 1 )); printf '\n' ;;
    SELECT*jsonb_array_length*)
      case "$inst" in
        a) printf '%s\n' "$CASE_BACK_A" ;;
        b) printf '%s\n' "$CASE_BACK_B" ;;
      esac ;;
    *) printf '\n' ;;
  esac
}

# The helper must NOT be run in a command substitution: `$(...)` forks a SUBSHELL, so
# the WROTE[] bookkeeping the stub writes would never reach this shell and every
# frame-write assertion below would read 0 and pass/fail for the wrong reason (it did,
# on first run). A redirect does not fork, so capture to a temp file and read it back.
TMPOUT="$(mktemp)"
trap 'rm -f "$TMPOUT"' EXIT
reset_case() { WROTE=(); : >"$TMPOUT"; }

# 1. Both frames saved ⇒ both frames restored, and both read-backs reported.
reset_case
_ATT_SAVED_OK=1 _ATT_SAVED_ROW='[{"device_pubkey":"aaa"}]' _ATT_SAVED_GH_ID=4242
_ATT_SAVED_B_OK=1 _ATT_SAVED_ROW_B='[{"device_pubkey":"aaa"}]'
CASE_BACK_A=1 CASE_BACK_B=1
_att_restore_b_devices >"$TMPOUT" 2>&1; out="$(cat "$TMPOUT")"
[ "${WROTE[a]:-0}" -ge 1 ] && [ "${WROTE[b]:-0}" -ge 1 ] \
  && ok "both frames saved → UPDATE issued on a AND b" \
  || bad "both frames saved → expected an UPDATE on a and b, got a=${WROTE[a]:-0} b=${WROTE[b]:-0}"
grep -q 'restored .*on frame a' <<<"$out" && grep -q 'restored .*on frame b' <<<"$out" \
  && ok "both restores reported" \
  || bad "both restores should be reported, got: $out"

# 2. Frame b never saved (its pre-strip read failed) ⇒ b must NOT be written. Writing
#    an unsaved b would leave B's own replica holding whatever we invented.
reset_case
_ATT_SAVED_OK=1 _ATT_SAVED_ROW='[{"device_pubkey":"aaa"}]' _ATT_SAVED_GH_ID=4242
_ATT_SAVED_B_OK=0 _ATT_SAVED_ROW_B=''
CASE_BACK_A=1 CASE_BACK_B=0
_att_restore_b_devices >"$TMPOUT" 2>&1; out="$(cat "$TMPOUT")"
[ "${WROTE[b]:-0}" = 0 ] && ok "b unsaved → b is NOT written" || bad "b unsaved → b must not be written, got ${WROTE[b]:-0}"
[ "${WROTE[a]:-0}" -ge 1 ] && ok "b unsaved → a is still restored" || bad "b unsaved → a should still be restored"

# 3. A read-back of 0 on either frame must WARN, never claim success — a silent
#    restore miss would hand revocation_kcut(90) a device-less member and make its
#    failure look like a revocation regression.
reset_case
_ATT_SAVED_OK=1 _ATT_SAVED_ROW='[{"device_pubkey":"aaa"}]' _ATT_SAVED_GH_ID=4242
_ATT_SAVED_B_OK=1 _ATT_SAVED_ROW_B='[{"device_pubkey":"aaa"}]'
CASE_BACK_A=0 CASE_BACK_B=0
_att_restore_b_devices >"$TMPOUT" 2>&1; out="$(cat "$TMPOUT")"
[ "$(printf '%s' "$out" | grep -c 'WARN')" -ge 2 ] \
  && ok "read-back 0 on both frames → WARN on both" \
  || bad "read-back 0 should WARN on both frames, got: $out"
# 3b. …and it must RETRY before warning. The leg now runs at 79, ahead of the churn band,
#     so a lost restore strands FOUR later legs (restart/reconnect/soak/revocation) against a
#     device-less member instead of only revocation_kcut(90). A single-shot write that loses a
#     race is exactly the failure that would produce four unexplained reds, so the write is
#     bounded-retried until the read-back confirms it. This pins the retry, not just the WARN.
[ "${WROTE[a]:-0}" -ge 2 ] && [ "${WROTE[b]:-0}" -ge 2 ] \
  && ok "read-back 0 → the restore RETRIES on both frames (a=${WROTE[a]} b=${WROTE[b]} writes)" \
  || bad "read-back 0 should retry the restore on both frames, got a=${WROTE[a]:-0} b=${WROTE[b]:-0}"

# 4. Nothing saved at all ⇒ a complete no-op (the leg failed before the strip).
reset_case
_ATT_SAVED_OK=0 _ATT_SAVED_B_OK=0 _ATT_SAVED_ROW='' _ATT_SAVED_ROW_B='' _ATT_SAVED_GH_ID=4242
CASE_BACK_A=0 CASE_BACK_B=0
_att_restore_b_devices >"$TMPOUT" 2>&1; out="$(cat "$TMPOUT")"
[ "${WROTE[a]:-0}" = 0 ] && [ "${WROTE[b]:-0}" = 0 ] && [ -z "$out" ] \
  && ok "nothing saved → complete no-op" \
  || bad "nothing saved → expected no writes and no output, got a=${WROTE[a]:-0} b=${WROTE[b]:-0} out='$out'"

# 5-9. STATIC WIRING. These live inside the ~200-line core function, which cannot be
# invoked without a live 2-frame rig — so pin them by source, the same way the
# seat-offer selftest pins its call site. Each pattern is the load-bearing half of a
# fix that a well-meaning cleanup would otherwise silently drop.
static() {
  local label="$1" pat="$2"
  grep -Eq "$pat" "$SCN" && ok "$label" || bad "$label — pattern not found in $SCN: $pat"
}
static "strip runs on frame b too (federated row cannot be re-synced back)" \
       "_ATT_SAVED_B_OK.*=.*1.*\&\&.*drv_psql b \"UPDATE harness_shared\.pot_members SET device_attestations='\[\]'"
static "precondition is RE-ASSERTED after the cache wait, before the probe" \
       "precondition drifted"
static "an unholdable precondition FAILS as rig, explicitly NOT as a product defect" \
       "PRECONDITION UNHOLDABLE.*NOT a product defect"
static "strip is re-read at SCORING time (strip_at_scoring)" \
       "strip_at_scoring=\"?\\\$\\(drv_psql a"
static "the applied-not-refused case names its two candidate readings" \
       "APPLIED, NOT REFUSED"
static "PASS verdict also reports strip-at-scoring (a PASS on a broken precondition is not a PASS)" \
       "refused-op OK on a GENUINE second frame.*strip-at-scoring"

# 10-16. EI-18737225233571148 — THE MISDIAGNOSIS GUARD. The leg's FAIL explanation used to key
# off `reasons` (a hive-wide `LIKE 'receipt-apply:%' ORDER BY updated_at DESC LIMIT 3` read) and,
# on merely SEEING responder_mismatch in it, printed "RIG/ENVIRONMENTAL ... Do not open a fresh
# investigation off this signature alone". In gate run 133957 that verdict was WRONG and it
# suppressed the real WI-5064 first-green investigation for hours: LEG3(60) bumps
# responder_mismatch, and the churn legs between 60 and 89 RETRY that same receipt until it is
# the most-recently-updated reason at scoring time — while THIS leg's probe caused no refusal at
# all. The counter ASSERT had been hardened against exactly this stale-rebump hazard (WI-5779:
# scope to the one reason this leg causes); the EXPLANATION never was.
#
# The fix is a per-reason before/after DIFF (`reasons_moved`), so a verdict cites only refusals
# that moved inside this leg's window. Both halves are load-bearing and neither is visible to
# any other test, so pin them — INCLUDING the negative: reading recency-ordered `reasons` to
# CLASSIFY is the defect itself, and a well-meaning "simplification" back to it would restore a
# confident wrong answer with no other guard in the tree noticing.
static_not() {
  local label="$1" pat="$2" body
  # Comments are allowed to quote the old behaviour (the file documents its own history) —
  # only a LIVE line may not. Strip comment-only lines before matching.
  #
  # WI-40595: capture the producer to completion, THEN match — deliberately not a
  # pipeline. Under this file's `set -o pipefail`, `grep -vE … | grep -Eq …` reports a
  # MATCH as a MISS whenever the early-exiting consumer SIGPIPEs the producer
  # (PIPESTATUS=[141 0]; measured 11/3000 under CPU contention on the sibling b3
  # selftest, which is how it reddened green-checkpoint candidate 4bd9c405). Here the
  # sense is inverted, so the race is WORSE than a flaky red: it takes the else branch
  # and reports a live banned pattern as PASS. Do NOT restore the pipeline.
  body="$(grep -vE '^[[:space:]]*#' "$SCN")" || true
  if grep -Eq "$pat" <<<"$body"; then
    bad "$label — pattern IS present on a live (non-comment) line in $SCN: $pat"
  else
    ok "$label"
  fi
}
static "reasons_before is snapshotted BEFORE the probe, sorted by REASON and UNBOUNDED (a stable set, no LIMIT window a reason can fall out of)" \
       "reasons_before=.*ORDER BY reason;"
static "reasons_after is read the same stable way at scoring time" \
       "reasons_after=.*ORDER BY reason;"
static "the before/after DIFF is actually computed (reasons_moved)" \
       "for _tok in \\\$reasons_after"
static "the responder_mismatch verdict is gated on reasons_MOVED, not on whatever was most recent" \
       "printf '%s' \"\\\$reasons_moved\" \\| grep -q 'receipt-apply:responder_mismatch='"
static "the 'nothing moved at all' case is reported as a probe that never reached receipt-apply" \
       "PROBE NEVER REACHED THE APPLY PATH"
static_not "no live verdict prints the RIG/ENVIRONMENTAL suppression that misdiagnosed 3/3 runs" \
           "RIG/ENVIRONMENTAL"
static_not "no live line CLASSIFIES off the recency-ordered \$reasons read (that read is diagnostic-only now)" \
           "printf '%s' \"\\\$reasons\" \\| grep -q"
# 10-12. DRIFT ATTRIBUTION (2026-07-26). The leg used to name a SUSPECT for the restored
# precondition ("re-federated from the other replica") without ever measuring it — and the two
# candidate writers demand OPPOSITE fixes (a re-announcing PROJECTION write is fixed by
# ordering; the admission path's clock-free UNION merge cannot be fixed by ordering at all).
# One paired row fingerprint separates them, so the leg must take it and print it.
static "a per-frame row fingerprint helper exists (origin + clock + author + device count)" \
       "_att_row_fingerprint\(\) \{"
static "the fingerprint is baselined at strip time, so 'newer than the strip' is decidable" \
       "strip_fp_a=\"\\\$\(_att_row_fingerprint a"
# WI-40586: this pin used to be the verbatim sentence "WHICH WRITER — read the fingerprint, do
# not guess". Rewording the verdict's VERB (read → corroborate, 7922ef3b) reddened the guard for
# ~3h without any invariant having changed. Pin the INVARIANT, not the prose: the directive
# ("WHICH WRITER"), the METHOD it names ("fingerprint"), and — the part a comment cannot fake —
# the fingerprint being actually CITED in the emitted message (${strip_fp_a...}). Deliberately
# loose on the connecting verb; deliberately strict on all three of those. It still fails if the
# fingerprint citation is dropped, if the directive is dropped, or if the verdict degrades back
# to naming a suspect in prose. Do NOT re-tighten this to an exact sentence.
static "the UNHOLDABLE verdict names WHICH writer by fingerprint, not by suspicion" \
       "WHICH WRITER.*fingerprint.*\\\$\{strip_fp_a"
static "the ordering ceiling below the churn band is recorded where the leg is registered" \
       "matrix_register attestation_unattested_device 79"

echo
if [ "$fails" = 0 ]; then
  echo "PASS — b9-attestation-precondition selftest (all checks)"
  exit 0
fi
echo "FAIL — b9-attestation-precondition selftest: $fails check(s) failed"
exit 1
