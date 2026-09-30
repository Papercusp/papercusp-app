#!/usr/bin/env bash
# papercusp_repo_root — resolve THE ONE monorepo root a sidecar build reads source from.
#
# EI-21832562420831737. build-desktop-sidecar.sh's own header advertises REPO_ROOT as the
# way to relocate the build ("Override locations with REPO_ROOT / PAPERCUSP_ROOT if your
# layout differs"), and a release-audited cut needs exactly that: build from a pinned,
# tracked-clean checkout so HEAD cannot move under a ~17-minute build and peers' dirty
# files cannot be baked in.
#
# But the script derived the repo root TWICE, independently:
#
#     REPO_ROOT="${REPO_ROOT:-$ROOT/..}"        # honours the override
#     REPO="$(cd "$ROOT/.." && pwd)"            # ~4,300 lines later — ignores it
#
# `$REPO` is not a minor local: the entire chat-dock half of the build reads through it —
# `$REPO/apps/tui`, `$REPO/apps/pui-zellij-plugin`, the `git -C "$REPO" rev-parse` that
# supplies the pui build sha, the dirty probe behind its `_PUI_BUILD_DIRTY` flag, and the
# `--remap-path-prefix=$REPO=/papercusp` that scrubs build paths out of the shipped
# binaries. So `REPO_ROOT=<pinned> build-desktop-sidecar.sh` — the documented invocation —
# produced a bundle whose JavaScript came from the pinned tree and whose Rust came from
# the live one, while the release stamp claimed the pin for all of it.
#
# WHY THAT IS THE DANGEROUS SHAPE rather than merely a bug: it fails SILENTLY and it fails
# PARTIALLY. Both roots exist, both are real checkouts, every path resolves, every build
# step succeeds. There is no error to notice — the only evidence is bytes whose provenance
# is a blend of two commits, which is precisely what the release audit exists to make
# impossible and precisely what it cannot see. The workaround that shipped r15 relocated
# the WHOLE invocation (running the copy of this script inside the pinned worktree), which
# makes the two roots agree by accident; it never exercised the documented override, so the
# trap stayed armed for the next reader who takes the header at its word.
#
# THE RULE: one root, resolved once, honoured everywhere. Canonicalised, so the value that
# reaches `--remap-path-prefix` and every error message is a real path and not
# `/…/papercusp-desktop/..`.
#
# ⚠ NEVER FAILS THE CALLER, deliberately. A root that cannot be entered is echoed back
# unchanged so the script's own named guards report it ("papercup/apps/operator not found
# at <path> — Set REPO_ROOT to the path of your clone"). Exiting here instead would move
# that failure ~200 lines earlier and lose the diagnosis, which is the same ordering
# mistake the identity-check comment at the top of the producer already documents.
#
# PORTABILITY: macOS ships /bin/bash 3.2.57 and this file is sourced by scripts that run on
# the mac VM. Everything here is bash 3.2 (no mapfile, no associative arrays, no ${var^^});
# see scripts/check-mac-bash-portability.mjs.

# Usage: papercusp_repo_root <desktop_root> [<override>]
# Echoes the monorepo root. <override> defaults to $REPO_ROOT from the environment, so the
# caller can assign straight onto REPO_ROOT itself. A blank/whitespace-only override counts
# as absent — same normalisation the vm-release entry gate applies to its pins, so "set but
# empty" cannot silently relocate a build to `/`.
papercusp_repo_root() {
  local _desktop_root="${1:-}"
  local _override="${2-${REPO_ROOT:-}}"
  local _candidate

  if [[ -n "${_override//[[:space:]]/}" ]]; then
    _candidate="$_override"
  else
    _candidate="$_desktop_root/.."
  fi

  ( cd "$_candidate" 2>/dev/null && pwd ) || printf '%s\n' "$_candidate"
}

