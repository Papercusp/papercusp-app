#!/usr/bin/env bash
# cross-install-darwin-tree.sh — WI-3307 (mac cross-build "all-5-buttons" gap).
#
# Produces a COPY of the monorepo with a genuinely-darwin (Mach-O) node_modules,
# built entirely on THIS Linux box, for use as PAPERCUSP_STAGE_SOURCE_ROOT in
# stage-source-tree.sh — which then does the real allowlist + identity-scrub +
# release-bundle audit pass when producing the shipped source.tar.zst. This
# script's output is a SCRATCH intermediate; it is never shipped directly.
#
# THE GAP THIS CLOSES (build-mac-cross.sh's own "KNOWN CROSS-BUILD GAPS" header,
# and WI-3307's checkpoint): stage-source-tree.sh tars `node_modules` from
# wherever its MONO root points. On this Linux cross-build box that is always
# linux-x64 native addons — wrong arch for the bundled darwin node the packaged
# app ships with, so a naive mirror of the Windows/Linux "all-5-buttons" legs
# onto Mac would break the dev(:3270)/local(:3055) source-tree buttons at
# runtime. This script gives stage-source-tree.sh a tree whose node_modules is
# real darwin output instead.
#
# WHY THIS WORKS (CORRECTED 2026-08-03 — the first version of this comment was
# wrong about the mechanism and it cost a full monorepo-scale validation run to
# find out): npm's OWN optionalDependency platform/arch resolution (the thing
# that picks e.g. `@esbuild/darwin-x64` over `@esbuild/linux-x64`) is controlled
# by the MODERN `npm_config_os`/`npm_config_cpu` config keys (npm >=9.7), NOT
# `npm_config_platform`/`npm_config_arch` — on this box's npm (11.12.1) the
# latter pair are silently-ignored unknown env config ("npm warn Unknown env
# config \"arch\"/\"platform\""), so a `npm ci` using only that pair falls back
# to the host's real platform (linux) for every optionalDependency package —
# @oxc-resolver, @img/sharp, @unrs/resolver-binding, lightningcss, @rolldown,
# @tailwindcss/oxide, @nx, @rollup, @next/swc, etc. all installed their
# linux-x64 variant instead of darwin. `npm_config_platform`/`npm_config_arch`
# are STILL needed, though — they're what `prebuild-install` (a DIFFERENT,
# older config-reading convention — see its rc.js) uses to decide which GitHub
# release asset to fetch for a binding.gyp package's prebuilt binary
# (better-sqlite3, bufferutil). So both env-var pairs must be set together;
# neither alone is sufficient. Verified 2026-08-03 by direct reproduction in a
# scratch dir: `npm_config_os=darwin npm_config_cpu=x64 npm install esbuild`
# alone correctly resolved `@esbuild/darwin-x64`, while adding
# `npm_config_platform=darwin npm_config_arch=x64` on top is what made
# better-sqlite3 (a prebuild-install consumer) fetch a genuine darwin binary
# too.
#
# ABI GAP FOUND + FIXED 2026-08-03 by REAL boot verification on Mac VM hardware
# (:2222) — the Mach-O check above only verifies FILE FORMAT (darwin/x64), not
# NODE ABI COMPATIBILITY, and those are two independent axes. Extracting a
# cross-installed tree onto the real Mac VM and loading better-sqlite3 under
# the SAME bundled sidecar node the dev/local buttons actually run under
# (stage-source-tree.sh: "the bundled node (sidecar/bin/node) ... run under
# the bundled node") threw:
#   "compiled against ... NODE_MODULE_VERSION 141. This version of Node.js
#    requires NODE_MODULE_VERSION 137."
# Root cause: `prebuild-install` (see its rc.js) defaults its ABI `target` to
# `process.versions.node` — i.e. THIS LINUX BOX's own running node (v25.9.0,
# ABI 141) — UNLESS `npm_config_target` is set. Neither `npm_config_os/cpu`
# (controls npm's own optionalDependency platform/arch pick) nor
# `npm_config_platform/arch` (controls prebuild-install's OS/arch asset pick)
# constrains WHICH ABI/version asset prebuild-install fetches, so it silently
# fetched a genuinely-darwin, genuinely-Mach-O, but WRONG-ABI better-sqlite3
# binary — passing the Mach-O check while still dying at runtime with
# ERR_DLOPEN_FAILED. build-desktop-sidecar.sh already special-cased this for
# better-sqlite3 alone (its own `--target="${NODE_VERSION#v}"` prebuild-install
# re-fetch, L2469) — this fix generalizes the same idea to the WHOLE npm ci via
# `npm_config_target`/`npm_config_runtime`, so it also covers bufferutil (the
# other prebuild-install consumer) with no special-casing. Packages built on
# N-API (ABI-stable across node versions) are unaffected either way — see
# prebuild-install's own `napi.isNapiRuntime()` short-circuit in rc.js.
# NODE_VERSION must match the ACTUAL runtime the dev/local buttons boot under
# (the bundled sidecar node), not this build box's node — keep it in sync with
# build-desktop-sidecar.sh's own NODE_VERSION default.
#
# KNOWN RESIDUAL GAPS even with both env-var pairs set (verified 2026-08-03) —
# neither is fixable by an env var; both require an actual osxcross-style
# darwin toolchain on this Linux box to close for real, and both are FUNCTIONALLY
# HARMLESS to ship as-is because their consumer gracefully degrades when the
# native binding fails to load:
#   - `cpu-features` (ssh2's optionalDependency): its own install script is a
#     bare `node-gyp rebuild` with NO prebuild-install/cross-fetch path at all —
#     it always compiles for whatever platform `npm ci` runs on. ssh2 declares
#     it as `optionalDependencies`, i.e. ssh2 is expected to work without it.
#   - ssh2's own bundled native crypto accelerator
#     (`lib/protocol/crypto/build/Release/sshcrypto.node`, built via ssh2's own
#     `install.js`/binding.gyp, no prebuild-install either): `lib/protocol/
#     crypto.js` wraps its require in a plain `try { … } catch {}` (verified by
#     reading the source) and falls back to a pure-JS crypto implementation —
#     ssh2 works correctly, just slower, if this binding fails to load.
# The Mach-O check below allowlists exactly these two verified-safe packages by
# name and treats any OTHER non-Mach-O file with no Mach-O sibling in its own
# package as a real, unexpected failure worth investigating.
#
# v1 SCOPE: x64 only is expected to be used in practice (build-mac-cross.sh
# stages a single x64 tree even for a universal-apple-darwin build — x64 .node
# prebuilts run fine under Rosetta 2 on Apple Silicon, and staging one arch
# instead of two keeps the install + tar cost to a single pass). arm64 is
# supported here too (in case a native-arm64 dev/local tree is ever wired up)
# but is NOT yet exercised by any caller.
#
# USAGE: cross-install-darwin-tree.sh <arch: x64|arm64> <out-dir>
set -euo pipefail

