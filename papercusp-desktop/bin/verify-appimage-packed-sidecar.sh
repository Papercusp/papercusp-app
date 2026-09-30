#!/usr/bin/env bash
# Compatibility entrypoint for the old "packed sidecar" AppImage check.
#
# Papercusp GUI is intentionally thin: it carries the shared SPA and attaches to
# the separately installed Papercusp Server. A GUI AppImage containing
# serve.mjs, bundled Node, database assets, or another Server runtime is a
# distribution-contract violation, not something this command should boot.
#
# Keep the historical filename because operators may still invoke it from old
# runbooks, but route the check through the canonical, archive-aware census. The
# census owns AppImage extraction, the installed-resource-root lookup, size
# budgets, the GUI allowlist, and forbidden Server-resource detection.
#
#   bash bin/verify-appimage-packed-sidecar.sh <path-to-GUI-AppImage>
#
# Exits 0 when the artifact satisfies the thin-GUI Linux contract, 1 when the
# expanded payload violates it, and 2 when the artifact cannot be inspected.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { echo "AUDIT ERROR: $*" >&2; exit 2; }

APPIMAGE="${1:-}"
[[ -n "$APPIMAGE" ]] || fail "usage: $0 <path-to-GUI-AppImage>"
[[ -f "$APPIMAGE" ]] || fail "no AppImage at $APPIMAGE"
APPIMAGE="$(cd "$(dirname "$APPIMAGE")" && pwd)/$(basename "$APPIMAGE")"

# The AppImage runtime implements --appimage-extract. Real release artifacts
# are executable; retain the legacy entrypoint's harmless chmod repair so a
# downloaded artifact that lost its mode remains inspectable.
[[ -x "$APPIMAGE" ]] \
  || chmod +x "$APPIMAGE" 2>/dev/null \
  || fail "AppImage is not executable and could not chmod +x: $APPIMAGE"

exec python3 "$HERE/audit-release-bundle.py" \
  --distribution-census gui linux "$APPIMAGE"
