#!/usr/bin/env bash
# Build one public PUI release archive from ONE committed source generation
# (pui-first-party-public-release P-011 / D-016).
#
# The unit is the same one the desktop sidecar ships (bin/pui + pui-companion.wasm
# + a release-relative pui-install.json, built with the sidecar's stamps and
# remap flags), plus the version-matched zellij, psu on a private pinned Node
# (bin/psu → lib/node + lib/psu, D-031), the documents and a digest of every
# file. Everything that goes into the archive — sources, templates and the
# manifest/license tooling — is read from `git archive <sha>`, never from the
# working tree, so an uncommitted edit cannot reach a release. psu is bundled
# by bundle-psu.mjs, which serves every first-party byte from git at <sha> and
# checks every npm package against that commit's package-lock.json.
#
# Reproducible by construction: SOURCE_DATE_EPOCH is the commit time, the
# source tree is exported to one constant absolute path, paths are remapped,
# and the tar/gzip stream is normalised. Build it twice and compare.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: apps/tui/scripts/package-release.sh [options]

  --target <t>     linux-x86_64 | macos-aarch64 | macos-x86_64 (default: this host)
  --sha <rev>      committed source generation to build (default: HEAD)
  --out <dir>      where the archive and SHA256SUMS go (default: dist/pui)
  --sign-key <f>   minisign secret key; writes <archive>.minisig
                   (or set PUI_RELEASE_MINISIGN_KEY)
  --keep-work      keep the temporary build tree and print its path

Environment:
  PUI_PACKAGE_TARGET_DIR   cargo target dir for release builds
                           (default: <cargo's configured target dir>/pui-package)
  PUI_LINUX_GLIBC          glibc floor for linux targets (default 2.31; needs zig)
  PAPERCUSP_ZIG_DIR        zig for cross builds (default ~/.papercusp/zig)

Prints one line `PUI_PACKAGE_RESULT {json}` describing the archive.
EOF
}

die() {
  echo "package-release: ERROR: $*" >&2
  exit 1
}

TARGET=""
REV="HEAD"
OUT=""
SIGN_KEY="${PUI_RELEASE_MINISIGN_KEY:-}"
KEEP_WORK=0
while (($#)); do
  case "$1" in
    --target) TARGET="${2:?--target needs a value}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --sha) REV="${2:?--sha needs a value}"; shift 2 ;;
    --sha=*) REV="${1#*=}"; shift ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --out=*) OUT="${1#*=}"; shift ;;
    --sign-key) SIGN_KEY="${2:?--sign-key needs a value}"; shift 2 ;;
    --sign-key=*) SIGN_KEY="${1#*=}"; shift ;;
    --keep-work) KEEP_WORK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT="${OUT:-$ROOT/dist/pui}"
for tool in cargo git python3 node curl sha256sum tar gzip; do
  command -v "$tool" >/dev/null || die "missing required tool: $tool"
done

case "$(uname -s)" in Linux) host_os=linux ;; Darwin) host_os=macos ;; *) host_os=unknown ;; esac
case "$(uname -m)" in x86_64|amd64) host_arch=x86_64 ;; arm64|aarch64) host_arch=aarch64 ;; *) host_arch=unknown ;; esac
TARGET="${TARGET:-$host_os-$host_arch}"

