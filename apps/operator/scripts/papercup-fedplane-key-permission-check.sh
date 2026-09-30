#!/usr/bin/env bash
# papercup-fedplane-key-permission-check.sh — periodic private-key EXPOSURE probe
# for a fed-plane host (WI-2143622).
#
# WHY: on 2026-09-03 an UNENCRYPTED SSH private key was found at
# /mnt/data/back/Debug/.ssh/id_ed25519 with mode 0664 inside a 0775 .ssh
# directory — group- AND world-readable, and `ssh-keygen -y -P ''` returned 0,
# so it was directly usable by any local account, not merely readable. It
# surfaced only because an agent happened to `stat` that path during an
# unrelated disk-reclaim check (EI-22240449643643994). Nothing on this box was
# looking for it. The fed-plane detector family covered host disk (EI-8982),
# DHT liveness (EI-8892) and backup health; key permissions were an uncovered
# class, so the interval between exposure and discovery was bounded only by
# luck.
#
# DETECTION + ESCALATION ONLY. This script never chmods, moves, or deletes
# anything, and never reads or logs key MATERIAL — it reports PATHS and MODE
# BITS only. Remediation is a human/agent call made off the filed EI, the same
# posture as papercup-fedplane-disk-health-check.sh (EI-8901: a health check
# must not also hold mutate authority over the thing it is judging, or a
# threshold bug becomes a self-inflicted incident).
#
# ─────────────────────────────────────────────────────────────────────────────
# THE THREE DESIGN CONSTRAINTS — every one of them MEASURED on this box, not
# guessed. Changing any of them without re-measuring will break the probe in a
# way that still looks like it is working.
# ─────────────────────────────────────────────────────────────────────────────
#
# (1) CONTENT-MATCH, NEVER FILENAME. A filename glob is simultaneously noisy
#     and incomplete: `id_*` matches /usr/share/i18n's `id_ID` LOCALE files,
#     while a genuine key named `deploy.pem`, `backup-key` or `server.key` is
#     missed entirely. Every candidate here is confirmed by a literal
#     "PRIVATE KEY" header inside the file.
#
# (2) EXCLUDE VENDORED TREES, OR THE PROBE IS IGNORED WITHIN A WEEK. A census
#     of /mnt/data on 2026-09-03 content-matched 755 group/world-readable
#     private keys. EVERY SINGLE ONE was published third-party test material
#     whose private half is public BY DESIGN:
#         496  openssl-src + postgresql-src test suites (build scratch)
#         188  gomodcache (grpc, kopia, sigstore/rekor, in-toto,
#              certificate-transparency-go testdata)
#          17  node_modules (ssh2 + node-gyp test fixtures)
#           4  Go stdlib source (crypto/tls, crypto/x509 testdata)
#     Mode 444 on a read-only Go module cache is normal, not a finding. A
#     detector that alarms on grpc testdata trains its readers to skip its
#     output — and then it cannot report the one real key either. The measured
#     post-exclusion hit count on this box is ZERO, which is what makes a hit
#     here worth waking someone for.
#
# (3) AN EMPTY RESULT IS NOT AUTOMATICALLY A CLEAN RESULT. This is the
#     constraint that matters most and the one a security probe most often
#     omits, because the broken direction is the REASSURING one. Three separate
#     instruments produced a clean-looking nothing during the census, any of
#     which would have supported "no exposed keys exist":
#         - `find / -xdev` never crosses into /home or /mnt/data on this box
#           (separate mounts) and returned ZERO rows while two id_ed25519 files
#           demonstrably existed;
#         - a whole-box foreground find exceeded its deadline and was
#           SIGTERM-killed, printing nothing;
#         - a log read taken while the writer was still running looked
#           identical to a finished empty result.
#     So this probe carries a POSITIVE CONTROL (a key path it must rediscover
#     on every run) and treats a timed-out or unrunnable scan as INDETERMINATE
#     — a RED about the DETECTOR — never as "clean". A scan that cannot prove
#     it can still find the key we already know about has not established
#     anything about the keys we do not.
#
# Usage: papercup-fedplane-key-permission-check.sh
# Env:
#   KEYPERM_SSH_ROOTS       (default "/home /root /mnt/data/back") — roots swept
#                             for .ssh directories (tier 1, cheap)
#   KEYPERM_SSH_MAXDEPTH    (default 6)   — depth bound for the tier-1 sweep
#   KEYPERM_DEEP            (default 1)   — run the tier-2 content sweep
#   KEYPERM_DEEP_ROOTS      (default "$HOME /mnt/data/back") — tier-2 roots
#   KEYPERM_DEEP_TIMEOUT_S  (default 900) — hard bound; a timeout is
#                             INDETERMINATE, never clean
#   KEYPERM_EXCLUDE_DIRS    (default: see EXCLUDE_DIRS_DEFAULT) — space-separated
#                             directory-NAME globs pruned from both tiers
#   KEYPERM_POSITIVE_CONTROL (default "$HOME/.ssh/id_ed25519") — a private key
#                             the tier-1 sweep MUST rediscover, or the scan is
#                             declared broken
#   KEYPERM_NO_FILE         (default 0)   — set 1 to skip EI filing (log-only)
#   KEYPERM_RED_REFILE_H    (default 24)  — RED-EI dedup window
#   OPERATOR_MCP_URL        (default http://127.0.0.1:3070/api/mcp?superuser=1)
set -uo pipefail

