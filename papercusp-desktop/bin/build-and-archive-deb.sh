#!/usr/bin/env bash
# build-and-archive-deb.sh — EI-7048.
#
# THE GAP THIS CLOSES
# --------------------
# `npm run build` (tauri build) always overwrites the SAME fixed bundle path
# (~/.cargo-target/release/bundle/deb/Papercusp GUI_0.0.2_amd64.deb — the
# version stamp is constant 0.0.2, so even the filename never disambiguates
# builds). Every new build silently destroys the only copy of the PRIOR
# build's artifact. Observed live (2026-07-03, WI-1910 hunt): a leader
# directed "pin any deb-validation run to the 07-02 deb" — impossible to
# execute, because the 07-03 11:52 build had already clobbered the 07-02
# 8/8-baseline artifact. Recovery required scavenging an offloaded rig
# workdir's extracted pkg tree from days earlier and repacking via
# dpkg-deb — 30+ minutes, and even then only an OLDER build survived, not
# the one actually directed.
#
# THE FIX
# --------
# A thin wrapper around the existing `npm run build` (untouched — this is
# purely ADDITIVE, so nothing that already calls `npm run build` directly
# changes behavior) that, on a successful build, HARDLINKS (not copies — the
# .deb is ~1GB and hardlinks cost ~0 extra disk on the same filesystem) the
# fresh artifact into a byte-independent git-sha + timestamp-stamped archive
# path (a reflink where supported, a real copy otherwise), then prunes to the
# last N (default 10) archived builds so this can run unattended
# (e.g. from a CI/gate script) without unbounded disk growth.
#
# Usage: bin/build-and-archive-deb.sh [--debug] [--keep N] [--test-artifact]
#   --debug          build the debug bundle (tauri build --debug) instead of release
#   --keep N         number of archived builds to retain (default 10)
#   --test-artifact  build a DRILL/TEST Server .deb from a dev (unaudited) sidecar
#                    (WI-10003499). The release identity audit and source-coherence
#                    proofs are NOT required, and the output never lands where a
#                    consumer scavenges: it goes to bundle/deb/test-artifacts/ with
#                    a TEST-ARTIFACT file name, and the live bundle/deb copy is
#                    removed. Pass the printed path explicitly to a drill, e.g.
#                    bin/hive-git-drill.sh <path>. Never publish one.
set -euo pipefail
LIVE_DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_REPO_DIR="${PAPERCUSP_REPO_DIR:-/home/builduser/papercupai-workspace/papercusp}"
DESKTOP_DIR="$LIVE_DESKTOP_DIR"
REPO_DIR="$LIVE_REPO_DIR"
# Ask Cargo where it writes, never a hard-coded name (WI-10003499). The old
# `${CARGO_TARGET_DIR:-$HOME/.cargo-target}` default outlived the 2026-09-03
# target-dir move. tauri built the .deb into the configured target, and this
# script then refused with "emitted no fresh .deb" at the old path.
# shellcheck source=lib/cargo-target-root.sh
source "$LIVE_DESKTOP_DIR/bin/lib/cargo-target-root.sh"
CARGO_TARGET="$(papercusp_cargo_target_root "$LIVE_DESKTOP_DIR/src-tauri")"

DEB_SOURCE_SNAPSHOT_ROOT=""
DEB_SOURCE_SNAPSHOT_PARENT=""
DEB_SOURCE_SNAPSHOT_DESKTOP=""
DEB_SOURCE_SNAPSHOT_COMMIT=""
DEB_SOURCE_SNAPSHOT_DESKTOP_COMMIT=""
DEB_SOURCE_SNAPSHOT_WORKTREE=0

cleanup_deb_source_snapshot() {
  if [[ "$DEB_SOURCE_SNAPSHOT_WORKTREE" == "1" && -n "$DEB_SOURCE_SNAPSHOT_DESKTOP" ]]; then
    git -C "$LIVE_DESKTOP_DIR" worktree remove --force "$DEB_SOURCE_SNAPSHOT_DESKTOP" \
      >/dev/null 2>&1 || true
    DEB_SOURCE_SNAPSHOT_WORKTREE=0
  fi
  if [[ -n "$DEB_SOURCE_SNAPSHOT_ROOT" ]]; then
    case "$DEB_SOURCE_SNAPSHOT_ROOT" in
      "$DEB_SOURCE_SNAPSHOT_PARENT"/papercusp-deb-source-*) rm -rf -- "$DEB_SOURCE_SNAPSHOT_ROOT" ;;
      *) echo "WARN: refusing to remove unexpected deb snapshot path: $DEB_SOURCE_SNAPSHOT_ROOT" >&2 ;;
    esac
    DEB_SOURCE_SNAPSHOT_ROOT=""
  fi
}

snapshot_copy_tree() {
  local source="${1:?snapshot source required}"
  local dest="${2:?snapshot destination required}"
  local source_dev dest_dev
  mkdir -p -- "$(dirname "$dest")"
  rm -rf -- "$dest"
  source_dev="$(stat -c '%d' "$source")"
  dest_dev="$(stat -c '%d' "$(dirname "$dest")")"
  if [[ "$source_dev" == "$dest_dev" ]]; then
    cp -al -- "$source" "$dest"
  else
    echo "==> snapshot copy crosses filesystems; using an independent copy for $source" >&2
    cp -a --reflink=auto -- "$source" "$dest"
  fi
}

# Package-local build tools are not publish-once outputs like the sidecar.
# Keep their snapshot byte-independent from the live install: a later `npm ci`
# may rewrite files in place, which would also mutate a hardlink snapshot.
snapshot_copy_tree_independent() {
  local source="${1:?snapshot source required}"
  local dest="${2:?snapshot destination required}"
  mkdir -p -- "$(dirname "$dest")"
  rm -rf -- "$dest"
  cp -a --reflink=auto -- "$source" "$dest"
}

