#!/usr/bin/env bash
# superproject-blob.sh — materialize ONE committed file from a pinned superproject
# commit into a private build root, descending through submodule gitlinks
# (WI-10003499).
#
# Desktop Rust sources compile superproject-owned files in via relative
# include_str!/include_bytes! paths that climb out of the papercusp-desktop
# submodule (e.g. custom_protocol.rs reads
# ../../../libs/generic/desktop-ipc/src/csp-policy.json). A producer that packages
# a private detached desktop worktree therefore has to stage those files beside
# it. Reading them from the live canonical tree would reopen the moving-source
# race the private worktree exists to close. So stage the exact blob the pinned
# commit names, resolved through every gitlink on the way, and verify its hash.
#
# Same contract as build-windows-cross.sh's copy_superproject_snapshot_blob. That
# producer still carries its own inline copy, which its tests slice by text;
# converging it onto this lib is a separate change.
#
# Sourcing this file only defines functions.

# papercusp_materialize_superproject_blob <superproject-root> <commit> <repo-rel-path> <dest-file>
# Prints a diagnostic to stderr and returns non-zero on any failure. On failure the
# destination is removed rather than left partial.
papercusp_materialize_superproject_blob() {
  local source_repo="$1" source_commit="$2" rel="$3" dest="$4"
  local source_path="" component tree_entry entry_mode="" entry_type="" expected_blob="" entry_path actual_blob
  local -a components
  if [[ -z "$source_repo" || -z "$source_commit" || -z "$rel" || -z "$dest" ]]; then
    echo "superproject-blob: usage: <superproject-root> <commit> <repo-rel-path> <dest-file>" >&2
    return 2
  fi
  IFS=/ read -r -a components <<< "$rel"
  for component in "${components[@]}"; do
    source_path="${source_path:+$source_path/}$component"
    if ! tree_entry="$(git -C "$source_repo" --literal-pathspecs ls-tree "$source_commit" -- "$source_path" 2>/dev/null)"; then
      echo "superproject-blob: could not resolve $rel at $source_commit ($source_repo)" >&2
      return 1
    fi
    read -r entry_mode entry_type expected_blob entry_path <<< "$tree_entry"
    if [[ -z "$expected_blob" ]]; then
      echo "superproject-blob: $rel is not tracked at $source_commit (missing component: $source_path in $source_repo)" >&2
      return 1
    fi
    if [[ "$entry_mode" == 160000 && "$entry_type" == commit ]]; then
      source_repo="$source_repo/$source_path"
      source_commit="$expected_blob"
      source_path=""
      if [[ ! -e "$source_repo/.git" ]]; then
        echo "superproject-blob: submodule repository is unavailable: $source_repo" >&2
        return 1
      fi
      if ! git -C "$source_repo" cat-file -e "$source_commit^{commit}" 2>/dev/null; then
        echo "superproject-blob: submodule commit $source_commit is unavailable in $source_repo" >&2
        return 1
      fi
    fi
  done
  if [[ "$entry_type" != blob || ( "$entry_mode" != 100644 && "$entry_mode" != 100755 ) ]]; then
    echo "superproject-blob: $rel is not a regular blob at the pinned commit (mode=$entry_mode type=$entry_type)" >&2
    return 1
  fi
  mkdir -p -- "$(dirname "$dest")" || return 1
  if ! git -C "$source_repo" cat-file blob "$expected_blob" > "$dest"; then
    rm -f -- "$dest"
    echo "superproject-blob: could not write $rel to $dest" >&2
    return 1
  fi
  actual_blob="$(git -C "$source_repo" hash-object "$dest" 2>/dev/null || true)"
  if [[ "$actual_blob" != "$expected_blob" ]]; then
    rm -f -- "$dest"
    echo "superproject-blob: hash mismatch for $rel (expected $expected_blob, got ${actual_blob:-none})" >&2
    return 1
  fi
}