# State-aware RED dedup (EI-22240553542994017). Sourced, not optional: without
# it this probe would fall back to age-only suppression, which is the defect
# that library exists to remove — a marker's age proves a filing happened, never
# that the condition is still TRACKED. A key-exposure detector inheriting that
# bug would assert "already tracked" about a dropped item while a usable private
# key sits world-readable.
RED_MARKER_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/red-marker.sh"
if [ -r "$RED_MARKER_LIB" ]; then
  # shellcheck source=lib/red-marker.sh
  . "$RED_MARKER_LIB"
else
  echo "[fedplane-key-perm] FATAL: missing $RED_MARKER_LIB — refusing to run with age-only dedup." >&2
  exit 2
fi

KEYPERM_SSH_ROOTS="${KEYPERM_SSH_ROOTS:-/home /root /mnt/data/back}"
KEYPERM_SSH_MAXDEPTH="${KEYPERM_SSH_MAXDEPTH:-6}"
KEYPERM_DEEP="${KEYPERM_DEEP:-1}"
# NOT "$HOME" — measured 2026-09-03 at load average ~63, nice 19 / ionice idle:
# a whole-$HOME sweep took 543s (9m03s), i.e. it consumed 60% of the 900s default
# budget on ONE root and left no headroom for a busier day. It is that expensive
# because $HOME here carries ~1.6M small files in toolchain and state trees that
# cannot hold a key worth alarming on: .papercusp 681k, go 468k, .local 172k,
# .rustup 114k, .cache 69k, .npm 62k, .cargo 51k. A probe that files a RED about
# its own timeout on any slow day gets muted exactly like one that alarms on grpc
# testdata — the failure this design spent its whole budget avoiding,
# reintroduced through the back door of a careless default.
#
# So the default names the trees tier 2 is actually FOR: the dev checkouts (a
# .pem committed into a working tree), user config, and the backup tree — which
# is where the 2026-09-03 key was found. Measured: 394k candidate files after
# pruning, and the find leg completes in under 100s. Widen it deliberately with
# a matching KEYPERM_DEEP_TIMEOUT_S; do not widen it and leave the budget.
KEYPERM_DEEP_ROOTS="${KEYPERM_DEEP_ROOTS:-$HOME/papercupai-workspace $HOME/.config /mnt/data/back}"
KEYPERM_DEEP_TIMEOUT_S="${KEYPERM_DEEP_TIMEOUT_S:-900}"
# ${VAR-default}, NOT ${VAR:-default} — the colon form treats an explicitly EMPTY
# value as unset and substitutes the default, which would silently cancel the
# documented opt-out below and re-enable a control the operator deliberately
# switched off. Same reason on KEYPERM_EXCLUDE_DIRS.
KEYPERM_POSITIVE_CONTROL="${KEYPERM_POSITIVE_CONTROL-$HOME/.ssh/id_ed25519}"
KEYPERM_NO_FILE="${KEYPERM_NO_FILE:-0}"
KEYPERM_RED_REFILE_H="${KEYPERM_RED_REFILE_H:-24}"
OPERATOR_MCP_URL="${OPERATOR_MCP_URL:-http://127.0.0.1:3070/api/mcp?superuser=1}"
GATE_SUPERUSER_TOKEN_PATH="${GATE_SUPERUSER_TOKEN_PATH:-$HOME/.papercusp/superuser-token}"
GATE_SUPERUSER_BEARER="$(cat "$GATE_SUPERUSER_TOKEN_PATH" 2>/dev/null | tr -d '[:space:]' || true)"
STATE_DIR="${KEYPERM_STATE_DIR:-$HOME/.papercusp/fedplane-key-permission}"
mkdir -p "$STATE_DIR" 2>/dev/null || true

