#!/usr/bin/env bash
# papercup-backup-health-check.sh — periodic DB-backup freshness + failure probe (EI-10733).
#
# WHY: the Postgres backup failed 100% for ~30 DAYS and nothing noticed.
# 2026-07-12 (EI-10733): ~/.config/kopia/hooks/pre-snapshot.sh dumped the DB with
# `timeout 60`, but the DB had grown to 1.4GB gzipped — a dump that size cannot finish
# in 60s, so pg_dumpall was SIGTERMed mid-stream on EVERY cycle, the .tmp was deleted,
# and "pg-5432 FAIL" was appended to a logfile nobody reads. Meanwhile the last
# SUCCESSFUL dump (2026-06-12) still sat on disk looking exactly like a healthy backup.
# We had no recoverable database for a month and the only evidence was a stale mtime.
#
# It also had a second-order victim: when `timeout` killed pg_dumpall, its per-database
# `pg_dump` GRANDCHILD survived (reparented to systemd, no timeout of its own) holding
# AccessShareLock on ~593 tables. That orphan blocked every migration's ACCESS EXCLUSIVE,
# so the deploy's migrate step died on lock_timeout and the release pipeline wedged for
# 9h (EI-10730). One dead backup silently took the release pipeline with it.
#
# THE DETECTOR GAP THIS CLOSES: "the backup file exists" is NOT "the backup works".
# Nothing checked FRESHNESS or SUCCESS — the same cannot-discriminate class as a gate
# whose pass-branch fires on exactly the condition it exists to catch.
#
# THREE independent signals, any can fire:
#   (a) FRESHNESS — the newest dump artifact is older than BACKUP_MAX_AGE_H. This is
#       the signal that would have caught the 30-day death on day one. It holds even if
#       the run log has been rotated away, because it judges the ARTIFACT, not the log.
#   (b) CONSECUTIVE FAILURES — db-backup.log's tail shows >= BACKUP_MAX_FAILS "backup
#       FAILED" runs with no intervening "backup OK". This fires EARLY (within an hour or
#       two of the breakage) rather than waiting for the artifact to age past the freshness
#       bar, and it catches the case where an artifact is fresh but a LATER dump began failing.
#   (c) STRANDED TMP — a "*.tmp" pg_dump staging directory under BACKUP_DUMP_DIR/pg/ older
#       than BACKUP_STALE_TMP_MAX_H. This is the recurrence guard for EI-18678678853631218
#       (2026-07-26): a failed pg_dump -Fd leaves a 0700 postgres-owned "$db.tmp" that a
#       service-user `rm -rf` cannot remove on the failure path. Because pg_dump -Fd refuses
#       a non-empty target, ONE stranded .tmp silently fails every subsequent hourly run for
#       that database forever — (a) and (b) both eventually catch that (the artifact goes
#       stale / the log fills with FAILs), but this signal names the ACTUAL mechanism
#       directly instead of making the on-call rediscover it from a generic staleness alarm.
#       db-backup.sh's own rm_tmp() now falls back to `sudo -n rm -rf` and should prevent
#       this from ever recurring — this check is the independent verifier that it did.
#   (d) POSTGRES DATA-VOLUME HEADROOM — the filesystem containing BACKUP_DB_DATA_DIR is
#       at/above BACKUP_DISK_WARN_PCT. This catches a shared root volume approaching ENOSPC
#       before PostgreSQL loses the ability to write WAL, locks, or its own data directory.
#
# CONVERGED 2026-07-12 (EI-10733): the backup path is now db-backup.sh (pg_dump -Fd -j,
# per-DB, TOC-validated) — NOT the old pre-snapshot.sh `timeout 60 pg_dumpall | gzip`
# that produced pg-5432.sql.gz. This probe was repointed at db-backup.sh's artifacts +
# run log accordingly; the signal design is unchanged, only what it judges.
#
# DETECTION + ESCALATION ONLY — this script never re-runs a dump, kills a process, or
# touches the backup config. Recovery is a human/agent call made off the filed EI. Same
# posture as papercup-dht-liveness-check.sh (EI-8892) and papercup-fedplane-disk-health-check.sh
# (EI-8982): a health check must not also hold mutate authority over what it judges
# (EI-8901's lesson — a threshold bug then becomes a self-inflicted incident).
#
# Usage: papercup-backup-health-check.sh
# Env:
#   BACKUP_DUMP_DIR      (default /mnt/backup/db-dumps) — where the dumps land
#   BACKUP_ARTIFACTS     (default "pg/papercusp-state pg/papercusp-transcript pg/restart") — space-separated dump artifacts
#                                                              (relative to BACKUP_DUMP_DIR) that
#                                                              MUST stay fresh. These are the
#                                                              per-DB pg_dump -Fd directories
#                                                              db-backup.sh renames into place
#                                                              ONLY after a chown + pg_restore -l
#                                                              validation, so a fresh dir mtime
#                                                              means a *verified* dump — the
#                                                              faithful successor to the old
#                                                              single pg-5432.sql.gz. papercusp
#                                                              (23GB) + restart (4.6GB) are the
#                                                              real-state DBs; papercusp_su /
#                                                              postgres are tiny/derived and
#                                                              deliberately not gated.
#   BACKUP_OPTIONAL_ARTIFACTS (default "$HOME/.papercusp-workspaces/*/db-dumps/pg-embedded.sql.gz")
#                                     — artifacts gated after a PROVEN newer degraded hook, not
#                                       on age alone, and not on EXISTENCE. Workspace policy can
#                                       be event-only, so elapsed wall time is not itself a miss;
#                                       allowed to be ABSOLUTE paths (these live beside each
#                                       workspace, not under BACKUP_DUMP_DIR). Absent ⇒ silent
#                                       (a box with no workspace backups is not broken);
#                                       stale + latest hook degraded ⇒ alarm.
#                                       EI-20109034777197353 recurrence guard: the workspace
#                                       pre-snapshot pg_dump died and went unnoticed for 26h
#                                       precisely because NO probe watched its artifact — the
#                                       snapshot ledger said status='ok' the whole time.
#   BACKUP_MAX_AGE_H     (default 6)   — artifact older than this ⇒ alarm (dumps run ~hourly)
#   BACKUP_MAX_FAILS     (default 3)   — this many trailing FAILED runs with no "OK" ⇒ alarm
#   BACKUP_STALE_TMP_MAX_H (default 2) — a "*.tmp" pg_dump staging dir under
#                                        BACKUP_DUMP_DIR/pg/ older than this ⇒ alarm
#                                        (EI-18678678853631218 recurrence guard — see above)
#   BACKUP_DB_DATA_DIR     (default /var/lib/postgresql/18/main) — a path on the PostgreSQL
#                                        data filesystem whose usage should be monitored
#   BACKUP_DISK_WARN_PCT   (default 90)  — usage percentage at/above which the PostgreSQL
#                                        data-volume headroom alarm fires
#   BACKUP_HOOK_LOG      (default $BACKUP_DUMP_DIR/db-backup.log) — db-backup.sh's run log
#   OPERATOR_MCP_URL     (default http://127.0.0.1:3070/api/mcp?superuser=1)
#   BACKUP_NO_FILE       (default 0)   — set 1 to skip EI filing (log-only / dry-run)
#   BACKUP_RED_REFILE_H  (default 12)  — RED-EI dedup window (mirrors DHT_RED_REFILE_H /
#                                        DISK_RED_REFILE_H — file once per window per still-bad
#                                        condition, not a fresh EI every tick)
set -uo pipefail

# State-aware RED dedup (EI-22240553542994017). Sourced, not optional: without it
# this probe falls back to age-only suppression — "I filed something inside the
# window" logged with the words "RED already tracked", which is a strictly
# stronger claim than what was checked. On the disk detector that gap ran 10h39m
# against a DROPPED item while the journal asserted the condition was owned.
RED_MARKER_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/red-marker.sh"
if [ -r "$RED_MARKER_LIB" ]; then
  # shellcheck source=lib/red-marker.sh
  . "$RED_MARKER_LIB"
else
  echo "[backup-health] FATAL: missing $RED_MARKER_LIB — refusing to run with age-only dedup." >&2
  exit 2
fi

# ── ALARM SAFETY: a TEST must not be able to fire the real alarm (EI-10746) ──
# Its sibling ~/.config/kopia/healthcheck.sh had the identical hole and it BIT: on
# 2026-07-12 22:25, three failure-path test runs against a 4-minute-old healthy dump each
# rang the real alarm and paged the whole fleet. Both scripts offered an opt-out
# (BACKUP_ALERT_CMD there, BACKUP_NO_FILE here) and neither ENFORCED it — so the default
# way to test the alarm was to fire it. A guard you must REMEMBER is not a guard.
#
# Structural rule: OVERRIDING A THRESHOLD IS THE DEFINITION OF A NON-PRODUCTION RUN.
# Detected HERE, before the `${VAR:-default}` assignments below erase the difference
# between "unset" and "set to the default value" (${VAR+x} can still see it). The verdict
# and exit path are untouched — only the FILING is withheld, so a test still gets the truth.
# BACKUP_ALERT_FORCE=1 files anyway, for the rare case a non-default threshold should.
if [ -z "${BACKUP_ALERT_FORCE:-}" ] \
   && { [ -n "${BACKUP_MAX_AGE_H+x}" ] || [ -n "${BACKUP_MAX_FAILS+x}" ] || [ -n "${BACKUP_STALE_TMP_MAX_H+x}" ] || [ -n "${BACKUP_DISK_WARN_PCT+x}" ] || [ -n "${BACKUP_VOLUME_WARN_PCT+x}" ] || [ -n "${BACKUP_VOLUME_FLOOR_PCT+x}" ] || [ -n "${BACKUP_TMPDIR_MAX_ENTRIES+x}" ] || [ -n "${PC_BACKUP_MIN_FREE_GB+x}" ] || [ -n "${PC_BACKUP_SPACE_SAFETY+x}" ]; } \
   && [ "${BACKUP_NO_FILE:-0}" != 1 ]; then
  echo "[backup-health] ALARM SUPPRESSED: a threshold was overridden (BACKUP_MAX_AGE_H/BACKUP_MAX_FAILS/BACKUP_STALE_TMP_MAX_H/BACKUP_DISK_WARN_PCT/BACKUP_VOLUME_WARN_PCT/BACKUP_VOLUME_FLOOR_PCT/BACKUP_TMPDIR_MAX_ENTRIES/PC_BACKUP_MIN_FREE_GB/PC_BACKUP_SPACE_SAFETY) — that is a TEST run, not production. Forcing BACKUP_NO_FILE=1 (no EI will be filed). Set BACKUP_ALERT_FORCE=1 to file anyway." >&2
  BACKUP_NO_FILE=1
fi

