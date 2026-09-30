#!/usr/bin/env bash
# cleanup-run.sh <WORK> — EI-1739: SAFELY clean up ONE two-instance rig run's
# leftovers (kill exactly that run's processes + rm exactly that run's $WORK).
#
# Use this for a crashed / timed-out / leftover run INSTEAD of a broad
# `rm -rf /tmp/<rig>.*` or `pkill -f <rig-name>` — those match EVERY run and crash
# OTHER agents' LIVE runs mid-flight (the EI-1739 collision). This refuses any path
# that isn't a single per-run rig $WORK dir, so it can never touch a sibling.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/federation-asserts.sh
source "$DIR/lib/federation-asserts.sh"

if [ "$#" -ne 1 ]; then
  echo "usage: cleanup-run.sh <WORK>     e.g. cleanup-run.sh /tmp/hive-fromrepo-smoke.AbC123" >&2
  echo "  to reap ALL dead runs safely:  reap-orphans.sh" >&2
  exit 2
fi

fed_cleanup_run "$1"
