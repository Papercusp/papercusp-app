#!/usr/bin/env bash
# cargo-build-safe.sh — run `cargo <args...>` under papercusp-desktop/src-tauri
# without racing a concurrent build-desktop-sidecar.sh rebuild (EI-200).
#
# WHY: a plain `cargo build` (or `cargo check`, `cargo tauri build`, ...) reads
# src-tauri/sidecar/ — tauri.conf.json's `bundle.resources` glob is validated
# by the `generate_context!` macro at COMPILE time, not just at bundle time.
# build-desktop-sidecar.sh publishes a rebuild via a two-step rename-swap
# (EI-160/P-056: `mv sidecar sidecar.old.$$` then, moments later,
# `mv sidecar.tmp.$$ sidecar`) — each rename is atomic on its own, but there
# is a real (if narrow) window BETWEEN the two renames where `sidecar/` does
# not exist on disk at all. A cargo build whose resource-glob validation
# happens to run in that window fails with a misleading
# "glob pattern sidecar/**/* path not found or didn't match any files" —
# looks like a missing-artifact defect, is actually a transient race.
#
# FIX: take a SHARED flock on the SAME lock file build-desktop-sidecar.sh
# takes EXCLUSIVE before it starts rebuilding. Multiple readers (concurrent
# cargo builds) may run alongside each other freely; none may run while a
# rebuild is in flight, and a rebuild (exclusive) waits for every reader to
# finish first — the standard readers/writer pattern. Prefer this wrapper to
# a bare `cargo build` whenever you're rebuilding under active desktop-sidecar
# contention (a peer running build-desktop-sidecar.sh for a .deb/.dmg/.exe cut).
#
# Usage: papercusp-desktop/bin/cargo-build-safe.sh build
#        papercusp-desktop/bin/cargo-build-safe.sh check --release
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SIDECAR_LOCK="$ROOT/src-tauri/sidecar.lock"
SIDECAR_LOCKDIR="$ROOT/src-tauri/sidecar.lockdir"
mkdir -p "$(dirname "$SIDECAR_LOCK")"

cd "$ROOT/src-tauri"

if command -v flock >/dev/null 2>&1; then
  # Same lock file build-desktop-sidecar.sh flocks EXCLUSIVE (fd 9 by
  # convention there too — distinct processes, so the fd number doesn't
  # collide). A SHARED acquire here is compatible with other readers but
  # blocks while a rebuild holds it exclusively.
  exec 9>"$SIDECAR_LOCK"
  if ! flock -sn 9; then
    echo "→ build-desktop-sidecar.sh holds $SIDECAR_LOCK exclusively — waiting for the rebuild to finish before reading sidecar/" >&2
    flock -s 9
  fi
else
  # macOS ships no flock(1); build-desktop-sidecar.sh's own fallback lock
  # there is a plain mkdir mutex (exclusive-only — no shared mode). A reader
  # doesn't need mutual exclusion with other readers, only avoidance of a
  # live writer, so just wait until the lockdir is absent (or stale) rather
  # than trying to reimplement a real shared/exclusive rwlock.
  while [[ -d "$SIDECAR_LOCKDIR" ]]; do
    holder="$(cat "$SIDECAR_LOCKDIR/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      break # stale lock from a dead build — proceed rather than wait forever
    fi
    echo "→ build-desktop-sidecar.sh holds $SIDECAR_LOCKDIR — waiting for the rebuild to finish before reading sidecar/" >&2
    sleep 2
  done
fi

exec cargo "$@"