# Usage: papercusp_assert_release_source_clean <captured_dirty_flag> <repo_root>
# Returns 0 when the captured source state is clean; otherwise prints a diagnosis to stderr
# and returns 1. The caller decides how to fail.
#
# EI-21832562420831737, the second half. A `vm-release` cut's contract is "these bytes came
# from this immutable sha" — the build hard-refuses to start without PAPERCUSP_BUILD_SHA —
# yet nothing checked that the tree it was about to read held ONLY that commit's content.
# The sidecar is esbuild-bundled from apps/operator/bin/serve.ts, whose import graph
# transitively includes packages/operator-core, so building on the shared checkout bakes
# whatever peers happen to have uncommitted into the bundle while the stamp claims the pin.
# Every artifact-side gate still passes — the release audit, the SBOM and the vulnerability
# scan all inspect the FINISHED bundle, and it agrees with itself. Nothing in the pipeline
# could see the source it came from.
#
# ⚠ THE VERDICT IS NOT MEASURED HERE, AND MUST NOT BE. It is the value already captured at
# the PHASE BOUNDARY — `PROVENANCE_SOURCE_GIT_DIRTY`, taken at build entry before dependency
# generation and npm installs mutate tracked build state, and supplied directly by a release
# orchestrator that captured that boundary itself (build-desktop-sidecar.sh states that seam
# contract explicitly, and remains authoritative). Re-measuring here would answer a DIFFERENT
# question — "is the tree dirty NOW", minutes later and after the build's own writes — and on
# this shared checkout the two answers routinely differ. It would also quietly become a
# second source of truth for a predicate the capture already defines precisely
# (`git diff --quiet HEAD` plus a submodule worktree check, in emit-build-provenance.sh).
#
# FAIL CLOSED: only the literal `false` is clean. An unset, empty, or unrecognised flag is
# refused, because "we could not tell" and "it is fine" must never be the same answer on a
# release path.
#
# UNTRACKED FILES ARE NOT DIRT, by that capture's definition — build outputs, scratch dirs
# and logs are untracked by design and cannot enter the bundle as source. A gate that tripped
# on them would be unsatisfiable in exactly the situation it exists for, and an unsatisfiable
# gate gets bypassed rather than obeyed.
#
# WHY REFUSING IS SAFE — a gate is only correct if it is SATISFIABLE, and this one is, today:
# r15 built and published end-to-end from the tracked-clean pinned worktree
# ~/.papercusp/p046-pinned. So a pinned-source cut passes and a shared-tree cut is refused,
# which is the intended split. It fires ONLY under vm-release, whose only setters are
# bin/build-linux-local.sh and bin/install-workspace-host-entrypoints.sh; the desktop release
# pipeline never sets it, and dogfood/developer builds never reach this.
#
# DELIBERATELY NOT CHECKED: that HEAD equals PAPERCUSP_BUILD_SHA. The provenance schema keeps
# `buildSha` and `gitHead` as SEPARATE fields on purpose (emit-build-provenance.sh records
# both, plus `gitHeadAtEmit`), so equality is a convention of one particular release wrapper,
# not a system-wide invariant — asserting it here would hard-fail cuts that are legitimately
# labelled with a sha other than the checkout's own.
papercusp_assert_release_source_clean() {
  local _dirty="${1:-}"
  local _root="${2:-}"
  local _detail _line _n

  _dirty="${_dirty//[[:space:]]/}"
  if [[ "$_dirty" == "false" ]]; then
    return 0
  fi

  if [[ "$_dirty" != "true" ]]; then
    echo "ERROR: vm-release source cleanliness is UNKNOWN (PROVENANCE_SOURCE_GIT_DIRTY='$1')." >&2
    echo "       Refusing rather than assuming clean: a release-audited cut may not guess." >&2
    return 1
  fi

  echo "ERROR: vm-release source tree carried uncommitted tracked changes at build entry: $_root" >&2

  # BEST-EFFORT DETAIL ONLY — never the verdict, which was decided above from the captured
  # phase-boundary flag. This listing is read LATE, so it can legitimately differ from what
  # was captured; a failure to produce it changes nothing.
  if _detail="$(git -C "$_root" status --porcelain --untracked-files=no --ignore-submodules=untracked 2>/dev/null)"; then
    if [[ -n "$_detail" ]]; then
      echo "       tracked changes visible now (indicative, not the verdict):" >&2
      _n=0
      # A while-read loop, not `| head`: under `set -euo pipefail` a pipe closed early by
      # head can SIGPIPE its producer and kill the build on the DIAGNOSTIC path.
      while IFS= read -r _line; do
        _n=$((_n + 1))
        if [[ "$_n" -le 20 ]]; then
          echo "         $_line" >&2
        fi
      done <<< "$_detail"
      if [[ "$_n" -gt 20 ]]; then
        echo "         … and $((_n - 20)) more" >&2
      fi
    fi
  fi

  echo "       Those bytes would be baked into the bundle while its stamp claims the pin." >&2
  echo "       Cut from a pinned worktree instead of the shared checkout:" >&2
  echo "         git -C <repo> worktree add --detach <path> <sha>" >&2
  echo "       then run THAT worktree's copy of bin/build-desktop-sidecar.sh." >&2
  return 1
}
