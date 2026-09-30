#!/usr/bin/env bash
# papercusp_pinned_deps_* — give a PINNED release cut dependencies that are decoupled
# from the shared checkout, and refuse to build when they are not.
#
# EI-21832562420831737, third and last part. Parts one and two (lib/source-roots.sh) made
# a vm-release cut read ONE repo root and refuse a source tree that was dirty at the phase
# boundary. Both are about *source*. This file is about the other half of what the build
# actually reads: node_modules.
#
# THE DEFECT. A pinned worktree is created by `git worktree add --detach`, so it has no
# node_modules at all, and a full install is minutes the release window does not have. The
# workaround that shipped r15 overlay-mounted 86 node_modules directories into the pinned
# tree with `lowerdir` pointing straight at the LIVE shared checkout. That gets the write
# direction right — an overlay upper layer captures every pinned write, so nothing the build
# does can reach the shared tree — and gets the READ direction exactly wrong: ~100 agents
# keep installing into that lower layer while the cut reads it.
#
# It is not a theoretical race; it has already destroyed a release. On 2026-08-29 a
# concurrent live build rewrote the shared sidecar node_modules at 20:34:43, 20:35:57 and
# 20:37:30 EDT, inside r14's dependency-generation comparison window, and r14 died on a torn
# cache hit (D-187). The detector that caught it was dependency generation itself, and D-186
# then switched dependency generation OFF for having zero consumers in the release path and
# costing ~23 of r14's 24 minutes. So the hazard survived and its only detector did not.
#
# WHY THE LOWER LAYER IS THE WRONG PLACE FOR A LIVE TREE, independently of the race window:
# overlayfs does not support it. Modifying the underlying directories of a mounted overlay
# is documented as producing undefined behaviour, not merely a stale read — so "we mounted
# the live tree and it worked" describes a build whose inputs were never well-defined.
#
# THE FIX: keep the overlay, move the floor. `lowerdir` becomes a HARDLINK SNAPSHOT of the
# donor rather than the donor itself. npm mutates a package by unlinking or renaming its
# directory entry, never by editing the inode in place, so a hardlink farm is a genuine
# point-in-time snapshot of exactly the operations that tore r14: entries the snapshot owns
# keep pointing at the inodes they were linked to, whatever the donor does afterwards. The
# result keeps BOTH properties — the donor cannot tear the build (its own entries are
# frozen) and the build cannot reach the donor (overlay writes land in the upper layer).
#
# MEASURED, not assumed: `cp -al` of the live root node_modules — 255,519 files — took 9
# seconds and consumed no measurable disk (58G available before and after; hardlinks share
# data blocks, so only directory entries are new). That is the whole cost of the fix, once
# per pin, against the ~17-minute cut it protects.
#
# ⚠ USE df, NOT du, IF YOU RE-MEASURE THAT. `du` over a hardlink farm dedupes within one
# invocation and not across them, so it reports whatever the caller's traversal order makes
# it report; a sibling item measured a ~7x overstatement that way.
#
# WHAT THIS DELIBERATELY DOES NOT DO: take the snapshot by fingerprinting the donor before
# and after and refusing a mismatch, the way sync_one_node_modules does in
# apps/operator/bin/release/setup-release-checkout.sh. That is a DETECTOR, and this path can
# have PREVENTION instead: scripts/npm-install-safe.mjs already owns a repo-keyed install
# mutex and already exposes the reader half of that contract as `--exec-under-lock`, written
# for precisely this shape ("long-lived host services build an entrypoint from node_modules
# immediately before boot"). Snapshotting under that lock means no sanctioned install can be
# mid-flight, and the lock is held for the ~9 seconds of the snapshot rather than the whole
# build. The cheap shape check below is the residual net for UNSANCTIONED writers — a bare
# `npm install`, which the repo forbids precisely because it corrupts the shared tree.
# The full fingerprint is deliberately not used as a per-cut gate, on cost grounds that were
# measured rather than guessed: `dependency_generation_tree_fingerprint` over the root
# node_modules ALONE took 3m09s (2m58s of it system time — it stats every one of the 255,519
# paths), against 9s for hardlink-snapshotting the same tree. Its before/after form needs two
# such walks per tree, so adopting it here would reintroduce exactly the cost profile D-186
# switched dependency generation off for. It remains the right instrument in
# setup-release-checkout.sh, which has no lock over its donor and therefore no alternative.
#
# PORTABILITY: macOS ships /bin/bash 3.2.57 and this file is sourced by scripts that run on
# the mac VM. Everything here is bash 3.2 (no mapfile, no associative arrays, no ${var^^});
# see scripts/check-mac-bash-portability.mjs.