# zellij 0.44.3 — the companion plugin API is version-coupled, so this is pinned
# exactly. Digests are of the zellij BINARY and equal the upstream-published
# zellij-<triple>.sha256sum (cross-checked 2026-09-23 for all three).
ZJ_VER=0.44.3
# Node — the private runtime psu runs on (D-031), the same pin as the desktop
# sidecar (build-desktop-sidecar.sh NODE_VERSION). Digests are of the upstream
# tarballs and equal nodejs.org's SHASUMS256.txt for this version (2026-09-26).
NODE_VER=v24.18.1
case "$TARGET" in
  linux-x86_64)
    RUST_TRIPLE=x86_64-unknown-linux-gnu
    ZJ_TRIPLE=x86_64-unknown-linux-musl
    ZJ_SHA256=397481870c4fc3bae646cd7613cde3a1cebdc204558a6cb9a7c603d4c852fc90
    NODE_PLATFORM=linux-x64
    NODE_SHA256=9f5eb6ac21845a66c493c91a253b1da32fd684e89e9b7202d4936982336be4ca
    ;;
  macos-aarch64)
    RUST_TRIPLE=aarch64-apple-darwin
    ZJ_TRIPLE=aarch64-apple-darwin
    ZJ_SHA256=99700a8c0afcf58f05651ccf543f9a84101dd2ea222c8e1cb06b57689425d693
    NODE_PLATFORM=darwin-arm64
    NODE_SHA256=eb02f7fab96d3d67de40c5ec8566096fcb4c2026728787683ae5a97eb612b941
    ;;
  macos-x86_64)
    RUST_TRIPLE=x86_64-apple-darwin
    ZJ_TRIPLE=x86_64-apple-darwin
    ZJ_SHA256=42dca16e7c852dd9c45485bb73457e090463b41ba8fade272b779ac33d54e642
    NODE_PLATFORM=darwin-x64
    NODE_SHA256=6fb20fceacbb157c2f95825b80df4a454a0f6d81cdcd7bb81eeae9147e0e76ec
    ;;
  *) die "unsupported target $TARGET (linux-x86_64 | macos-aarch64 | macos-x86_64)" ;;
esac
ZJ_LICENSE_SHA256=9aa6c363b18a48eeecbffe13ff390c76ede2c90eb37ba17dfbbaffc42892d87d

# ── the committed source generation ─────────────────────────────────────────
SHA="$(git -C "$ROOT" rev-parse --verify --quiet "$REV^{commit}")" || die "$REV is not a commit"
EPOCH="$(git -C "$ROOT" show -s --format=%ct "$SHA")"
VERSION="$(git -C "$ROOT" show "$SHA:apps/tui/Cargo.toml" | sed -n 's/^version = "\(.*\)"$/\1/p' | head -1)"
[[ -n "$VERSION" ]] || die "could not read the pui version from $SHA:apps/tui/Cargo.toml"
NAME="pui-$VERSION-$TARGET"

# The source tree is exported to ONE constant absolute path, whatever the
# target dir, user or machine. Cargo hashes the absolute path of a path
# dependency outside the building workspace (apps/pui-companion-proto, for both
# apps/tui and apps/pui-zellij-plugin) into -C metadata, which renames and
# reorders every symbol of the crates that depend on it: exporting under the
# target dir made two builds of one commit differ byte-for-byte. The same path
# also keeps RUSTFLAGS (which remaps it) constant, and RUSTFLAGS is part of
# every crate's cargo fingerprint, so warm builds stay warm. Because the path
# is shared, one packager runs per machine at a time (flock).
SRC=/tmp/pui-release-src
if command -v flock >/dev/null; then
  exec 7>"$SRC.lock"
  flock 7 || die "could not lock $SRC.lock"
fi
if [[ -z "${PUI_PACKAGE_TARGET_DIR:-}" ]]; then
  base_target="$(cd "$ROOT/apps/tui" && cargo metadata --format-version 1 --no-deps --offline 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])' || true)"
  PUI_PACKAGE_TARGET_DIR="${base_target:-$ROOT/apps/tui/target}/pui-package"
fi
mkdir -p "$PUI_PACKAGE_TARGET_DIR"
export CARGO_TARGET_DIR="$(cd "$PUI_PACKAGE_TARGET_DIR" && pwd)"
WORK="$CARGO_TARGET_DIR/work"
cleanup() {
  if ((KEEP_WORK)); then
    echo "package-release: kept work tree $WORK and source $SRC" >&2
  else
    rm -rf "$WORK" "$SRC"
  fi
}
trap cleanup EXIT
rm -rf "$WORK" "$SRC" || die "could not clear $SRC (owned by another user?)"
mkdir -p "$WORK" "$SRC"
git -C "$ROOT" archive --format=tar "$SHA" apps/tui apps/pui-zellij-plugin apps/pui-companion-proto \
    apps/operator/bin/bundle-host-common.sh packages/omp-plugin/build-native.mjs \
  | tar -x -C "$SRC"
for required in apps/tui/release/install.sh apps/tui/release/compatibility.json apps/tui/release/psu \
                apps/tui/scripts/write-install-manifest.py apps/tui/scripts/license-inventory.py \
                apps/tui/scripts/bundle-psu.mjs; do
  [[ -f "$SRC/$required" ]] || die "$required is not in commit $SHA; commit the release tooling first"
