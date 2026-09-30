#!/usr/bin/env bash
# Shared sccache setup (WI-5083, plan desktop-build-speed-2026-07-16#P-004).
#
# Puts a compiler cache in front of every rustc invocation on the LOCAL Linux
# leg (release-local.sh's Linux subshell + build-linux-local.sh) and the
# Darwin VM leg (mac-vm-build.sh), backed by a PERSISTENT on-disk cache — so
# even a from-scratch `tauri build` (a clean checkout, a rotated
# ~/.cargo-target, a freshly-reverted VM snapshot) reuses object code already
# compiled from an earlier build instead of recompiling every crate from
# zero. sccache keys on the PREPROCESSED source + compiler flags, not on the
# mtime/location of the source tree, so it survives across checkouts in a way
# cargo's own incremental cache (keyed to a specific target-dir) cannot.
#
# The Windows leg gets its own PowerShell-native equivalent inline in
# build-windows-on-vm.sh (Ensure-Sccache) — this is a *bash* lib, and sourcing
# it over ssh into a cmd/powershell VM session isn't a thing.
#
# Best-effort THROUGHOUT: sccache absent/uninstallable just means no
# RUSTC_WRAPPER gets exported (identical behavior to before this file
# existed). This must never fail a release build — install/version-probe
# failures are WARN, not fatal. Effectiveness (hit-rate, before/after delta)
# is measured separately — WI-5084.
#
# ⚠ EVERY filesystem-mutating step below (mkdir/cp/chmod) is guarded so a
# failure DEGRADES instead of propagating. This is not optional politeness:
# every caller of this lib runs under `set -e` (release-local.sh,
# build-linux-local.sh, mac-vm-build.sh), and this function executes SOURCED
# — in the caller's own shell, not a subshell — so an unguarded failing
# command in here would abort the ENTIRE release build, not just skip the
# cache. Confirmed live (WI-5084 investigation, 2026-07-16): some sandboxed
# execution contexts on this fleet mount $HOME read-only (only a project
# checkout + /tmp are writable) — `mkdir -p "$HOME/.local/bin"` and
# `mkdir -p "$HOME/.cache/sccache"` both fail there. An unguarded version of
# this lib would have crash-looped every release build run from such a
# context; every mutating step here is now wrapped so that class of
# environment just silently skips RUSTC_WRAPPER instead.
#
# Usage:
#   source ".../lib/sccache.sh"
#   setup_sccache_env   # exports RUSTC_WRAPPER / SCCACHE_DIR / SCCACHE_CACHE_SIZE
#                        # / CARGO_INCREMENTAL=0 when sccache is available
#
# setup_sccache_env accepts one optional arg: a default SCCACHE_CACHE_SIZE
# (e.g. "10G") — pass a SMALLER cap on a disk-tight build VM than on this
# spacious dev box. SCCACHE_CACHE_SIZE in the caller's env always wins.

# Pinned release (github.com/mozilla/sccache/releases) — bump deliberately;
# re-verify effectiveness after a bump (WI-5084).
SCCACHE_LIB_VERSION="${SCCACHE_LIB_VERSION:-0.16.0}"

