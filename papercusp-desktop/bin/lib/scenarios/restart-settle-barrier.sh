#!/usr/bin/env bash
# restart-settle-barrier.sh — WI-5444: settle-or-repair barrier between order
# 80 (restart_durability) and the later invasive scenarios (85 reconnect_catchup,
# 87 replication_soak, 90 revocation_kcut).
#
# Repro this closes (WI-5444): b5-restart.sh deliberately leaves both sidecars
# up + re-joined after order 80 for the later invasive scenarios, but order 80
# can leave a real (if latent, sometimes self-healing) convergence backlog in
# flight — order 85 has started while still inside that recovery window and
# died at its OWN baseline step, before ever exercising its own partition/
# reconnect logic. That is test-harness contamination, not a reproduction of
# whatever 85/87/90 are meant to test on their own. There was no barrier
# between 80 and 85/87/90 that made the matrix wait for (or at least measure)
# settling first — this file is that barrier.
#
# Design (per fleet-leader su-4c73ae38's WI-5444 posts 52896/52901 — read
# those before touching the constants below): make the barrier an INSTRUMENT,
# not a mute. A barrier that silently blocks until convergence would let
# 85/87/90 go green over a system that still takes minutes to resync against
# a 90s SLA — hiding the defect instead of exposing it. So this scenario:
#   - re-polls the SAME canary write order 80 made (scenario_restart_durability
#     exports RD_LAST_CANARY_FID/RD_LAST_MEMBER/RD_LAST_CANARY_WRITE_TS) —
#     never invents a fresh one; the point is observing THAT restart's actual
#     convergence, tracked from the ORIGINAL write time;
#   - ALWAYS emits elapsed time as a first-class result line, never a silent
#     sleep — including a loud ⚠ once elapsed crosses RD_SETTLE_WARN_S even
#     when it still converges after that (a visible regression signal short
#     of an outright fail);
#   - hard-FAILs only past RD_SETTLE_FAIL_S. That deadline is deliberately
#     generous (default 900s) — run 214246/224336's own timings are confounded
#     by verified shared-host CPU contention (WI-5481, fix EI-16524 not yet
#     live) per WI-5444 posts 52926/52963, so hard-failing at ~2min would just
#     turn this into permanent, uninformative noise until that infra fix
#     lands. DO NOT tighten RD_SETTLE_FAIL_S (or flip RD_SETTLE_WARN_IS_FAIL)
#     without a clean post-EI-16524-fix run establishing the real SLA — every
#     knob here is env-overridable so that recalibration never needs a code
#     change, and su-d93ac1bf's post 52963 explicitly left this exact call
#     open ("leaving the barrier-threshold call to whoever's driving this").
#   - order 80 (scn_restart_durability) itself is UNCHANGED — its own
#     270s-bounded check on this same canary keeps failing on its own,
#     independent of this barrier. That is the "at least one scenario that
#     measures the SLA WITHOUT a barrier in front of it" leg the disposition
#     asked to keep — this file adds a second, later checkpoint; it does not
#     replace or soften the first one.
#
# No preceding restart_durability canary (e.g. a `--only` run excluded order
# 80) → nothing to settle → PASS (no-op), never a forced fail.
#
# WI-5772: "no canary vars set" used to be treated as a single case ("order 80
# didn't run this session") — but order 80 (scenario_restart_durability) can also
# RUN and FAIL/bail *before* reaching its final canary write (frames never
# joined, an earlier step's assertion failed, etc.), which left the exact same
# four vars unset. That misattributed a genuine order-80 failure as "nothing to
# settle — PASS", masking it (gate run 20260725-143908). order 80 now stamps
# RD_LAST_RAN_AT unconditionally as its first action, before any early return,
# so this barrier can tell the two apart: RD_LAST_RAN_AT unset = truly did not
# run this session (still a silent PASS, unchanged); RD_LAST_RAN_AT set but no
# canary vars = it ran and left no canary to check — that is itself a signal
# worth a hard FAIL, not a silent pass, since 85/87/90 are about to run without
# any verified-converged baseline.

