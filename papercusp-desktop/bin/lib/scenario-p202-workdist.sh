#!/usr/bin/env bash
# scenario-p202-workdist.sh — the LIVE-2 CROSS-MACHINE WORK-DISTRIBUTION probes
# (endgame p2p-public-release-endgame-2026-09-01 P-202; = remaining-lanes P-205/P-508,
# authorized for fresh execution by D-073).
#
# Driven by bin/vm-rig/p202-workdist.sh against the REAL two-machine rig
# (tower <-> Mac VM). This file holds ONLY probes; every seam it needs is supplied
# by the driver:
#
#   drv_psql <inst> <sql>        the SQL seam            (inst = tower | vm)
#   rig_mcp  <inst> <tool> <json>  the product MCP seam  (echoes the raw response)
#   wd_bundle_has <inst> <sym>   is <sym> in that host's shipped bundle (rc 0/1)
#   WD_FLEET / WD_PLAN / WD_RUNID   the throwaway identifiers for this run
#
# ── WHY THIS EXISTS SEPARATELY FROM bin/work-distribution-drill.sh ────────────
# That drill is SINGLE-BOX and says so: its FED-REAP leg is "UNPROVABLE ON ONE BOX
# BY CONSTRUCTION". The matrix scenarios (scenarios/{fleet-directory,seat-offer,
# spawn-request,work-item,fed-reap}.sh, orders 55-59) prove the federation legs on
# two LOCAL FRAMES, and spawn-request.sh's own header defers the one leg that
# matters most: "The HONOR leg (gate ON -> real member terminals) deliberately
# rides the P-010 live 2-box drill, not the matrix: a matrix run must not boot LLM
# sessions." THIS is that 2-box drill. It drives the honor leg on real hardware.
#
# ── THE FOUR RULES THIS FILE IS BUILT AROUND (each cost a run to learn) ───────
# 1. ASSERT SETUP SUCCEEDED BEFORE ASSERTING ITS RESULT. A probe whose setup
#    failure is indistinguishable from its finding manufactures false product
#    defects. Every MCP write here goes through _wd_mcp, which SEPARATES "the call
#    errored" (SETUP FAIL, no verdict) from "the call worked and the row did not
#    appear" (a real finding).
# 2. EVERY NEGATIVE ASSERTION NEEDS A POSITIVE CONTROL. WD-7 asserts a receipt
#    reached the ORIGIN. Its control is WD-3, which proves the very same VM->tower
#    direction carried a row EARLIER IN THIS SAME RUN. Without that, a dead wire
#    and a dropped receipt are the same observation.
# 3. A RUN THAT COULD NOT EXERCISE ITS PROBES EXITS DIFFERENTLY FROM ONE WHOSE
#    PROBES FAILED — rc 2 "NO VERDICT" vs rc 1 "FAILED". Collapsing those is how a
#    rig problem gets filed as a product bug.
# 4. THE VM'S EMBEDDED PG PORT IS RANDOMIZED PER BOOT. The driver re-discovers it;
#    a stale port makes every query fail to connect and reads as durable loss.
#
# ── AND ONE MORE, SPECIFIC TO THIS LANE ──────────────────────────────────────
# "opened: N/N" IS NOT PROOF OF SPAWN. On macOS probeLocalClaudeLogin returns
# usable:true with evidence 'assumed-darwin-keychain' — it ASSUMES the login rather
# than verifying it (honor-account-resolution.ts), so a member can be "opened" and
# then die without taking a turn. The product has its own guard for this
# (refused:member_boot_unconfirmed) and the rig has produced it live. So WD-8 never
# reads the honor path's self-report as success: an 'honored' disposition must be
# backed by an actual seat consumption row, or it is a red.
#
# Exit: 0 every probe green · 1 one or more red · 2 setup failed (NO VERDICT)

WD_PASS=0; WD_FAIL=0; WD_SKIP=0; WD_SETUP=0
_wd_ok()    { echo "  ✓ $*"; WD_PASS=$((WD_PASS+1)); }
_wd_bad()   { echo "  ✗ $*"; WD_FAIL=$((WD_FAIL+1)); }
_wd_skip()  { echo "  ⏭ SKIP $*"; WD_SKIP=$((WD_SKIP+1)); }
# A SETUP failure is NOT a product verdict. It means the run could not be performed.
_wd_setup() { echo "  ⚠ SETUP FAIL $*"; WD_SETUP=$((WD_SETUP+1)); }

