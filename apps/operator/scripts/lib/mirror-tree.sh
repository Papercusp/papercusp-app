#!/usr/bin/env bash
# mirror-tree.sh — "is this generated mirror EXACTLY its source?" for the
# setup-*-runtime.sh scripts (monaco, vditor, excalidraw).
#
# SOURCED, never executed. Consumers: setup-monaco-runtime.sh,
# setup-vditor-runtime.sh, setup-excalidraw-runtime.sh.
#
# WHY (WI-10004074, measured 2026-09-30 in the 0.0.25 reproducibility diff,
# WI-10002524): each script skipped its copy when a version stamp matched and one
# sentinel file existed. That proves "a copy of vX finished once". It does NOT
# prove that the mirror holds vX's file set and nothing more. The canonical tree's
# public/monaco/vs had 151 files against monaco-editor 0.56.0's 123. The 28 extra
# hashed chunks (abap-D-t0cyap.js and others) came from an older monaco build. The
# stamp still read 0.56.0, so every run printed "already current". The release cut
# hard-links that tree into the release root, so all 28 dead files shipped in the
# 0.0.25 SPA. It also made each cut depend on the state of the integration tree:
# the reproduction happened to come out clean (123) only because a separate bug
# deleted the mirror first.
#
# WHAT IS COMPARED: the sorted set of relative FILE PATHS, not their bytes. That
# catches the drift class that actually happens: stale extra chunks from an older
# build, and a mirror missing files after an interrupted copy. Content is
# deliberately not hashed. Monaco and excalidraw chunk names are content-hashed,
# so the same version means the same bytes. Vditor rewrites markmap.min.js in
# place after copying, so a byte comparison would never match. Hashing ~30 MB on
# every install and build would also make the cheap path expensive.

# Copy one generated runtime asset without writing through a destination that
# another checkout may still hard-link. GNU cp --remove-destination is unavailable
# on macOS, where these same postinstall scripts run during desktop packaging.
mirror_copy_unlinked() {
  local source="$1" destination="$2"
  rm -f "$destination"
  cp "$source" "$destination"
}

# mirror_file_set <dir> [excluded-relative-path...]
# Print the sorted relative file paths under <dir> (./a/b.js form), excluding
# the named paths (for a stamp file that lives inside the mirror).
mirror_file_set() {
  local dir="$1"
  shift
  local rel
  local excludes=()
  for rel in "$@"; do
    excludes+=(! -path "./$rel")
  done
  (cd "$dir" && find . -type f ${excludes[@]+"${excludes[@]}"}) | LC_ALL=C sort
}

# mirror_matches <src> <dest> [dest-only-excluded-relative-path...]
# Exit 0 when <dest> holds exactly <src>'s file set, otherwise non-zero. A missing
# <dest> never matches.
mirror_matches() {
  local src="$1"
  local dest="$2"
  shift 2
  [ -d "$dest" ] || return 1
  local want have
  want="$(mirror_file_set "$src")" || return 1
  have="$(mirror_file_set "$dest" "$@")" || return 1
  [ "$want" = "$have" ]
}
