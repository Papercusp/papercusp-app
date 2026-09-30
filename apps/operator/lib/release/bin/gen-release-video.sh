#!/usr/bin/env bash
# Regenerate release-video.ts from the live site's demo-video element.
#
# Sibling of gen-release-bg.sh. papercusp.com's src/page.html is the SOURCE OF
# TRUTH for both the video URL and its poster frame; this script lifts them so
# the release page cannot drift from the homepage by retyping.
#
#   bin/gen-release-video.sh [<path-to-public-site-checkout>]
#
# Default checkout: ~/.papercusp-workspaces/clones/papercusp-public-site
# gen-release-bg.sh uses the same default checkout.
#
# The poster is INLINED as a data URI (70 KB) so the page stays self-contained —
# the homepage serves it relatively, which would 404 under the release bucket's
# secret path. The 32 MB video is NOT inlined: it stays the absolute
# clips.papercusp.com URL the homepage already plays from.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$(cd "$HERE/.." && pwd)/release-video.ts"
SITE="${1:-$HOME/.papercusp-workspaces/clones/papercusp-public-site}"
PAGE="$SITE/src/page.html"
POSTER="$SITE/src/video/poster-d65.jpg"

[[ -f "$PAGE"   ]] || { echo "ERROR: site page not found: $PAGE" >&2; exit 1; }
[[ -f "$POSTER" ]] || { echo "ERROR: poster not found: $POSTER" >&2; exit 1; }

# Lift the src + aria-label straight out of the homepage's #demoVid element, so
# a swapped cut is picked up by re-running this rather than by hand-editing.
VIDEO_LINE="$(grep -m1 'id="demoVid"' "$PAGE")"
SRC="$(printf '%s' "$VIDEO_LINE" | grep -oP '(?<=\ssrc=")[^"]+')"
LABEL="$(printf '%s' "$VIDEO_LINE" | grep -oP '(?<=aria-label=")[^"]+')"
[[ -n "$SRC"   ]] || { echo "ERROR: could not read src= from #demoVid" >&2; exit 1; }
[[ -n "$LABEL" ]] || { echo "ERROR: could not read aria-label= from #demoVid" >&2; exit 1; }
case "$SRC" in
  https://*) ;;
  *) echo "ERROR: #demoVid src is not absolute ($SRC) — the release page cannot use a site-relative video." >&2; exit 1 ;;
esac

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

{
  cat <<'HDR'
/**
 * ⚠ GENERATED FILE — do not edit by hand. Run bin/gen-release-video.sh.
 *
 * The demo video from the papercusp.com homepage, mirrored onto the beta
 * release-history page [owner 2026-07-27: "add the same video that is on our
 * homepage to the top"].
 *
 * Sibling of release-bg.ts, and lifted the same way: the site is the source of
 * truth (src/page.html, the `#demoVid` element) and this file is REGENERATED
 * from it rather than retyped. If the homepage swaps the cut, re-run the
 * script instead of editing the constants below.
 *
 * ── Why the video is hotlinked but the poster is inlined ────────────────────
 * They are not the same decision.
 *
 * The VIDEO stays an absolute clips.papercusp.com URL — the one the homepage
 * uses. It is ~32 MB: copying it under the release bucket's secret path would
 * add 32 MB to every publish and give us a second copy to keep in sync with
 * the homepage, for no gain — it is already on a Cloudflare CDN. If that host
 * is ever unreachable the page is unharmed: the poster still paints, and every
 * download link and instruction on the page still works.
 *
 * The POSTER is inlined because it is ~70 KB and it is what the reader sees
 * BEFORE the video plays — the one frame that must never be a broken image
 * box, and the ONLY thing they see if autoplay is blocked (data saver, reduced
 * motion, some mobile browsers). The homepage serves it relatively
 * (`video/poster-d65.jpg`), which would 404 under the release bucket's secret
 * path, so it had to become either a second uploaded asset or these bytes.
 * Same reasoning as ROBOT_BG_DATA_URI: the page stays self-contained.
 *
 * ⚠ The release page ships `<meta name="referrer" content="no-referrer">`, and
 * that is what keeps the secret path out of the Referer header on the video
 * request to clips.papercusp.com. Do not drop that meta tag.
 */

HDR
  printf '/** The demo cut, on the same CDN the homepage plays it from. */\n'
  printf "export const DEMO_VIDEO_SRC = '%s';\n\n" "$SRC"
  printf "/** The homepage's own aria-label for the video, kept verbatim. */\n"
  printf "export const DEMO_VIDEO_LABEL =\n  '%s';\n\n" "$LABEL"
  printf '/** src/video/poster-d65.jpg, inlined — the frame shown before play. */\n'
  printf "export const DEMO_VIDEO_POSTER_DATA_URI =\n  'data:image/jpeg;base64,%s';\n" "$(base64 -w0 "$POSTER")"
} > "$TMP"

mv "$TMP" "$DEST"
trap - EXIT
echo "wrote $DEST"
echo "  src    = $SRC"
echo "  label  = ${LABEL:0:60}..."
echo "  poster = $POSTER ($(wc -c < "$POSTER") bytes)"