# Directory-NAME globs pruned from both tiers. See constraint (2): this list is
# the difference between a probe with a measured zero-noise floor and one that
# reports 755 published test keys per run. Names, not paths, so a vendored tree
# is pruned wherever it is unpacked — the same openssl-src appeared under two
# different VM-release-trust scratch directories with random suffixes.
# Two populations, both excluded for the same reason — a hit inside them is
# never actionable — but worth telling apart when tuning:
#   VENDORED third-party source, whose "keys" are published test vectors
#     (node_modules and its deployment/generation temp trees, gomodcache*,
#      openssl-src, postgresql-src, testdata, vendor, hetzner-rescue OS
#      snapshots, dependency-generations);
#   TOOLCHAIN/BUILD/CACHE trees, which are regenerable and dominate the file
#     count rather than the risk (.git, target, .cargo-target, .cache, .cargo,
#      .rustup, .npm, .pnpm-store, __pycache__).
# The cache half is what makes a widened KEYPERM_DEEP_ROOTS survivable; see the
# measurement on KEYPERM_DEEP_ROOTS below.
EXCLUDE_DIRS_DEFAULT='node_modules node_modules.deploy-tmp.* node_modules.deploy-old.* node_modules.generation-tmp.* node_modules.generation-old.* gomodcache* .git target dependency-generations openssl-src postgresql-src hetzner-rescue testdata vendor site-packages dist-packages .venv venv .cargo-target .cache .cargo .rustup .npm .pnpm-store __pycache__'
KEYPERM_EXCLUDE_DIRS="${KEYPERM_EXCLUDE_DIRS-$EXCLUDE_DIRS_DEFAULT}"

log() { echo "[fedplane-key-perm $(date +%H:%M:%S 2>/dev/null || true)] $*" >&2; }
jstr() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$1"; }

# Build the shared `find` prune expression from KEYPERM_EXCLUDE_DIRS.
# Echoes nothing when the list is empty, which is a legitimate (noisy) mode.
PRUNE_ARGS=()
_build_prune() {
  PRUNE_ARGS=()
  local first=1 d
  for d in $KEYPERM_EXCLUDE_DIRS; do
    [ -n "$d" ] || continue
    if [ "$first" = 1 ]; then PRUNE_ARGS+=('(' '-name' "$d"); first=0
    else PRUNE_ARGS+=('-o' '-name' "$d"); fi
  done
  [ "$first" = 1 ] || PRUNE_ARGS+=(')' '-prune' '-o')
}
_build_prune

