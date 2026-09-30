#!/usr/bin/env bash
# audit-bundle.sh — compatibility entry point for THE release privacy gate.
#
# Usage:
#   bin/audit-bundle.sh <artifact-or-dir> [<artifact-or-dir> ...]
#
# Every argument is scanned by bin/audit-release-bundle.py — the ONE release gate
# (credentials incl. PostHog phx_/phc_ keys, build-box identity, forbidden paths):
#   • a finished installer/archive (.deb .dmg .msi .exe .AppImage .zip .tar.gz …)
#     → `--scan-artifact` (expands it and fails closed if it cannot be read)
#   • a directory (an unpacked .app, a staged sidecar)            → `--scan-dir`
# Exit: 0 clean · 1 a finding · 2 could not check (e.g. no owner-name literal —
# export PAPERCUSP_RELEASE_OWNER_NAME — or an unreadable container).
#
# WHY THIS IS A WRAPPER (WI-10003577, 2026-09-28). This script used to be a SEPARATE
# PostHog-key scanner with its OWN allowlist: a single PUBLIC_PROJECT_KEY. The
# canonical gate absorbed its phx_/phc_ rules in 2026-07 and grew the curated
# BENIGN_ERE list (our public key + third-party vendors' own anon keys), but this
# copy was never retired. The two lists drifted, and the 0.0.22 mac cut went red on
# lost-pixel's vendor key — a package the Server sidecar ships ON PURPOSE (design
# comparison) and that the canonical gate already classifies as benign. Two scanners
# with two allowlists is the defect; a second copy of the list here would reintroduce
# it. Keep this file a pure delegate: no needles, no allowlist.
# test/audit-bundle-delegates.test.js pins that behaviourally.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="$HERE/audit-release-bundle.py"

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <artifact-or-dir> [<artifact-or-dir>...]" >&2
  exit 2
fi

artifacts=()
dirs=()
for arg in "$@"; do
  if [[ -d "$arg" ]]; then
    dirs+=("$arg")
  else
    # A missing path goes to --scan-artifact too: it refuses (exit 2) rather than
    # reporting CLEAN on a file nobody read.
    artifacts+=("$arg")
  fi
done

rc=0
if [[ ${#artifacts[@]} -gt 0 ]]; then
  python3 "$AUDIT" --scan-artifact "${artifacts[@]}" || rc=$?
fi
if [[ ${#dirs[@]} -gt 0 ]]; then
  dir_rc=0
  python3 "$AUDIT" --scan-dir "${dirs[@]}" || dir_rc=$?
  # A finding (1) outranks could-not-check (2): report the leak.
  if [[ $dir_rc -eq 1 || $rc -eq 0 ]]; then
    [[ $dir_rc -ne 0 ]] && rc=$dir_rc
  fi
fi
exit "$rc"
