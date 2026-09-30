#!/usr/bin/env bash
# Mirror vditor's runtime asset tree into apps/operator/public/vditor/ so the
# markdown surfaces load it from LOCALHOST instead of the public internet.
#
# WHY THIS EXISTS (WI-7088). Vditor resolves its runtime assets from an
# `options.cdn` base, defaulting to `https://unpkg.com/vditor@<version>`. We
# never set that option, so EVERY cold markdown render fetched ~4.9 MB across
# the internet before it could paint:
#
#     js/lute/lute.min.js                 3907 KB   (Go->WASM blob: slow to
#     js/highlight.js/highlight.min.js    1025 KB    fetch AND slow to parse)
#     js/icons/ant.js                       42 KB
#     js/highlight.js/third-languages.js    21 KB
#     js/i18n/en_US.js                       2 KB
#
# That is the "opening a plan takes several seconds" report — and it also meant
# markdown rendering silently required internet connectivity. Every one of those
# files already ships inside node_modules/vditor; nothing was ever missing but a
# local copy and a `cdn` pointing at it.
#
# WHY THE WHOLE dist/ AND NOT JUST THE FIVE MEASURED FILES. Those five are what
# one plan happened to request. Vditor lazily pulls mermaid / katex / echarts /
# graphviz / plantuml the moment a document contains one of those blocks, and
# our plans do contain mermaid. A partial mirror would turn "slow" into "404 —
# renders nothing" for exactly those documents: strictly worse than the bug, and
# intermittent enough to look fixed. Copying the tree wholesale (~23 MB into a
# public/ that is already ~491 MB, gitignored, generated) removes the whole
# class instead of the instance.
#
# Run after `npm install` (chained from apps/operator's postinstall hook next to
# setup-wake-runtime / setup-vad-runtime) and again from operator-vite's
# `prebuild`, so a build whose install was skipped still gets the assets.
# Idempotent: a version stamp makes a no-op re-run essentially free.
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/mirror-tree.sh
. scripts/lib/mirror-tree.sh

# Same require.resolve('pkg/package.json') trap as the sibling setup scripts —
# probe paths directly instead of asking node to resolve them.
SRC=""
for cand in \
  "$(pwd)/node_modules/vditor/dist" \
  "$(pwd)/../../node_modules/vditor/dist"; do
  if [ -d "$cand" ]; then
    SRC="$cand"
    break
  fi
done

if [ -z "$SRC" ]; then
  echo "ERR: can't find vditor/dist; install vditor first" >&2
  exit 1
fi

VERSION="$(node -p "require('$SRC/../package.json').version" 2>/dev/null || echo unknown)"
DEST="public/vditor/dist"
STAMP="public/vditor/.version"
LOCAL_DEST="public/vditor-local"
LOCAL_STAMP="$LOCAL_DEST/.versions"
LOCAL_VERSIONS=$'d3=6.7.0\nmarkmap-view=0.14.3\nwebfontloader=1.6.28'

# Vditor's markmap bundle injects these three scripts itself instead of routing
# them through its `options.cdn` base. Keep the browser copies beside the
# mirror, under a stable root that the patched loader can address directly.
# Resolve each package from the workspace first, but prefer the operator-local
# copy when npm kept the exact workspace version there (d3 is also used by
# other workspaces at a different major version).
resolve_asset() {
  local package_name="$1"
  local relative_asset="$2"
  local expected_version="$3"
  local package_root actual_version

  for package_root in \
    "$(pwd)/node_modules/$package_name" \
    "$(pwd)/../../node_modules/$package_name"; do
    if [ ! -f "$package_root/$relative_asset" ]; then
      continue
    fi
    actual_version="$(node -p "require(process.argv[1]).version" "$package_root/package.json" 2>/dev/null || true)"
    if [ "$actual_version" = "$expected_version" ]; then
      printf '%s\n' "$package_root/$relative_asset"
      return 0
    fi
  done

  echo "ERR: can't find $package_name@$expected_version/$relative_asset; install the declared runtime dependency first" >&2
  exit 1
}

D3_ASSET="$(resolve_asset d3 dist/d3.min.js 6.7.0)"
MARKMAP_VIEW_ASSET="$(resolve_asset markmap-view dist/index.min.js 0.14.3)"
WEBFONTLOADER_ASSET="$(resolve_asset webfontloader webfontloader.js 1.6.28)"
MARKMAP="$DEST/js/markmap/markmap.min.js"

