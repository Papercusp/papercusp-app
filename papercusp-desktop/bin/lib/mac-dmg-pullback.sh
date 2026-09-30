#!/usr/bin/env bash
# WI-489075 — the artifact contract for the macOS public-release verification build.
#
# WHY THIS IS A SEAM AND NOT TEN INLINE LINES IN mac-vm-verify-build.sh:
# the DMG pull-back is the ONLY evidence that mac-vm-verify-build.sh produced a
# shippable artifact at all. Nothing downstream re-checks it — CI has zero macOS
# runners, the only Mac available is a native Intel VM, and the script never
# boots what it retrieves (see lib/mac-shim-arch.sh for the sibling contract on
# the same build path). So this check is not one of many; it is the only thing
# standing between "the build reported success" and "a release artifact exists",
# which is why it lives somewhere a test can execute it directly, with no Mac,
# no VM and no network.
#
# The bug it replaces (mac-vm-verify-build.sh, pre-WI-489075):
#   scp "$VM:.../$MAC_BUILD_TARGET/release/bundle/dmg/*.dmg" "$SCRATCH/dmg/" || true
#   echo; echo "=== DMGs ==="; ls -la "$SCRATCH/dmg/" 2>/dev/null
#   echo "=== BUILD DONE sha=$SHA ... ==="
# That script sets `set -uo pipefail` but deliberately NOT `-e`, so the `|| true`
# swallowed a failed pull, the `2>/dev/null` listing neither failed nor printed on
# an empty directory, and the unconditional "BUILD DONE" line then exited 0. Any
# of: scp failure, a remote build that emitted no bundle, or a MAC_BUILD_TARGET
# that does not match the directory tauri actually bundled into, produced a
# confident green run with zero artifacts on disk.
#
# CLASS: EI-21713782985040786 — "required verification evidence is not a mandatory
# predicate of success; unavailable or failed probes are converted into a
# successful outer result." Same rule as the sibling contract: a probe that cannot
# fail is not a check, and an UNMEASURED result is scored as FAIL, never as a pass.
#
# bash 3.2-clean (macOS system bash; this file is pulled into
# scripts/check-mac-bash-portability.mjs's mac-build-path closure): no nullglob,
# no mapfile, no associative arrays, no ${var,,} case conversion.

# assert_dmg_pullback <dmg-dir> <rust-target-triple>
# Succeed only if <dmg-dir> holds at least one *.dmg and every one is non-empty.
# Returns non-zero instead of exiting, so callers keep their own failure idiom
# and tests can exercise it repeatedly in-process.
assert_dmg_pullback() {
  local dir="${1:?assert_dmg_pullback: dmg dir required}"
  local target="${2:-unknown}"
  local count=0
  local f

  for f in "$dir"/*.dmg; do
    # No nullglob: an unmatched glob stays literal, so -e is what rejects it.
    [ -e "$f" ] || continue
    if [ ! -s "$f" ]; then
      echo "FATAL: retrieved DMG is zero bytes: $f" >&2
      return 1
    fi
    count=$((count + 1))
  done

  if [ "$count" -eq 0 ]; then
    echo "FATAL: 0 DMGs retrieved into $dir (target=$target)." >&2
    echo "       The remote build reported success but left no bundle at" >&2
    echo "       src-tauri/target/$target/release/bundle/dmg/ — verify MAC_BUILD_TARGET" >&2
    echo "       matches the target tauri actually bundled." >&2
    return 1
  fi

  echo "=== DMG pull-back verified: $count artifact(s), all non-empty ==="
  return 0
}