DEBUG=0
KEEP=10
TEST_ARTIFACT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --debug) DEBUG=1; shift ;;
    --test-artifact) TEST_ARTIFACT=1; shift ;;
    --keep)
      [[ $# -ge 2 ]] || { echo "FATAL: --keep requires a number" >&2; exit 2; }
      KEEP="$2"
      shift 2
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Retention is destructive: a bad value must fail before signing, building, or
# pruning anything. Text used to slip through the parser and silently disable
# the numeric prune branch; zero/negative values could delete every retained
# archive, including the one just published. Keep at least one archive and
# require an unambiguous positive integer.
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || {
  echo "FATAL: --keep must be a positive integer, got '$KEEP'" >&2
  exit 2
}

# --- UPDATER SIGNING KEY (EI-20398328195531333) ---
#
# tauri.conf.json enables createUpdaterArtifacts, so a build without a private
# key can spend the full compile + multi-GB Debian bundle and only then fail at
# the updater-signing step. The other local release producers already load the
# conventional key; keep this wrapper on the same contract. An explicitly
# supplied TAURI_SIGNING_PRIVATE_KEY still wins because Tauri accepts either
# key contents or a path in that variable. TAURI_SIGNING_PRIVATE_KEY_PATH is
# the repo's path-only convenience override and is otherwise ignored by Tauri.
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  SIGNING_KEY_FILE="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.papercusp/signing/papercusp.key}"
  if [[ ! -f "$SIGNING_KEY_FILE" ]]; then
    echo "FATAL: updater signing key not found at $SIGNING_KEY_FILE." >&2
    echo "       Run bin/setup-signing-key.sh, set TAURI_SIGNING_PRIVATE_KEY_PATH," >&2
    echo "       or provide TAURI_SIGNING_PRIVATE_KEY directly before building." >&2
    exit 7
  fi
  export TAURI_SIGNING_PRIVATE_KEY="$SIGNING_KEY_FILE"
  echo "==> updater signing key: $SIGNING_KEY_FILE"
else
  echo "==> updater signing key: supplied via TAURI_SIGNING_PRIVATE_KEY"
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# --- IMMUTABLE SOURCE BOUNDARY (EI-21575353881676545) -----------------------
#
# The sidecar and this wrapper used to consume the same SHARED checkout at two
# different times. On an active box that is not a source boundary: git-sync and
# peer Vite builds can move HEAD/dist between a verified sidecar and npm's
# prebuild check. The guard correctly refused that skew, but rebuilding in a
# loop could never make forward progress while the tree kept moving.
#
# Reuse the Windows producer's maintained contract: the sidecar provenance
# names the accepted superproject commit; that commit names the exact desktop
# submodule commit. Package from a private detached desktop worktree at that
# gitlink, and copy the already-built sidecar plus its Vite snapshot into the
# private root while holding the established sidecar reader lock. The live
# checkout may keep changing, but none of those paths are build inputs anymore.
# No stale override is involved: the pinned commit is checked again below, and
# npm's normal SPA content guard runs against the pinned snapshot.
SIDECAR_PROVENANCE="$LIVE_DESKTOP_DIR/src-tauri/sidecar/build-provenance.json"
[[ -s "$SIDECAR_PROVENANCE" ]] || {
  echo "FATAL: sidecar build-provenance.json is missing; cannot establish an immutable deb source boundary." >&2
  echo "       Rebuild with bin/build-desktop-sidecar.sh, then retry." >&2
  exit 4
}

DEB_SOURCE_SNAPSHOT_COMMIT="$(python3 - "$SIDECAR_PROVENANCE" <<'PY'
import json, re, sys
try:
    value = json.load(open(sys.argv[1], encoding='utf-8')).get('gitHead', '')
except (OSError, ValueError, TypeError):
    value = ''
print(value if isinstance(value, str) and re.fullmatch(r'[0-9a-fA-F]{40}', value) else '')
PY
)"
[[ -n "$DEB_SOURCE_SNAPSHOT_COMMIT" ]] || {
  echo "FATAL: sidecar provenance has no full 40-hex gitHead; refusing an unpinned deb build." >&2
  exit 4
}
git -C "$LIVE_REPO_DIR" cat-file -e "$DEB_SOURCE_SNAPSHOT_COMMIT^{commit}" 2>/dev/null || {
  echo "FATAL: sidecar source commit $DEB_SOURCE_SNAPSHOT_COMMIT is unknown to $LIVE_REPO_DIR." >&2
  exit 4
}

DEB_SOURCE_SNAPSHOT_DESKTOP_COMMIT="$(
  git -C "$LIVE_REPO_DIR" ls-tree "$DEB_SOURCE_SNAPSHOT_COMMIT" papercusp-desktop 2>/dev/null \
    | awk '$1 == "160000" && $2 == "commit" { print $3; exit }'
)"
[[ "$DEB_SOURCE_SNAPSHOT_DESKTOP_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || {
  echo "FATAL: source commit $DEB_SOURCE_SNAPSHOT_COMMIT has no papercusp-desktop gitlink." >&2
  exit 4
}
git -C "$LIVE_DESKTOP_DIR" cat-file -e "$DEB_SOURCE_SNAPSHOT_DESKTOP_COMMIT^{commit}" 2>/dev/null || {
  echo "FATAL: desktop source commit $DEB_SOURCE_SNAPSHOT_DESKTOP_COMMIT is unavailable locally." >&2
  exit 4
}

# Keep the default beside the workspace so the 6GB sidecar can be snapshotted
# with hardlinks. /tmp is a separate mount on common dev hosts; blindly using
# it produced millions of EXDEV diagnostics before failing (the first live
# recurrence run for EI-21575353881676545). An explicit cross-device parent is
# still supported via the independent-copy fallback in snapshot_copy_tree.
DEB_SOURCE_SNAPSHOT_PARENT="${PAPERCUSP_DEB_SNAPSHOT_PARENT:-$(dirname "$LIVE_REPO_DIR")/.papercusp-build-snapshots}"
mkdir -p -- "$DEB_SOURCE_SNAPSHOT_PARENT"
DEB_SOURCE_SNAPSHOT_PARENT="$(cd "$DEB_SOURCE_SNAPSHOT_PARENT" && pwd -P)"
DEB_SOURCE_SNAPSHOT_ROOT="$(mktemp -d "$DEB_SOURCE_SNAPSHOT_PARENT/papercusp-deb-source-XXXXXX")"
DEB_SOURCE_SNAPSHOT_DESKTOP="$DEB_SOURCE_SNAPSHOT_ROOT/papercusp-desktop"
trap cleanup_deb_source_snapshot EXIT INT TERM
if ! git -C "$LIVE_DESKTOP_DIR" worktree add --detach \
  "$DEB_SOURCE_SNAPSHOT_DESKTOP" "$DEB_SOURCE_SNAPSHOT_DESKTOP_COMMIT" >/dev/null 2>&1; then
  echo "FATAL: could not create immutable desktop source at $DEB_SOURCE_SNAPSHOT_DESKTOP." >&2
  exit 4
fi
DEB_SOURCE_SNAPSHOT_WORKTREE=1

# WI-10003499: the desktop Rust sources compile SUPERPROJECT-owned files in via
# relative include_str!/include_bytes! paths that climb out of papercusp-desktop.
# Without them the private worktree fails at `cargo build` with "couldn't read
# src/../../../libs/...". Stage each one from the SAME pinned superproject commit,
# resolved through submodule gitlinks and hash-verified, never from the live tree.
# test/build-deb-superproject-inputs.test.js scans src-tauri/src for non-test
# out-of-tree includes and fails when one is missing from this list.
DEB_SUPERPROJECT_BUILD_INPUTS=(
  libs/generic/desktop-ipc/src/csp-policy.json
)
# shellcheck source=lib/superproject-blob.sh
source "$LIVE_DESKTOP_DIR/bin/lib/superproject-blob.sh"
for _superproject_input in "${DEB_SUPERPROJECT_BUILD_INPUTS[@]}"; do
  papercusp_materialize_superproject_blob "$LIVE_REPO_DIR" "$DEB_SOURCE_SNAPSHOT_COMMIT" \
    "$_superproject_input" "$DEB_SOURCE_SNAPSHOT_ROOT/$_superproject_input" || {
    echo "FATAL: could not stage superproject build input $_superproject_input at ${DEB_SOURCE_SNAPSHOT_COMMIT:0:10}." >&2
    exit 4
  }
done
unset _superproject_input

# The desktop package owns @tauri-apps/cli in its own package-lock/node_modules;
# the superproject root deliberately does not. A detached worktree therefore
# has no `tauri` executable unless we carry this package-local toolchain too.
# Refuse to mix the pinned desktop source with an install for a different lock,
# then make an independent copy so a concurrent/future npm install cannot
# mutate the build inputs through shared hardlink inodes.
_snapshot_desktop_lock="$DEB_SOURCE_SNAPSHOT_DESKTOP/package-lock.json"
_live_desktop_lock="$LIVE_DESKTOP_DIR/package-lock.json"
[[ -s "$_snapshot_desktop_lock" && -s "$_live_desktop_lock" ]] || {
  echo "FATAL: desktop package-lock.json is missing; cannot pin the deb build toolchain." >&2
  exit 4
}
_snapshot_desktop_lock_sha="$(sha256sum "$_snapshot_desktop_lock" | awk '{print $1}')"
_live_desktop_lock_sha_before="$(sha256sum "$_live_desktop_lock" | awk '{print $1}')"
[[ "$_snapshot_desktop_lock_sha" == "$_live_desktop_lock_sha_before" ]] || {
  echo "FATAL: live desktop dependencies do not match pinned source $DEB_SOURCE_SNAPSHOT_DESKTOP_COMMIT." >&2
  echo "       Run npm ci in $LIVE_DESKTOP_DIR at the pinned package-lock before retrying." >&2
  exit 4
}
[[ -d "$LIVE_DESKTOP_DIR/node_modules" ]] || {
  echo "FATAL: $LIVE_DESKTOP_DIR/node_modules is missing; run npm ci there before retrying." >&2
  exit 4
}
snapshot_copy_tree_independent "$LIVE_DESKTOP_DIR/node_modules" \
  "$DEB_SOURCE_SNAPSHOT_DESKTOP/node_modules"
_live_desktop_lock_sha_after="$(sha256sum "$_live_desktop_lock" | awk '{print $1}')"
[[ "$_live_desktop_lock_sha_after" == "$_live_desktop_lock_sha_before" ]] || {
  echo "FATAL: desktop package-lock.json changed while snapshotting the deb build toolchain." >&2
  exit 4
}
[[ -x "$DEB_SOURCE_SNAPSHOT_DESKTOP/node_modules/.bin/tauri" ]] || {
  echo "FATAL: pinned desktop toolchain has no executable node_modules/.bin/tauri." >&2
  echo "       Run npm ci in $LIVE_DESKTOP_DIR, then retry." >&2
  exit 4
}
_pinned_tauri_version="$(node -p \
  "require('${DEB_SOURCE_SNAPSHOT_DESKTOP}/package-lock.json').packages['node_modules/@tauri-apps/cli'].version" 2>/dev/null || true)"
_copied_tauri_version="$(node -p \
  "require('${DEB_SOURCE_SNAPSHOT_DESKTOP}/node_modules/@tauri-apps/cli/package.json').version" 2>/dev/null || true)"
[[ -n "$_pinned_tauri_version" && "$_copied_tauri_version" == "$_pinned_tauri_version" ]] || {
  echo "FATAL: copied Tauri CLI version '${_copied_tauri_version:-missing}' does not match pinned lock '${_pinned_tauri_version:-missing}'." >&2
  exit 4
}
echo "==> immutable desktop toolchain: tauri=$_copied_tauri_version lock=${_snapshot_desktop_lock_sha:0:10}"

command -v flock >/dev/null 2>&1 || {
  echo "FATAL: flock(1) is required to snapshot the sidecar safely." >&2
  exit 4
}
exec 8>>"$LIVE_DESKTOP_DIR/src-tauri/sidecar.lock"
flock -s 8
snapshot_copy_tree "$LIVE_DESKTOP_DIR/src-tauri/sidecar" \
  "$DEB_SOURCE_SNAPSHOT_DESKTOP/src-tauri/sidecar"
flock -u 8
exec 8>&-

snapshot_copy_tree "$DEB_SOURCE_SNAPSHOT_DESKTOP/src-tauri/sidecar/spa" \
  "$DEB_SOURCE_SNAPSHOT_ROOT/apps/operator-vite/dist"
ln -s -- "$LIVE_REPO_DIR/node_modules" "$DEB_SOURCE_SNAPSHOT_ROOT/node_modules"

_snapshot_provenance_head="$(python3 - "$DEB_SOURCE_SNAPSHOT_DESKTOP/src-tauri/sidecar/build-provenance.json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1], encoding='utf-8')).get('gitHead', ''))
except (OSError, ValueError, TypeError):
    print('')