RD_SETTLE_WARN_S="${RD_SETTLE_WARN_S:-120}"     # leader's "~2min should be loud" bar (52896) — always a visible ⚠, not by itself a fail (see header)
RD_SETTLE_FAIL_S="${RD_SETTLE_FAIL_S:-900}"     # provisional hard deadline — comfortably above the observed ~12min self-heal (214246) and short of the confound-free "never converged" case (224336, 36+min) — retune only from a clean run
RD_SETTLE_WARN_IS_FAIL="${RD_SETTLE_WARN_IS_FAIL:-0}"  # set 1 to make crossing RD_SETTLE_WARN_S itself a hard fail, once calibration lands

# ── D-044 / WI-40534: post-restart owner-self-classification re-poll ──────────
# W1 claims the OWNER frame comes to classify ITSELF `remote` AFTER a restart.
# The instrument for that already existed and already ran — it was MIS-POSITIONED,
# not missing: deb-hetzner-matrix.sh:~251 runs this same pot_members query against
# frame a, but inside a one-shot inline block right after peer_connect (its own
# header at :227 says so), ~30 orders BEFORE order 80's restart. So the only dump
# any run ever produced is the BEFORE half, and every local-matrix run to date has
# been structurally incapable of observing W1 at all. Its PASSes are real, and they
# are a green that cannot see the thing — they must not be quoted as W1 moving.
#
# This is the AFTER half. Run 20260822/m1787374736 banked the BEFORE half for this
# rig shape: frame a reported BOTH members `local` (zero remote rows) pre-restart,
# while frame b correctly reported `remote`. Against that baseline a non-zero remote
# count here is unambiguously restart-CAUSED rather than a standing misclassification.
#
# TWO PROPERTIES THAT ARE NOT INCIDENTAL — preserve them if you touch this:
#
#  1. It is called as the FIRST statement of scn_restart_settle_barrier, NOT from
#     inside the settle loop. This barrier has SIX return paths; an instrument
#     placed lower silently stops running the first time an early return is added
#     above it, and silence then stops meaning "measured" and starts meaning "never
#     ran" with no signal. That is the exact standing fragility flagged against the
#     gate's L392 barrier (see WI-40388's checkpoint, which depends on no early
#     return between L392 and L410). Top-of-function is already post-restart —
#     order 80 has run — AND structurally immune to that failure mode.
#
#  2. MEASURE-ONLY, but deliberately NOT fail-open. It always `return 0` and never
#     touches this scenario's verdict: the barrier's PASS/FAIL is about SETTLING,
#     and folding a live W1 finding into it would both overload that signal and red
#     the gate on a question still under investigation (WI-40388, claimed). But an
#     unmeasurable frame prints an explicit NOT-MEASURED line, because "the query
#     failed" and "the owner classified itself correctly" must never render the same
#     way — a fail-open instrument reports absence of evidence as health.
_rsb_owner_self_classification() {
  local phase="${1:-post-restart}" out="" rc=0 remote_n=0
  # device_attestations is deliberately NOT selected: it carries JSON, and this
  # readout is field-split on '|'. origin is $3 of exactly four columns.
  out="$(drv_psql a "SELECT github_username, pot_home_slug, origin, fed_ts FROM harness_shared.pot_members ORDER BY github_username;" 2>&1)" || rc=$?

  if [ "${rc:-1}" -ne 0 ]; then
    echo "  ⚠ owner-self-classification ($phase): NOT MEASURED — frame a pot_members query FAILED (rc=${rc}). This is ABSENCE OF EVIDENCE about W1, not a clean owner frame; do NOT read this run as owner-classifies-itself-local."
    printf '%s\n' "${out:-<no output>}" | sed 's/^/  ⚠   /'
    return 0
  fi
  if [ -z "${out//[[:space:]]/}" ]; then
    echo "  ⚠ owner-self-classification ($phase): NOT MEASURED — frame a returned ZERO pot_members rows. The query succeeded, so this is not a transport failure; an owner frame with no members at all is itself anomalous and is NOT evidence that W1 did not reproduce."
    return 0
  fi

  echo "  · owner-self-classification ($phase) — frame a (OWNER) view of harness_shared.pot_members [github_username|pot_home_slug|origin|fed_ts]:"
  printf '%s\n' "$out" | sed 's/^/  ·   /'

  remote_n="$(printf '%s\n' "$out" | awk -F'|' '$3 == "remote"' | grep -c . || true)"
  if [ "${remote_n:-0}" -gt 0 ]; then
    echo "  ⚠ owner-self-classification ($phase): frame a reports ${remote_n} row(s) origin=remote. The pre-restart baseline for this rig shape is ZERO (m1787374736 measured BOTH rows 'local' on frame a). A non-zero count HERE, against that before-half, is the W1 signal — restart-CAUSED, not a standing misclassification. MEASURE-ONLY: this does not change this scenario's verdict. See WI-40388."
  else
    echo "  ✓ owner-self-classification ($phase): frame a reports 0 rows origin=remote — the owner still classifies every member, ITSELF included, as 'local' AFTER the restart. On this run W1 did not reproduce. Bounded claim: this is one run, and it speaks only to this restart."
  fi
  # ── D-067 positive control (adjudication mt6u5sj2, route (b)): the frame-a
  # reading above cannot fail in the tested direction if a WI-39363-class
  # mis-stamp (a should-be-remote row rendered 'local') is live in the run —
  # 'clean' and 'mis-stamped' read identically. Route (a) disjointness FAILED:
  # every hyperbee projection derives origin from the SAME ProvenanceContext
  # with the SAME `?? 'local'` fallback (feature-queue.ts:129 ≡
  # hive-members.ts:180), so a provenance-loss defect reaches pot_members too.
  # Frame b (JOINER) is the in-run control: its pot_members rows are
  # owner-authored and arrive federated, so they MUST read origin='remote'
  # (banked BEFORE-half m1787374736: frame b correctly reported 'remote').
  # MEASURE-ONLY like the leg above — never changes this scenario's verdict;
  # it marks the frame-a reading COUNTABLE or NOT toward the W1 retirement
  # bar (plan p2p-public-release-remaining-lanes-2026-07-16 D-067). Same
  # fail-closed rendering: a failed/empty control query is ABSENCE OF
  # EVIDENCE, never a pass.
  local b_out="" b_rc=0 b_remote_n=0 b_local_n=0
  b_out="$(drv_psql b "SELECT github_username, pot_home_slug, origin, fed_ts FROM harness_shared.pot_members ORDER BY github_username;" 2>&1)" || b_rc=$?
  if [ "${b_rc:-1}" -ne 0 ]; then
    echo "  ⚠ owner-origin positive control ($phase): NOT MEASURED — frame b pot_members query FAILED (rc=${b_rc}). Without the control, the frame-a reading above must NOT count toward W1 retirement (D-067)."
  elif [ -z "${b_out//[[:space:]]/}" ]; then
    echo "  ⚠ owner-origin positive control ($phase): NOT MEASURED — frame b returned ZERO pot_members rows. Without the control, the frame-a reading above must NOT count toward W1 retirement (D-067)."
  else
    b_remote_n="$(printf '%s\n' "$b_out" | awk -F'|' '$3 == "remote"' | grep -c . || true)"
    b_local_n="$(printf '%s\n' "$b_out" | awk -F'|' '$3 == "local"' | grep -c . || true)"
    if [ "${b_remote_n:-0}" -ge 1 ] && [ "${b_local_n:-0}" -eq 0 ]; then
      echo "  ✓ owner-origin positive control ($phase): frame b (JOINER) reports ${b_remote_n} row(s) origin=remote and 0 origin=local — the origin pipeline CAN stamp/preserve 'remote' in THIS run; the frame-a reading above is COUNTABLE toward W1 retirement (D-067)."
    else
      echo "  ⚠ owner-origin positive control ($phase): CONTROL DEGRADED — frame b reports ${b_local_n} row(s) origin=local / ${b_remote_n} origin=remote (expected all-remote for this rig shape, baseline m1787374736). A WI-39363-class mis-stamp is LIVE in this run; the frame-a reading above must NOT count toward W1 retirement (D-067)."
      printf '%s\n' "$b_out" | sed 's/^/  ⚠   /'
    fi
  fi
  return 0
}