done
# git archive records a submodule as a gitlink and cannot export files inside it.
# Resolve the first-party license from the exact agent-chat commit pinned by this
# release's superproject commit, never from the submodule's moving worktree.
LICENSE_SHA="$(git -C "$ROOT" rev-parse --verify "$SHA:libs/agent-chat")" \
  || die "could not resolve the agent-chat license pin from $SHA"
# A caller may set GIT_DIR to a throwaway superproject object store (the
# compatibility-claim regression does this). Resolve the pinned gitlink above
# through that store, then clear its Git environment when reading the submodule.
# Otherwise Git ignores -C and looks for LICENSE in the superproject store.
( unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
  git -C "$ROOT/libs/agent-chat" cat-file -e "$LICENSE_SHA:LICENSE" \
    || die "agent-chat $LICENSE_SHA has no LICENSE file"
  git -C "$ROOT/libs/agent-chat" show "$LICENSE_SHA:LICENSE" > "$WORK/PUI_LICENSE"
)
# compatibility.json is committed before the candidate it ships in exists, so it
# can never hold that candidate's installed-product evidence: a 'verified' target
# there is always evidence of another generation (R-10). Refused before anything
# is built; verified targets are advertised per candidate at the release stage.
VERIFIED="$(python3 -c 'import json, sys
print(" ".join(n for n, t in json.load(open(sys.argv[1]))["targets"].items() if t.get("status") == "verified"))' \
  "$SRC/apps/tui/release/compatibility.json")" || die "could not read compatibility.json from $SHA"
[[ -z "$VERIFIED" ]] || die "compatibility.json in ${SHA:0:12} marks $VERIFIED verified, but installed evidence for this candidate cannot exist before it is built; record it at the release stage, not in the committed file"
echo "→ packaging $NAME from ${SHA:0:12} (commit time $EPOCH)"

# ── build ───────────────────────────────────────────────────────────────────
export SOURCE_DATE_EPOCH="$EPOCH"
export PUI_BUILD_SHA="$SHA" PUI_BUILD_DIRTY=0 PUI_BUILD_EPOCH="$EPOCH"
# Later prefixes win in rustc: the source tree last, so it never reads as /build or /target.
REMAP="--remap-path-prefix=$HOME=/build --remap-path-prefix=$CARGO_TARGET_DIR=/target --remap-path-prefix=$SRC=/pui-src"

ZIG_DIR="${PAPERCUSP_ZIG_DIR:-$HOME/.papercusp/zig}"
ZIG_VERSION=""
if [[ -x "$ZIG_DIR/zig" ]]; then
  ZIG_VERSION="$("$ZIG_DIR/zig" version)"
fi

echo "→ building the companion (wasm32-wasip1)…"
( cd "$SRC/apps/pui-zellij-plugin" && RUSTFLAGS="$REMAP" \
    cargo build --release --locked --target wasm32-wasip1 )
WASM="$CARGO_TARGET_DIR/wasm32-wasip1/release/pui_companion.wasm"
[[ -f "$WASM" ]] || die "companion build did not produce $WASM"
export PUI_COMPANION_SHA256="$(sha256sum "$WASM" | cut -d' ' -f1)"

GLIBC_REQUEST=""
case "$TARGET" in
  linux-*)
    if [[ "$host_os" == linux && -n "$ZIG_VERSION" ]] && command -v cargo-zigbuild >/dev/null; then
      GLIBC_REQUEST="${PUI_LINUX_GLIBC:-2.31}"
      echo "→ building pui for $RUST_TRIPLE against glibc $GLIBC_REQUEST (cargo zigbuild)…"
      ( cd "$SRC/apps/tui" && PATH="$ZIG_DIR:$PATH" RUSTFLAGS="$REMAP" \
          cargo zigbuild --release --locked --target "$RUST_TRIPLE.$GLIBC_REQUEST" )
    else
      [[ "$host_os-$host_arch" == "$TARGET" ]] || die "cross-building $TARGET needs zig at $ZIG_DIR and cargo-zigbuild"
      echo "→ building pui for $RUST_TRIPLE (host glibc; no zig to pin an older floor)…"
      ( cd "$SRC/apps/tui" && RUSTFLAGS="$REMAP" cargo build --release --locked --target "$RUST_TRIPLE" )
    fi
    ;;
  macos-*)
    if [[ "$host_os" == macos ]]; then
      ( cd "$SRC/apps/tui" && RUSTFLAGS="$REMAP" cargo build --release --locked --target "$RUST_TRIPLE" )
    else
      [[ -n "$ZIG_VERSION" ]] || die "cross-building $TARGET needs zig at $ZIG_DIR"
      SDKROOT="${SDKROOT:-$HOME/.papercusp/macos-sdk/MacOSX.sdk}"
      [[ -d "$SDKROOT" ]] || die "cross-building $TARGET needs a macOS SDK at $SDKROOT"
      echo "→ cross-building pui for $RUST_TRIPLE (cargo zigbuild, SDK $SDKROOT)…"
      ( cd "$SRC/apps/tui" && PATH="$ZIG_DIR:$PATH" SDKROOT="$SDKROOT" RUSTFLAGS="$REMAP" \
          cargo zigbuild --release --locked --target "$RUST_TRIPLE" )
    fi
    ;;
