#!/usr/bin/env bash
#
# postbuild-copy.sh — deploy the built Starlight docs into the operator.
#
# Astro builds the engineering docs into ./dist with `base: '/internal/docs'`
# and `build.format: 'file'` (so pages are emitted as `<slug>.html`, not
# `<slug>/index.html`). The operator's Next app serves apps/operator/public/
# at the web root and next.config.js rewrites bare-slug requests to their
# `.html` twin — so deploying the docs is just mirroring dist/ into
# apps/operator/public/internal/docs/.
#
# This script is wired into `npm run build` (astro build && bash this).
# It runs with cwd = apps/operator-docs.
#
# ── WI-1998: build elsewhere, publish atomically ────────────────────────────
# The old approach rsync'd dist/ STRAIGHT INTO the live DEST with --delete —
# an in-place mutation that, for a tree the size of the docs site, takes
# multiple seconds and deletes+rewrites files (incl. the pagefind search
# index shards) one at a time. Two concurrent readers of DEST race that
# window and lose: apps/operator-vite's Vite build copies its `publicDir`
# (which IS apps/operator/public, docs included) into its own dist/, and
# papercusp-desktop/bin/build-desktop-sidecar.sh separately `cp -a`s
# public/internal/docs/ into the packaged sidecar. Either copy can enumerate
# a pagefind shard via readdir, then ENOENT trying to read it a moment later
# once this script's rsync has already deleted/replaced it mid-run — failing
# the whole SPA build or the whole sidecar build on what is, from the
# operator's perspective, a routine docs regeneration.
#
# Fix: build the full mirror in an ISOLATED staging dir (a plain rsync/cp
# into an empty target, never touching the live DEST a reader might be
# mid-copy on), then PUBLISH it with two back-to-back rename() calls —
# swap the old DEST out of the way, swap the new tree in. This is the same
# "build a temp tree, publish atomically" pattern build-desktop-sidecar.sh
# itself already uses for its own SIDECAR_DIR (EI-160/P-056) — applied here
# to the docs deploy target that races it.
#
# ── follow-up: the two-rename swap ALONE is NOT enough — reap with a grace
#    period, don't eagerly rm -rf the swapped-out tree ─────────────────────
# The rename swap makes the top-level NAME "DEST" flip atomically, but a
# reader like `cp -a`/rsync doesn't hold one fd for its whole walk — it opens
# each file/subdir by name as it descends. unlink()ing a name removes it from
# lookup for EVERYONE, including a reader with a perfectly valid, still-open
# fd on an ancestor directory: "the inode stays alive while open" only covers
# files the reader has ALREADY opened, not ones it hasn't reached yet in its
# walk. So an eager `rm -rf "$DEST_OLD"` right after the swap (the original
# fix's EXIT trap did this unconditionally, same-run) unlinks the just-
# swapped-out tree's contents out from under any reader still mid-walk of it
# — reproduced live: a concurrent-reader stress harness (rapid re-publish +
# a slow `cp -a` loop) still threw `cp: cannot stat …: No such file or
# directory` on pagefind shards WITH the rename-swap in place, because this
# same run's trap deleted DEST_OLD within milliseconds of creating it — zero
# grace period. Fix: never touch a FRESH swap-out; instead, before this run's
# own swap, reap only PRIOR runs' swapped-out trees old enough (>=2 min) that
# no reasonable reader could still be walking them. A reader that takes over
# 2 minutes to copy the docs tree has a bigger problem than this script.
#
set -euo pipefail

SRC="dist"
DEST="../operator/public/internal/docs"
DEST_TMP="${DEST}.tmp.$$"
DEST_OLD="${DEST}.old.$$"
DEST_OLD_GLOB="$(basename "$DEST").old.*"
DEST_OLD_GRACE_MIN=2

if [[ ! -d "$SRC" ]]; then
  echo "postbuild-copy: '$SRC' not found — run 'astro build' first" >&2
  exit 1
fi

# Clean up ONLY our own tmp staging dir on any exit (success, error, or
# interrupt) — NEVER this run's own DEST_OLD (see above: that would reap the
# tree we just swapped out with no grace period for an in-flight reader).
trap 'rm -rf "$DEST_TMP"' EXIT

rm -rf "$DEST_TMP"
mkdir -p "$DEST_TMP"

# Mirror dist/ → the ISOLATED staging dir (not the live DEST). `--checksum`
# is kept as cheap insurance against a same-size/same-mtime re-emit (the
# original reason it was added, 2026-05-31) even though staging is always a
# fresh empty target now — belt-and-braces, not load-bearing here.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --checksum "$SRC"/ "$DEST_TMP"/
else
  cp -R "$SRC"/. "$DEST_TMP"/
