#!/usr/bin/env bash
# b3-revocation-kcut.selftest.sh — guards the revocation K-CUT detector's
# falsifiability: the K-CUT device resolver, leak classifier, and WI-6043's
# source-write precondition for the post-ban negative assertion.
#
# WHY THIS EXISTS. Both probes were previously wrong in the one way a live run can
# never reveal — they produced a CONFIDENT verdict that was structurally incapable of
# being different:
#
#   1. K-CUT device resolution. The old lookup took an ARBITRARY element of B's
#      device_attestations array (`jsonb_array_elements(...) ... LIMIT 1`). By order 90,
#      scenario order 60 (attestation_membership LEG2) has merged a SYNTHETIC device into
#      that array: d2="att2dev-${rid}-$RANDOM". That is a label, not a key — it can never
#      equal a base64 member_device_pubkey — so `rig_assert_row_absent ...
#      member_device_pubkey='att2dev-…'` returned "absent" unconditionally and the
#      scenario printed "K-CUT VERIFIED" on EVERY banked run, INCLUDING run 223522
#      (2026-08-06) whose content leg failed with a real leak. Measured in all four banked
#      runs: "B device=att2dev-m1786068697-27155" beside a dump of base64 pubkeys.
#
#   2. Leak classification. The LEAK-detail line called rig_read_content — which returns
#      `harness_slug||'|'||origin`, i.e. table METADATA from the same table and predicate
#      rig_assert_absent had already probed — and labelled a '*|remote' result "READABLE
#      plaintext disclosure". It restated the arrival fact under a label that escalated it.
#      Delivery is not disclosure: revocation is designed as a DECRYPT cut, so a banned
#      member holding sealed bytes is expected behaviour, not a breach.
#
# WHAT IT ASSERTS. Each probe is driven under a stubbed drv_psql across the shapes that
# decide it, INCLUDING a calibration case that must come out the other way — a test where
# every case passes for the same reason is the defect this file exists to prevent.
# Hermetic: no docker, no ssh, no PG, no network.
#
#   bash bin/lib/b3-revocation-kcut.selftest.sh   # exit 0 = PASS
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# B3_SCENARIO_SRC lets a falsifiability probe point this at a MUTATED COPY outside the
# tree (scripts/mutation-probe.sh tier 2) instead of mutating the shared checkout, where
# git-sync would commit the mutant mid-probe. Defaults to the real file.
SCN="${B3_SCENARIO_SRC:-$DIR/scenarios/b3-revocation.sh}"
RIG_LIB="${RIG_LIB_SRC:-$DIR/deb-hetzner-rig.sh}"
STANDALONE="$DIR/../deb-hetzner-revocation.sh"

fails=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fails=$((fails + 1)); }

[ -f "$SCN" ] || { echo "FAIL — cannot find $SCN"; exit 1; }
[ -f "$RIG_LIB" ] || { echo "FAIL — cannot find $RIG_LIB"; exit 1; }
[ -f "$STANDALONE" ] || { echo "FAIL — cannot find $STANDALONE"; exit 1; }

matrix_register() { :; }
# shellcheck disable=SC1090
source "$SCN"
# shellcheck disable=SC1090
source "$RIG_LIB"

# live_has <file> <fixed-string> — does a NON-COMMENT line of <file> contain <fixed-string>?
#
# WI-40595. Deliberately NOT a pipeline. The obvious spelling —
#   grep -vE '^[[:space:]]*#' "$f" | grep -Fq 'PAT'
# — is unsafe under this file's `set -o pipefail`: `grep -Fq` exits the instant it
# matches, the still-writing producer takes SIGPIPE (141), and pipefail promotes that
# to the pipeline's status, so a MATCH is reported as a MISS. Measured here:
# PIPESTATUS=[141 0] on 11/3000 runs under CPU contention, 0/400 idle. That is exactly
# how this selftest passed green-checkpoint isolation attempt 1 and failed attempt 2 on
# byte-identical files, freezing candidate 4bd9c405 with a guard nobody had broken.
# Capture the producer's output to completion first, then match it. Do NOT "simplify"
# this back into a pipeline.
live_has() {
  local src="$1" pat="$2" body
  body="$(grep -vE '^[[:space:]]*#' "$src")" || true
  grep -Fq -- "$pat" <<<"$body"
}

for fn in _rv_key_bearing_device _rv_classify_leak; do
  declare -f "$fn" >/dev/null \
    || { echo "FAIL — $fn missing from $SCN (EI-18712383368117845 probe removed or inlined again?)"; exit 1; }
done

