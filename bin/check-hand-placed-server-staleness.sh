#!/usr/bin/env bash
# check-hand-placed-server-staleness.sh — EI-13939
#
# WHY THIS EXISTS
# A "Papercusp Server" install that predates the in-app update poller (WI-4404)
# — or whose call site never runs for any other reason — produces ZERO log
# lines about updates, ever. That is structurally indistinguishable from "the
# poller checked and you are current": absence of signal reads as healthy
# forever, and the running build has no way to say otherwise about ITSELF.
# The only place that CAN catch this is something that runs BEFORE the stale
# binary's own (possibly-nonexistent) code does — an external launcher.
#
# This is that external check. It is deliberately dependency-free (no network
# call, no manifest fetch) so it can run unconditionally on every boot without
# adding a network dependency or a hang risk to server startup — it just
# refuses to let a badly-stale binary start SILENTLY. It compares the target
# binary's mtime against a threshold and prints a loud, impossible-to-miss
# warning (to stderr, so it lands in whatever log the caller redirects to) when
# the binary looks old. It never blocks startup by default (see
# PAPERCUSP_SERVER_STALENESS_STRICT below) — this install pattern has no
# package-manager update path (WI-4404's own bug report: no dpkg receipt, no
# installer in this repo), so a hard refusal would just leave the owner locked
# out of their own tray icon with no recovery path except editing this script.
#
# CAVEAT: binary mtime is a heuristic, not a cryptographic build date — a `cp`
# without `-p` (or any archive tool that doesn't preserve timestamps) resets
# it to copy time and this check would then see a fresh mtime for old content.
# It is nonetheless a real, external, code-independent signal that catches the
# exact failure this item reported (a `cp -a`-style hand-placed install, whose
# mtime DOES reflect the original build time) — see the dev-box install this
# script now guards (papercusp-server-launch.sh) for a live example. A future
# install helper that writes a `BUILD_INFO` marker file at install time could
# upgrade this to an exact check without changing the external-to-the-binary
# principle; this script checks for one first and only falls back to mtime.
#
# USAGE
#   check-hand-placed-server-staleness.sh <path-to-installed-binary> [max-age-days]
#
# Exit code is always 0 unless PAPERCUSP_SERVER_STALENESS_STRICT=1 is set, in
# which case a stale binary exits 1 (for a caller that wants a hard refusal).
set -u

bin_path="${1:?usage: check-hand-placed-server-staleness.sh <path-to-installed-binary> [max-age-days]}"
max_age_days="${2:-14}"

if [ ! -e "$bin_path" ]; then
  echo "[staleness-check] WARNING: '$bin_path' does not exist — cannot check for staleness" >&2
  exit 0
fi

install_dir="$(dirname "$bin_path")"
build_info="$install_dir/BUILD_INFO.json"

# Prefer an explicit build-info marker (an install helper's own honest
# timestamp) over mtime, when one exists.
if [ -f "$build_info" ]; then
  source_desc="BUILD_INFO.json"
  built_epoch="$(grep -o '"builtAtEpochSecs"[[:space:]]*:[[:space:]]*[0-9]*' "$build_info" 2>/dev/null | grep -o '[0-9]*$')"
fi
if [ -z "${built_epoch:-}" ]; then
  source_desc="binary mtime (no BUILD_INFO.json — see this script's CAVEAT)"
  built_epoch="$(stat -c '%Y' "$bin_path" 2>/dev/null || stat -f '%m' "$bin_path" 2>/dev/null)"
fi

if [ -z "${built_epoch:-}" ]; then
  echo "[staleness-check] WARNING: could not determine an install date for '$bin_path' — cannot check for staleness" >&2
  exit 0
fi

now_epoch="$(date +%s)"
age_days=$(( (now_epoch - built_epoch) / 86400 ))

if [ "$age_days" -ge "$max_age_days" ]; then
  built_human="$(date -d "@$built_epoch" 2>/dev/null || date -r "$built_epoch" 2>/dev/null)"
  cat >&2 <<EOF
[staleness-check] ================================================================
[staleness-check] WARNING: '$bin_path' is $age_days days old (> ${max_age_days}d threshold),
[staleness-check] per $source_desc — built $built_human.
[staleness-check]
[staleness-check] This install has NO package-manager update path (it is hand-placed —
[staleness-check] see EI-13939) and its in-app update poller, if this build even HAS
[staleness-check] one, only checks itself every few hours from inside a process that
[staleness-check] is about to start. A build old enough may predate the poller entirely,
[staleness-check] in which case it will NEVER self-report as stale — only THIS external
[staleness-check] check can catch that. If this looks unexpectedly old, replace the
[staleness-check] install tree with a fresh build/package before relying on it.
[staleness-check] ================================================================
EOF
  if [ "${PAPERCUSP_SERVER_STALENESS_STRICT:-0}" = "1" ]; then
    echo "[staleness-check] PAPERCUSP_SERVER_STALENESS_STRICT=1 — refusing to launch." >&2
    exit 1
  fi
fi

exit 0