# WI-2145397: follow the SAME env seam papercusp-db-backup.sh:60 WRITES through, so this
# probe measures the tree the backup actually writes. This is the identical fix WI-2145150
# leg (c) made to kopia-healthcheck.sh:52; this script was the second consumer and was missed.
#
# Hardcoding the default here meant the dump relocation left the probe tailing
# /mnt/data/Backup/db-dumps/db-backup.log — a file nothing appends to any more, frozen on
# "backup FAILED". That is TWO failures, and the second is the dangerous one:
#   1. a PERMANENT false alarm — no "backup OK" line can ever arrive to reset the
#      consecutive-failure count, so the alarm re-fires forever (it filed WI-2145343);
#   2. a BLIND detector — a genuine failure in the live tree raises nothing at all,
#      which is precisely the 30-day-unnoticed failure mode EI-10733 exists to prevent.
#
# An explicitly-set BACKUP_DUMP_DIR still wins, which the self-test cases below rely on
# (they pass BACKUP_DUMP_DIR="$t/dump" to judge a temp tree instead of live state).
# Fallback moved to the live dump volume 2026-09-05 (WI-2146225) — see the long
# note in papercusp-db-backup.sh. This script's own header (line ~139) already
# records what the stale fallback did here: it tailed a db-backup.log frozen on
# "backup FAILED", so the alarm could never clear and was blind to real failures.
BACKUP_DUMP_DIR="${BACKUP_DUMP_DIR:-${PAPERCUSP_HOST_PG_DUMP_DIR:-/mnt/backup/db-dumps}}"
# WI-2146225 cutover 2026-09-05: papercusp is dumped as a TIER PAIR, and the
# undifferentiated pg/papercusp dump it used to name here is RETIRED — nothing
# writes that path any more. Leaving the old default would have produced BOTH
# failures this file's own header warns about, at once: a PERMANENT false alarm on
# a path that can never be fresh again, AND a blind detector, because the two
# artifacts that now hold the whole database were not being looked at by anything.
# Both tiers are listed because either one going stale means real data is unbacked
# — tier 1 (state) is what restarts the system and is the tier kopia carries, tier
# 2 (transcript) is the ONLY copy of session_turns + tool_invocations that exists.
# ⚠ TRAVELS WITH THE PRODUCER: if you ever set PC_BACKUP_TIERS_ENABLED=0 in
# papercusp-db-backup.sh, papercusp falls back to one undifferentiated dump and
# this list must go back to pg/papercusp in the same change, or the alarm inverts
# again. The producer's is_tiered() comment names this dependency from its side.
BACKUP_ARTIFACTS="${BACKUP_ARTIFACTS:-pg/papercusp-state pg/papercusp-transcript pg/restart}"
# Unquoted on purpose at the loop below so the glob expands per workspace; an
# unmatched glob stays literal, which then reads as "absent" and is silent.
#
# `-` not `:-` deliberately: an explicitly EMPTY value must mean "gate nothing",
# not "use the default". With `:-` the two are indistinguishable, so a caller
# that opts out (the self-test does exactly this) silently gets the default set
# back — and here that default points at a REAL artifact on the host, which made
# an isolated test case judge live state. Caught by self-test case 4.
BACKUP_OPTIONAL_ARTIFACTS="${BACKUP_OPTIONAL_ARTIFACTS-$HOME/.papercusp-workspaces/*/db-dumps/pg-embedded.sql.gz}"
BACKUP_MAX_AGE_H="${BACKUP_MAX_AGE_H:-6}"
BACKUP_MAX_FAILS="${BACKUP_MAX_FAILS:-3}"
BACKUP_STALE_TMP_MAX_H="${BACKUP_STALE_TMP_MAX_H:-2}"
BACKUP_DB_DATA_DIR="${BACKUP_DB_DATA_DIR:-/var/lib/postgresql/18/main}"
BACKUP_DISK_WARN_PCT="${BACKUP_DISK_WARN_PCT:-90}"
# WI-2141004: the alert names the CURRENT top consumers, read at alert time.
# These bound that read so a slow or unreachable database can never delay the alarm.
BACKUP_DB_NAME="${BACKUP_DB_NAME:-papercusp}"
BACKUP_DB_PORT="${BACKUP_DB_PORT:-5432}"
BACKUP_CONSUMERS_TIMEOUT_S="${BACKUP_CONSUMERS_TIMEOUT_S:-10}"
# TOAST-bloat signature. A high-churn large-bytea table ratchets its TOAST relation
# upward forever because plain VACUUM marks TOAST pages reusable but never returns
# them to the OS. The discriminator is TOAST BYTES PER CATALOG-ESTIMATED ROW, which
# separates bloat from a legitimately large table without detoasting anything:
# measured 2026-09-02, gateway_payload_blobs was 51 MiB/row (60.59 GiB of TOAST over
# 1,176 rows, ~98.7% bloat) while session_archive_files — genuine stored content —
# was 0.23 MiB/row. The denominator must come from persisted pg_class metadata:
# pg_stat_user_tables.n_live_tup is a volatile stats estimate that can reset to a
# tiny value while the catalog's reltuples estimate remains accurate.
BACKUP_BLOAT_MIN_TOAST_GIB="${BACKUP_BLOAT_MIN_TOAST_GIB:-5}"
BACKUP_BLOAT_MIB_PER_ROW="${BACKUP_BLOAT_MIB_PER_ROW:-8}"
# This tracks the volume the DUMPS land on — a separate capacity domain from PGDATA/root,
# so it needs its own level and derivative. Alert with 8% free so there is a 6%-of-volume
# intervention window before the 2% admission floor used by backup/checkpoint operations.
#
# ⚠ WI-2145397: dumps and the Kopia repository NO LONGER SHARE A VOLUME on this host.
# They both sat on /mnt/data when this check was written; WI-2145150 leg (a) moved the
# dumps to /mnt/backup (/dev/sda1) while the repo stayed at /mnt/data/Backup/kopia-repo
# (/dev/nvme1n1). Because this derives from BACKUP_DUMP_DIR it correctly follows the
# dumps — the right subject, since the alarm exists to answer "will the next dump fit",
# which is exactly what the "papercusp SKIPPED — needs ~154 GiB" failure was.
# KNOWN GAP, deliberately not widened here: the Kopia repo's volume is therefore no
# longer covered by this check. Point BACKUP_VOLUME_PATH at it explicitly, or add a
# second derivative, if repo-volume headroom needs its own alarm.
BACKUP_VOLUME_PATH="${BACKUP_VOLUME_PATH:-$BACKUP_DUMP_DIR}"
BACKUP_VOLUME_WARN_PCT="${BACKUP_VOLUME_WARN_PCT:-92}"
BACKUP_VOLUME_FLOOR_PCT="${BACKUP_VOLUME_FLOOR_PCT:-2}"
# Keep the capacity alarm in the producer's units. papercusp-db-backup.sh uses
# these exact defaults to refuse a dump when free space is below
# `last_dump_size * PC_BACKUP_SPACE_SAFETY% + PC_BACKUP_MIN_FREE_GB`; a separate
# percentage-only alarm can therefore fire too late as databases grow or the
# volume is resized. The env seam is intentional: the systemd producer and this
# probe can be pinned together for a deliberate host-specific policy.
PC_BACKUP_MIN_FREE_GB="${PC_BACKUP_MIN_FREE_GB:-120}"
PC_BACKUP_SPACE_SAFETY="${PC_BACKUP_SPACE_SAFETY:-140}"
# Colon-separated. /tmp/pcv is the TMPDIR libs/test-config/src/vitest-config.ts FORCES for
# every test process, which is why it is watched explicitly and not merely as part of /tmp:
# it is a subdirectory, so a count of /tmp's top level cannot see inside it. That exact blind
# spot is why WI-38830 went unnoticed (see check_tmpdir_entry_count below).
BACKUP_TMPDIR_WATCH="${BACKUP_TMPDIR_WATCH:-/tmp:/tmp/pcv}"
BACKUP_TMPDIR_MAX_ENTRIES="${BACKUP_TMPDIR_MAX_ENTRIES:-50000}"
BACKUP_HOOK_LOG="${BACKUP_HOOK_LOG:-$BACKUP_DUMP_DIR/db-backup.log}"
OPERATOR_MCP_URL="${OPERATOR_MCP_URL:-http://127.0.0.1:3070/api/mcp?superuser=1}"
BACKUP_NO_FILE="${BACKUP_NO_FILE:-0}"
BACKUP_RED_REFILE_H="${BACKUP_RED_REFILE_H:-12}"
GATE_SUPERUSER_TOKEN_PATH="${GATE_SUPERUSER_TOKEN_PATH:-$HOME/.papercusp/superuser-token}"
GATE_SUPERUSER_BEARER="$(cat "$GATE_SUPERUSER_TOKEN_PATH" 2>/dev/null | tr -d '[:space:]' || true)"
STATE_DIR="${BACKUP_STATE_DIR:-$HOME/.papercusp/backup-health}"; mkdir -p "$STATE_DIR" 2>/dev/null || true

log() { echo "[backup-health $(date +%H:%M:%S 2>/dev/null || true)] $*" >&2; }
now_s() { date +%s 2>/dev/null || echo 0; }
# Delegates to the shared reader, which takes FIELD 1 of the marker. The old
# implementation was `cat` piped into arithmetic, which BREAKS on the
# "<epoch> <item-id>" marker format red_marker_write now produces — a two-field
# marker would make `$(( now - "1788465012 WI-2143622" ))` a syntax error and the
# age unusable. Every marker age goes through one implementation for that reason.
age_h() { red_marker_age_h "$1"; }
mtime_s() { local f="$1"; stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0; }
jstr() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$1"; }

# Mark a RED as filed, so we file once per BACKUP_RED_REFILE_H window instead of every tick.
# NEVER writes the marker on a dry-run: file_ei() no-ops under BACKUP_NO_FILE=1, so writing
# the marker anyway would let a harmless dry-run SUPPRESS the next REAL filing for 12h — a
# dry-run that disarms the alarm it is testing.
#
# ⚠ THAT IS EXACTLY WHAT WAS HAPPENING (EI-10746, fixed 2026-07-12). This function was
# defined, its rationale was written out in full above — and then NEVER CALLED. All three
# call sites inlined `echo "$(now_s)" >"$RED_MARKER"`, bypassing the guard completely. So a
# BACKUP_NO_FILE=1 dry-run skipped the EI (correct) but STILL wrote the marker (wrong), and
# the next REAL red was silently suppressed for 12 hours. Testing the alarm turned the alarm
# off — the precise failure this comment claims to prevent. The "discrimination test below"
# the comment used to cite did not exist either; it does now (--self-test), and it fails if
# any call site ever bypasses mark_red again.
#
# It now records the FILED ITEM ID alongside the timestamp (EI-22240553542994017),
# so the next tick can ask whether that item is still open instead of trusting the
# marker's age. The BACKUP_NO_FILE guard above is unchanged and still comes first:
# a dry-run must not write a marker at all, id or no id.
mark_red() { [ "$BACKUP_NO_FILE" = 1 ] && return 0; red_marker_write "$1" "$LAST_FILED_EI_ID"; }

# red_gate <marker> <label> — the ONE dedup decision, shared by all nine RED sites.
# Returns 0 when the caller should file, 1 when it should skip, and logs the
# library's verdict VERBATIM either way.
#
# Logging the verdict text rather than a hand-written sentence is the point of
# EI-22240553542994017. Every site used to print the words "RED already tracked",
# which asserts the condition is OWNED — while the code had only checked that a
# filing happened inside the window. When the tracked item had been dropped those
# words were false, and false in the direction that stops anyone looking: on the
# disk detector the journal asserted ownership for 10h39m while nothing tracked
# the RED. red_dedup_check returns a reason that states exactly what it did and
# did not establish ("still open (state 'open')" vs "records NO item id — tracking
# UNVERIFIED, suppressing on age alone"), so the journal can no longer claim more
# than was checked.
red_gate() {
  local marker="${1:-}" label="${2:-}" verdict
  verdict="$(red_dedup_check "$marker" "$BACKUP_RED_REFILE_H")"
  log "RED dedup ($label): ${verdict#* }"
  [ "${verdict%% *}" = "SUPPRESS" ] && return 1
  return 0
}

# Set by file_ei to the work-item id the filing resolved to (empty when it did not
# confirm one). mark_red records it into the marker so the NEXT tick can state-check
# the item rather than trusting the marker's age — EI-22240553542994017.
LAST_FILED_EI_ID=""

file_ei() { # <title> <body> — best-effort curl-MCP; loud echo + journald are the fallback
  LAST_FILED_EI_ID=""
  [ "$BACKUP_NO_FILE" = 1 ] && { log "BACKUP_NO_FILE=1 — would have filed: $1"; return 0; }
  local resp
  local -a auth_hdr=()
  if [ -n "$GATE_SUPERUSER_BEARER" ]; then
    auth_hdr=(-H "authorization: Bearer $GATE_SUPERUSER_BEARER")
  else
    log "WARN: no superuser bearer at $GATE_SUPERUSER_TOKEN_PATH — EI filing will 403; falling back to log-only."
  fi
  resp="$(curl -s -m 30 -X POST "$OPERATOR_MCP_URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "${auth_hdr[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"work_items:create\",\"arguments\":{\"kind\":\"bug\",\"title\":$(jstr "$1"),\"summary\":$(jstr "$2"),\"harness\":\"papercusp\",\"severity\":\"critical\",\"topics\":[\"backup\",\"data-safety\",\"host-health\"]}}}" 2>/dev/null || true)"
  local id_match
  id_match="$(printf '%s' "$resp" | grep -oaE '\\?"id\\?":\\?"WI-[0-9]+' | head -1)"
  if [ -n "$id_match" ]; then
    # On a duplicate_identity refusal the response carries the OPEN twin this
    # filing folded onto, so this id is the item that actually tracks the RED
    # either way — precisely the one the next tick needs to state-check.
    LAST_FILED_EI_ID="$(printf '%s' "$id_match" | grep -oaE 'WI-[0-9]+')"
    log "EI filed OK → $LAST_FILED_EI_ID"
  else
    log "EI filing DID NOT CONFIRM (no WI id in response) — resp head: ${resp:0:200}"
  fi
}

# ── (d) POSTGRES DATA-VOLUME HEADROOM ─────────────────────────────────────
# `df -Pk TARGET` is portable across GNU/Linux and macOS. Parse the explicit
# NN% field instead of assuming a fixed column: a mount path containing spaces
# can shift the final field, while the percentage token remains unambiguous.
#
# ── WHY A TREND (WI-38595, 2026-08-14) ───────────────────────────────────
# A LEVEL alone is not actionable, and this alarm proved it: WI-38595 was filed
# at 90%, sat unclaimed 19.4h, and was found at 95% — ~104 GiB gone in the gap.
# Nothing on the item said the volume was STILL FALLING, so a genuine "~17h to
# ENOSPC, fleet-wide Postgres outage" read like a chronic "disk is fullish"
# warning. The DERIVATIVE is what turns this alarm into a deadline.
#
# It is also the only thing we can afford. A `du` of a multi-TiB shared root
# volume is ~7 MINUTES of heavy IO (measured on this box), so a probe that runs
# hourly must not scan for consumers — but remembering each df reading is O(1).
# Hence: report the rate we get for free, and hand over the scan RECIPE for the
# receiving agent to run ONCE, instead of scanning on every tick.
#
# The trend deliberately does NOT go in the title. work_items:create dedupes on
# admissionIdentity(title).titleKey (_create-core.ts), so a title carrying a
# changing "~17h to full" would mint a BRAND NEW item on every refile instead of
# deduping onto the open one. Keep the title stable; put the varying part here.
disk_trend_line() { # <avail_kb> [history-name] [floor-kb] [floor-label]
  # Echoes ONE human line. Never fails, never blocks the alarm. A floor of zero
  # preserves the original PGDATA "ETA TO FULL" semantics; the backup volume
  # passes its admission floor so the countdown names the actionable boundary.
  local avail_kb="${1:-}" hist_name="${2:-db-disk-history}" floor_kb="${3:-0}" floor_label="${4:-FULL}"
  local hist="$STATE_DIR/$hist_name" now="" line_count=0
  now="$(now_s)"
  [[ "$avail_kb" =~ ^[0-9]+$ ]] || { echo "trend: unavailable (available-space field unparseable)"; return 0; }
  # Append BEFORE reading, so even a first-ever run leaves a baseline for the next.
  printf '%s %s\n' "$now" "$avail_kb" >>"$hist" 2>/dev/null || true
  line_count="$(wc -l <"$hist" 2>/dev/null || echo 0)"
  if [ "${line_count:-0}" -gt 240 ] 2>/dev/null; then
    { tail -n 240 "$hist" >"$hist.tmp" 2>/dev/null && mv "$hist.tmp" "$hist" 2>/dev/null; } || true
  fi
  # Compare against the most recent valid prior sample. An older retained sample can
  # describe a recovery while the current interval is declining, making the long-window
  # net change look stable and masking the actionable trend.
  # A malformed/garbage history must degrade to "no baseline", never to a wrong number.
  awk -v now="$now" -v cur="$avail_kb" -v floor="$floor_kb" -v floor_label="$floor_label" '
    /^[0-9]+ [0-9]+$/ && $1 < now { if (latest == 0 || $1 > latest) { latest = $1; latest_avail = $2 } }
    END {
      if (latest == 0) { print "trend: no prior sample yet (this run seeds the baseline)"; exit }
      span_h = (now - latest) / 3600.0
      if (span_h < 0.5) { printf "trend: baseline too recent (%dm) to extrapolate\n", int(span_h * 60); exit }
      lost_kb = latest_avail - cur
      rate = lost_kb / 1048576.0 / span_h
      if (rate <= 0.01) {
        printf "trend: NOT shrinking over the last %.1fh (free space changed %+.1f GiB)\n", span_h, -lost_kb / 1048576.0
        exit
      }
      headroom = cur - floor
      if (headroom <= 0) {
        printf "trend: losing %.2f GiB/h over the last %.1fh — AT/BELOW %s now\n", rate, span_h, floor_label
        exit
      }
      printf "trend: losing %.2f GiB/h over the last %.1fh — ETA TO %s ~%.0fh at this rate\n", rate, span_h, floor_label, (headroom / 1048576.0) / rate
    }
  ' "$hist" 2>/dev/null || echo "trend: unavailable"
}