esac
PUI_BIN="$CARGO_TARGET_DIR/$RUST_TRIPLE/release/pui"
PUI_AUDIO_BIN="$CARGO_TARGET_DIR/$RUST_TRIPLE/release/pui-audio"
[[ -f "$PUI_BIN" ]] || die "pui build did not produce $PUI_BIN"
[[ -f "$PUI_AUDIO_BIN" ]] || die "pui build did not produce $PUI_AUDIO_BIN"

# ── zellij, pinned ──────────────────────────────────────────────────────────
ZJ_CACHE="$CARGO_TARGET_DIR/zellij-$ZJ_VER-$ZJ_TRIPLE"
if [[ ! -f "$ZJ_CACHE/zellij" ]] || [[ "$(sha256sum "$ZJ_CACHE/zellij" | cut -d' ' -f1)" != "$ZJ_SHA256" ]]; then
  echo "→ fetching zellij $ZJ_VER ($ZJ_TRIPLE)…"
  rm -rf "$ZJ_CACHE" && mkdir -p "$ZJ_CACHE"
  curl -fsSL "https://github.com/zellij-org/zellij/releases/download/v$ZJ_VER/zellij-$ZJ_TRIPLE.tar.gz" \
    | tar -xz -C "$ZJ_CACHE" zellij
  curl -fsSL -o "$ZJ_CACHE/LICENSE.md" "https://raw.githubusercontent.com/zellij-org/zellij/v$ZJ_VER/LICENSE.md"
fi
[[ "$(sha256sum "$ZJ_CACHE/zellij" | cut -d' ' -f1)" == "$ZJ_SHA256" ]] \
  || die "zellij $ZJ_VER ($ZJ_TRIPLE) does not match its pinned digest $ZJ_SHA256"
[[ "$(sha256sum "$ZJ_CACHE/LICENSE.md" | cut -d' ' -f1)" == "$ZJ_LICENSE_SHA256" ]] \
  || die "zellij's LICENSE.md does not match its pinned digest"

# ── Node, pinned ────────────────────────────────────────────────────────────
NODE_DIST="node-$NODE_VER-$NODE_PLATFORM"
NODE_TARBALL="$CARGO_TARGET_DIR/$NODE_DIST.tar.gz"
if [[ ! -f "$NODE_TARBALL" ]] || [[ "$(sha256sum "$NODE_TARBALL" | cut -d' ' -f1)" != "$NODE_SHA256" ]]; then
  echo "→ fetching Node $NODE_VER ($NODE_PLATFORM)…"
  curl -fsSL -o "$NODE_TARBALL.tmp" "https://nodejs.org/dist/$NODE_VER/$NODE_DIST.tar.gz"
  mv -f "$NODE_TARBALL.tmp" "$NODE_TARBALL"
fi
[[ "$(sha256sum "$NODE_TARBALL" | cut -d' ' -f1)" == "$NODE_SHA256" ]] \
  || die "Node $NODE_VER ($NODE_PLATFORM) does not match its pinned digest $NODE_SHA256"
NODE_CACHE="$WORK/$NODE_DIST"
mkdir -p "$NODE_CACHE"
tar -xzf "$NODE_TARBALL" -C "$NODE_CACHE" --strip-components=1 "$NODE_DIST/bin/node" "$NODE_DIST/LICENSE"
[[ -f "$NODE_CACHE/bin/node" && -f "$NODE_CACHE/LICENSE" ]] || die "$NODE_DIST.tar.gz lacks bin/node or LICENSE"

