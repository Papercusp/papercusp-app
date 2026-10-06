#!/usr/bin/env bash
# Copy @ricky0123/vad-web's Silero ONNX models + worklet into
# apps/operator/public/ so the browser can load them at runtime.
#
# `MicVAD.new()` defaults to fetching `./silero_vad_v5.onnx` and
# `./vad.worklet.bundle.min.js` from the document URL. Without these
# files in public/, the always-on whisper capture loads an empty
# VAD which never fires onSpeechEnd, so no transcription POST is
# ever made. Same regression bites the "Test wake word" button.
#
# Run after `npm install` (chained from the postinstall hook in
# package.json next to setup-wake-runtime).
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=lib/mirror-tree.sh
source scripts/lib/mirror-tree.sh

# Same require.resolve('pkg/package.json') trap as setup-wake-runtime.sh —
# probe paths directly instead.
SRC=""
for cand in \
  "$(pwd)/node_modules/@ricky0123/vad-web/dist" \
  "$(pwd)/../../node_modules/@ricky0123/vad-web/dist"; do
  if [ -d "$cand" ]; then
    SRC="$cand"
    break
  fi
done

if [ -z "$SRC" ]; then
  echo "ERR: can't find @ricky0123/vad-web/dist; install @ricky0123/vad-web first" >&2
  exit 1
fi

DEST="public"
mkdir -p "$DEST"
# Unlink before copying, never plain `cp`/`cp -f` (WI-10004321): plain cp rewrites an
# existing destination IN PLACE (O_TRUNC on the same inode). Release trees used
# to receive these gitignored files as HARD LINKS of this tree's copies
# (setup-release-checkout.sh step 3b, `cp -al`), so an in-place rewrite here
# silently changed the published and in-flight release trees too, and a release
# tree's own postinstall rewrote this one. Unlinking first gives every write a
# fresh inode, so a rewrite only ever changes the tree that ran it.
for f in silero_vad_v5.onnx silero_vad_legacy.onnx vad.worklet.bundle.min.js; do
  if [ -f "$SRC/$f" ]; then
    mirror_copy_unlinked "$SRC/$f" "$DEST/$f"
  fi
done

# vad-web / onnxruntime-web may resolve its module+wasm pair from either the
# configured base path or the public root depending on browser/runtime backend.
# Mirror ORT assets into BOTH locations:
#   - public/vad-runtime/  (explicit onnxWASMBasePath in stt-voicemode.ts)
#   - public/              (fallback module-script resolution observed in Tauri WebKit)
ORT_DIR=""
for cand in "$(pwd)/../../node_modules/onnxruntime-web/dist" "$(pwd)/node_modules/onnxruntime-web/dist"; do
  [ -d "$cand" ] && ORT_DIR="$cand" && break
done
ORT_DEST="$DEST/vad-runtime"
mkdir -p "$ORT_DEST"
if [ -n "$ORT_DIR" ] && [ -d "$ORT_DIR" ]; then
  for w in "$ORT_DIR"/ort-wasm-*.wasm "$ORT_DIR"/ort-wasm-*.mjs; do
    if [ -f "$w" ]; then
      mirror_copy_unlinked "$w" "$ORT_DEST/$(basename "$w")"
      mirror_copy_unlinked "$w" "$DEST/$(basename "$w")"
    fi
  done
fi

echo "vad-runtime: copied silero models + worklet into $DEST/ and ort wasm into $ORT_DEST/ plus $DEST/"