PY
)"
[[ "$_snapshot_provenance_head" == "$DEB_SOURCE_SNAPSHOT_COMMIT" ]] || {
  echo "FATAL: copied sidecar provenance changed while establishing the source boundary." >&2
  exit 4
}

DESKTOP_DIR="$DEB_SOURCE_SNAPSHOT_DESKTOP"
REPO_DIR="$DEB_SOURCE_SNAPSHOT_ROOT"
export PAPERCUSP_REPO_DIR="$DEB_SOURCE_SNAPSHOT_ROOT"
export PAPERCUSP_BUILD_SHA="${DEB_SOURCE_SNAPSHOT_COMMIT:0:10}"
echo "==> immutable deb source: root=${DEB_SOURCE_SNAPSHOT_COMMIT:0:10} desktop=${DEB_SOURCE_SNAPSHOT_DESKTOP_COMMIT:0:10} path=$DEB_SOURCE_SNAPSHOT_ROOT"

# --- BUILD-BOX PATH REMAP (WI-3496) -----------------------------------------
#
# This standalone Debian producer compiles the shipped Tauri ELF itself. It
# therefore must establish the same Rust source-path hygiene as every other
# release producer instead of relying on an ambient release-local.sh export.
# Without the remap, rustc bakes $HOME/.cargo and $HOME/.rustup source paths
# into usr/bin/papercusp-server; the finished-artifact identity audit correctly
# rejects that package after the multi-GB build has already completed.
#
# Keep the linker flag paired with RUSTFLAGS: once the environment variable is
# present, Cargo no longer applies target.*.rustflags from .cargo/config.toml.
# shellcheck source=lib/rust-path-remap.sh
source "$LIVE_DESKTOP_DIR/bin/lib/rust-path-remap.sh"
papercusp_export_rust_path_remap
papercusp_export_rust_lld linux

# This wrapper CONSUMES a sidecar it did not build. A normal/dev sidecar can be
# runtime-complete yet still carry the build box's identity because the release
# scrub needs PAPERCUSP_RELEASE_OWNER_NAME at build time. That exact gap escaped
# into the WI-3496 canonical archive: the later finished-artifact audit found 39
# leaking paths only after the multi-GB package had been built and repacked.
# Reuse the cross-build freshness contract rather than inventing a second stamp:
# the final assembled-sidecar identity scan records releaseIdentityAudit only
# after it passes, and this assertion cannot be bypassed by ALLOW_STALE.
#
# --test-artifact (WI-10003499) is the ONE sanctioned way to package without that
# proof. A release-audited sidecar requires a clean source tree, and the shared
# canonical tree is never clean, so drills that need a CURRENT Server .deb (P-505
# hive-git-drill, the migration-freshness check) had no producer at all. The
# relaxation is paid for at the OUTPUT: a test artifact is written only to
# bundle/deb/test-artifacts/ under a TEST-ARTIFACT name, and the live bundle/deb
# copy is removed, so no scavenger (live-federation-gate, a drill's default pick)
# can mistake it for a canonical build. The ordinary freshness verdicts still run.
if [[ "$TEST_ARTIFACT" == "1" ]]; then
  echo "==> TEST ARTIFACT MODE (WI-10003499): release identity audit and source coherence are NOT required;" >&2
  echo "    output goes ONLY to bundle/deb/test-artifacts/ — never archive/, never the scavenged bundle/deb path. Do not publish it." >&2
  node "$LIVE_DESKTOP_DIR/bin/check-sidecar-freshness.js" \
    --sidecar "$DESKTOP_DIR/src-tauri/sidecar" \
    --repo-root "$LIVE_REPO_DIR" \
    --label build-and-archive-deb:test-artifact
else
  PAPERCUSP_REQUIRE_SIDECAR_RELEASE_AUDIT=1 \
    PAPERCUSP_REQUIRE_SOURCE_COHERENCE=1 \
    node "$LIVE_DESKTOP_DIR/bin/check-sidecar-freshness.js" \
      --sidecar "$DESKTOP_DIR/src-tauri/sidecar" \
      --repo-root "$LIVE_REPO_DIR" \
      --label build-and-archive-deb
fi

# --- SEED OVERLAY / SERVER PRODUCT (WI-6075 / GUI-Server split P-007) ---
#
# The multi-GB hive seed (src-tauri/seed, ~2GB) is deliberately NOT in the base
# tauri.conf.json: it must never ship inside the GUI product. The debs this script
# archives are what bin/live-federation-gate.sh SCAVENGES as its BASE_DEB, and
# that gate needs the complete operator runtime plus seed. Therefore this is a
# SERVER producer, not a special full-runtime flavor wearing the GUI identity.
# Reuse the canonical Server overlay so the archived package has the Server
# identifier, install root and resource manifest by construction.
#
# Do NOT "simplify" this by putting seed/**/* back in tauri.conf.json — that is
# the exact regression test/tauri-config-resources.test.js exists to catch.
# NOTE: `tauri build --config` OVERWRITES conflicting values rather than merging,
# so tauri.server.conf.json carries the complete Server resource list.
SERVER_OVERLAY="src-tauri/tauri.server.conf.json"