# ── stage the unit ──────────────────────────────────────────────────────────
STAGE="$WORK/stage"
UNIT="$STAGE/$NAME"
mkdir -p "$UNIT/bin"
install -m 0755 "$PUI_BIN" "$UNIT/bin/pui"
install -m 0755 "$PUI_AUDIO_BIN" "$UNIT/bin/pui-audio"
install -m 0755 "$ZJ_CACHE/zellij" "$UNIT/bin/zellij"
install -m 0644 "$WASM" "$UNIT/pui-companion.wasm"
install -m 0755 "$SRC/apps/tui/release/install.sh" "$UNIT/install.sh"
install -m 0644 "$SRC/apps/tui/release/README.md" "$UNIT/README.md"
install -m 0644 "$SRC/apps/tui/release/RELEASE_NOTES.md" "$UNIT/RELEASE_NOTES.md"
install -m 0644 "$WORK/PUI_LICENSE" "$UNIT/LICENSE"

# psu on the private Node: bin/psu runs lib/psu/psu.mjs with lib/node/node.
mkdir -p "$UNIT/lib/node"
install -m 0755 "$NODE_CACHE/bin/node" "$UNIT/lib/node/node"
install -m 0644 "$NODE_CACHE/LICENSE" "$UNIT/lib/node/LICENSE"
install -m 0755 "$SRC/apps/tui/release/psu" "$UNIT/bin/psu"
echo "→ bundling psu from ${SHA:0:12}…"
# The banner (ESM require/__dirname shims) is the one the desktop sidecar uses, read from this commit.
# shellcheck source=/dev/null
source "$SRC/apps/operator/bin/bundle-host-common.sh"
HOST_BANNER="$HOST_BANNER" node "$SRC/apps/tui/scripts/bundle-psu.mjs" \
  --root "$ROOT" --sha "$SHA" --target "$TARGET" --out "$UNIT/lib/psu" \
  --summary "$WORK/psu-summary.json" --native-builds "$SRC/packages/omp-plugin/build-native.mjs" \
  --cache "$CARGO_TARGET_DIR"

python3 "$SRC/apps/tui/scripts/write-install-manifest.py" write \
  --manifest "$UNIT/pui-install.json" \
  --source-sha "$SHA" --source-dirty 0 --built-at-epoch "$EPOCH" \
  --binary "$UNIT/bin/pui" --companion "$UNIT/pui-companion.wasm" \
  --relative-paths --version "$VERSION" --target "$TARGET"

# Source ancestry (WI-10003535): every commit reachable from $SHA as a byte-sorted
# 12-hex prefix. `pui doctor` on an installed release has no checkout to run
# `git merge-base --is-ancestor`, so this listing is how it tells "the operator is
# an older generation this pui already covers" from "this pui is behind the
# operator". Written before CONTENTS.sha256, so the listing is hash-verified too.
git -C "$ROOT" rev-list "$SHA" | cut -c1-12 | LC_ALL=C sort -u > "$UNIT/pui-source-ancestry.txt"
grep -q "^${SHA:0:12}\$" "$UNIT/pui-source-ancestry.txt" \
  || die "source ancestry listing does not contain the release source ${SHA:0:12}"

echo "→ license inventory…"
python3 "$SRC/apps/tui/scripts/license-inventory.py" \
  --out "$UNIT/THIRD_PARTY_LICENSES.md" \
  --crate "$SRC/apps/tui/Cargo.toml=$RUST_TRIPLE" \
  --crate "$SRC/apps/pui-zellij-plugin/Cargo.toml=wasm32-wasip1" \
  --component "zellij=$ZJ_VER=MIT=https://github.com/zellij-org/zellij=$ZJ_CACHE/LICENSE.md" \
  --component "node=$NODE_VER=MIT=https://nodejs.org/dist/$NODE_VER/$NODE_DIST.tar.gz=$NODE_CACHE/LICENSE" \
  --npm-packages "$WORK/psu-summary.json"

