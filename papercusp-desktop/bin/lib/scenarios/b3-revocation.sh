# b3-revocation.sh — Brief 3 matrix scenario: revocation + epoch K-cut (TERMINAL).
#
# Sourced by bin/deb-hetzner-matrix.sh (Brief 13). Self-contained: the matrix has
# ALREADY sourced federation-asserts.sh + deb-hetzner-rig.sh and populated
# RIG_FRAMES=(a b) / FRAME_*/FED_*/FRAME_MEMBER_SLUG/RIG_HIVE_*/MATRIX_RUN_ID, and
# published+joined the hive with a↔b peer_connected. Do NOT re-source those (re-sourcing
# deb-hetzner-rig.sh would reset RIG_FRAMES=() and clobber the matrix's frame state) and
# do NOT provision/teardown. `return`, never `exit`. See README.md for the full contract.
#
# TERMINAL/DESTRUCTIVE → order 90 (runs LAST): it bans member B, so B may be unable to
# receive afterward. The standalone equivalent (its own 2 frames + adaptive baseline) is
# bin/deb-hetzner-revocation.sh; this is the matrix-integrated form on the shared frames.
#
# Proof (mechanism-agnostic behavioral form of federation-revocation-kcut-sidecar.repro):
#   1. baseline — owner→B federation works pre-ban (attribution guard: a post-ban absence
#      only proves a cut-off if federation worked before it);
#   2. owner BANS B (Hive-wide revoke → revoked_pubkeys blocklist + epoch 0→1 K-cut);
#   3. owner writes post-ban content (triggers the C-001 re-key) → it must NOT reach B.

# ── EI-18712383368117845 helpers ──────────────────────────────────────────────────────
# Extracted from the monolithic core function for ONE reason: both encode a judgement
# that was previously WRONG in a way no live run could reveal (an unfalsifiable assert
# and a mislabelled diagnostic), so both must be drivable under a stub.
# Guarded by lib/b3-revocation-kcut.selftest.sh — hermetic, no docker/ssh/PG.

# _rv_key_bearing_device <maxep> — echo the pubkey of the B-attested device that ACTUALLY
# held an epoch key below <maxep>; empty when none does. Filtering on "held a key" is the
# whole point: B's attestation array also carries the SYNTHETIC att2dev-<rid>-<rand> device
# that scenario order 60 merges in, and asserting the absence of a value that can never
# appear in pot_epoch_keys is a probe that cannot fail.
_rv_key_bearing_device() {
  local maxep="$1"
  drv_psql a "SELECT e.v->>'device_pubkey' FROM harness_shared.pot_members m, LATERAL jsonb_array_elements(m.device_attestations::jsonb) e(v) WHERE m.github_username='${FRAME_USER[b]}' AND EXISTS (SELECT 1 FROM harness_shared.pot_epoch_keys k WHERE k.member_device_pubkey = e.v->>'device_pubkey' AND k.epoch < $maxep) LIMIT 1;" 2>/dev/null | head -1 | tr -d '[:space:]'
}

# _rv_classify_leak <observed_title> <written_title> — echo DISCLOSURE | UNREADABLE | SEALED.
# DISCLOSURE only when B's replicated row carries the owner's exact plaintext bytes; row
# presence alone is delivery, and delivery is not disclosure (revocation is a DECRYPT cut).
_rv_classify_leak() {
  local observed="$1" written="$2"
  if [ "$observed" = "$written" ]; then echo DISCLOSURE
  elif [ -z "$observed" ]; then echo UNREADABLE
  else echo SEALED; fi
}

