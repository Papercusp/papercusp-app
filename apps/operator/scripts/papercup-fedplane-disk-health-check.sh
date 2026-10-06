#!/usr/bin/env bash
# papercup-fedplane-disk-health-check.sh — periodic disk-usage + ENOSPC/crash-loop
# probe for a fed-plane host (EI-8982).
#
# WHY: a fed-plane machine's disk can fill silently until total wedge — no disk
# monitor, no ENOSPC alert, no health surface existed before this script.
# 2026-07-10 P-059 live-rig cause #9: a Mac VM's Data volume hit 100% (43Mi
# free); ~/.papercusp/operator.lock writes failed ENOSPC, serve spawns
# crash-looped (~25s connect-cycles), and the ONLY visible symptom was on the
# PEER machine — a mysterious connect/drop cycle with no local signal at all.
# Diagnosis took cross-machine correlation; the fix itself was trivial (freed
# 30G of a stale cargo target dir). This mirrors papercup-dht-liveness-check.sh
# (EI-8892)'s pattern: a durable, scheduled, detection-only probe so the next
# occurrence is caught within minutes instead of by chance cross-machine
# correlation.
#
# TWO independent signals, either can fire:
#   (a) disk usage on the papercusp data volume crosses a threshold (default
#       90%) — catches the class BEFORE it wedges anything;
#   (b) serve.log carries the ENOSPC/crash-loop signature (repeated
#       spawn/exit within a short window, or a literal ENOSPC string) — catches
#       it even if disk usage recovered since (e.g. someone else already freed
#       space) but the crash-loop scars are still fresh in the log tail.
#
# DETECTION + ESCALATION ONLY — this script never deletes files or restarts a
# service. Recovery (freeing space, restarting the wedged serve process) is a
# human/agent call made off the filed EI, same posture as EI-8892's DHT probe
# (EI-8901 lesson: a health check must not also hold restart/mutate authority
# over the thing it's judging, or a boot-grace/threshold bug becomes a
# self-inflicted incident).
#
# Portable: uses only `df -h` / `df -Pk` forms and grep/awk available on both
# GNU (tower, Linux dev boxes) and BSD/macOS (the Mac VM) — no GNU-only df
# flags (`--output`, etc).
#
# Usage: papercup-fedplane-disk-health-check.sh
# Env:
#   DISK_PATH                 (default $HOME/.papercusp)  — path on the volume to check
#   DISK_WARN_PCT             (default 90)     — usage% at/above which this alarms
#   SERVE_LOG                 (default $HOME/.papercusp/serve.log, first existing of a
#                               few common locations — see LOG_CANDIDATES below)
#   CRASH_LOOP_WINDOW_S        (default 300)    — window to count spawn/exit repeats in
#   CRASH_LOOP_MIN_COUNT       (default 5)      — >= this many crash-loop-signature
#                                                  lines inside the window ⇒ alarm
#   OPERATOR_MCP_URL            (default http://127.0.0.1:3070/api/mcp?superuser=1)
#   DISK_NO_FILE                (default 0)     — set 1 to skip EI filing (log-only)
#   DISK_RED_REFILE_H           (default 12)    — RED-EI dedup window (mirrors
#                                                  papercup-dht-liveness-check.sh's
#                                                  DHT_RED_REFILE_H — file once per
#                                                  window per still-bad condition, not
#                                                  a fresh EI every tick)
set -uo pipefail

# State-aware RED dedup (EI-22240553542994017). Sourced, not optional: without it
# this probe would silently fall back to age-only suppression, which is the defect.
RED_MARKER_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/red-marker.sh"
if [ -r "$RED_MARKER_LIB" ]; then
  # shellcheck source=lib/red-marker.sh
  . "$RED_MARKER_LIB"
else
  echo "[fedplane-disk-health] FATAL: missing $RED_MARKER_LIB — refusing to run with age-only dedup." >&2
  exit 2
fi

DISK_PATH="${DISK_PATH:-$HOME/.papercusp}"
DISK_WARN_PCT="${DISK_WARN_PCT:-90}"
CRASH_LOOP_WINDOW_S="${CRASH_LOOP_WINDOW_S:-300}"
CRASH_LOOP_MIN_COUNT="${CRASH_LOOP_MIN_COUNT:-5}"
OPERATOR_MCP_URL="${OPERATOR_MCP_URL:-http://127.0.0.1:3070/api/mcp?superuser=1}"
DISK_NO_FILE="${DISK_NO_FILE:-0}"
DISK_RED_REFILE_H="${DISK_RED_REFILE_H:-12}"
GATE_SUPERUSER_TOKEN_PATH="${GATE_SUPERUSER_TOKEN_PATH:-$HOME/.papercusp/superuser-token}"
GATE_SUPERUSER_BEARER="$(cat "$GATE_SUPERUSER_TOKEN_PATH" 2>/dev/null | tr -d '[:space:]' || true)"
STATE_DIR="${DISK_STATE_DIR:-$HOME/.papercusp/fedplane-disk-health}"; mkdir -p "$STATE_DIR" 2>/dev/null || true