top_db_consumers() {
  # Echoes a DERIVED block naming the current largest relations, plus a TOAST-bloat
  # verdict for any that carry the signature. Never fails, never blocks the alarm —
  # an unreachable database degrades to one explanatory line, exactly like
  # disk_trend_line() degrades to "no baseline".
  #
  # WHY THIS IS DERIVED AND NOT WRITTEN DOWN (WI-2141004). This block replaced a
  # hand-written sentence that read "Measured on this box: PGDATA was 34 GiB of a
  # 1.9 TiB volume (1.8%), while VM disk images were 566 GiB (37%)". Both numbers were
  # true when written on 2026-08-14 and false by 2026-09-02 — PGDATA had grown to
  # 154 GiB and the Windows VM had been moved off the volume entirely — but the probe
  # kept asserting them as current guidance on every fire, and every issue it filed
  # inherited them. Three work-items (WI-38831, WI-39344, WI-40173) chased the owner's
  # VM images for three weeks on the strength of that sentence while the actual
  # consumer, a 60.59 GiB bloated TOAST relation, went unexamined. A measurement
  # embedded in generated prose is invisible to every typecheck and test in the repo,
  # so the only safe form is the one that cannot go stale: read it at alert time.
  local sql out
  sql="WITH relation_sizes AS (
           SELECT c.oid,
                  n.nspname,
                  c.relname,
                  pg_total_relation_size(c.oid)::numeric AS relation_bytes,
                  COALESCE(pg_total_relation_size(c.reltoastrelid),0)::numeric AS toast_bytes,
                  GREATEST(c.reltuples,0)::numeric AS estimated_rows
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r','p')
              AND n.nspname NOT IN ('pg_catalog','information_schema')
         )
         SELECT round(relation_bytes/1073741824.0,2)||' GiB  '||nspname||'.'||relname||
                CASE WHEN toast_bytes > ${BACKUP_BLOAT_MIN_TOAST_GIB}*1073741824::numeric
                           AND estimated_rows > 0
                           AND (toast_bytes/1048576.0)/estimated_rows > ${BACKUP_BLOAT_MIB_PER_ROW}
                     THEN '   <<< LIKELY TOAST BLOAT: '||round(toast_bytes/1073741824.0,2)
                          ||' GiB of TOAST over '||round(estimated_rows,0)||' catalog-estimated live rows ('
                          ||round((toast_bytes/1048576.0)/estimated_rows,1)
                          ||' MiB/estimated row). Plain VACUUM cannot return TOAST pages to the OS; only a rewrite can.'
                     ELSE '' END
           FROM relation_sizes
          ORDER BY relation_bytes DESC
          LIMIT 6"
  # 2>&1, deliberately. Sending stderr to /dev/null makes a BROKEN QUERY indistinguishable
  # from an empty result, so the detector reads as "nothing to report" while being dead.
  # That is not hypothetical: the first version of this query multiplied two int4 literals
  # (5*1073741824), overflowed, and returned "ERROR: integer out of range" on every call.
  # The self-tests still passed, because a silent failure is exactly what they asserted was
  # safe. A query that cannot run must be LOUD.
  out="$(timeout "${BACKUP_CONSUMERS_TIMEOUT_S}s" sudo -n -u postgres psql \
           -p "$BACKUP_DB_PORT" -d "$BACKUP_DB_NAME" -tA -c "$sql" 2>&1)" || true
  if grep -qE '^(ERROR|FATAL|psql):' <<<"$out"; then
    log "WARN top-consumers query FAILED (the alert will not name a consumer): $(printf '%s' "$out" | head -1)"
    out=""
  fi
  if [ -z "$out" ]; then
    echo "  (could not read live relation sizes: psql unavailable, unreachable, or timed out after ${BACKUP_CONSUMERS_TIMEOUT_S}s.
   Read them by hand before blaming anything: SELECT relname, pg_size_pretty(pg_total_relation_size(oid))
   FROM pg_class ORDER BY pg_total_relation_size(oid) DESC LIMIT 10;)"
    return 0
  fi
  printf '%s\n' "$out" | sed 's/^/  /'
}

check_db_disk_headroom() {
  local df_line="" disk_pct="" red_marker="" avail_kb="" trend=""
  if [ -e "$BACKUP_DB_DATA_DIR" ]; then
    df_line="$(df -Pk "$BACKUP_DB_DATA_DIR" 2>/dev/null | tail -n1)"
    disk_pct="$(printf '%s' "$df_line" | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+%$/) print $i}' | tr -d '%' | tail -n1)"
    # Available is the field immediately BEFORE the capacity token — located the
    # same way as disk_pct above, so a mount path containing spaces cannot shift it.
    avail_kb="$(printf '%s' "$df_line" | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+%$/) { print $(i - 1); exit }}')"
  fi

  if [ -z "$disk_pct" ]; then
    log "SKIP disk-headroom probe: could not resolve usage% for '$BACKUP_DB_DATA_DIR' (path missing or df output unparseable)."
    return 0
  fi
  if ! [[ "$disk_pct" =~ ^[0-9]+$ ]] || ! [[ "$BACKUP_DISK_WARN_PCT" =~ ^[0-9]+$ ]] || [ "$BACKUP_DISK_WARN_PCT" -gt 100 ] 2>/dev/null; then
    log "SKIP disk-headroom probe: invalid usage/threshold (usage='$disk_pct', threshold='$BACKUP_DISK_WARN_PCT')."
    return 0
  fi

  # Sample on EVERY run, green included — a baseline that only starts accumulating
  # once the volume is already red can never produce a rate when one is needed.
  trend="$(disk_trend_line "$avail_kb")"
  log "Postgres data-volume usage at $BACKUP_DB_DATA_DIR: ${disk_pct}% (warn threshold ${BACKUP_DISK_WARN_PCT}%) | ${trend}"
  red_marker="$STATE_DIR/db-disk-red-ei-filed"
  if [ "$disk_pct" -ge "$BACKUP_DISK_WARN_PCT" ]; then
    local host consumers
    host="$(hostname 2>/dev/null || echo unknown-host)"
    # Read at ALERT TIME, so the filed issue names the consumer that exists now.
    consumers="$(top_db_consumers)"
    local title="Postgres data-volume disk usage ${disk_pct}% (>= ${BACKUP_DISK_WARN_PCT}% threshold) on ${host}"
    # Real newlines, not literal "\n": the body is JSON-encoded by jstr(), so a
    # backslash-n survived into the stored summary and rendered as the two
    # characters \n to every agent that read it.
    local body="EI-20115751074601731 durable disk-headroom probe: the filesystem containing PostgreSQL data path '$BACKUP_DB_DATA_DIR' is ${disk_pct}% used (warn threshold ${BACKUP_DISK_WARN_PCT}%). A full shared root volume takes PostgreSQL down fleet-wide by preventing WAL, lock, and data-directory writes.

${trend}

ACTION: inspect current filesystem consumers and free space before starting disk-heavy work. This probe is detection-only; it never deletes files or restarts PostgreSQL.

df output:
${df_line}

LARGEST RELATIONS RIGHT NOW (read at alert time, not written down — see below):
${consumers}

A relation flagged LIKELY TOAST BLOAT is the cheapest win available and needs no owner
decision: its bytes are almost entirely dead TOAST pages that plain VACUUM can never
return to the OS. Confirm by comparing pg_total_relation_size(reltoastrelid) against the
live payload (sum a denormalized length column, or sample pg_column_size), then reclaim
with a rewrite. ALWAYS bound the lock, because a rewrite takes ACCESS EXCLUSIVE and a
blocked one queues AHEAD of every later lock request on that table:
  sudo -n -u postgres env PGOPTIONS='-c lock_timeout=10000' psql -p $BACKUP_DB_PORT -d $BACKUP_DB_NAME \\
    -c 'VACUUM (FULL, VERBOSE, ANALYZE) <schema>.<relation>'
Measured 2026-09-02 (WI-2140986): that reclaimed 60.89 GiB from gateway_payload_blobs in
55s with no contention and no data loss.

INVESTIGATION RECIPE (traps verified while working WI-38595, 2026-08-14, and WI-2141004, 2026-09-02):
1. PostgreSQL is usually NOT the consumer, despite this alarm's title — but \"not PostgreSQL\" is a HYPOTHESIS TO TEST, never a conclusion to inherit. The probe watches the VOLUME holding PGDATA, and that volume is shared with \$HOME. Size PGDATA with 'sudo -n du -xsh $BACKUP_DB_DATA_DIR' — an unprivileged du prints a SILENT '4.0K' (permission denied) rather than an error, which reads as 'Postgres is tiny' for the wrong reason. Start from the LARGEST RELATIONS block above and from a fresh directory scan; do not start from any remembered figure, including one quoted in an older issue. This step used to carry a measured example here, and it went stale and misdirected three work-items for three weeks.
2. CONFIRM WHICH VOLUME a directory is on before reclaiming anything: 'findmnt -T <path>' or 'stat -c %d <path>'. On this box /tmp is a BIND MOUNT from a second physical disk, so deleting 136 GiB of stale /tmp scratch frees exactly nothing on the volume this alarm is about.
3. Enumerate consumers in ONE bounded backgrounded pass: 'nice -n 19 ionice -c3 du -x -d3 / | sort -hr > /tmp/scan-1.txt' (~7 min here). Re-run it later into scan-2.txt and DIFF the two — a diff of two snapshots is the only reliable attribution of NET growth per directory.
4. Do NOT attribute growth by mtime ('find -newermt'). It counts a file's WHOLE size when the file is merely touched, so a single live VM image reads as hundreds of GiB 'written' in 26h. Note also that qcow2 images grow monotonically and never return space the guest frees — and the .img suffix lies, so check the magic ('QFI\\373' = qcow2)."
    if red_gate "$red_marker" "Postgres data volume"; then
      file_ei "$title" "$body"
      mark_red "$red_marker"
    fi
  else
    rm -f "$red_marker"
  fi
}

# ── (e) BACKUP-REPOSITORY VOLUME HEADROOM ────────────────────────────────
# PGDATA and the backup repository are different filesystems on this host.
# Watching only PGDATA leaves the repository able to consume /mnt/data until
# Kopia and the logical dumps both fail. Keep this probe O(1): one df sample per
# health tick, retained as a bounded history. The derivative counts down to the
# admission floor rather than ENOSPC, so the alarm names the last safe action
# boundary instead of the later catastrophe.
check_db_relation_bloat() {
  # Fires on the SIGNATURE, not on the disk level (WI-2141004 / P-004).
  #
  # check_db_disk_headroom() only speaks once the volume is already >= its warn
  # threshold, which is far too late for this failure: a bloated TOAST relation grows
  # quietly for weeks and is only noticed as a full disk. Measured 2026-09-02,
  # gateway_payload_blobs reached 60.59 GiB of TOAST holding 0.78 GiB of live payload
  # before anything said a word, and the volume it sat on came within ~20 minutes of
  # tripping the green-checkpoint disk floor and freezing every agent's deploys.
  #
  # The reason autovacuum cannot save you here, and why this needs its own detector:
  # plain VACUUM marks TOAST pages reusable but never returns them to the OS. A table
  # that continuously writes and deletes large bytea rows therefore ratchets its TOAST
  # relation upward permanently, and a HIGH autovacuum_count is evidence of that
  # treadmill rather than of health. Only a rewrite reclaims the space.
  #
  # Use pg_class.reltuples as the denominator. It is persisted relation metadata
  # refreshed by VACUUM/ANALYZE and survives a stats-collector reset; the volatile
  # pg_stat_user_tables.n_live_tup estimate can temporarily collapse to a tiny
  # number, turning a healthy large archive into a false bloat alarm. A non-positive
  # reltuples value means the catalog has no usable estimate, so this heuristic
  # deliberately emits no verdict instead of dividing by a made-up row count.
  local bloated red_marker sql host title body
  sql="WITH relation_sizes AS (
           SELECT n.nspname,
                  c.relname,
                  COALESCE(pg_total_relation_size(c.reltoastrelid),0)::numeric AS toast_bytes,
                  GREATEST(c.reltuples,0)::numeric AS estimated_rows
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r','p')
              AND n.nspname NOT IN ('pg_catalog','information_schema')
         )
         SELECT nspname||'.'||relname||'  '
                ||round(toast_bytes/1073741824.0,2)||' GiB of TOAST over '
                ||round(estimated_rows,0)||' catalog-estimated live rows ('
                ||round((toast_bytes/1048576.0)/estimated_rows,1)||' MiB/estimated row)'
           FROM relation_sizes
          WHERE toast_bytes > ${BACKUP_BLOAT_MIN_TOAST_GIB}*1073741824::numeric
            AND estimated_rows > 0
            AND (toast_bytes/1048576.0)/estimated_rows > ${BACKUP_BLOAT_MIB_PER_ROW}
          ORDER BY toast_bytes DESC
          LIMIT 5"
  # 2>&1 for the same reason as top_db_consumers: a detector whose query errors must say
  # so, not fall silent. A silent detector is indistinguishable from a healthy database.
  bloated="$(timeout "${BACKUP_CONSUMERS_TIMEOUT_S}s" sudo -n -u postgres psql \
               -p "$BACKUP_DB_PORT" -d "$BACKUP_DB_NAME" -tA -c "$sql" 2>&1)" || true
  if grep -qE '^(ERROR|FATAL|psql):' <<<"$bloated"; then
    log "WARN TOAST-bloat query FAILED (this detector is BLIND until fixed): $(printf '%s' "$bloated" | head -1)"
    bloated=""
  fi
  red_marker="$STATE_DIR/db-relation-bloat-ei-filed"
  if [ -z "$bloated" ]; then
    # Unreachable and clean are deliberately treated alike: this probe must never
    # invent a red, and check_db_disk_headroom remains the backstop for a full volume.
    rm -f "$red_marker"
    return 0
  fi
  log "TOAST-bloat signature detected on $(printf '%s\n' "$bloated" | grep -c .) relation(s) (threshold: >${BACKUP_BLOAT_MIN_TOAST_GIB} GiB TOAST and >${BACKUP_BLOAT_MIB_PER_ROW} MiB/estimated row)."
  host="$(hostname 2>/dev/null || echo unknown-host)"
  title="Postgres TOAST bloat: $(printf '%s\n' "$bloated" | head -1 | awk '{print $1}') is mostly dead TOAST pages on ${host}"
  body="Relations carrying the TOAST-bloat signature (>${BACKUP_BLOAT_MIN_TOAST_GIB} GiB of TOAST AND >${BACKUP_BLOAT_MIB_PER_ROW} MiB of TOAST per catalog-estimated row):

${bloated}

WHY THIS IS ALMOST CERTAINLY RECLAIMABLE, NOT DATA: TOAST bytes per catalog-estimated row is the
discriminator. A legitimately large table holds a plausible amount per row; a bloated
one holds an absurd amount, because the rows it is charged for are long deleted. Plain
VACUUM marks TOAST pages reusable but never hands them back to the OS, so a high-churn
large-bytea table ratchets upward forever and a high autovacuum_count means the
treadmill is running, not that the table is healthy.