# Set by file_ei to the work-item id the filing resolved to (empty when it did
# not confirm one). Recorded into the RED marker so the NEXT run can ask whether
# that item is still open instead of trusting the marker's age.
LAST_FILED_EI_ID=""

file_ei() { # <title> <body>
  LAST_FILED_EI_ID=""
  [ "$KEYPERM_NO_FILE" = 1 ] && { log "KEYPERM_NO_FILE=1 — would have filed: $1"; return 0; }
  local resp
  local -a auth_hdr=()
  if [ -n "$GATE_SUPERUSER_BEARER" ]; then
    auth_hdr=(-H "authorization: Bearer $GATE_SUPERUSER_BEARER")
  else
    log "WARN: no superuser bearer at $GATE_SUPERUSER_TOKEN_PATH — EI filing will 403; falling back to log-only."
  fi
  resp="$(curl -s -m 30 -X POST "$OPERATOR_MCP_URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "${auth_hdr[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"work_items:create\",\"arguments\":{\"kind\":\"bug\",\"title\":$(jstr "$1"),\"summary\":$(jstr "$2"),\"harness\":\"papercusp\",\"severity\":\"critical\",\"topics\":[\"security\",\"host-health\",\"secrets\"]}}}" 2>/dev/null || true)"
  local id_match
  id_match="$(printf '%s' "$resp" | grep -oaE '\\?"id\\?":\\?"WI-[0-9]+' | head -1)"
  if [ -n "$id_match" ]; then
    LAST_FILED_EI_ID="$(printf '%s' "$id_match" | grep -oaE 'WI-[0-9]+')"
    log "EI filed OK → $LAST_FILED_EI_ID"
  else
    log "EI filing DID NOT CONFIRM (no WI id in response) — resp head: ${resp:0:200}"
  fi
}

# file_red <marker-name> <title> <body> — dedup through red-marker.sh, then file.
file_red() {
  local marker="$STATE_DIR/$1" title="$2" body="$3" verdict
  verdict="$(red_dedup_check "$marker" "$KEYPERM_RED_REFILE_H")"
  if [ "${verdict%% *}" = "SUPPRESS" ]; then
    log "RED dedup: ${verdict#* }. $title"
    return 0
  fi
  log "RED dedup: ${verdict#* }"
  file_ei "$title" "$body"
  red_marker_write "$marker" "$LAST_FILED_EI_ID"
}

# The one content predicate, shared by both tiers.
#
# ⚠ IT MUST MATCH THE PEM DELIMITER, NOT THE BARE PHRASE "PRIVATE KEY". The
# first implementation grepped for the phrase and the first full live run
# immediately proved that wrong: it flagged Python SOURCE FILES that merely
# mention it — cryptography/hazmat/primitives/serialization/ssh.py, jwt/utils.py,
# joserfc/_rfc7519/security.py — because any library that PARSES PEM naturally
# contains the string in a constant or regex. That is a false-positive class
# large enough to bury a real finding, which is the failure mode this whole
# design is organised around.
#
# Anchoring on a line that IS the delimiter ("-----BEGIN [LABEL] PRIVATE KEY-----"
# at start of line) keeps every real key — OpenSSH, PKCS#1, PKCS#8, EC, DSA,
# ENCRYPTED — while dropping source that only talks about them. The pattern is
# written with -{5} rather than five literal dashes so this script does not
# itself contain a PEM begin-block: that token trips the repo secrets guard on
# write and, worse, the pot-git publish guard, whose baseline never advances past
# a refused range.
KEY_HEADER_RE='^-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}'

# is_private_key <file> — 0 when the file IS a private key.
# -I skips binaries, -m1 stops at the first match, and NOTHING from the file is
# ever echoed: this predicate answers yes/no and discards the matched line.
is_private_key() {
  local f="${1:-}"
  [ -f "$f" ] && [ -r "$f" ] || return 1
  grep -qaIE -m1 "$KEY_HEADER_RE" "$f" 2>/dev/null
}

