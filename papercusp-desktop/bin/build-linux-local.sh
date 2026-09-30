#!/usr/bin/env bash
# Build the Linux x86_64 desktop release (deb + AppImage) LOCALLY, WITHOUT
# GitHub — the committed local-Linux counterpart to bin/build-windows-on-vm.sh
# and the mac VM leg. Produces artifacts the owner uploads themselves (fact
# releases-not-on-github-owner-2026-07-08); prints their paths + sha256.
#
# WHY THIS EXISTS (2026-07-09): there was no committed local-Linux recipe — the
# canonical bin/release-local.sh bakes in a version-bump + `gh release` publish,
# so past local Linux builds were an ad-hoc manual chain. This scripts that chain
# durably AND fixes the artifact-location divergence: this box has a GLOBAL cargo
# override (~/.cargo/config.toml → target-dir = ~/.cargo-target), so a native
# `cargo`/`tauri build` drops bundles under ~/.cargo-target/release/bundle, NOT
# under the source tree like the Mac (src-tauri/target/universal-apple-darwin/…)
# and Windows (src-tauri/target/windows-vm/…) legs. This script COLLECTS the
# finished Linux artifacts into src-tauri/target/release/bundle/ so all three
# platforms' release artifacts live under one tree:
#     papercusp-desktop/src-tauri/target/…
# (both that path and ~/.cargo-target are symlinked to /mnt/data on the dev box,
# so the collection is a same-filesystem move — instant, no copy.)
#
# Usage:
#   bin/build-linux-local.sh                 # version from tauri.conf.json
#   PAPERCUSP_SKIP_SEED_CUT=1 bin/build-linux-local.sh   # reuse committed seed
#   PAPERCUSP_DISTRIBUTION_PROFILE=vm-release bin/build-linux-local.sh
#                                                   # immutable Server-only VM package
#
# Env passthrough (same knobs as release-local.sh's Linux leg):
#   PAPERCUSP_DISTRIBUTION_PROFILE
#                              dogfood (default): preserve the source/env-sidecar,
#                              GUI+Server and multi-environment developer package;
#                              vm-release: emit one immutable runtime-only Server
#                              .deb and reject conflicting role selection
#   PAPERCUSP_SKIP_SEED_CUT=1  reuse src-tauri/seed as-is (no live-store seed cut)
#   PAPERCUSP_REUSE_SIDECAR=1   reuse the already-verified Linux sidecar,
#                               env-sidecars and source.tar.zst; resume at Tauri
#                               packaging after an interrupted local build
#   PAPERCUSP_BUILD_ROLES      subset of "gui server" (default: BOTH — D-004 of
#                              desktop-build-speed-2026-07-16 restored this after
#                              WI-5085/P-006's gui-only default silently dropped the
#                              published linux Server .deb/.appimage from a release
#                              cut, see EI-18099496479921046. Pass "gui" for the
#                              fast-iteration gui-only opt-in. A real Linux Server
#                              deploy, e.g. a Hetzner box, does not go through this
#                              knob — see bin/build-and-archive-deb.sh)
#   PAPERCUSP_RELEASE_OWNER_NAME  human owner name asserted at run time for the
#                                 release identity audit (required; never write it
#                                 into the tree)
#   PAPERCUSP_RELEASE_OWNER_EMAIL optional comma/semicolon-separated owner
#                                 address list for email audit coverage
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  minisign key passphrase (default empty)
set -euo pipefail