# Runtime requirements are MEASURED from the built binary, never asserted.
GLIBC_FLOOR=""
NEEDED=""
if [[ "$TARGET" == linux-* ]] && command -v readelf >/dev/null && command -v objdump >/dev/null; then
  GLIBC_FLOOR="$(objdump -T "$UNIT/bin/pui" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1)"
  NEEDED="$(readelf -d "$UNIT/bin/pui" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | LC_ALL=C sort | paste -sd, -)"
  [[ ",$NEEDED," != *,libasound.so.2,* ]] || die "bin/pui still links libasound.so.2; audio must stay isolated in bin/pui-audio"
fi

# Quoted heredoc: every input arrives through the environment, so nothing in the
# python (including the backticks in the rendered markdown) is shell-expanded.
P_UNIT="$UNIT" P_COMPAT="$SRC/apps/tui/release/compatibility.json" P_ROOT="$ROOT" P_SHA="$SHA" \
P_EPOCH="$EPOCH" P_TARGET="$TARGET" P_VERSION="$VERSION" P_RUST_TRIPLE="$RUST_TRIPLE" \
P_NEEDED="$NEEDED" P_GLIBC_FLOOR="$GLIBC_FLOOR" P_GLIBC_REQUEST="$GLIBC_REQUEST" \
P_ZIG_VERSION="$ZIG_VERSION" P_ZJ_VER="$ZJ_VER" P_ZJ_TRIPLE="$ZJ_TRIPLE" P_ZJ_SHA256="$ZJ_SHA256" \
P_NODE_VER="$NODE_VER" P_NODE_DIST="$NODE_DIST" P_NODE_SHA256="$NODE_SHA256" P_PSU_SUMMARY="$WORK/psu-summary.json" \
python3 - <<'PY'
import json, os, subprocess
from pathlib import Path

env = os.environ
unit, compat = Path(env["P_UNIT"]), json.loads(Path(env["P_COMPAT"]).read_text())
target, version = env["P_TARGET"], env["P_VERSION"]
needed = [lib for lib in env["P_NEEDED"].split(",") if lib]
glibc = env["P_GLIBC_FLOOR"] or None
zj_ver, zj_triple = env["P_ZJ_VER"], env["P_ZJ_TRIPLE"]
node_ver, node_dist = env["P_NODE_VER"], env["P_NODE_DIST"]
psu = json.loads(Path(env["P_PSU_SUMMARY"]).read_text())

def tree(path):
    return subprocess.run(["git", "-C", env["P_ROOT"], "rev-parse", env["P_SHA"] + ":" + path],
                          check=True, capture_output=True, text=True).stdout.strip()

def first_line(*cmd):
    try:
        return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.splitlines()[0]
    except Exception:
        return None

provenance = {
    "schemaVersion": 1,
    "name": "pui",
    "version": version,
    "target": target,
    "rustTarget": env["P_RUST_TRIPLE"],
    "source": {
        "repository": "https://github.com/Papercusp/papercusp.git",
        "commit": env["P_SHA"],
        "commitEpoch": int(env["P_EPOCH"]),
        "trees": {p: tree(p) for p in ("apps/tui", "apps/pui-zellij-plugin", "apps/pui-companion-proto")},
    },
    "toolchain": {
        "rustc": first_line("rustc", "--version"),
        "cargo": first_line("cargo", "--version"),
        "zig": env["P_ZIG_VERSION"] or None,
        "glibcRequested": env["P_GLIBC_REQUEST"] or None,
    },
    "bundled": {
        "zellij": {
            "version": zj_ver,
            "upstream": f"https://github.com/zellij-org/zellij/releases/download/v{zj_ver}/zellij-{zj_triple}.tar.gz",
            "sha256": env["P_ZJ_SHA256"],
        },
        "node": {
            "version": node_ver,
            "upstream": f"https://nodejs.org/dist/{node_ver}/{node_dist}.tar.gz",
            "sha256": env["P_NODE_SHA256"],
            "path": "lib/node/node",
        },
        "psu": {
            "entry": psu["entry"],
            "path": "lib/psu/psu.mjs",
            "launcher": "bin/psu",
            "esbuild": psu["esbuild"],
            "sourcePins": psu["sourcePins"],
            "firstPartyInputs": psu["firstPartyInputs"],
            "outputs": {name: out["sha256"] for name, out in psu["outputs"].items()},
            "npmPackages": [f"{p['name']}@{p['version']}" for p in psu["npmPackages"]],
        },
    },
    "runtime": {
        "measuredOn": "this archive's bin/pui (readelf/objdump)" if needed else None,
        "glibcFloor": glibc,
        "sharedLibraries": needed,
    },
}
(unit / "PROVENANCE.json").write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n")