# mode_of <path> — numeric mode ("600"), or empty when unreadable.
mode_of() { stat -c '%a' "$1" 2>/dev/null || true; }

# group_or_other_bits <mode> — 0 (true) when any group/other bit is set.
# Modes are compared as OCTAL TEXT, not arithmetic: `stat -c %a` drops leading
# zeros ("600", not "0600"), so a numeric comparison silently reinterprets a
# 4-digit setuid mode. Taking the last two characters is exact for both forms.
group_or_other_bits() {
  local m="${1:-}"
  [ -n "$m" ] || return 1
  [ "${m: -2}" != "00" ]
}

# key_encryption_state <file> — echoes "unencrypted" | "encrypted" | "unknown".
#
# An UNENCRYPTED key is directly usable by anyone who can read it. That is the
# fact separating "readable" from "usable", and it is what raised
# EI-22240449643643994 from a hygiene note to a credential exposure — so the
# probe has to establish it, and has to fail toward "unknown" rather than toward
# the reassuring "encrypted".
#
# ⚠ DO NOT "SIMPLIFY" THIS BACK TO `ssh-keygen -y -P ''`. That was the first
# implementation and it is structurally broken HERE, in the false-comfort
# direction: ssh-keygen REFUSES to load a key whose permissions are too open
# ("Permissions 0664 ... are too open", exit 255) — which is TRUE OF EVERY KEY
# THIS PROBE FLAGS, by definition. So it never once returns 0 on a finding, and
# every exposed unencrypted key gets reported as "passphrase-protected". A
# fixture test caught this; the earlier by-hand check on the real key only
# appeared to work because it was run AFTER the key had been chmod'd to 0600.
#
# Header inspection has none of that coupling: it needs no permission from ssh,
# never copies the key anywhere, and works on TLS/PEM keys that ssh-keygen
# cannot read at all. Nothing decoded here is key material — only the format
# magic and the cipher NAME are examined, and both are discarded unprinted.
key_encryption_state() {
  local f="${1:-}" head1
  [ -r "$f" ] || { echo unknown; return; }
  head1="$(head -c 200 "$f" 2>/dev/null | head -1)"
  case "$head1" in
    *'BEGIN ENCRYPTED PRIVATE KEY'*) echo encrypted; return ;;
  esac
  # Legacy PEM announces encryption in the header block, not the BEGIN line.
  if head -20 "$f" 2>/dev/null | grep -qaE 'Proc-Type:.*ENCRYPTED|DEK-Info:'; then
    echo encrypted; return
  fi
  case "$head1" in
    *'BEGIN OPENSSH PRIVATE KEY'*)
      # openssh-key-v1 body: the magic "openssh-key-v1\0", a uint32 length, then
      # the cipher NAME — literally "none" when there is no passphrase, and
      # "aes256-ctr" (or similar) when there is. 64 base64 chars is a whole
      # number of quanta and decodes to 48 bytes, comfortably past the name.
      if sed -n '2,4p' "$f" 2>/dev/null | tr -d '\n' | cut -c1-64 | base64 -d 2>/dev/null \
           | head -c 48 | grep -qa 'none'; then
        echo unencrypted; return
      fi
      echo encrypted; return ;;
    *'BEGIN PRIVATE KEY'* | *'BEGIN RSA PRIVATE KEY'* | *'BEGIN EC PRIVATE KEY'* | *'BEGIN DSA PRIVATE KEY'*)
      echo unencrypted; return ;;
  esac
  echo unknown
}

FINDINGS=""        # human-readable lines, appended by both tiers
FINDING_COUNT=0
add_finding() { FINDINGS="${FINDINGS}$1"$'\n'; FINDING_COUNT=$((FINDING_COUNT + 1)); }

