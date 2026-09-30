#!/usr/bin/env bash
# papercusp_stamp_git_head — resolve the gitHead a sidecar build stamp should record.
#
# EI-21826568874232796. A `vm-release` build is handed an IMMUTABLE source SHA and
# build-desktop-sidecar.sh hard-refuses (exit 2) to start without one: "Pass the
# immutable source SHA and desktop version explicitly". But the freshness stamp did
# not use it. It recorded a LIVE `git rev-parse --short HEAD` taken at the moment the
# stamp is written — near the END of a ~12-minute build. On this shared checkout a
# background git-sync sweep commits the whole tree on a short cadence, so HEAD moving
# inside the build window is routine rather than exotic, and the stamp then records a
# sha the bytes were NOT built from.
#
# That is wrong as PROVENANCE independent of any verdict layered on top: the artifact
# claims to describe bytes it was not built from. It was also actively misleading —
# the release wrapper's assertion reported a wholly correct build as "STALE STAMP",
# which points the reader at a stale-artifact hypothesis that is false, so the natural
# repair (delete the stamp, rebuild) does not address the cause and the next sweep
# reproduces it.
#
# THE RULE: record the pin the build was GIVEN; re-derive from the live checkout only
# where there is no pin. Outside vm-release there is no pin, so developer/dogfood
# builds keep exactly their previous behaviour, including the `unknown` fallback
# outside a git repo.
#
# WHY THIS IS NOT THE "gitHead != HEAD" RULE bin/lib/sidecar-freshness.js REJECTS:
# that rejected rule is a CONSUMER-side staleness JUDGEMENT ("the sidecar is older
# than my HEAD, so block") which on this shared checkout fires on nearly every build
# and trains the bypass. This is a PRODUCER-side identity question — "which source did
# I build?" — whose answer the producer already holds. Recording it has no
# false-positive rate; nothing here blocks anything.
#
# ⚠ WHY THIS LIVES IN ITS OWN FILE rather than inline at the stamp write: the
# regression this closes is HEAD moving BETWEEN build start and stamp write, and that
# is unreachable from a test that cannot run a ~12-minute release build. Extracted, it
# is a pure function of (PAPERCUSP_BUILD_SHA, repo state) that a unit test can drive
# against a throwaway git repo with HEAD deliberately moved underneath it. Same
# motivation as lib/portable-sha256.sh and lib/sidecar-freshness.js: the shape lives
# once, where it can be tested.
#
# PORTABILITY: macOS ships /bin/bash 3.2.57, and this file is sourced by scripts that
# run on the mac VM. Everything here is bash 3.2 (no mapfile, no associative arrays,
# no ${var^^}); see scripts/check-mac-bash-portability.mjs.

# Usage: papercusp_stamp_git_head <repo_root>
# Echoes the sha to record as the stamp's gitHead. Never fails the caller: a checkout
# that cannot answer yields the literal `unknown`, which is visible in the stamp JSON,
# rather than killing a fully-built and verified sidecar (the EI-9905 lesson).
papercusp_stamp_git_head() {
  local _repo_root="${1:-.}"
  local _pinned="${PAPERCUSP_BUILD_SHA:-}"
  # Whitespace-normalised exactly as the vm-release entry gate normalises it
  # (build-desktop-sidecar.sh's `${_vm_release_build_sha//[[:space:]]/}` check), so a
  # value that gate accepted as non-empty is the value recorded here.
  _pinned="${_pinned//[[:space:]]/}"
  if [[ -n "$_pinned" ]]; then
    printf '%s\n' "$_pinned"
    return 0
  fi
  git -C "$_repo_root" rev-parse --short HEAD 2>/dev/null || echo unknown
}