# ── the MCP seam, with the setup/finding split baked in ───────────────────────
# Echoes the raw response on stdout; returns 0 only when the call itself succeeded.
# An MCP-level error is a SETUP failure by construction: it means the product call
# never ran, so nothing downstream of it may be reported as a federation finding.
WD_MCP_OUT=""
#
# ⚠ JUDGE THE ENVELOPE, NEVER THE PAYLOAD — and this file earned that the hard way.
# The first version of this function grepped the WHOLE response for
#   "isError":true | "ok":false | "error":
# On the very first live run, a perfectly SUCCESSFUL fleet:create was reported as a
# SETUP FAIL, because the tool's own result PROSE contains an `"errors":[...]` array
# of harmless advisories ("loop: no concrete harness available…"). Two `"error":`
# substrings inside a 2,241-byte success response were enough.
#
# That is the SAME defect class this whole driver is built to prevent, one level up:
# an instrument that cannot tell "the call failed" from "the call succeeded and
# mentioned a failure". A grep over a JSON document cannot make that distinction,
# because it has no idea which nesting level it is looking at — so this parses.
# Envelope truth only: a JSON-RPC top-level `error`, or `result.isError === true`.
# Anything inside result.content[].text is the TOOL'S payload and is none of this
# function's business.
#
# (The bug was contained rather than costly, and that is the point: it surfaced as
# rc=2 NO VERDICT with the gate cleanly restored, not as a red against the product.
# A collapsed exit code would have filed it as a work-distribution defect.)
_wd_mcp() {
  local inst="$1" tool="$2" args="$3" out verdict
  out="$(rig_mcp "$inst" "$tool" "$args" 2>&1)"
  WD_MCP_OUT="$out"
  if [ -z "$out" ]; then
    _wd_setup "$tool on $inst returned NOTHING (transport failure — no verdict is available from this run)"
    return 1
  fi
  # The sidecar answers text/event-stream, so the JSON rides on a `data:` line.
  verdict="$(printf '%s' "$out" | python3 -c '
import sys, json
raw = sys.stdin.read()
doc = None
for line in raw.splitlines():
    line = line.strip()
    if line.startswith("data:"):
        line = line[5:].strip()
    if not line.startswith("{"):
        continue
    try:
        doc = json.loads(line)
    except Exception:
        continue
if doc is None:
    print("UNPARSEABLE no JSON-RPC document in the response")
    raise SystemExit(0)
if isinstance(doc.get("error"), dict):
    e = doc["error"]
    print("RPCERROR %s %s" % (e.get("code"), str(e.get("message"))[:200]))
    raise SystemExit(0)
res = doc.get("result")
texts = []
if isinstance(res, dict):
    for c in (res.get("content") or []):
        if isinstance(c, dict) and c.get("type") == "text":
            texts.append(str(c.get("text", "")))
if isinstance(res, dict) and res.get("isError") is True:
    print("TOOLERROR(isError) %s" % (" ".join(texts))[:280].replace("\n", " "))
    raise SystemExit(0)
# These tools ALSO refuse with a clean MCP envelope and `ok:false` in their own
# payload (measured: resource:delegate answering `hive_required` returns
# result.content[0].text = {"ok":false,"error":"hive_required",...} with isError
# UNSET). So the payload has to be read too — but read as a DOCUMENT, at its top
# level only. That is what separates a refusal from a success that merely carries a
# nested `errors:[...]` advisory list.
for t in texts:
    s = t.strip()
    if s.startswith("{"):
        try:
            p = json.loads(s)
        except Exception:
            continue
        if isinstance(p, dict) and p.get("ok") is False:
            print("TOOLREFUSED %s %s" % (p.get("error"), str(p.get("detail", ""))[:220].replace("\n", " ")))
            raise SystemExit(0)
    elif s.startswith("format:"):
        # the toon rendering: a top-level `ok: false` line is the same refusal
        for ln in s.splitlines():
            if ln.strip() == "ok: false":
                print("TOOLREFUSED(toon) %s" % s[:220].replace("\n", " "))
                raise SystemExit(0)
print("OK")
' 2>/dev/null)"
  case "$verdict" in
    OK) return 0 ;;
    "")
      _wd_setup "$tool on $inst — could not evaluate the response envelope (parser produced nothing). Refusing to call this either a success or a product failure"
      return 1 ;;
    *)
      _wd_setup "$tool on $inst ERRORED: $verdict"
      return 1 ;;
  esac
}

