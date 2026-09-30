#!/usr/bin/env bash
#
# hold-release-page.sh — put the beta releases page behind a holding page that
# says "NEXT UPDATE COMING SOON", keeping the demo video, the Discord link and a
# contact mailto. [owner 2026-07-28]
#
#   Usage:  bin/hold-release-page.sh
#           DRY_RUN=1 bin/hold-release-page.sh    # generate + gate, upload nothing
#
#   Undo:   bin/restore-release-page.sh           # puts the real page back
#
# WHAT IT CHANGES: index.html, and nothing else.
#   - history.json stays published, so the in-app Update Center keeps showing
#     update history to everyone who already installed the app.
#   - plans/*.html and every installer object stay exactly where they are, so a
#     direct download link a tester already has keeps working.
#   - The hold is RECORDED (~/.papercusp/release-page-held), so a later
#     `--regenerate` — including one during a release cut — re-renders the
#     holding page instead of silently restoring the site.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_ROOT="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_ROOT/.." && pwd)"

echo "==> holding the releases page (index.html only)"
npx tsx "${REPO_ROOT}/apps/operator/lib/release/record-release-cli.ts" --hold-page

echo
echo "==> publishing"
exec "${HERE}/publish-release-history.sh"