entry = compat["targets"][target]
lines = [
    f"# PUI {version} build-time compatibility — {target}",
    "",
    "This document is packaged before installed-product acceptance can run. Its",
    "verification statuses describe the build-time record, not the final release",
    "advertisement. A published release must include the adjacent",
    f"`pui-{version}-{target}.tar.gz.acceptance.json` report. Treat a platform/backend",
    "as verified only if that report passes and its `candidate.archiveSha256`",
    "matches the SHA-256 of the archive you downloaded.",
    "",
    "## This archive",
    "",
    f"- Runs on: {', '.join(entry['platforms'])}.",
    f"- `psu` (bin/psu) runs on the bundled Node {node_ver} (lib/node/node); no system Node, npm or checkout is needed.",
    f"- Build-time verification: **{entry['status']}**"
    + (f" — evidence: {entry['evidence']}" if entry.get("evidence") else "")
    + ".",
]
if entry["status"] != "verified":
    lines.append("- Not advertised by this build-time record; check the exact archive's release-stage acceptance report for the final verdict.")
if entry.get("blocker"):
    lines.append(f"- Blocker: {entry['blocker']}")
if glibc:
    lines.append(f"- Requires glibc {glibc} or newer (measured from the binary).")
if needed:
    lines.append(f"- Loads these system libraries (measured): {', '.join(needed)}.")
if target.startswith("linux-"):
    lines.append("- Voice uses the bundled `bin/pui-audio` helper and the system ALSA library (`libasound.so.2`). For voice on a minimal system, install `libasound2t64` (current Debian/Ubuntu), `libasound2` (older Debian/Ubuntu), or `alsa-lib` (Fedora). PUI's text interface starts without it.")
lines += ["", "## All targets at build time", "", "| Target | Platforms | Build-time status |", "| --- | --- | --- |"]
for name, t in compat["targets"].items():
    lines.append(f"| {name} | {', '.join(t['platforms'])} | {t['status']} |")
backend = compat["backend"]
lines += ["", "## Backend", "", backend["requirement"], "", backend["packaging"], "", backend["check"], "",
          "## Engines", "", compat["engines"]["note"], ""]
(unit / "COMPATIBILITY.md").write_text("\n".join(lines))
PY

( cd "$UNIT" && find . -type f ! -name CONTENTS.sha256 | sed 's|^\./||' | LC_ALL=C sort \
    | while IFS= read -r file; do sha256sum "$file"; done > CONTENTS.sha256 )

# ── archive ─────────────────────────────────────────────────────────────────
mkdir -p "$OUT"
ARCHIVE="$OUT/$NAME.tar.gz"
( cd "$STAGE" && LC_ALL=C tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner \
    --mode='u+rwX,go+rX,go-w' --format=gnu -cf - "$NAME" ) | gzip -n -9 > "$ARCHIVE.tmp"
mv -f "$ARCHIVE.tmp" "$ARCHIVE"
DIGEST="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
( cd "$OUT" && { grep -v "  $NAME.tar.gz\$" SHA256SUMS 2>/dev/null || true; echo "$DIGEST  $NAME.tar.gz"; } \
    | LC_ALL=C sort -k2 > SHA256SUMS.tmp && mv -f SHA256SUMS.tmp SHA256SUMS )
SIGNATURE=""
if [[ -n "$SIGN_KEY" ]]; then
  command -v minisign >/dev/null || die "--sign-key needs minisign"
  minisign -S -s "$SIGN_KEY" -m "$ARCHIVE" -x "$ARCHIVE.minisig" \
    -t "pui $VERSION $TARGET source $SHA" </dev/null
  SIGNATURE="$ARCHIVE.minisig"
fi

echo "✓ $ARCHIVE"
echo "  sha256 $DIGEST"
python3 -c 'import json,sys; print("PUI_PACKAGE_RESULT " + json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2]))))' \
  archive "$ARCHIVE" sha256 "$DIGEST" name "$NAME" version "$VERSION" target "$TARGET" \
  sourceSha "$SHA" glibcFloor "$GLIBC_FLOOR" signature "$SIGNATURE"
