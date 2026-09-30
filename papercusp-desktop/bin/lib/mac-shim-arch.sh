#!/usr/bin/env bash
# WI-484916 — the shipping-slice contract for the macOS embedded-terminal shim.
#
# WHY THIS IS A SEAM AND NOT FOUR INLINE LINES IN mac-vm-build.sh:
# the arm64 half of what we ship is executed by NOTHING in this project. The
# only Mac available is a native Intel VM (uname=x86_64, sysctl.proc_translated
# unset so it is not Rosetta, hw.optional.arm64 absent, "Intel Core Processor
# (Skylake)"), and CI has zero macOS runners. mac-vm-verify-build.sh builds a
# DMG and copies it back; it never boots it. So for the Apple Silicon slice
# this contract is not one check among many — it is the ONLY check, which is
# why it lives somewhere a test can execute it directly.
#
# The bug it replaces (mac-vm-build.sh, pre-WI-484916):
#   swift build --arch x86_64 --arch arm64 || { ...; swift build -c release; }
#   lipo -info "$dylib" || true
# A failed universal build silently fell back to a HOST-ARCH-ONLY dylib, which
# was then embedded into a universal bundle, and the only architecture check
# was suffixed `|| true` so its failure was unobservable. Net effect: an
# x86_64-only terminal shim could ship inside an arm64-capable app, load fine
# on Intel, and fail on Apple Silicon — with every build reporting success.
#
# This is the CAN-FALSELY-PASS class that P-411/WI-5788 eliminated for the rig
# scenarios, sitting one level up in the build path. Same rule applies here:
# a probe that cannot fail is not a check, and an UNMEASURED result is scored
# as FAIL, never silently as a pass.

# required_shim_slices <rust-target-triple>
# Echo the architecture slices an artifact MUST carry to be shippable for that
# target. Derived from the TARGET, never from the build host — "it built here"
# says nothing about the arm64 half when here is always Intel. An unrecognized
# target echoes empty, and callers then enforce nothing (fail-open is correct
# for a target this contract does not claim to know).
required_shim_slices() {
  case "$1" in
    universal-apple-darwin) echo "x86_64 arm64" ;;
    aarch64-apple-darwin)   echo "arm64" ;;
    x86_64-apple-darwin)    echo "x86_64" ;;
    *)                      echo "" ;;
  esac
}

# shim_slices_satisfied <archs-actually-present> <rust-target-triple>
# Pure predicate over an already-measured arch list: 0 when every required
# slice is present, 1 otherwise. Split out from the lipo read so the decision
# is testable without a Mach-O file or a macOS host.
shim_slices_satisfied() {
  local archs="$1" target="$2" need
  for need in $(required_shim_slices "$target"); do
    case " $archs " in
      *" $need "*) ;;
      *) return 1 ;;
    esac
  done
  return 0
}

# assert_shim_slices <dylib> <rust-target-triple>
# Return 0 only when the dylib demonstrably carries every required slice.
# An unreadable/empty lipo result returns 1: "lipo told us nothing" and "the
# slices are fine" must never be indistinguishable.
assert_shim_slices() {
  local dylib="$1" target="$2" archs required
  required="$(required_shim_slices "$target")"
  # R7 (WI-40549), caught by check-assert-integrity against this very file:
  # report the contract AT the measurement, not past the early `return` below.
  # The UNMEASURED bail is exactly the path where a reader most needs to know
  # what was demanded — it is what separates "the probe never ran" from "the
  # artifact is wrong" — and reporting here means every exit path inherits it,
  # including any early return added later.
  echo "    term shim contract: target=$target requires ${required:-<none>}"
  archs="$(lipo -archs "$dylib" 2>/dev/null || true)"
  if [ -z "$archs" ]; then
    echo "FATAL: could not read architectures from '$dylib' — lipo returned nothing."
    echo "       Scoring UNMEASURED as FAIL rather than assuming the slices are present (WI-484916)."
    return 1
  fi
  echo "    term shim archs: $archs"
  if ! shim_slices_satisfied "$archs" "$target"; then
    echo "FATAL: '$dylib' is MISSING a required slice for target=$target."
    echo "       has: $archs / required: $required"
    echo "       Shipping this would break the embedded terminal on the missing architecture (WI-484916)."
    return 1
  fi
  return 0
}
