#!/usr/bin/env bash
# Producer-side provenance note helpers for build-desktop-sidecar.sh.
#
# EI-21815364572202875: `.pg-tools-source` is shipped inside the sidecar, but
# the old writer only scrubbed its two known call sites. A future source-note
# write could therefore bypass the scrub and make the release identity scan
# discover a build-box path only after the whole sidecar had been assembled.
#
# Keep the path rewrite and the write-time assertion together. Callers must use
# papercusp_append_pg_tool_source_note for every note that includes a source
# path; the final assembled-sidecar scan remains the authoritative backstop.
#
# PORTABILITY: macOS ships /bin/bash 3.2. Do not use mapfile, associative
# arrays, `${var^^}`, or other newer Bash features here.

# Rewrite build-local roots to stable placeholders while preserving provenance.
# The replacement order is intentional: the sidecar staging directory is more
# specific than the repo, the repo is more specific than the desktop checkout,
# and all of those are more specific than HOME.
papercusp_scrub_build_path() {
  local p="$1"
  if [[ -n "${SIDECAR_DIR:-}"     ]]; then p="${p//"$SIDECAR_DIR"/<sidecar>}"; fi
  if [[ -n "${SIDECAR_TMP_DIR:-}" ]]; then p="${p//"$SIDECAR_TMP_DIR"/<sidecar>}"; fi
  if [[ -n "${REPO_ROOT:-}"       ]]; then p="${p//"$REPO_ROOT"/<repo>}"; fi
  if [[ -n "${ROOT:-}"            ]]; then p="${p//"$ROOT"/<desktop>}"; fi
  if [[ -n "${HOME:-}"            ]]; then p="${p//"$HOME"/<home>}"; fi
  printf '%s' "$p"
}

# Return success when a source path still looks like an unredacted build-box
# identity. The configured roots catch this build's exact checkout; the generic
# /home/<user> and /Users/<user> forms catch a source path from another
# user-root that the current process cannot name. System paths such as
# /usr/lib/postgresql/... remain valid provenance and are intentionally kept.
papercusp_source_note_path_unredacted() {
  local original="$1"
  local rendered="$2"
  local root_name
  local root

  for root_name in SIDECAR_DIR SIDECAR_TMP_DIR REPO_ROOT ROOT HOME; do
    root="${!root_name:-}"
    [[ -n "$root" ]] || continue
    if [[ "$original" == "$root" || "$original" == "$root/"* ]]; then
      [[ "$rendered" == "$original" ]] && return 0
    fi
  done

  [[ "$rendered" =~ ^/(home|Users)/[^/]+(/|$) ]]
}

# Append one source-note row, refusing to write if the path scrub did not
# remove a build-box identity. This is deliberately producer-time: the failure
# points at the exact tool/source write rather than the terminal whole-tree
# scan many minutes later.
papercusp_append_pg_tool_source_note() {
  local note_file="$1"
  local tool="$2"
  local method="$3"
  local source="$4"
  local scrubbed

  scrubbed="$(papercusp_scrub_build_path "$source")"
  if papercusp_source_note_path_unredacted "$source" "$scrubbed"; then
    echo "ERROR: refusing to write unredacted build-box path to $note_file" >&2
    echo "       tool=$tool method=$method source=$source" >&2
    echo "       Add the build root to the producer scrub before continuing." >&2
    return 1
  fi

  printf '%s: %s (%s)\n' "$tool" "$method" "$scrubbed" >> "$note_file"
}