PROFILE_DIR="release"
BUILD_CMD="PAPERCUSP_DEFER_DEB_REPACK=1 npm run build -- --config $SERVER_OVERLAY"
if [ "$DEBUG" = 1 ]; then
  PROFILE_DIR="debug"
  BUILD_CMD="PAPERCUSP_DEFER_DEB_REPACK=1 npm run build:debug -- --config $SERVER_OVERLAY"
fi

DEB_DIR="$CARGO_TARGET/$PROFILE_DIR/bundle/deb"
ARCHIVE_DIR="$DEB_DIR/archive"
ARCHIVE_LABEL=""
if [[ "$TEST_ARTIFACT" == "1" ]]; then
  # WI-10003499: a test artifact must never share the canonical archive or its
  # retention census, and its file name must say what it is wherever it travels.
  ARCHIVE_DIR="$DEB_DIR/test-artifacts"
  ARCHIVE_LABEL="TEST-ARTIFACT-"
fi

# WI-3287 / env-switcher-packaged-all-platforms-2026-07-06: stage the bundled
# env-sidecars/staging bundle inside sidecar/ (if a sidecar was already built)
# so the packaged env switcher has a real staging button — see
# bin/stage-env-sidecars.sh for the contract. Best-effort: this script does
# not itself build the sidecar (the documented manual flow does that first),
# so skip quietly if there's nothing to stage yet.
if [[ -f "$DESKTOP_DIR/src-tauri/sidecar/serve.mjs" ]]; then
  bash "$DESKTOP_DIR/bin/stage-env-sidecars.sh"
else
  echo "NOTE: src-tauri/sidecar/serve.mjs not found — skipping env-sidecars/staging (run bin/build-desktop-sidecar.sh first for a packaged staging button)"
fi

# --- PLACEHOLDER-SIDECAR GUARD (EI-20576367847192101) -----------------------
#
# `src-tauri/build.rs` (ensure_sidecar_placeholder / ensure_seed_placeholder)
# writes PLACEHOLDER-README.txt stand-ins for sidecar/serve.mjs and
# sidecar/db-sql/*.sql whenever the real sidecar hasn't been built — purely so
# a fresh/cleaned checkout's `cargo build`/`tauri dev` can compile (dev never
# spawns the sidecar, see build.rs's own comment). `tauri build` (this
# script's BUILD_CMD) does not know the difference: it happily bundles
# whatever sits in sidecar/, placeholders included, and exits 0. The result is
# a .deb that is byte-plausible — right filename, multi-hundred-MB, archived
# like a good build — but ships zero migrations and no server: indistinguishable
# from a real artifact by exit code, filename, or the archive step, only
# detectable by actually installing and running it.
#
# check-spa-freshness.js's 'no-sidecar' verdict deliberately does NOT block on
# this ("the build will fail on its own, and more clearly, than a freshness
# check can" — bin/lib/spa-freshness.js's `describe()`). That assumption is
# false: build.rs's placeholder is exactly what lets the build succeed instead
# of failing. So the check belongs here too, as a hard pre-flight — the one
# place guaranteed to run before every real packaging build, independent of
# whether the npm `prebuild` hook fires (a caller could invoke `tauri build`
# directly, or a future refactor could change the npm script wiring).
#
# Positive checks only — never "is PLACEHOLDER-README.txt absent". A file-name
# check is fragile against the placeholder mechanism's own shape changing;
# checking for the REAL artifacts the shipped app actually needs is not.
if [[ ! -f "$DESKTOP_DIR/src-tauri/sidecar/serve.mjs" ]]; then
  echo "" >&2
  echo "FATAL: PLACEHOLDER SIDECAR — src-tauri/sidecar/serve.mjs does not exist." >&2
  echo "" >&2
  echo "  build.rs writes a placeholder there on a fresh/cleaned checkout so plain" >&2
  echo "  cargo/tauri-dev builds can compile — but this script packages a REAL .deb," >&2
  echo "  and 'tauri build' cannot tell a placeholder from a real bundle. Left" >&2
  echo "  unguarded this produces a .deb that exits 0, looks complete, and ships" >&2
  echo "  nothing runnable." >&2
  echo "" >&2
  echo "  FIX:  bash bin/build-desktop-sidecar.sh   # then re-run this script" >&2
  echo "" >&2
  exit 8
fi
SIDECAR_SQL_COUNT=0
if [[ -d "$DESKTOP_DIR/src-tauri/sidecar/db-sql" ]]; then
  # Guarded behind the -d check above: under `set -euo pipefail`, `find` on a
  # NONEXISTENT dir exits 1, and pipefail propagates that through `| wc -l | tr`
  # into this assignment — which set -e then treats as a script-ending failure,
  # silently, with none of this guard's own FATAL messaging ever printed.
  SIDECAR_SQL_COUNT="$(find "$DESKTOP_DIR/src-tauri/sidecar/db-sql" -maxdepth 1 -iname '*.sql' 2>/dev/null | wc -l | tr -d ' ')"
fi
if [[ "${SIDECAR_SQL_COUNT:-0}" -eq 0 ]]; then
  echo "" >&2
  echo "FATAL: PLACEHOLDER SIDECAR — src-tauri/sidecar/db-sql/ has no *.sql files." >&2
  echo "" >&2
  echo "  Same root cause as the serve.mjs check above: build.rs placeholders this" >&2
  echo "  directory on a fresh checkout so cargo/tauri-dev can compile. A real bundle" >&2
  echo "  must ship every migration — bin/build-desktop-sidecar.sh is what actually" >&2
  echo "  populates it from libs/db/sql/." >&2
  echo "" >&2
  echo "  FIX:  bash bin/build-desktop-sidecar.sh   # then re-run this script" >&2
  echo "" >&2
  exit 8
fi
if [[ ! -f "$DESKTOP_DIR/src-tauri/sidecar/spa/index.html" ]]; then
  echo "" >&2
  echo "FATAL: PLACEHOLDER SIDECAR — src-tauri/sidecar/spa/index.html does not exist." >&2
  echo "" >&2
  echo "  No staged SPA means the sidecar build never ran, or was interrupted before" >&2
  echo "  it staged the frontend. Packaging now would ship an app with no UI." >&2
  echo "" >&2
  echo "  FIX:  bash bin/build-desktop-sidecar.sh   # then re-run this script" >&2
  echo "" >&2
  exit 8
fi
echo "==> sidecar looks real (serve.mjs, $SIDECAR_SQL_COUNT migration file(s), spa/index.html present)"