The row denominator is pg_class.reltuples, a persisted catalog estimate. The volatile
pg_stat_user_tables.n_live_tup estimate is intentionally not used: after a stats reset it
can briefly report a tiny count for a healthy large table and create a false bloat alarm.

CONFIRM before reclaiming — compare the TOAST size against the live payload:
  SELECT pg_size_pretty(pg_total_relation_size(reltoastrelid)) FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='<schema>' AND c.relname='<relation>';
  -- then sum a denormalized length column if the table has one, else sample:
  SELECT round(avg(pg_column_size(t.*))/1024.0,1) AS avg_kib
    FROM (SELECT * FROM <schema>.<relation> LIMIT 400) t;

RECLAIM with a rewrite, and ALWAYS bound the lock. A rewrite takes ACCESS EXCLUSIVE, and
a blocked ACCESS EXCLUSIVE request queues AHEAD of every later lock request on that
relation — so an unbounded rewrite of a table on a hot path can stall every caller of it.
With lock_timeout the failure mode is a clean abort instead:
  sudo -n -u postgres env PGOPTIONS='-c lock_timeout=10000' psql -p $BACKUP_DB_PORT -d $BACKUP_DB_NAME \\
    -c 'VACUUM (FULL, VERBOSE, ANALYZE) <schema>.<relation>'

This probe is detection-only; it never rewrites, deletes, or restarts anything."
  if red_gate "$red_marker" "TOAST bloat"; then
    file_ei "$title" "$body"
    mark_red "$red_marker"
  fi
}

largest_recent_dump_gb() {
  local artifact path size_kb size_gb largest=0
  for artifact in $BACKUP_ARTIFACTS; do
    path="$BACKUP_DUMP_DIR/$artifact"
    [ -e "$path" ] || continue
    size_kb="$(du -sk "$path" 2>/dev/null | awk 'NR == 1 { print $1; exit }')"
    [[ "$size_kb" =~ ^[0-9]+$ ]] || continue
    size_gb=$(( size_kb / 1048576 ))
    [ "$size_gb" -gt "$largest" ] && largest="$size_gb"
  done
  printf '%s\n' "$largest"
}

backup_required_free_gb() {
  local largest_dump_gb="${1:-}" required_dump_gb
  [[ "$largest_dump_gb" =~ ^[0-9]+$ ]] || return 1
  [[ "$PC_BACKUP_MIN_FREE_GB" =~ ^[0-9]+$ ]] || return 1
  [[ "$PC_BACKUP_SPACE_SAFETY" =~ ^[0-9]+$ ]] || return 1
  required_dump_gb=$(( largest_dump_gb * PC_BACKUP_SPACE_SAFETY / 100 ))
  printf '%s\n' "$(( PC_BACKUP_MIN_FREE_GB + required_dump_gb ))"
}

check_backup_volume_headroom() {
  local df_line="" disk_pct="" total_kb="" avail_kb="" floor_kb="" trend="" red_marker=""
  local largest_dump_gb="" required_free_gb="" required_free_kb=""
  if [ -e "$BACKUP_VOLUME_PATH" ]; then
    df_line="$(df -Pk "$BACKUP_VOLUME_PATH" 2>/dev/null | tail -n1)"
    disk_pct="$(printf '%s' "$df_line" | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+%$/) print $i}' | tr -d '%' | tail -n1)"
    avail_kb="$(printf '%s' "$df_line" | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+%$/) { print $(i - 1); exit }}')"
    total_kb="$(printf '%s' "$df_line" | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+%$/) { print $(i - 3); exit }}')"
  fi

  if [ -z "$disk_pct" ]; then
    log "SKIP backup-volume probe: could not resolve usage% for '$BACKUP_VOLUME_PATH' (path missing or df output unparseable)."
    return 0
  fi
  if ! [[ "$disk_pct" =~ ^[0-9]+$ ]] \
     || ! [[ "$total_kb" =~ ^[0-9]+$ ]] \
     || ! [[ "$avail_kb" =~ ^[0-9]+$ ]] \
     || ! [[ "$BACKUP_VOLUME_WARN_PCT" =~ ^[0-9]+$ ]] \
     || ! [[ "$BACKUP_VOLUME_FLOOR_PCT" =~ ^[0-9]+$ ]] \
     || ! [[ "$PC_BACKUP_MIN_FREE_GB" =~ ^[0-9]+$ ]] \
     || ! [[ "$PC_BACKUP_SPACE_SAFETY" =~ ^[0-9]+$ ]] \
     || [ "$BACKUP_VOLUME_WARN_PCT" -gt 100 ] 2>/dev/null \
     || [ "$BACKUP_VOLUME_FLOOR_PCT" -ge 100 ] 2>/dev/null; then
    log "SKIP backup-volume probe: invalid usage/size/threshold (usage='$disk_pct', total_kb='$total_kb', avail_kb='$avail_kb', warn='$BACKUP_VOLUME_WARN_PCT', floor='$BACKUP_VOLUME_FLOOR_PCT', min_free_gb='$PC_BACKUP_MIN_FREE_GB', safety_pct='$PC_BACKUP_SPACE_SAFETY')."
    return 0
  fi

  largest_dump_gb="$(largest_recent_dump_gb)"
  required_free_gb="$(backup_required_free_gb "$largest_dump_gb")" || {
    log "SKIP backup-volume probe: could not derive the producer's required free-space threshold (largest_dump_gb='$largest_dump_gb', min_free_gb='$PC_BACKUP_MIN_FREE_GB', safety_pct='$PC_BACKUP_SPACE_SAFETY')."
    return 0
  }
  required_free_kb=$(( required_free_gb * 1048576 ))
  floor_kb=$(( total_kb * BACKUP_VOLUME_FLOOR_PCT / 100 ))
  trend="$(disk_trend_line "$avail_kb" backup-volume-history "$floor_kb" "${BACKUP_VOLUME_FLOOR_PCT}% FLOOR")"
  log "Backup-volume usage at $BACKUP_VOLUME_PATH: ${disk_pct}% (warn ${BACKUP_VOLUME_WARN_PCT}%, producer-fit threshold ${required_free_gb} GiB = ${largest_dump_gb} GiB x ${PC_BACKUP_SPACE_SAFETY}% + ${PC_BACKUP_MIN_FREE_GB} GiB floor, admission floor ${BACKUP_VOLUME_FLOOR_PCT}% free) | ${trend}"

  red_marker="$STATE_DIR/backup-volume-red-ei-filed"
  if [ "$disk_pct" -ge "$BACKUP_VOLUME_WARN_PCT" ] || [ "$avail_kb" -lt "$required_free_kb" ]; then
    local host title body
    host="$(hostname 2>/dev/null || echo unknown-host)"
    # Keep changing measurements out of the title so repeated samples dedupe.
    title="Backup repository volume above capacity warning threshold on ${host}"
    body="WI-39596 durable backup-volume detector: the filesystem containing '$BACKUP_VOLUME_PATH' is ${disk_pct}% used with ${avail_kb} KiB free. The producer-fit threshold is ${required_free_gb} GiB (${largest_dump_gb} GiB largest recent dump x ${PC_BACKUP_SPACE_SAFETY}% + ${PC_BACKUP_MIN_FREE_GB} GiB floor); the coarse percentage backstop is ${BACKUP_VOLUME_WARN_PCT}% used and the admission floor is ${BACKUP_VOLUME_FLOOR_PCT}% free.

${trend}

This volume holds the database dump artifacts under '$BACKUP_DUMP_DIR'. The Kopia repository may be on a separate volume and is a separate capacity domain; this alarm follows the volume the producer actually writes.

ACTION: read the measured trend first. If it is still shrinking, compare consecutive Kopia upload bytes and full-maintenance receipts; do not attribute growth from mtime or a single du snapshot. A mitigation/reclamation does not close WI-39596 until consecutive post-change dump/snapshot cycles show bounded growth.

df output:
${df_line}"
    if red_gate "$red_marker" "backup volume"; then
      file_ei "$title" "$body"
      mark_red "$red_marker"
    fi
  else
    rm -f "$red_marker"
  fi
}

# ── (f) TMPDIR ENTRY-COUNT ────────────────────────────────────────────────
# ── WHY A COUNT, WHEN (d) ALREADY WATCHES THE SAME DISK (WI-38830, 2026-08-14) ──
# Because the two measure different things, and this failure is INVISIBLE to bytes.
# A leaked per-test-process scratch dir costs ~6 KiB, so 449,259 of them — the state
# this check was written after — were 2.6 GiB total. Every space-based probe on this
# box read that as noise. The damage is not the space: it is that ~500k dirents in one
# directory degrade every mkdir/readdir/stat the whole fleet does under the shared
# TMPDIR, which the 2026-07-09 incident tied to spurious integration-test timeouts and
# elevated host load. A volume can be perfectly healthy on df while a directory in it
# is pathological, so a byte threshold cannot be made sensitive enough to see this —
# it is the wrong instrument, not a badly-tuned one.
#
# The same leak has now shipped TWICE (2026-07-09 ~700k dirs, 2026-08-14 ~500k) and was
# found BY ACCIDENT both times, while chasing an unrelated disk alarm. That is the gap
# this closes: not the bug, which is fixed in libs/test-config/src/hermetic-tmpdir.ts,
# but the fact that nothing was watching the axis it grows along.
#
# NAMING THE CULPRIT IS THE POINT. "62,000 entries in /tmp" is a fact; "62,000 entries,
# 71,529 of them matching voice-ipc-hermetic-*" is a diagnosis. Same lesson as the trend
# line in (d): a level with no attribution reads as chronic weather and gets ignored.
# So the body carries the dominant name-shape histogram, computed from the SAME listing
# that produced the count — no second scan.
tmpdir_top_shapes() { # <dir> — echoes up to 5 "<count> <shape>" lines; never fails.
  # Collapse the random suffix mktemp/mkdtemp appends so N unique names become ONE shape.
  # This is what turns an unreadable wall of names into a single actionable line.
  #
  # WI-519487: this pass used to be `s/[A-Za-z0-9]{6,}$/<rand>/` — anchored to the END
  # of the name, so it only ever caught a random run that WAS the final path component.
  # A random run followed by a literal extension — e.g. mktemp's own
  # "pc-heavy-self.XXXXXX.sh" template (_pc_heavy_scratch_mktemp in pc-heavy.sh) — sits
  # in the MIDDLE of the name and never matched, so 21,504 distinct pc-heavy-self.<rand>.sh
  # entries (the #1 leaker at the time) never collapsed into one line and the histogram's
  # top line under-reported the true leader 5x, steering every responder at the wrong shape.
  #
  # Fixed by scanning every '-'/'.'-delimited alnum run in the name (not just the last
  # one) and collapsing the runs that LOOK random: >=6 chars AND (contains a digit OR
  # mixes upper+lower case). Real path components in this codebase (self, start, sidecar,
  # snapshot, affected, tests, papercusp, hermetic, ...) are plain lowercase words with no
  # digits, so they are never mistaken for the random part — only mktemp's actual
  # [A-Za-z0-9] output (which draws from both cases and digits, so a run matching neither
  # condition is a ~1-in-90 fluke) gets folded away. A run this pass leaves alone (pure
  # digits, or pure lowercase a-f with no digit) still reaches the <hex>/<n> rules below
  # exactly as before — this only WIDENS where a random-looking run is looked for; it does
  # not touch the existing hex/numeric handling.
  ls -U "$1" 2>/dev/null \
    | awk '
        function looks_random(tok,    i, c, hasDigit, hasUpper, hasLower, hasLetter, allHexChars) {
          if (length(tok) < 6) return 0
          hasDigit = 0; hasUpper = 0; hasLower = 0; hasLetter = 0; allHexChars = 1
          for (i = 1; i <= length(tok); i++) {
            c = substr(tok, i, 1)
            if (c ~ /[0-9]/) hasDigit = 1
            else if (c ~ /[A-Z]/) { hasUpper = 1; hasLetter = 1; allHexChars = 0 }
            else { hasLower = 1; hasLetter = 1; if (c !~ /[a-f]/) allHexChars = 0 }
          }
          # A pure lowercase-hex-alphabet run of >=8 chars is exactly what the <hex>
          # rule below already exists to label consistently — defer to it instead of
          # splitting one shape into <rand>/<hex> depending on incidental digit
          # presence within the hex run (e.g. "abcdef12" vs "deadbeef" are the SAME
          # shape either way; only this pass can tell they came from the same field).
          if (allHexChars && length(tok) >= 8) return 0
          return hasLetter && (hasDigit || (hasUpper && hasLower))
        }
        {
          out = ""; rest = $0
          while (match(rest, /[A-Za-z0-9]+/)) {
            out = out substr(rest, 1, RSTART - 1)
            tok = substr(rest, RSTART, RLENGTH)
            out = out (looks_random(tok) ? "<rand>" : tok)
            rest = substr(rest, RSTART + RLENGTH)
          }
          print out rest
        }
      ' \
    | sed -E 's/[0-9a-f]{8,}/<hex>/g; s/[0-9]{3,}/<n>/g' \
    | sort | uniq -c | sort -rn | head -n 5 || true
}