# A local cut routinely runs for tens of minutes out of the shared tree. Bash
# re-reads a script by byte offset instead of slurping it up front, so git-sync
# atomically replacing this file mid-run can shift the offsets and crash a
# syntactically valid build with a phantom parse error. This is the same hazard
# and fix as live-federation-gate.sh (EI-16828): re-exec an immutable private
# snapshot once, while resolving every resource against the original repo root.
if [[ -z "${PAPERCUSP_BUILD_LINUX_SELF_SNAPSHOT:-}" ]]; then
  BUILD_LINUX_ROOT_FOR_SNAPSHOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  BUILD_LINUX_SNAPSHOT_DIR="$(mktemp -d /tmp/papercusp-build-linux-local.XXXXXX)"
  cp -- "${BASH_SOURCE[0]}" "$BUILD_LINUX_SNAPSHOT_DIR/build-linux-local.sh"
  chmod +x "$BUILD_LINUX_SNAPSHOT_DIR/build-linux-local.sh"
  export PAPERCUSP_BUILD_LINUX_SELF_SNAPSHOT=1
  export PAPERCUSP_BUILD_LINUX_SNAPSHOT_DIR="$BUILD_LINUX_SNAPSHOT_DIR"
  export PAPERCUSP_BUILD_LINUX_ROOT="$BUILD_LINUX_ROOT_FOR_SNAPSHOT"
  exec bash "$BUILD_LINUX_SNAPSHOT_DIR/build-linux-local.sh" "$@"
fi
trap 'rm -rf -- "${PAPERCUSP_BUILD_LINUX_SNAPSHOT_DIR:-}"' EXIT

ROOT="${PAPERCUSP_BUILD_LINUX_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HERE="$ROOT/bin"
cd "$ROOT"

# D-043 / P-049: customer VM releases are a separate, explicit packaging
# profile. The absent knob MUST keep the historical dogfood behavior: both
# roles, staged environment sidecars, editable source and the broad Server
# overlay. The vm-release profile is deliberately fail-closed; no caller can
# accidentally widen it back to GUI/dev payloads through PAPERCUSP_BUILD_ROLES.
# shellcheck source=lib/distribution-profile.sh
. "$HERE/lib/distribution-profile.sh"
DISTRIBUTION_PROFILE="${PAPERCUSP_DISTRIBUTION_PROFILE:-$(default_distribution_profile "$ROOT")}"
# Exported so cargo's option_env!("PAPERCUSP_DISTRIBUTION_PROFILE") bakes it into the shell.
export PAPERCUSP_DISTRIBUTION_PROFILE="$DISTRIBUTION_PROFILE"
case "$DISTRIBUTION_PROFILE" in
  dogfood|public)
    ROLES="${PAPERCUSP_BUILD_ROLES:-gui server}"
    ;;
  vm-release)
    if [[ "${PAPERCUSP_BUILD_ROLES+x}" == x && "$PAPERCUSP_BUILD_ROLES" != "server" ]]; then
      echo "ERROR: PAPERCUSP_DISTRIBUTION_PROFILE=vm-release requires PAPERCUSP_BUILD_ROLES=server (or unset); got '${PAPERCUSP_BUILD_ROLES}'" >&2
      exit 2
    fi
    ROLES="server"
    export PAPERCUSP_BUILD_ROLES="$ROLES"
    export PAPERCUSP_STAGE_SOURCE=0
    ;;
  *)
    echo "ERROR: PAPERCUSP_DISTRIBUTION_PROFILE must be dogfood, public or vm-release (got '$DISTRIBUTION_PROFILE')" >&2
    exit 2
    ;;
esac

# ── OWNER-NAME PREFLIGHT (EI-21129566831677520). This entrypoint always
# produces release artifacts, and its final identity audit cannot certify the
# bundle without an explicitly asserted human owner name. The stager also runs
# this shared check, but waiting until [3/5] means sidecar assembly and
# env-sidecar staging have already spent time before a doomed build is refused.
# Keep the policy in audit-release-bundle.py so every producer uses the same
# non-secret, runtime-only contract.
python3 "$HERE/audit-release-bundle.py" --owner-preflight \
  || { echo "ERROR: owner-name preflight failed — refusing to start Linux release build" >&2; exit 2; }

