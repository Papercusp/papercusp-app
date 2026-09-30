#!/usr/bin/env bash
# rust-path-remap.selftest.sh — regression test for the 2026-08-10 AppImage
# identity-gate failure (EI-20075266271803900's rebuild leg).
#
# THE BUG THIS GUARDS
# -------------------
# The `--remap-path-prefix` flag that strips the build box's $HOME out of a
# shipped Rust binary's embedded source paths lived as an inline `export` in the
# CALLERS (release-local.sh, mac-vm-build.sh, build-mac-cross.sh), and
# build-appimage.sh deliberately owned no copy — it inherited RUSTFLAGS from
# release-local.sh as a child process. So the SAME script produced a shippable
# binary under a release cut and a LEAKY one when run directly (measured: 691
# build-box-$HOME strings vs 0), failing the identity gate ~10 min into the
# build with a message that points at the sidecar, not at the missing flag.
#
# The two properties that fix stays fixed by, and that this test pins:
#
#   1. EVERY script that compiles a shipped Rust binary sets the remap itself,
#      so shippability does not depend on which entry point was used. Asserted
#      structurally (does the script wire up the shared lib?) — a new build
#      script that forgets it fails here rather than at the release gate.
#   2. The helper is IDEMPOTENT. A child that already inherited a remapped
#      RUSTFLAGS must not append a second copy: a differing RUSTFLAGS string is
#      a distinct cargo fingerprint, so a double-append silently busts the
#      incremental cache and forces a full rebuild. This is the property that
#      makes it safe to source everywhere, so it is the one most worth pinning.
#
# Pure-local: sources the real lib in a subshell with a synthetic $HOME and
# inspects the RUSTFLAGS it exports. No cargo, no network, no build. <1s.
#
#   bash bin/lib/rust-path-remap.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$DIR/rust-path-remap.sh"
[ -f "$LIB" ] || { echo "FAIL: $LIB not found"; exit 1; }

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

# Run the helper in a subshell under a controlled env, echo resulting RUSTFLAGS.
remap_under() { # $1=HOME  $2=preset RUSTFLAGS  $3=CARGO_HOME  $4=platform (optional)
  (
    export HOME="$1"
    if [ -n "${2:-}" ]; then export RUSTFLAGS="$2"; else unset RUSTFLAGS; fi
    if [ -n "${3:-}" ]; then export CARGO_HOME="$3"; else unset CARGO_HOME; fi
    # shellcheck disable=SC1090
    . "$LIB" || exit 9
    papercusp_export_rust_path_remap || exit 9
    if [ -n "${4:-}" ]; then
      papercusp_export_rust_lld "$4" || exit 9
    fi
    printf '%s' "${RUSTFLAGS:-}"
  )
}

echo "rust-path-remap.selftest"

# 1. From a clean env it remaps $HOME.
OUT="$(remap_under /home/buildbot '' '')"
case "$OUT" in
  *"--remap-path-prefix=/home/buildbot=/build-home"*) ok "remaps \$HOME from a clean env" ;;
  *) bad "clean env did not remap \$HOME (got: $OUT)" ;;
esac

# 2. CARGO_HOME defaults under $HOME, and an explicitly relocated one is honored.
case "$OUT" in
  *"--remap-path-prefix=/home/buildbot/.cargo=/build-cargo"*) ok "defaults CARGO_HOME to \$HOME/.cargo" ;;
  *) bad "did not remap the default CARGO_HOME (got: $OUT)" ;;
esac
OUT_CH="$(remap_under /home/buildbot '' /mnt/data/cargo)"
case "$OUT_CH" in
  *"--remap-path-prefix=/mnt/data/cargo=/build-cargo"*) ok "honors a relocated CARGO_HOME" ;;
  *) bad "ignored relocated CARGO_HOME (got: $OUT_CH)" ;;
esac

# 3. IDEMPOTENT — the cache-busting property. Sourcing under an already-remapped
#    RUSTFLAGS (the release-cut parent→child case) must change nothing at all.
PRESET="-C target-cpu=native --remap-path-prefix=/home/other=/build-home"
OUT_IDEM="$(remap_under /home/buildbot "$PRESET" '')"
if [ "$OUT_IDEM" = "$PRESET" ]; then
  ok "idempotent: inherited remap left byte-identical (no cargo cache bust)"
else
  bad "appended a second remap onto an inherited one (got: $OUT_IDEM)"
fi

