#!/usr/bin/env bash
# Vendor Porcupine's wake-word model into apps/operator/public/porcupine/ so
# wake-word detection loads it from LOCALHOST instead of raw.githubusercontent.com.
#
# WHY THIS EXISTS (cdn-egress-fixes-2026-08-02 P-003). Unlike the other mirrors
# next door, this one is OUR OWN bug, not a library default:
# packages/operator-core/lib/voice-engines/porcupine.ts passed
#
#     publicPath: 'https://raw.githubusercontent.com/Picovoice/porcupine/master/lib/common/porcupine_params.pv'
#
# straight to PorcupineWorker.create. Three problems in one line: it fetches ~961KB
# from the public internet at runtime; raw.githubusercontent.com is a SOURCE HOST
# with rate limits and no CDN/availability guarantee, not somewhere to serve a
# production asset from; and `master` is a MOVING ref, so the model could change
# under us — silently, and differently for each user, depending on when they
# happened to load it.
#
# WHY THIS CANNOT COPY FROM node_modules like its siblings: Picovoice does not
# ship the model in `@picovoice/porcupine-web` (that package's 3.6MB dist is the
# WASM engine only). The model is distributed separately, so this script fetches
# it ONCE AT SETUP TIME — a build-time dependency, never a runtime one, which is
# the whole point.
#
# PINNING. Fetched by immutable COMMIT SHA, not by `master` and not by tag (a tag
# can be moved). Verified 2026-08-02: the pinned commit, the `v4.0` tag and
# `master` all serve byte-identical content (sha256 0b0685f1…), so pinning is a
# zero-behaviour-change fix rather than a model swap. v4.0 is also the tag that
# matches the installed @picovoice/porcupine-web 4.0.0 — note the `v3.0` tag
# serves a DIFFERENT model of exactly the same byte length, so size is not a
# usable identity check here. The checksum is.
set -euo pipefail

cd "$(dirname "$0")/.."

# Immutable commit for lib/common/porcupine_params.pv (authored 2025-12-11).
PORCUPINE_REF="97b6ee6f353fc27132ab126497033eea91df416b"
PORCUPINE_SHA256="0b0685f170c5e73259fb45c32f481b100cdffb8ef6a4d87be871519c8d17df36"
URL="https://raw.githubusercontent.com/Picovoice/porcupine/${PORCUPINE_REF}/lib/common/porcupine_params.pv"

DEST_DIR="public/porcupine"
DEST="$DEST_DIR/porcupine_params.pv"

verify() {
  [ -f "$1" ] && [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$PORCUPINE_SHA256" ]
}

if verify "$DEST"; then
  echo "porcupine-runtime: already current (sha256 verified) — skipping download"
  exit 0
fi

mkdir -p "$DEST_DIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if curl -fsSL --max-time 120 "$URL" -o "$TMP" 2>/dev/null && verify "$TMP"; then
  mv "$TMP" "$DEST"
  # mktemp creates 0600 and mv preserves it; a static asset the webview fetches
  # must be world-readable like every other file under public/.
  chmod 644 "$DEST"
  trap - EXIT
  echo "porcupine-runtime: fetched wake-word model into $DEST ($(du -h "$DEST" | cut -f1))"
  exit 0
fi

# The download failed, or returned something that is not the model we pinned.
# Degrade rather than break an install over a network blip — but ONLY when a
# previously-verified copy is already on disk. With no copy at all, wake-word
# would 404 at runtime, and a silent "install succeeded" is exactly how that
# reaches a user; so that case fails loudly here instead.
if [ -f "$DEST" ]; then
  echo "WARN: porcupine-runtime: could not refresh the model (network or checksum) — keeping the existing copy at $DEST" >&2
  exit 0
fi

echo "ERR: porcupine-runtime: failed to fetch the wake-word model and no local copy exists." >&2
echo "     URL: $URL" >&2
echo "     Wake-word detection will 404 at runtime until this succeeds." >&2
exit 1
