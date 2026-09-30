#!/usr/bin/env bash
# Shared LLD linker PATH setup (EI-18105311090526787).
#
# .cargo/config.toml (papercusp-desktop) pins `-fuse-ld=lld` on Linux + macOS
# (WI-5086, see that file's header for the full rationale) using the LLD
# binaries every rustup toolchain since ~Rust 1.71 already bundles at
# `<sysroot>/lib/rustlib/<host-triple>/bin/gcc-ld/{ld.lld,ld64.lld,lld-link,wasm-ld}`.
# rustc's OWN link step resolves that binary by its known sysroot path, so it
# always works — but a C BUILD SCRIPT compiled by the `cc` crate (proc-macro2,
# serde_core, quote, libc, zmij, icu_properties_data, …) links via
# cc→clang/gcc→`-fuse-ld=lld`, and that invocation requires `ld.lld`/`ld64.lld`
# to be resolvable ON PATH — the sysroot dir is NOT on PATH by default on a
# freshly-provisioned box. A COLD build (empty target dir, so every one of
# those build-script crates must compile) hits it immediately: "error: linking
# with `cc` failed: exit status: 1". A WARM build with cached build-script
# output does not re-trigger it, which is why it looks intermittent/box-
# specific rather than a deterministic cold-build failure. Confirmed live
# 2026-07-19 on the mac VM (a truly cold `target/`), building role-server —
# blocked WI-5028/WI-5522.
#
# This dev box's Linux toolchain happens to have a SYSTEM `ld.lld` already on
# PATH (the `lld` apt package), which is why build-linux-local.sh has not hit
# this in practice — but that is incidental to THIS box, not a property of the
# `-fuse-ld=lld` config every cold Linux build (a fresh box/CI image without
# the `lld` package) shares with macOS. Source this from every entrypoint that
# runs a `-fuse-ld=lld` cargo/tauri build (mac-vm-build.sh confirmed;
# build-linux-local.sh defensively) so a cold build never depends on the host
# already happening to have a system-wide `ld.lld`.
#
# Windows is NOT in scope: its cargo config block uses `linker = "rust-lld.exe"`
# directly (not `-fuse-ld=`), a different resolution path entirely, and its
# build runs on the VM via PowerShell (not this bash lib) — see lib/sccache.sh's
# header for the same Windows-gets-its-own-native-equivalent pattern.
#
# Best-effort, like every lib in this directory: a probe/lookup failure just
# means PATH is left unchanged (identical behavior to before this file
# existed) — this must never fail the caller's build. Every caller runs under
# `set -e`/`set -eo pipefail` and sources this INTO its own shell (not a
# subshell), so every step here is guarded.
#
# Usage:
#   source ".../lib/lld-path.sh"
#   setup_lld_path   # prepends the toolchain's gcc-ld dir to PATH, if found
#                     # and ld.lld/ld64.lld isn't already resolvable

setup_lld_path() {
  # Already resolvable (a system package, or a prior call in this same shell
  # chain) — nothing to do.
  if command -v ld.lld >/dev/null 2>&1 || command -v ld64.lld >/dev/null 2>&1; then
    return 0
  fi

  local rustc_bin="${RUSTC:-rustc}"
  command -v "$rustc_bin" >/dev/null 2>&1 || return 0

  local sysroot host_triple gcc_ld_dir
  sysroot="$("$rustc_bin" --print sysroot 2>/dev/null || true)"
  [[ -n "$sysroot" ]] || return 0

  # The host triple's rustlib bin/gcc-ld dir ships ALL of ld.lld/ld64.lld/
  # lld-link/wasm-ld together (they're host tool binaries, not per-target
  # content) — this is the exact dir the bug's verified-fix repro used.
  local vv line
  vv="$("$rustc_bin" -vV 2>/dev/null || true)"
  while IFS= read -r line; do
    if [[ "$line" == host:* ]]; then
      host_triple="${line#host: }"
      break
    fi
  done <<<"$vv"
  [[ -n "$host_triple" ]] || return 0

  gcc_ld_dir="$sysroot/lib/rustlib/$host_triple/bin/gcc-ld"
  if [[ -d "$gcc_ld_dir" ]] && { [[ -x "$gcc_ld_dir/ld.lld" ]] || [[ -x "$gcc_ld_dir/ld64.lld" ]]; }; then
    export PATH="$gcc_ld_dir:$PATH"
    echo "==> lld-path: $gcc_ld_dir prepended to PATH (EI-18105311090526787 — cc-crate build scripts need ld.lld/ld64.lld resolvable, not just rustc's own link step)"
  else
    echo "    WARN: lld-path: no ld.lld/ld64.lld found under $gcc_ld_dir (host_triple=$host_triple) — a cc-crate build script relying on -fuse-ld=lld may fail on a cold build" >&2
  fi
}