# 4. Pre-existing unrelated RUSTFLAGS are PRESERVED, not clobbered.
OUT_KEEP="$(remap_under /home/buildbot '-C target-cpu=native' '')"
case "$OUT_KEEP" in
  *"-C target-cpu=native"*)
    case "$OUT_KEEP" in
      *"--remap-path-prefix=/home/buildbot=/build-home"*) ok "preserves unrelated RUSTFLAGS while adding the remap" ;;
      *) bad "kept unrelated flags but did not add the remap (got: $OUT_KEEP)" ;;
    esac ;;
  *) bad "clobbered pre-existing RUSTFLAGS (got: $OUT_KEEP)" ;;
esac

# 5. Release linker flags must travel with RUSTFLAGS, not only config.toml.
#    This is the regression that originally prompted the item: once a release
#    producer exports RUSTFLAGS for path remapping, Cargo drops target.*.rustflags
#    from .cargo/config.toml entirely.
OUT_LINUX="$(remap_under /home/buildbot '' '' linux)"
case "$OUT_LINUX" in
  *"-C link-arg=-fuse-ld=lld"*) ok "Linux release flags carry the LLD linker flag" ;;
  *) bad "Linux release flags omitted the LLD linker flag (got: $OUT_LINUX)" ;;
esac
OUT_MAC="$(remap_under /home/buildbot '' '' macos)"
case "$OUT_MAC" in
  *"-C link-arg=-fuse-ld=lld"*) ok "macOS release flags carry the LLD linker flag" ;;
  *) bad "macOS release flags omitted the LLD linker flag (got: $OUT_MAC)" ;;
esac
OUT_REMAP_ONLY="$(remap_under /home/buildbot "$PRESET" '' linux)"
case "$OUT_REMAP_ONLY" in
  *"--remap-path-prefix=/home/other=/build-home"*"-C link-arg=-fuse-ld=lld"*) ok "adds LLD even when remap was inherited" ;;
  *) bad "inherited remap suppressed the LLD linker flag (got: $OUT_REMAP_ONLY)" ;;
esac
PRESET_LLD="$PRESET -C link-arg=-fuse-ld=lld"
OUT_LLD_IDEM="$(remap_under /home/buildbot "$PRESET_LLD" '' linux)"
if [ "$OUT_LLD_IDEM" = "$PRESET_LLD" ]; then
  ok "idempotent: inherited LLD flag is not duplicated"
else
  bad "duplicated an inherited LLD flag (got: $OUT_LLD_IDEM)"
fi

# Multi-target release parents compute a native-only value without contaminating
# their ambient remap flags, and the shared sidecar removes that native flag for
# wasm32-wasip1 while retaining the remaps.
SCOPED_PAIR="$({
  export RUSTFLAGS="$PRESET"
  . "$LIB" || exit 9
  printf '%s\n' "$RUSTFLAGS"
  papercusp_rustflags_with_lld linux "$RUSTFLAGS"
})"
SCOPED_AMBIENT="${SCOPED_PAIR%%$'\n'*}"
SCOPED_NATIVE="${SCOPED_PAIR#*$'\n'}"
if [ "$SCOPED_AMBIENT" = "$PRESET" ] && [[ "$SCOPED_NATIVE" == *"-C link-arg=-fuse-ld=lld"* ]]; then
  ok "multi-target parent computes native LLD flags without mutating ambient RUSTFLAGS"
else
  bad "native LLD scoping mutated ambient flags or omitted LLD (ambient=$SCOPED_AMBIENT native=$SCOPED_NATIVE)"
fi
WASM_FLAGS="$({ . "$LIB" || exit 9; papercusp_rustflags_without_native_lld "$SCOPED_NATIVE"; })"
if [[ "$WASM_FLAGS" == *"--remap-path-prefix=/home/other=/build-home"* ]] && [[ "$WASM_FLAGS" != *"-fuse-ld=lld"* ]]; then
  ok "wasm flags retain path remapping while removing the native-only LLD selector"
else
  bad "wasm flag sanitizer lost remapping or retained native LLD (got: $WASM_FLAGS)"
fi

SIDECAR_SCRIPT="$DIR/../build-desktop-sidecar.sh"
# The wasm build is written as a multi-line env-prefix block (RUSTFLAGS=... \ then
# the cargo line), so a LINE-oriented grep for the whole command is a false miss
# even though the sanitized flags are plainly in effect. Join backslash
# continuations first, then require the assignment and the build on ONE logical
# line — matching them anywhere in the file would pass on two unrelated sites.
# No `| grep -q`: an early-exiting consumer here would trip the pipefail
# predicate gate in run-selftests.sh, and carries the SIGPIPE false-miss it bans.
SIDECAR_JOINED="$(sed -e ':a' -e '/\\$/{N; s/\\\n[[:space:]]*/ /; ta}' "$SIDECAR_SCRIPT")"
SIDECAR_WASM_OK=0
while IFS= read -r _sidecar_line; do
  case "$_sidecar_line" in
    *'RUSTFLAGS="$_PUI_WASM_RUSTFLAGS"'*'cargo build --release --target wasm32-wasip1'*)
      SIDECAR_WASM_OK=1 ;;
  esac