# WI-240169: systemd user managers retain their launch-time PATH, which commonly
# omits Cargo's default install directory even when the owner has a healthy
# Rust toolchain at ~/.cargo/bin. The sidecar builder repairs that only for its
# own child process; without the same parent-entrypoint preflight, a release cut
# can finish the expensive sidecar work and then fail at this script's later
# `cargo metadata` / Tauri invocation. Keep the owner-name policy check first,
# then resolve Cargo before any build work. Honour a caller-selected cargo and a
# relocated CARGO_HOME; amend PATH only when cargo is otherwise unavailable.
_cargo_home="${CARGO_HOME:-$HOME/.cargo}"
if ! command -v cargo >/dev/null 2>&1 && [[ -x "$_cargo_home/bin/cargo" ]]; then
  export PATH="$_cargo_home/bin:$PATH"
  hash -r
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "ERROR: Linux release build requires Cargo, but PATH has no cargo and $_cargo_home/bin/cargo is not executable." >&2
  echo "       Install/expose the Rust toolchain (systemd callers usually need CARGO_HOME/bin on PATH), then re-run." >&2
  exit 1
fi
echo "→ using Cargo toolchain: $(command -v cargo) ($(cargo --version))"
unset _cargo_home

# ── Update source. LOAD IT HERE, in the producer (WI-4389) ───────────────────
# This script used to have no idea PAPERCUSP_RELEASE_HOST existed: it worked only
# because release-local.sh exported it and the value inherited across the local
# fork. Run THIS script directly — the normal way to rebuild one leg — and
# option_env!("PAPERCUSP_RELEASE_HOST") baked an EMPTY STRING, the compile
# SUCCEEDED, and the .deb shipped an app that polls nothing and reports
# "up to date" forever. Nothing was red. That is the 0.0.8 defect.
# shellcheck source=lib/release-host.sh
source "$HERE/lib/release-host.sh"
load_release_host
# EI-20551860898590077: release-local.sh exports PAPERCUSP_RELEASE_TAG for its
# child legs. A direct release-leg caller can provide the same tag explicitly;
# without it, the later incremental/upload path fails closed on a missing stamp.
# shellcheck source=lib/release-artifacts.sh
source "$HERE/lib/release-artifacts.sh"

# WI-5083: RUSTC_WRAPPER=sccache backed by a persistent ~/.cache/sccache, so
# even this "local" build reuses crates compiled by a prior run/checkout
# instead of a bare-metal recompile. Best-effort — see lib/sccache.sh.
# shellcheck source=lib/sccache.sh
source "$HERE/lib/sccache.sh"
setup_sccache_env "30G"

# EI-18105311090526787: defensive parity with mac-vm-build.sh — this dev box
# happens to have a system `ld.lld` on PATH already (the `lld` apt package),
# but the `-fuse-ld=lld` config (../.cargo/config.toml) applies here too, and a
# cold build on a box WITHOUT that system package would hit the same cc-crate
# build-script linker failure the mac VM did.
# shellcheck source=lib/lld-path.sh
source "$HERE/lib/lld-path.sh"
setup_lld_path
# Keep the direct Linux release entrypoint independent of an ambient caller:
# Cargo suppresses target.*.rustflags as soon as RUSTFLAGS exists.
# shellcheck source=lib/rust-path-remap.sh
source "$HERE/lib/rust-path-remap.sh"
papercusp_export_rust_path_remap
papercusp_export_rust_lld linux

# Claim one stable Cargo target slot for the ENTIRE dual-role build. The GUI
# and Server share one Rust binary and must therefore reuse the same claimed
# directory, while an unrelated live desktop/build must never interleave its
# generated Tauri manifest with this release cut (WI-7101).
# shellcheck source=lib/claim-target-dir.sh
source "$HERE/lib/claim-target-dir.sh"

VERSION="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
BUILD_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '')"
if [[ -n "${PAPERCUSP_RELEASE_TAG:-}" ]]; then
  PAPERCUSP_RELEASE_CUT_START_NS="$(release_artifacts_cut_start_ensure "$PAPERCUSP_RELEASE_TAG")"
  export PAPERCUSP_RELEASE_CUT_START_NS
  echo "==> release artifact freshness: cut-start=$PAPERCUSP_RELEASE_CUT_START_NS (tag=$PAPERCUSP_RELEASE_TAG)"