# ── TIER 1: .ssh directories ────────────────────────────────────────────────
# Cheap, depth-bounded, and the tier that would have caught the 2026-09-03 key.
# It checks BOTH halves of that finding: the containing directory's mode (0775)
# and each contained private key's mode (0664). A 0700 directory holding a 0644
# key is still an exposure to anything running as the owner's group inside it,
# and a 0600 key inside a 0775 directory is exposed to a path-traversal read of
# anything else in there, so neither check subsumes the other.
SSH_KEYS_SEEN=""
SSH_BLIND_ROOTS=""
for root in $KEYPERM_SSH_ROOTS; do
  [ -d "$root" ] || { log "tier1: skip missing root $root"; continue; }
  # A root this process cannot read is a BLIND SPOT, not an empty one — the
  # sweep runs unprivileged by design, so /root is normally unreadable here and
  # contributes exactly zero rows while looking identical to a clean root.
  # Deliberately NOT treated as a scan failure (that would fire every run); it
  # is named in the log and in any filing so the coverage claim stays honest,
  # and the positive control is what actually validates the sweep.
  if [ ! -r "$root" ] || [ ! -x "$root" ]; then
    log "tier1: root $root is NOT READABLE by $(id -un 2>/dev/null || echo '?') — BLIND SPOT, not a clean result."
    SSH_BLIND_ROOTS="${SSH_BLIND_ROOTS}${root} "
    continue
  fi
  while IFS= read -r sshdir; do
    [ -n "$sshdir" ] || continue
    dmode="$(mode_of "$sshdir")"
    if group_or_other_bits "$dmode"; then
      add_finding "DIR  mode=${dmode} ${sshdir} (expected 700)"
    fi
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      is_private_key "$f" || continue
      SSH_KEYS_SEEN="${SSH_KEYS_SEEN}${f}"$'\n'
      fmode="$(mode_of "$f")"
      group_or_other_bits "$fmode" || continue
      case "$(key_encryption_state "$f")" in
        unencrypted) add_finding "KEY  mode=${fmode} ${f} — UNENCRYPTED (no passphrase): readable == directly usable" ;;
        encrypted)   add_finding "KEY  mode=${fmode} ${f} — passphrase-protected (still fix the mode; an offline crack is unbounded)" ;;
        *)           add_finding "KEY  mode=${fmode} ${f} — encryption state UNKNOWN (unrecognised key format); treat as unencrypted until checked" ;;
      esac
    done < <(find "$sshdir" -maxdepth 1 -type f ! -name '*.pub' ! -name 'known_hosts*' ! -name 'config' ! -name 'authorized_keys*' 2>/dev/null)
  done < <(find "$root" -maxdepth "$KEYPERM_SSH_MAXDEPTH" -type d -name .ssh 2>/dev/null)
done

# ── POSITIVE CONTROL — constraint (3) ───────────────────────────────────────
# The tier-1 sweep must rediscover a key we already know exists. If it does not,
# the sweep is BROKEN (wrong roots, a mount it cannot cross, a depth bound too
# shallow, a permissions refusal) and its silence carries no information. Report
# that as a RED about the detector rather than letting an empty finding list be
# read as a clean bill of health.
#
# A CONFIGURED-BUT-MISSING control is a FAILURE, not a skip. That distinction is
# the whole point: if the control path is stale, typo'd, or the key moved, the
# probe would otherwise run unvalidated forever while still printing "no exposed
# private keys found" — a false clean produced by the safety mechanism itself.
# A host that genuinely holds no private key can opt out DELIBERATELY with
# KEYPERM_POSITIVE_CONTROL="", which is loud in the log and cannot happen by
# accident the way a wrong path can.
if [ -z "$KEYPERM_POSITIVE_CONTROL" ]; then
  CONTROL_STATUS="opted-out"
  log "positive control DISABLED (KEYPERM_POSITIVE_CONTROL empty) — this run is UNVALIDATED by design."
