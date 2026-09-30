#!/usr/bin/env bash
# papercup-dht-liveness-check.sh — periodic REAL liveness probe for the isolated
# DHT testnet's bootstrap node (EI-8892).
#
# WHY: `papercup-isolated-dht.service` can WEDGE (unit stays `active`, the
# bootstrap node stops actually routing DHT traffic) with ZERO passive signal —
# "is the unit active" cannot see this, and hyperswarm rides UDX/UDP so `ss`/
# `netstat` show nothing useful either. 2026-07-06→07-09: wedged for 3 days,
# cross-machine federation dead the whole time, caught only by a hand-rolled
# probe (su-4dc3befd's live incident response). This wrapper runs the real
# 2-swarm probe (p2p-dht-liveness-probe.mjs) on a schedule and files an EI on
# failure, so the class is caught within minutes instead of by chance.
#
# DETECTION + ESCALATION ONLY — this script NEVER restarts / touches
# papercup-isolated-dht.service. A staleness/liveness detector that reads a
# signal spanning process restarts must not also hold restart authority: mixing
# the two turns a boot-grace bug into a restart-storm (EI-8901's lesson — a
# freshly-restarted unit that hasn't had time to become live yet gets
# repeatedly killed by its own health check). Escalation is a human/agent call;
# this script's whole job is "don't let the wedge be silent again."
#
# Usage: papercup-dht-liveness-check.sh
# Env:
#   DHT_UNIT              (default papercup-isolated-dht.service)
#   DHT_PROBE_TIMEOUT_MS   (default 15000)  — probe connect-timeout
#   DHT_BOOT_GRACE_SEC     (default 120)    — skip judging a unit less than this
#                                             long into its current ActiveState
#                                             (EI-8901 boot-grace lesson)
#   OPERATOR_MCP_URL        (default http://127.0.0.1:3070/api/mcp?superuser=1)
#   DHT_NO_FILE             (default 0)     — set 1 to skip EI filing (log-only)
#   DHT_RED_REFILE_H        (default 12)    — RED-EI dedup window (mirrors
#                                             live-federation-gate.sh's
#                                             RED_REFILE_H — file once per
#                                             window per still-wedged condition,
#                                             not a fresh EI every tick)
#   DHT_STALE_H             (default 6)     — no successful probe run for this
#                                             long ⇒ file a LOUD staleness EI
#                                             (silence must never look like green)
#   DHT_REMOTE_HOST         (unset)         — ssh target for the DIALLING leg.
#                                             UNSET ⇒ the run is LOCAL-ONLY and
#                                             cannot detect a machine-boundary
#                                             transport failure (P-302).
#   DHT_REMOTE_CWD          (required with DHT_REMOTE_HOST) — dir on the remote
#                                             host from which `hyperswarm` resolves
#   DHT_REMOTE_NODE         (default node)  — node binary on the remote host
#   DHT_REQUIRE_CROSS_HOST  (default 0)     — 1 ⇒ refuse to report health without
#                                             a proven cross-host packet
#
# EXIT CODES (from the probe, propagated): 0 healthy · 1 FAIL (wedged /
# unreachable / degenerate) · 2 usage · 3 INCONCLUSIVE (could not run the
# experiment). 3 is NEVER filed as a wedge — see the handler below.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROBE="$REPO_ROOT/apps/operator/scripts/p2p-dht-liveness-probe.mjs"

DHT_UNIT="${DHT_UNIT:-papercup-isolated-dht.service}"
DHT_PROBE_TIMEOUT_MS="${DHT_PROBE_TIMEOUT_MS:-15000}"
DHT_BOOT_GRACE_SEC="${DHT_BOOT_GRACE_SEC:-120}"
OPERATOR_MCP_URL="${OPERATOR_MCP_URL:-http://127.0.0.1:3070/api/mcp?superuser=1}"
DHT_NO_FILE="${DHT_NO_FILE:-0}"
DHT_RED_REFILE_H="${DHT_RED_REFILE_H:-12}"
DHT_STALE_H="${DHT_STALE_H:-6}"
GATE_SUPERUSER_TOKEN_PATH="${GATE_SUPERUSER_TOKEN_PATH:-$HOME/.papercusp/superuser-token}"
GATE_SUPERUSER_BEARER="$(cat "$GATE_SUPERUSER_TOKEN_PATH" 2>/dev/null | tr -d '[:space:]' || true)"
STATE_DIR="${DHT_STATE_DIR:-$HOME/.papercusp/dht-liveness}"; mkdir -p "$STATE_DIR"