# --- STALE-SIDECAR GUARD (EI-18683847182779973, third occurrence 2026-07-26) ---
#
# `tauri build` does NOT rebuild the sidecar (tauri.conf.json beforeBuildCommand
# is ""), and src-tauri/sidecar/serve.mjs is an esbuild bundle that INLINES its
# vendored deps — including patched ones like hyperdht. So applying a patch to
# node_modules (and regenerating patches/*.patch) updates every SOURCE-level
# check an agent can run, while changing nothing in the artifact the rig
# actually executes.
#
# That is not a normal stale-build bug. The instrumentation a diagnostic patch
# adds reads back `undefined`, which renders as the FALSY value — which in a
# diagnostic context is usually the "nothing unusual happened" reading. So the
# run does not error and does not look odd: it produces a clean CONFIRMATION of
# whatever hypothesis predicted the falsy value. A stale bundle here does not
# lose data, it MANUFACTURES AGREEMENT.
#
# This has now nearly cost three separate investigation runs in one week, so it
# fails the build rather than warning. Escape hatch for a deliberate build with
# a knowingly-older sidecar: PAPERCUSP_ALLOW_STALE_SIDECAR=1.
SIDECAR_STAMP="$DESKTOP_DIR/src-tauri/sidecar/.sidecar-build-stamp"
if [[ -f "$SIDECAR_STAMP" && "${PAPERCUSP_ALLOW_STALE_SIDECAR:-0}" != "1" ]]; then
  if [[ -n "${DEB_SOURCE_SNAPSHOT_COMMIT:-}" ]]; then
    PINNED_SIDECAR_HEAD="$(sed -n 's/.*"gitHead"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DESKTOP_DIR/src-tauri/sidecar/build-provenance.json" | head -1)"
    if [[ "$PINNED_SIDECAR_HEAD" != "$DEB_SOURCE_SNAPSHOT_COMMIT" ]]; then
      echo "FATAL: STALE SIDECAR — pinned source $DEB_SOURCE_SNAPSHOT_COMMIT does not match sidecar provenance $PINNED_SIDECAR_HEAD." >&2
      exit 4
    fi
    echo "==> sidecar source boundary pinned to ${DEB_SOURCE_SNAPSHOT_COMMIT:0:10}; live patch mtimes are not inputs"
  else
    STAMP_EPOCH="$(sed -n 's/.*"epochSec"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' "$SIDECAR_STAMP" | head -1)"
    if [[ -n "$STAMP_EPOCH" ]]; then
    NEWEST_PATCH=""
    NEWEST_PATCH_EPOCH=0
    while IFS= read -r -d '' p; do
      # Do NOT coerce a failed stat to epoch 0 — that would silently treat an
      # unreadable patch as "doesn't count" and defeat the exact staleness
      # check this script exists to enforce (see header). Fail outright.
      if ! pe="$(stat -c '%Y' "$p")"; then
        echo "FATAL: could not stat patch file '$p' while checking sidecar staleness." >&2
        exit 1
      fi
      if [[ "$pe" -gt "$NEWEST_PATCH_EPOCH" ]]; then
        NEWEST_PATCH_EPOCH="$pe"
        NEWEST_PATCH="$p"
      fi
    done < <(find "$REPO_DIR/patches" -maxdepth 1 -name '*.patch' -print0 2>/dev/null)

    if [[ "$NEWEST_PATCH_EPOCH" -gt "$STAMP_EPOCH" ]]; then
      echo "" >&2
      echo "FATAL: STALE SIDECAR — the bundle predates a vendored-dependency patch." >&2
      echo "" >&2
      echo "  sidecar built : $(date -u -d "@$STAMP_EPOCH" +%Y-%m-%dT%H:%M:%SZ)  ($SIDECAR_STAMP)" >&2
      echo "  newer patch   : $(date -u -d "@$NEWEST_PATCH_EPOCH" +%Y-%m-%dT%H:%M:%SZ)  ${NEWEST_PATCH#$REPO_DIR/}" >&2
      echo "" >&2
      echo "  serve.mjs INLINES its vendored deps, so this build would ship the PRE-patch" >&2
      echo "  copy. Any instrumentation the patch adds would read back \`undefined\` —" >&2
      echo "  i.e. FALSY — and a diagnostic run would silently 'confirm' whatever" >&2
      echo "  hypothesis predicted the falsy value instead of failing loudly." >&2
      echo "" >&2
      echo "  FIX:  bash bin/build-desktop-sidecar.sh   # then re-run this script" >&2
      echo "  THEN VERIFY THE ARTIFACT, not node_modules and not the .patch file:" >&2
      echo "        grep -c '<your new field>' src-tauri/sidecar/serve.mjs   # expect > 0" >&2
      echo "" >&2
      echo "  Deliberate build against an older sidecar: PAPERCUSP_ALLOW_STALE_SIDECAR=1" >&2
      echo "  Background: /internal/docs/agent-insights/stale-bundle-fabricates-diagnostic-confirmation" >&2
      echo "" >&2
      exit 4
    fi
    fi
  fi
fi

# --- BUNDLE MUTEX + PROCESS-GROUP OWNERSHIP (EI-18698595682442781) ----------
#
# The deb staging path ($CARGO_TARGET/<profile>/bundle/deb/<name>/) is a SINGLE
# FIXED directory — not per-agent, not per-PID. On this shared box several agents
# build concurrently, and two bundlers in that directory race on control/,
# md5sums and data.tar.gz: one hashes a tree the other is rewriting, a file
# vanishes mid-hash, and you get the thoroughly misleading
#   `Failed to create md5sums file: No such file or directory (os error 2)`
# which sends you hunting for filesystem debris instead of for a peer. Observed
# live 2026-07-26 with three concurrent tauri builds owned by two agents.
# Worse, a race can leave a PARTIAL .deb at the canonical output path that looks
# complete by size — and anything selecting "the newest .deb" then ships stale
# or truncated contents silently.
#
# `node_modules` has the same class of problem and got a mutex (install:safe +
# scripts/lib/fs-mutex.mjs); this path had none. We use flock here rather than
# that ESM helper to match the sibling build script (build-desktop-sidecar.sh
# already locks with flock), keeping ONE locking idiom in this script family.
#
# fd 9 is held by THIS shell for the lock's lifetime. The build runs with fd 9
# CLOSED (exec 9>&-) so that a daemonizing grandchild (sccache, node) cannot
# inherit and retain the lock after we exit — the same hazard, and the same fix,
# that test/build-desktop-sidecar-lock.test.js pins for the sidecar build.
#
# The build also runs via setsid, in its OWN process group, with a trap that
# kills that group. Without this, killing the wrapper leaves `npm run build` ->
# `tauri build` -> node ORPHANED and still writing to the shared staging dir
# (observed: ~10 minutes of a killed build continuing to corrupt a peer's).
# Note there is no safe pattern-kill alternative — a host-wide
# `pkill -f 'tauri build'` kills peers' builds and is guarded against
# (EI-18690252462401774), so owning our own process group is the only correct fix.
#
# EI-18721802836296042: the default lock path used to be a single fixed
# /tmp path regardless of CARGO_TARGET_DIR. That's correct for the common case
# (CARGO_TARGET_DIR unset, everyone sharing $HOME/.cargo-target — the whole
# reason this mutex exists), but it also means an agent who deliberately
# isolates CARGO_TARGET_DIR (the documented workaround for this exact
# collision class — see the memory note this script's own header references)
# still contends the SAME global lock as every other build on the box, even
# though their bundle dir is provably disjoint and there is no real collision
# risk. Hit live 2026-07-26: an isolated-target build queued 11+ minutes
# behind an unrelated peer's ~5h-old build on the shared default target dir,
# nearly hitting the 3600s timeout on a critical-path deb.
#
# FIX: default the lock path OFF CARGO_TARGET so it naturally follows the same
# isolation an agent already opted into — no separate env var to remember, no
# risk of eating a spurious stall/timeout just for not knowing the trick. An
# explicit PAPERCUSP_DEB_BUNDLE_LOCK still overrides this for anyone who wants
# a different scheme.
BUNDLE_LOCK="${PAPERCUSP_DEB_BUNDLE_LOCK:-$CARGO_TARGET/.deb-bundle.lock}"
BUNDLE_LOCK_WAIT="${PAPERCUSP_DEB_BUNDLE_LOCK_WAIT:-3600}"
mkdir -p "$(dirname "$BUNDLE_LOCK")"