done <<<"$SIDECAR_JOINED"
if [[ "$SIDECAR_JOINED" == *papercusp_rustflags_without_native_lld* ]] && [ "$SIDECAR_WASM_OK" -eq 1 ]; then
  ok "sidecar wasm build uses the native-LLD sanitizer"
else
  bad "sidecar wasm build bypasses the native-LLD sanitizer"
fi

CONFIG="$DIR/../../.cargo/config.toml"
if [ -f "$CONFIG" ] && grep -q -- 'link-arg=-fuse-ld=lld' "$CONFIG"; then
  ok ".cargo/config.toml keeps the bare-cargo LLD fallback"
else
  bad ".cargo/config.toml lost its bare-cargo LLD fallback"
fi

# 6. A salvage cut sources the current release-local.sh while $0 deliberately
#    names the frozen release-worktree entrypoint. The target tree may carry an
#    older helper revision, so release-local must resolve its OWN sourced libs
#    through BASH_SOURCE[0], while it continues to build/collect through $0.
#
#    Reproduce that exact shape with a foreign target tree whose helper files
#    are fatal sentinels. An invalid version makes the real script exit at its
#    normal early validation gate, before any release mutation. Exit 1 proves
#    canonical helpers loaded; exit 97 proves a stale target helper leaked in.
RELEASE_SCRIPT="$DIR/../release-local.sh"
FOREIGN_ROOT="$(mktemp -d)"
mkdir -p "$FOREIGN_ROOT/bin/lib"
for STALE_LIB in gen-latest-manifest.sh release-tag-pin.sh rust-path-remap.sh; do
  printf '%s\n' 'echo "STALE TARGET HELPER SOURCED" >&2' 'exit 97' > "$FOREIGN_ROOT/bin/lib/$STALE_LIB"
done
OUT_FOREIGN="$(bash -c 'canonical=$1; shift; source "$canonical"' \
  "$FOREIGN_ROOT/bin/release-local.sh" "$RELEASE_SCRIPT" invalid alpha 2>&1)"
STATUS_FOREIGN=$?
rm -rf "$FOREIGN_ROOT"
if [ "$STATUS_FOREIGN" -eq 1 ] && [[ "$OUT_FOREIGN" == *"version must look like"* ]] && [[ "$OUT_FOREIGN" != *"STALE TARGET HELPER"* ]]; then
  ok "foreign-\$0 salvage loads orchestration helpers from BASH_SOURCE, not the stale target tree"
else
  bad "foreign-\$0 salvage mixed target-tree helpers into canonical orchestration (status=$STATUS_FOREIGN output=$OUT_FOREIGN)"
fi

# 7. THE STRUCTURAL GUARD — every script that compiles a shipped Rust binary
#    must set the remap itself rather than trust an ambient export. A new build
#    script that forgets it fails HERE, in <1s, instead of at the identity gate
#    ~10 min into a real build (or, worse, shipping a leaky artifact).
#
#    Accepts EITHER wiring: sourcing this lib (preferred), or a self-contained
#    inline `--remap-path-prefix` export (what the mac legs still carry). The
#    point is that the script does not depend on a caller.
for SCRIPT in build-appimage.sh release-local.sh mac-vm-build.sh build-mac-cross.sh build-linux-local.sh build-and-archive-deb.sh; do
  P="$DIR/../$SCRIPT"
  if [ ! -f "$P" ]; then
    bad "$SCRIPT missing — update this list if it was renamed/removed"
    continue
  fi
  if grep -q 'papercusp_export_rust_path_remap' "$P"; then
    ok "$SCRIPT sources the shared remap lib"
  elif grep -q -- '--remap-path-prefix' "$P"; then
    ok "$SCRIPT carries its own inline remap export"
  else
    bad "$SCRIPT compiles a shipped binary but sets NO path remap — it would inherit one only by luck (see lib/rust-path-remap.sh)"
  fi
  if grep -Eq 'papercusp_(export_rust_lld|rustflags_with_lld)[[:space:]]+(linux|macos|darwin)' "$P"; then
    ok "$SCRIPT carries or scopes its platform LLD flag with RUSTFLAGS"
  else
    bad "$SCRIPT has no platform LLD export — its RUSTFLAGS would suppress .cargo/config.toml"
  fi
done

if [ "$FAILS" -eq 0 ]; then echo "PASS"; exit 0; fi
echo "FAIL ($FAILS)"; exit 1