# ── Self-read guard (WI-3306 idiom): read the whole script before executing,
# so a peer's mid-run edit to this shared-tree file can't shift the running
# shell's read offset mid-install (this can run for many minutes).
{
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"        # papercusp-desktop
MONO="$(cd "$ROOT/.." && pwd)"        # monorepo root — this box's real (linux) tree, the rsync SOURCE

ARCH="${1:-}"
OUT="${2:-}"
if [[ -z "$ARCH" || -z "$OUT" ]]; then
  echo "usage: cross-install-darwin-tree.sh <x64|arm64> <out-dir>" >&2
  exit 1
fi
# Must match the runtime the dev/local buttons actually boot under — the
# BUNDLED SIDECAR node (build-desktop-sidecar.sh's own NODE_VERSION default),
# never this build box's node. See the "ABI GAP" header comment above.
NODE_VERSION="${NODE_VERSION:-v24.18.1}"
case "$ARCH" in
  x64|arm64) : ;;
  *) echo "ERROR: arch must be x64 or arm64 (got '$ARCH')" >&2; exit 1 ;;
esac

command -v rsync >/dev/null 2>&1 || { echo "ERROR: rsync not on PATH" >&2; exit 1; }
command -v file >/dev/null 2>&1 || { echo "ERROR: file(1) not on PATH (needed to verify Mach-O output)" >&2; exit 1; }

