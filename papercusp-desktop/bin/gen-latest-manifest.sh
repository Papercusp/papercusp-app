#!/usr/bin/env bash
# gen-latest-manifest.sh — standalone CLI entry point for producing latest.json
# / latest-server.json (+ brief release notes) from an already-built artifact
# set, WITHOUT running the full multi-leg bin/release-local.sh join.
#
# WHY THIS EXISTS (EI-18101626616739029): the tri-platform PARALLEL-FLEET
# release pattern has each agent cut ONE platform via its own per-leg script
# (bin/build-linux-local.sh, bin/build-windows-cross.sh, bin/build-mac-cross.sh)
# and publish it to r2 the moment it's individually ready (owner directive,
# 2026-07-15: "agents should always do the builds in parallel... Publish each
# platform as soon as each gets ready"). None of those per-leg scripts emit a
# manifest — only release-local.sh's embedded Python did, and only AFTER every
# leg joins — so a single-platform cut had no updater manifest unless someone
# hand-extracted that Python block and ran it standalone. This script IS that
# extraction, committed and reusable, sharing the exact manifest-generation
# logic (bin/lib/gen-latest-manifest.sh) bin/release-local.sh itself now calls.
#
# Usage:
#   bin/gen-latest-manifest.sh <version> <channel: alpha|beta|stable|nightly> <artifact>...
#
#   # e.g. after bin/build-linux-local.sh finishes:
#   PAPERCUSP_UPDATE_BASE_URL=https://release.example.com bin/gen-latest-manifest.sh \
#     0.0.13 alpha src-tauri/target/release/bundle/deb/*_0.0.13_*.deb* \
#                   src-tauri/target/release/bundle/appimage/*_0.0.13_*.AppImage*
#
# Set PAPERCUSP_UPDATE_BASE_URL to the base the artifacts will actually be
# served from — unset, latest.json's download URLs are an obviously-invalid
# placeholder and this prints a loud warning (see bin/lib/gen-latest-manifest.sh
# for why: a plausible-but-wrong URL fails SILENTLY at the client, forever
# reporting "up to date").
#
# Prints the tag + the manifest/notes paths on success. To fold a manifest this
# produces into an ALREADY-LIVE latest.json for a different platform (adding
# one platform onto an existing multi-platform release rather than replacing
# it), see the surgical-merge recall on EI-18101626616739029 / the release
# runbook — this script always writes a fresh single-cut manifest, it does not
# merge.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/gen-latest-manifest.sh
source "$HERE/lib/gen-latest-manifest.sh"

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <version> <channel: alpha|beta|stable|nightly> <artifact>..." >&2
  exit 1
fi

VERSION="$1"
CHANNEL="$2"
shift 2

TAG="$(desktop_release_tag "$VERSION" "$CHANNEL")"
echo "==> version=$VERSION channel=$CHANNEL tag=$TAG"
echo "==> generating latest.json + latest-server.json"
gen_latest_manifest "$VERSION" "$CHANNEL" "$TAG" "$@"
echo "tag: $TAG"