fi
KEY_FILE="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.papercusp/signing/papercusp.key}"
[[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" || -f "$KEY_FILE" ]] || {
  echo "ERROR: minisign signing key not found at $KEY_FILE"
  echo "       Run bin/setup-signing-key.sh, set TAURI_SIGNING_PRIVATE_KEY_PATH,"
  echo "       or export TAURI_SIGNING_PRIVATE_KEY (key content or a path) first."
  exit 1
}

# Collection destination — the same tree Mac/Windows artifacts land in.
DEST_BUNDLE="$ROOT/src-tauri/target/release/bundle"

echo "==> Linux local build: desktop sha=${BUILD_SHA:-<none>} version=$VERSION profile=$DISTRIBUTION_PROFILE roles='$ROLES'  $(date -u +%H:%M:%SZ)"
echo "    (provenance baked via option_env! → /api/health self-reports sha+version)"

# ── Seed: reuse the committed src-tauri/seed unless a cut is explicitly wanted.
# A live-store seed cut belongs in release-local.sh (it owns cut_release_seed);
# a local rebuild almost always reuses the committed seed.
if [[ "$DISTRIBUTION_PROFILE" == "dogfood" && "${PAPERCUSP_SKIP_SEED_CUT:-0}" != "1" ]]; then
  echo "WARN: PAPERCUSP_SKIP_SEED_CUT!=1 — this local script does NOT cut a fresh seed;"
  echo "      it ships the committed src-tauri/seed. Use bin/release-local.sh for a seed cut."
elif [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
  echo "==> vm-release excludes src-tauri/seed; updates replace the signed package"
fi

hold_sidecar_read_lock() {
  local lock="$ROOT/src-tauri/sidecar.lock"
  command -v flock >/dev/null 2>&1 || {
    echo "ERROR: flock(1) is required to package the live sidecar safely on Linux" >&2
    exit 1
  }
  mkdir -p "$(dirname "$lock")"
  # Match tauri-guarded/cargo-build-safe.sh: the sidecar builder owns this
  # lock EXCLUSIVELY while publishing; finite Tauri packaging owns it SHARED
  # while build.rs and the bundler enumerate resources. fd 8 is the Cargo
  # target-slot claim, so keep the reader on the established fd 9 convention.
  exec 9>>"$lock"
  if ! flock -sn 9; then
    echo "→ build-desktop-sidecar.sh holds $lock exclusively — waiting before packaging sidecar/" >&2
    flock -s 9
  fi
  echo "→ sidecar resources pinned by shared lock for this finite package read" >&2
}

assert_vm_release_deb_runtime_only() {
  local deb="${1:?vm-release deb path required}"
  local members_file="$PAPERCUSP_BUILD_LINUX_SNAPSHOT_DIR/vm-release-deb-members.txt"
  local leaked=0

  # Inspect the FINISHED Debian payload, not only the Tauri config. A future
  # config merge/default change must fail here if dogfood-only bytes reappear.
  if ! dpkg-deb --fsys-tarfile "$deb" | tar -tf - >"$members_file"; then
    echo "ERROR: could not enumerate vm-release Debian payload: $deb" >&2
    exit 1
  fi
  while IFS= read -r member; do
    case "$member" in
      *"/sidecar/source.tar.zst"|*"/sidecar/env-sidecars"|*"/sidecar/env-sidecars/"*|*"/seed"|*"/seed/"*|*"/resources/"*)
        echo "ERROR: vm-release forbidden payload member: $member" >&2
        leaked=1
        ;;
    esac
  done <"$members_file"
  [[ "$leaked" == 0 ]] || exit 1

  # Reuse the archive-aware identity scanner so a runtime-only release cannot
  # pass merely because its container bytes were opaque to grep. --licenses also
  # runs the installer license gate (scripts/check-licenses.mjs --installer-tree,
  # WI-10003906 / P-017) on the same expanded tree: every native binary, model file
  # and Syft package must map to a reviewed component in scripts/installer-components.json.
  # Report-only for now (owner decision 2026-09-29): findings print, the release continues.
  python3 "$HERE/audit-release-bundle.py" --scan-artifact --licenses "$deb"
}

case "${PAPERCUSP_REUSE_SIDECAR:-0}" in
  0)
    echo "==> [1/5] building sidecar (build-desktop-sidecar.sh)"
    PAPERCUSP_BUILD_SHA="$BUILD_SHA" PAPERCUSP_DESKTOP_VERSION="$VERSION" \
      bash "$ROOT/bin/build-desktop-sidecar.sh"

    if [[ "$DISTRIBUTION_PROFILE" == "dogfood" ]]; then
      echo "==> [2/5] staging env-sidecars (stage-env-sidecars.sh)"
      bash "$ROOT/bin/stage-env-sidecars.sh"

      echo "==> [3/5] staging source tree / all-5-buttons bundle (stage-source-tree.sh)"
      bash "$ROOT/bin/stage-source-tree.sh"
      hold_sidecar_read_lock
    else
      echo "==> [2-3/5] vm-release — skipping env-sidecars and editable source staging"
      hold_sidecar_read_lock
    fi
    ;;
  1)
    echo "==> [1-3/5] PAPERCUSP_REUSE_SIDECAR=1 — validating the staged Linux sidecar before resuming packaging"
    hold_sidecar_read_lock
    required_payload=(
      src-tauri/sidecar/serve.mjs \
      src-tauri/sidecar/spa/index.html \
      src-tauri/sidecar/build-provenance.json
    )
    if [[ "$DISTRIBUTION_PROFILE" == "dogfood" ]]; then
      required_payload+=(
        src-tauri/sidecar/env-sidecars/staging
        src-tauri/sidecar/source.tar.zst
      )
    fi
    for required in "${required_payload[@]}"; do
      [[ -e "$required" ]] || {
        echo "ERROR: PAPERCUSP_REUSE_SIDECAR=1 but required staged payload is missing: $required" >&2
        exit 1
      }
    done
    # vm-release binds its Rust launcher and sidecar runtime to ONE immutable
    # build identity. The runtime enforces the same equality at startup; letting
    # a stale-but-structurally-valid sidecar reach Tauri therefore produces a
    # signed package that installs successfully and then refuses every launch.
    # Reuse the maintained provenance verifier here so the mixed-SHA package is
    # rejected before Cargo/Tauri work instead of after a clean-VM install.
    if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
      if ! bash "$ROOT/bin/verify-provenance.sh" "$ROOT/src-tauri/sidecar" \
        --health-sha "$BUILD_SHA" --allow-dirty; then
        echo "ERROR: vm-release sidecar reuse must match build SHA $BUILD_SHA; rebuild without PAPERCUSP_REUSE_SIDECAR=1" >&2
        exit 1
      fi
    fi
    bash "$ROOT/bin/verify-sidecar-bundle.sh" "$ROOT/src-tauri/sidecar"
    # Reuse is a byte-for-byte packaging shortcut, not a release-policy bypass.
    # A sidecar assembled by a dev/background producer can be structurally valid
    # while still carrying that producer's local identity in SPA/docs content.
    # Catch that before the Rust build instead of several minutes later in the
    # AppImage's final assembled-tree scan (WI-40598).
    if [[ "$DISTRIBUTION_PROFILE" == "dogfood" ]]; then
      python3 "$ROOT/bin/audit-release-bundle.py" \
        --scan-dir "$ROOT/src-tauri/sidecar"
    else
      echo "==> vm-release reused runtime will be identity-scanned from the finished .deb"
    fi
    ;;
  *)
    echo "ERROR: PAPERCUSP_REUSE_SIDECAR must be 0 or 1 (got '${PAPERCUSP_REUSE_SIDECAR}')" >&2
    exit 2
    ;;