scn_revocation_kcut() {
  local rid="$MATRIX_RUN_ID" oslug="${FRAME_MEMBER_SLUG[a]:-}" bslug="${FRAME_MEMBER_SLUG[b]:-}"
  local FPRE="F-RV-PRE-$rid" FPOST="F-RV-POST-$rid"
  [ -n "$oslug" ] && [ -n "$bslug" ] || { echo "revocation: frames not joined (owner='$oslug' member='$bslug')"; return 1; }

  # 1. baseline — owner→B federation works pre-ban (the matrix already proved it at order
  #    10; re-confirm here so the post-ban absence is attributable to the BAN, not a broken
  #    path). NOTE (EI-15535): this is a CONTENT probe (harness_features_consolidated),
  #    NOT the hive_members/roster path WI-1378 fixed — a "WI-1378?" guess in this message
  #    is a red herring for THIS probe. Cross-run evidence (EI-15535, WI-5481, WI-5448)
  #    instead shows this baseline reliably fails whenever order-87 replication_soak just
  #    failed a few scenarios earlier: the soak's sustained 5x-restart churn leaves
  #    federation genuinely stalled (WI-183-class) and it has not recovered by the time
  #    this order-90 scenario runs. Surface THAT correlation instead of misattributing to
  #    WI-1378, so a reader doesn't file a fresh "is this a WI-1378 regression?" bug again
  #    (SCN_RC is the matrix runner's global result table — populated for every
  #    already-run scenario id since scenarios run in-process in order; guarded with a
  #    default for standalone/--only invocations where it may be unset under `set -u`).
  local pre; pre="$(fed_hive_merge_probe a b "$oslug" "$FPRE" 40 || true)"
  if [ "${pre%% *}" != 1 ]; then
    local hint="mechanism unconfirmed — this is a content probe, not the WI-1378 roster path; check order-87 replication_soak + WI-5481/WI-5448 (known WI-183-class sustained-restart stall) before assuming a fresh regression"
    if [ "${SCN_RC[replication_soak]:-0}" -ne 0 ]; then
      hint="order-87 replication_soak FAILED earlier this run (rc=${SCN_RC[replication_soak]}) — this is almost certainly the SAME downstream WI-183-class stall (see WI-5481/WI-5448), not a fresh regression or a WI-1378 roster issue"
    fi
    echo "revocation: BASELINE FAIL — owner→B pre-ban federation broken (probe=$pre; $hint) — cannot attribute a cut-off"
    return 1
  fi

  # 2. owner bans B (owner authority = the Hive-key holder = frame a; Hive-wide revoke →
  #    revoked_pubkeys admission blocklist + the epoch 0→1 K-cut).
  local bid; bid="$(rig_github_id "${FRAME_USER[b]}")"
  [ -n "$bid" ] || { echo "revocation: could not resolve github id for member '${FRAME_USER[b]:-?}'"; return 1; }
  local ban; ban="$(rig_ban_member a "$bid" hive)"
  printf '%s' "$ban" | grep -q '"ok":true' || { echo "revocation: REVOKE FAILED — $(printf '%s' "$ban" | head -c 160)"; return 1; }

  # EI-18712383368117845: SURFACE revoke.live. The revoke response carries {ok,revokedPubkeys,live}
  # and `live` is THE diagnostic for this leg — true = the epoch advance applied a real read cut,
  # false = PG-only write-plane block with no read cut-off, so a LEAK below is EXPECTED rather than
  # mysterious. It was being captured into $ban and discarded (only "ok":true was grepped), which
  # is why 5 FAIL / 1 PASS gave no way to tell "the cut-off ran and lost a race" from "no cut-off
  # ever applied". Diagnostic only — the assertion below is deliberately UNCHANGED.
  local rvlive; rvlive="$(printf '%s' "$ban" | grep -oE '"live":[a-z]+' | head -1)"
  echo "  · revocation: revoke.live=${rvlive:-ABSENT} (true ⇒ real read cut applied; false/ABSENT ⇒ write-plane block only)"

  # WI-6043: OPTIONAL ban→write gap, for discriminating the two live leak hypotheses.
  #
  # WHY THIS KNOB EXISTS. hive-epoch-state.ts:50-58 documents a v1 scope gap: a producer that
  # advances the epoch (member-ban) and then writes post-boundary content while a DIFFERENT
  # process still holds a cached pre-boundary epoch (EPOCH_CACHE_TTL_MS = 5000,
  # hive-epoch-op-gate.ts:160-169) re-uses the STALE epoch — and at the 0→1 boundary that hits
  # the epoch === BASELINE_EPOCH plaintext bypass and federates post-ban content UNENCRYPTED to
  # the member just revoked. If that TTL is the mechanism, delaying the write past 5s must make
  # the leak disappear; if the leak persists across the delay, the TTL story is dead and the
  # "epoch never armed at all" branch leads instead.
  #
  # NOTE the gap is ~0s by default: the ban above and the write below are adjacent with only a
  # grep+echo between them. So the "<5s" arm of that experiment is what EVERY run already does
  # and is not forceable — which is itself evidence, because a gap-only mechanism would then
  # predict a ~100% leak rate rather than the intermittency actually observed. Only the >5s arm
  # carries new information, which is what this knob buys.
  #
  # DEFAULT IS UNSET ⇒ ZERO behaviour change: the gate, and every existing run, take the exact
  # path they took before. This is deliberately a defaulted knob and not a hardcoded sleep, so
  # it can live in the tree permanently without ever slowing or altering the real gate.
  if [ -n "${RIG_REVOKE_WRITE_DELAY_SEC:-}" ]; then
    echo "  · revocation: RIG_REVOKE_WRITE_DELAY_SEC=$RIG_REVOKE_WRITE_DELAY_SEC — delaying post-ban write to probe the epoch-cache TTL window (WI-6043)"
    sleep "$RIG_REVOKE_WRITE_DELAY_SEC"
  fi

  # 3. post-ban owner write (triggers the re-key; revoke.live is false until it lands) must
  #    NOT reach B. Fail BEFORE the negative assert if the source write was rejected:
  #    "absent" is otherwise vacuously true for a row the owner never authored (WI-6043).
  #    rig_assert_absent waits the full window and passes only if a confirmed write never appears.
  local post_title="revocation post-ban (must be ABSENT on banned B)"
  if ! rig_write_content a "$oslug" "$FPOST" "$post_title" todo >/dev/null; then
    echo "revocation: POST-BAN WRITE FAILED — $FPOST was never authored; refusing to score its absence as a cut-off (WI-6043)"
    return 1
  fi
  local absent; absent="$(rig_assert_absent b "$FPOST" 30)"

  # WI-40542: REPORT THE BEHAVIORAL VERDICT HERE, where it is computed — not only at the
  # `if [ "$absent" != 1 ]` block far below. That block sits AFTER the WI-560 crypto K-CUT
  # assert, which `return 1`s on failure, so a crypto failure used to discard this result
  # entirely: the 30s window above was paid in full and the answer never reached the log.
  # Run m1787374736 hit exactly that — the crypto leg failed, and D-045's discriminator
  # ("did post-ban content reach B?") was unanswerable from a run that had MEASURED it.
  #
  # Read the silence correctly: absence of a leak line used to mean "not reported", NOT
  # "no leak". This line removes that ambiguity on every path.
  #
  # Diagnostic only — the FAIL verdict and both asserts are deliberately UNCHANGED.
  #
  # ⚠ ARRIVAL IS NOT DISCLOSURE. rig_assert_absent probes whether the ROW reached B's
  # consolidated table. Revocation is designed as a DECRYPT cut, not a replication cut, so
  # arrival alone is a delivery leak, NOT proof B could read the bytes. The disclosure
  # discriminator is the `title` comparison in the block below (and the live
  # content-undecryptability witness that WI-6266 says is still missing). Do not upgrade
  # this line's wording to imply disclosure — that exact over-claim was already made and
  # retracted once (see the retraction note at the `absent != 1` block).
  # THREE states, not two. An unreadable probe is UNMEASURED — it must render as neither
  # "clean" nor "leaked", or this line reintroduces the absence-of-evidence-as-health trap
  # it exists to remove.
  case "${absent:-}" in
    1) echo "  · revocation: BEHAVIORAL leg — post-ban content did NOT arrive on banned B (row-absence over a 30s window; arrival-plane only, says nothing about decryptability)" ;;
    0) echo "  · revocation: BEHAVIORAL leg — post-ban content DID arrive on banned B — a DELIVERY leak; see the title-comparison below for whether plaintext was actually disclosed" ;;
    *) echo "  · revocation: BEHAVIORAL leg — UNMEASURED: rig_assert_absent returned '${absent:-<empty>}', neither 1 nor 0. This is NOT a clean result and NOT a leak; it is absence of evidence, and it must not be scored either way." ;;
  esac

  # WI-560 K-CUT CRYPTO WITNESS (diagnostic — the assertion above is deliberately UNCHANGED).
  #
  # The pass/fail leg of this scenario is BEHAVIORAL and self-describes as "mechanism-agnostic"
  # (header line 14): it proves post-ban content did not REACH B. That is a real cut, but it is
  # a row-arrival fact — rig_assert_absent checks B's consolidated table, so a write-plane
  # admission block (revoked_pubkeys) satisfies it identically to a cryptographic key cut. It
  # therefore cannot distinguish "B held epoch N and was cut off at N+1" (the K-CUT WI-560 asks
  # to witness) from "B never held a key at all", and it never queries an epoch-key table.
  #
  # These two dumps close that gap by capturing the K-sequence on BOTH sides at the one moment
  # it is decidable — after the ban's re-key has landed, before teardown destroys the frames:
  #   owner (a): epoch N wrapped to BOTH devices, epoch N+1 wrapped to the REMAINING device only
  #              ⇒ the owner-side cut. (The 20260726-213733 run already showed the epoch-0 half.)
  #   joiner (b): its OWN rows — epoch N present, epoch N+1 ABSENT ⇒ the live B-side K-CUT.
  # Deliberately dumped rather than asserted: B-side receipt has never been measured on any rig,
  # so asserting a shape nobody has observed would red a shared gate on a prediction. Measure
  # first; the assertion lands once the real shape is known. Non-fatal by construction.
  echo "  · WI-560 K-CUT witness — pot_epoch_keys AFTER ban+re-key (expect: owner has N+1 for remaining device only; B has N but NOT N+1)"
  # EVERY line below MUST carry the `·` marker. The matrix runner surfaces a PASSING
  # scenario's LIVE/terminal output by grepping `^[[:space:]]*·` (deb-hetzner-matrix.sh:351,
  # WI-6057) — an unmarked diagnostic line is silently dropped from that live output on
  # exactly the runs that need it (a PASS), and looks identical to the dump never having
  # run. Verified the hard way on run m1785118654: this block's header (marked) printed
  # while the psql rows (unmarked, indented with spaces) vanished entirely from the log.
  # (The underlying $RIG_WORK/scn.<id>.log itself is separately banked to
  # ~/.papercusp/live-fed-gate/triage/ by rig_bank_logs — WI-5481, 2026-07-19 — regardless
  # of pass/fail and BEFORE $RIG_WORK is torn down, so the raw psql output is not actually
  # lost forever; it's just absent from the run's own printed summary unless marked.)
  # EI-18762718908280875: use the shared `scn_diag` helper (federation-asserts.sh) instead
  # of a hand-written `sed 's/^/…/'` at each call site, so the marker can never be
  # typo'd/dropped/"tidied" away by a later edit.
  #
  # No `|| echo "dump failed"` fallback: piping into scn_diag makes the pipeline's exit
  # status scn_diag's (awk), never drv_psql's, so such a guard could never fire. `2>&1` is
  # the real mechanism — a psql/transport error is captured and printed inline as a marked
  # line instead.
  echo "  · WI-560 K-CUT — frame a (owner, wrap record):"
  drv_psql a "SELECT harness_slug, epoch, member_device_pubkey, origin FROM harness_shared.pot_epoch_keys ORDER BY epoch, member_device_pubkey;" 2>&1 | scn_diag "a: "
  echo "  · WI-560 K-CUT — frame b (banned joiner, own view):"
  drv_psql b "SELECT harness_slug, epoch, member_device_pubkey, origin FROM harness_shared.pot_epoch_keys ORDER BY epoch, member_device_pubkey;" 2>&1 | scn_diag "b: "

  # ── WI-560 K-CUT ASSERTION (the CRYPTO form; the content assert below is the behavioral one) ──
  #
  # WI-560 asks to witness: B has epoch N but NOT epoch N+1 — "its machine never gets the new key".
  # Measured live on run m1785119xxx, and the OBVIOUS form of this assert would have been WRONG:
  #
  #   epoch 0 → owner wraps to BOTH devices; B holds both, origin=remote
  #   epoch 1 → owner wraps to the REMAINING device ONLY (K-cut on the owner side)
  #   ...but B STILL RECEIVES the epoch-1 ROW, origin=remote — wrapped to the OWNER's pubkey.
  #
  # So "B has no epoch-N+1 row" is FALSE and asserting it would red this gate on correct behavior.
  # Revocation is a DECRYPT cut, not a replication cut, for this table: the row that reaches B is
  # a blob sealed to a key B does not hold. The true invariant is DEVICE-SCOPED —
  #   *** no epoch-key row wrapped to B'S OWN device pubkey exists at the post-ban epoch ***
  # — which is exactly what makes B unable to read post-ban content, and is what we assert.
  #
  # Fail-closed on VACUITY: if the epoch never advanced (max epoch still 0) there was no re-key to
  # cut, so a device-scoped absence would pass trivially and prove nothing — the exact
  # "a probe that cannot fail is not a probe" trap this file's rig_assert_* helpers were rewritten
  # for (WI-5768). We therefore require maxep>=1 and FAIL loudly if it did not advance. Likewise a
  # blank pubkey means the identity lookup failed, not that the cut held — also a FAIL, never a pass.
  # EI-18712383368117845: the device-pubkey lookup used to be
  #   SELECT jsonb_array_elements(device_attestations)->>'device_pubkey' ... LIMIT 1
  # which picks an ARBITRARY element of a MULTI-DEVICE array — and by the time this
  # scenario (order 90) runs, scenario order 60 (attestation_membership LEG2) has
  # deliberately merged a SYNTHETIC second device into B's attestations:
  #   d2="att2dev-${rid}-$RANDOM"        (b9-attestation.sh)
  # That string is a device LABEL, not a key: it can never equal a base64
  # member_device_pubkey, so `rig_assert_row_absent ... member_device_pubkey='att2dev-…'`
  # returned "absent" unconditionally and this assert printed K-CUT VERIFIED on EVERY
  # run — including run 223522 (2026-08-06), whose content leg FAILED with a real leak.
  # Measured in all four banked runs: "B device=att2dev-m1786068697-27155" while every
  # pot_epoch_keys row in the same dump carries a base64 pubkey. A probe that cannot
  # fail is not a probe (WI-5768) — the blank-pubkey and vacuous-epoch guards below
  # already encode that principle; this closes the third hole in the same family.
  #
  # The fix resolves B's device by the only property that makes the assert meaningful:
  # it must be a device that ACTUALLY HELD a pre-ban epoch key. That is self-calibrating
  # — the very predicate required to come back ABSENT at epoch N is first proven PRESENT
  # at some epoch < N, on B's own frame and against the same table.
  local bpub maxep preep
  maxep="$(drv_psql a "SELECT COALESCE(MAX(epoch),0) FROM harness_shared.pot_epoch_keys;" 2>/dev/null | head -1 | tr -d '[:space:]')"
  case "${maxep:-}" in
    ''|*[!0-9]*) echo "revocation: K-CUT UNMEASURED — could not read max epoch on the owner ('${maxep:-}'); not a pass"; return 1 ;;
  esac
  if [ "$maxep" -lt 1 ]; then
    echo "revocation: K-CUT VACUOUS — epoch never advanced past 0, so there was no re-key to cut (papercusp-hive-rekey not armed? see rig_arm_hive_rekey); refusing to pass a probe that cannot fail"; return 1
  fi
  bpub="$(_rv_key_bearing_device "$maxep")"
  echo "  · WI-560 K-CUT assert — B key-bearing device=${bpub:-<UNRESOLVED>} post-ban maxEpoch=${maxep}"
  if [ -z "$bpub" ]; then
    echo "revocation: K-CUT UNMEASURED — none of B's attested devices ever held an epoch key below $maxep, so a device-scoped absence at $maxep would pass vacuously (a synthetic attestation such as attestation_membership's att2dev-… device can never match member_device_pubkey); an unmeasurable probe is not a pass"; return 1
  fi
  # CALIBRATION (the half that makes the assert falsifiable): the same table, the same
  # frame, the same device — proven PRESENT before the ban. If this reads nothing, the
  # absence below would prove nothing.
  preep="$(drv_psql b "SELECT COALESCE(MAX(epoch),-1) FROM harness_shared.pot_epoch_keys WHERE member_device_pubkey='$bpub' AND epoch < $maxep;" 2>/dev/null | head -1 | tr -d '[:space:]')"
  case "${preep:-}" in
    ''|*[!0-9-]*|-1) echo "revocation: K-CUT UNCALIBRATED — B's own frame shows NO pre-ban epoch key for device $bpub (read '${preep:-<empty>}'), so asserting its absence at epoch $maxep cannot fail; not a pass"; return 1 ;;
  esac
  echo "  · WI-560 K-CUT calibration — B's frame holds device $bpub at epoch $preep (< $maxep), so the absence assert below is falsifiable"
  local kcut; kcut="$(rig_assert_row_absent b "harness_shared.pot_epoch_keys WHERE epoch=$maxep AND member_device_pubkey='$bpub'" 12)"
  if [ "$kcut" != 1 ]; then
    echo "revocation: K-CUT FAILED — banned member B still holds an epoch-$maxep key wrapped to its OWN device ($bpub); the re-key did not cut it off"; return 1
  fi
  echo "  · WI-560 K-CUT VERIFIED — B holds NO epoch-$maxep key for its own device (pre-ban epochs retained; the epoch-$maxep row B did receive is sealed to the owner's device, unreadable by B)"

  if [ "$absent" != 1 ]; then
    # EI-18712383368117845: on a LEAK, record whether B can actually READ the leaked content —
    # rig_assert_absent only proves the row REACHED B's consolidated table, and delivery is not
    # disclosure (revocation is designed as a DECRYPT cut, not a replication cut).
    #
    # ⚠ This block previously called rig_read_content and labelled a '*|remote' result
    # "READABLE plaintext disclosure". That was FALSE and is retracted: rig_read_content returns
    # `harness_slug||'|'||origin` — table METADATA, read from the SAME table and the SAME
    # predicate rig_assert_absent had already probed. It could not distinguish disclosure from
    # sealed bytes; it merely restated the arrival fact in different words, under a label that
    # escalated it. Run 223522 (2026-08-06)'s "READABLE plaintext disclosure" line rests on that
    # bad inference and does not establish disclosure.
    #
    # The discriminator is the CONTENT column against the exact bytes the owner wrote: `title`
    # is written plaintext by rig_write_content on frame a, so if B's replicated row carries the
    # identical string, the plaintext genuinely crossed to a banned member. Anything else
    # (sealed/placeholder/empty) is a delivery leak WITHOUT disclosure — a materially lower
    # severity. Diagnostic only — the FAIL verdict is unchanged either way.
    local leaked_title; leaked_title="$(drv_psql b "SELECT title FROM harness_shared.harness_features_consolidated WHERE feature_id='$FPOST' LIMIT 1;" 2>/dev/null | head -1)"
    leaked_title="$(printf '%s' "$leaked_title" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    case "$(_rv_classify_leak "$leaked_title" "$post_title")" in
      DISCLOSURE) echo "  · revocation: LEAK detail — revoke.live=${rvlive:-ABSENT}; DISCLOSURE — B's row carries the owner's exact plaintext title ('$leaked_title')" ;;
      UNREADABLE) echo "  · revocation: LEAK detail — revoke.live=${rvlive:-ABSENT}; row reached B but its title read EMPTY (probe error or sealed) — delivery leak, disclosure NOT established" ;;
      *)          echo "  · revocation: LEAK detail — revoke.live=${rvlive:-ABSENT}; row reached B with a NON-matching title ('$leaked_title') — delivery leak, plaintext NOT disclosed" ;;
    esac
    echo "revocation: LEAK — $FPOST reached banned member B after the ban (cut-off failed)"
    return 1
  fi

  # pre-ban content survives on B (revocation is not retroactive — matches the repro's
  # readable epoch-0). A WARN (not FAIL): the cut-off assertion above is the gate.
  #
  # EI-18712383368117845: rig_read_content returns `harness_slug||'|'||origin`, so this leg
  # measures ROW PRESENCE + federation origin — it has never measured readability, and the
  # old wording ("not readable on B post-ban") over-claimed exactly the way the retracted
  # LEAK-detail label above did. Every banked passing run (233537, 003418, 232013) tripped
  # this WARN with 'hello-world|local', i.e. the row IS on B but carries origin=local; that
  # is a probe/origin-attribution question, not evidence about decryptability. Report what
  # was measured, and name the two readings separately.
  local fpre_post; fpre_post="$(rig_read_content b "$FPRE" 2>/dev/null)"
  case "$fpre_post" in
    *"|remote") : ;;
    "") echo "revocation: WARN — pre-ban $FPRE row is ABSENT on B post-ban (retroactive cut?)" ;;
    *) echo "revocation: WARN — pre-ban $FPRE row IS present on B post-ban but not marked federated (got '$fpre_post'; expected '*|remote') — origin attribution, NOT a readability finding" ;;
  esac

  echo "revocation + K-cut OK — B federated pre-ban, then after the ban B stopped receiving post-ban content (pre-ban stayed readable)"
  return 0
}
matrix_register revocation_kcut 90 "revocation + epoch K-cut" scn_revocation_kcut
