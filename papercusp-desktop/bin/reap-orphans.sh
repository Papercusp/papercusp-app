#!/usr/bin/env bash
# reap-orphans.sh [--dry-run] [--min-age-min N] — EI-1739: reap leftover two-instance
# rig runs whose processes are GONE (crashed / killed / timed out — the EXIT trap
# never fired). It NEVER touches a live sibling: a run with ANY process still
# referencing its $WORK, or one younger than N minutes (default 5, the startup
# window), is skipped. Safe to run anytime, concurrently, by any agent.
#
# Use this instead of `rm -rf /tmp/<rig>.*` / `pkill -f <rig-name>`, which match
# every run and crash concurrent live runs.
#
#   reap-orphans.sh            # reap all dead runs
#   reap-orphans.sh --dry-run  # show what WOULD be reaped, touch nothing
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/federation-asserts.sh
source "$DIR/lib/federation-asserts.sh"

fed_reap_orphans "$@"