# Usage: papercusp_pinned_deps_trees <root>
# Echoes, one per line, the repo-relative path of every node_modules directory a workspace
# install can reach from <root>. Empty output is a legitimate answer (a fresh worktree).
#
# The enumeration matches the r15 workaround's, including its two exclusions, because both
# were paid for:
#   - `.papercusp/` holds agent scratch, not build input;
#   - nested node_modules under a node_modules are reached through their parent already;
#   - the generated sidecar OUTPUT dir is excluded by D-187. Mounting inside it makes the
#     mount follow the retired inode when publication atomically renames sidecar/ aside, and
#     the builder's cleanup then fails EBUSY after an otherwise-green cut. It would also
#     leak live build artifacts into server.tgz.
papercusp_pinned_deps_trees() {
  local _root="${1:-}"
  [ -n "$_root" ] || return 0
  [ -d "$_root" ] || return 0

  # ⚠ `-type d` ALONE IS A HOLE, and it is the hole that matters: a node_modules which is a
  # SYMLINK into another tree is `-type l`, so a directory-only enumeration silently omits
  # the single worst coupling shape from the gate below — the guard reports clean precisely
  # when it should refuse. Caught by its own suite, not by review.
  ( cd "$_root" 2>/dev/null || exit 0
    find . -maxdepth 4 -name node_modules \( -type d -o -type l \) \
      -not -path './.papercusp/*' \
      -not -path './node_modules/*' 2>/dev/null \
      | sed 's#^\./##' \
      | grep -v '^papercusp-desktop/src-tauri/sidecar/node_modules$' \
      | LC_ALL=C sort
  )
}