# State-aware RED dedup (EI-22240553542994017). Sourced, not optional: without it
# this probe would silently fall back to age-only suppression, which is the defect.
RED_MARKER_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/red-marker.sh"
if [ -r "$RED_MARKER_LIB" ]; then
  # shellcheck source=lib/red-marker.sh
  . "$RED_MARKER_LIB"
else
  echo "[dht-liveness] FATAL: missing $RED_MARKER_LIB — refusing to run with age-only dedup." >&2
  exit 2
fi

log() { echo "[dht-liveness $(date +%H:%M:%S 2>/dev/null || true)] $*" >&2; }
now_s() { date +%s 2>/dev/null || echo 0; }
# Delegates to the shared reader, which takes FIELD 1 of the marker. A bare `cat`
# here would break on the "<epoch> <item-id>" marker format (arithmetic on a
# non-numeric second field), so every marker age goes through one implementation.
# Still correct for this script's bare-epoch last-ok / stale-ei-filed markers.
age_h() { red_marker_age_h "$1"; }
jstr() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$1"; }

# Set by file_ei to the work-item id the filing resolved to (empty when it did not
# confirm one). Recorded into the RED marker so the NEXT tick can ask whether that
# item is still open instead of trusting the marker's age — EI-22240553542994017.
LAST_FILED_EI_ID=""

file_ei() { # <title> <body> — best-effort curl-MCP; loud echo + journald are the fallback
  LAST_FILED_EI_ID=""
  [ "$DHT_NO_FILE" = 1 ] && return 0
  local resp
  local -a auth_hdr=()
  if [ -n "$GATE_SUPERUSER_BEARER" ]; then
    auth_hdr=(-H "authorization: Bearer $GATE_SUPERUSER_BEARER")
  else
    log "WARN: no superuser bearer at $GATE_SUPERUSER_TOKEN_PATH — EI filing will 403; falling back to log-only."
  fi
  resp="$(curl -s -m 30 -X POST "$OPERATOR_MCP_URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "${auth_hdr[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"work_items:create\",\"arguments\":{\"kind\":\"bug\",\"title\":$(jstr "$1"),\"summary\":$(jstr "$2"),\"harness\":\"papercusp\",\"severity\":\"major\",\"topics\":[\"p2p\",\"dht\",\"federation\"]}}}" 2>/dev/null || true)"
  # SSE-aware: the tool result may arrive nested in an SSE `data:` envelope with its
  # own quotes backslash-escaped — make each quote's backslash optional so this
  # matches both a plain-JSON and an SSE transport (live-federation-gate.sh gotcha).
  local id_match
  id_match="$(printf '%s' "$resp" | grep -oaE '\\?"id\\?":\\?"WI-[0-9]+' | head -1)"
  if [ -n "$id_match" ]; then
    # On a duplicate_identity refusal the response carries the OPEN twin this filing
    # folded onto, so this id is the item that actually tracks the RED either way.
    LAST_FILED_EI_ID="$(printf '%s' "$id_match" | grep -oaE 'WI-[0-9]+')"
    log "EI filed OK → $LAST_FILED_EI_ID"
  else
    log "EI filing DID NOT CONFIRM (no WI id in response) — resp head: ${resp:0:200}"
  fi
}