esac

# Never clobber a caller-supplied key: `tauri build` takes CONTENT or a path here, and an
# unconditional export makes every env-supplied override inert (EI-20549708598153511).
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$KEY_FILE"
else
  echo "==> updater signing key: supplied via TAURI_SIGNING_PRIVATE_KEY"
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# cargo's REAL target dir (this box has a global override → ~/.cargo-target, so it
# is NOT src-tauri/target). Resolved once, up front: both the release-host gate
# below and the artifact collection at the bottom need it.
SRC_ROOT="$(cd "$ROOT/src-tauri" && cargo metadata --no-deps --format-version 1 2>/dev/null \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("target_directory",""))' 2>/dev/null || true)"
[[ -n "$SRC_ROOT" ]] || SRC_ROOT="$ROOT/src-tauri/target"

VM_RELEASE_FRESHNESS_MARKER=""
if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
  VM_RELEASE_FRESHNESS_MARKER="$PAPERCUSP_BUILD_LINUX_SNAPSHOT_DIR/vm-release-cut-start"
  : >"$VM_RELEASE_FRESHNESS_MARKER"
fi

echo "==> [4/5] tauri build --bundles deb (profile: $DISTRIBUTION_PROFILE; roles: $ROLES)"
for role in $ROLES; do
  role_cfg=()
  role_binary=papercusp-desktop
  if [[ "$role" == "server" ]]; then
    if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
      role_cfg=(--config src-tauri/tauri.vm-release.conf.json)
    else
      role_cfg=(--config src-tauri/tauri.server.conf.json)
    fi
    role_binary=papercusp-server
  fi
  echo "    -- role=$role  $(date -u +%H:%M:%SZ)"
  (cd "$ROOT" && PAPERCUSP_BUILD_SHA="$BUILD_SHA" PAPERCUSP_BUILD_VERSION="$VERSION" \
     npx --yes -p @tauri-apps/cli@"${PAPERCUSP_TAURI_CLI_VERSION:-2.11.0}" tauri build --bundles deb "${role_cfg[@]}")

  # LABELED != PACKED (WI-4389). A .deb existing says NOTHING about whether the
  # update source reached the binary: option_env! bakes at compile time and bakes
  # an empty string SUCCESSFULLY when the var is absent. Gate on the BYTES, here
  # in the producer, so no caller can forget it.
  #
  # Gate the RAW binary, never the .deb/.AppImage — those are compressed archives
  # (ar+zstd / squashfs), so grepping them would MISS a correctly-baked host and
  # spuriously red the build. Same reason the mac leg gates the .app's Mach-O and
  # not the .dmg. Both roles build the single [[bin]] papercusp-desktop, so this
  # path is rewritten each iteration — which is exactly what we want to check.
  bash "$HERE/assert-release-host-baked.sh" "$SRC_ROOT/release/$role_binary" \
    || { echo "ERROR: role=$role — release host not baked; refusing to package a permanently-un-updatable app"; exit 1; }