# The stamp is written LAST, so a failed copy or rewrite cannot make the next
# run trust a half-populated mirror. The local assets and URL rewrite are part
# of the stamp contract too; this deliberately repairs an existing v3.11.2
# mirror produced before WI-7118 instead of taking the old early-exit path.
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$VERSION" ] \
  && [ -f "$DEST/js/lute/lute.min.js" ] \
  && [ -f "$MARKMAP" ] \
  && [ -f "$LOCAL_STAMP" ] \
  && [ "$(cat "$LOCAL_STAMP")" = "$LOCAL_VERSIONS" ] \
  && [ -f "$LOCAL_DEST/d3.min.js" ] \
  && [ -f "$LOCAL_DEST/markmap-view.min.js" ] \
  && [ -f "$LOCAL_DEST/webfontloader.js" ] \
  && ! grep -qF 'https://cdn.jsdelivr.net/npm/d3@6.7.0' "$MARKMAP" \
  && ! grep -qF 'https://cdn.jsdelivr.net/npm/markmap-view@0.14.3' "$MARKMAP" \
  && ! grep -qF 'https://cdn.jsdelivr.net/npm/webfontloader@1.6.28/webfontloader.js' "$MARKMAP"; then
  # A matching stamp is NOT sufficient on its own (WI-10004074): both mirrors
  # must hold exactly their expected file sets, or files from an older build ride
  # along into every release SPA. See scripts/lib/mirror-tree.sh.
  if mirror_matches "$SRC" "$DEST" \
    && [ "$(mirror_file_set "$LOCAL_DEST")" = "$(printf '%s\n' ./.versions ./d3.min.js ./markmap-view.min.js ./webfontloader.js | LC_ALL=C sort)" ]; then
    echo "vditor-runtime: already current (v$VERSION) — skipping copy"
    exit 0
  fi
  echo "vditor-runtime: v$VERSION stamp is current but a mirror's file set has drifted — re-copying"
fi

rm -rf "$DEST" "$LOCAL_DEST"
mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/

# Sanity-check the one asset every single render needs. A silently-empty mirror
# would fall back to nothing (a 404, not the old CDN), so fail loudly here rather
# than at paint time in the desktop app.
if [ ! -f "$DEST/js/lute/lute.min.js" ]; then
  echo "ERR: vditor mirror is missing js/lute/lute.min.js after copy" >&2
  exit 1
fi

# These URLs are inside Vditor's prebuilt markmap loader, not in our app code,
# so setting VDITOR_CDN cannot redirect them. The loader injects them as
# <script src> tags; replace only the three exact executable URLs with local
# browser assets. Other source-attribution URLs in vendored files stay intact.
if [ ! -f "$MARKMAP" ]; then
  echo "ERR: vditor mirror is missing js/markmap/markmap.min.js after copy" >&2
  exit 1
fi

mkdir -p "$LOCAL_DEST"
cp "$D3_ASSET" "$LOCAL_DEST/d3.min.js"
cp "$MARKMAP_VIEW_ASSET" "$LOCAL_DEST/markmap-view.min.js"
cp "$WEBFONTLOADER_ASSET" "$LOCAL_DEST/webfontloader.js"

sed -i \
  -e 's|https://cdn.jsdelivr.net/npm/d3@6.7.0|/vditor-local/d3.min.js|g' \
  -e 's|https://cdn.jsdelivr.net/npm/markmap-view@0.14.3|/vditor-local/markmap-view.min.js|g' \
  -e 's|https://cdn.jsdelivr.net/npm/webfontloader@1.6.28/webfontloader.js|/vditor-local/webfontloader.js|g' \
  "$MARKMAP"

if grep -qF 'https://cdn.jsdelivr.net/npm/d3@6.7.0' "$MARKMAP" \
  || grep -qF 'https://cdn.jsdelivr.net/npm/markmap-view@0.14.3' "$MARKMAP" \
  || grep -qF 'https://cdn.jsdelivr.net/npm/webfontloader@1.6.28/webfontloader.js' "$MARKMAP"; then
  echo "ERR: markmap loader still contains a live jsDelivr URL after rewrite" >&2
  exit 1
fi

printf '%s\n' "$LOCAL_VERSIONS" > "$LOCAL_STAMP"

echo "$VERSION" > "$STAMP"
echo "vditor-runtime: mirrored vditor v$VERSION and local markmap assets into $DEST/ ($(du -sh "$DEST" | cut -f1))"