# ── resolve the LIVE unit's bootstrap host/port — never hardcode here. ──
ENV_LINE="$(systemctl --user show "$DHT_UNIT" -p Environment 2>/dev/null || true)"
DHT_HOST="$(printf '%s' "$ENV_LINE" | grep -oE 'PAPERCUSP_DHT_HOST=[^ ]+' | cut -d= -f2)"
DHT_PORT="$(printf '%s' "$ENV_LINE" | grep -oE 'PAPERCUSP_DHT_PORT=[^ ]+' | cut -d= -f2)"
if [ -z "$DHT_HOST" ] || [ -z "$DHT_PORT" ]; then
  log "SKIP: could not resolve PAPERCUSP_DHT_HOST/PORT from '$DHT_UNIT' Environment= — is the unit installed? ($ENV_LINE)"
  exit 0
fi

ACTIVE_STATE="$(systemctl --user show "$DHT_UNIT" -p ActiveState --value 2>/dev/null || true)"
if [ "$ACTIVE_STATE" != "active" ]; then
  log "SKIP: $DHT_UNIT is not active (state=$ACTIVE_STATE) — nothing to probe; that's a separate, already-visible signal."
  exit 0
fi

# ── boot-grace (EI-8901): don't judge a unit that hasn't had time to come up yet. ──
ACTIVE_MONO_US="$(systemctl --user show "$DHT_UNIT" -p ActiveEnterTimestampMonotonic --value 2>/dev/null || echo 0)"
UPTIME_S="$(cut -d' ' -f1 /proc/uptime 2>/dev/null || echo 0)"
ACTIVE_S_AGO=0
if [ -n "$ACTIVE_MONO_US" ] && [ "$ACTIVE_MONO_US" != "0" ]; then
  ACTIVE_S_AGO="$(awk -v u="$UPTIME_S" -v m="$ACTIVE_MONO_US" 'BEGIN{printf "%d", u - (m/1000000)}')"
fi
if [ "$ACTIVE_S_AGO" -lt "$DHT_BOOT_GRACE_SEC" ] 2>/dev/null; then
  log "SKIP: $DHT_UNIT entered its current active state ${ACTIVE_S_AGO}s ago (< ${DHT_BOOT_GRACE_SEC}s boot-grace) — not yet judging (EI-8901)."
  exit 0
fi

# ── cross-host preflight (P-302): the remote leg is BEST-EFFORT by default. ──
# WHY THIS EXISTS: in cross-host mode the DIALLING leg runs on the remote host,
# so an unreachable remote makes the WHOLE run INCONCLUSIVE (exit 3,
# 'remote-leg-unavailable') — which would silently COST US the local
# bootstrap-wedge detection this timer was built for (EI-8892, the 3-day silent
# outage). The remote here is a LAPTOP: it is off most of the time, so wiring it
# in unconditionally would trade a detector that works every tick for one that
# goes dark whenever someone closes a lid, plus an INCONCLUSIVE EI every
# DHT_STALE_H forever. Cross-host SUBSUMES the local check (the announce still
# has to reach the bootstrap), so when the remote IS up we simply run the
# stronger probe, and when it is not we fall back to local-only and say so.
# A reachable-but-failing remote is NOT skipped — that is the real P-302 signal.
DHT_REMOTE_OPTIONAL="${DHT_REMOTE_OPTIONAL:-1}"
DHT_REMOTE_PREFLIGHT_SEC="${DHT_REMOTE_PREFLIGHT_SEC:-8}"
CROSS_HOST_SKIP_REASON=""
if [ -n "${DHT_REMOTE_HOST:-}" ] && [ "$DHT_REMOTE_OPTIONAL" = 1 ] && [ "${DHT_REQUIRE_CROSS_HOST:-0}" != 1 ]; then
  # `true` over ssh: cheapest possible "is this host answering" check. BatchMode
  # so a missing key fails fast instead of prompting and hanging the timer.
  if ! ssh -o BatchMode=yes -o ConnectTimeout="$DHT_REMOTE_PREFLIGHT_SEC" \
       -o StrictHostKeyChecking=accept-new "$DHT_REMOTE_HOST" true </dev/null >/dev/null 2>&1; then
    CROSS_HOST_SKIP_REASON="$DHT_REMOTE_HOST did not answer ssh within ${DHT_REMOTE_PREFLIGHT_SEC}s (host off/asleep/unreachable)"
    log "cross-host leg SKIPPED — $CROSS_HOST_SKIP_REASON. Falling back to a LOCAL-ONLY run so bootstrap-wedge detection is preserved; this is NOT filed (an off laptop is an expected condition, not a DHT signal). Set DHT_REQUIRE_CROSS_HOST=1 to make this INCONCLUSIVE instead."
    DHT_REMOTE_HOST=""
  fi