# Bounded poll of a count query on one host. Echoes 1 (satisfied) / 0 (never).
# Deliberately count-based: a zero row-count and a failed connection look identical
# in a bare psql result, so the caller must have proven the host answers SQL first
# (WD-0 does exactly that, which is why it is a preflight and not a probe).
_wd_wait() {
  local inst="$1" table="$2" pred="$3" tries="${4:-45}" n
  for _ in $(seq 1 "$tries"); do
    n="$(drv_psql "$inst" "SELECT count(*) FROM harness_shared.$table WHERE $pred;" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$n" ] && [ "$n" != "0" ]; then echo 1; return; fi
    sleep 2
  done
  echo 0
}

_wd_one() { drv_psql "$1" "$2" 2>/dev/null | tr -d '[:space:]'; }

# ═════════════════════════════════════════════════════════════════════════════
scenario_p202_workdist() {
  local seat_offer="" req_offer="" disp="" rc

  echo
  echo "── WD-1  OFFER: the VM delegates agent seats to the tower's fleet ──"
  # SETUP a: the fleet must exist on the OWNER before seats can be spent against it
  # (request_remote_spawn refuses "no fleet '<slug>' in this workspace", and only the
  # fleet LEADER may spend — creating it here makes this caller the leader).
  _wd_mcp tower 'fleet:create' \
    "{\"name\":\"$WD_FLEET\",\"description\":\"P-202 LIVE-2 cross-machine work-distribution acceptance $WD_RUNID\"}" \
    || return 2
  echo "    fleet '$WD_FLEET' created on tower (this caller is its leader)"

  # SETUP b: the VM donates one explicitly modelled seat. The driver validates
  # WD_MODEL/WD_EFFORT and defaults them to the owner's current agent policy.
  # `hive` is NOT optional here. This workspace hosts TWO shared hives (papercusp and
  # shared-hive-test-hive-2), so resource:delegate refuses with `hive_required` rather
  # than guessing — "without it the seat would be delegated locally but never
  # discoverable pot-wide", i.e. WD-2 would then fail for a reason that is not a
  # federation defect at all. Found by calibrating the MCP detector against a real refusal.
  _wd_mcp vm 'resource:delegate' \
    "{\"fleetSlug\":\"$WD_FLEET\",\"kind\":\"agent_slot\",\"model\":\"$WD_MODEL\",\"effort\":\"$WD_EFFORT\",\"count\":1,\"hive\":\"$WD_HIVE\"}" \
    || return 2
  echo "    VM delegated 1 $WD_MODEL/$WD_EFFORT agent_slot to '$WD_FLEET'"

  # FINDING: the delegation must have PUBLISHED a local seat-offer on the VM.
  # (WI-5447 is the sibling bug in the other direction — a revoked allotment
  # leaving its offer 'open' — so the offer row is a fact worth asserting, not a
  # restatement of the call above.)
  if [ "$(_wd_wait vm p2p_work_offers "fleet_slug='$WD_FLEET' AND offer_kind='seat' AND origin='local'" 20)" = 1 ]; then
    seat_offer="$(_wd_one vm "SELECT offer_id FROM harness_shared.p2p_work_offers WHERE fleet_slug='$WD_FLEET' AND offer_kind='seat' AND origin='local' LIMIT 1;")"
    _wd_ok "WD-1 OFFER published on the VM: $seat_offer"
  else
    _wd_bad "WD-1 OFFER — resource:delegate succeeded but NO local seat-offer row exists on the VM for '$WD_FLEET' (publish leg failed silently)"
    return 1
  fi

  echo
  echo "── WD-2  the seat-offer federates VM -> TOWER, with unforgeable attribution ──"
  # This is BOTH a leg and the POSITIVE CONTROL for WD-7. It proves the VM->tower
  # direction carries rows in THIS run, so a later missing receipt cannot be
  # explained away as a dead wire — and cannot be blamed on the wire either.
  # author_pubkey ~ '^[0-9a-f]{64}$' is the exact-key authentication P-508 asks
  # for: that stamp is applied by the RECEIVER from the substrate author, so a
  # side-writer leaves it NULL or base64. Presence of the 64-hex form IS the verify.
  if [ "$(_wd_wait tower p2p_work_offers "offer_id='$seat_offer' AND origin='remote' AND author_pubkey ~ '^[0-9a-f]{64}\$'" 60)" = 1 ]; then
    _wd_ok "WD-2 seat-offer $seat_offer reached the TOWER origin='remote' with 64-hex substrate attribution (VM->tower wire PROVEN LIVE this run; exact-key auth green)"
  else
    # Distinguish "arrived unattributed" from "never arrived" — they are different
    # defects and the second one invalidates WD-7's control.
    if [ "$(_wd_one tower "SELECT count(*) FROM harness_shared.p2p_work_offers WHERE offer_id='$seat_offer';")" != "0" ]; then
      _wd_bad "WD-2 seat-offer $seat_offer reached the tower but WITHOUT 64-hex author_pubkey attribution (exact-key authentication leg broken)"
    else
      _wd_bad "WD-2 seat-offer $seat_offer NEVER reached the tower — the VM->tower direction is not carrying rows, so WD-7 has no positive control and this run cannot judge origin-observability"
    fi
    return 1
  fi

  echo
  echo "── WD-3  PULL: the tower authors the SIGNED spawn-request against that offer ──"
  # request_remote_spawn matches seat-offers by fleet slug, and WD_FLEET is unique to
  # this run, so it cannot pick up a stranger's open offer from the 19 already on
  # these hosts.
  _wd_mcp tower 'fleet:request_remote_spawn' \
    "{\"fleet\":\"$WD_FLEET\",\"plan\":\"$WD_PLAN\",\"count\":1,\"hive\":\"$WD_HIVE\"}" \
    || return 2

  if [ "$(_wd_wait tower p2p_work_offers "fleet_slug='$WD_FLEET' AND offer_kind='spawn_request' AND origin='local'" 20)" = 1 ]; then
    req_offer="$(_wd_one tower "SELECT offer_id FROM harness_shared.p2p_work_offers WHERE fleet_slug='$WD_FLEET' AND offer_kind='spawn_request' AND origin='local' LIMIT 1;")"
    _wd_ok "WD-3 PULL: signed spawn_request stored on the tower: $req_offer"
  else
    _wd_bad "WD-3 PULL — request_remote_spawn succeeded but no local spawn_request row exists on the tower for '$WD_FLEET' (author leg failed silently)"
    return 1
  fi

  echo
  echo "── WD-4  the spawn-request federates TOWER -> VM, signature-verified ──"
  if [ "$(_wd_wait vm p2p_work_offers "offer_id='$req_offer' AND origin='remote' AND author_pubkey ~ '^[0-9a-f]{64}\$'" 90)" = 1 ]; then
    _wd_ok "WD-4 spawn_request $req_offer reached the VM origin='remote' with 64-hex attribution (the projection verified the signature before applying)"
  else
    if [ "$(_wd_one vm "SELECT count(*) FROM harness_shared.p2p_work_offers WHERE offer_id='$req_offer';")" != "0" ]; then
      _wd_bad "WD-4 spawn_request $req_offer reached the VM but WITHOUT 64-hex attribution"
    else
      _wd_bad "WD-4 spawn_request $req_offer NEVER reached the VM (tower->VM direction) — the honor path was never given anything to honor"
    fi
    return 1
  fi

  echo
  echo "── WD-5  SPAWN: the VM's honor hook ACTS on the request ──"
  # The gate was armed by the driver BEFORE WD-3, on purpose: delegated-spawn-honor.ts
  # states there is NO re-trigger on a later ACCEPT_DELEGATED_SEATS flip — a request
  # that lands while the gate is off sits un-disposed and EXPIRES. Arming afterwards
  # would produce a false "honor leg broken".
  # A disposition is therefore the honest signal that the hook ran at all: gate-off is
  # a SILENT skip by design (no disposition, no receipt, no consumption).
  #
  # ⚠ 'honoring' IS NOT AN OUTCOME — IT IS THE ATOMIC CLAIM. delegated-spawn-honor.ts
  # gate 5 writes 'honoring' (WHERE NULL) purely so two concurrent hooks cannot
  # double-spawn, and only then does it spawn and settle to 'honored' or
  # 'refused:<code>' (both written with { expect: 'honoring' }).
  # The first live run of this driver broke out of this loop on the FIRST non-empty
  # value, caught 'honoring' at ~0s, and WD-6 then judged an IN-FLIGHT operation as a
  # finished one — reporting "honored but consumed ZERO seats" as a product red. The
  # true terminal state seconds later was 'honored' with 1 seat consumed and a receipt
  # emitted. That is a SAMPLING race in the probe, not a defect in the subject, and it
  # is the same rule as everywhere else in this file: do not assert a result before the
  # thing that produces it has finished.
  # So: poll for a TERMINAL disposition, and treat a claim that never settles as its
  # own distinct finding rather than as an unbacked honor.
  local waited=0
  while [ "$waited" -lt 300 ]; do
    disp="$(_wd_one vm "SELECT coalesce(local_disposition,'') FROM harness_shared.p2p_work_offers WHERE offer_id='$req_offer';")"
    case "$disp" in
      honored|refused:*) break ;;
    esac
    sleep 5; waited=$((waited+5))
  done
  case "$disp" in
    honored|refused:*)
      _wd_ok "WD-5 SPAWN: honor hook ran and SETTLED on the VM after ~${waited}s — local_disposition='$disp'"
      ;;
    honoring)
      _wd_bad "WD-5 SPAWN — the VM claimed $req_offer ('honoring') but never settled it within 300s. The atomic claim is dangling: no 'honored', no 'refused:<code>'. That is a stuck honor, distinct from a silent skip and distinct from a refusal"
      return 1
      ;;
    "")
      _wd_bad "WD-5 SPAWN — the VM never disposed $req_offer within 300s. The honor hook stayed silent even though the accept-delegated-seats gate was armed BEFORE the request federated (a silent skip past an armed gate)"
      return 1
      ;;
    *)
      _wd_bad "WD-5 SPAWN — unrecognised disposition '$disp' for $req_offer (the honor path's contract is honoring -> honored | refused:<code>)"
      return 1
      ;;
  esac

  echo
  echo "── WD-6  COMPLETE: the outcome is BACKED, not just self-reported ──"
  # The load-bearing asymmetry (delegated-spawn-honor.ts): a refusal is LOUD and
  # carries a receipt; a SUCCESS needs no receipt because the members' federated
  # presence IS the signal. So each branch is checked against a different witness,
  # and neither is allowed to rest on the honor path's own prose.
  local consumed
  consumed="$(_wd_one vm "SELECT count(*) FROM harness_shared.agent_seat_consumptions WHERE fleet_slug='$WD_FLEET';")"
  case "$disp" in
    honored)
      if [ -n "$consumed" ] && [ "$consumed" != "0" ]; then
        _wd_ok "WD-6 COMPLETE: disposition 'honored' is BACKED by $consumed real seat consumption(s) on the VM"
      else
        _wd_bad "WD-6 COMPLETE — the VM reports 'honored' but consumed ZERO seats for '$WD_FLEET'. 'opened' is not 'spawned'; on macOS the local login is ASSUMED (assumed-darwin-keychain), so an unbacked honor claim is exactly the failure this leg exists to catch"
      fi
      ;;
    refused:spawn_failed|refused:member_boot_unconfirmed)
      # ⚠ "A REFUSAL MUST NOT SPEND" IS NOT THE PRODUCT'S CONTRACT, and asserting it
      # here produced a false red on the second live run. Seats are taken by
      # consumeSeatAtBoot — "Boot-time seat consumption (bootstrap-su, after the
      # WI-1893 fleet stamp)" — i.e. BY THE MEMBER, at ITS boot, not by the honor path.
      # So for the two post-boot refusal codes the member DID boot (and legitimately
      # consumed) before its agent died or failed to prove a turn. A consumption is
      # therefore EXPECTED here, and its ABSENCE is the surprising direction.
      # (That the seat stays consumed after such a death is a known, separately-tracked
      # seat-leak concern — WI-5317 — not something this drill re-files.)
      if [ -n "$consumed" ] && [ "$consumed" != "0" ]; then
        _wd_ok "WD-6 COMPLETE: post-boot refusal '$disp' with $consumed seat consumption(s) — consistent with consume-at-boot: the member booted, took its seat, then failed. The refusal CODE is this run's product finding; WD-7 decides whether the origin can see it"
      else
        _wd_bad "WD-6 COMPLETE — '$disp' is a POST-BOOT refusal code, yet ZERO seats were consumed for '$WD_FLEET'. Either the member never actually booted (so this code is misreported) or consumeSeatAtBoot did not fire"
      fi
      ;;
    refused:*)
      # Every OTHER refusal code is a gate refusal reached BEFORE any member boots
      # (expired, seat_ref_unknown, audience_refused, seats_exhausted,
      # agent_runtime_missing, an account-resolution refusal). Nothing has booted, so
      # nothing may have been spent. THIS is where fail-closed is actually testable.
      if [ -n "$consumed" ] && [ "$consumed" != "0" ]; then
        _wd_bad "WD-6 COMPLETE — the VM refused at a PRE-BOOT gate ('$disp') yet consumed $consumed seat(s) for '$WD_FLEET' (fail-closed broken: a gate refusal spends nothing, because no member ever boots)"
      else
        _wd_ok "WD-6 COMPLETE: pre-boot gate refusal '$disp' spent no seats — fail-closed held. The refusal CODE is this run's product finding; WD-7 decides whether the origin can see it"
      fi
      ;;
    *)
      _wd_bad "WD-6 COMPLETE — unrecognised disposition '$disp' for $req_offer (neither an honor nor a loud refusal; the honor path's contract is honored|honoring|refused:<code>)"
      ;;
  esac

  echo
  echo "── WD-7  ORIGIN-OBSERVABLE: the outcome reaches the REQUESTER ──"
  # THE LEG THIS WHOLE DRIVER EXISTS FOR. P-205's bar is "every leg observable from
  # the ORIGIN, any silent leg = FAIL", and request_remote_spawn's own contract says
  # "a refusal federates back as a p2p receipt (p2p:trace with this requestOfferId)".
  # local_disposition is HOST-LOCAL and never federates, so the receipt is the ONLY
  # channel by which the origin learns the outcome.
  # This rig has already produced the silent case once: VM receipt a03458d1
  # (member_boot_unconfirmed, 2026-08-13) is stamped for federation yet has never
  # appeared on the tower. WD-2 above is the control that makes this measurement mean
  # something today.
  local vm_rcpt tower_rcpt
  # ⚠ THE MODULE HEADER SAYS "Success needs no receipt — the members' federated
  # presence IS the signal". MEASURED ON BUILD #8, THAT IS OUT OF DATE: the honor
  # path emits a kind='honored' receipt too (delegated-spawn-honor.ts ~line 1029), and
  # the first live run of this driver produced one. So a SUCCESS is origin-observable
  # through exactly the same channel as a refusal, and this leg asserts it either way
  # rather than excusing the success case. The prose was trusted; the artifact was
  # probed; the artifact won.
  vm_rcpt="$(_wd_one vm "SELECT count(*) FROM harness_shared.p2p_receipts WHERE offer_id='$req_offer';")"
  if [ -z "$vm_rcpt" ] || [ "$vm_rcpt" = "0" ]; then
    case "$disp" in
      refused:*)
        _wd_bad "WD-7 ORIGIN-OBSERVABLE — the VM refused ('$disp') but emitted NO receipt at all for $req_offer. A refusal past gate 2 is contractually LOUD (D-004 no-silent-drops); the origin can never learn why"
        ;;
      *)
        _wd_skip "WD-7 ORIGIN-OBSERVABLE — DETECTED: disposition '$disp' emitted no receipt on this build, so there is nothing to carry and origin-observability of the OUTCOME is NOT measured by this run. (Older prose says success needs no receipt; build #8 does emit one, so read this SKIP as 'unexpected', not 'as designed'.)"
        ;;
    esac
  else
    if [ "$(_wd_wait tower p2p_receipts "offer_id='$req_offer' AND origin='remote' AND author_pubkey ~ '^[0-9a-f]{64}\$'" 90)" = 1 ]; then
      _wd_ok "WD-7 ORIGIN-OBSERVABLE: the VM's receipt for $req_offer reached the TOWER origin='remote' with 64-hex attribution — the requester can see the outcome and who signed it"
    else
      tower_rcpt="$(_wd_one tower "SELECT count(*) FROM harness_shared.p2p_receipts WHERE offer_id='$req_offer';")"
      if [ -n "$tower_rcpt" ] && [ "$tower_rcpt" != "0" ]; then
        _wd_bad "WD-7 ORIGIN-OBSERVABLE — the receipt reached the tower but WITHOUT 64-hex attribution (unattributed outcome: the origin cannot tell who signed it)"
      else
        _wd_bad "WD-7 ORIGIN-OBSERVABLE — SILENT LEG. The VM emitted $vm_rcpt receipt(s) for $req_offer and NONE reached the tower, while WD-2 proved the VM->tower direction carried a row in this same run. The requester is left with no way to learn the outcome. P-205: any silent leg = FAIL"
      fi
    fi
  fi

  echo
  echo "── WD-8  METER: probed from the artifact, never asserted from memory ──"
  # D-018's rule, learned the expensive way on this very lane: A LEG MAY NOT STATE A
  # REASON, IT MAY ONLY RUN A PROBE. The bundle is tree-shaken, so a symbol no
  # production path reaches is ABSENT from the shipped file — absence is signal.
  # Reporting this as a RED would file a product defect for a leg that was never
  # built; reporting it as a silent green would hide a release gap. It is a SKIP with
  # a detected reason, and the SKIP is the release evidence.
  if wd_bundle_has vm 'recordSpendDurable'; then
    local spend_rows
    spend_rows="$(_wd_one vm "SELECT count(*) FROM harness_shared.p2p_metering_spend WHERE fleet_slug='$WD_FLEET';")"
    if [ -n "$spend_rows" ] && [ "$spend_rows" != "0" ]; then
      _wd_ok "WD-8 METER: the spend writer ships AND recorded $spend_rows row(s) for this run's fleet"
    else
      _wd_bad "WD-8 METER — the spend writer SHIPS in this bundle but no spend row was written for '$WD_FLEET' (the ledger has a writer and it did not fire)"
    fi
  else
    _wd_skip "WD-8 METER — DETECTED: recordSpendDurable is ABSENT from the VM's tree-shaken bundle, so the metering ledger has NO production writer on this build. The tables exist, but nothing in production writes them (their only production reader, host-availability, was deleted with the dead kind:work offer-executor seam). P-202's meter leg is UNBUILT, not broken"
  fi

  echo
  echo "── WD-9  REVOCATION: honest scope statement, not a vacuous green ──"
  # Deliberately NOT re-implemented here. The federated withdrawal path
  # (reapForeignSessionsForRevocation, gated on provenance origin='remote') has its
  # own registered cross-node scenario — scenarios/fed-reap.sh, order 59 — and P-202's
  # own item text scopes this run to offer->pull->spawn->complete->meter. Claiming it
  # from this driver without driving it would be exactly the D-018 rot.
  if wd_bundle_has vm 'reapForeignSessionsForRevocation'; then
    _wd_skip "WD-9 REVOCATION — DETECTED: the federated withdrawal hook SHIPS in this bundle, but this driver does not exercise it. NOT COVERED BY THIS RUN BY CONSTRUCTION — prove it with: bin/local-matrix.sh --only=fed_reap (scenarios/fed-reap.sh, order 59)"
  else
    _wd_bad "WD-9 REVOCATION — reapForeignSessionsForRevocation is ABSENT from the VM's shipped bundle: the federated withdrawal path does not ship at all on this build"
  fi

  return 0
}

# Render the verdict. Kept here so the driver and any future caller cannot disagree
# about what a given counter combination MEANS — in particular that a setup failure
# is not a red.
wd_verdict() {
  echo
  echo "════════════════════════════════════════════════════════"
  echo "P-202 LIVE-2 cross-machine work-distribution: PASS=$WD_PASS FAIL=$WD_FAIL SKIP=$WD_SKIP SETUP-FAIL=$WD_SETUP"
  if [ "$WD_SETUP" -gt 0 ]; then
    echo "RESULT: NO VERDICT — the run could not exercise its probes (setup failed)."
    echo "  This is NOT a federation or work-distribution verdict. Nothing here may be"
    echo "  filed as a product defect. Fix the rig/setup and re-run."
    return 2
  fi
  if [ "$WD_FAIL" -gt 0 ]; then
    echo "RESULT: FAILED — $WD_FAIL probe(s) red (see above)."
    return 1
  fi
  echo "OVERALL: PASS — every exercised leg green; $WD_SKIP leg(s) reported with a DETECTED reason (read them: they are the release evidence for what is unbuilt or uncovered)."
  return 0
}