# --- HARD BUILD TIMEOUT (EI-18721897570279658, hardened EI-18726398328755840) -
#
# BUNDLE_LOCK_WAIT above bounds how long a LOSER waits to ACQUIRE the lock —
# it does nothing to bound how long the WINNER may hold it. A build that
# wedges (hangs against a stuck toolchain, a stalled network fetch, a runaway
# linker, ...) previously squatted on the lock — and on cargo's own
# target-dir lock underneath it — for as long as the process lived, with
# nothing to reap it. Observed live 2026-07-26: an orphaned build (its
# owning work-item already closed, its own session long gone) sat at ~99% CPU
# for 5h13m with no cargo/rustc child left to explain the CPU, starving the
# next scheduled deb build behind cargo's target-dir lock and burning a real
# CPU core the whole time as phantom host load.
#
# FIX (original): wrap the build in `timeout` so it fails LOUDLY after a
# bounded duration instead of squatting silently, then kill the whole PROCESS
# GROUP on the way out (`kill -TERM/-KILL "-$BUILD_PGID"`) so a killed build
# cannot orphan into the shared staging dir.
#
# HARDENING (EI-18726398328755840): that process-GROUP-based enforcement was
# observed live to NOT fire on a real npm/tauri build — 74min+ past the
# 3630s cap, the `timeout` monitor process had vanished from the box entirely
# (not wedged — gone) while the real build chain kept running, its topmost
# surviving process reparented directly under this script with no
# setsid/timeout process left in between. Signalling one process GROUP is
# provably defeatable the moment ANY descendant in the real
# npm -> tauri -> cargo -> bundler chain calls setsid()/setpgid() to detach
# itself into a NEW session (a common thing: daemonizing helpers, persistent
# workers, cargo build-script children, ...) — proven directly on this box
# (a `setsid`-escaped grandchild survives `kill -TERM "-$PGID"` every time),
# while a cgroup the whole tree was born into still reaches it, because
# cgroup-v2 membership is inherited by every fork regardless of
# session/process-group changes, and escaping it requires a privileged
# migration no build tool performs. This is the SAME shape already
# established in this codebase for exactly this reason — see
# packages/operator-core/lib/p2p/sandbox/enforcement-kill.ts, which documents
# 'cgroup-freeze-kill' as the FULL guarantee and a bare pid/pgid kill as its
# explicitly weaker fallback.
#
# So: the whole build subtree is (best-effort) placed in a dedicated cgroup
# at launch, and TWO independent mechanisms now enforce the deadline — the
# original `timeout` (cheap, still helps in the common case) AND a
# from-scratch watchdog that does not trust `timeout`'s own process to
# survive: it independently re-checks the cgroup well past the same deadline
# and force-kills it if anything is still alive, however that happened to
# survive — so a repeat of "the monitor itself vanished" no longer means
# unbounded runtime. Degrades gracefully to today's process-group-only
# behavior when cgroup v2 isn't available/delegated — never fails the build
# over this.
BUILD_TIMEOUT_SEC="${PAPERCUSP_DEB_BUILD_TIMEOUT_SEC:-3600}"
# EI-21561573003367567: compile/bundle and xz are separate phases with
# independent budgets. A cold compile can no longer consume the repack's
# clock, and an advancing xz is never mislabeled as a wedged compiler merely
# because the combined wall time crossed the old one-hour ceiling.
REPACK_TIMEOUT_SEC="${PAPERCUSP_DEB_REPACK_TIMEOUT_SEC:-5400}"
WATCHDOG_GRACE_SEC="${PAPERCUSP_DEB_WATCHDOG_GRACE_SEC:-45}"
for _timeout_name in BUILD_TIMEOUT_SEC REPACK_TIMEOUT_SEC; do
  _timeout_value="${!_timeout_name}"
  [[ "$_timeout_value" =~ ^[1-9][0-9]*$ ]] || {
    echo "FATAL: $_timeout_name must be a positive integer, got: $_timeout_value" >&2
    exit 8
  }
done
[[ "$WATCHDOG_GRACE_SEC" =~ ^[0-9]+$ ]] || {
  echo "FATAL: WATCHDOG_GRACE_SEC must be a non-negative integer, got: $WATCHDOG_GRACE_SEC" >&2
  exit 8
}

CGROOT="${PAPERCUSP_CGROUP_ROOT:-/sys/fs/cgroup}"
BUILD_CGROUP=""
if [ "$(stat -fc %T "$CGROOT" 2>/dev/null)" = cgroup2fs ]; then
  SELF_CG_REL="$(awk -F: '{print $3}' /proc/self/cgroup 2>/dev/null | head -1)"
  if [ -n "$SELF_CG_REL" ]; then
    CAND="$CGROOT$SELF_CG_REL/papercusp-deb-build-$$-$(date +%s%N 2>/dev/null || echo 0)"
    if mkdir -p "$CAND" 2>/dev/null; then
      BUILD_CGROUP="$CAND"
      echo "==> build subtree bounded to cgroup $BUILD_CGROUP (kill reaches it even if a descendant escapes its process group/session)"
    fi
  fi
fi
if [ -z "$BUILD_CGROUP" ]; then
  echo "NOTE: no delegated cgroup v2 available under $CGROOT — falling back to process-group-only enforcement (weaker: a descendant that escapes its session/process group via setsid/setpgid will not be reached by the timeout kill; see EI-18726398328755840)." >&2
fi

# Definitive kill of the whole build subtree: freeze first (stop it from
# forking MORE escapees mid-kill), TERM everything for a graceful chance to
# flush/exit cleanly, then the unconditional cgroup.kill (SIGKILL, cannot be
# dodged by any process in the cgroup, escaped session or not) as the
# backstop. Safe to call repeatedly / when BUILD_CGROUP is unset or gone.
kill_build_cgroup() {
  [ -n "$BUILD_CGROUP" ] && [ -d "$BUILD_CGROUP" ] || return 0
  echo 1 > "$BUILD_CGROUP/cgroup.freeze" 2>/dev/null || true
  while IFS= read -r _p; do kill -TERM "$_p" 2>/dev/null || true; done < "$BUILD_CGROUP/cgroup.procs" 2>/dev/null || true
  echo 0 > "$BUILD_CGROUP/cgroup.freeze" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    [ -s "$BUILD_CGROUP/cgroup.procs" ] 2>/dev/null || break
    sleep 1
  done
  echo 1 > "$BUILD_CGROUP/cgroup.kill" 2>/dev/null || true
}

cleanup_build_cgroup() {
  [ -n "$BUILD_CGROUP" ] && [ -d "$BUILD_CGROUP" ] || return 0
  for _ in 1 2 3 4 5; do
    rmdir "$BUILD_CGROUP" 2>/dev/null && return 0
    sleep 1
  done
}

BUILD_PGID=""
ARCHIVE_TMP=""
ARCHIVE_SIG_TMP=""
ARCHIVE_SIG_PUBLISHED=""
DEB_BUILD_MARKER=""
stop_build_group() {
  if [ -n "$BUILD_PGID" ] && kill -0 "-$BUILD_PGID" 2>/dev/null; then
    echo "==> stopping build process group $BUILD_PGID (so it cannot orphan into the shared staging dir)" >&2
    kill -TERM "-$BUILD_PGID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "-$BUILD_PGID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "-$BUILD_PGID" 2>/dev/null || true
  fi
  kill_build_cgroup
  cleanup_build_cgroup
  if [ -n "$ARCHIVE_TMP" ]; then
    rm -f -- "$ARCHIVE_TMP"
  fi
  if [ -n "$ARCHIVE_SIG_TMP" ]; then
    rm -f -- "$ARCHIVE_SIG_TMP"
  fi
  if [ -n "$DEB_BUILD_MARKER" ]; then
    rm -f -- "$DEB_BUILD_MARKER"
  fi
  # The signature is published first and the .deb is the discoverable commit
  # marker. Roll back a signature-only publication after any ordinary failure;
  # after the .deb move succeeds this condition is false and the pair remains.
  if [ -n "$ARCHIVE_SIG_PUBLISHED" ] \
     && [ ! -f "${ARCHIVE_SIG_PUBLISHED%.sig}" ]; then
    rm -f -- "$ARCHIVE_SIG_PUBLISHED"
  fi
  cleanup_deb_source_snapshot
}
trap stop_build_group EXIT INT TERM

exec 9>"$BUNDLE_LOCK"
if ! flock -w "$BUNDLE_LOCK_WAIT" 9; then
  echo "FATAL: timed out after ${BUNDLE_LOCK_WAIT}s waiting for the deb bundle lock ($BUNDLE_LOCK)." >&2
  echo "       Another agent is very likely mid-build against the same shared" >&2
  echo "       \$CARGO_TARGET bundle directory. Check with:" >&2
  echo "         pgrep -af 'tauri build'   # then read /proc/<pid>/environ for CLAUDE_CONFIG_DIR" >&2
  exit 5
fi
echo "==> holding deb bundle lock ($BUNDLE_LOCK)"