fi

# ── run the real probe. ──
run_probe() {
  local -a remote_args=()
  # P-302: with a remote peer configured the probe runs its DIALLING leg on the
  # other machine, so the run actually crosses the network. Without one it is
  # explicitly local-only and says so in its own verdict.
  if [ -n "${DHT_REMOTE_HOST:-}" ]; then
    remote_args=(--remote-host "$DHT_REMOTE_HOST" --remote-cwd "${DHT_REMOTE_CWD:?DHT_REMOTE_HOST requires DHT_REMOTE_CWD}")
    [ -n "${DHT_REMOTE_NODE:-}" ] && remote_args+=(--remote-node "$DHT_REMOTE_NODE")
    [ "${DHT_REQUIRE_CROSS_HOST:-0}" = 1 ] && remote_args+=(--require-cross-host)
  elif [ "${DHT_REQUIRE_CROSS_HOST:-0}" = 1 ]; then
    remote_args=(--require-cross-host)
  fi
  # The margin covers the probe's own budget plus ssh staging on the remote leg.
  cd "$REPO_ROOT" && timeout $(( (DHT_PROBE_TIMEOUT_MS / 1000) + 45 )) node "$PROBE" \
    --host "$DHT_HOST" --port "$DHT_PORT" --timeout-ms "$DHT_PROBE_TIMEOUT_MS" "${remote_args[@]}" 2>&1
}

log "probing bootstrap $DHT_HOST:$DHT_PORT (timeout ${DHT_PROBE_TIMEOUT_MS}ms) …"
# WI-4077: the probe itself now bounds ALL of its work (announce/flush AND
# connection-wait, not just the latter) to DHT_PROBE_TIMEOUT_MS, plus its own
# 5s teardown backstop — so it always self-reports well inside that budget.
# This outer `timeout` is now a pure last-resort backstop (should never
# actually fire); the wider margin just avoids re-clipping the probe's own
# diagnostic output the way the tighter +10s margin once did (empty
# "Probe output:" body on the WI-4077 incident, root-caused as the probe
# hanging past this wrapper's kill before reaching its own FAIL branch).
PROBE_OUT="$(run_probe)"
PROBE_EXIT=$?
log "$PROBE_OUT"

if [ "$PROBE_EXIT" -eq 0 ]; then
  echo "$(now_s)" >"$STATE_DIR/last-ok"; rm -f "$STATE_DIR/red-ei-filed"
  # SCOPE (P-302): without DHT_REMOTE_HOST this is a LOCAL-ONLY result — two
  # processes on THIS host. It proves the bootstrap is routing; it proves
  # nothing about any other machine, and nothing about the app process's own
  # ability to reach the DHT. Say so, every time: the previous version logged a
  # bare "HEALTHY" that was read as federation health for days.
  if [ -n "${DHT_REMOTE_HOST:-}" ]; then
    log "HEALTHY (CROSS-HOST) — bootstrap $DHT_HOST:$DHT_PORT carried a verified packet to/from $DHT_REMOTE_HOST. NOTE: measured with a standalone probe process; a per-process denial on the app itself is NOT covered."
  elif [ -n "$CROSS_HOST_SKIP_REASON" ]; then
    # Distinct from a deliberate local-only run: cross-host WAS configured and
    # was skipped. Never let this read as "cross-host health confirmed".
    log "HEALTHY (LOCAL-ONLY, cross-host SKIPPED) — bootstrap $DHT_HOST:$DHT_PORT routed between two processes on this host, but the configured cross-host leg did not run: $CROSS_HOST_SKIP_REASON. NOTHING is proven about machine-to-machine transport this tick."
  else
    log "HEALTHY (LOCAL-ONLY) — bootstrap $DHT_HOST:$DHT_PORT routed between two processes on this host. This does NOT prove any other machine can reach the DHT (set DHT_REMOTE_HOST to test that)."
  fi
  exit 0