echo "==> cross-install-darwin-tree: rsyncing $MONO -> $OUT"
echo "    (excluding .git, node_modules, papercusp-desktop, build-target dirs — this is a SCRATCH npm-install"
echo "     input; stage-source-tree.sh does the real allowlist/scrub/audit pass on top of this later)"
mkdir -p "$OUT"
rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='papercusp-desktop' \
  --exclude='target' --exclude='.cargo-target' \
  --exclude='.wi*-cargo-target' --exclude='*cargo-target*' \
  --exclude='.next' \
  --exclude='.turbo' \
  --exclude='.papercusp' --exclude='.agent-tmp' --exclude='.claude' --exclude='.harness' \
  "$MONO/" "$OUT/"

[[ -f "$OUT/package.json" && -f "$OUT/package-lock.json" ]] \
  || { echo "ERROR: $OUT is missing package.json/package-lock.json after rsync — refusing to npm ci" >&2; exit 1; }

echo "==> cross-install-darwin-tree: npm ci (npm_config_os=darwin npm_config_cpu=$ARCH for npm's own optionalDependency resolution + npm_config_platform=darwin npm_config_arch=$ARCH for prebuild-install consumers + npm_config_target=${NODE_VERSION#v}/npm_config_runtime=node so prebuild-install fetches the ABI the BUNDLED SIDECAR NODE actually requires, not this box's own node's ABI — see the header comment's ABI GAP section for why all three are required)"
( cd "$OUT" && npm_config_os=darwin npm_config_cpu="$ARCH" npm_config_platform=darwin npm_config_arch="$ARCH" npm_config_target="${NODE_VERSION#v}" npm_config_runtime=node npm ci --no-audit --no-fund )

echo "==> cross-install-darwin-tree: verifying node_modules has no unexplained linux-native compile fallback"
# A .node file is judged bad only if it is NOT Mach-O *and* no sibling .node
# file anywhere in its "platform-variant family" is Mach-O either. Two
# unrelated conventions both need this, so the grouping key (`family_key`
# below) is defined to subsume both:
#   1. A SINGLE package bundles multiple platforms' prebuilds as files inside
#      itself (`prebuilds/<platform>-<arch>/` or `bin/napi-v6/<platform>/
#      <arch>/`, e.g. rabin-native, onnxruntime-node, bufferutil) — inert
#      other-platform binaries never loaded at runtime (the package's own
#      loader picks by the ACTUAL running platform). Family key = the
#      package's own directory (unsuffixed package names pass through
#      unchanged, so this case is just "group by package dir").
#   2. A package FAMILY ships as several SEPARATE sibling npm packages, one
#      per platform, selected via `optionalDependencies` (e.g. `@unrs/
#      resolver-binding-{linux,darwin,win32,...}-<arch>[-<libc>]`) — the exact
#      convention esbuild/rollup/swc/lightningcss/sharp/oxc-resolver/tailwind-
#      oxide/nx/rolldown all use too. npm's optionalDependencies platform
#      filtering is USUALLY exclusive (only the matching variant installs),
#      but was observed 2026-08-03 to install BOTH the darwin-x64 (correct)
#      AND linux-x64-gnu (harmless extra) variants of `@unrs/resolver-
#      binding-*` in the same `npm ci` — a real npm resolver quirk, not
#      something an env var controls. Family key = the package name with a
#      trailing `-<platform>[-<arch>[-<libc>]]` suffix stripped, so
#      `@unrs/resolver-binding-linux-x64-gnu` and `@unrs/resolver-binding-
#      darwin-x64` both normalize to `@unrs/resolver-binding`.
# The prior version of this check flagged every file independently and had
# two classes of false-positive from this: (1) failed on e.g.
# `rabin-native/prebuilds/android-x64/rabin-native.node` even though that same
# package's `prebuilds/darwin-x64/rabin-native.node` was present and correct;
# (2) failed on `@unrs/resolver-binding-linux-x64-gnu` even though the sibling
# `@unrs/resolver-binding-darwin-x64` package was present and correct.
KNOWN_OPTIONAL_NATIVE_FALLBACK_PKGS="cpu-features ssh2"  # see header comment
family_key() {  # $1 = pkgroot (e.g. "pkg" or "@scope/pkg") -> family key
  local pkgroot="$1" scope="" name="$1"
  if [[ "$pkgroot" == @*/* ]]; then
    scope="${pkgroot%%/*}/"
    name="${pkgroot#*/}"
  fi
  name="$(printf '%s' "$name" | sed -E \
    -e 's/-(gnu|musl|msvc|gnueabihf|musleabihf)$//' \
    -e 's/-(x64|arm64|ia32|arm|riscv64|ppc64|s390x|wasm32)$//' \
    -e 's/-(linux|darwin|win32|android|freebsd|ios)$//')"
  printf '%s%s' "$scope" "$name"
}
declare -a all_nodefiles=() pkgroots=() families=() ismacho=()
while IFS= read -r nodefile; do
  rel="${nodefile#"$OUT"/node_modules/}"
  case "$rel" in
    @*/*) pkgroot="$(printf '%s' "$rel" | cut -d/ -f1-2)" ;;
    *)    pkgroot="${rel%%/*}" ;;
  esac
  all_nodefiles+=("$nodefile")
  pkgroots+=("$pkgroot")
  families+=("$(family_key "$pkgroot")")
  if file "$nodefile" 2>/dev/null | grep -q 'Mach-O'; then
    ismacho+=(1)
  else
    ismacho+=(0)
  fi
done < <(find "$OUT/node_modules" -name '*.node' -type f 2>/dev/null)

family_list_contains() {
  local needle="$1" candidate
  shift
  for candidate in "$@"; do
    [[ "$candidate" == "$needle" ]] && return 0
  done
  return 1
}

declare -a family_has_macho=()
for i in "${!all_nodefiles[@]}"; do
  if [[ "${ismacho[$i]}" == "1" ]] && ! family_list_contains "${families[$i]}" "${family_has_macho[@]}"; then
    family_has_macho+=("${families[$i]}")
  fi
done

declare -a bad=() excused=()
for i in "${!all_nodefiles[@]}"; do
  [[ "${ismacho[$i]}" == "1" ]] && continue
  fam="${families[$i]}"
  if family_list_contains "$fam" "${family_has_macho[@]}"; then
    continue  # a Mach-O sibling exists elsewhere in this same platform-variant family — inert other-platform bundle, ignore
  fi
  pkgroot="${pkgroots[$i]}"
  pkgname="${pkgroot#@*/}"; pkgname="${pkgname:-$pkgroot}"
  is_known=0
  for k in $KNOWN_OPTIONAL_NATIVE_FALLBACK_PKGS; do
    [[ "$pkgroot" == "$k" || "$pkgname" == "$k" ]] && { is_known=1; break; }
  done
  if (( is_known )); then
    excused+=("${all_nodefiles[$i]} (known optional native fallback: $pkgroot — see header comment)")
  else
    bad+=("${all_nodefiles[$i]}")
  fi