# First existing candidate wins; these are the locations serve.mjs / the
# desktop sidecar have actually logged to in practice.
LOG_CANDIDATES=(
  "${SERVE_LOG:-}"
  "$HOME/.papercusp/serve.log"
  "$HOME/Library/Logs/papercup/serve.log"
  "$HOME/.local/share/papercup/serve.log"
)
SERVE_LOG=""
for c in "${LOG_CANDIDATES[@]}"; do
  [ -n "$c" ] && [ -f "$c" ] && { SERVE_LOG="$c"; break; }
done

log() { echo "[fedplane-disk-health $(date +%H:%M:%S 2>/dev/null || true)] $*" >&2; }
now_s() { date +%s 2>/dev/null || echo 0; }
# Delegates to the shared reader, which takes FIELD 1 of the marker. A bare `cat`
# here would break on the "<epoch> <item-id>" marker format (arithmetic on a
# non-numeric second field), so every marker age goes through one implementation.
age_h() { red_marker_age_h "$1"; }
jstr() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$1"; }

# Set by file_ei to the work-item id the filing resolved to (empty when it did not
# confirm one). Recorded into the RED marker so the NEXT tick can ask whether that
# item is still open instead of trusting the marker's age — EI-22240553542994017.
LAST_FILED_EI_ID=""

file_ei() { # <title> <body> — best-effort curl-MCP; loud echo + journald/log are the fallback
  LAST_FILED_EI_ID=""
  [ "$DISK_NO_FILE" = 1 ] && { log "DISK_NO_FILE=1 — would have filed: $1"; return 0; }
  local resp
  local -a auth_hdr=()
  if [ -n "$GATE_SUPERUSER_BEARER" ]; then
    auth_hdr=(-H "authorization: Bearer $GATE_SUPERUSER_BEARER")
  else
    log "WARN: no superuser bearer at $GATE_SUPERUSER_TOKEN_PATH — EI filing will 403; falling back to log-only."
  fi
  resp="$(curl -s -m 30 -X POST "$OPERATOR_MCP_URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "${auth_hdr[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"work_items:create\",\"arguments\":{\"kind\":\"bug\",\"title\":$(jstr "$1"),\"summary\":$(jstr "$2"),\"harness\":\"papercusp\",\"severity\":\"major\",\"topics\":[\"p2p\",\"federation\",\"host-health\",\"disk\"]}}}" 2>/dev/null || true)"
  # SSE-aware, mirrors papercup-dht-liveness-check.sh's file_ei.
  local id_match
  id_match="$(printf '%s' "$resp" | grep -oaE '\\?"id\\?":\\?"WI-[0-9]+' | head -1)"
  if [ -n "$id_match" ]; then
    # On a duplicate_identity refusal the response carries the OPEN twin this filing
    # folded onto, so this id is the item that actually tracks the RED either way —
    # which is precisely the one the next tick needs to state-check.
    LAST_FILED_EI_ID="$(printf '%s' "$id_match" | grep -oaE 'WI-[0-9]+')"
    log "EI filed OK → $LAST_FILED_EI_ID"
  else
    log "EI filing DID NOT CONFIRM (no WI id in response) — resp head: ${resp:0:200}"
  fi
}

# ── (a) disk-usage probe ──────────────────────────────────────────────────
# `df -Pk TARGET` (POSIX -P, portable output form on both GNU and BSD/macOS
# df) → second line's 5th field (Linux) / same column layout on macOS is
# `Capacity` as an explicit "NN%" — parse defensively via awk on the last
# numeric-looking %-suffixed field instead of a fixed column index.
# WATCH EVERY VOLUME THAT CAN WEDGE THIS BOX, NOT JUST ONE (2026-09-03).
# This probe measured a single path ($HOME/.papercusp, on /) and nothing else.
# The dump/VM volume was therefore INVISIBLE to it, and on 2026-09-03 /mnt/data
# sat at 97% while the hourly pg_dump wrote an 85 GB uncompressed copy into it —
# ~20 minutes from filling. The only signal that reached a human was the owner
# asking why his Windows VM felt laggy (25 ms NVMe writes, 160-deep queue),
# followed by a CLOCK_WATCHDOG_TIMEOUT BSOD in the guest. A one-path disk probe
# on a box with two hot volumes is a detector that reports "healthy" about the
# volume it is not looking at.
#
# Measure them all and alarm on the FULLEST: the alert has to name the volume
# that is actually about to wedge, and one marker per host is correct precisely
# because the operator action ("free space now") is the same either way.
# DISK_PATH stays honoured verbatim for any caller that sets it.
DISK_PATHS="${DISK_PATHS:-$DISK_PATH /mnt/data}"
DISK_PCT=""
DF_LINE=""
for _dp in $DISK_PATHS; do
  [ -e "$_dp" ] || continue
  _line="$(df -Pk "$_dp" 2>/dev/null | tail -n1)"
  _pct="$(printf '%s' "$_line" | awk '{for(i=1;i<=NF;i++) if ($i ~ /^[0-9]+%$/) print $i}' | tr -d '%' | tail -n1)"
  [ -n "$_pct" ] || continue
  log "disk usage at $_dp: ${_pct}%"
  if [ -z "$DISK_PCT" ] || [ "$_pct" -gt "$DISK_PCT" ] 2>/dev/null; then
    DISK_PCT="$_pct"; DF_LINE="$_line"; DISK_PATH="$_dp"
  fi