fi

mkdir -p "$(dirname "$DEST")"

# Reap stale swapped-out trees from PRIOR runs — only ones old enough that no
# in-flight reader could plausibly still be walking them. Never matches this
# run's own (not-yet-created) DEST_OLD, since -mmin +N excludes anything that
# doesn't exist yet.
find "$(dirname "$DEST")" -maxdepth 1 -name "$DEST_OLD_GLOB" -mmin "+$DEST_OLD_GRACE_MIN" -exec rm -rf {} + 2>/dev/null || true

# Atomic-ish publish: swap the old tree out, swap the new tree in. A plain
# `mv "$DEST_TMP" "$DEST"` can't do this in one syscall when DEST already
# exists as a non-empty directory (rename(2) requires an empty target), hence
# the two-step swap via DEST_OLD — left in place for the grace period above
# to reap on a LATER run, not this one.
if [[ -d "$DEST" ]]; then
  mv "$DEST" "$DEST_OLD"
  # WI-10004327: rename(2) KEEPS a directory's mtime, so the swapped-out tree
  # carries the OLD build's mtime, not the swap-out time. Without this stamp
  # the -mmin grace sweep (above, and in any concurrent run) sees a tree
  # swapped out this instant as long-stale and reaps it out from under an
  # in-flight reader, which is exactly what the grace period exists to prevent.
  # Measured: docs.old.3438785 had mtime 09-28 22:17Z but ctime 09-30 07:48Z.
  touch "$DEST_OLD"
fi
mv "$DEST_TMP" "$DEST"

# ── reap THIS run's swap-out too, after the same grace period ────────────────
# WI-6539. The reap above only runs at the START of a run, so the LAST build's
# DEST_OLD survived until some future build happened to come along — and if none
# did, forever. That is not hypothetical: on 2026-07-28 a `docs.old.160411` was
# found still sitting in public/internal/ (and copied onward into
# operator-vite/dist/), 242MB each, 484MB total — and, because the Vite dev
# server walks publicDir, ~5,200 of its ~12,000 inotify watches (42%) were being
# spent on those two dead trees alone. Same class was found and hand-purged from
# the desktop sidecar copy on 2026-07-06 (build-desktop-sidecar.sh) without ever
# being fixed at the source; this is the source fix.
#
# The grace period is load-bearing (see the long comment at the top — an eager
# same-run rm -rf demonstrably broke concurrent readers mid-walk), so we do NOT
# reap inline. Instead detach a reaper that waits out the SAME grace period and
# then removes only this run's own swap-out. Fails safe: if the reaper is killed
# with its process group, the tree simply survives to be reaped by the
# start-of-run sweep above, i.e. exactly today's behaviour, never worse.
#
# WI-10004327: a setsid'd sleeper escapes the process GROUP but not the build's
# CGROUP, and a systemd unit launcher kills its whole cgroup when the build
# exits (capability:bash runs each command as a pc-*.service with
# KillMode=control-group). Measured 2026-09-30: the sleeper's unit cgroup was
# gone ~10s into its 120s sleep and the swapped-out tree survived. That is how
# a 350 MB docs.old.<pid> sat in public/ for hours and was copied into dist and
# release trees. So schedule the reap as a transient USER TIMER: it runs in the
# systemd user manager, outside the build's cgroup, and outlives the build. Fall
# back to the detached sleeper only where there is no user manager (CI,
# containers), where no unit teardown exists to kill it.
if [[ -d "$DEST_OLD" ]]; then
  DEST_OLD_ABS="$(cd "$(dirname "$DEST_OLD")" && pwd)/$(basename "$DEST_OLD")"
  REAP_AFTER_SEC="$((DEST_OLD_GRACE_MIN * 60))"
  if ! systemd-run --user --quiet --collect --on-active="${REAP_AFTER_SEC}s" \
      --description="postbuild-copy reap $DEST_OLD_ABS" \
      "$(command -v rm)" -rf -- "$DEST_OLD_ABS" </dev/null >/dev/null 2>&1; then
    setsid nohup sh -c 'sleep "$1"; rm -rf -- "$2"' _ \
      "$REAP_AFTER_SEC" "$DEST_OLD_ABS" \
      </dev/null >/dev/null 2>&1 &
  fi
fi

echo "postbuild-copy: $(find "$DEST" -type f | wc -l | tr -d ' ') files → $DEST"