fi

# ── INCONCLUSIVE (exit 3) is NOT a wedge — never file it as one. ──
# The probe distinguishes "the DHT is broken" (1) from "I could not run the
# experiment" (3). Filing an inconclusive run under the alarming
# "unreachable/wedged" title sends the next responder hunting a fault that never
# existed — the same false-alarm class as the WI-5804 crash below.
if [ "$PROBE_EXIT" -eq 3 ]; then
  log "INCONCLUSIVE — the probe could not carry out its experiment (NOT evidence of a wedge, NOT evidence of health): $PROBE_OUT"
  inconclusive_age_h="$(age_h "$STATE_DIR/inconclusive-ei-filed")"
  if [ "$inconclusive_age_h" -ge "$DHT_STALE_H" ]; then
    file_ei "papercup-isolated-dht liveness probe INCONCLUSIVE — the liveness signal itself is not running" \
      "The EI-8892/P-302 probe exited 3 (INCONCLUSIVE): it could not carry out its experiment, so there is NO liveness signal right now — neither healthy nor wedged. Silence must never read as green. Probe output:\n$PROBE_OUT"
    echo "$(now_s)" >"$STATE_DIR/inconclusive-ei-filed"
  fi
  exit 3
fi

# WI-5804 root cause: a FAIL is not always evidence the DHT is wedged — the
# probe's OWN node process can crash on a fatal signal (observed 2026-07-25
# 19:46 EDT: SIGBUS inside udx-native's prebuilt native addon, `timeout`'s
# "the monitored command dumped core" diagnostic), which is a probe-runtime
# fault unrelated to bootstrap health. GNU `timeout` reports a coredump this
# way only when the child actually died on a signal (not a plain non-zero
# exit), so this check can't misclassify a genuine "no connection" FAIL as a
# crash. Filing the alarming "bootstrap … unreachable/wedged" title for a
# one-off native-addon crash is a FALSE ALARM that sends the next responder
# hunting a wedge that never existed (the DHT was healthy on the very next
# tick 5min later). A crash is transient by nature, so retry ONCE immediately
# before deciding anything — if the retry is healthy, the DHT was never the
# problem; log + record it distinctly and skip the wedge EI entirely.
PROBE_CRASHED=0
case "$PROBE_OUT" in
  *"dumped core"*) PROBE_CRASHED=1 ;;
esac
if [ "$PROBE_CRASHED" -eq 1 ]; then
  log "PROBE CRASHED (native-addon signal, not a DHT signal) — retrying once immediately before judging bootstrap health: $PROBE_OUT"
  RETRY_OUT="$(run_probe)"
  RETRY_EXIT=$?
  log "$RETRY_OUT"
  if [ "$RETRY_EXIT" -eq 0 ]; then
    echo "$(now_s)" >"$STATE_DIR/last-ok"; rm -f "$STATE_DIR/red-ei-filed"
    log "HEALTHY on retry — bootstrap $DHT_HOST:$DHT_PORT connected within ${DHT_PROBE_TIMEOUT_MS}ms. Prior failure was a one-off probe-process crash (native addon signal), not a wedged DHT — no wedge EI filed."
    if [ "$DHT_NO_FILE" != 1 ]; then
      file_ei "papercup-isolated-dht liveness probe process crashed (native addon signal) — DHT itself confirmed healthy on immediate retry" \
        "The probe's node process died on a fatal signal (not a timeout/no-connection FAIL) before it could report bootstrap health: $PROBE_OUT An immediate retry against the SAME bootstrap $DHT_HOST:$DHT_PORT succeeded ($RETRY_OUT), confirming the DHT was never wedged — this is probe-runtime flakiness (a native addon, e.g. udx-native, crashing), tracked separately from the wedge-detection EI so it never sends a responder hunting a wedge that didn't exist. Low severity / informational; investigate only if this recurs."
    fi
    exit 0
  fi
  log "Retry ALSO failed — treating as a genuine possible wedge (not just a one-off crash); proceeding to the normal FAIL/escalation path."
  PROBE_OUT="$RETRY_OUT"