check_tmpdir_entry_count() {
  local dir="" count="" red_marker="" shapes="" host=""
  local old_ifs="$IFS"; IFS=':'; local watch_list=($BACKUP_TMPDIR_WATCH); IFS="$old_ifs"
  if ! [[ "$BACKUP_TMPDIR_MAX_ENTRIES" =~ ^[0-9]+$ ]]; then
    log "SKIP tmpdir entry-count probe: invalid threshold (BACKUP_TMPDIR_MAX_ENTRIES='$BACKUP_TMPDIR_MAX_ENTRIES')."
    return 0
  fi
  for dir in "${watch_list[@]}"; do
    [ -n "$dir" ] || continue
    [ -d "$dir" ] || continue
    # `ls -U` is unsorted, so this is one readdir pass with no sort buffer. Measured
    # ~0.6s on a 486k-entry directory; the probe runs hourly, so pay it and get a real
    # number rather than a sampled guess that cannot be quoted in the alarm body.
    count="$(ls -U "$dir" 2>/dev/null | wc -l | tr -d ' ')"
    [[ "$count" =~ ^[0-9]+$ ]] || continue
    # Marker path must be unique per watched dir AND filesystem-safe: '/tmp/pcv' would
    # otherwise write into a nonexistent nested path. Same reason the title below names
    # the dir — two watched dirs must not dedupe onto each other's work-item.
    red_marker="$STATE_DIR/tmpdir-entries-red$(printf '%s' "$dir" | tr -c 'A-Za-z0-9' '-')"
    if [ "$count" -lt "$BACKUP_TMPDIR_MAX_ENTRIES" ]; then
      log "TMPDIR entry count $dir: ${count} (warn threshold ${BACKUP_TMPDIR_MAX_ENTRIES})"
      rm -f "$red_marker"
      continue
    fi
    shapes="$(tmpdir_top_shapes "$dir")"
    log "TMPDIR entry count $dir: ${count} — OVER threshold ${BACKUP_TMPDIR_MAX_ENTRIES}"
    host="$(hostname 2>/dev/null || echo unknown-host)"
    # Stable title (no count) for the same dedupe reason as (d): admissionIdentity is
    # derived from the title, so a changing number would mint a new item every refile.
    local title="Shared TMPDIR '$dir' has too many entries on ${host} — something is leaking scratch"
    local body="WI-38830 recurrence-guard probe: '$dir' currently holds ${count} entries (warn threshold ${BACKUP_TMPDIR_MAX_ENTRIES}).

THIS IS NOT A DISK-SPACE ALARM. Leaked scratch dirs are individually tiny — 449,259 of them measured 2.6 GiB total — so every byte-based probe reads this as noise. The cost is that a directory with hundreds of thousands of dirents degrades every mkdir/readdir/stat the fleet performs under the shared TMPDIR, including the testcontainer start-lock. That was tied to spurious integration-test timeouts and elevated host load fleet-wide (2026-07-09).

DOMINANT NAME SHAPES (random suffixes collapsed — the top line is almost always the culprit):
${shapes}

HOW TO ACT ON THIS:
1. Take the top shape above and find who creates it: grep -rn '<the literal prefix>' --include=*.ts --include=*.mjs --include=*.sh . | grep -v node_modules
2. Read that creation site's cleanup. If the cleanup is a 'process.on(\"exit\")' handler, IT IS DEAD CODE under vitest: vitest-config.ts pins pool:'forks' and tinypool SIGNAL-KILLS each per-file worker, so Node never runs exit handlers there. Falsify it in both directions before believing either result — run the module under 'tsx -e' (a normal exit, cleanup runs) and under 'npm run test:file' with an isolated TMPDIR (a signal kill, cleanup does not).
3. The durable fix shape is in libs/test-config/src/hermetic-tmpdir.ts: NEST per-process scratch under one parent so a leak costs the shared TMPDIR one top-level entry, and SWEEP siblings whose creating pid is dead on create. Cleanup that requires the dying process to cooperate is not cleanup — a SIGKILLed process runs nothing.
4. Reclaiming is safe only with an age floor, so a live run's scratch is never deleted under it: find '$dir' -maxdepth 1 -mindepth 1 -type d -name '<shape>*' -mmin +240 -exec rm -rf {} +

WHY BOTH /tmp AND /tmp/pcv ARE WATCHED: vitest-config.ts FORCES TMPDIR=/tmp/pcv for every test process, so a count of /tmp's top level cannot see the directory where test scratch actually lands. Measuring only /tmp under-reported this exact leak by 6x (74,385 seen vs 523,644 real). If a new tool forces its own TMPDIR, add it to BACKUP_TMPDIR_WATCH.

This probe is detection-only; it never deletes anything."
    if red_gate "$red_marker" "tmpdir entries $dir"; then
      file_ei "$title" "$body"
      mark_red "$red_marker"
    fi
  done
}

# ── (e) WORKSPACE DUMP TRANSACTION OWNERSHIP ───────────────────────────────
# packages/backup writes PID/sequence-scoped transaction files so concurrent
# processes never share an inode. A killed writer cannot run its finally-path,
# and the old preflight cleanup only knew the retired single `.tmp` name. Judge
# ownership, not age: `kill -0` sends no signal, and only a dead encoded PID is
# a stranded transaction. Live concurrent writers are never touched or alarmed.
check_workspace_dump_transactions() {
  local pattern="" tmp="" base="" owner="" pid="" size="" mtime="" age=""
  local count=0 bytes=0 oldest_h=0 sample="" red_marker="$STATE_DIR/workspace-dead-dump-tmp"
  declare -A seen=()

  for pattern in $BACKUP_OPTIONAL_ARTIFACTS; do
    while IFS= read -r tmp; do
      [ -f "$tmp" ] || continue
      [ -n "${seen[$tmp]+x}" ] && continue
      seen[$tmp]=1
      base="${tmp##*/}"
      owner="${base#pg-embedded.sql.gz.}"
      [[ "$base" == pg-embedded.sql.gz.*.tmp && "$owner" =~ ^([1-9][0-9]*)-([0-9]+)\.tmp$ ]] || continue
      pid="${BASH_REMATCH[1]}"
      kill -0 "$pid" 2>/dev/null && continue
      size="$(stat -c %s "$tmp" 2>/dev/null || stat -f %z "$tmp" 2>/dev/null || echo 0)"
      mtime="$(mtime_s "$tmp")"
      age=$(( ( $(now_s) - mtime ) / 3600 ))
      count=$((count + 1)); bytes=$((bytes + size))
      [ "$age" -gt "$oldest_h" ] 2>/dev/null && oldest_h="$age"
      [ "$count" -le 3 ] && sample="${sample}${sample:+, }$base"
    done < <(compgen -G "${pattern}.*.tmp" 2>/dev/null || true)
  done

  if [ "$count" -eq 0 ]; then
    rm -f "$red_marker"
    return 0
  fi

  local title="Workspace backup has dead-writer pg_dump transaction files"
  local body="The per-workspace backup hook found $count attempt-scoped pg-embedded transaction file(s) whose filename-encoded writer PID is no longer alive (${bytes} bytes total; oldest ${oldest_h}h; sample: $sample).

These are partial, non-restorable transactions, not backup artifacts. They consume the same filesystem headroom the next transactional dump needs. packages/backup must reap dead-writer PID/sequence files before its free-space admission check while preserving files owned by live concurrent writers. This probe is detection-only and deleted nothing."
  if red_gate "$red_marker" "dead workspace dump transaction"; then
    file_ei "$title" "$body"; mark_red "$red_marker"
  fi
}

# A workspace dump can legitimately be old when its backup policy is event-only.
# Alarm only when the writer's own companion log proves a NEWER attempt degraded.
# This preserves the EI-20109034777197353 detector without imposing the host's
# hourly RPO on every optional workspace policy.
#
# The outcome match is PREFIX-shaped ('hook done (') on purpose: it must select the
# genuinely LATEST outcome, not the latest member of a hand-typed subset. It used to
# enumerate `(ok|degraded)`, which could not see the hook's third terminal outcome,
# `hook done (skipped: host-covered)` — emitted since the host-coverage stand-down
# (EI-21874492117996483). Under that policy the workspace dump is deliberately frozen
# forever, so `tail -1` of the enumerated set kept returning a `degraded` line from
# BEFORE the stand-down while the mtime gate below was satisfied by the very skip
# lines the enumeration was blind to. The two halves conspired into a permanent
# critical false alarm: WI-1547678 re-filed the byte-identical 2580223915B artifact
# that WI-1288840 had already closed 13h earlier, and seven agents each burned a
# claim on it. Match the outcome SHAPE the emitter guarantees; classify on the
# result. New outcome tokens are pinned by the vocabulary test in
# apps/operator/scripts/__tests__/papercup-backup-health-check.test.ts.
optional_artifact_latest_hook_degraded() { # <artifact>
  local art="$1" hook="${1%/*}/hook.log" latest=""
  [ -f "$hook" ] || return 1
  latest="$(grep -aE 'hook done \(' "$hook" 2>/dev/null | tail -n 1)"
  [[ "$latest" == *'hook done (degraded)'* ]] || return 1
  [ "$(mtime_s "$hook")" -gt "$(mtime_s "$art")" ] 2>/dev/null
}

# ── SELF-TEST: prove the alarm DISCRIMINATES (EI-10746) ────────────────────
# The comment on mark_red() used to cite "the discrimination test below". There was no
# test. Both bugs it would have caught were live. So: this is that test, and it asserts
# the two independent failure modes plus the two ways the fix could over-correct.
#
# The observable is the RED MARKER, because the marker IS the alarm's memory: writing it
# on a run that filed nothing is what silently disarms the next real red for 12h.
# No real EI is ever filed here — the force case points OPERATOR_MCP_URL at a dead port,
# so the filing PATH runs (and marks) while the filing itself harmlessly fails.
#
# Run:  apps/operator/scripts/papercup-backup-health-check.sh --self-test
if [ "${1:-}" = "--self-test" ]; then
  t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
  mkdir -p "$t/dump" "$t/state"
  self="${BASH_SOURCE[0]}"
  p=0; f=0
  # PIN THE ARTIFACT LIST TO THIS FIXTURE, do not inherit the production default.
  # Every case below builds pg/papercusp + pg/restart in a temp tree and asserts on
  # the marker; inheriting BACKUP_ARTIFACTS meant a change to the PRODUCTION default
  # (WI-2146225 retired pg/papercusp for the tier pair) silently turned every case
  # into "artifact absent" — the cases still run, still write markers, and still look
  # like they are testing staleness while actually testing nothing of the kind.
  # Exported once here rather than added to each of the eight nested invocations, so
  # a ninth case cannot be added without it. The production default gets its own
  # guard in apps/operator/scripts/__tests__/backup-tier-split.test.ts.
  export BACKUP_ARTIFACTS="pg/papercusp pg/restart"
  # ── WI-2145430 recurrence guard: the shell's OWN runtime errors ──────────
  # `bash -n` is STRUCTURALLY BLIND to this class, so the syntax check that
  # guards this script cannot see it. An unescaped double quote inside a
  # multi-line double-quoted alarm body is VALID SYNTAX: it closes the string
  # early, so the body is silently TRUNCATED and the remainder is re-parsed as
  # stray words. The only channel that reports it is stderr — and every nested
  # probe run below used to send stderr to /dev/null, so a filed alarm could
  # lose its entire investigation recipe with all cases green. That is exactly
  # what the disk-headroom body did: it closed at `but "not PostgreSQL"` and
  # dropped the whole 4-step INVESTIGATION RECIPE from every EI it ever filed.
  # Bash prefixes its own diagnostics with "<script>: line N:", which is never
  # legitimate probe output, so that signature — not "stderr is non-empty" — is
  # the tripwire: several probes below use stderr as their reporting channel.
  selftest_stderr="$t/selftest-stderr.log"; : > "$selftest_stderr"
  # For probes that capture stderr into a variable to assert on its CONTENT:
  # feed that text through here so it reaches the same tripwire.
  note_shell_errors() { printf '%s\n' "$1" | grep -aE ': line [0-9]+:' >> "$selftest_stderr" || true; }
  # <name> <stale:yes|no> <want-marker:yes|no> [ENV=VAL ...]
  check() {
    local name="$1" stale="$2" want_marker="$3"; shift 3
    rm -rf "${t:?}/state" "$t/dump/pg"; mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart"
    # A directory artifact, matching db-backup.sh's pg_dump -Fd output shape.
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    if [ "$stale" = yes ]; then touch -d '10 hours ago' "$t/dump/pg/papercusp" "$t/dump/pg/restart"; fi
    env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/no-db-data" \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="" \
        "$@" bash "$self" >/dev/null 2>>"$selftest_stderr"
    # BACKUP_ARTIFACTS can name several dumps, so a red writes one stale-* marker PER
    # artifact — glob-match ANY of them (a bare `[ -f state/stale-* ]` errors with
    # "binary operator expected" the moment the glob expands to >1 file).
    local got_marker=no
    compgen -G "$t/state/stale-*" >/dev/null 2>&1 && got_marker=yes
    if [ "$got_marker" = "$want_marker" ]; then
      printf '  ok    %s (marker=%s)\n' "$name" "$got_marker"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted marker=%s, got marker=%s\n' "$name" "$want_marker" "$got_marker"; f=$((f+1))
    fi
  }
  echo "papercup-backup-health-check.sh --self-test — EI-10746 alarm discrimination"
  # 1. THE DEAD-GUARD BUG: a dry-run files no EI, so it must not write the marker either.
  #    Before the fix it DID — silently disarming the next real red for BACKUP_RED_REFILE_H.
  check "dry-run on a RED does NOT write the marker (cannot disarm the real alarm)" \
        yes no  BACKUP_NO_FILE=1
  # 2. THE FALSE-ALARM BUG: overriding a threshold is a TEST — it must not file or mark.
  check "threshold override on a RED auto-suppresses (no file, no marker)" \
        yes no  BACKUP_MAX_AGE_H=1
  # 3. NOT A MUTE BUTTON: the alarm must still be able to fire when forced.
  check "threshold override + BACKUP_ALERT_FORCE=1 DOES take the filing path" \
        yes yes BACKUP_MAX_AGE_H=1 BACKUP_ALERT_FORCE=1
  # 4. NOT A HAIR-TRIGGER: a fresh artifact on production defaults is green and silent.
  check "fresh artifact, production defaults: green, no marker" \
        no  no
  printf '  ---- %d passed, %d failed\n' "$p" "$f"

  # ── EI-18678678853631218 recurrence guard: signal (c), stranded .tmp ──────
  # A separate helper (not `check`, which fixes the pg/<db> shape) so a stranded .tmp is
  # exercised independently of the freshness artifacts above.
  check_tmp() {
    local name="$1" stale="$2" want_marker="$3"; shift 3
    rm -rf "${t:?}/state" "$t/dump/pg"; mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart" "$t/dump/pg/papercusp.tmp"
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    if [ "$stale" = yes ]; then touch -d '3 hours ago' "$t/dump/pg/papercusp.tmp"; fi
    env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/no-db-data" \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="" \
        "$@" bash "$self" >/dev/null 2>>"$selftest_stderr"
    local got_marker=no
    [ -f "$t/state/stale-tmp" ] && got_marker=yes
    if [ "$got_marker" = "$want_marker" ]; then
      printf '  ok    %s (marker=%s)\n' "$name" "$got_marker"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted marker=%s, got marker=%s\n' "$name" "$want_marker" "$got_marker"; f=$((f+1))
    fi
  }
  # 5. A .tmp older than the threshold fires (dry-run: marker still withheld, per bug #1's rule).
  check_tmp "stranded .tmp older than threshold on a REAL run: marker set" \
        yes yes BACKUP_ALERT_FORCE=1
  check_tmp "stranded .tmp older than threshold, dry-run: NO marker" \
        yes no  BACKUP_NO_FILE=1
  # 6. A fresh .tmp (still within one cycle — a dump legitimately in progress) is silent.
  check_tmp "fresh .tmp (in-progress dump), production defaults: green, no marker" \
        no  no
  printf '  ---- %d passed, %d failed (post stranded-tmp block)\n' "$p" "$f"

  # ── EI-20109034777197353 recurrence guard: the WORKSPACE dump artifact ────
  # The workspace pre-snapshot pg_dump died and nobody noticed for 26 HOURS,
  # because no probe watched its artifact — it lives outside BACKUP_DUMP_DIR,
  # and the only surface that mentioned it (backup_snapshots.status) said 'ok'
  # the entire time. It is gated on FRESHNESS but not EXISTENCE: a box with no
  # workspace backup is not broken. A stale artifact alarms only when the
  # latest, newer hook result is degraded; event-only idle time stays green.
  check_optional() {
    local name="$1" mode="$2" want_marker="$3"; shift 3
    rm -rf "${t:?}/state" "$t/dump/pg" "$t/ws"
    mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart" "$t/ws"
    # Required artifacts stay FRESH so any marker can only come from the optional one.
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    local opt="$t/ws/pg-embedded.sql.gz"
    case "$mode" in
      absent) rm -f "$opt" ;;
      fresh)  : > "$opt" ;;
      stale-degraded)
        : > "$opt"; touch -d '26 hours ago' "$opt"
        printf '[%s] hook done (degraded)\n' "$(date -Iseconds)" >"$t/ws/hook.log"
        ;;
      stale-ok)
        : > "$opt"; touch -d '26 hours ago' "$opt"
        printf '[%s] hook done (ok)\n' "$(date -Iseconds)" >"$t/ws/hook.log"
        ;;
      stale-no-attempt)
        : > "$opt"; touch -d '26 hours ago' "$opt"; rm -f "$t/ws/hook.log"
        ;;
      # WI-1547678: the host-coverage stand-down supersedes the older degraded run.
      # The artifact is then frozen BY DESIGN and can never advance again, so reading
      # the stale `degraded` as "the latest outcome" mints one critical false alarm
      # per re-file window, forever. The newest outcome is the only one that judges.
      stale-skipped-after-degraded)
        : > "$opt"; touch -d '26 hours ago' "$opt"
        { printf '[%s] hook done (degraded)\n' "$(date -Iseconds)"
          printf '[%s] hook done (skipped: host-covered)\n' "$(date -Iseconds)"
        } >"$t/ws/hook.log"
        ;;
      # The other direction, so the fix cannot over-correct into silence: a degraded
      # attempt AFTER a stand-down is a real, newer failure and must still alarm.
      stale-degraded-after-skipped)
        : > "$opt"; touch -d '26 hours ago' "$opt"
        { printf '[%s] hook done (skipped: host-covered)\n' "$(date -Iseconds)"
          printf '[%s] hook done (degraded)\n' "$(date -Iseconds)"
        } >"$t/ws/hook.log"
        ;;
    esac
    env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/no-db-data" \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="$opt" \
        "$@" bash "$self" >/dev/null 2>>"$selftest_stderr"
    local got_marker=no
    compgen -G "$t/state/stale-*" >/dev/null 2>&1 && got_marker=yes
    if [ "$got_marker" = "$want_marker" ]; then
      printf '  ok    %s (marker=%s)\n' "$name" "$got_marker"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted marker=%s, got marker=%s\n' "$name" "$want_marker" "$got_marker"; f=$((f+1))
    fi
  }
  # 7. THE INCIDENT ITSELF: a newer degraded attempt after the last good dump alarms.
  check_optional "optional artifact stale + latest hook DEGRADED: marker set" \
        stale-degraded yes
  # Event-only policies are allowed to sit idle indefinitely; age alone is not failure.
  check_optional "optional artifact stale + latest hook OK: event-only idle is silent" \
        stale-ok no
  check_optional "optional artifact stale + no newer attempt: event-only idle is silent" \
        stale-no-attempt no
  # 7b. WI-1547678: a NEWER stand-down supersedes an older degraded run. Judging on a
  # hand-typed (ok|degraded) subset made this the live permanent-false-alarm case.
  check_optional "optional artifact stale + latest hook SKIPPED after degraded: silent" \
        stale-skipped-after-degraded no
  # ...and the over-correction guard: a degraded run AFTER a stand-down still alarms.
  check_optional "optional artifact stale + latest hook DEGRADED after skip: marker set" \
        stale-degraded-after-skipped yes
  # 8. NOT gated on existence — a box that never ran a workspace backup is silent.
  check_optional "optional artifact ABSENT: silent (never-backed-up workspace is not a fault)" \
        absent no
  # 9. NOT a hair-trigger: a current workspace dump is green.
  check_optional "optional artifact FRESH: green, no marker" \
        fresh  no
  printf '  ---- %d passed, %d failed (post optional-artifact block)\n' "$p" "$f"

  check_workspace_tmp() {
    local name="$1" owner_mode="$2" want_marker="$3"
    rm -rf "${t:?}/state" "$t/dump/pg" "$t/ws"
    mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart" "$t/ws"
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    local opt="$t/ws/pg-embedded.sql.gz" pid="999999999"
    : > "$opt"
    [ "$owner_mode" = live ] && pid="$$"
    [ "$owner_mode" != none ] && : >"$opt.$pid-1.tmp"
    env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/no-db-data" \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="$opt" BACKUP_ALERT_FORCE=1 \
        bash "$self" >/dev/null 2>>"$selftest_stderr"
    local got_marker=no
    [ -f "$t/state/workspace-dead-dump-tmp" ] && got_marker=yes
    if [ "$got_marker" = "$want_marker" ]; then
      printf '  ok    %s (marker=%s)\n' "$name" "$got_marker"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted marker=%s, got marker=%s\n' "$name" "$want_marker" "$got_marker"; f=$((f+1))
    fi
  }
  check_workspace_tmp "dead PID workspace transaction: marker set" dead yes
  check_workspace_tmp "live PID workspace transaction: silent" live no
  check_workspace_tmp "no workspace transaction: silent" none no
  printf '  ---- %d passed, %d failed (post workspace-transaction block)\n' "$p" "$f"

  # ── EI-20115751074601731 recurrence guard: PostgreSQL data-volume headroom ──
  # Use a real temporary directory so the test exercises the portable `df -Pk`
  # parser without depending on the host's current root-volume usage. Threshold
  # overrides are explicitly forced for the RED leg; the alarm-safety guard above
  # must still suppress a dry-run and leave no dedupe marker behind.
  check_disk() {
    local name="$1" path_mode="$2" want_marker="$3"; shift 3
    rm -rf "${t:?}/state" "$t/dump/pg" "$t/db-data"
    mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart"
    [ "$path_mode" = present ] && mkdir -p "$t/db-data"
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/db-data" \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="" \
        "$@" bash "$self" >/dev/null 2>>"$selftest_stderr"
    local got_marker=no
    [ -f "$t/state/db-disk-red-ei-filed" ] && got_marker=yes
    if [ "$got_marker" = "$want_marker" ]; then
      printf '  ok    %s (marker=%s)\n' "$name" "$got_marker"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted marker=%s, got marker=%s\n' "$name" "$want_marker" "$got_marker"; f=$((f+1))
    fi
  }
  # 10. A threshold-forced red takes the filing path and writes its dedupe marker.
  check_disk "Postgres data volume over threshold: marker set" \
        present yes BACKUP_DISK_WARN_PCT=0 BACKUP_ALERT_FORCE=1
  # 11. A dry-run red must not disarm the next real alarm.
  check_disk "Postgres data volume red in dry-run: no marker" \
        present no BACKUP_DISK_WARN_PCT=0 BACKUP_NO_FILE=1
  # 12. A host without the native PostgreSQL path is skipped, not a false alarm.
  check_disk "Postgres data path absent: probe skipped" \
        missing no

  # ── WI-38595 recurrence guard: the disk TREND ────────────────────────────
  # The bug this alarm actually had was not a crash — it was reporting a LEVEL
  # with no derivative, so a volume falling ~5 GiB/h read the same as a stable
  # one and sat 19.4h. The trend fixes that, which means the trend itself now
  # gets read as a deadline. So the thing to guard is not "does it print" but
  # "can it print a number it has not earned": one sample, a too-recent
  # baseline, or a corrupt history must all degrade to an explicit no-baseline
  # message, NEVER to a fabricated rate or ETA.
  check_trend() {
    local name="$1" seed="$2" want_re="$3" out=""
    rm -rf "${t:?}/state" "$t/dump/pg" "$t/db-data"
    mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart" "$t/db-data"
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    [ -n "$seed" ] && printf '%s\n' "$seed" > "$t/state/db-disk-history"
    out="$(env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/db-data" \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="" BACKUP_NO_FILE=1 \
        PATH="$selftest_df_bin:$PATH" \
        bash "$self" 2>&1 >/dev/null)"
    note_shell_errors "$out"
    if grep -qE "$want_re" <<<"$out"; then
      printf '  ok    %s\n' "$name"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted /%s/ in probe output, got: %s\n' \
        "$name" "$want_re" "$(printf '%s' "$out" | grep -i 'data-volume usage' | head -1)"; f=$((f+1))
    fi
  }
  # Trend arithmetic must not depend on the host's live free-space changing while a
  # concurrent test is writing its own temporary files. The level/parser checks above
  # still use the real df; these arithmetic-only cases use a stable fixture instead.
  selftest_df_bin="$t/fake-bin"
  mkdir -p "$selftest_df_bin"
  cat >"$selftest_df_bin/df" <<'EOF'