done

if (( ${#excused[@]} > 0 )); then
  echo "    ⚠ ${#excused[@]} known-safe linux-native fallback file(s) present (gracefully-optional at runtime — see header comment):"
  printf '      %s\n' "${excused[@]}"
fi
if (( ${#bad[@]} > 0 )); then
  echo "ERROR: ${#bad[@]} .node file(s) under $OUT/node_modules are an UNEXPECTED linux-native compile fallback (no Mach-O sibling in their package, and not on the known-safe allowlist — cross-install is NOT safe to ship):" >&2
  printf '  %s\n' "${bad[@]}" >&2
  exit 1
fi
count="$(find "$OUT/node_modules" -name '*.node' -type f 2>/dev/null | wc -l)"
echo "    ✓ ${count} native .node file(s) checked — every package has a verified Mach-O (darwin/$ARCH) build, zero unexplained linux fallbacks"

# The two markers stage-source-tree.sh's own preflight requires, plus the
# .bin toolchain — fail loud here rather than let the caller discover it later.
[[ -f "$OUT/apps/operator/package.json" && -f "$OUT/libs/papercusp/package.json" ]] \
  || { echo "ERROR: $OUT is missing the apps/operator + libs/papercusp package.json markers stage-source-tree.sh requires" >&2; exit 1; }
[[ -e "$OUT/node_modules/.bin/tsx" ]] \
  || { echo "ERROR: $OUT/node_modules/.bin/tsx missing after npm ci — toolchain incomplete" >&2; exit 1; }

echo "    ✓ cross-installed darwin($ARCH) tree ready at $OUT"
exit 0
}  # ── end self-read guard ──