fi

# ── FAIL: dedup-file an EI (RED_REFILE_H window), never auto-restart. ──
RED_MARKER="$STATE_DIR/red-ei-filed"
red_verdict="$(red_dedup_check "$RED_MARKER" "$DHT_RED_REFILE_H")"
TITLE="papercup-isolated-dht liveness probe FAILED — bootstrap $DHT_HOST:$DHT_PORT unreachable/wedged"
BODY="EI-8892/P-302 durable probe (apps/operator/scripts/p2p-dht-liveness-probe.mjs via papercup-dht-liveness-check.sh) FAILED against the live $DHT_UNIT bootstrap $DHT_HOST:$DHT_PORT — a two-PROCESS, identity-verified hyperswarm announce/connect did not complete within ${DHT_PROBE_TIMEOUT_MS}ms. READ THE PROBE'S OWN VERDICT CODE BELOW before diagnosing: 'announce-timeout' = the bootstrap is not acking (the classic wedge); 'bootstrap-silent' = queries sent with nothing back, which is AMBIGUOUS between a dead/wrong bootstrap address and this host's outbound path being dropped — the probe names the discriminating capture; 'tx-blocked' = another leg reached the bootstrap in the same run, so THIS host's egress is the fault; 'same-host-degenerate'/'wrong-peer'/'self-connection' = the run did not actually prove what it was asked to. This is the SILENT-WEDGE class (2026-07-06→07-09 3-day outage): the unit reports ActiveState=active but is not actually routing DHT traffic — no passive systemd/port signal catches this. THIS SCRIPT DOES NOT RESTART THE UNIT (detection + escalation only, by design — EI-8901 boot-grace lesson: a restart-authority health check on a signal that spans process restarts risks a restart-storm). Manual recovery: systemctl --user restart $DHT_UNIT, then re-run this probe to confirm recovery: node apps/operator/scripts/p2p-dht-liveness-probe.mjs --host $DHT_HOST --port $DHT_PORT. Probe output:\n$PROBE_OUT"
if [ "${red_verdict%% *}" = "SUPPRESS" ]; then
  log "RED dedup: ${red_verdict#* }. $TITLE"
else
  log "RED dedup: ${red_verdict#* }"
  file_ei "$TITLE" "$BODY"
  red_marker_write "$RED_MARKER" "$LAST_FILED_EI_ID"
fi

# ── staleness: no successful probe in DHT_STALE_H ⇒ a LOUDER, separate signal. ──
last_ok_age_h="$(age_h "$STATE_DIR/last-ok")"
if [ "$last_ok_age_h" -ge "$DHT_STALE_H" ]; then
  stale_filed_age_h="$(age_h "$STATE_DIR/stale-ei-filed")"
  if [ "$stale_filed_age_h" -ge "$DHT_STALE_H" ]; then
    log "STALE: no successful probe for ${last_ok_age_h}h (>= ${DHT_STALE_H}h) — filing staleness EI"
    file_ei "papercup-isolated-dht STALE: no healthy probe for ${last_ok_age_h}h — the DHT liveness signal itself may be dark" \
      "The EI-8892 liveness probe has not recorded a single successful run in ${last_ok_age_h}h (threshold ${DHT_STALE_H}h). Check: systemctl --user list-timers papercup-isolated-dht-liveness.timer ; journalctl --user -u papercup-isolated-dht-liveness.service ; state in ~/.papercusp/dht-liveness/."
    echo "$(now_s)" >"$STATE_DIR/stale-ei-filed"
  fi
fi

exit 1
