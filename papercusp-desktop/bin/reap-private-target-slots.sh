#!/usr/bin/env bash
# reap-private-target-slots.sh — reclaim dead private overflow Cargo roots now.
#
# Every desktop launch already runs this reaper through bin/lib/claim-target-dir.sh
# (WI-10004764). This entrypoint runs the same reaper on demand, without claiming
# a target slot, and deletes in the foreground so the space is free on return.
#
#   bin/reap-private-target-slots.sh            reap
#   bin/reap-private-target-slots.sh --dry-run  list what would be reaped
#
# The safety rules (claimant lock, live references, grace period, release
# retention leases) are the reaper's own; see claim-target-dir.sh.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
  --dry-run) export PAPERCUSP_DESKTOP_PRIVATE_SLOT_REAP_DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

export PAPERCUSP_DESKTOP_REAP_ONLY=1
export PAPERCUSP_DESKTOP_PRIVATE_SLOT_REAP_SYNC="${PAPERCUSP_DESKTOP_PRIVATE_SLOT_REAP_SYNC:-1}"
ROOT="${ROOT:-$(cd "$HERE/.." && pwd)}"
# shellcheck source=lib/claim-target-dir.sh
. "$HERE/lib/claim-target-dir.sh"

shared="$(__pc_cargo_target_root)"
mkdir -p "$__pc_slot_lockdir"
__pc_reap_private_target_slots "$shared"