#!/usr/bin/env bash
target="${2:-/self-test-fixture}"
total_kb="${SELFTEST_DF_TOTAL_KB:-1000000000}"
avail_kb="${SELFTEST_DF_AVAIL_KB:-500000000}"
used_kb=$((total_kb - avail_kb))
capacity="${SELFTEST_DF_CAPACITY:-50%}"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'self-test-fixture %s %s %s %s %s\n' "$total_kb" "$used_kb" "$avail_kb" "$capacity" "$target"
EOF
  chmod +x "$selftest_df_bin/df"
  selftest_du_bin="$t/du-bin"
  mkdir -p "$selftest_du_bin"
  cat >"$selftest_du_bin/du" <<'EOF'
#!/usr/bin/env bash
# The production helper asks only for the first size field. Returning a fixture
# size lets the regression test exercise the producer-fit predicate without
# allocating a multi-gigabyte directory in the shared checkout.
target="${@: -1}"
printf '%s %s\n' "${SELFTEST_DUMP_SIZE_KB:-0}" "$target"
EOF
  chmod +x "$selftest_du_bin/du"
  selftest_avail_kb=500000000
  # Compute each synthetic timestamp immediately before its case. A single timestamp
  # captured here made the expected 5 GiB/h rate drift below the assertion while a
  # concurrent test occupied the host long enough for the self-test itself to age.
  trend_seed() {
    local age_s="$1" delta_kb="$2" now_s
    now_s="$(date +%s)"
    printf '%s %s' "$((now_s - age_s))" "$((selftest_avail_kb + delta_kb))"
  }
  # 13. No history at all: seeds a baseline and says so — no rate from one sample.
  check_trend "trend with no prior sample: seeds baseline, invents no rate" \
        "" "no prior sample yet"
  # 14. A 2h-old baseline with 10 GiB more free space = losing exactly 5 GiB/h.
  check_trend "trend over a 2h baseline: reports the rate AND an ETA" \
        "$(trend_seed 7200 10485760)" \
        "losing 5\.0[0-9] GiB/h .* ETA TO FULL ~[0-9]+h"
  # 15. A stale recovery must not hide a current decline: the newest prior sample
  # is the actionable baseline, even when the oldest retained sample shows net gain.
  check_trend "trend uses the newest prior sample after an older recovery" \
        "$(trend_seed 14400 -10485760)