scn_restart_settle_barrier() {
  # FIRST statement, before every return path — see the block comment above.
  _rsb_owner_self_classification post-restart

  local fid="${RD_LAST_CANARY_FID:-}" member="${RD_LAST_MEMBER:-}" write_ts="${RD_LAST_CANARY_WRITE_TS:-}"
  local ran_at="${RD_LAST_RAN_AT:-}"
  if [ -z "$fid" ] || [ -z "$member" ] || [ -z "$write_ts" ]; then
    if [ -z "$ran_at" ]; then
      echo "settle-barrier: no preceding restart_durability canary (order 80 didn't run this session) — nothing to settle, skipping"
      return 0
    fi
    echo "  ✗ settle-barrier FAIL: order 80 (restart_durability) RAN this session (started at epoch $ran_at) but left no canary — it failed or bailed before its final post-restart write (see its own ✗/OVERALL line above)"
    echo "OVERALL: FAIL — order 80 ran but produced nothing to settle-check; treat its own failure as unverified, not settled"
    return 1
  fi

  local now elapsed budget tries origin
  now="$(date +%s)"; elapsed=$(( now - write_ts ))
  fed_log "═══ WI-5444: restart-settle barrier — re-checking $fid on $member (${elapsed}s since write) ═══"

  # Already converged (order 80's own check may already have seen it land, or
  # it landed in the gap since) — report + done, no extra poll needed.
  origin="$(_rd_origin "$member" "$fid")"
  case "$origin" in
    *"|remote")
      if [ "$elapsed" -gt "$RD_SETTLE_WARN_S" ]; then
        echo "  ⚠ settle-barrier: $fid converged after ${elapsed}s — over the ${RD_SETTLE_WARN_S}s regression-warn bar (still under the ${RD_SETTLE_FAIL_S}s hard deadline)"
        if [ "$RD_SETTLE_WARN_IS_FAIL" = 1 ]; then
          echo "OVERALL: FAIL — RD_SETTLE_WARN_IS_FAIL=1: ${elapsed}s exceeds the ${RD_SETTLE_WARN_S}s bar"
          return 1
        fi
      else
        echo "  ✓ settle-barrier: $fid already converged (${elapsed}s since write, within the ${RD_SETTLE_WARN_S}s warn bar)"
      fi
      echo "OVERALL: PASS — settled after ${elapsed}s; 85/87/90 can start on a converged system"
      return 0
      ;;
  esac

  budget=$(( RD_SETTLE_FAIL_S - elapsed ))
  if [ "$budget" -le 0 ]; then
    echo "  ✗ settle-barrier FAIL: $fid still NOT converged at ${elapsed}s — past the ${RD_SETTLE_FAIL_S}s hard deadline"
    echo "OVERALL: FAIL — no convergence within ${RD_SETTLE_FAIL_S}s (provisional deadline, WI-5444 — do not retune without a clean post-EI-16524-fix run)"
    return 1
  fi

  tries=$(( (budget + 2) / 3 ))
  fed_log "settle-barrier: $fid not yet converged at ${elapsed}s — polling up to ${budget}s more (hard deadline ${RD_SETTLE_FAIL_S}s total since write)"
  if _rd_poll_remote "$member" "$fid" "$tries" >/dev/null; then
    now="$(date +%s)"; elapsed=$(( now - write_ts ))
    echo "  ⚠ settle-barrier: $fid converged after ${elapsed}s — over the ${RD_SETTLE_WARN_S}s warn bar (recovery was slow; not yet a hard fail)"
    if [ "$RD_SETTLE_WARN_IS_FAIL" = 1 ] && [ "$elapsed" -gt "$RD_SETTLE_WARN_S" ]; then
      echo "OVERALL: FAIL — RD_SETTLE_WARN_IS_FAIL=1: ${elapsed}s exceeds the ${RD_SETTLE_WARN_S}s bar"
      return 1
    fi
    echo "OVERALL: PASS — settled after ${elapsed}s (slow — see WI-5444 calibration note); 85/87/90 can start"
    return 0
  fi

  now="$(date +%s)"; elapsed=$(( now - write_ts ))
  echo "  ✗ settle-barrier FAIL: $fid still NOT converged after ${elapsed}s — past the ${RD_SETTLE_FAIL_S}s hard deadline"
  echo "OVERALL: FAIL — no convergence within ${RD_SETTLE_FAIL_S}s (provisional deadline, WI-5444 — do not retune without a clean post-EI-16524-fix run)"
  return 1
}
matrix_register restart_settle_barrier 82 "settle-or-repair barrier after restart durability (WI-5444)" scn_restart_settle_barrier