# The helper cases above prove the two decisions in isolation. These source-level
# checks prove that scn_revocation_kcut still wires those decisions to the real
# probes. A unit-only test would stay green if a future edit quietly switched the
# leak detail back to rig_read_content (metadata) or stopped filtering the device
# resolver by a pre-ban key (the two integration failures this item covers).
if awk '!/^[[:space:]]*#/ && /EXISTS/ && /k\.epoch < \$maxep/ { found=1 }
        END { if (found) exit 0; exit 1 }' "$SCN"; then
  ok "K-CUT integration: resolver filters attested devices by a pre-ban epoch key"
else
  bad "K-CUT integration: resolver no longer selects a key-bearing pre-ban device"
fi

if live_has "$SCN" 'rig_read_content b "$FPOST"'; then
  bad "leak integration: detail path still re-reads metadata through rig_read_content"
else
  ok "leak integration: detail path does not re-read the arrival predicate"
fi

if live_has "$SCN" 'SELECT title FROM harness_shared.harness_features_consolidated'; then
  ok "leak integration: detail path reads the replicated content column"
else
  bad "leak integration: detail path no longer reads replicated content"
fi

if awk '!/^[[:space:]]*#/ && /_rv_classify_leak[[:space:]]+"\$leaked_title"[[:space:]]+"\$post_title"/ { found=1 }
        END { if (found) exit 0; exit 1 }' "$SCN"; then
  ok "leak integration: classifier compares observed bytes with the exact written title"
else
  bad "leak integration: classifier is not wired to the observed and written content"
fi

declare -A FRAME_USER=([a]=owner-user [b]=member-user)

# ── The stub. It answers _rv_key_bearing_device's query the way PG would, from a table of
#    (device_pubkey, max epoch it holds a key at) pairs in $STUB_DEVICES: "pk:epoch" rows,
#    where epoch=-1 means "attested but holds no epoch key at all" (the att2dev shape).
#    The stub honours the query's `epoch < $maxep` filter, so the resolver's real
#    discriminating clause is what decides each case — not the stub's mood.
STUB_DEVICES=""
STUB_CALLS=0
STUB_WS="workspace-rigtest"
STUB_INSERT_RC=0
SQL_LOG="$(mktemp)"
ERR_LOG="$(mktemp)"
trap 'rm -f "$SQL_LOG" "$ERR_LOG"' EXIT
drv_psql() {
  local sql="${2:-}"   # drv_psql <inst> <sql>

  STUB_CALLS=$((STUB_CALLS + 1))
  printf '%s\n' "$sql" >>"$SQL_LOG"
  if [[ "$sql" == *"SELECT workspace_id FROM harness_shared.pot_members"* ]]; then
    printf '%s\n' "$STUB_WS"
    return 0
  fi
  if [[ "$sql" == *"INSERT INTO harness_shared.harness_features_consolidated"* ]]; then
    return "$STUB_INSERT_RC"
  fi
  local maxep row pk ep
  maxep="$(printf '%s' "$sql" | sed -n 's/.*k\.epoch < \([0-9]\+\).*/\1/p')"
  [ -n "$maxep" ] || return 0
  for row in $STUB_DEVICES; do
    pk="${row%%:*}"; ep="${row##*:}"
    if [ "$ep" != "-1" ] && [ "$ep" -lt "$maxep" ]; then echo "  $pk  "; return 0; fi
  done
  return 0
}

echo "── b3-revocation-kcut.selftest: EI-18712383368117845 probes ──"

echo "K-CUT device resolver"

# CALIBRATION — the case that must come out NON-EMPTY. Without it, every assertion below
# could be satisfied by a resolver that simply always returns nothing.
STUB_DEVICES="RealPubKeyAAA=:0"
got="$(_rv_key_bearing_device 1)"
[ "$got" = "RealPubKeyAAA=" ] \
  && ok "calibration: a device holding an epoch-0 key resolves at maxep=1 (got '$got')" \
  || bad "calibration FAILED: expected 'RealPubKeyAAA=', got '$got' — the resolver returns nothing even when a key-bearing device exists, so every case below would pass vacuously"

# THE REGRESSION. The exact live shape: the synthetic att2dev device is FIRST in the array
# (as it was in all four banked runs), the real key-bearing device second.
STUB_DEVICES="att2dev-m1786068697-27155:-1 RealPubKeyAAA=:0"
got="$(_rv_key_bearing_device 1)"
[ "$got" = "RealPubKeyAAA=" ] \
  && ok "skips the synthetic att2dev device and resolves the key-bearing one (got '$got')" \
  || bad "resolved '$got' — a device that never held an epoch key makes the absence assert unfalsifiable (the pre-fix behaviour)"

