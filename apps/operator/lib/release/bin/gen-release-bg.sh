#!/usr/bin/env bash
# Regenerate release-bg.ts from the live site's static background SVG.
# The release-history page inlines this as a base64 data URI so it stays
# self-contained (no external asset under the secret R2 path). Re-run this
# whenever papercusp.com's src/bg-flow-static.svg changes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$(cd "$HERE/.." && pwd)/release-bg.ts"
SVG="${1:-$HOME/.papercusp-workspaces/clones/papercusp-public-site/src/bg-flow-static.svg}"
[[ -f "$SVG" ]] || { echo "ERROR: background SVG not found: $SVG" >&2; exit 1; }

{
  printf '%s\n' '/**'
  printf '%s\n' ' * The static "robot" background from papercusp.com — the flow-field the site'"'"'s'
  printf '%s\n' ' * agents ride, frozen (no video/animation). Inlined as a base64 data URI so the'
  printf '%s\n' ' * release page stays fully self-contained: no second request, no external asset'
  printf '%s\n' ' * under the secret path, and it renders even offline. Source of truth is the live'
  printf '%s\n' ' * site'"'"'s src/bg-flow-static.svg; regenerate with bin/gen-release-bg.sh if it changes.'
  printf '%s\n' ' * The checkout default is ~/.papercusp-workspaces/clones/papercusp-public-site.'
  printf '%s\n' ' */'
  printf 'export const ROBOT_BG_DATA_URI =\n'
  printf "  'data:image/svg+xml;base64,%s';\n" "$(base64 -w0 "$SVG")"
} > "$DEST"
echo "wrote $DEST from $SVG"