# Establish the artifact freshness boundary only AFTER acquiring the bundle
# mutex. Every pre-existing .deb is older than this marker. Sleeping across one
# whole timestamp tick makes the comparison reliable even on a filesystem with
# one-second mtime resolution; a build that emits nothing can no longer fall
# back to an older package and archive it under a fresh timestamp/source SHA.
mkdir -p "$DEB_DIR"
DEB_BUILD_MARKER="$(mktemp "$DEB_DIR/.papercusp-deb-build-start.XXXXXX")" || {
  echo "FATAL: could not create the deb build-start marker under $DEB_DIR." >&2
  exit 3
}
sleep 1

run_bounded_phase() {
  local phase_timeout_sec="$1"
  shift
  # Self-migrate into the cgroup as our OWN very first act (before setsid /
  # exec) so cgroup-v2 membership is inherited by every descendant from
  # birth — no race against something forking before we get a chance to
  # move it. $BASHPID (not $$, which bash deliberately keeps pinned to the
  # top-level shell's pid even inside a backgrounded subshell) is the real
  # pid of THIS process, matching what the caller's $! captured.
  if [ -n "$BUILD_CGROUP" ]; then
    echo "$BASHPID" > "$BUILD_CGROUP/cgroup.procs" 2>/dev/null || true
  fi
  exec setsid timeout --signal=TERM --kill-after=30 "$phase_timeout_sec" "$@"
}

# Independent watchdog (EI-18726398328755840): does NOT trust `timeout`'s own
# process to still be alive to enforce anything — it just re-checks the
# CGROUP well past the same deadline (kill-after's 30s + a further grace) and
# force-kills it if anything is still alive, however that happened to
# survive. A no-op in the normal case: the cgroup is already empty by the
# time this would fire, and it is killed the moment the build finishes.
#
# Cooperative shutdown via a flag FILE, not a process-group kill: whether a
# backgrounded job gets its OWN new process group here is a bash-config/
# environment detail we cannot rely on (observed to differ between an
# interactive top-level shell and a plain `bash -c` invocation) — a bare
# `kill $WATCHDOG_PID` can leave its inner `sleep` orphaned (same pgid as
# something else entirely) for the rest of a long grace window, holding this
# script's stdout/stderr pipes open and hanging any caller reading them for
# EOF (e.g. Node's spawnSync) well past the build's own real completion. A
# short poll loop that exits the moment it sees the done-flag sidesteps that
# uncertainty entirely — no reliance on pgid semantics at all.
WATCHDOG_PID=""
WATCHDOG_DONE_FLAG=""
start_phase_watchdog() {
  local phase_label="$1"
  local phase_timeout_sec="$2"
  WATCHDOG_PID=""
  WATCHDOG_DONE_FLAG=""
  [ -n "$BUILD_CGROUP" ] || return 0
  WATCHDOG_DONE_FLAG="$(mktemp -u "${TMPDIR:-/tmp}/papercusp-deb-watchdog-done.XXXXXX")"
  ( DEADLINE=$((phase_timeout_sec + 30 + WATCHDOG_GRACE_SEC))
    ELAPSED=0
    while [ "$ELAPSED" -lt "$DEADLINE" ]; do
      [ -e "$WATCHDOG_DONE_FLAG" ] && exit 0
      sleep 1
      ELAPSED=$((ELAPSED + 1))
    done
    if [ -s "$BUILD_CGROUP/cgroup.procs" ] 2>/dev/null; then
      echo "WATCHDOG: $phase_label subtree still alive well past its ${phase_timeout_sec}s+kill-after deadline — the primary timeout enforcement did not land (EI-18726398328755840). Forcing the cgroup kill." >&2
      kill_build_cgroup
    fi
  ) &
  WATCHDOG_PID=$!
}

stop_phase_watchdog() {
  [ -n "$WATCHDOG_PID" ] || return 0
  : > "$WATCHDOG_DONE_FLAG" 2>/dev/null || true
  wait "$WATCHDOG_PID" 2>/dev/null || true
  rm -f "$WATCHDOG_DONE_FLAG" 2>/dev/null || true
  WATCHDOG_PID=""
  WATCHDOG_DONE_FLAG=""
}

echo "=== building ($BUILD_CMD), bounded to ${BUILD_TIMEOUT_SEC}s ==="
set +e
run_bounded_phase "$BUILD_TIMEOUT_SEC" bash -c 'exec 8>&- 9>&-; cd "$1" && eval "$2"' _ "$DESKTOP_DIR" "$BUILD_CMD" &
BUILD_PGID=$!
start_phase_watchdog build "$BUILD_TIMEOUT_SEC"
wait "$BUILD_PGID"
BUILD_RC=$?
stop_phase_watchdog
set -e
BUILD_PGID=""
if [ "$BUILD_RC" -eq 124 ] || [ "$BUILD_RC" -eq 137 ] || [ "$BUILD_RC" -eq 143 ]; then
  echo "FATAL: build exceeded the ${BUILD_TIMEOUT_SEC}s timeout and was killed (rc=$BUILD_RC)." >&2
  echo "       This is very likely a WEDGED build (stuck toolchain fetch, a runaway" >&2
  echo "       linker, an orphaned process from a prior session) rather than a merely" >&2
  echo "       slow one — a clean release build here normally finishes in single-digit" >&2
  echo "       minutes. If this really is a deliberately long build (e.g. a cold cache" >&2
  echo "       on a fresh box), rerun with a larger PAPERCUSP_DEB_BUILD_TIMEOUT_SEC." >&2
  exit 6
fi
if [ "$BUILD_RC" -ne 0 ]; then
  echo "FATAL: build failed (rc=$BUILD_RC)." >&2
  echo "       If this was 'Failed to create md5sums file', suspect a CONCURRENT build" >&2
  echo "       rather than filesystem debris — but note this script now holds a mutex," >&2
  echo "       so a peer would have to be invoking 'npm run build' directly to collide." >&2
  exit "$BUILD_RC"
fi

DEB_CANDIDATE_LIST="$(find "$DEB_DIR" -maxdepth 1 -type f -iname '*.deb' \
  -newer "$DEB_BUILD_MARKER" -printf '%p\n' 2>/dev/null)"
rm -f -- "$DEB_BUILD_MARKER"
DEB_BUILD_MARKER=""
DEB_CANDIDATES=()
if [[ -n "$DEB_CANDIDATE_LIST" ]]; then
  mapfile -t DEB_CANDIDATES <<< "$DEB_CANDIDATE_LIST"
fi
if [ "${#DEB_CANDIDATES[@]}" -eq 0 ]; then
  echo "FATAL: build reported success but emitted no fresh .deb under $DEB_DIR." >&2
  echo "       Refusing to select a pre-existing package from an earlier build." >&2
  exit 3
fi
if [ "${#DEB_CANDIDATES[@]}" -ne 1 ]; then
  echo "FATAL: build emitted ${#DEB_CANDIDATES[@]} fresh .deb candidates under $DEB_DIR; expected exactly one." >&2
  printf '       %s\n' "${DEB_CANDIDATES[@]}" >&2
  exit 3
fi
DEB_PATH="${DEB_CANDIDATES[0]}"

# P-003 / desktop-release-size-reduction-2026-08-14: Tauri emits a
# data.tar.gz. Recompress it before archiving (and re-sign the changed bytes),
# saving ~193MB on the measured GUI artifact while retaining old-dpkg support.
# This is deliberately NOT inside BUILD_TIMEOUT_SEC: a cold compile and an
# advancing xz each own a full phase budget (EI-21561573003367567).
echo "=== repacking ($DEB_PATH), independently bounded to ${REPACK_TIMEOUT_SEC}s ==="
set +e
run_bounded_phase "$REPACK_TIMEOUT_SEC" bash -c 'exec 8>&- 9>&-; exec bash "$1" "$2"' _ "$LIVE_DESKTOP_DIR/bin/repack-deb-xz.sh" "$DEB_PATH" &
BUILD_PGID=$!
start_phase_watchdog repack "$REPACK_TIMEOUT_SEC"
wait "$BUILD_PGID"
REPACK_RC=$?
stop_phase_watchdog
set -e
BUILD_PGID=""
cleanup_build_cgroup
if [ "$REPACK_RC" -eq 124 ] || [ "$REPACK_RC" -eq 137 ] || [ "$REPACK_RC" -eq 143 ]; then
  echo "FATAL: xz repack exceeded its dedicated ${REPACK_TIMEOUT_SEC}s phase budget and was killed (rc=$REPACK_RC)." >&2
  echo "       The compile budget is independent and did not consume this clock. Check the component diagnostics and tune PAPERCUSP_DEB_REPACK_TIMEOUT_SEC only for a deliberately longer repack." >&2
  exit 9
