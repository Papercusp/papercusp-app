#!/usr/bin/env bash
#
# restore-release-page.sh — undo bin/hold-release-page.sh: put the REAL releases
# page (downloads, changelog, instructions, plan links) back on the beta link.
#
#   Usage:  bin/restore-release-page.sh
#           DRY_RUN=1 bin/restore-release-page.sh   # generate + gate, upload nothing
#
# This is a full re-render from the release registry in Postgres, NOT an undo of
# an edit — the page is a projection of that table, so what comes back is the
# current truth about every release, not a stale copy of whatever was up before
# the hold.
#
# If you ever need the EXACT bytes that were live before the hold instead, a
# snapshot was taken at hold time and kept outside the repo:
#   ~/.papercusp/artifacts/wi-6580/index.html.live-before-holding
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_ROOT="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_ROOT/.." && pwd)"

echo "==> restoring the real releases page"
npx tsx "${REPO_ROOT}/apps/operator/lib/release/record-release-cli.ts" --restore-page

echo
echo "==> publishing"
exec "${HERE}/publish-release-history.sh"