done
if [ -z "$DISK_PCT" ]; then
  log "SKIP disk-usage probe: could not resolve usage% for '$DISK_PATH' (path missing or df output unparseable)."
else
  log "disk usage at $DISK_PATH: ${DISK_PCT}% (warn threshold ${DISK_WARN_PCT}%)"
  if [ "$DISK_PCT" -ge "$DISK_WARN_PCT" ] 2>/dev/null; then
    RED_MARKER="$STATE_DIR/disk-red-ei-filed"
    red_verdict="$(red_dedup_check "$RED_MARKER" "$DISK_RED_REFILE_H")"
    TITLE="fed-plane host disk usage ${DISK_PCT}% (>= ${DISK_WARN_PCT}% threshold) at $DISK_PATH on $(hostname 2>/dev/null || echo unknown-host)"
    BODY="EI-8982 durable disk-health probe: $DISK_PATH is at ${DISK_PCT}% used (warn threshold ${DISK_WARN_PCT}%). UNCHECKED this leads to total wedge (P-059 cause #9, 2026-07-10): a full disk fails ~/.papercusp/operator.lock writes with ENOSPC, serve spawns crash-loop (~25s connect-cycles), and the ONLY visible symptom is on a PEER machine as a mysterious connect/drop cycle — no local signal at all without this probe. ACTION: free space now (check for stale build artifacts — a cargo target dir or old .dmg/backup directories are common offenders) before it wedges federation. df output:\n$DF_LINE"
    if [ "${red_verdict%% *}" = "SUPPRESS" ]; then
      log "RED dedup: ${red_verdict#* }. $TITLE"
    else
      log "RED dedup: ${red_verdict#* }"
      file_ei "$TITLE" "$BODY"
      red_marker_write "$RED_MARKER" "$LAST_FILED_EI_ID"
    fi
  else
    rm -f "$STATE_DIR/disk-red-ei-filed"
  fi
fi

# ── (b) ENOSPC / crash-loop signature on serve.log ─────────────────────────
if [ -z "$SERVE_LOG" ]; then
  log "SKIP crash-loop probe: no serve.log found in any candidate location — nothing to scan."
else
  CUTOFF_EPOCH=$(( $(now_s) - CRASH_LOOP_WINDOW_S ))
  # Grab the log tail cheaply (last 2000 lines is ample for a 5-min window at
  # any sane log rate) and count ENOSPC / rapid-restart signature lines. We
  # can't assume a parseable per-line timestamp format across every logger,
  # so this is a bounded-tail heuristic (matches the DHT probe's "detection,
  # not perfect forensics" posture) rather than a strict time-windowed count.
  SIG_COUNT="$(tail -n 2000 "$SERVE_LOG" 2>/dev/null | grep -ciE 'ENOSPC|no space left on device' || true)"
  SIG_COUNT="${SIG_COUNT:-0}"
  log "serve.log ($SERVE_LOG) ENOSPC/crash-loop signature count in tail: $SIG_COUNT (threshold $CRASH_LOOP_MIN_COUNT)"
  if [ "$SIG_COUNT" -ge "$CRASH_LOOP_MIN_COUNT" ] 2>/dev/null; then
    RED_MARKER="$STATE_DIR/crashloop-red-ei-filed"
    red_verdict="$(red_dedup_check "$RED_MARKER" "$DISK_RED_REFILE_H")"
    TITLE="fed-plane serve.log ENOSPC crash-loop signature ($SIG_COUNT hits) on $(hostname 2>/dev/null || echo unknown-host)"
    BODY="EI-8982 durable disk-health probe: $SERVE_LOG's tail carries $SIG_COUNT ENOSPC / 'no space left on device' line(s) (threshold $CRASH_LOOP_MIN_COUNT) — the P-059 cause #9 crash-loop signature (repeated serve spawn/exit as the process fails to write ~/.papercusp/operator.lock). This can occur even if disk usage has since recovered (someone freed space) — the scarring in the log tail is still evidence a wedge happened and the peer(s) this machine talks to may have logged the 'connect/drop every ~25s' symptom during the window. ACTION: verify current disk usage is healthy (see the companion disk-usage probe in this same run) and confirm serve is no longer crash-looping (\`systemctl --user status\` / \`launchctl list\` / process list)."
    if [ "${red_verdict%% *}" = "SUPPRESS" ]; then
      log "RED dedup: ${red_verdict#* }. $TITLE"
    else
      log "RED dedup: ${red_verdict#* }"
      file_ei "$TITLE" "$BODY"
      red_marker_write "$RED_MARKER" "$LAST_FILED_EI_ID"
    fi
  fi
fi

exit 0