done

# Tauri's Debian bundler emits gzip payloads. Dogfood preserves the historical
# all-role sweep. vm-release first selects exactly the fresh Server package by
# Debian identity, then repacks/audits ONLY that package: a stale same-version
# GUI artifact in the shared Cargo target must never enter the VM collector.
vm_release_debs=()
if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
  shopt -s nullglob
  for deb in "$SRC_ROOT"/release/bundle/deb/*_"$VERSION"_*.deb; do
    [[ "$deb" -nt "$VM_RELEASE_FRESHNESS_MARKER" ]] || continue
    [[ "$(dpkg-deb -f "$deb" Package 2>/dev/null || true)" == "papercusp-server" ]] || continue
    vm_release_debs+=("$deb")
  done
  shopt -u nullglob
  [[ ${#vm_release_debs[@]} -eq 1 ]] || {
    echo "ERROR: vm-release expected exactly one fresh papercusp-server .deb for version $VERSION; found ${#vm_release_debs[@]}" >&2
    exit 1
  }
  for deb in "${vm_release_debs[@]}"; do
    bash "$ROOT/bin/repack-deb-xz.sh" "$deb"
    [[ -f "$deb.sig" && "$deb.sig" -nt "$VM_RELEASE_FRESHNESS_MARKER" ]] || {
      echo "ERROR: vm-release package is not accompanied by a fresh updater signature: $deb.sig" >&2
      exit 1
    }
    assert_vm_release_deb_runtime_only "$deb"
  done
else
  for deb in "$SRC_ROOT"/release/bundle/deb/*_"$VERSION"_*.deb; do
    [[ -f "$deb" ]] && bash "$ROOT/bin/repack-deb-xz.sh" "$deb"
  done
fi

if [[ " $ROLES " == *" gui "* ]]; then
  echo "==> [5/5] building Linux AppImage (gui, build-appimage.sh)"
  (cd "$ROOT" && PAPERCUSP_BUILD_SHA="$BUILD_SHA" PAPERCUSP_BUILD_VERSION="$VERSION" \
     PAPERCUSP_BUILD_LINUX_COLLECTING=1 \
     TAURI_SIGNING_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY:-$KEY_FILE}" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
     bash "$ROOT/bin/build-appimage.sh")
fi

# ── COLLECT: move the finished artifacts under the source tree so all platforms
# share one location. $SRC_ROOT (cargo's real target dir, respecting the global
# override) was resolved before the build loop; if it already equals
# src-tauri/target this is a no-op. Same-filesystem move ⇒ instant rename.
echo "==> collecting Linux artifacts into $DEST_BUNDLE"
SRC_BUNDLE="$SRC_ROOT/release/bundle"

# The canonical source-tree target may be a host relocation symlink. A cleanup
# can remove its referent after the expensive package build finishes; recover
# that one safe missing-directory case before mkdir descends through the link.
papercusp_prepare_collection_target_root "$ROOT/src-tauri/target"

collected=()
if [[ "$(readlink -f "$SRC_BUNDLE" 2>/dev/null)" == "$(readlink -f "$DEST_BUNDLE" 2>/dev/null)" ]]; then
  echo "    cargo already targets the source tree — artifacts are in place ($DEST_BUNDLE)"
  if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
    for f in "${vm_release_debs[@]}"; do
      collected+=("$f" "$f.sig")
    done
  else
    for f in "$DEST_BUNDLE"/deb/*_"$VERSION"_*.deb "$DEST_BUNDLE"/deb/*_"$VERSION"_*.deb.sig \
             "$DEST_BUNDLE"/appimage/*_"$VERSION"_*.AppImage "$DEST_BUNDLE"/appimage/*_"$VERSION"_*.AppImage.sig; do
      [[ -f "$f" ]] && collected+=("$f")
    done
  fi
else
  mkdir -p "$DEST_BUNDLE/deb" "$DEST_BUNDLE/appimage"
  shopt -s nullglob
  if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
    for deb in "${vm_release_debs[@]}"; do
      for f in "$deb" "$deb.sig"; do
        mv -f "$f" "$DEST_BUNDLE/deb/"
        collected+=("$DEST_BUNDLE/deb/$(basename "$f")")
      done
    done
  else
    for f in "$SRC_BUNDLE"/deb/*_"$VERSION"_*.deb "$SRC_BUNDLE"/deb/*_"$VERSION"_*.deb.sig; do
      mv -f "$f" "$DEST_BUNDLE/deb/"; collected+=("$DEST_BUNDLE/deb/$(basename "$f")")
    done
    for f in "$SRC_BUNDLE"/appimage/*_"$VERSION"_*.AppImage "$SRC_BUNDLE"/appimage/*_"$VERSION"_*.AppImage.sig; do
      mv -f "$f" "$DEST_BUNDLE/appimage/"; collected+=("$DEST_BUNDLE/appimage/$(basename "$f")")
    done
  fi
  shopt -u nullglob
fi

[[ ${#collected[@]} -gt 0 ]] || { echo "ERROR: no Linux artifacts collected for version $VERSION under $SRC_BUNDLE"; exit 1; }

# The AppImage leg is a child of this producer and moves its finished output
# into DEST_BUNDLE; retain the final roots only after that collection is done
# so the lease cannot block the producer's own move.
papercusp_retain_release_paths "$SRC_ROOT" "$DEST_BUNDLE" "${collected[@]}" || exit 1

echo "=== LINUX BUILD DONE  $(date -u +%H:%M:%SZ) ==="
echo "Artifacts (under papercusp-desktop/src-tauri/target/release/bundle):"
for f in "${collected[@]}"; do printf '  %s\n' "$f"; done
echo "=== sha256 (installers only) ==="
for f in "${collected[@]}"; do
  case "$f" in *.deb|*.AppImage) sha256sum "$f" ;; esac
done