elif [ ! -f "$KEYPERM_POSITIVE_CONTROL" ]; then
  CONTROL_STATUS="ABSENT"
elif printf '%s' "$SSH_KEYS_SEEN" | grep -qxF "$KEYPERM_POSITIVE_CONTROL"; then
  CONTROL_STATUS="passed"
else
  CONTROL_STATUS="FAILED"
fi
log "tier1: .ssh sweep over [$KEYPERM_SSH_ROOTS] depth<=$KEYPERM_SSH_MAXDEPTH — positive control: $CONTROL_STATUS${SSH_BLIND_ROOTS:+; blind roots: $SSH_BLIND_ROOTS}"

if [ "$CONTROL_STATUS" = "FAILED" ] || [ "$CONTROL_STATUS" = "ABSENT" ]; then
  file_red "scanbroken-red-ei-filed" \
    "fed-plane key-permission probe cannot validate itself on $(hostname 2>/dev/null || echo unknown-host) — its result is INDETERMINATE, not clean" \
    "WI-2143622 key-permission probe: the tier-1 .ssh sweep FAILED ITS POSITIVE CONTROL (status=${CONTROL_STATUS}; ABSENT means the configured control path does not exist, FAILED means it exists but the sweep did not reach it). It was asked to rediscover a private key expected at ${KEYPERM_POSITIVE_CONTROL} while sweeping roots [${KEYPERM_SSH_ROOTS}] to depth ${KEYPERM_SSH_MAXDEPTH}, and did not. Unreadable (blind) roots this run: [${SSH_BLIND_ROOTS:-none}]. UNTIL THIS IS FIXED THE PROBE'S SILENCE MEANS NOTHING: an exposed key would produce the same empty output. Likely causes, in the order they have actually bitten here: a root on a filesystem the sweep does not cross; a depth bound too shallow for where the key lives; a permission refusal reading a directory (the sweep runs unprivileged by design); the control path itself moved. ACTION: run the script by hand with KEYPERM_NO_FILE=1 and read the tier-1 log lines, then correct KEYPERM_SSH_ROOTS / KEYPERM_SSH_MAXDEPTH / KEYPERM_POSITIVE_CONTROL. Do NOT silence this by deleting the control."
fi