$(trend_seed 7200 10485760)" \
        "losing 5\.0[0-9] GiB/h .* ETA TO FULL ~[0-9]+h"
  # 16. Space FREED must never render as a countdown to full.
  check_trend "trend when the volume is recovering: NOT shrinking, no ETA" \
        "$(trend_seed 7200 -10485760)" \
        "NOT shrinking"
  # 17. A corrupt history degrades to no-baseline, not to a garbage rate.
  check_trend "trend with a corrupt history: degrades to no-baseline" \
        "not-a-timestamp garbage" "no prior sample yet"
  # 18. A baseline minutes old cannot support an hourly extrapolation.
  check_trend "trend with a 6-minute baseline: refuses to extrapolate" \
        "$(trend_seed 360 10485760)" \
        "baseline too recent"
  # ── WI-2141004 recurrence guard: the alert must MEASURE, never REMEMBER ──────
  # The defect here was not a crash. check_db_disk_headroom() had a measured example
  # hand-written into the prose it files ("PGDATA was 34 GiB ... VM disk images were
  # 566 GiB"). Both figures went stale, the probe kept asserting them as current
  # guidance on every fire, and three work-items chased the owner's VM images for
  # three weeks while a 60.59 GiB bloated TOAST relation went unexamined. A stale
  # sentence inside generated output is invisible to every other check in this repo —
  # no typecheck or unit test can see prose drift — so it needs its own guard.
  guard_body() { awk '/^check_db_disk_headroom\(\)/,/^}/' "$self"; }
  # WI-10005986: read the body ONCE into a variable and grep a here-string. Under
  # `set -o pipefail`, `guard_body | grep -q` is a load-dependent false FAIL: the
  # range is >4 KiB, mawk writes it in two chunks, grep -q exits on a match in the
  # first, and the second write SIGPIPEs awk, so the pipeline fails WITH a match.
  guard_text="$(guard_body)"

  # 19. The filed body must SPLICE THE DERIVED READING rather than a written-down list.
  if grep -q '\${consumers}' <<<"$guard_text"; then
    printf '  ok    alert body splices the derived top-consumers reading\n'; p=$((p+1))
  else
    printf '  FAIL  alert body no longer references ${consumers} — the consumer list is not being derived at alert time\n'; f=$((f+1))
  fi

  # 20. THE CLASS GUARD: no past-tense measured quantity may be asserted in that body.
  #     "was/were N GiB" is the shape of a remembered measurement, and a remembered
  #     measurement is exactly what went stale. Derived values interpolate at runtime
  #     and never match this, so a correct implementation cannot trip it.
  if grep -qE '(was|were) [0-9]+(\.[0-9]+)? ?(GiB|TiB|GB|TB)\b' <<<"$guard_text"; then
    printf '  FAIL  a remembered measurement is back in the alert body: ...%s...\n' \
      "$(grep -oE '.{0,45}(was|were) [0-9]+(\.[0-9]+)? ?(GiB|TiB|GB|TB)\b.{0,25}' <<<"$guard_text" | head -1)"; f=$((f+1))
  else
    printf '  ok    alert body asserts no remembered measurement\n'; p=$((p+1))
  fi

  # 21. The reading must degrade to an explanatory line — never to silence, and never
  #     to a nonzero exit — when the database cannot be reached. The alarm's whole job
  #     is to fire on a full disk, and a full disk is precisely when a database is
  #     most likely to be unreachable, so this helper must never be able to block it.
  consumers_out="$( ( BACKUP_DB_PORT=1
                      BACKUP_DB_NAME=nonexistent_db_for_selftest
                      BACKUP_CONSUMERS_TIMEOUT_S=2
                      top_db_consumers ) 2>/dev/null )"
  consumers_rc=$?
  if [ "$consumers_rc" = 0 ] && [ -n "$consumers_out" ]; then
    printf '  ok    unreachable database degrades to an explanatory line, never blocks the alarm\n'; p=$((p+1))
  else
    printf '  FAIL  top_db_consumers with an unreachable database: rc=%s, output=%q\n' \
      "$consumers_rc" "$consumers_out"; f=$((f+1))
  fi

  # 22. Neither database helper may discard psql's stderr. This guards the class that
  #     actually bit during development: the first version of the bloat query multiplied
  #     two int4 literals (5*1073741824), overflowed, and returned "ERROR: integer out of
  #     range" on EVERY call — but stderr went to /dev/null, so an empty result was
  #     indistinguishable from a healthy database and the detector was silently dead.
  #     Tests 19-21 all still passed, because a silent failure is precisely what test 21
  #     asserts is safe. Only a positive control caught it. So: stderr must be captured
  #     and screened, and a query that cannot run must log loudly.
  db_helpers() { awk '/^top_db_consumers\(\)/,/^}/' "$self"; awk '/^check_db_relation_bloat\(\)/,/^}/' "$self"; }
  # Assert the REDIRECT ITSELF, on the line that carries it. An earlier version of this
  # test matched /psql.*2>\/dev\/null/ and a mutation probe walked straight past it: the
  # psql invocation is split across continuation lines, so the word "psql" and the
  # redirect are never on the same line and a line-based grep can never see both.
  if [ "$(db_helpers | grep -c -- '-c "\$sql" 2>&1')" -lt 2 ] || \
     [ "$(db_helpers | grep -c "grep -qE '\^(ERROR|FATAL|psql):'")" -lt 2 ]; then
    printf '  FAIL  a database helper discards psql stderr or no longer screens for ERROR/FATAL — a failing query would read as a healthy database\n'; f=$((f+1))
  else
    printf '  ok    database helpers capture and screen psql errors instead of falling silent\n'; p=$((p+1))
  fi

  # ── WI-2147002 regression guard: persisted row estimate, not volatile stats ──
  # Reproduce the incident with a fake psql wrapper. In the stale-stats fixture,
  # pg_stat_user_tables.n_live_tup is 25 while pg_class.reltuples is ~99k for a
  # healthy 22 GiB archive; an implementation that trusts n_live_tup therefore
  # returns a false-positive row. The genuine-bloat fixture is the positive control:
  # the persisted estimate is small enough that 60 GiB of TOAST must still alarm.
  selftest_db_bin="$t/db-bin"; mkdir -p "$selftest_db_bin"
  cat >"$selftest_db_bin/sudo" <<'EOF'
#!/usr/bin/env bash
query=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-c" ]; then
    shift
    query="${1:-}"
    break
  fi
  shift
done
if [ -n "${SELFTEST_PSQL_QUERY_LOG:-}" ]; then
  printf '%s\n---QUERY---\n' "$query" >>"$SELFTEST_PSQL_QUERY_LOG"
fi
case "${SELFTEST_PSQL_MODE:-}" in
  stale-stats)
    [[ "$query" == *n_live_tup* ]] &&
      printf '%s\n' 'harness_shared.session_archive_files 22.02 GiB of TOAST over 25 live rows (11274.5 MiB/row)'
    ;;
  genuine-bloat)
    [[ "$query" == *reltuples* ]] &&
      printf '%s\n' 'harness_shared.gateway_payload_blobs 60.59 GiB of TOAST over 1176 catalog-estimated live rows (51.0 MiB/estimated row)'
    ;;
esac
EOF
  chmod +x "$selftest_db_bin/sudo"
  check_bloat_estimate() {
    local name="$1" mode="$2" want_marker="$3"; shift 3
    rm -rf "${t:?}/state" "$t/dump/pg" "$t/db-data" "$t/psql-query.log"
    mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart" "$t/db-data"
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/db-data" BACKUP_DISK_WARN_PCT=0 \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="" BACKUP_ALERT_FORCE=1 \
        SELFTEST_PSQL_MODE="$mode" SELFTEST_PSQL_QUERY_LOG="$t/psql-query.log" \
        PATH="$selftest_db_bin:$PATH" \
        "$@" bash "$self" >/dev/null 2>>"$selftest_stderr"
    local got_marker=no query_count=0 persisted_count=0
    [ -f "$t/state/db-relation-bloat-ei-filed" ] && got_marker=yes
    query_count="$(grep -c -- '---QUERY---' "$t/psql-query.log" 2>/dev/null || true)"
    persisted_count="$(grep -c -- 'reltuples' "$t/psql-query.log" 2>/dev/null || true)"
    if [ "$got_marker" = "$want_marker" ] && [ "$query_count" -eq 2 ] && [ "$persisted_count" -eq 2 ]; then
      printf '  ok    %s (marker=%s, persisted-estimate queries=%s)\n' "$name" "$got_marker" "$persisted_count"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted marker=%s and two persisted-estimate queries, got marker=%s, queries=%s, persisted=%s\n' \
        "$name" "$want_marker" "$got_marker" "$query_count" "$persisted_count"; f=$((f+1))
    fi
  }
  check_bloat_estimate "stale stats do not create a false TOAST-bloat alarm" stale-stats no
  check_bloat_estimate "persisted row estimate still flags genuine TOAST bloat" genuine-bloat yes
  printf '  ---- %d passed, %d failed (post TOAST-row-estimate block)\n' "$p" "$f"

  printf '  ---- %d passed, %d failed (post disk-headroom block)\n' "$p" "$f"

  # ── WI-39596 recurrence guard: backup-volume level + ETA to admission floor
  # This is deliberately a SECOND history and marker from PGDATA. A green root
  # volume says nothing about /mnt/data, where both dumps and Kopia content live.
  check_backup_volume() {
    local name="$1" threshold="$2" want_marker="$3" seed="$4" want_re="$5"; shift 5
    local out="" got_marker=no
    rm -rf "${t:?}/state" "$t/dump"; mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart"
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    [ -n "$seed" ] && printf '%s\n' "$seed" > "$t/state/backup-volume-history"
    out="$(env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/no-db-data" BACKUP_VOLUME_PATH="$t/dump" \
        BACKUP_VOLUME_WARN_PCT="$threshold" BACKUP_VOLUME_FLOOR_PCT=2 \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="" \
        PATH="$selftest_du_bin:$selftest_df_bin:$PATH" \
        "$@" bash "$self" 2>&1 >/dev/null)"
    note_shell_errors "$out"
    [ -f "$t/state/backup-volume-red-ei-filed" ] && got_marker=yes
    if [ "$got_marker" = "$want_marker" ] && grep -qE "$want_re" <<<"$out"; then
      printf '  ok    %s (marker=%s)\n' "$name" "$got_marker"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted marker=%s and /%s/; got marker=%s, output: %s\n' \
        "$name" "$want_marker" "$want_re" "$got_marker" \
        "$(printf '%s' "$out" | grep -i 'backup-volume usage' | head -1)"
      f=$((f+1))
    fi
  }

  backup_seed() {
    local age_s="$1" delta_kb="$2" now_s
    now_s="$(date +%s)"
    printf '%s %s' "$((now_s - age_s))" "$((selftest_avail_kb + delta_kb))"
  }

  check_backup_volume "backup volume green: no marker" \
        100 no "" "Backup-volume usage" BACKUP_NO_FILE=1
  check_backup_volume "backup volume red: marker set" \
        0 yes "" "Backup-volume usage" BACKUP_ALERT_FORCE=1
  # 23. THE INCIDENT ITSELF: the producer skips a 73 GiB dump at 122 GiB free,
  #     while 92% used has not fired yet. The alarm must follow the producer's
  #     120 GiB floor + 140% last-dump estimate and file here.
  check_backup_volume "producer-fit dead zone: largest dump triggers before 92%" \
        92 yes "" "producer-fit threshold 222 GiB" \
        BACKUP_ALERT_FORCE=1 SELFTEST_DF_TOTAL_KB=1348468736 \
        SELFTEST_DF_AVAIL_KB=127926272 SELFTEST_DF_CAPACITY=91% \
        SELFTEST_DUMP_SIZE_KB=76546048
  check_backup_volume "backup trend with no baseline: refuses an ETA" \
        100 no "" "no prior sample yet" BACKUP_NO_FILE=1
  check_backup_volume "backup trend falling: counts down to the 2% floor" \
        100 no "$(backup_seed 7200 10485760)" \
        "losing 5\\.0[0-9] GiB/h .* ETA TO 2% FLOOR" BACKUP_NO_FILE=1
  check_backup_volume "backup trend recovering: no countdown" \
        100 no "$(backup_seed 7200 -10485760)" \
        "NOT shrinking" BACKUP_NO_FILE=1
  printf '  ---- %d passed, %d failed (post backup-volume block)\n' "$p" "$f"

  # ── WI-38830 recurrence guard: signal (f), TMPDIR entry count ─────────────
  # Every case below points a WATCHED dir at an isolated fixture, never at the real
  # /tmp — a self-test that judged live host state would pass or fail for reasons that
  # have nothing to do with the code under test.
  check_entries() { # <name> <n-entries> <threshold> <want-marker> [subdir-entries] [ENV=VAL ...]
    local name="$1" n="$2" thresh="$3" want_marker="$4" sub="${5:-0}"; shift 5
    rm -rf "${t:?}/state" "$t/tmpwatch"; mkdir -p "$t/state" "$t/tmpwatch/nested"
    local i=0
    while [ "$i" -lt "$n" ]; do mkdir -p "$t/tmpwatch/leaky-scratch-$i"; i=$((i+1)); done
    i=0
    while [ "$i" -lt "$sub" ]; do mkdir -p "$t/tmpwatch/nested/leaky-scratch-$i"; i=$((i+1)); done
    env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/no-db-data" \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="" \
        BACKUP_TMPDIR_WATCH="$t/tmpwatch" BACKUP_TMPDIR_MAX_ENTRIES="$thresh" \
        "$@" bash "$self" >/dev/null 2>>"$selftest_stderr"
    local got_marker=no
    compgen -G "$t/state/tmpdir-entries-red*" >/dev/null 2>&1 && got_marker=yes
    if [ "$got_marker" = "$want_marker" ]; then
      printf '  ok    %s (marker=%s)\n' "$name" "$got_marker"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted marker=%s, got marker=%s\n' "$name" "$want_marker" "$got_marker"; f=$((f+1))
    fi
  }
  # 18. NOT A HAIR-TRIGGER: a normally-populated TMPDIR is green and silent.
  check_entries "entry count under threshold: green, no marker" 3 10 no 0
  # 19. NOT A MUTE BUTTON: it must actually be able to fire.
  check_entries "entry count over threshold + ALERT_FORCE: marker set" \
        12 10 yes 0 BACKUP_ALERT_FORCE=1
  # 20. The EI-10746 safety rule holds for this threshold too — overriding it is a TEST.
  #     (Cases 18/19 override it as well; 18 is green anyway and 19 opts in via FORCE,
  #     so this is the case that actually pins the suppression.)
  check_entries "entry count over threshold, no FORCE: suppressed, no marker" 12 10 no 0
  # 21. THE BLIND SPOT THIS PROBE EXISTS FOR (WI-38830): entries nested in a SUBDIRECTORY
  #     do not count toward the parent, so watching only the parent under-reports a leak
  #     that lands one level down. Measuring /tmp while the leak was in /tmp/pcv is exactly
  #     how 523,644 leaked dirs were reported as 74,385. A green here with 40 nested
  #     entries and a threshold of 10 is the CORRECT reading of the parent — and is
  #     precisely why /tmp/pcv must be named in BACKUP_TMPDIR_WATCH in its own right.
  check_entries "nested entries do NOT inflate the parent's count (the /tmp vs /tmp/pcv trap)" \
        3 10 no 40 BACKUP_ALERT_FORCE=1
  # 22. A non-numeric threshold must SKIP, never crash the whole health check.
  check_entries "invalid threshold: skips cleanly, no marker" 12 abc no 0 BACKUP_ALERT_FORCE=1
  printf '  ---- %d passed, %d failed (post tmpdir-entries block)\n' "$p" "$f"

  # ── WI-519487 recurrence guard: tmpdir_top_shapes collapses a random token
  # ANYWHERE in the name, not only a trailing suffix ─────────────────────────
  # tmpdir_top_shapes is a pure function already in scope in this process (defined
  # above, before this --self-test branch runs), so call it directly against a
  # throwaway fixture dir instead of spawning a nested `bash "$self"` per case.
  check_shape() { # <name> <fixture-dir> <want-line-regex> <file...>
    local name="$1" dir="$2" want_re="$3"; shift 3
    rm -rf "${t:?}/shapes"; mkdir -p "$dir"
    local f_name got
    for f_name in "$@"; do : > "$dir/$f_name"; done
    got="$(tmpdir_top_shapes "$dir")"
    if grep -qE "$want_re" <<<"$got"; then
      printf '  ok    %s\n' "$name"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted /%s/, got: %s\n' "$name" "$want_re" "$got"; f=$((f+1))
    fi
  }
  # 23. THE REPORTED BUG: mktemp's own "<literal>.XXXXXX.sh" template (the #1 leaker,
  #     _pc_heavy_scratch_mktemp in pc-heavy.sh) puts the random run BEFORE a literal
  #     extension, not at the end of the name — the old $-anchored regex never matched
  #     this shape at all, so three distinct random self-copies used to render as three
  #     distinct, un-actionable lines instead of one dominant "N pc-heavy-self.<rand>.sh".
  check_shape "random run before a literal extension collapses (the reported bug)" \
        "$t/shapes" '3 pc-heavy-self\.<rand>\.sh' \
        pc-heavy-self.tok1a3.sh pc-heavy-self.xY9zK2.sh pc-heavy-self.qR7bN4.sh
  # 24. A real lowercase word ("sidecar") sitting next to the random part must survive —
  #     collapsing must not mistake a literal path component for the random one just
  #     because it is also >=6 characters. Loses "NAMING THE CULPRIT" if this regresses.
  check_shape "a literal word beside the random part is preserved, not collapsed" \
        "$t/shapes" '2 prov-sidecar-<rand>$' \
        prov-sidecar-a1b2c3 prov-sidecar-x9y8z7
  # 25. The ALREADY-WORKING case (random run truly at the end) must keep working —
  #     this pass widens where a random run is looked for, it must not narrow it.
  check_shape "a trailing random run (the pre-existing working case) still collapses" \
        "$t/shapes" '2 live-fed-gate-snapshot\.<rand>$' \
        live-fed-gate-snapshot.aB3xY9 live-fed-gate-snapshot.qR7zK2
  # 26. A pure lowercase hex-alphabet run of >=8 chars must collapse to the SAME <hex>
  #     shape whether or not it happens to contain a digit — "abcdef12" and "deadbeef"
  #     are the same field, and splitting them into <rand> vs <hex> by digit-luck would
  #     fragment the one dominant "papercusp-affected-tests-<n>-<hex>.log" shape
  #     (1942 entries, WI-75008) into two, defeating the point of collapsing at all.
  check_shape "a >=8-char hex-alphabet run stays <hex> regardless of digit presence" \
        "$t/shapes" '2 papercusp-affected-tests-<n>-<hex>\.log$' \
        papercusp-affected-tests-123-abcdef12.log papercusp-affected-tests-456-deadbeef.log
  printf '  ---- %d passed, %d failed (post tmpdir-shapes block)\n' "$p" "$f"

  # 27. WI-2145430: no path any case above exercised may make the SHELL itself
  #     complain. This runs last on purpose — it is a verdict over the stderr
  #     every preceding case produced, so widening the self-test automatically
  #     widens this guard, with no pattern list to hand-maintain.
  # Grep HERE, not only in note_shell_errors: the redirected probe runs append
  # their WHOLE stderr, and several of them legitimately log there, so matching
  # on "non-empty" would fail on ordinary output.
  selftest_shell_errs="$(grep -aE ': line [0-9]+:' "$selftest_stderr" 2>/dev/null | sort -u | head -5)"
  if [ -z "$selftest_shell_errs" ]; then
    printf '  ok    no bash runtime error on any exercised probe path\n'; p=$((p+1))
  else
    printf '  FAIL  the shell itself errored on an exercised probe path:\n%s\n' "$selftest_shell_errs"; f=$((f+1))
  fi
  printf '  ---- %d passed, %d failed (post shell-runtime-error block)\n' "$p" "$f"

  [ "$f" -eq 0 ] || exit 1
  exit 0