# FAIL-CLOSED. Only the synthetic device attested ⇒ empty ⇒ the caller scores UNMEASURED
# rather than printing K-CUT VERIFIED.
STUB_DEVICES="att2dev-m1786068697-27155:-1"
got="$(_rv_key_bearing_device 1)"
[ -z "$got" ] \
  && ok "returns EMPTY when only the synthetic device is attested (caller must score UNMEASURED, never VERIFIED)" \
  || bad "returned '$got' for a devices set holding no epoch key — this is the exact false VERIFIED that ran on every banked run"

# A device whose only key is AT the post-ban epoch is not a pre-ban holder, so it cannot
# calibrate the cut either.
STUB_DEVICES="RealPubKeyAAA=:1"
got="$(_rv_key_bearing_device 1)"
[ -z "$got" ] \
  && ok "excludes a device whose only key is at the post-ban epoch itself" \
  || bad "returned '$got' for a device with no key BELOW maxep — nothing was cut, so the assert would be vacuous"

echo "leak classifier"

WRITTEN="revocation post-ban (must be ABSENT on banned B)"
got="$(_rv_classify_leak "$WRITTEN" "$WRITTEN")"
[ "$got" = DISCLOSURE ] \
  && ok "exact plaintext title on B ⇒ DISCLOSURE" \
  || bad "exact plaintext match classified '$got' — a real breach would be under-reported"

got="$(_rv_classify_leak "hello-world|remote" "$WRITTEN")"
[ "$got" = SEALED ] \
  && ok "the retracted 'hello-world|remote' metadata reading ⇒ SEALED, not DISCLOSURE" \
  || bad "classified '$got' — this is the exact string the old probe labelled READABLE plaintext disclosure"

got="$(_rv_classify_leak "" "$WRITTEN")"
[ "$got" = UNREADABLE ] \
  && ok "empty read ⇒ UNREADABLE (probe error or sealed), never DISCLOSURE" \
  || bad "classified '$got' — an unread probe must never be reported as a disclosure finding"

echo "source-write precondition"

# CALIBRATION: the helper must author under the Pot home, not the member-repo
# slug its historical API still receives. Migrations 651/652 reject the latter.
: >"$SQL_LOG"; : >"$ERR_LOG"
RIG_HIVE_ID="pot-home-rigtest"; STUB_INSERT_RC=0
got="$(rig_write_content a member-repo-slug F-RV-WRITE "post-ban bytes" todo 2>"$ERR_LOG")"; rc=$?
insert_sql="$(grep 'INSERT INTO harness_shared.harness_features_consolidated' "$SQL_LOG" || true)"
if [ "$rc" = 0 ] && [ "$got" = F-RV-WRITE ] \
  && grep -q "'workspace-rigtest','pot-home-rigtest','F-RV-WRITE'" <<<"$insert_sql" \
  && ! grep -q "'member-repo-slug'" <<<"$insert_sql"; then
  ok "rig_write_content authors under the resolved Pot home and emits the fid only after success"
else
  bad "rig_write_content Pot-home write: rc=$rc got='$got' sql='$insert_sql' err='$(cat "$ERR_LOG")'"
fi

# THE REGRESSION: a rejected post-ban INSERT must be observable as failure and
# must not emit the fid (which callers historically treated as authored).
: >"$SQL_LOG"; : >"$ERR_LOG"
STUB_INSERT_RC=42
got="$(rig_write_content a member-repo-slug F-RV-REJECT "post-ban bytes" todo 2>"$ERR_LOG")"; rc=$?
if [ "$rc" -ne 0 ] && [ -z "$got" ] \
  && grep -q 'source write was rejected' "$ERR_LOG"; then
  ok "rig_write_content propagates a rejected INSERT instead of reporting a phantom write"
else
  bad "rejected INSERT did not fail closed: rc=$rc got='$got' err='$(cat "$ERR_LOG")'"
fi

# Wiring guard: the helper's nonzero is only protective if both revocation
# drivers check it BEFORE entering rig_assert_absent. Ignore comments so a prose
# mention cannot keep the test green after the executable guard is removed.
if live_has "$SCN" 'if ! rig_write_content a "$oslug" "$FPOST" "$post_title" todo'; then
  ok "matrix revocation leg checks post-ban authoring before its negative assert"
else
  bad "matrix revocation leg can still run a vacuous negative assert after a rejected post-ban write"
fi
if live_has "$STANDALONE" 'if ! rig_write_content "$OWNER" "$oslug" "$FPOST"'; then
  ok "standalone revocation leg checks post-ban authoring before its negative assert"
else
  bad "standalone revocation leg can still run a vacuous negative assert after a rejected post-ban write"
fi

echo
if [ "$fails" -eq 0 ]; then echo "b3-revocation-kcut.selftest: PASS"; exit 0; fi
echo "b3-revocation-kcut.selftest: FAIL ($fails)"; exit 1
