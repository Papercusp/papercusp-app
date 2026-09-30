#!/usr/bin/env bash
# Mirror @excalidraw/excalidraw's runtime asset tree into
# apps/operator/public/excalidraw/ so the brainstorm canvas loads its fonts from
# LOCALHOST instead of esm.sh.
#
# WHY THIS EXISTS (cdn-egress-fixes-2026-08-02 P-004). Excalidraw resolves its
# runtime assets (fonts, locales) through a candidate list built in
# dist/prod/chunk-K2UTITRG.js:
#
#     if (typeof window.EXCALIDRAW_ASSET_PATH === "string") { ...push local... }
#     return r.push(new URL(n, jn.ASSETS_FALLBACK_URL)), r;
#
# where ASSETS_FALLBACK_URL is `https://esm.sh/@excalidraw/excalidraw@<ver>/dist/prod/`.
# We never set EXCALIDRAW_ASSET_PATH, so the ONLY candidate was esm.sh and the
# canvas fetched ~14MB of fonts across the internet.
#
# READ THIS BEFORE TRIMMING THE MIRROR. The fallback is pushed UNCONDITIONALLY —
# it is appended even when EXCALIDRAW_ASSET_PATH is set. So an INCOMPLETE mirror
# does not fail loudly the way vditor's or monaco's would: the local candidate
# simply misses and excalidraw silently falls through to esm.sh for that asset.
# The app looks fixed, the fonts still render, and the egress continues. That is
# strictly worse than a 404, because nothing surfaces it — which is why this
# copies dist/prod wholesale (~18MB, 14MB of it fonts) and why P-004's
# acceptance criterion is a RUNTIME check, not a file listing.
#
# Run after `npm install` (chained from apps/operator's postinstall) and again
# from operator-vite's `prebuild`. Idempotent: a version stamp makes a no-op
# re-run essentially free.
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/mirror-tree.sh
. scripts/lib/mirror-tree.sh

# Same require.resolve('pkg/package.json') trap as the sibling setup scripts —
# probe paths directly instead of asking node to resolve them.
SRC=""
for cand in \
  "$(pwd)/node_modules/@excalidraw/excalidraw/dist/prod" \
  "$(pwd)/../../node_modules/@excalidraw/excalidraw/dist/prod"; do
  if [ -d "$cand" ]; then
    SRC="$cand"
    break
  fi
done

if [ -z "$SRC" ]; then
  echo "ERR: can't find @excalidraw/excalidraw/dist/prod; install it first" >&2
  exit 1
fi

VERSION="$(node -p "require('$SRC/../../package.json').version" 2>/dev/null || echo unknown)"
DEST="public/excalidraw"
STAMP="public/excalidraw/.version"

# Skip the copy when the mirror already matches the installed excalidraw. The
# stamp is written LAST, so an interrupted copy leaves it stale/absent and the
# next run redoes the work rather than trusting a half-populated tree — which
# here would mean silent esm.sh fallback rather than a visible failure.
#
# A matching stamp is NOT sufficient on its own (WI-10004074): the mirror must
# also hold exactly the package's file set, or chunks from an older excalidraw
# build ride along into every release SPA. The stamp lives INSIDE the mirror,
# so it is excluded from the comparison. See scripts/lib/mirror-tree.sh.
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$VERSION" ] && [ -d "$DEST/fonts" ]; then
  if mirror_matches "$SRC" "$DEST" .version; then
    echo "excalidraw-runtime: already current (v$VERSION) — skipping copy"
    exit 0
  fi
  echo "excalidraw-runtime: v$VERSION stamp is current but $DEST/ file set differs from @excalidraw/excalidraw — re-copying"
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/

if [ ! -d "$DEST/fonts" ]; then
  echo "ERR: excalidraw mirror is missing fonts/ after copy" >&2
  exit 1
fi

echo "$VERSION" > "$STAMP"
echo "excalidraw-runtime: mirrored @excalidraw/excalidraw v$VERSION into $DEST/ ($(du -sh "$DEST" | cut -f1))"