setup_sccache_env() {
  # desktop-build-speed-2026-07-16 D-006 / WI-5577: sccache is OPT-IN, default OFF.
  # WHY: the block below exports CARGO_INCREMENTAL=0 (sccache and cargo incremental
  # cancel — running both splits the hit-rate between two caches), and that env var
  # OVERRIDES src-tauri/Cargo.toml [profile.release] incremental=true — the warm-rebuild
  # lever (P-002 measured ~4.4s warm vs 143s cold full recompile; the plan's biggest win,
  # D-002). The whole rail keeps role target-dirs WARM (P-001) and WI-5027 removed the
  # ENOSPC that used to force cold builds, so cold builds — sccache's only real benefit —
  # are now RARE (D-005). Defaulting sccache ON therefore REGRESSED the common warm
  # rebuild. So default to the incremental warm path; enable sccache only for an explicit
  # cold/clean build via PAPERCUSP_USE_SCCACHE=1.
  case "${PAPERCUSP_USE_SCCACHE:-0}" in
    1|true|yes|on) : ;; # opt-in: wire sccache (disables incremental — best for a genuine cold build)
    *)
      echo "==> sccache: OFF by default — incremental warm-rebuild is the fast path (set PAPERCUSP_USE_SCCACHE=1 for a cold/clean build); RUSTC_WRAPPER unset, CARGO_INCREMENTAL left to [profile.release] incremental=true"
      return 0
      ;;
  esac
  local default_cache_size="${1:-30G}"
  local sccache_bin
  sccache_bin="$(command -v sccache || true)"

  if [[ -z "$sccache_bin" && -x "$HOME/.local/bin/sccache" ]]; then
    export PATH="$HOME/.local/bin:$PATH"
    sccache_bin="$HOME/.local/bin/sccache"
  fi

  if [[ -z "$sccache_bin" ]]; then
    echo "==> sccache: not on PATH — installing a static binary into ~/.local/bin (WI-5083, pinned v${SCCACHE_LIB_VERSION})"
    local os target tmp asset
    os="$(uname -s)"
    case "$os" in
      Darwin)
        case "$(uname -m)" in
          arm64|aarch64) target="aarch64-apple-darwin" ;;
          *)              target="x86_64-apple-darwin" ;;
        esac
        ;;
      Linux)
        case "$(uname -m)" in
          aarch64) target="aarch64-unknown-linux-musl" ;;
          x86_64)  target="x86_64-unknown-linux-musl" ;;
          *)       target="" ;;
        esac
        ;;
      *) target="" ;;
    esac
    if [[ -n "$target" ]]; then
      asset="sccache-v${SCCACHE_LIB_VERSION}-${target}.tar.gz"
      tmp="$(mktemp -d 2>/dev/null || true)"
      if [[ -n "$tmp" ]] \
         && curl -fsSL "https://github.com/mozilla/sccache/releases/download/v${SCCACHE_LIB_VERSION}/${asset}" \
              -o "$tmp/sccache.tar.gz" 2>/dev/null \
         && tar -xzf "$tmp/sccache.tar.gz" -C "$tmp" 2>/dev/null; then
        local extracted
        extracted="$(find "$tmp" -maxdepth 2 -type f -name sccache 2>/dev/null | head -1)"
        # Guarded as ONE && chain inside an `if` — a failure at any step (a
        # read-only $HOME being the observed real-world case) short-circuits
        # into the `else` below instead of tripping the caller's `set -e`.
        if [[ -n "$extracted" ]] \
           && mkdir -p "$HOME/.local/bin" 2>/dev/null \
           && cp "$extracted" "$HOME/.local/bin/sccache" 2>/dev/null \
           && chmod +x "$HOME/.local/bin/sccache" 2>/dev/null; then
          export PATH="$HOME/.local/bin:$PATH"
          sccache_bin="$HOME/.local/bin/sccache"
        fi
      fi
      [[ -n "$tmp" ]] && rm -rf "$tmp" 2>/dev/null
    fi
    if [[ -n "$sccache_bin" ]]; then
      echo "    ✓ sccache installed → $sccache_bin ($("$sccache_bin" --version 2>/dev/null || echo "v${SCCACHE_LIB_VERSION}"))"
    else
      echo "    WARN: could not install sccache (os=$os target=${target:-<unsupported>}) — continuing without RUSTC_WRAPPER; this build will recompile every crate (WI-5083 benefit skipped this run)"
    fi
  fi

  if [[ -n "$sccache_bin" ]]; then
    local cache_dir="${SCCACHE_DIR:-$HOME/.cache/sccache}"
    # Guarded the same way as the install steps above: a read-only $HOME
    # (confirmed real on this fleet, see the file header) must degrade this
    # to "no cache dir, no wrapper" — never abort the caller's build.
    if mkdir -p "$cache_dir" 2>/dev/null; then
      export RUSTC_WRAPPER="$sccache_bin"
      export SCCACHE_DIR="$cache_dir"
      export SCCACHE_CACHE_SIZE="${SCCACHE_CACHE_SIZE:-$default_cache_size}"
      # sccache's own cache and cargo's incremental cache both try to skip
      # recompiling the same code, keyed differently — running both splits
      # the hit-rate between two caches instead of maximizing one. Upstream
      # sccache guidance is to disable cargo incremental when
      # RUSTC_WRAPPER=sccache.
      export CARGO_INCREMENTAL=0
      echo "==> sccache: RUSTC_WRAPPER=$RUSTC_WRAPPER SCCACHE_DIR=$SCCACHE_DIR SCCACHE_CACHE_SIZE=$SCCACHE_CACHE_SIZE CARGO_INCREMENTAL=0"
    else
      echo "    WARN: sccache binary found ($sccache_bin) but its cache dir ($cache_dir) is not writable — continuing without RUSTC_WRAPPER"
    fi
  fi
}