fi

# Check the PostgreSQL data filesystem before the artifact probes. A shared root
# volume can take PostgreSQL down even while every backup artifact is still fresh.
check_db_disk_headroom
check_db_relation_bloat
check_backup_volume_headroom
check_tmpdir_entry_count
check_workspace_dump_transactions

# ── (a) FRESHNESS — judge the ARTIFACT, not the log ────────────────────────
# Deliberately artifact-based: a rotated/truncated hook.log must never make a dead
# backup look healthy. An artifact that stopped advancing IS the failure, whatever
# the log says.
# Required artifacts first, then the optional ones. The sentinel flips the mode
# mid-loop: membership testing cannot be used here because the optional list is
# a GLOB that expands during this very word-split, so an expanded path would no
# longer match the pattern it came from.
ART_OPTIONAL=0
for art in $BACKUP_ARTIFACTS __OPTIONAL_ARTIFACTS_FOLLOW__ $BACKUP_OPTIONAL_ARTIFACTS; do
  if [ "$art" = __OPTIONAL_ARTIFACTS_FOLLOW__ ]; then ART_OPTIONAL=1; continue; fi
  # Absolute entries are used as-is (workspace dumps live outside BACKUP_DUMP_DIR);
  # relative ones hang off it, as they always have.
  case "$art" in /*) f="$art" ;; *) f="$BACKUP_DUMP_DIR/$art" ;; esac
  # -e not -f: db-backup.sh's artifacts are pg_dump -Fd DIRECTORIES, not single files.
  if [ ! -e "$f" ]; then
    # An optional artifact that does not exist is not a fault: the workspace may
    # simply never have been backed up. Only its going STALE is a signal.
    if [ "$ART_OPTIONAL" = 1 ]; then
      log "artifact $art: absent (optional — not gated on existence)"
      continue
    fi
    TITLE="DB backup artifact MISSING: $art (no dump has ever succeeded at $BACKUP_DUMP_DIR)"
    BODY="EI-10733 durable backup-health probe: expected dump artifact '$f' does not exist at all. There is NO recoverable database dump. Check ~/.config/kopia/db-backup.sh, its timer (systemctl --user status papercusp-db-backup.timer), and $BACKUP_HOOK_LOG."
    RED_MARKER="$STATE_DIR/missing-${art//\//-}"   # art may contain '/' (pg/papercusp) — flatten for the filename
    if red_gate "$RED_MARKER" "missing $art"; then
      file_ei "$TITLE" "$BODY"; mark_red "$RED_MARKER"
    fi
    continue
  fi
  mtime="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)"
  age_hours=$(( ( $(now_s) - mtime ) / 3600 ))
  size="$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || echo 0)"
  log "artifact $art: age ${age_hours}h, size ${size}B (max age ${BACKUP_MAX_AGE_H}h)"
  RED_MARKER="$STATE_DIR/stale-${art//\//-}"   # flatten '/' in the artifact path for the marker filename
  if [ "$age_hours" -ge "$BACKUP_MAX_AGE_H" ] 2>/dev/null; then
    if [ "$ART_OPTIONAL" = 1 ] && ! optional_artifact_latest_hook_degraded "$f"; then
      rm -f "$RED_MARKER"
      log "artifact $art: ${age_hours}h old but no newer degraded hook result (optional/event cadence — age alone is not failure)"
      continue
    fi
    if [ "$ART_OPTIONAL" = 1 ]; then
      # Keep the admission title stable for this artifact. work_items:create derives
      # its dedupe identity from the title, so putting the changing age in it would
      # mint a new critical item every health-check tick. The measurement belongs in
      # the body, where it can stay current without changing the condition identity.
      TITLE="Workspace DB dump is stale after its latest snapshot hook degraded: $art"
      BODY="The optional per-workspace dump '$f' is ${age_hours} hours old (${size}B), and its companion hook.log records a newer final outcome of 'hook done (degraded)'. This is a proven failed attempt after the last good artifact, not elapsed idle time under an event-only policy.

Read ${f%/*}/hook.log for the pg FAIL/SKIP cause and the matching backup_snapshots row. The workspace hook writes PID/sequence-scoped transactions; check for dead-writer '${f}.*.tmp' files, which consume the headroom needed for recovery."
    else
    TITLE="DB backup is STALE: $art is ${age_hours}h old (>= ${BACKUP_MAX_AGE_H}h threshold) — we may have no recoverable database"
    BODY="EI-10733 durable backup-health probe: '$f' has not advanced in ${age_hours} hours (size ${size}B). The DB dump is supposed to run ~hourly.

THIS IS THE SIGNAL THAT WAS MISSING. On 2026-07-12 the backup had been failing 100% for ~30 DAYS (newest good dump 2026-06-12) and nothing detected it, because a plausible-looking 1.4GB .gz sat on disk the whole time. 'The backup file exists' is not 'the backup works' — only its FRESHNESS discriminates.

LIKELY CAUSES (check in this order):
 1. db-backup.sh's timer stopped firing: systemctl --user status papercusp-db-backup.timer papercusp-db-backup.service ; journalctl --user -u papercusp-db-backup.service -n 50. Read $BACKUP_DUMP_DIR/STATUS.json (ok / failed[] / lastSuccessEpoch) and $BACKUP_HOOK_LOG.
 2. A specific DB's dump is failing validation: db-backup.sh only renames a dump into place after pg_restore -l passes, so a per-DB 'FAIL' in db-backup.log means the archive was unreadable or the dump errored — read the actual pg_dump error there. DO NOT blindly raise PC_BACKUP_TIMEOUT_SEC without reading it.
 3. An orphaned pg_dump is holding locks (the EI-10730 knock-on): check for a pg_dump backend older than its timeout (SELECT pid, application_name, backend_start FROM pg_stat_activity WHERE application_name LIKE 'pg_dump%'). db-backup.sh tags its own dumps PGAPPNAME=pcbackup and reaps foreign ones; a lingering 'pg_dump%' backend is a legacy/manual dump.
 4. Disk full on the backup volume: df -h $BACKUP_DUMP_DIR

An orphaned/stuck dump is not just a dead backup — it holds AccessShareLock on ~593 tables, which starves every migration's ACCESS EXCLUSIVE and can wedge the whole release pipeline (EI-10730)."
    fi
    if red_gate "$RED_MARKER" "stale $art"; then
      file_ei "$TITLE" "$BODY"; mark_red "$RED_MARKER"
    fi
  else
    rm -f "$RED_MARKER"
  fi
done

# ── (b) CONSECUTIVE FAILURES in the hook log ───────────────────────────────
# Fires EARLY — within an hour or two of breakage — instead of waiting for the artifact
# to age past the freshness bar. Counts the TRAILING run of FAILs: any "ok" resets it, so
# a single transient failure never alarms, but a persistently broken dump does.
if [ ! -f "$BACKUP_HOOK_LOG" ]; then
  log "SKIP consecutive-fail probe: no hook log at $BACKUP_HOOK_LOG"
else
  # Walk the tail newest→oldest; count FAILED runs until the first OK. db-backup.sh writes
  # exactly one per-run summary line — "backup OK in Ns: ..." or "backup FAILED in Ns: ..." —
  # so this counts RUNS, not per-DB legs. Matching is anchored to that summary token so a
  # per-DB "papercusp FAIL" line inside a run never double-counts.
  TRAILING_FAILS="$(tac "$BACKUP_HOOK_LOG" 2>/dev/null | grep -aE 'backup (OK|FAILED)' | awk '
    /backup FAILED/ { n++; next }
    /backup OK/     { exit }
    { next }
    END { print n+0 }')"
  TRAILING_FAILS="${TRAILING_FAILS:-0}"
  log "hook log: $TRAILING_FAILS trailing FAIL(s) with no intervening ok (threshold $BACKUP_MAX_FAILS)"
  RED_MARKER="$STATE_DIR/consecutive-fails"
  if [ "$TRAILING_FAILS" -ge "$BACKUP_MAX_FAILS" ] 2>/dev/null; then
    TITLE="DB backup has FAILED $TRAILING_FAILS runs consecutively with no success — backups are broken"
    BODY="EI-10733 durable backup-health probe: $BACKUP_HOOK_LOG shows $TRAILING_FAILS consecutive 'backup FAILED' runs with no intervening 'backup OK' (threshold $BACKUP_MAX_FAILS).

This fires EARLY, before the artifact ages past the freshness bar — precisely so a broken backup is caught in hours, not the 30 DAYS it went unnoticed on 2026-07-12 (EI-10733).

Read the per-DB error in $BACKUP_HOOK_LOG (db-backup.sh logs 'db FAIL (...)' per database) and $BACKUP_DUMP_DIR/STATUS.json (failed[]). db-backup.sh only accepts a dump that passes pg_restore -l, so a FAILED run means the dump errored or produced an unreadable archive — read the actual pg_dump error, do NOT blindly raise PC_BACKUP_TIMEOUT_SEC. Also check for an orphaned pg_dump backend holding AccessShareLock on ~593 tables, which can wedge the release pipeline for hours (EI-10730): SELECT pid, application_name, backend_start FROM pg_stat_activity WHERE application_name LIKE 'pg_dump%'."
    if red_gate "$RED_MARKER" "consecutive fails"; then
      file_ei "$TITLE" "$BODY"; mark_red "$RED_MARKER"
    fi
  else
    rm -f "$RED_MARKER"
  fi
fi

# ── (c) STRANDED TMP — the EI-18678678853631218 recurrence guard ───────────
# A "*.tmp" pg_dump -Fd staging directory under $BACKUP_DUMP_DIR/pg/ that survives past
# one dump cycle means the failure-path cleanup could not remove it (0700 postgres-owned,
# `rm -rf` as the service user denied) — and because pg_dump -Fd refuses a non-empty target,
# that ONE stranded .tmp silently fails every later run of that database. db-backup.sh's
# rm_tmp() now falls back to `sudo -n rm -rf`, so this should never fire; if it does, the
# fallback itself is failing (e.g. a sudoers change) and needs a human, not just a retry.
PG_DIR="$BACKUP_DUMP_DIR/pg"
if [ -d "$PG_DIR" ]; then
  STALE_TMPS="$(find "$PG_DIR" -mindepth 1 -maxdepth 1 -name '*.tmp' -mmin "+$(( BACKUP_STALE_TMP_MAX_H * 60 ))" 2>/dev/null || true)"
  RED_MARKER="$STATE_DIR/stale-tmp"
  if [ -n "$STALE_TMPS" ]; then
    log "stranded tmp(s) found (older than ${BACKUP_STALE_TMP_MAX_H}h): $STALE_TMPS"
    TITLE="DB backup has a STRANDED .tmp staging dir — a database is silently failing every run"
    BODY="EI-18678678853631218 recurrence-guard probe: the following pg_dump -Fd staging director$([ "$(printf '%s\n' "$STALE_TMPS" | grep -c .)" = 1 ] && echo y || echo ies) under '$PG_DIR' predate the current run by more than ${BACKUP_STALE_TMP_MAX_H}h:

$STALE_TMPS

pg_dump -Fd refuses to write into a non-empty target, so as long as a stale '.tmp' sits here the database it belongs to fails EVERY hourly run — silently, unless (a)/(b) above happen to also fire. This is the EI-18678678853631218 failure shape: a failed dump's 0700 postgres-owned '.tmp' cannot be removed by a plain \`rm -rf\` running as the service user on the failure path.

CHECK FIRST: db-backup.sh's rm_tmp() (added 2026-07-26) should already fall back to \`sudo -n rm -rf\` for exactly this case — if a .tmp is still stranded, that fallback itself is failing (e.g. a sudoers/NOPASSWD change, disk-full on the delete). Read \$BACKUP_DUMP_DIR/db-backup.log for 'WARN could not remove stale tmp' to confirm, then fix the sudoers/perms gap. Manual recovery: \`sudo rm -rf <path>\` once, to let the next hourly run proceed."
    if red_gate "$RED_MARKER" "stranded tmp"; then
      file_ei "$TITLE" "$BODY"; mark_red "$RED_MARKER"
    fi
  else
    rm -f "$RED_MARKER"
  fi
fi

exit 0
