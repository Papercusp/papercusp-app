#!/usr/bin/env bash
# Fast LOCAL Windows-cfg compile gate (WI-2215).
#
# WHY THIS EXISTS
# The desktop's Windows-only Rust — ~68 `#[cfg(target_os = "windows")]` /
# `#[cfg(windows)]` regions across main.rs, wsl_setup.rs, native_console.rs,
# pty.rs, custom_protocol.rs, endpoint_ipc.rs, dev_bridge.rs,
# native_terminal.rs — is INVISIBLE to a default `cargo check` on this Linux
# box (that target compiles the `cfg(not(windows))` half). So a type / import /
# borrow / name error inside a Windows-only block can compile clean here and
# remain hidden until a Windows-targeted build. This gate compiles those exact
# blocks on THIS box in ~40 s. It is a
# manual-only check: the retired QEMU VM producer no longer invokes it.
#
# HOW
# `cargo check --target x86_64-pc-windows-msvc` alone does NOT work: the graph
# pulls in `ring` (and friends), whose build SCRIPT compiles C/asm and needs
# the MSVC librarian `lib.exe` — absent on Linux, so cargo aborts at `ring`
# before it ever reaches our crate. `cargo-xwin` fixes exactly that: it shims
# clang-cl / llvm-lib / llvm-rc in for the MSVC tools and downloads the MSVC
# CRT + Windows SDK (one-time, cached under ~/.cache/cargo-xwin). `check` emits
# metadata only (no link), so no real MSVC linker is needed.
#
# This is a metadata check, NOT a build — it will NOT produce a runnable .exe.
# It catches the compile-error class before a Windows cross-build or release
# build, without requiring a VM round-trip.
#
# ONE-TIME SETUP (this script checks for each and prints the exact command):
#   rustup target add x86_64-pc-windows-msvc
#   sudo apt-get install -y --no-install-recommends clang lld llvm   # cargo-xwin's toolchain
#   cargo install cargo-xwin
#
# USAGE
#   bin/check-windows-cfg.sh                       # check papercusp-desktop for windows-msvc
#   bin/check-windows-cfg.sh --message-format short # extra args pass through to cargo
#
# Exit code is cargo's: 0 = the Windows-cfg surface compiles, non-zero = it does
# not (with the errors printed). Run it manually before a Windows cross-build
# or after editing any cfg(windows) code. It is deliberately NOT wired into the
# green-checkpoint suite: it needs cargo-xwin + the SDK, which not every dev/CI
# box has.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TARGET="x86_64-pc-windows-msvc"
CRATE="papercusp-desktop"

hint() { echo "  → $*" >&2; }

missing=0
if ! rustup target list --installed 2>/dev/null | grep -qx "$TARGET"; then
  echo "MISSING: rustup target '$TARGET' is not installed." >&2
  hint "rustup target add $TARGET"
  missing=1
fi
if ! command -v clang >/dev/null 2>&1; then
  echo "MISSING: clang/lld/llvm (cargo-xwin uses clang-cl + llvm-lib + llvm-rc as the MSVC shims)." >&2
  hint "sudo apt-get install -y --no-install-recommends clang lld llvm"
  missing=1
fi
if ! command -v cargo-xwin >/dev/null 2>&1; then
  echo "MISSING: cargo-xwin." >&2
  hint "cargo install cargo-xwin"
  missing=1
fi
if [[ "$missing" -ne 0 ]]; then
  echo "" >&2
  echo "Install the above, then re-run: bin/check-windows-cfg.sh" >&2
  exit 2
fi

cd "$ROOT/src-tauri"

echo "[check-windows-cfg] cargo xwin check --target $TARGET -p $CRATE  (compiles the cfg(windows) surface Linux skips)"
start=$(date +%s)
# XWIN_ACCEPT_LICENSE=1: accept the redistributable MSVC CRT/SDK license
# non-interactively (first run downloads it; cached thereafter).
if XWIN_ACCEPT_LICENSE=1 CARGO_TERM_COLOR="${CARGO_TERM_COLOR:-never}" \
     cargo xwin check --target "$TARGET" -p "$CRATE" "$@"; then
  echo "[check-windows-cfg] PASS — Windows-cfg surface compiles ($(( $(date +%s) - start ))s)"
else
  rc=$?
  echo "[check-windows-cfg] FAIL — Windows-cfg compile error(s) above ($(( $(date +%s) - start ))s). Fix before the Windows cross-build." >&2
  exit "$rc"
fi