fi
if [ "$REPACK_RC" -ne 0 ]; then
  echo "FATAL: xz repack phase failed (rc=$REPACK_RC); see the component statuses above." >&2
  exit "$REPACK_RC"
fi

if [[ -n "$DEB_SOURCE_SNAPSHOT_COMMIT" ]]; then
  GIT_SHA="${DEB_SOURCE_SNAPSHOT_COMMIT:0:10}"
else
  GIT_SHA="$(cd "$REPO_DIR" && git rev-parse --short HEAD 2>/dev/null || echo 'nogit')"
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASENAME="$(basename "$DEB_PATH" .deb)"
ARCHIVED_PATH="$ARCHIVE_DIR/${STAMP}-${GIT_SHA}-${ARCHIVE_LABEL}${BASENAME}.deb"
ARCHIVED_SIG_PATH="${ARCHIVED_PATH}.sig"
LIVE_SIG_PATH="${DEB_PATH}.sig"

mkdir -p "$ARCHIVE_DIR"
[[ -s "$LIVE_SIG_PATH" ]] || {
  echo "FATAL: signed deb has no non-empty updater signature: $LIVE_SIG_PATH" >&2
  echo "       Refusing to publish an archive that a downloader cannot verify." >&2
  exit 9
}

# Never hardlink either fixed live path into the archive. Tauri/dpkg may rewrite
# the .deb and signer may rewrite its .sig on the next build; a hardlink then
# mutates the supposedly immutable OLD archive too. Reflinks retain the near-zero
# incremental storage benefit while giving both archived files distinct inodes.
ARCHIVE_TMP="${ARCHIVED_PATH}.partial.$$"
ARCHIVE_SIG_TMP="${ARCHIVED_SIG_PATH}.partial.$$"
rm -f -- "$ARCHIVE_TMP" "$ARCHIVE_SIG_TMP"
cp --reflink=auto --preserve=mode,timestamps -- "$DEB_PATH" "$ARCHIVE_TMP"
cp --reflink=auto --preserve=mode,timestamps -- "$LIVE_SIG_PATH" "$ARCHIVE_SIG_TMP"
if [[ "$(stat -c '%d:%i' "$DEB_PATH")" == "$(stat -c '%d:%i' "$ARCHIVE_TMP")" ]]; then
  echo "FATAL: archive copy shares the live deb inode; refusing a mutable archive ($ARCHIVE_TMP)." >&2
  exit 9
fi
if [[ "$(stat -c '%d:%i' "$LIVE_SIG_PATH")" == "$(stat -c '%d:%i' "$ARCHIVE_SIG_TMP")" ]]; then
  echo "FATAL: archive copy shares the live signature inode; refusing a mutable archive ($ARCHIVE_SIG_TMP)." >&2
  exit 9
fi
cmp -s -- "$DEB_PATH" "$ARCHIVE_TMP" || {
  echo "FATAL: staged archive deb differs from the signed live bytes." >&2
  exit 9
}
cmp -s -- "$LIVE_SIG_PATH" "$ARCHIVE_SIG_TMP" || {
  echo "FATAL: staged archive signature differs from the live signature bytes." >&2
  exit 9
}

# Verify the STAGED pair, not the live pair. This proves the exact bytes about
# to become immutable are accepted by the updater key embedded in this pinned
# desktop source. Read the maintained Tauri config directly so the archive
# verifier cannot drift onto a parallel key/config surface.
UPDATER_PUBKEY="$(python3 - "$DESKTOP_DIR/src-tauri/tauri.conf.json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1], encoding='utf-8'))['plugins']['updater']['pubkey'])
except (OSError, KeyError, TypeError, ValueError):
    print('')
PY
)"
[[ -n "$UPDATER_PUBKEY" ]] || {
  echo "FATAL: pinned Tauri config has no updater public key; signature cannot be verified." >&2
  exit 9
}
node "$LIVE_DESKTOP_DIR/bin/verify-tauri-signature.mjs" \
  "$UPDATER_PUBKEY" "$ARCHIVE_TMP" "$ARCHIVE_SIG_TMP"

# Publish the signature first, then the .deb as the commit marker. Archive
# consumers enumerate *.deb, so there is no observable package without its
# already-verified sibling. The EXIT trap rolls back a signature-only result if
# the second rename fails.
mv -- "$ARCHIVE_SIG_TMP" "$ARCHIVED_SIG_PATH"
ARCHIVE_SIG_TMP=""
ARCHIVE_SIG_PUBLISHED="$ARCHIVED_SIG_PATH"
mv -- "$ARCHIVE_TMP" "$ARCHIVED_PATH"
ARCHIVE_TMP=""
ARCHIVE_SIG_PUBLISHED=""
echo "✓ archived + updater-signature verified (immutable reflink/copies): $ARCHIVED_PATH (+ .sig)"

# Prune to the last $KEEP archived builds (oldest-first deletion), so an
# unattended repeated build (e.g. a periodic gate) never grows this unbounded.
# Do not hide a failed census inside process substitution: `mapfile < <(find …)`
# reports the mapfile status (usually zero) to the parent shell even when find,
# sort, or cut failed. That would claim a successful release while silently
# skipping retention. Capture the pipeline directly under pipefail so every
# enumeration failure is an explicit packaging failure.
ARCHIVED_LIST=""
if ! ARCHIVED_LIST="$(find "$ARCHIVE_DIR" -maxdepth 1 -iname '*.deb' -printf '%T@ %p\n' 2>/dev/null | sort -n | cut -d' ' -f2-)"; then
  echo "FATAL: could not enumerate archived Debian packages for retention under $ARCHIVE_DIR." >&2
  exit 9
fi
ARCHIVED=()
if [[ -n "$ARCHIVED_LIST" ]]; then
  mapfile -t ARCHIVED <<< "$ARCHIVED_LIST"
fi
COUNT="${#ARCHIVED[@]}"
if [ "$COUNT" -gt "$KEEP" ]; then
  PRUNE_COUNT=$((COUNT - KEEP))
  for ((i = 0; i < PRUNE_COUNT; i++)); do
    echo "  pruning old archive: ${ARCHIVED[$i]}"
    # Hide the discoverable .deb first, then remove its companion. At no point
    # can a retained archive package be visible without a signature.
    rm -f -- "${ARCHIVED[$i]}"
    rm -f -- "${ARCHIVED[$i]}.sig"
  done
fi

echo "=== done: archived verified pair $ARCHIVED_PATH (+ .sig), $KEEP most-recent builds retained ==="
# Keep the line above the ONLY `echo "=== done:` in this file and keep the
# branch below AFTER it: build-deb-archive-immutability.test.js slices the real
# archive block up to that literal.
if [[ "$TEST_ARTIFACT" == "1" ]]; then
  # WI-10003499: remove the live copy LAST, after the test-artifact pair is
  # published and verified. bundle/deb/Papercusp*_amd64.deb is exactly what
  # live-federation-gate and hive-git-drill scavenge by default; leaving an
  # unaudited package there would let a release-shaped consumer pick it up.
  rm -f -- "$DEB_PATH" "$LIVE_SIG_PATH"
  echo "    TEST ARTIFACT: live bundle/deb copy removed; pass this path explicitly to a drill."
  echo "TEST_ARTIFACT_DEB=$ARCHIVED_PATH"
else
  echo "    live artifact: $DEB_PATH"
fi
