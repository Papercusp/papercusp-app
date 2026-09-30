#!/usr/bin/env bash
# portable-sha256.sh — a darwin-safe sha256 helper, NEVER fatal to the caller.
#
# WHY (WI-4223 / EI-9899, 0.0.8 mac cut): macOS ships NO `sha256sum` (only
# `shasum`). A bare `sha256sum ... | cut ...` pipeline under `set -euo
# pipefail` exits 127 on darwin, and if that pipeline's stderr is redirected
# to /dev/null (a common "keep the log clean" habit), bash's own "command not
# found" is swallowed too — the failure is completely silent. In
# build-desktop-sidecar.sh this silently killed a fully-built, fully-verified
# sidecar (the EXIT trap's cleanup ran against the dead pipeline, deleting the
# tmp dir *after* "verify-sidecar-bundle: OK" had already printed).
#
# Source this file, then call `papercusp_portable_sha256 <path>` — it prints
# the hex digest on stdout, or an EMPTY string (never a crash, never a
# non-zero exit under `set -e`) if neither hasher nor the file exists. A
# metadata/provenance hash must NEVER be fatal to a verified build; let the
# empty string surface in whatever JSON/log the caller writes instead.
#
# Any NEW bin/*.sh script that may run on a darwin host should source this
# rather than hand-rolling `sha256sum`/`shasum` inline (see EI-9905).

papercusp_portable_sha256() {
  local out=""
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum "$1" 2>/dev/null | cut -d' ' -f1)" || true
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1)" || true
  fi
  printf '%s' "$out"
}
