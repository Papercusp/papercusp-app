#!/usr/bin/env bash
# rust-path-remap.sh — the ONE definition of the Rust build-box-path remap.
#
# WHAT IT DOES
# ------------
# Without `--remap-path-prefix`, rustc embeds ABSOLUTE source paths of every
# compiled crate (the workspace tree AND every ~/.cargo/registry dependency) in
# the shipped binary's panic/debug strings. On this build box that means the
# build user's $HOME appears hundreds of times inside usr/bin/papercusp-desktop.
# The release identity-scan (WI-4736/EI-11730) treats a build-box $HOME literal
# in an assembled bundle as a FATAL leak and refuses to package — correctly.
#
# WHY IT IS A SHARED LIB AND NOT AN EXPORT IN EACH CALLER
# ------------------------------------------------------
# It used to be an inline `export RUSTFLAGS=...` duplicated in release-local.sh,
# mac-vm-build.sh and build-mac-cross.sh, with build-appimage.sh deliberately
# owning NO copy — release-local.sh's comment stated the design plainly: "a
# plain `export` also reaches build-appimage.sh, which this script invokes as a
# child process later."
#
# That premise holds for exactly one entry point. Run `bin/build-appimage.sh`
# DIRECTLY — which is the documented way to rebuild just the AppImage, and what
# any agent iterating on AppImage packaging actually does — and there is no
# parent to inherit from, so the very same script silently produces a LEAKY
# binary and then fails its own identity gate. The failure lands at the END of a
# full cargo build + a multi-GB AppDir assembly (~10 min in), and its message
# ("prune the leaking file from the sidecar copy") points at the sidecar, not at
# the missing flag, so the diagnosis costs far more than the build did.
# Measured 2026-08-10: standalone build → 691 build-box-$HOME strings in
# usr/bin/papercusp-desktop; the release-cut build of the same commit → 0.
#
# The class of bug is "release-critical build hygiene lives in the CALLER, so
# whether an artifact is shippable depends on which entry point produced it."
# The fix is that the flag travels with the BUILD, not with one of its callers:
# every script that compiles a shipped Rust binary sources this file.
#
# IDEMPOTENT BY DESIGN — the property that makes sourcing it everywhere safe.
# A child that already inherited a remapped RUSTFLAGS must not append a second
# copy: a differing RUSTFLAGS string is a distinct cargo fingerprint, so a
# double-append busts the incremental cache and forces a full rebuild in the
# child. So this is a no-op when a remap is already present, which makes the
# release path (parent exports, child sources) cost exactly nothing.
#
# Cosmetic hygiene, NOT a security fix: these are source paths, never
# credentials. The reason it is load-bearing is the release gate, not secrecy.
#
# Usage (before ANY cargo/tauri build of a shipped binary):
#   . "$DESK/bin/lib/rust-path-remap.sh"
#   papercusp_export_rust_path_remap
#   papercusp_export_rust_lld linux   # or macos for a Darwin target
#
# Guarded by lib/rust-path-remap.selftest.sh (in the run-selftests.sh aggregate).
# Bash 3.2 compatible — the mac VM legs run macOS's /bin/bash 3.2.57.

papercusp_export_rust_path_remap() {
  # Already remapped (we sourced this twice, or a parent exported it) ⇒ no-op.
  case "${RUSTFLAGS:-}" in
    *--remap-path-prefix=*) return 0 ;;
  esac

  # $HOME is what the scan flags; CARGO_HOME defaults under it but can be moved.
  local cargo_home="${CARGO_HOME:-$HOME/.cargo}"
  export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=/build-home --remap-path-prefix=$cargo_home=/build-cargo"
}

# Cargo's target.*.rustflags and the RUSTFLAGS environment variable are
# mutually exclusive. Release producers set RUSTFLAGS for the path remap, so a
# linker flag left only in .cargo/config.toml disappears on the real release
# path. Single-target producers may export the combined flags. A multi-target
# parent (release-local builds native + wasm + Windows + Darwin children) must
# instead compute the native value and pass it only to that native cargo call;
# a cc-driver flag is invalid input to rust-lld's wasm flavor.
#
# The platform is explicit because build-mac-cross.sh runs on Linux while
# producing a Darwin target. Windows has its own native linker/CRT flag path and
# deliberately does not call this helper.
papercusp_rustflags_with_lld() { # $1=linux|macos|darwin  $2=flags (default RUSTFLAGS)
  local platform="${1:-}"
  local flags="${2-${RUSTFLAGS:-}}"
  case "$platform" in
    linux|macos|darwin) ;;
    *) printf '%s' "$flags"; return 0 ;;
  esac

  case " $flags " in
    *" -C link-arg=-fuse-ld=lld "*) printf '%s' "$flags"; return 0 ;;
    *"-C link-arg=-fuse-ld=lld"*) printf '%s' "$flags"; return 0 ;;
  esac

  printf '%s' "$flags -C link-arg=-fuse-ld=lld"
}

# A native producer may already have exported the LLD cc-driver flag before it
# invokes the shared sidecar builder. The sidecar also builds wasm32-wasip1;
# remove only this native-only flag for that cargo call while preserving every
# path remap and unrelated caller flag.
papercusp_rustflags_without_native_lld() { # $1=flags (default RUSTFLAGS)
  local flags="${1-${RUSTFLAGS:-}}"
  flags="${flags//-C link-arg=-fuse-ld=lld/}"
  printf '%s' "$flags"
}

papercusp_export_rust_lld() { # $1=linux|macos|darwin — single-target producers only
  RUSTFLAGS="$(papercusp_rustflags_with_lld "$1" "${RUSTFLAGS:-}")"
  export RUSTFLAGS
}