# Usage: papercusp_pinned_deps_snapshot <donor_root> <snapshot_root>
# Hardlink-snapshots every dependency tree under <donor_root> into <snapshot_root>, preserving
# the donor's relative layout. Prints progress to stdout; returns non-zero on any failure.
#
# ⚠ CALL IT UNDER THE DONOR'S INSTALL MUTEX. This function does not take the lock itself,
# because the lock belongs to the donor tree and is owned by the donor's own tooling — taking
# it here would be a second implementation of a contract scripts/npm-install-safe.mjs already
# defines. `papercusp_pinned_deps_snapshot_locked` below is the wrapper that does it properly.
#
# LAYOUT IS MIRRORED, NOT FLATTENED. The snapshot keeps `apps/operator/node_modules` at
# `<snapshot_root>/apps/operator/node_modules` rather than a flattened key, so a lowerdir can
# be checked with a plain prefix test and a reader can see which tree a directory came from.
#
# RELATIVE SYMLINKS SURVIVE. The ~98 `@papercusp/*` entries are relative symlinks
# (`../../libs/generic/...`). `cp -al` preserves the link TEXT, and an overlay resolves links
# at the MOUNTPOINT, so under the pinned tree they land inside the pinned tree — the same
# property the r15 overlay had, for the same reason. That is also why a snapshot must never be
# used as a node_modules directly at a different depth: the links would resolve elsewhere.
papercusp_pinned_deps_snapshot() {
  local _donor="${1:-}"
  local _snap="${2:-}"
  local _rel _src _dst _tmp _old _n=0 _fail=0

  if [ -z "$_donor" ] || [ -z "$_snap" ]; then
    echo "ERROR: papercusp_pinned_deps_snapshot needs <donor_root> <snapshot_root>." >&2
    return 2
  fi
  if [ ! -d "$_donor" ]; then
    echo "ERROR: dependency donor is not a directory: $_donor" >&2
    return 2
  fi

  # Hardlinks cannot cross filesystems, and the failure mode without this check is a
  # half-built snapshot plus an EXDEV error thousands of files in. Assert it once, up front,
  # naming both devices — the same contract assert_hardlink_compatible_roots makes in
  # setup-release-checkout.sh before its own hardlink copy.
  local _donor_dev _snap_dev _snap_probe
  _snap_probe="$_snap"
  while [ -n "$_snap_probe" ] && [ ! -e "$_snap_probe" ]; do
    _snap_probe="$(dirname "$_snap_probe")"
  done
  _donor_dev="$(df -P "$_donor" 2>/dev/null | awk 'NR==2 {print $1}')"
  _snap_dev="$(df -P "$_snap_probe" 2>/dev/null | awk 'NR==2 {print $1}')"
  if [ -z "$_donor_dev" ] || [ -z "$_snap_dev" ]; then
    echo "ERROR: could not determine the filesystem of the donor ($_donor) or snapshot root ($_snap)." >&2
    return 1
  fi
  if [ "$_donor_dev" != "$_snap_dev" ]; then
    echo "ERROR: a hardlink dependency snapshot needs one filesystem." >&2
    echo "       donor=$_donor ($_donor_dev)  snapshot=$_snap ($_snap_dev)" >&2
    echo "       Place the snapshot root on the donor's filesystem; a cross-device copy would" >&2
    echo "       duplicate the whole dependency payload instead of sharing its data blocks." >&2
    return 1
  fi

  mkdir -p "$_snap" || return 1

  while IFS= read -r _rel; do
    [ -n "$_rel" ] || continue
    _src="$_donor/$_rel"
    _dst="$_snap/$_rel"
    _tmp="$_dst.pinned-deps-tmp.$$"
    _old="$_dst.pinned-deps-old.$$"
    [ -d "$_src" ] || continue

    # A SYMLINKED dependency tree must not be snapshotted through. `cp -al` implies
    # --no-dereference, so it would faithfully reproduce the symlink and the "snapshot" would
    # still point at the donor — decoupled in name only, and silently so. Refusing is also
    # honest about the alternative: dereferencing with -L would turn a 9-second hardlink farm
    # into a real 15GB copy of somebody else's tree.
    if [ -L "$_src" ]; then
      echo "  REFUSING to snapshot through a symlinked dependency tree: $_rel -> $(readlink "$_src")" >&2
      _fail=1
      continue
    fi

    mkdir -p "$(dirname "$_dst")" || { _fail=1; continue; }
    rm -rf "$_tmp" 2>/dev/null

    # Build beside the destination and swap with renames, never in place. A snapshot root is
    # cheap to rebuild but it may be the lowerdir of a mounted overlay while we run, and a
    # half-populated lower layer is precisely the torn read this file exists to prevent.
    if ! cp -al "$_src" "$_tmp" 2>/dev/null; then
      echo "  FAILED to snapshot $_rel" >&2
      rm -rf "$_tmp" 2>/dev/null
      _fail=1
      continue
    fi

    if [ -e "$_dst" ]; then
      if ! mv "$_dst" "$_old" 2>/dev/null; then
        echo "  FAILED to retire the previous snapshot of $_rel" >&2
        rm -rf "$_tmp" 2>/dev/null
        _fail=1
        continue
      fi
    fi
    if ! mv "$_tmp" "$_dst" 2>/dev/null; then
      echo "  FAILED to publish the snapshot of $_rel" >&2
      [ -e "$_old" ] && mv "$_old" "$_dst" 2>/dev/null
      rm -rf "$_tmp" 2>/dev/null
      _fail=1
      continue
    fi
    rm -rf "$_old" 2>/dev/null
    _n=$((_n + 1))
  done <<EOF
$(papercusp_pinned_deps_trees "$_donor")
EOF

  if [ "$_fail" -ne 0 ]; then
    echo "ERROR: dependency snapshot incomplete; refusing to stamp it." >&2
    return 1
  fi

  # The stamp is what a later reader (and the gate below) can point at to say WHICH donor and
  # WHEN. It is written last, so an interrupted snapshot leaves no stamp rather than a stamp
  # describing a tree that was never finished.
  {
    echo "donor=$_donor"
    echo "trees=$_n"
    echo "takenAtUtc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } > "$_snap/.papercusp-pinned-deps" || return 1

  echo "snapshotted $_n dependency tree(s) from $_donor into $_snap"
  return 0
}

# Usage: papercusp_pinned_deps_snapshot_locked <donor_root> <snapshot_root>
# The supported entry point: takes the DONOR's repo-keyed install mutex, then snapshots.
#
# It re-invokes this file as a script under `npm-install-safe.mjs --exec-under-lock`, which is
# that script's own documented reader-side contract, rather than reimplementing the mkdir-lock
# algorithm in scripts/lib/fs-mutex.mjs. Two consequences worth knowing: the lock is keyed off
# the donor root's symlink-resolved real path, so a different checkout is never blocked by it;
# and the wait is bounded by whatever install is in flight, not by our build.
#
# NO SILENT DEGRADATION. If the wrapper is missing we refuse instead of snapshotting unlocked,
# because an unlocked snapshot is the exact artifact this function exists to rule out and it is
# indistinguishable from a good one by inspection.
papercusp_pinned_deps_snapshot_locked() {
  local _donor="${1:-}"
  local _snap="${2:-}"
  local _self="${BASH_SOURCE[0]}"
  local _wrapper

  if [ -z "$_donor" ] || [ -z "$_snap" ]; then
    echo "ERROR: papercusp_pinned_deps_snapshot_locked needs <donor_root> <snapshot_root>." >&2
    return 2
  fi

  _wrapper="$_donor/scripts/npm-install-safe.mjs"
  if [ ! -f "$_wrapper" ]; then
    echo "ERROR: cannot take the donor's install mutex — $_wrapper is missing." >&2
    echo "       Refusing to snapshot dependencies unlocked: a snapshot taken while an install" >&2
    echo "       is reifying the donor is torn, and a torn snapshot looks exactly like a good one." >&2
    return 1
  fi

  node "$_wrapper" --repo-root "$_donor" --exec-under-lock -- \
    bash "$_self" snapshot "$_donor" "$_snap"
}

# Usage: papercusp_assert_pinned_deps_decoupled <repo_root> [<allowed_root>] [<mountinfo>]
# Returns 0 when every dependency tree the build will read is backed only by storage inside
# <repo_root> (or inside <allowed_root>, the declared snapshot root). Otherwise prints a
# diagnosis to stderr and returns 1. The caller decides how to fail.
#
# THIS IS THE GATE, and it is the increment-2 shape applied to dependencies: having demanded
# an immutable source sha and a clean source tree, refuse to read dependencies out of a tree
# that ~100 agents are concurrently writing. Nothing checked this before — the release audit,
# the SBOM and the vulnerability scan all inspect the FINISHED bundle, which agrees with
# itself whether or not its inputs were torn.
#
# TWO COUPLING SHAPES ARE CHECKED, because both are reachable from here:
#   1. an overlay whose lowerdir is outside the pinned tree — the r15 workaround's shape, and
#      the one that killed r14;
#   2. a node_modules that is a SYMLINK out of the pinned tree — the cheaper thing a reader
#      reaches for first, and worse than the overlay: the workspace packages' relative links
#      would resolve back into the donor and npm's writes would land there directly.
# A bind mount is caught by the same mountinfo pass as (1), since its field-4 root IS the
# source path when the filesystem is mounted at /.
#
# A PLAIN DIRECTORY PASSES, and that is the point rather than a gap: real dependencies inside
# the pinned tree are decoupled by construction, so the gate fires only on the shapes that
# borrow storage from somewhere else.
#
# PLATFORM: the mount pass reads /proc/self/mountinfo directly rather than shelling to
# findmnt, which does not exist on macOS. Where that file is unreadable the mount axis is
# reported as not applicable and the symlink axis still runs — overlayfs is Linux-only, so on
# a platform without procfs shape (1) cannot exist. That is a statement about the platform,
# not a guess about this tree, which is why it is not treated as "could not tell".
#
# <mountinfo> exists so this gate is TESTABLE — the overlay shape it is built to refuse needs
# root to create, so without an injectable table the only executable coverage would be a
# source grep, and a guard nobody can run against a real fixture is a guard nobody has
# falsified. It is a positional PARAMETER and deliberately not an environment variable: an
# ambient `PAPERCUSP_..._MOUNTINFO=/dev/null` would silently blind a release gate, whereas an
# argument has to be passed by the caller, and the producer is guard-tested to pass exactly
# two. Default is the live table.
papercusp_assert_pinned_deps_decoupled() {
  local _root="${1:-}"
  local _allowed="${2:-}"
  local _mountinfo="${3:-}"
  local _rel _path _target _fail=0

  [ -n "$_mountinfo" ] || _mountinfo=/proc/self/mountinfo

  if [ -z "$_root" ]; then
    echo "ERROR: papercusp_assert_pinned_deps_decoupled needs <repo_root>." >&2
    return 2
  fi

  local _root_real _allowed_real=""
  _root_real="$( cd "$_root" 2>/dev/null && pwd )" || _root_real="$_root"
  if [ -n "$_allowed" ]; then
    _allowed_real="$( cd "$_allowed" 2>/dev/null && pwd )" || _allowed_real="$_allowed"
  fi

  # --- shape 2: a dependency tree that is a symlink out of the pinned tree ---------------
  while IFS= read -r _rel; do
    [ -n "$_rel" ] || continue
    _path="$_root_real/$_rel"
    [ -L "$_path" ] || continue
    _target="$( cd "$(dirname "$_path")" 2>/dev/null && cd "$(readlink "$_path")" 2>/dev/null && pwd )"
    [ -n "$_target" ] || _target="$(readlink "$_path")"
    case "$_target" in
      "$_root_real"/*|"$_root_real") continue ;;
    esac
    if [ -n "$_allowed_real" ]; then
      case "$_target" in
        "$_allowed_real"/*|"$_allowed_real") continue ;;
      esac
    fi
    echo "ERROR: $_rel is a SYMLINK to dependencies outside the pinned tree: $_target" >&2
    _fail=1
  done <<EOF
$(papercusp_pinned_deps_trees "$_root_real")
EOF

  # --- shape 1: an overlay/bind whose backing storage is outside the pinned tree ---------
  if [ ! -r "$_mountinfo" ]; then
    echo "note: skipping the mount check — no $_mountinfo on this platform, where" >&2
    echo "      overlayfs does not exist; the symlink check above still ran." >&2
  else
    local _line
    while IFS= read -r _line; do
      [ -n "$_line" ] || continue
      echo "ERROR: $_line" >&2
      _fail=1
    done <<EOF
$(awk -v root="$_root_real" -v allowed="$_allowed_real" '
  function inside(p, base) {
    return base != "" && (p == base || index(p, base "/") == 1);
  }
  function report(mp, backing) {
    if (inside(backing, root)) return;
    if (allowed != "" && inside(backing, allowed)) return;
    printf "%s is backed by storage OUTSIDE the pinned tree: %s\n", mp, backing;
  }
  {
    # mountinfo: id parent maj:min ROOT MOUNTPOINT OPTIONS [tags...] - FSTYPE SOURCE SUPEROPTS
    sep = 0;
    for (i = 7; i <= NF; i++) if ($i == "-") { sep = i; break; }
    if (!sep) next;
    mountroot = $4; mp = $5; fstype = $(sep + 1); superopts = $(sep + 3);
    if (!inside(mp, root)) next;
    if (mp !~ /node_modules$/) next;
    if (fstype == "overlay") {
      n = split(superopts, opts, ",");
      for (i = 1; i <= n; i++) {
        if (index(opts[i], "lowerdir=") == 1) {
          lowers = substr(opts[i], 10);
          m = split(lowers, lower, ":");
          for (j = 1; j <= m; j++) report(mp, lower[j]);
        }
      }
    } else if (mountroot != "/" && mountroot != "") {
      report(mp, mountroot);
    }
  }
' "$_mountinfo")
EOF
  fi

  [ "$_fail" -eq 0 ] && return 0

  echo "       A release-audited cut may not read dependencies out of a tree other agents are" >&2
  echo "       writing: overlayfs calls a mutating lower layer undefined behaviour, and this is" >&2
  echo "       how r14 died (D-187) — with dependency generation off (D-186) nothing detects it." >&2
  echo "       Snapshot the donor first, then point the pinned tree at the SNAPSHOT:" >&2
  echo "         papercusp_pinned_deps_snapshot_locked <donor_root> <snapshot_root>" >&2
  return 1
}

# Script entry point — sourceable AND runnable. `papercusp_pinned_deps_snapshot_locked` needs
# a command to hand to `--exec-under-lock`, and re-invoking this same file is what keeps the
# locked and unlocked paths from drifting into two implementations.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-}" in
    snapshot) shift; papercusp_pinned_deps_snapshot "$@" ;;
    snapshot-locked) shift; papercusp_pinned_deps_snapshot_locked "$@" ;;
    trees) shift; papercusp_pinned_deps_trees "$@" ;;
    assert) shift; papercusp_assert_pinned_deps_decoupled "$@" ;;
    *)
      echo "usage: $0 {snapshot|snapshot-locked|trees|assert} <args...>" >&2
      exit 2
      ;;
  esac
fi