# ── TIER 2: content-matched sweep outside .ssh ──────────────────────────────
# Catches what tier 1 structurally cannot: an exported deploy key, a .pem
# checked into a working tree, a key in a backup directory that is not shaped
# like a home. Bounded by KEYPERM_DEEP_TIMEOUT_S and nice'd, because on this box
# the same sweep ran for ~10 minutes at load average 63 (a security probe that
# degrades its host is a probe that gets disabled).
DEEP_STATUS="disabled"
if [ "$KEYPERM_DEEP" = 1 ]; then
  DEEP_STATUS="ok"
  for root in $KEYPERM_DEEP_ROOTS; do
    [ -d "$root" ] || { log "tier2: skip missing root $root"; continue; }
    log "tier2: content sweep of $root (timeout ${KEYPERM_DEEP_TIMEOUT_S}s)"
    # The WHOLE pipeline runs under one timeout, because the expensive half is
    # the grep, not the find. It is wrapped in `bash -c` so that `timeout`'s own
    # exit status is what lands in $? — a naive
    #   deep_out="$(timeout … find … | xargs grep …)"; rc=${PIPESTATUS[0]}
    # reads the ASSIGNMENT's status (i.e. grep's), never timeout's, so a killed
    # sweep reports rc=1 and is indistinguishable from a clean one. That is
    # precisely the false-clean this probe exists to refuse, so it is worth the
    # extra process.
    deep_out="$(timeout "$KEYPERM_DEEP_TIMEOUT_S" nice -n 19 ionice -c 3 bash -c '
        re="$1"; shift
        find "$@" -print0 2>/dev/null | xargs -0 -r -n 200 grep -laIE -m1 "$re" 2>/dev/null
      ' _ "$KEY_HEADER_RE" "$root" "${PRUNE_ARGS[@]}" -type f -size -64k -size +100c)"
    rc=$?
    # 124 is timeout(1)'s own "the command timed out" status. Partial output from
    # a killed sweep is not a complete answer, so it is reported as such rather
    # than folded into the clean case.
    if [ "$rc" = 124 ]; then
      DEEP_STATUS="TIMEOUT"
      log "tier2: TIMED OUT after ${KEYPERM_DEEP_TIMEOUT_S}s under $root — result INDETERMINATE, not clean."
    fi
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      # Tier 1 already reported anything under a .ssh directory, with the
      # richer encryption verdict; do not double-file the same path.
      case "$f" in */.ssh/*) continue ;; esac
      fmode="$(mode_of "$f")"
      group_or_other_bits "$fmode" || continue
      add_finding "FILE mode=${fmode} ${f} (content-matched private key outside .ssh)"
    done <<<"$deep_out"
  done
fi

if [ "$DEEP_STATUS" = "TIMEOUT" ]; then
  file_red "deeptimeout-red-ei-filed" \
    "fed-plane key-permission deep sweep timed out on $(hostname 2>/dev/null || echo unknown-host) — the tier-2 result is INDETERMINATE" \
    "WI-2143622 key-permission probe: the tier-2 content sweep over [${KEYPERM_DEEP_ROOTS}] exceeded KEYPERM_DEEP_TIMEOUT_S=${KEYPERM_DEEP_TIMEOUT_S}s and was killed. Whatever it had found so far is reported alongside this, but ABSENCE OF FURTHER FINDINGS PROVES NOTHING for this run — a killed find prints nothing and looks exactly like a clean one, which is the failure mode this probe was built to refuse (see constraint 3 in the script header). ACTION: either raise KEYPERM_DEEP_TIMEOUT_S, narrow KEYPERM_DEEP_ROOTS, or widen KEYPERM_EXCLUDE_DIRS — on this box the dominant cost is vendored dependency trees, and pruning them is what makes the sweep tractable. Note that tier 1 (.ssh directories) is independent of this and reported separately."
fi

# ── Report ──────────────────────────────────────────────────────────────────
if [ "$FINDING_COUNT" = 0 ]; then
  log "no exposed private keys found (tier1 control=$CONTROL_STATUS, tier2=$DEEP_STATUS)."
  rm -f "$STATE_DIR/exposed-red-ei-filed"
else
  log "EXPOSED PRIVATE KEYS: $FINDING_COUNT"
  printf '%s' "$FINDINGS" >&2
  file_red "exposed-red-ei-filed" \
    "${FINDING_COUNT} private key(s) or .ssh director(ies) are group/world-readable on $(hostname 2>/dev/null || echo unknown-host)" \
    "WI-2143622 key-permission probe: ${FINDING_COUNT} exposure(s) found. A private key readable by group or other is usable by every local account and by anything that can read the backup tree it sits in; when it is also UNENCRYPTED (marked below where established) readable means directly usable — that distinction is what raised EI-22240449643643994 from a hygiene note to a credential exposure.

FINDINGS (paths and mode bits only — this probe never reads or logs key material):
${FINDINGS}
ACTION: for each, chmod 0600 the key and 0700 its containing directory, then decide whether the key must be ROTATED — permissions are recoverable, an already-copied key is not. Check who could have read it (group membership, backup replication targets, anything that syncs that tree) before assuming a chmod closes the incident.

CONTEXT: every hit here already survived the vendored-tree exclusion set (${KEYPERM_EXCLUDE_DIRS}), whose measured false-positive floor on this box is ZERO — 755 published third-party test keys were excluded by it. So these are not test fixtures unless the exclusion set has drifted; verify that before dismissing one."
fi

exit 0
