#!/usr/bin/env bash
# Build + sign a Papercusp desktop release LOCALLY (no GitHub Actions, and —
# since 2026-07-12 — no GitHub publish at all). Run on this Linux box;
# produces a Linux x86_64 build by default, with cross-compile hooks for
# other targets.
#
# ⛔ RELEASES ARE LOCAL-ONLY. Owner directive (2026-07-08, restated
# 2026-07-12): "We are no longer using github for our releases so just build
# the installer locally and I will upload it to the right spot." The signed
# artifacts + latest.json on disk ARE the deliverable. This script prints each
# artifact with its sha256 at the end; hand those to the owner, who uploads.
# The old GitHub-publish leg (git push origin + gh release create/upload,
# behind PAPERCUSP_PUBLISH_GITHUB=1) has been DELETED, not merely defaulted
# off — see the note at the tail. Recover it from git history if that ever
# reverses.
#
# One separate, explicit remote-ref operation exists because a brand-new cut's
# dogfood clone pin needs an exact tag before artifact work starts:
#
#   PAPERCUSP_RELEASE_PREPARE_TAG_SHA=<40-char superproject sha> \
#   PAPERCUSP_RELEASE_PREPARE_TAG_CONFIRM=1 \
#     bin/release-local.sh <version> <channel>
#
# It creates only a MISSING tag under a force-with-lease expecting absence,
# verifies local+origin equality, and exits before any build or manifest write.
# It never creates a GitHub Release or uploads an artifact. Prefer the audited,
# dry-run-by-default `release:cut { op:'prepare-tag', ... }` wrapper.
#
# Usage:
#   bin/release-local.sh 0.0.8 stable     # tag + channel
#   bin/release-local.sh 0.0.8 beta
#
# What it does:
#   1. Bumps version in package.json + Cargo.toml + tauri.conf.json
#   2. Builds the sidecar (papercup/apps/operator → src-tauri/sidecar/)
#   3. cargo + Tauri build (signs with ~/.papercusp/signing/papercusp.key)
#   4. Generates latest.json manifest + release notes
#   5. Commits the version bump and creates a LOCAL git tag (never pushed)
#   6. Prints the local artifacts + sha256s, and stops.
#
# ⚠ THIS SCRIPT IS NOT READ-ONLY, and its first ~550 lines look like it is.
# Step 1 writes FOUR tracked files in the SHARED tree (package.json,
# src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}). git-sync commits that
# within minutes, and every running `tauri dev` watches this tree — so the write
# to tauri.conf.json restarts EVERY desktop on the box, the owner's included.
# Do NOT run it "to see where it stops" when testing a preflight change:
#
#   PAPERCUSP_RELEASE_PRECHECK_ONLY=1 bin/release-local.sh <version> <channel>
#
# runs every gate and exits 0 before the first write, having modified nothing.
#
# NOTE: a NORMAL CUT does `git commit` the version bump and may `git tag -f`
# locally (neither is pushed to origin). The dogfood *monorepo* tag must already
# exist on origin at the explicit expected source SHA; the normal cut verifies
# it and never creates, moves, or force-pushes that remote ref. The separate
# prepare-tag operation above is the only create path and never overwrites.
#
# Optional platform legs (both mac + windows now build NATIVELY on this Linux box
# via cross-compilation — the QEMU build VMs were retired as build legs, WI-5651;
# the VMs stay startable for on-device TESTING only):
#   - macOS  : WITH_MAC=1 — universal binary cross-compiled here by
#              bin/build-mac-cross.sh (cargo-zigbuild + llvm-lipo + rcodesign +
#              libdmg-hfsplus), UNSIGNED by Apple (D-002/D-006 of
#              mac-desktop-release-readiness-2026-06-11; updater artifacts are
#              still minisign-signed). No VM, no SSH.
#   - Windows: WITH_WINDOWS=1 — builds the Inno installer(s) via
#              bin/build-windows-cross.sh (cargo-xwin + Inno-under-wine) NATIVELY
#              on this Linux box — no VM, no SSH/lease (D-001/D-006 of
#              windows-desktop-release-readiness-2026-06-11). Not
#              Authenticode-signed unless an owner cert is supplied
#              (WINDOWS_CERT_*), so SmartScreen will warn.
#   - arm64  : cross-compile via WITH_ARM64=1 (needs `cross` set up)
#
# Which Tauri role(s) to build (WI-5085, desktop-build-speed-2026-07-16#P-006;
# default RESTORED to both roles by D-004 of that same plan — see EI-18099496479921046):
#   PAPERCUSP_BUILD_ROLES="gui server"     build BOTH roles (DEFAULT — a real release)
#   PAPERCUSP_BUILD_ROLES="gui"            GUI-role-only fast-iteration opt-in
# D-004 (desktop-build-speed-2026-07-16, 2026-07-16): P-006 proposed defaulting
# the release cut to GUI-only for speed, but that DIRECTLY CONFLICTS with
# WI-5028/record-release-cli: the linux Server .deb/.appimage is a real
# published download (product:'server'), and WI-5028 wants Server built on mac
# too (its mac gap was pure disk pressure — WI-5027 grew the mac VM 120→180GiB,
# 68GB free, so both roles' ~12GB targets now fit warm). D-004's resolution:
# do NOT flip the release default — keep BOTH roles in a real cut. The
# gui-only speed win stays available on demand:
# PAPERCUSP_BUILD_ROLES="gui" bin/release-local.sh builds gui-only for fast
# local iteration (documented in the release-upload runbook). ⚠ CORRECTED
# 2026-09-22: this used to say the WINDOWS leg "still defaults gui-only
# server-side (see build-windows-on-vm.sh)". That producer NO LONGER EXISTS —
# the leg is bin/build-windows-cross.sh (native cargo-xwin + Inno-under-wine),
# which takes ROLES="${PAPERCUSP_BUILD_ROLES:-gui server}" and so defaults to
# BOTH roles, matching the note further down this file. The stale wording cost
# a wrong "windows cannot be journalled" conclusion (WI-10002471); leaving the
# rest of the claim as-is because it is NOT re-verified here: the Server
# installer is a hard Inno-spanning limitation, not a disk/scope
# issue, so record-release-cli never publishes it regardless of whether it's
# built (WI-5028 checkpoint); building it today wastes a ~40min ISCC pack for
# an artifact nobody ships. Revisit the mac/linux default ONLY if the owner
# decides Server is being dropped as a product (then flip default + close
# WI-5028 as won't-do).
#
# Re-run safety: idempotent. If a release for the tag exists, asset
# uploads use `gh release upload --clobber`.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <version> <channel: alpha|beta|stable|nightly>"
  exit 1
fi

VERSION="$1"
CHANNEL="$2"
# An exact-source salvage cut deliberately combines the current orchestration
# script with a frozen target tree: callers source this file while setting $0
# to the frozen worktree entrypoint. Keep those roots separate. Libraries and
# orchestrator-owned producer scripts that THIS script revision calls follow
# BASH_SOURCE[0]; target roots and artifact paths continue to follow the
# target-tree $0 (EI-21078401508503033).
ORCHESTRATOR_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# A detached systemd launch may inherit a PATH without rustup's bin directory.
# Resolve Cargo before the first metadata query while preserving a toolchain the
# caller deliberately placed earlier on PATH.
ensure_release_cargo_path() {
  command -v cargo >/dev/null 2>&1 && return 0
  local cargo_home="${CARGO_HOME:-$HOME/.cargo}"
  if [[ -x "$cargo_home/bin/cargo" ]]; then
    export PATH="$PATH:$cargo_home/bin"
  fi
  command -v cargo >/dev/null 2>&1 || {
    echo "ERROR: cargo not resolvable (checked PATH and $cargo_home/bin)" >&2
    return 12
  }
}
# Signing-key selection must agree with every OTHER producer in bin/ — and with this
# same file's Windows preflight below, which already resolves
# "${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/...}" because build-windows-cross.sh:121 does.
# Hardcoding $HOME here made release-local.sh the ONE producer that ignored that
# override, so a cut launched with TAURI_SIGNING_PRIVATE_KEY_PATH set signed its Windows
# leg with the override and its Linux leg with the default — split-brain key selection
# inside a single cut. EI-20549708598153511 (latent sibling of the signer-key bug).
KEY_FILE="${TAURI_SIGNING_PRIVATE_KEY_PATH:-${HOME}/.papercusp/signing/papercusp.key}"
KEY_PUB="${KEY_FILE}.pub"

# Load only the two pure release-ref helpers before installing the cut's EXIT
# reaper. A repair-only call or a source-drift refusal must not claim build
# resources or run cleanup intended for a cut that actually launched children.
# shellcheck source=lib/gen-latest-manifest.sh
source "$ORCHESTRATOR_HERE/lib/gen-latest-manifest.sh"
# shellcheck source=lib/release-tag-pin.sh
source "$ORCHESTRATOR_HERE/lib/release-tag-pin.sh"
# Release-local's own function calls must resolve against the same revision as
# release-local.sh, even when $0 names a frozen target worktree.
# shellcheck source=lib/rust-path-remap.sh
source "$ORCHESTRATOR_HERE/lib/rust-path-remap.sh"

# A brand-new version needs an exact remote ref before the LOCAL-only cutter can
# bake its dogfood clone pin. Keep that outward write separate from the cut:
# create is explicit + confirmed, idempotent when already exact, and uses an
# empty force-with-lease expectation so it can never overwrite a concurrent ref.
if [[ -n "${PAPERCUSP_RELEASE_PREPARE_TAG_SHA:-}" ]]; then
  if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$ ]]; then
    echo "ERROR: version must look like X.Y.Z or X.Y.Z-foo" >&2
    exit 2
  fi
  case "$CHANNEL" in
    alpha|beta|stable|nightly) ;;
    *) echo "ERROR: channel must be alpha|beta|stable|nightly" >&2; exit 2 ;;
  esac
  TAG="$(desktop_release_tag "$VERSION" "$CHANNEL")"
  MONOREPO="$(cd "$ROOT/.." && pwd)"
  if [[ "${PAPERCUSP_RELEASE_PREPARE_TAG_CONFIRM:-0}" != "1" ]]; then
    echo "DRY RUN: would create missing local+origin refs/tags/$TAG at $PAPERCUSP_RELEASE_PREPARE_TAG_SHA"
    echo "Set PAPERCUSP_RELEASE_PREPARE_TAG_CONFIRM=1 to execute the create-only force-with-lease operation." >&2
    exit 2
  fi
  release_tag_create_exact "$MONOREPO" "$TAG" "$PAPERCUSP_RELEASE_PREPARE_TAG_SHA"
  exit $?
fi

# P-009 containment escape hatch. This is intentionally an explicit confirmed
# RELEASE-owned operation, not advice to run a manual `git push`. It only moves
# an existing desktop release tag to an exact commit object and verifies both
# local + origin refs before returning.
if [[ -n "${PAPERCUSP_RELEASE_REPAIR_TAG_SHA:-}" ]]; then
  if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$ ]]; then
    echo "ERROR: version must look like X.Y.Z or X.Y.Z-foo" >&2
    exit 2
  fi
  case "$CHANNEL" in
    alpha|beta|stable|nightly) ;;
    *) echo "ERROR: channel must be alpha|beta|stable|nightly" >&2; exit 2 ;;
  esac
  TAG="$(desktop_release_tag "$VERSION" "$CHANNEL")"
  MONOREPO="$(cd "$ROOT/.." && pwd)"
  if [[ "${PAPERCUSP_RELEASE_REPAIR_TAG_CONFIRM:-0}" != "1" ]]; then
    echo "DRY RUN: would repair local+origin refs/tags/$TAG to $PAPERCUSP_RELEASE_REPAIR_TAG_SHA"
    echo "Set PAPERCUSP_RELEASE_REPAIR_TAG_CONFIRM=1 to execute the force-with-lease repair." >&2
    exit 2
  fi
  release_tag_repair_exact "$MONOREPO" "$TAG" "$PAPERCUSP_RELEASE_REPAIR_TAG_SHA"
  exit $?
fi

# EI-20505417131773854: every cut is explicitly bound to one full superproject
# commit before any release-tree write. The agent-facing release:cut wrapper
# supplies this value; direct/manual callers must do the same. A moving staging
# HEAD therefore fails at second zero instead of silently re-pinning a release.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$ ]]; then
  echo "ERROR: version must look like X.Y.Z or X.Y.Z-foo"
  exit 1
fi
case "$CHANNEL" in
  alpha|beta|stable|nightly) ;;
  *) echo "ERROR: channel must be alpha|beta|stable|nightly"; exit 1 ;;
esac
MONOREPO="$(cd "$ROOT/.." && pwd)"
EXPECTED_SOURCE_SHA="${PAPERCUSP_EXPECTED_SOURCE_SHA:-}"
release_tag_validate_exact_commit "$MONOREPO" "$EXPECTED_SOURCE_SHA" || exit $?
CURRENT_SOURCE_SHA="$(git -C "$MONOREPO" rev-parse HEAD 2>/dev/null || true)"
if [[ "$CURRENT_SOURCE_SHA" != "$EXPECTED_SOURCE_SHA" ]]; then
  echo "ERROR: release source drift — current superproject HEAD is ${CURRENT_SOURCE_SHA:-<unreadable>}" >&2
  echo "       expected exact PAPERCUSP_EXPECTED_SOURCE_SHA=$EXPECTED_SOURCE_SHA" >&2
  echo "       Refusing before any manifest, tag, seed, or build mutation." >&2
  exit 1
fi
export PAPERCUSP_EXPECTED_SOURCE_SHA="$EXPECTED_SOURCE_SHA"

# EI-21007848170102877: the finished-byte identity audit is mandatory on every
# release cut, and it cannot certify anything without the human owner's name as
# a runtime search literal. Fail HERE — after exact-source validation but before
# the first manifest/seed/build write — instead of paying the full seed cut and
# discovering the missing env only when build-desktop-sidecar.sh starts.
# Runtime-only is load-bearing: persisting the owner's identity in the release
# tree would manufacture the very identity leak this audit exists to catch.
if [[ -z "${PAPERCUSP_RELEASE_OWNER_NAME:-}" ]]; then
  echo "ERROR: release cut requires PAPERCUSP_RELEASE_OWNER_NAME at run time before any seed/build work." >&2
  echo "       Pass the human owner name through release:cut; never write it into a tracked file." >&2
  exit 2
fi

# ── EI-17272: reap orphaned build-tool descendants on ANY exit ────────────────
# The Linux leg (below) launches `tauri build` → cargo → rustc, and
# bin/build-appimage.sh (appimagetool/linuxdeploy), as a background subshell of
# THIS script. If this script's own process dies before `supervise_legs` reaps that
# subshell (an interrupted/killed terminal or tmux pane, an OOM, a `kill -9` on
# a wedged cut) the leg is silently ORPHANED and keeps running forever, pinning
# a full CPU core — observed live: a `tauri build` ran 10h at 99% CPU after its
# cutting session died, unrelated to any later cut that happened to run on the
# same box (EI-17272). Mirrors the EI-14500 leaked-sidecar reaper in
# bin/live-federation-gate.sh (reap_gate_sidecars/gate_owns_rig_pid): an EXIT
# trap that pgrep-matches known build-tool cmdlines AND verifies ownership via
# cwd rooted under THIS script's own tree ($ROOT) before killing — so a
# concurrent PEER release cut's tauri/cargo build elsewhere on this shared dev
# box is NEVER touched. A normal, successful supervise_legs already reaps every leg
# itself, so by the time this trap fires on a clean exit, pgrep finds nothing —
# a no-op. Bash still runs the EXIT trap when the script dies from an unhandled
# signal (SIGINT/SIGTERM/etc, though not SIGKILL of THIS process), so this
# covers the interrupted-terminal / killed-pane case that produced the observed
# orphan; it deliberately does NOT ALSO trap INT/TERM directly (see
# release-local-leg-reaper.selftest.sh header for why that would misfire).
release_owns_leg_pid() { # <pid> — true iff pid's cwd is rooted under THIS cut's $ROOT
  local pid="$1" cwd
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ -n "$cwd" ]] || return 1
  [[ "$cwd" == "$ROOT" || "$cwd" == "$ROOT"/* ]]
}
reap_release_legs() { # kill this cut's own orphaned build-tool descendants, if any
  local pid pids sigged=()
  pids="$(pgrep -f 'bin/tauri build|cargo build.*papercusp|rustc.*papercusp_desktop|appimagetool|linuxdeploy' 2>/dev/null || true)"
  for pid in $pids; do
    release_owns_leg_pid "$pid" || continue
    echo "==> leg reap (EI-17272): orphaned build process pid=$pid — SIGTERM. cmd: $(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | head -c 160)" >&2
    kill "$pid" 2>/dev/null || true
    sigged+=("$pid")
  done
  [[ ${#sigged[@]} -eq 0 ]] && return 0
  sleep "${RELEASE_LEG_REAP_GRACE_S:-3}"
  for pid in "${sigged[@]}"; do
    kill -0 "$pid" 2>/dev/null && { echo "==> leg reap (EI-17272): pid=$pid survived SIGTERM — SIGKILL." >&2; kill -9 "$pid" 2>/dev/null || true; }
  done
  return 0
}
cleanup_release_local() {
  local rc=$?
  # Verification-harness contract (below): record the open phase + HARNESS_RESULT. No-op before
  # the contract starts; never changes the cut's exit code.
  if declare -F vh_exit >/dev/null 2>&1; then vh_exit "$rc"; fi
  reap_release_legs
  # The release orchestrator may reserve sidecar staging space before the long
  # migration/toolchain preflights below. Release it on every exit, including a
  # fail-fast before build-desktop-sidecar.sh gets a chance to run.
  if declare -F papercusp_release_disk_reservation >/dev/null 2>&1; then
    papercusp_release_disk_reservation
  fi
  [[ -z "${_OWN_PROVENANCE_SOURCE_DIRTY_MANIFEST:-}" ]] \
    || rm -f "$_OWN_PROVENANCE_SOURCE_DIRTY_MANIFEST"
  # The gitleaks report contains redacted matches and is kept only for the
  # duration of this cut. The directory is private (mktemp -d) and is removed
  # on every ordinary exit so a failed cut leaves no diagnostic bundle behind.
  [[ -z "${_GITLEAKS_REPORT_DIR:-}" ]] || rm -rf -- "$_GITLEAKS_REPORT_DIR"
}
# Override any inherited value before the EXIT trap can observe it. The report
# directory is assigned only by the gate below after a successful mktemp -d.
_GITLEAKS_REPORT_DIR=""
trap cleanup_release_local EXIT

# ── Release host (plan desktop-release-hosting-r2-2026-07-12) ────────────────
# Where the shipped app looks for updates, and where the artifacts get uploaded.
# Kept OUT of git and alongside the signing key, because it is a shared secret of
# the same character: the secret lives in the URL PATH (D-002 — a random
# SUBdomain would be published to Certificate Transparency the moment it got a
# cert), and it is PERMANENT (D-003 — it is baked into every shipped app, so
# rotating it silently strands every existing install on a dead URL).
#
#   PAPERCUSP_RELEASE_HOST    → baked into the app; the app polls <host>/latest.json
#   PAPERCUSP_UPDATE_BASE_URL → written into latest.json as the artifact download base
#
# Both are the same value today. They are separate knobs on purpose: only the
# MANIFEST location must be permanent — the artifact URLs live inside latest.json
# and can move per release without an app update.
#
# The loader is a SHARED LIB, not a block here, because this script is not the
# only entry point: the per-leg producers (build-linux-local.sh, build-windows-on-vm.sh)
# are run directly all the time, and when they were relying on inheriting these
# exports FROM here, a direct run baked an EMPTY host and shipped a permanently
# un-updatable app without a single red line (WI-4389). See lib/release-host.sh.
#
# This is the CUT, so it REQUIRES the host — it does not merely warn. A hostless
# dev build is fine (you just get no auto-update); a hostless RELEASE ships an app
# that can never be updated, and it fails INVISIBLY ("up to date", forever). 0.0.8
# warned, and shipped anyway. Escape hatch, if you truly want a throwaway:
# PAPERCUSP_ALLOW_HOSTLESS_RELEASE=1.
# shellcheck source=lib/release-host.sh
source "$ORCHESTRATOR_HERE/lib/release-host.sh"
# EI-12913: the ONE source of truth for this cut's artifact set — release-local.sh
# writes it (below), upload-release.sh reads it, so the two halves can never drift.
source "$ORCHESTRATOR_HERE/lib/release-artifacts.sh"
# WI-20118266632432430: shared Inno Server DiskSpan normalization used by the
# direct cross-builder and incremental publisher as well as this full cut.
# shellcheck source=lib/inno-spanned-server.sh
source "$ORCHESTRATOR_HERE/lib/inno-spanned-server.sh"
# WI-36794 / WI-7101: claim a Rust target-dir SLOT before any cargo runs. This
# script drives `tauri build` directly (npx, not the guarded `tauri` npm
# script), so it was routing around the only chokepoint that claims one — and a
# release cut is the longest cargo build on the box, i.e. the widest window in
# which to interleave writes to the shared generated app-manifest and take down
# a concurrently-running desktop (the owner's included).
#
# Sourced, not executed: it exports CARGO_TARGET_DIR and holds a lock fd this
# process must keep. Slot 0 IS the pre-existing shared dir, so a cut on an idle
# box is unchanged and keeps its warm cache; it isolates only when something
# else genuinely holds the dir. It honours a preset CARGO_TARGET_DIR and
# degrades safely where flock(1) is absent (the mac VM leg drives this script).
# CARGO_TARGET_ROOT below is derived from `cargo metadata`, so artifact
# collection follows the claimed dir automatically.
# shellcheck source=lib/claim-target-dir.sh
ensure_release_cargo_path
# WI-10003533: the slot picker exempts a retention lease held by THIS cut's own
# tag (EI-23946118243608426), and it learns that tag from PAPERCUSP_RELEASE_TAG.
# The tag used to be exported ~1700 lines below, after the slot was already
# claimed, so on every real launch the exemption saw an empty tag. A run-leg
# retry then skipped the very slot holding its earlier legs' artifacts, and
# PAPERCUSP_REUSE_* found nothing to reuse. Derive it from the same
# VERSION/CHANNEL the later export uses, before claiming a slot.
if [[ -n "${VERSION:-}" && -n "${CHANNEL:-}" ]]; then
  PAPERCUSP_RELEASE_TAG="$(desktop_release_tag "$VERSION" "$CHANNEL")"
  export PAPERCUSP_RELEASE_TAG
fi
source "$ORCHESTRATOR_HERE/lib/claim-target-dir.sh"
require_release_host

# EI-22579401012596804: reserve sidecar staging headroom BEFORE the long WSL,
# toolchain, migration-lint, and migration boot-smoke preflights. Previously the
# first disk claim lived inside build-desktop-sidecar.sh ~5 minutes later, so an
# unrelated build could reserve the remaining bytes after this cut started and
# make the cut fail rc28 only after all preflight work completed.
#
# This parent shell stays alive for the child sidecar build, so its pid-bound
# reservation protects the whole interval. The child receives a zero additional
# requirement below: it still runs the shared disk guard, but does not
# double-count the 8GB already held by this release process. The reservation is
# released immediately after the atomic sidecar publish completes; the EXIT
# cleanup above is the failure-path backstop.
# shellcheck source=lib/disk-preflight.sh
source "$ORCHESTRATOR_HERE/lib/disk-preflight.sh"
papercusp_require_free_gb \
  "$ROOT/src-tauri/sidecar" \
  "${PAPERCUSP_SIDECAR_MIN_FREE_GB:-8}" \
  "release sidecar staging" || exit $?

WITH_WINDOWS="${WITH_WINDOWS:-0}"
WITH_ARM64="${WITH_ARM64:-0}"
WITH_MAC="${WITH_MAC:-0}"
# WI-5085: the ONE source of truth for which Tauri role(s) this cut builds —
# canonicalized HERE so every leg (linux in-process, mac + windows over ssh,
# where it must be explicitly forwarded since env does not cross ssh on its
# own) sees the SAME value instead of each falling back to its own default.
# Default BOTH roles (D-004, desktop-build-speed-2026-07-16) — see the usage
# comment above for why. Pass PAPERCUSP_BUILD_ROLES=gui for the fast-iteration
# opt-in.
#
# WI-5600: the Windows leg forwards the resolved roles like mac/linux (below),
# and build-windows-on-vm.sh ALSO defaults to gui+server — so an UNSET caller
# gets a LAUNCHABLE Windows build (the GUI plus the Server it attaches to).
# WI-5559 had suppressed the Windows Server here on the false premise it was
# unpublished throwaway output; a gui-only Windows cut actually ships a dead
# build (WI-5600), so that suppression is reversed.
#
# WI-36794: remember whether the caller ASKED for these roles or merely inherited
# the default. A side-by-side channel (below) narrows the default to gui — but an
# explicit `PAPERCUSP_BUILD_ROLES="gui server"` must be REFUSED there rather than
# silently narrowed, because silently building less than the caller asked for is
# how a cut ships a missing product.
PAPERCUSP_BUILD_ROLES_EXPLICIT="${PAPERCUSP_BUILD_ROLES:+1}"
PAPERCUSP_BUILD_ROLES="${PAPERCUSP_BUILD_ROLES:-gui server}"
export PAPERCUSP_BUILD_ROLES
# Mobile (Android) leg — optional, but STRICT when enabled. An explicitly
# disabled/prerequisite-absent desktop-only cut stays legal; once enabled, a
# broken or unprovenanced APK+AAB pair fails the cut. The pair is BUILT in the sibling
# papercup-rust-mobile repo; it is RECORDED separately by record-release-cli
# (scanMobileArtifacts) and deliberately NOT swept into ARTIFACTS[], which feeds
# the DESKTOP-only auto-update latest.json (mobile must never leak into the
# desktop updater). iOS is NOT built here — it needs the Mac VM + Apple Developer
# signing, so it enters the registry from a Mac-VM leg once a signed .ipa exists;
# until enrollment it stays dormant (record-release simply finds no .ipa).
# Resolve the sibling mobile repo the same way record-release-cli's
# resolveMobileRoot does (walk up, match crates/ or Makefile).
resolve_mobile_root() {
  if [[ -n "${PAPERCUSP_MOBILE_ROOT:-}" ]]; then printf '%s\n' "$PAPERCUSP_MOBILE_ROOT"; return 0; fi
  local d="$ROOT" cand parent
  for _ in 1 2 3 4 5 6 7 8; do
    for cand in "$d/papercup-rust-mobile" "$(dirname "$d")/papercup-rust-mobile"; do
      if [[ -d "$cand/crates" || -f "$cand/Makefile" ]]; then printf '%s\n' "$cand"; return 0; fi
    done
    parent="$(dirname "$d")"; [[ "$parent" == "$d" ]] && break; d="$parent"
  done
  printf '%s\n' ""
}
MOBILE_ROOT="$(resolve_mobile_root)"
# Auto-detect: on when the sibling repo AND an Android SDK are present; an explicit
# WITH_ANDROID env (0/1) always wins; PAPERCUSP_SKIP_MOBILE=1 forces it off.
if [[ "${PAPERCUSP_SKIP_MOBILE:-0}" == "1" ]]; then
  WITH_ANDROID=0
elif [[ -n "${WITH_ANDROID:-}" ]]; then
  : # explicit override respected
elif [[ -n "$MOBILE_ROOT" && ( -n "${ANDROID_HOME:-}" || -n "${ANDROID_SDK_ROOT:-}" || -d "$HOME/Android/Sdk" ) ]]; then
  WITH_ANDROID=1
else
  WITH_ANDROID=0
fi
# P-014 (repro hygiene): PIN the Tauri CLI instead of `@latest` (which fetches
# whatever npm resolves at cut time — a silent reproducibility hole: two cuts of
# identical source could bundle with different tauri-cli versions). Keep in sync
# with package.json's @tauri-apps/cli devDependency (^2.1.0 → resolved 2.11.0).
# One-off override: PAPERCUSP_TAURI_CLI_VERSION=x.y.z.
TAURI_CLI_VERSION="${PAPERCUSP_TAURI_CLI_VERSION:-2.11.0}"
# WI-5651: the mac VM ssh/scp/rsync frames that used to live here are GONE — the
# mac leg builds natively (bin/build-mac-cross.sh), no VM. mac-vm-build.sh keeps
# its own VM connection setup for the on-device TESTING the VM is retained for.
# Build provenance: the short git sha of the tree we're packaging, made HONEST
# per EI-8914 / P-003 (desktop-build-hardening-tri-platform-2026-07-11). This is
# the SINGLE SOURCE OF TRUTH for PAPERCUSP_BUILD_SHA across all three legs — it
# flows unchanged into the linux/mac/arm64/windows build envs below AND into
# every build-provenance.json emit, so option_env!("PAPERCUSP_BUILD_SHA")
# (main.rs) / the operator's /api/health can never claim a clean commit for a
# build cut from a modified tree. The VM build trees are rsynced WITHOUT .git, so
# they can't self-derive it — it MUST be passed in from here, where .git is
# present.
#
# Why the -dirty marker (previously only the Windows leg carried it,
# build-windows-on-vm.sh): the linux leg compiles the LIVE working tree, and the
# mac/windows legs overlay THIS release's version-bump (+ freshly-cut seed) onto
# their source — so a cut is ~never a byte-clean checkout of HEAD, and on this
# shared fleet checkout the tree is almost always dirty against HEAD (git-sync
# commits on a schedule). Baking a bare commit UNDER-reports that — the exact
# LABELED!=PACKED lie P-003 kills. Mark -dirty whenever the desktop tree OR the
# monorepo superproject (the sidecar is built from apps/operator, so its
# dirtiness ships too) has uncommitted changes. Over-reporting dirty is the SAFE
# direction; the per-artifact packedSrcFingerprint (P-014) is what actually
# distinguishes two dirty cuts. On stable/beta the dirty-tree guard below aborts
# a dirty desktop tree, so a clean release keeps a bare sha; alpha surfaces it.
# (Fed this already-honest value, the Windows leg's own derivation reproduces the
# same label — no divergence.)
_short_head="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
_source_git_head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
_source_git_dirty=false
if [[ -n "$_short_head" ]] \
   && { [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]] \
        || [[ -n "$(git -C "$ROOT/.." status --porcelain 2>/dev/null)" ]]; }; then
  _source_git_dirty=true
  BUILD_SHA="${_short_head}-dirty"
else
  BUILD_SHA="$_short_head"
fi
# Capture the exact dirty source set at the SAME phase boundary as gitHead and
# gitDirty. The primary desktop repository contains the Rust shell; the workspace
# repository contains the operator source packed into the sidecar. Labels are
# stable manifest namespaces and prevent checkout paths from leaking.
_OWN_PROVENANCE_SOURCE_DIRTY_MANIFEST="$(mktemp "${TMPDIR:-/tmp}/papercusp-release-dirty-source.XXXXXX")"
bash "$ROOT/bin/emit-build-provenance.sh" --capture-dirty-source \
  "$_OWN_PROVENANCE_SOURCE_DIRTY_MANIFEST" \
  "desktop=$ROOT" "workspace=$ROOT/.." \
  || { echo "ERROR: could not capture content-addressed source provenance at cut start" >&2; exit 2; }
export PROVENANCE_SOURCE_DIRTY_MANIFEST="$_OWN_PROVENANCE_SOURCE_DIRTY_MANIFEST"
# Preserve the input state NOW, before the cutter bumps versions or regenerates
# tracked env-sidecars. Every provenance emitter inherits these values; its own
# later checkout observation rides separately as git*AtEmit. Without this phase
# boundary, the documented ship gate fails every normal cut even when this
# preflight proved the source clean (EI-20555742146560765).
export PROVENANCE_SOURCE_GIT_HEAD="$_source_git_head"
export PROVENANCE_SOURCE_GIT_DIRTY="$_source_git_dirty"
echo "==> build provenance: PAPERCUSP_BUILD_SHA=${BUILD_SHA:-<unknown>}"
# Fail-fast on a -dirty cut (0.0.8 drive, 2026-07-11): the release-verify-provenance
# ship-gate asserts gitDirty==false on EVERY channel — alpha included, since alpha
# IS the public shipping channel — so a -dirty cut can only produce unshippable
# bytes; abort at second five, not minute forty. On this shared fleet checkout the
# cure is: force git-sync, wait for `status --porcelain` to be empty in BOTH the
# desktop tree and the superproject, re-fire. PAPERCUSP_ALLOW_DIRTY=1 escapes for
# local dev iteration (the -dirty label itself stays honest, P-003).
if [[ "$BUILD_SHA" == *-dirty && "${PAPERCUSP_ALLOW_DIRTY:-0}" != "1" ]]; then
  echo "ERROR: BUILD_SHA is ${BUILD_SHA} — uncommitted changes in the desktop tree or superproject."
  echo "       A -dirty cut cannot pass the ship-gate (gitDirty must be false), so this run"
  echo "       would only produce unshippable artifacts. Force git-sync, verify"
  echo "       'git status --porcelain' is empty in $ROOT AND $ROOT/.., then re-fire."
  echo "       (PAPERCUSP_ALLOW_DIRTY=1 to build a dirty dev cut anyway.)"
  exit 1
fi
# Build provenance: the shipped app VERSION (WI-2644). Same mechanism as
# PAPERCUSP_BUILD_SHA above — the packaged sidecar has no npm_package_version
# in its env, so build-info.ts needs this baked in explicitly. Sourced from
# $VERSION (this script's own CLI arg, semver-validated below) — the exact
# value this run writes into tauri.conf.json, so they can never drift.
echo "==> build provenance: PAPERCUSP_BUILD_VERSION=${VERSION}"

# ── CHANNEL IDENTITY (WI-36794) ───────────────────────────────────────────────
# THE ONE derivation for this cut, from the shared chokepoint. It sets
# DESKTOP_CHANNEL_BUILD_CFG (the tauri `--config` identity overlay) and
# DESKTOP_CHANNEL_BUILD_ENV (the baked PAPERCUSP_CHANNEL +
# PAPERCUSP_CHANNEL_DATA_HOME stamps). Both are EMPTY for an update lane, so
# every build site below expands them unconditionally and an alpha/beta/stable
# cut is byte-for-byte the command it ran before this existed.
#
# Expand the two arrays TOGETHER, always. Splitting them is the one mistake that
# matters here: the overlay alone is a separate installed application pointed at
# ~/.papercusp — the operator state of the desktop in daily use.
desktop_channel_identity "$CHANNEL" || exit 1

if desktop_channel_is_side_by_side "$CHANNEL"; then
  echo "==> channel '$CHANNEL' is SIDE-BY-SIDE: ${DESKTOP_CHANNEL_BUILD_CFG[*]} + ${DESKTOP_CHANNEL_BUILD_ENV[*]}"

  # A side-by-side cut has exactly ONE identity overlay, and it is the GUI's.
  # There is no tauri.<channel>-server.conf.json: a Server-role build would take
  # tauri.server.conf.json AND the channel overlay, and the later `--config`
  # wins the identifier — producing a Server-role bundle wearing the GUI's
  # nightly identity. On Linux that role is not needed at all (main.rs's
  # #[cfg(target_os = "linux")] arm self-hosts the operator sidecar inside the
  # GUI process, WI-2902), which is why the overlay was only ever built for GUI.
  # Refuse rather than emit an incoherent bundle.
  if [[ " $PAPERCUSP_BUILD_ROLES " == *" server "* ]]; then
    if [[ -n "${PAPERCUSP_BUILD_ROLES_EXPLICIT:-}" ]]; then
      echo "ERROR: channel '$CHANNEL' is side-by-side and has no Server identity overlay" >&2
      echo "       (src-tauri/tauri.${CHANNEL}-server.conf.json does not exist), so a Server-role" >&2
      echo "       build would wear the GUI's '$CHANNEL' bundle identity. Linux does not need it:" >&2
      echo "       the GUI self-hosts the sidecar (WI-2902). Re-run with PAPERCUSP_BUILD_ROLES=gui." >&2
      exit 1
    fi
    echo "==> [$CHANNEL] narrowing PAPERCUSP_BUILD_ROLES to 'gui' (no Server identity overlay for a side-by-side channel; the Linux GUI self-hosts the sidecar — WI-2902)"
    PAPERCUSP_BUILD_ROLES="gui"
    export PAPERCUSP_BUILD_ROLES
  fi

  # Cross-platform legs do NOT carry the overlay: the mac/windows producers run
  # over ssh with their own build commands, and the two-bundle split there still
  # needs a channel-aware SERVER_BUNDLE_ID (main.rs:4350) that has not been
  # built. Shipping them under a nightly TAG with stable IDENTITY is the
  # LABELED != PACKED class this script guards against everywhere else, so
  # refuse instead of publishing it.
  for leg in WITH_WINDOWS WITH_MAC; do
    if [[ "${!leg}" == "1" ]]; then
      echo "ERROR: $leg=1 with side-by-side channel '$CHANNEL' — that leg has no channel identity" >&2
      echo "       overlay yet (the mac/windows two-bundle split needs a channel-aware" >&2
      echo "       SERVER_BUNDLE_ID, WI-36794 item 5 defers it), so it would build STABLE-identity" >&2
      echo "       artifacts and publish them under the '$CHANNEL' tag. Cut $CHANNEL on Linux only." >&2
      exit 1
    fi
  done
fi

# Tag convention matches the operator's manifest classifier
# (apps/operator/app/api/updates/manifest/route.ts):
#   alpha  → desktop-vX.Y.Z-alpha
#   beta   → desktop-vX.Y.Z-beta
#   stable → desktop-vX.Y.Z
# (EI-18101626616739029: computed by the shared lib/gen-latest-manifest.sh
# helper so bin/gen-latest-manifest.sh's standalone CLI derives the identical
# tag from the same version+channel — one implementation, no drift.)
TAG="$(desktop_release_tag "$VERSION" "$CHANNEL")"

# ── P-005: restart-safe release stages in the existing managed-task journal ──
# The nightly routine already creates one task_ledger.detail.release journal and
# passes its task/operation IDs through this process.  Keep the shell cutter a
# thin consumer of that journal: it asks the shared TypeScript adapter for the
# stage decision, then proves the local bytes through the release script's
# existing provenance/artifact surfaces before it accepts a receipt.
#
# An unmanaged/manual cut remains byte-for-byte on the historical path.  A
# half-configured managed cut fails closed; silently dropping one ID would turn
# a restartable operation back into an unjournaled mutation.
RELEASE_TASK_JOURNAL_ENABLED=0
RELEASE_TASK_BUILD_ACTION=""
RELEASE_TASK_BUILD_REQUEST_ID=""
RELEASE_TASK_BUILD_IDENTITY=""
RELEASE_TASK_WIN_ACTION=""
RELEASE_TASK_WIN_REQUEST_ID=""
RELEASE_TASK_WIN_IDENTITY=""
RELEASE_TASK_MAC_ACTION=""
RELEASE_TASK_MAC_REQUEST_ID=""
RELEASE_TASK_MAC_IDENTITY=""
RELEASE_TASK_MANIFEST_ACTION=""
RELEASE_TASK_MANIFEST_REQUEST_ID=""
RELEASE_TASK_MANIFEST_IDENTITY=""
RELEASE_TASK_MANIFEST_SKIP=0
RELEASE_TASK_LAST_LOOKUP_MS=0
# P-003 clause 1 (D-008): the PRIOR committed receipt's artifact-set digest, read
# back at begin. Empty when the stage has no prior receipt (a fresh `run`).
RELEASE_TASK_LAST_ARTIFACT_SET=""
RELEASE_TASK_BUILD_ARTIFACT_SET=""
RELEASE_TASK_WIN_ARTIFACT_SET=""
RELEASE_TASK_MAC_ARTIFACT_SET=""
# P-004 / R-4 demand 4: the manifest stage's equivalent, read back at begin so a
# reused manifest receipt can be checked against the bytes it actually committed.
RELEASE_TASK_LAST_MANIFEST_RECEIPT=""
RELEASE_TASK_MANIFEST_OUTPUT_DIGEST=""
RELEASE_TASK_BUILD_PREPARATION_START_MS=""
RELEASE_TASK_WIN_PREPARATION_START_MS=""
RELEASE_TASK_MAC_PREPARATION_START_MS=""
RELEASE_TASK_MANIFEST_PREPARATION_START_MS=""
RELEASE_TASK_PREPARATION_MS=""
RELEASE_TASK_REUSE_EXPIRES_AT=""

release_task_journal_configure() {
  local task_id="${PAPERCUSP_RELEASE_TASK_ID:-}"
  local operation_id="${PAPERCUSP_RELEASE_OPERATION_ID:-}"
  if [[ -z "$task_id" && -z "$operation_id" ]]; then return 0; fi
  if [[ -z "$task_id" || -z "$operation_id" ]]; then
    echo "ERROR: managed release resume requires BOTH PAPERCUSP_RELEASE_TASK_ID and PAPERCUSP_RELEASE_OPERATION_ID." >&2
    return 2
  fi

  RELEASE_TASK_JOURNAL_CLI="${PAPERCUSP_RELEASE_TASK_JOURNAL_CLI:-$ORCHESTRATOR_HERE/../../scripts/lib/release-task-journal.mts}"
  RELEASE_TASK_JOURNAL_ROOT="$(cd "$ORCHESTRATOR_HERE/../.." && pwd)"
  if [[ -z "${PAPERCUSP_RELEASE_TASK_JOURNAL_RUNNER:-}" && ! -f "$RELEASE_TASK_JOURNAL_CLI" ]]; then
    echo "ERROR: managed release journal adapter is missing at $RELEASE_TASK_JOURNAL_CLI." >&2
    return 2
  fi
  RELEASE_TASK_JOURNAL_ENABLED=1
}

release_task_assert_credential_fresh() {
  [[ "$RELEASE_TASK_JOURNAL_ENABLED" == "1" ]] || return 0
  local expires_at="${PAPERCUSP_RELEASE_CREDENTIAL_EXPIRES_AT:-}"
  [[ -n "$expires_at" ]] || return 0
  node - "$expires_at" <<'NODE'
const expiresAt = process.argv[2];
const epoch = Date.parse(expiresAt);
if (!Number.isFinite(epoch)) {
  console.error('ERROR: PAPERCUSP_RELEASE_CREDENTIAL_EXPIRES_AT must be an ISO timestamp.');
  process.exit(2);
}
if (epoch <= Date.now()) {
  console.error(`ERROR: release credential expired at ${expiresAt}; refusing the next release stage.`);
  process.exit(1);
}
NODE
}

# release_task_journal_call <command> <stage> <identity> <request-id-or-empty> [evidence...]
release_task_journal_call() {
  local command="$1" stage="$2" identity="$3" request_id="${4:-}"
  shift 4
  local -a argv=(
    "$command"
    --task-id "$PAPERCUSP_RELEASE_TASK_ID"
    --operation-id "$PAPERCUSP_RELEASE_OPERATION_ID"
    --source-root "$MONOREPO"
    --source-sha "$EXPECTED_SOURCE_SHA"
    --version "$VERSION"
    --channel "$CHANNEL"
    --stage "$stage"
    --identity "$identity"
  )
  [[ "$stage" != "release.manifest" ]] || argv+=(--source-scope stage)
  [[ -z "$request_id" ]] || argv+=(--request-id "$request_id")
  if [[ "$command" == "commit" && -n "${RELEASE_TASK_PREPARATION_MS:-}" ]]; then
    argv+=(--preparation-ms "$RELEASE_TASK_PREPARATION_MS")
  fi
  if [[ "$command" == "commit" && -n "${RELEASE_TASK_REUSE_EXPIRES_AT:-}" ]]; then
    argv+=(--reuse-expires-at "$RELEASE_TASK_REUSE_EXPIRES_AT")
  fi
  local evidence
  for evidence in "$@"; do argv+=(--evidence "$evidence"); done

  if [[ -n "${PAPERCUSP_RELEASE_TASK_JOURNAL_RUNNER:-}" ]]; then
    "$PAPERCUSP_RELEASE_TASK_JOURNAL_RUNNER" "${argv[@]}"
  else
    (cd "$RELEASE_TASK_JOURNAL_ROOT" && npx tsx "$RELEASE_TASK_JOURNAL_CLI" "${argv[@]}")
  fi
}

release_task_now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

release_task_elapsed_ms() { # <start-ms>
  local start="$1" now
  now="$(release_task_now_ms)" || return $?
  # Older/manual harnesses may not carry the managed-task start stamp. Keep the
  # timing explicitly unavailable rather than manufacturing zero or blocking
  # the release; the nightly managed path always supplies a valid boundary.
  [[ "$start" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ && "$now" -ge "$start" ]] || return 0
  printf '%s\n' "$((now - start))"
}

release_task_emit_timing() { # <stage> <decision> <verification-ms>
  local stage="$1" decision="$2" verification_ms="$3"
  local queue_wait_ms=unavailable
  if [[ "${PAPERCUSP_RELEASE_ENQUEUED_AT_MS:-}" =~ ^[0-9]+$ \
     && "${PAPERCUSP_RELEASE_CHILD_STARTED_AT_MS:-}" =~ ^[0-9]+$ \
     && "$PAPERCUSP_RELEASE_CHILD_STARTED_AT_MS" -ge "$PAPERCUSP_RELEASE_ENQUEUED_AT_MS" ]]; then
    queue_wait_ms="$((PAPERCUSP_RELEASE_CHILD_STARTED_AT_MS - PAPERCUSP_RELEASE_ENQUEUED_AT_MS))"
  fi
  printf 'RELEASE_STAGE_TIMING schema=1 stage=%s decision=%s queue_wait_ms=%s lookup_ms=%s verification_ms=%s preparation_ms=%s\n' \
    "$stage" "$decision" "$queue_wait_ms" "${RELEASE_TASK_LAST_LOOKUP_MS:-0}" \
    "$verification_ms" "${RELEASE_TASK_PREPARATION_MS:-unavailable}"
}

release_task_audit_reuse_expiry() {
  local stamp="$ROOT/src-tauri/sidecar/.sidecar-build-stamp"
  node - "$stamp" "${PAPERCUSP_RELEASE_REUSE_MAX_AGE_SEC:-0}" <<'NODE'
const fs = require('node:fs');
const [stampPath, rawMaxAge] = process.argv.slice(2);
const maxAgeSec = Number(rawMaxAge);
if (!Number.isSafeInteger(maxAgeSec) || maxAgeSec <= 0 || maxAgeSec > 7 * 24 * 60 * 60) {
  throw new Error('release reuse max age must be an integer in 1..604800 seconds');
}
const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
const audit = stamp?.releaseIdentityAudit;
if (audit?.schemaVersion !== 1 || audit.passed !== true
    || audit.scanner !== 'audit-release-bundle.py --scan-dir') {
  throw new Error('release reuse requires the canonical successful identity-scan attestation');
}
const passedAt = Date.parse(audit.passedAtUtc);
if (!Number.isFinite(passedAt) || passedAt > Date.now()) {
  throw new Error('release reuse identity-scan timestamp is invalid or future-dated');
}
const expiresAt = passedAt + maxAgeSec * 1000;
if (expiresAt <= Date.now()) throw new Error(`release reuse identity scan expired at ${new Date(expiresAt).toISOString()}`);
process.stdout.write(new Date(expiresAt).toISOString());
NODE
}

release_task_json_field() { # <json> <field> [optional=0]
  local json="$1" field="$2" optional="${3:-0}"
  RELEASE_TASK_RESULT_JSON="$json" node - "$field" "$optional" <<'NODE'
const field = process.argv[2];
const optional = process.argv[3] === '1';
let value;
try {
  value = JSON.parse(process.env.RELEASE_TASK_RESULT_JSON || '')[field];
} catch (error) {
  console.error(`ERROR: release journal returned invalid JSON: ${error.message}`);
  process.exit(2);
}
if (value == null && optional) process.exit(0);
if (typeof value !== 'string' || value.length === 0) {
  console.error(`ERROR: release journal response has no string field '${field}'.`);
  process.exit(2);
}
process.stdout.write(value);
NODE
}

release_task_json_number_field() { # <json> <field> [fallback=0]
  local json="$1" field="$2" fallback="${3:-0}"
  RELEASE_TASK_RESULT_JSON="$json" node - "$field" "$fallback" <<'NODE'
const field = process.argv[2];
const fallback = Number(process.argv[3]);
const value = JSON.parse(process.env.RELEASE_TASK_RESULT_JSON || '')[field];
if (value == null && Number.isFinite(fallback)) process.stdout.write(String(fallback));
else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) process.stdout.write(String(value));
else {
  console.error(`ERROR: release journal response field '${field}' is not a finite non-negative number.`);
  process.exit(2);
}
NODE
}

# P-003 clause 1 (D-008). Pull ONE committed evidence ref back out of a journal
# reply by prefix. A malformed payload RAISES rather than printing nothing: an
# empty result legitimately means "this stage has no such ref yet" (a first run),
# so letting a parse failure share that spelling would turn a broken reader into
# a clean "nothing to verify against" — the exact false-negative this whole
# clause exists to remove.
release_task_json_evidence_ref() { # <json> <prefix> — prints the ref's value, or nothing
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    payload = json.loads(sys.argv[1])
except Exception as err:
    raise SystemExit(f"release journal reply is not JSON: {err}")
refs = payload.get("evidenceRefs")
if refs is None:
    raise SystemExit("release journal reply carries no evidenceRefs key")
prefix = sys.argv[2]
for ref in refs:
    if isinstance(ref, str) and ref.startswith(prefix):
        print(ref[len(prefix):])
        break
PY
}

# P-003 clause 1 (D-008) / R-2 "output paths and hashes". A digest over the
# ARTIFACT SET this leg produced, taken from build-provenance.json — which
# already records every artifact's name, size and sha256 and is written
# atomically (emit-build-provenance.sh:646,652).
#
# It digests ONLY (name, bytes, sha256) and deliberately excludes builtAtUtc,
# mtime and sig presence. That exclusion is what makes the digest comparable at
# all: a reuse RE-EMITS provenance (release_task_leg_commit's own note), so a
# digest of the whole file would differ on every resume and could never be used
# to verify anything. Identical artifact bytes therefore yield an identical
# digest across cuts, which is precisely the property a reuse check needs.
release_task_leg_output_digest() { # <bundle-dir>
  python3 - "$1/build-provenance.json" <<'PY'
import hashlib, json, pathlib, sys
path = pathlib.Path(sys.argv[1])
try:
    manifest = json.loads(path.read_text())
except FileNotFoundError:
    raise SystemExit(f"no build provenance to digest: {path}")
except Exception as err:
    raise SystemExit(f"build provenance is unreadable: {err}")
artifacts = manifest.get("artifacts")
if not isinstance(artifacts, list) or not artifacts:
    raise SystemExit(f"build provenance names no artifacts: {path}")
rows = []
for entry in artifacts:
    name, digest, size = entry.get("name"), entry.get("sha256"), entry.get("bytes")
    if not name or not digest:
        raise SystemExit(f"artifact entry lacks name/sha256: {entry!r}")
    rows.append((str(name), str(digest), str(size)))
outer = hashlib.sha256()
for name, digest, size in sorted(rows):
    outer.update(name.encode() + b"\0" + digest.encode() + b"\0" + size.encode() + b"\0")
print(outer.hexdigest())
PY
}

release_task_begin_stage() { # <stage> <identity>; writes RELEASE_TASK_LAST_*
  local stage="$1" identity="$2" result
  release_task_assert_credential_fresh || return $?
  if ! result="$(release_task_journal_call begin "$stage" "$identity" "")"; then
    echo "ERROR: could not begin managed release stage $stage." >&2
    return 1
  fi
  RELEASE_TASK_LAST_ACTION="$(release_task_json_field "$result" action)" || return $?
  RELEASE_TASK_LAST_REQUEST_ID="$(release_task_json_field "$result" requestIdentity 1)" || return $?
  RELEASE_TASK_LAST_LOOKUP_MS="$(release_task_json_number_field "$result" lookupElapsedMs 0)" || return $?
  RELEASE_TASK_LAST_ARTIFACT_SET="$(release_task_json_evidence_ref "$result" 'artifact-set:sha256:')" || {
    echo "ERROR: could not read the prior artifact-set digest for $stage." >&2
    return 1
  }
  RELEASE_TASK_LAST_MANIFEST_RECEIPT="$(release_task_json_evidence_ref "$result" 'manifest-receipt:sha256:')" || {
    echo "ERROR: could not read the prior manifest-receipt digest for $stage." >&2
    return 1
  }
  case "$RELEASE_TASK_LAST_ACTION" in
    run|reuse|reconcile|refused) ;;
    *) echo "ERROR: release journal returned unknown action '$RELEASE_TASK_LAST_ACTION' for $stage." >&2; return 2 ;;
  esac
  if [[ -z "$RELEASE_TASK_LAST_REQUEST_ID" ]]; then
    echo "ERROR: release journal returned no request identity for $stage/$RELEASE_TASK_LAST_ACTION." >&2
    return 2
  fi
}

# Canonical, reviewable PER-PLATFORM stage identity. Source SHA + the complete
# gitlink tuple are added by release-task-journal.mts; bin/lib/release-content-identity.js
# binds every remaining input that can change produced/trusted bytes. No secret
# material enters it: signing is represented only by the public updater-key digest.
#
# The builder used to be a heredoc right here with `platform` written as the
# literal 'linux-x86_64', which is precisely why only the Linux leg could be
# journalled — there was no way to ask for another platform's identity, and no
# way to test the builder at all. It now lives in bin/lib/release-content-identity.js
# (covered by release-content-identity.selftest.sh).
release_task_content_identity() { # <platform>
  local platform="${1:-}" signer_pubkey
  [[ -n "$platform" ]] || {
    echo "ERROR: release_task_content_identity requires a platform (e.g. linux-x86_64)." >&2
    return 2
  }
  signer_pubkey="$(release_task_target_pubkey)" || return $?
  PAPERCUSP_REUSE_SIGNER_PUBKEY="$signer_pubkey" \
  PAPERCUSP_REUSE_BUILD_ROLES="$PAPERCUSP_BUILD_ROLES" \
  PAPERCUSP_REUSE_TAURI_CLI="$TAURI_CLI_VERSION" \
  PAPERCUSP_REUSE_RELEASE_HOST="${PAPERCUSP_RELEASE_HOST%/}" \
  PAPERCUSP_REUSE_CHANNEL="$CHANNEL" \
  PAPERCUSP_REUSE_RUSTFLAGS="${RUSTFLAGS:-}" \
  PAPERCUSP_REUSE_CHANNEL_CONFIG="${DESKTOP_CHANNEL_BUILD_CFG[*]:-}" \
  PAPERCUSP_REUSE_ALLOW_INCOMPLETE="${PAPERCUSP_ALLOW_INCOMPLETE_ROLES:-0}" \
  PAPERCUSP_REUSE_SKIP_PROVENANCE="${PAPERCUSP_SKIP_PROVENANCE_PARITY_CHECK:-0}" \
  PAPERCUSP_REUSE_SKIP_MIGRATION_LINT="${PAPERCUSP_SKIP_MIGRATION_LINT:-0}" \
  PAPERCUSP_REUSE_SKIP_MIGRATION_BOOTSMOKE="${PAPERCUSP_SKIP_MIGRATION_BOOTSMOKE:-0}" \
  PAPERCUSP_REUSE_SKIP_BUILDSET="${PAPERCUSP_SKIP_BUILDSET_CHECK:-0}" \
  PAPERCUSP_REUSE_ALLOW_UNVERIFIED_SUBMODULE="${PAPERCUSP_ALLOW_UNVERIFIED_SUBMODULE:-0}" \
  PAPERCUSP_RELEASE_REUSE_MAX_AGE_SEC="${PAPERCUSP_RELEASE_REUSE_MAX_AGE_SEC:-0}" \
  PAPERCUSP_REUSE_SOURCE_ZSTD_LEVEL="${PAPERCUSP_SOURCE_ZSTD_LEVEL:-6}" \
  PAPERCUSP_REUSE_DEB_XZ_THREADS="${PAPERCUSP_XZ_THREADS:-4}" \
  PAPERCUSP_REUSE_DEB_XZ_MEMLIMIT="${PAPERCUSP_XZ_MEMORY_LIMIT:-4GiB}" \
    node "$ORCHESTRATOR_HERE/lib/release-content-identity.js" "$MONOREPO" "$ROOT" "$platform"
}

# ── Leg registry ────────────────────────────────────────────────────────────
# One row per JOURNALLED build leg. The fail-closed state machine below is
# written ONCE and dispatches through this registry, so adding a leg is a row
# plus its two predicates (`release_task_<leg>_outputs_absent` and
# `release_task_verify_<leg>_artifacts`) — never another copy of the state
# machine. Each leg keeps its own state-variable PREFIX, so the names the rest
# of the script already reads (RELEASE_TASK_BUILD_ACTION, …) are unchanged.
#
# A leg is journallable only once it HAS the prerequisites the receipt contract
# depends on (plan decision D-004) — adding a row without them mints receipts
# nothing can verify, which is WORSE than no receipt: a receipt that passes on
# incomplete bytes is a false guarantee:
#   1. a build-provenance emission (the committed output hash),
#   2. a reuse variable for a `reuse`/`reconcile` action to land in,
#   3. an assert_reused_provenance label, and
#   4. a way to know its EXPECTED artifact set, so `outputs_absent` can tell
#      "incomplete" from "complete" instead of guessing.
#
# arm64 and android have none of 1-3, so they are not listed (WI-10002472).
#
# WINDOWS has all four (WI-10002471). Its expected set derives from
# PAPERCUSP_BUILD_ROLES exactly as the linux counts do: bin/build-windows-cross.sh
# takes ROLES="${PAPERCUSP_BUILD_ROLES:-gui server}" and hard-fails a role that
# yields no "<AppName>_<version>_x64-setup.exe", and again if the tauri signer
# yields no .sig, so the contract is one SIGNED setup.exe per role. Count those;
# do NOT count the "*-setup-N.bin" DiskSpan slices (variable per role) nor the
# "-setup.zip" papercusp_normalize_spanned_server adds at collection time — that
# helper only writes the zip and swaps the ARTIFACTS list, leaving the stub and
# slices on disk, so a normalized cut still presents exactly one setup.exe per
# role to a later resume.
#
# MAC has all four as of P-002 — but only three of them were FOUND true; #1 had
# to be MADE true (plan D-006). Its build-provenance emission was BEST-EFFORT in
# both producers (`|| echo "WARN: … (non-fatal)"`), so the one prerequisite a mac
# receipt depends on most was the one its producers treated as optional. That is
# now fatal in build-mac-cross.sh and in the collection block below; without it a
# COMPLETE mac build whose emit merely warned would read as retryable-absent, and
# a committed receipt would hard-fail the cut rather than name the real fault.
#
# The mac leg's expected set is modelled DIFFERENTLY from these two, and
# deliberately so (plan D-006). Windows and mac look alike — "one installer plus
# one updater bundle per role" — but only Windows names EVERY artifact with the
# version, which is what makes counting version-scoped files a real completeness
# test there. Tauri leaves the mac "<Product>.app.tar.gz" UNVERSIONED, so no
# count can separate this cut's updater bundle from a prior cut's; see
# release_task_mac_outputs_absent for the cross-count rule that covers it.
declare -A RELEASE_TASK_LEG_PLATFORM=(
  [linux]=linux-x86_64
  [windows]=windows-x86_64
  [mac]=darwin-universal
)
declare -A RELEASE_TASK_LEG_PREFIX=(
  [linux]=RELEASE_TASK_BUILD
  [windows]=RELEASE_TASK_WIN
  [mac]=RELEASE_TASK_MAC
)
declare -A RELEASE_TASK_LEG_REUSE_VAR=(
  [linux]=PAPERCUSP_REUSE_LINUX
  [windows]=PAPERCUSP_REUSE_WIN
  [mac]=PAPERCUSP_REUSE_MAC
)

release_task_leg_assert_known() { # <leg>
  [[ -n "${RELEASE_TASK_LEG_PREFIX[${1:-}]:-}" ]] && return 0
  echo "ERROR: unknown release leg '${1:-<empty>}'; add it to the leg registry before journalling it." >&2
  return 2
}

# Read/write a leg's state slot by name. Indirect expansion rather than a
# nameref on purpose: a `local -n` whose target collides with a local in an
# enclosing frame is a circular-reference error, and these functions call each
# other (prepare -> commit) over the SAME slots.
release_task_leg_get() { # <leg> <slot>
  local var="${RELEASE_TASK_LEG_PREFIX[$1]}_$2"
  printf '%s' "${!var-}"
}
release_task_leg_set() { # <leg> <slot> <value>
  printf -v "${RELEASE_TASK_LEG_PREFIX[$1]}_$2" '%s' "$3"
}

# The source identity EVERY journalled leg shares: this cut's desktop checkout
# must be the exact clean gitlink the source sha names. Re-checked per leg
# (cheap, idempotent) so no leg can begin against a source its receipt would
# not match.
release_task_assert_source_exact() {
  local expected_desktop_sha
  expected_desktop_sha="$(git -C "$MONOREPO" ls-tree "$EXPECTED_SOURCE_SHA" -- papercusp-desktop \
    | awk '$1 == "160000" && $2 == "commit" && $4 == "papercusp-desktop" { print $3 }')"
  if [[ -z "$expected_desktop_sha" || "$PROVENANCE_SOURCE_GIT_HEAD" != "$expected_desktop_sha" ]]; then
    echo "ERROR: managed release desktop checkout $PROVENANCE_SOURCE_GIT_HEAD does not match source gitlink ${expected_desktop_sha:-<absent>}." >&2
    return 1
  fi
  if [[ "$PROVENANCE_SOURCE_GIT_DIRTY" != "false" ]]; then
    echo "ERROR: managed release source is dirty; task-journal reuse requires the exact clean source/gitlink tuple." >&2
    return 1
  fi
}

release_task_leg_start() { # <leg>
  [[ "$RELEASE_TASK_JOURNAL_ENABLED" == "1" ]] || return 0
  local leg="${1:-}" identity stage prep_start
  release_task_leg_assert_known "$leg" || return $?
  stage="release.build.$leg"
  # Captured into a local first: `set "$(...)"` would report the SETTER's
  # status, silently swallowing a failed clock read.
  prep_start="$(release_task_now_ms)" || return $?
  release_task_leg_set "$leg" PREPARATION_START_MS "$prep_start"
  release_task_assert_source_exact || return $?
  identity="$(release_task_content_identity "${RELEASE_TASK_LEG_PLATFORM[$leg]}")" || {
    echo "ERROR: could not construct the complete $leg release reuse identity." >&2
    return 1
  }
  release_task_leg_set "$leg" IDENTITY "$identity"
  release_task_begin_stage "$stage" "$identity" || return $?
  release_task_leg_set "$leg" ACTION "$RELEASE_TASK_LAST_ACTION"
  release_task_leg_set "$leg" REQUEST_ID "$RELEASE_TASK_LAST_REQUEST_ID"
  release_task_leg_set "$leg" ARTIFACT_SET "$RELEASE_TASK_LAST_ARTIFACT_SET"
  case "$RELEASE_TASK_LAST_ACTION" in
    run) ;;
    reuse|reconcile)
      # This happens before the cut-start stamp is selected: a valid resumed
      # artifact must preserve the original boundary, not be made stale by a
      # newly-written timestamp and then rejected for the wrong reason.
      printf -v "${RELEASE_TASK_LEG_REUSE_VAR[$leg]}" '%s' 1
      echo "==> [journal] $stage is $RELEASE_TASK_LAST_ACTION; existing bytes require reconciliation before reuse"
      ;;
    refused)
      echo "ERROR: $stage has an unresolved refused receipt; start a new release operation after resolving it." >&2
      return 1
      ;;
  esac
}

release_task_linux_outputs_absent() { # <bundle-dir>
  local bundle="$1" expected_appimages=0 expected_debs=0 appimages appimage_sigs debs deb_sigs role
  [[ " $PAPERCUSP_BUILD_ROLES " == *" gui "* ]] && expected_appimages=1
  for role in $PAPERCUSP_BUILD_ROLES; do
    case "$role" in gui|server) expected_debs=$((expected_debs + 1)) ;; esac
  done
  appimages="$(find "$bundle/appimage" -maxdepth 1 -type f -name "*_${VERSION}_*.AppImage" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  appimage_sigs="$(find "$bundle/appimage" -maxdepth 1 -type f -name "*_${VERSION}_*.AppImage.sig" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  debs="$(find "$bundle/deb" -maxdepth 1 -type f -name "*_${VERSION}_*.deb" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  deb_sigs="$(find "$bundle/deb" -maxdepth 1 -type f -name "*_${VERSION}_*.deb.sig" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  # Surplus candidates are contamination, never "no completed result".  Send
  # them to the strict verifier so they fail closed even when provenance itself
  # is missing.  Missing provenance with no surplus proves only an incomplete
  # local stage, which is retryable under a fresh one-use journal request.
  (( appimages <= expected_appimages && appimage_sigs <= expected_appimages \
     && debs <= expected_debs && deb_sigs <= expected_debs )) || return 1
  [[ -f "$bundle/build-provenance.json" ]] || return 0
  (( appimages < expected_appimages || appimage_sigs < expected_appimages \
     || debs < expected_debs || deb_sigs < expected_debs ))
}

release_task_windows_outputs_absent() { # <inno-dir>
  local inno="$1" expected=0 setups setup_sigs role
  for role in $PAPERCUSP_BUILD_ROLES; do
    case "$role" in gui|server) expected=$((expected + 1)) ;; esac
  done
  # One SIGNED "<AppName>_<version>_x64-setup.exe" per role; see the leg-registry
  # note above for why the DiskSpan ".bin" slices and the normalized "-setup.zip"
  # are deliberately outside both globs.
  setups="$(find "$inno" -maxdepth 1 -type f -name "*_${VERSION}_x64-setup.exe" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  setup_sigs="$(find "$inno" -maxdepth 1 -type f -name "*_${VERSION}_x64-setup.exe.sig" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  # Same three-way split as the Linux predicate: surplus is contamination rather
  # than "no completed result", so it goes to the strict verifier and fails closed
  # even when provenance is missing; missing provenance with no surplus proves
  # only an incomplete local stage, which is retryable under a fresh request.
  (( setups <= expected && setup_sigs <= expected )) || return 1
  [[ -f "$inno/build-provenance.json" ]] || return 0
  (( setups < expected || setup_sigs < expected ))
}

# The mac predicate is NOT the Windows one with different globs, though the two
# legs emit the same SHAPE (one installer + one updater bundle per role).
# Windows names every artifact with the version, so counting version-scoped files
# IS a completeness test there. Tauri names the mac updater bundle
# "<Product>.app.tar.gz" — UNVERSIONED — so a count of them cannot tell this cut's
# bundle from one a prior cut left behind, and the version-scoped glob that makes
# the Windows count sound is simply unavailable. Two consequences:
#   * build-provenance.json is this leg's completeness ORACLE (its per-artifact
#     sha256 is the only thing that can attribute an unversioned bundle), which is
#     why its emission is now fatal in both producers rather than best-effort;
#   * the unversioned half needs the cross-count rule the collection block already uses
#     (P-009): more .app.tar.gz than THIS-version .dmg proves contamination.
# Per role build-mac-cross.sh hard-fails without all four files — make_dmg gates
# "$dmg.sig" and make_updater gates "$tgz.sig" — so a complete leg leaves exactly
# one of each per role, and anything less is a genuinely incomplete local stage.
release_task_mac_outputs_absent() { # <mac-bundle-dir>
  local bundle="$1" expected=0 dmgs dmg_sigs tgzs tgz_sigs role
  for role in $PAPERCUSP_BUILD_ROLES; do
    case "$role" in gui|server) expected=$((expected + 1)) ;; esac
  done
  dmgs="$(find "$bundle/dmg" -maxdepth 1 -type f -name "*_${VERSION}_*.dmg" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  dmg_sigs="$(find "$bundle/dmg" -maxdepth 1 -type f -name "*_${VERSION}_*.dmg.sig" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  tgzs="$(find "$bundle/macos" -maxdepth 1 -type f -name "*.app.tar.gz" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  tgz_sigs="$(find "$bundle/macos" -maxdepth 1 -type f -name "*.app.tar.gz.sig" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  # Same three-way split as the other legs: surplus is contamination rather than
  # "no completed result", so it goes to the strict verifier and fails closed even
  # when provenance is missing.
  (( dmgs <= expected && dmg_sigs <= expected && tgzs <= expected && tgz_sigs <= expected )) || return 1
  # The unversioned-bundle rule, and the one case no count against `expected`
  # can reach: a cut that is SHORT a role's dmg while carrying that role's stale
  # .app.tar.gz sits at or under every expected count, so it would otherwise read
  # as a clean incomplete stage and be retried — silently keeping a prior cut's
  # updater bytes in the expected set. More bundles than this-version dmgs can
  # only mean contamination, so fail closed exactly as collection does.
  if (( tgzs > dmgs || tgz_sigs > dmgs )); then return 1; fi
  [[ -f "$bundle/build-provenance.json" ]] || return 0
  (( dmgs < expected || dmg_sigs < expected || tgzs < expected || tgz_sigs < expected ))
}

release_task_target_pubkey() {
  python3 - "$ROOT/src-tauri/tauri.conf.json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))["plugins"]["updater"]["pubkey"]
if not isinstance(value, str) or not value.strip():
    raise SystemExit("target tauri.conf.json has no updater public key")
print(value)
PY
}

release_task_verify_linux_artifacts() { # <bundle-dir> <reused:0|1>
  local bundle="$1" reused="$2" pubkey
  assert_linux_artifact_cardinality "$bundle" || return $?
  if [[ "$reused" == "1" ]]; then
    # A journal-controlled resume never inherits the two manual salvage
    # bypasses.  Its source/gitlink identity is exact, so mismatched or missing
    # provenance is a hard contradiction, not permission to relabel bytes.
    PAPERCUSP_ALLOW_REUSE_UNVERIFIED=0 \
    PAPERCUSP_ALLOW_REUSE_VERSION_MISMATCH=0 \
      assert_reused_provenance "$bundle" linux || return $?
    if [[ "$LINUX_REUSE_GIT_HEAD" != "$PROVENANCE_SOURCE_GIT_HEAD" || "$LINUX_REUSE_GIT_DIRTY" != "false" ]]; then
      echo "ERROR: reused Linux provenance does not match the managed release's exact clean desktop gitlink." >&2
      return 1
    fi
  fi
  pubkey="$(release_task_target_pubkey)" || return $?
  bash "$ORCHESTRATOR_HERE/verify-provenance.sh" "$bundle" \
    --health-sha "$BUILD_SHA" --pubkey "$pubkey" --require-signed
}

release_task_verify_windows_artifacts() { # <inno-dir> <reused:0|1>
  local inno="$1" reused="$2" pubkey
  assert_windows_artifact_cardinality "$inno" || return $?
  if [[ "$reused" == "1" ]]; then
    # As on Linux: a journal-controlled resume never inherits the manual salvage
    # bypasses, because its source/gitlink identity is exact.
    PAPERCUSP_ALLOW_REUSE_UNVERIFIED=0 \
    PAPERCUSP_ALLOW_REUSE_VERSION_MISMATCH=0 \
      assert_reused_provenance "$inno" windows || return $?
    if [[ "$WINDOWS_REUSE_GIT_HEAD" != "$PROVENANCE_SOURCE_GIT_HEAD" || "$WINDOWS_REUSE_GIT_DIRTY" != "false" ]]; then
      echo "ERROR: reused Windows provenance does not match the managed release's exact clean desktop gitlink." >&2
      return 1
    fi
  fi
  pubkey="$(release_task_target_pubkey)" || return $?
  bash "$ORCHESTRATOR_HERE/verify-provenance.sh" "$inno" \
    --health-sha "$BUILD_SHA" --pubkey "$pubkey" --require-signed
}

release_task_verify_mac_artifacts() { # <mac-bundle-dir> <reused:0|1>
  local bundle="$1" reused="$2" pubkey
  assert_mac_artifact_cardinality "$bundle" || return $?
  if [[ "$reused" == "1" ]]; then
    # As on the other legs: a journal-controlled resume never inherits the manual
    # salvage bypasses, because its source/gitlink identity is exact. This matters
    # most here — PAPERCUSP_REUSE_MAC salvages bytes from an earlier cut, and the
    # unversioned .app.tar.gz cannot be checked by name, so provenance is the only
    # thing standing between a salvaged bundle and THIS cut's version label.
    PAPERCUSP_ALLOW_REUSE_UNVERIFIED=0 \
    PAPERCUSP_ALLOW_REUSE_VERSION_MISMATCH=0 \
      assert_reused_provenance "$bundle" mac || return $?
    if [[ "$MAC_REUSE_GIT_HEAD" != "$PROVENANCE_SOURCE_GIT_HEAD" || "$MAC_REUSE_GIT_DIRTY" != "false" ]]; then
      echo "ERROR: reused mac provenance does not match the managed release's exact clean desktop gitlink." >&2
      return 1
    fi
  fi
  pubkey="$(release_task_target_pubkey)" || return $?
  bash "$ORCHESTRATOR_HERE/verify-provenance.sh" "$bundle" \
    --health-sha "$BUILD_SHA" --pubkey "$pubkey" --require-signed
}

release_task_leg_commit() { # <leg> <bundle-dir> <reused:0|1>
  local leg="${1:-}" bundle="$2" reused="$3"
  local provenance_sha result verify_started verification_ms decision action stage prep_start
  local committed_set observed_set output_set
  [[ "$RELEASE_TASK_JOURNAL_ENABLED" == "1" ]] || return 0
  release_task_leg_assert_known "$leg" || return $?
  stage="release.build.$leg"
  action="$(release_task_leg_get "$leg" ACTION)"
  prep_start="$(release_task_leg_get "$leg" PREPARATION_START_MS)"
  case "$action" in
    run|reconcile) ;;
    reuse)
      # A committed receipt authorizes no mutation, but it also grants no trust:
      # recheck after collection/provenance re-emit before downstream consumers
      # use these bytes.
      verify_started="$(release_task_now_ms)" || return $?
      "release_task_verify_${leg}_artifacts" "$bundle" "$reused" || return $?
      # P-003 clause 1 (D-008). The checks above re-derive trust from the CURRENT
      # tree — cardinality, provenance, signature — so a different-but-internally
      # -consistent artifact set passes every one of them. This is the only check
      # that asks the question reuse actually turns on: are these the same BYTES
      # the receipt committed? A receipt with no digest predates the field and
      # cannot answer, so it fails closed rather than reusing unverifiable bytes.
      committed_set="$(release_task_leg_get "$leg" ARTIFACT_SET)"
      if [[ -z "$committed_set" ]]; then
        echo "ERROR: $stage has a committed receipt with no artifact-set digest; it cannot prove these bytes are the ones it accepted. Start a new release operation." >&2
        return 1
      fi
      observed_set="$(release_task_leg_output_digest "$bundle")" || return $?
      if [[ "$observed_set" != "$committed_set" ]]; then
        echo "ERROR: $stage bytes are NOT the ones its receipt committed (receipt $committed_set, on disk $observed_set); refusing to reuse them." >&2
        return 1
      fi
      verification_ms="$(release_task_elapsed_ms "$verify_started")" || return $?
      RELEASE_TASK_PREPARATION_MS="$(release_task_elapsed_ms "$prep_start")" || return $?
      release_task_emit_timing "$stage" verified-reuse "$verification_ms"
      return 0
      ;;
    *) echo "ERROR: cannot commit $stage from action '$action'." >&2; return 2 ;;
  esac
  verify_started="$(release_task_now_ms)" || return $?
  "release_task_verify_${leg}_artifacts" "$bundle" "$reused" || {
    echo "ERROR: $stage bytes failed verification; receipt remains $action (fail closed)." >&2
    return 1
  }
  verification_ms="$(release_task_elapsed_ms "$verify_started")" || return $?
  RELEASE_TASK_PREPARATION_MS="$(release_task_elapsed_ms "$prep_start")" || return $?
  RELEASE_TASK_REUSE_EXPIRES_AT="$(release_task_audit_reuse_expiry)" || {
    echo "ERROR: verified $leg bytes have no fresh release identity-scan evidence." >&2
    return 1
  }
  provenance_sha="$(sha256sum "$bundle/build-provenance.json" | cut -d' ' -f1)"
  # P-003 clause 1 (D-008) / R-2. `build-provenance:sha256:` digests the
  # provenance FILE, which a reuse re-emits — so it can never be compared against
  # anything. This is the re-emission-stable digest of the artifact set itself,
  # and it is what the reuse branch above checks the bytes against.
  output_set="$(release_task_leg_output_digest "$bundle")" || {
    echo "ERROR: could not digest the $leg artifact set; refusing to commit a receipt that cannot be verified later." >&2
    return 1
  }
  if ! result="$(release_task_journal_call commit "$stage" "$(release_task_leg_get "$leg" IDENTITY)" \
      "$(release_task_leg_get "$leg" REQUEST_ID)" \
      "build-provenance:sha256:$provenance_sha" \
      "artifact-set:sha256:$output_set" \
      "source-gitlink:$PROVENANCE_SOURCE_GIT_HEAD" \
      "artifact-set:hash-signature-verified" \
      "audit-reuse-expires:$RELEASE_TASK_REUSE_EXPIRES_AT")"; then
    echo "ERROR: verified $leg bytes could not be committed to the release journal." >&2
    return 1
  fi
  [[ "$(release_task_json_field "$result" state)" == "committed" ]] || {
    echo "ERROR: release journal did not confirm $stage committed." >&2
    return 1
  }
  # WI-10003545. Flipping ACTION to reuse routes every later settle of this leg in
  # THIS process (the collection-join commit below) through the reuse branch, which
  # checks the bytes against ARTIFACT_SET. That slot was loaded at leg start from
  # the begin response, and a cross-task `reconcile` begin returns the NEW intent's
  # refs, which carry no digest — so without this the parent settle refused a
  # receipt the journal had just committed WITH a digest ("no artifact-set digest",
  # op 2db8843f, 0.0.22). The digest just committed is the one to check against.
  release_task_leg_set "$leg" ARTIFACT_SET "$output_set"
  release_task_leg_set "$leg" ACTION reuse
  decision="$([[ "$reused" == "1" ]] && printf cache-hit || printf built)"
  release_task_emit_timing "$stage" "$decision" "$verification_ms"
}

release_task_leg_prepare() { # <leg> <bundle-dir>
  local leg="${1:-}" bundle="$2" action stage reuse_var
  [[ "$RELEASE_TASK_JOURNAL_ENABLED" == "1" ]] || return 0
  release_task_leg_assert_known "$leg" || return $?
  stage="release.build.$leg"
  reuse_var="${RELEASE_TASK_LEG_REUSE_VAR[$leg]}"
  action="$(release_task_leg_get "$leg" ACTION)"
  case "$action" in
    run) return 0 ;;
    reuse|reconcile) ;;
    *) echo "ERROR: invalid $stage action '$action'." >&2; return 2 ;;
  esac

  if "release_task_${leg}_outputs_absent" "$bundle"; then
    if [[ "$action" == "reuse" ]]; then
      echo "ERROR: $stage is committed but its artifact/provenance set is absent; refusing to rebuild under the spent receipt." >&2
      return 1
    fi
    echo "==> [journal] prior $stage outcome is confirmed absent; refusing its spent request before retry"
    release_task_journal_call refuse "$stage" "$(release_task_leg_get "$leg" IDENTITY)" \
      "$(release_task_leg_get "$leg" REQUEST_ID)" "artifact-set:confirmed-absent" >/dev/null || return $?
    release_task_begin_stage "$stage" "$(release_task_leg_get "$leg" IDENTITY)" || return $?
    [[ "$RELEASE_TASK_LAST_ACTION" == "run" ]] || {
      echo "ERROR: $stage did not mint a fresh attempt after confirmed absence." >&2
      return 1
    }
    release_task_leg_set "$leg" ACTION run
    release_task_leg_set "$leg" REQUEST_ID "$RELEASE_TASK_LAST_REQUEST_ID"
    printf -v "$reuse_var" '%s' 0
    PAPERCUSP_RELEASE_CUT_START_NS="$(release_artifacts_cut_start_write "$TAG")" || return $?
    export PAPERCUSP_RELEASE_CUT_START_NS
    echo "==> [journal] $stage retry=$(release_task_leg_get "$leg" REQUEST_ID); refreshed cut-start=$PAPERCUSP_RELEASE_CUT_START_NS"
    return 0
  fi

  "release_task_verify_${leg}_artifacts" "$bundle" 1 || {
    echo "ERROR: $stage receipt has present but mismatched/partial bytes; not treating corruption as absence." >&2
    return 1
  }
  if [[ "$action" == "reconcile" ]]; then
    release_task_leg_commit "$leg" "$bundle" 1 || return $?
  fi
  printf -v "$reuse_var" '%s' 1
  release_task_leg_set "$leg" ACTION reuse
  echo "==> [journal] $stage verified; activating the existing $reuse_var path"
}

release_task_manifest_input_identity() { # <artifact>...
  PAPERCUSP_MANIFEST_VERSION="$VERSION" \
  PAPERCUSP_MANIFEST_CHANNEL="$CHANNEL" \
  PAPERCUSP_MANIFEST_TAG="$TAG" \
  PAPERCUSP_MANIFEST_UPDATE_BASE="${PAPERCUSP_UPDATE_BASE_URL:-}" \
  PAPERCUSP_MANIFEST_ROLES="$PAPERCUSP_BUILD_ROLES" \
    python3 - "$@" <<'PY'
import hashlib, json, os, pathlib, sys

rows = []
names = set()
for raw in sys.argv[1:]:
    path = pathlib.Path(raw)
    if not path.is_file():
        raise SystemExit(f"release manifest input is missing: {path}")
    if path.name in names:
        raise SystemExit(f"release manifest input has duplicate artifact basename: {path.name}")
    names.add(path.name)
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    rows.append({"name": path.name, "bytes": path.stat().st_size, "sha256": digest.hexdigest()})
payload = {
    "version": os.environ["PAPERCUSP_MANIFEST_VERSION"],
    "channel": os.environ["PAPERCUSP_MANIFEST_CHANNEL"],
    "tag": os.environ["PAPERCUSP_MANIFEST_TAG"],
    "updateBaseSha256": hashlib.sha256(os.environ["PAPERCUSP_MANIFEST_UPDATE_BASE"].rstrip("/").encode()).hexdigest(),
    "roles": os.environ["PAPERCUSP_MANIFEST_ROLES"].split(),
    "artifacts": sorted(rows, key=lambda row: row["name"]),
}
encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
print("manifest-input-sha256:" + hashlib.sha256(encoded).hexdigest())
PY
}

release_task_manifest_outputs_absent() {
  # These three are written in order by the canonical generator + artifact
  # ledger writer.  Any missing member proves the local stage never reached its
  # complete output boundary and is safe to classify as absent/retryable.  A
  # complete set with bad content is handled separately as corruption.
  [[ ! -f "$LATEST_JSON" || ! -f "$NOTES_FILE" || ! -f "$ARTIFACTS_MANIFEST" ]]
}

release_task_verify_manifest_outputs() { # <artifact>...
  local expected_dir expected_gui expected_server expected_notes
  expected_dir="$(mktemp -d "${TMPDIR:-/tmp}/papercusp-manifest-verify.XXXXXX")" || return 1
  expected_gui="$expected_dir/latest.json"
  expected_server="$expected_dir/latest-server.json"
  expected_notes="$expected_dir/release-notes.md"

  # Re-run the SAME generator into an isolated output namespace.  Function
  # overrides change only its pure path helpers; classification, URL encoding,
  # product separation, signature selection, and notes stay single-sourced.
  if ! (
    gen_latest_manifest_json_path() { printf '%s\n' "$expected_gui"; }
    gen_latest_manifest_server_json_path() { printf '%s\n' "$expected_server"; }
    gen_latest_manifest_notes_path() { printf '%s\n' "$expected_notes"; }
    unset GEN_LATEST_MANIFEST_MERGE_GUI_JSON GEN_LATEST_MANIFEST_MERGE_SERVER_JSON
    gen_latest_manifest "$VERSION" "$CHANNEL" "$TAG" "$@" >/dev/null
  ); then
    rm -rf -- "$expected_dir"
    echo "ERROR: could not reproduce the canonical release manifest for verification." >&2
    return 1
  fi

  PAPERCUSP_MANIFEST_ACTUAL_GUI="$LATEST_JSON" \
  PAPERCUSP_MANIFEST_ACTUAL_SERVER="$LATEST_SERVER_JSON" \
  PAPERCUSP_MANIFEST_ACTUAL_NOTES="$NOTES_FILE" \
  PAPERCUSP_MANIFEST_ACTUAL_LEDGER="$ARTIFACTS_MANIFEST" \
  PAPERCUSP_MANIFEST_EXPECTED_GUI="$expected_gui" \
  PAPERCUSP_MANIFEST_EXPECTED_SERVER="$expected_server" \
  PAPERCUSP_MANIFEST_EXPECTED_NOTES="$expected_notes" \
    python3 - "$@" <<'PY'
import datetime, json, os, pathlib, sys

artifacts = [pathlib.Path(raw) for raw in sys.argv[1:]]
if not artifacts or any(not path.is_file() for path in artifacts):
    raise SystemExit("release manifest receipt has a missing/empty artifact set")
names = [path.name for path in artifacts]
if len(names) != len(set(names)):
    raise SystemExit("release manifest receipt has duplicate artifact basenames")

ledger = pathlib.Path(os.environ["PAPERCUSP_MANIFEST_ACTUAL_LEDGER"])
if not ledger.is_file():
    raise SystemExit(f"release artifact ledger is missing: {ledger}")
recorded = sorted(line.strip() for line in ledger.read_text().splitlines() if line.strip())
# release_artifacts_write preserves absolute input spellings (including a
# deliberate symlinked target root); compare the same lexical absolute paths,
# not realpath-resolved aliases.
expected_paths = sorted({os.path.abspath(str(path)) for path in artifacts})
if recorded != expected_paths:
    raise SystemExit("release artifact ledger does not name the exact current artifact set")

def normalized_manifest(raw):
    path = pathlib.Path(raw)
    if not path.is_file():
        raise SystemExit(f"release manifest is missing: {path}")
    try:
        value = json.loads(path.read_text())
    except Exception as error:
        raise SystemExit(f"release manifest is invalid JSON ({path}): {error}")
    try:
        datetime.datetime.fromisoformat(str(value["pub_date"]).replace("Z", "+00:00"))
    except Exception:
        raise SystemExit(f"release manifest has no valid pub_date: {path}")
    value["pub_date"] = "<verified-timestamp>"
    return value

pairs = [
    (os.environ["PAPERCUSP_MANIFEST_ACTUAL_GUI"], os.environ["PAPERCUSP_MANIFEST_EXPECTED_GUI"]),
]
actual_server = pathlib.Path(os.environ["PAPERCUSP_MANIFEST_ACTUAL_SERVER"])
expected_server = pathlib.Path(os.environ["PAPERCUSP_MANIFEST_EXPECTED_SERVER"])
if actual_server.is_file() != expected_server.is_file():
    raise SystemExit("latest-server.json presence does not match the canonical generator")
if expected_server.is_file():
    pairs.append((str(actual_server), str(expected_server)))
for actual, expected in pairs:
    if normalized_manifest(actual) != normalized_manifest(expected):
        raise SystemExit(f"release manifest does not match the canonical generator: {actual}")

actual_notes = pathlib.Path(os.environ["PAPERCUSP_MANIFEST_ACTUAL_NOTES"])
expected_notes = pathlib.Path(os.environ["PAPERCUSP_MANIFEST_EXPECTED_NOTES"])
if not actual_notes.is_file() or actual_notes.read_bytes() != expected_notes.read_bytes():
    raise SystemExit("release notes do not match the canonical generator")
PY
  local verify_rc=$?
  rm -rf -- "$expected_dir"
  (( verify_rc == 0 )) || return "$verify_rc"
  RELEASE_ARTIFACTS_NO_REACHABILITY=1 \
    release_artifacts_assert_urls_covered "$TAG" "$LATEST_JSON" "$LATEST_SERVER_JSON" || return $?
  RELEASE_ARTIFACTS_NO_SIGNATURE_CHECK= \
    release_artifacts_assert_signatures_present "$TAG"
}

release_task_manifest_output_digest() {
  python3 - "$LATEST_JSON" "$LATEST_SERVER_JSON" "$NOTES_FILE" "$ARTIFACTS_MANIFEST" <<'PY'
import hashlib, pathlib, sys
outer = hashlib.sha256()
for raw in sys.argv[1:]:
    path = pathlib.Path(raw)
    if not path.is_file():
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    outer.update(path.name.encode() + b"\0" + digest.encode() + b"\0")
print(outer.hexdigest())
PY
}

release_task_commit_manifest_stage() { # <artifact>...
  local output_digest result verify_started verification_ms decision
  [[ "$RELEASE_TASK_JOURNAL_ENABLED" == "1" ]] || return 0
  case "$RELEASE_TASK_MANIFEST_ACTION" in
    run|reconcile) ;;
    reuse)
      # P-004 / R-4 demand 4 ("never silently republishes an unverified artifact").
      # This used to `return 0` outright, which made the manifest the ONE stage
      # whose reuse path trusted its receipt without re-reading the bytes -- while
      # linux, windows and mac all re-verify. Since the manifest is what the
      # publish step consumes, that gap is the exact shape R-4 names: a committed
      # receipt authorizing publication of outputs nobody re-checked.
      #
      # Parity fix, not new policy. The prepare path already proves the outputs are
      # PRESENT; presence is not integrity, so re-run the canonical-generator check
      # and compare the digest the receipt actually committed.
      verify_started="$(release_task_now_ms)" || return $?
      release_task_verify_manifest_outputs "$@" || {
        echo "ERROR: reused release.manifest outputs failed verification; refusing to publish them." >&2
        return 1
      }
      if [[ -z "$RELEASE_TASK_MANIFEST_OUTPUT_DIGEST" ]]; then
        echo "ERROR: release.manifest has a committed receipt with no output digest; it cannot prove these outputs are the ones it accepted. Start a new release operation." >&2
        return 1
      fi
      output_digest="$(release_task_manifest_output_digest)" || return $?
      if [[ "$output_digest" != "$RELEASE_TASK_MANIFEST_OUTPUT_DIGEST" ]]; then
        echo "ERROR: release.manifest outputs are NOT the ones its receipt committed (receipt $RELEASE_TASK_MANIFEST_OUTPUT_DIGEST, on disk $output_digest); refusing to publish them." >&2
        return 1
      fi
      verification_ms="$(release_task_elapsed_ms "$verify_started")" || return $?
      release_task_emit_timing release.manifest verified-reuse "$verification_ms"
      return 0
      ;;
    *) echo "ERROR: cannot commit release.manifest from action '$RELEASE_TASK_MANIFEST_ACTION'." >&2; return 2 ;;
  esac
  verify_started="$(release_task_now_ms)" || return $?
  release_task_verify_manifest_outputs "$@" || {
    echo "ERROR: release.manifest outputs failed verification; receipt remains $RELEASE_TASK_MANIFEST_ACTION (fail closed)." >&2
    return 1
  }
  verification_ms="$(release_task_elapsed_ms "$verify_started")" || return $?
  RELEASE_TASK_PREPARATION_MS="$(release_task_elapsed_ms "$RELEASE_TASK_MANIFEST_PREPARATION_START_MS")" || return $?
  RELEASE_TASK_REUSE_EXPIRES_AT="$(release_task_audit_reuse_expiry)" || {
    echo "ERROR: verified manifest inputs have no fresh release identity-scan evidence." >&2
    return 1
  }
  output_digest="$(release_task_manifest_output_digest)" || return $?
  if ! result="$(release_task_journal_call commit release.manifest "$RELEASE_TASK_MANIFEST_IDENTITY" \
      "$RELEASE_TASK_MANIFEST_REQUEST_ID" \
      "manifest-receipt:sha256:$output_digest" \
      "artifact-ledger:exact-set-verified" \
      "audit-reuse-expires:$RELEASE_TASK_REUSE_EXPIRES_AT")"; then
    echo "ERROR: verified manifest outputs could not be committed to the release journal." >&2
    return 1
  fi
  [[ "$(release_task_json_field "$result" state)" == "committed" ]] || {
    echo "ERROR: release journal did not confirm release.manifest committed." >&2
    return 1
  }
  decision="$([[ "$RELEASE_TASK_MANIFEST_ACTION" == "reconcile" ]] && printf cache-hit || printf built)"
  RELEASE_TASK_MANIFEST_ACTION=reuse
  release_task_emit_timing release.manifest "$decision" "$verification_ms"
}

release_task_prepare_manifest_stage() { # <artifact>...
  local result
  RELEASE_TASK_MANIFEST_SKIP=0
  [[ "$RELEASE_TASK_JOURNAL_ENABLED" == "1" ]] || return 0
  RELEASE_TASK_MANIFEST_PREPARATION_START_MS="$(release_task_now_ms)" || return $?
  RELEASE_TASK_MANIFEST_IDENTITY="$(release_task_manifest_input_identity "$@")" || return $?
  release_task_begin_stage release.manifest "$RELEASE_TASK_MANIFEST_IDENTITY" || return $?
  RELEASE_TASK_MANIFEST_ACTION="$RELEASE_TASK_LAST_ACTION"
  RELEASE_TASK_MANIFEST_REQUEST_ID="$RELEASE_TASK_LAST_REQUEST_ID"
  RELEASE_TASK_MANIFEST_OUTPUT_DIGEST="$RELEASE_TASK_LAST_MANIFEST_RECEIPT"
  case "$RELEASE_TASK_MANIFEST_ACTION" in
    run) return 0 ;;
    reuse|reconcile) ;;
    refused)
      echo "ERROR: release.manifest has an unresolved refused receipt; start a new release operation after resolving it." >&2
      return 1
      ;;
  esac

  if release_task_manifest_outputs_absent; then
    if [[ "$RELEASE_TASK_MANIFEST_ACTION" == "reuse" ]]; then
      echo "ERROR: release.manifest is committed but its manifest/artifact-ledger outputs are absent; refusing to regenerate under the spent receipt." >&2
      return 1
    fi
    echo "==> [journal] prior release.manifest outcome is confirmed absent; refusing its spent request before retry"
    release_task_journal_call refuse release.manifest "$RELEASE_TASK_MANIFEST_IDENTITY" \
      "$RELEASE_TASK_MANIFEST_REQUEST_ID" "manifest-outputs:confirmed-absent" >/dev/null || return $?
    release_task_begin_stage release.manifest "$RELEASE_TASK_MANIFEST_IDENTITY" || return $?
    [[ "$RELEASE_TASK_LAST_ACTION" == "run" ]] || {
      echo "ERROR: release.manifest did not mint a fresh attempt after confirmed absence." >&2
      return 1
    }
    RELEASE_TASK_MANIFEST_ACTION=run
    RELEASE_TASK_MANIFEST_REQUEST_ID="$RELEASE_TASK_LAST_REQUEST_ID"
    return 0
  fi

  local verify_started verification_ms
  verify_started="$(release_task_now_ms)" || return $?
  release_task_verify_manifest_outputs "$@" || {
    echo "ERROR: release.manifest receipt has present but mismatched/partial outputs; not treating corruption as absence." >&2
    return 1
  }
  verification_ms="$(release_task_elapsed_ms "$verify_started")" || return $?
  if [[ "$RELEASE_TASK_MANIFEST_ACTION" == "reconcile" ]]; then
    release_task_commit_manifest_stage "$@" || return $?
  else
    RELEASE_TASK_PREPARATION_MS="$(release_task_elapsed_ms "$RELEASE_TASK_MANIFEST_PREPARATION_START_MS")" || return $?
    release_task_emit_timing release.manifest verified-reuse "$verification_ms"
  fi
  RELEASE_TASK_MANIFEST_ACTION=reuse
  RELEASE_TASK_MANIFEST_SKIP=1
  echo "==> [journal] release.manifest verified; reusing the immutable manifest/artifact-ledger outputs"
}

release_task_journal_configure || exit $?
# ── end P-005 release-task journal helpers ──────────────────────────────────

echo "==> version=$VERSION channel=$CHANNEL tag=$TAG"

# P-016: parity regression gate — fail FAST (before the ~35-min build) if any leg
# re-forked provenance emission or the centralized honest-sha derivation. Fast +
# hermetic. Skip with PAPERCUSP_SKIP_PROVENANCE_PARITY_CHECK=1 (emergencies only).
if [[ "${PAPERCUSP_SKIP_PROVENANCE_PARITY_CHECK:-0}" != "1" ]]; then
  echo "==> checking build-provenance parity (P-016)"
  bash "$ROOT/bin/verify-provenance-parity.sh" \
    || { echo "ERROR: build-provenance parity gate failed (above) — a leg re-forked provenance. Fix, or PAPERCUSP_SKIP_PROVENANCE_PARITY_CHECK=1 to override."; exit 1; }
fi

# WSL rootfs gate — fail FAST (before the ~35-min build), and self-heal when it is safe.
#
# src-tauri/resources/papercup-runtime.tar.gz (~245MB) is GITIGNORED (.gitignore:31), so
# it is a build artifact that lives only in whichever checkout last ran build-rootfs.sh.
# EVERY release cut runs from a fresh `git worktree`, which by construction receives no
# copy — so the Windows leg reaches build-windows-cross.sh:161 and dies on "WSL rootfs
# missing". That failure is far more expensive than it looks: the win leg is launched in
# PARALLEL with linux/mac, and its failure aborts the WHOLE cut. The 0.0.17 cut
# (2026-08-15) lost three healthy legs this way, ~10 minutes in, to a missing file that
# was knowable at second zero. (EI-20549139616021387 has since made supervise_legs
# SALVAGE the healthy siblings rather than reap them — but the cut still fails, and it
# still costs the ~10 minutes of compute this preflight exists to refuse in seconds.)
#
# Hydration is VERIFIABLE, not a guess: .rootfs-build-stamp is TRACKED, so the pinned
# commit itself names the exact rootfsSha256 it expects. We accept a donor copy only if
# its sha256 equals that stamp — so a stale or wrong-recipe rootfs can never be silently
# packed into an installer. No matching donor ⇒ we fail HERE, with the fix, instead of
# 10 minutes later taking two other legs down with us.
if [[ "$WITH_WINDOWS" == "1" && "${PAPERCUSP_REUSE_WIN:-0}" != "1" ]]; then
  rootfs_tarball="$ROOT/src-tauri/resources/papercup-runtime.tar.gz"
  rootfs_stamp="$ROOT/src-tauri/resources/.rootfs-build-stamp"
  if [[ ! -f "$rootfs_tarball" ]]; then
    echo "==> WSL rootfs absent (gitignored ⇒ a fresh worktree never has one) — attempting VERIFIED hydration"
    [[ -f "$rootfs_stamp" ]] || {
      echo "ERROR: WITH_WINDOWS=1 but neither the rootfs tarball nor its tracked stamp exists." >&2
      echo "       Expected stamp: $rootfs_stamp" >&2
      echo "       Run scripts/build-rootfs.sh (~250-400MB output), or cut with WITH_WINDOWS=0." >&2
      exit 1; }
    rootfs_want_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("rootfsSha256",""))' "$rootfs_stamp" 2>/dev/null || true)"
    [[ -n "$rootfs_want_sha" ]] || { echo "ERROR: $rootfs_stamp has no rootfsSha256 — cannot verify a donor. Run scripts/build-rootfs.sh." >&2; exit 1; }
    # Bounded one-level scan of sibling checkouts in the workspace root (never a deep find).
    rootfs_donor=""
    for cand in "${PAPERCUSP_ROOTFS_DONOR:-}" \
                "$(cd "$ROOT/../.." 2>/dev/null && pwd)"/*/papercusp-desktop/src-tauri/resources/papercup-runtime.tar.gz \
                "$(cd "$ROOT/../.." 2>/dev/null && pwd)"/papercusp-desktop/src-tauri/resources/papercup-runtime.tar.gz; do
      [[ -n "$cand" && -f "$cand" ]] || continue
      [[ "$cand" -ef "$rootfs_tarball" ]] && continue
      if [[ "$(sha256sum "$cand" | cut -d' ' -f1)" == "$rootfs_want_sha" ]]; then rootfs_donor="$cand"; break; fi
      echo "    (donor rejected — sha256 != tracked stamp: $cand)"
    done
    [[ -n "$rootfs_donor" ]] || {
      echo "ERROR: WITH_WINDOWS=1 but no rootfs tarball matching the TRACKED stamp was found." >&2
      echo "       want sha256: $rootfs_want_sha" >&2
      echo "       Run scripts/build-rootfs.sh, set PAPERCUSP_ROOTFS_DONOR=/path/to/papercup-runtime.tar.gz," >&2
      echo "       or cut with WITH_WINDOWS=0. (Failing here costs seconds; failing in the win leg aborts the whole cut.)" >&2
      exit 1; }
    cp "$rootfs_donor" "$rootfs_tarball.tmp.$$" && mv "$rootfs_tarball.tmp.$$" "$rootfs_tarball"
    echo "==> WSL rootfs hydrated from $rootfs_donor (sha256 verified against tracked stamp)"
  fi
  # Whether pre-existing or just hydrated, the bytes we are about to pack must match the stamp.
  if [[ -f "$rootfs_stamp" ]]; then
    rootfs_want_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("rootfsSha256",""))' "$rootfs_stamp" 2>/dev/null || true)"
    rootfs_have_sha="$(sha256sum "$rootfs_tarball" | cut -d' ' -f1)"
    if [[ -n "$rootfs_want_sha" && "$rootfs_have_sha" != "$rootfs_want_sha" ]]; then
      echo "ERROR: WSL rootfs does not match the tracked .rootfs-build-stamp — refusing to pack it." >&2
      echo "       want $rootfs_want_sha" >&2
      echo "       have $rootfs_have_sha  ($rootfs_tarball)" >&2
      echo "       Re-run scripts/build-rootfs.sh to regenerate it for this commit." >&2
      exit 1
    fi
    echo "==> WSL rootfs verified against tracked stamp ($rootfs_have_sha)"
  fi
fi

# Windows TOOLCHAIN preflight (WI-39339) — the third instance of the same pattern, and the
# same economics: build-windows-cross.sh:139-149 already checks each of these, but it checks
# them INSIDE the leg, which is launched in parallel and joined FATALLY. So a missing wine or
# an unprovisioned Inno prefix — host state that is knowable at second zero and cannot change
# during the cut — is discovered only after the leg starts, ~10 minutes of compute later,
# and fails the whole cut. (Since EI-20549139616021387 the healthy linux/android/mac legs
# are SALVAGED rather than reaped, but the cut is still lost.)
#
# SCOPE IS DELIBERATE — these six are HOST CAPABILITIES, true or false before the cut begins.
# Two of build-windows-cross.sh's other preconditions are deliberately NOT hoisted:
#   - the SIDECAR ($SRC_TAURI/sidecar/apps): release-local.sh BUILDS it at build-desktop-sidecar.sh
#     below, which runs AFTER this preflight zone but BEFORE any leg launches. Asserting it here
#     would fail on a tree that is about to be perfectly valid — a false refusal, not a fast one.
#   - src-tauri/icons/icon.ico: TRACKED in the papercusp-desktop submodule and not gitignored
#     (verified), so unlike the WSL rootfs it is present in every fresh worktree by construction.
#     The in-leg check remains the right home for it.
# The in-leg checks all stay regardless: build-windows-cross.sh must remain safe to invoke
# directly, outside a cut. This is defence in depth, not relocation.
if [[ "$WITH_WINDOWS" == "1" && "${PAPERCUSP_REUSE_WIN:-0}" != "1" ]]; then
  # Mirror build-windows-cross.sh's own derivations EXACTLY (:94, :121, :128-129). If these
  # drift apart, this preflight would happily verify a DIFFERENT path than the leg later uses
  # — a guard that passes while the leg dies, which is worse than no guard. A test pins the
  # two files' defaults together so the drift fails loudly instead.
  win_target="x86_64-pc-windows-msvc"
  win_key_file="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.papercusp/signing/papercusp.key}"
  win_wineprefix_inno="${PAPERCUSP_WINE_INNO_PREFIX:-$HOME/.papercusp/wine-inno}"
  win_iscc_exe="${PAPERCUSP_ISCC_EXE:-$win_wineprefix_inno/drive_c/InnoSetup6/ISCC.exe}"

  win_missing=()
  command -v cargo >/dev/null 2>&1 || win_missing+=("cargo not on PATH")
  cargo xwin --version >/dev/null 2>&1 \
    || win_missing+=("cargo-xwin not installed or not working — cargo install cargo-xwin")
  # Capture-then-match rather than `rustup ... | grep -qx`: under `set -o pipefail` an
  # early-exiting grep can SIGPIPE the producer, so the pipeline reports failure even on a
  # match. That would refuse a perfectly good cut — the exact false-alarm class this file
  # exists to avoid.
  win_targets_installed="$(rustup target list --installed 2>/dev/null || true)"
  case "$win_targets_installed" in
    *"$win_target"*) ;;
    *) win_missing+=("rustup target $win_target not installed — rustup target add $win_target") ;;
  esac
  command -v wine >/dev/null 2>&1 \
    || win_missing+=("wine not installed — apt install wine + dpkg --add-architecture i386")
  command -v xvfb-run >/dev/null 2>&1 \
    || win_missing+=("xvfb-run not installed — apt install xvfb (ISCC runs headless under it)")
  [[ -f "$win_iscc_exe" ]] \
    || win_missing+=("ISCC not found at $win_iscc_exe — provision Inno Setup under WINEPREFIX=$win_wineprefix_inno")
  [[ -f "$win_key_file" ]] \
    || win_missing+=("updater signing key not found at $win_key_file — bin/setup-signing-key.sh")

  # Report EVERY missing prerequisite at once. Failing on the first would make provisioning a
  # fresh host an N-cut discovery loop; this is one cut, one list.
  if (( ${#win_missing[@]} > 0 )); then
    echo "ERROR: WITH_WINDOWS=1 but ${#win_missing[@]} Windows prerequisite(s) are missing — refusing to start the cut." >&2
    for m in "${win_missing[@]}"; do echo "       - $m" >&2; done
    echo "       Fix these, or cut with WITH_WINDOWS=0. (Failing here costs seconds; failing" >&2
    echo "        inside the win leg aborts the whole cut and reaps the other legs.)" >&2
    exit 1
  fi
  echo "==> Windows toolchain verified (cargo-xwin, $win_target, wine, xvfb-run, ISCC, signing key)"
fi

# Android versionName preflight — same shape, same reason as the WSL-rootfs block above:
# a defect that is knowable by reading ONE line at second zero must not be discovered
# ~10 minutes into a parallel leg, where a leg's fatal `exit 1` loses the whole cut.
#
# The failure this prevents (0.0.17 cut, 2026-08-15): android/app/build.gradle.kts hardcoded
# `versionName = "0.1.0"` while tools/build-scripts/android-release-provenance.sh:66-67
# asserts the packaged APK's versionName EQUALS the requested release version. That
# assertion is correct and stays — but it is POST-BUILD: it can only fire after a full
# Gradle release build, and the android leg is supervised FATALLY (supervise_legs, below), so it
# aborted the entire cut rather than just the mobile artifacts.
#
# This is therefore a STATIC read of the assignment, never a build. If versionName does not
# derive from PAPERCUP_RELEASE_VERSION — the variable this very script supplies to the leg —
# then the post-build assertion CANNOT hold, and the cut is already doomed. Refuse in
# seconds instead. Ordinary dev/debug builds leave the env unset and keep the repo default.
if [[ "$WITH_ANDROID" == "1" ]]; then
  android_gradle="$MOBILE_ROOT/android/app/build.gradle.kts"
  if [[ ! -f "$android_gradle" ]]; then
    echo "ERROR: WITH_ANDROID=1 but the sibling mobile app's build.gradle.kts is missing." >&2
    echo "       Expected: $android_gradle" >&2
    echo "       Cut with WITH_ANDROID=0 (or PAPERCUSP_SKIP_MOBILE=1) for a desktop-only cut." >&2
    exit 1
  fi
  # EVERY versionName assignment must derive from the env, not just the first one found:
  # a hardcoded assignment in a product flavor or a build type overrides defaultConfig in
  # the packaged APK, so "one good assignment exists" is not the property worth pinning.
  # Line comments are stripped BEFORE matching, and the match is NOT anchored to start-of-line:
  # anchoring misses the single-line flavor form `create("store") { versionName = "1.0.0" }`
  # (verified — that exact shape slips past a `^[[:space:]]*versionName` pattern), while
  # stripping `//` keeps a commented-out historical hardcode from false-refusing a good cut.
  android_vn_lines="$(sed 's;//.*;;' "$android_gradle" | grep -E 'versionName[[:space:]]*=' || true)"
  if [[ -z "$android_vn_lines" ]]; then
    echo "ERROR: WITH_ANDROID=1 but $android_gradle declares no versionName assignment." >&2
    echo "       The packaged APK would carry no release version for provenance to assert." >&2
    exit 1
  fi
  android_vn_total="$(printf '%s\n' "$android_vn_lines" | wc -l)"
  android_vn_env="$(printf '%s\n' "$android_vn_lines" | grep -cE 'PAPERCUP_RELEASE_VERSION' || true)"
  if [[ "$android_vn_total" != "$android_vn_env" ]]; then
    echo "ERROR: Android versionName does not track PAPERCUP_RELEASE_VERSION — refusing to start the cut." >&2
    echo "       $android_gradle" >&2
    echo "       $android_vn_env of $android_vn_total versionName assignment(s) read the env; all must." >&2
    sed 's;//.*;;' "$android_gradle" | grep -nE 'versionName[[:space:]]*=' >&2 || true
    echo "       Expected form: versionName = System.getenv(\"PAPERCUP_RELEASE_VERSION\")?.takeIf { it.isNotBlank() } ?: \"0.1.0\"" >&2
    echo "       (android-release-provenance.sh asserts the packaged versionName == the requested" >&2
    echo "        version AFTER a ~10-minute build, and the android leg is joined fatally — so" >&2
    echo "        failing here costs seconds, while failing there aborts the whole cut.)" >&2
    exit 1
  fi
  echo "==> Android versionName verified to derive from PAPERCUP_RELEASE_VERSION ($android_vn_env/$android_vn_total assignment(s))"
fi

# Migration-safety gate — fail FAST (before the ~35-min build) if a migration would
# crash the packaged operator on FIRST BOOT. Catches the migration-631 class (an
# unguarded work_items harness_slug re-slug UPDATE → duplicate work_items_pkey →
# crash-loop) that in v0.0.12 was found only AFTER a full build + install + boot —
# a big slice of that release's 12h. Static scan (seconds), no PG needed. Skip with
# PAPERCUSP_SKIP_MIGRATION_LINT=1 (emergencies only). Plan
# release-readiness-preflight-gate-2026-07-19 P-003.
if [[ "${PAPERCUSP_SKIP_MIGRATION_LINT:-0}" != "1" ]]; then
  echo "==> checking migration safety (lint:migrations)"
  ( cd "$ROOT/.." && node scripts/lint-migrations.mjs ) \
    || { echo "ERROR: migration lint failed (above) — a migration would break the packaged operator's first-boot migrate. Fix, or PAPERCUSP_SKIP_MIGRATION_LINT=1 to override."; exit 1; }
fi

# Cold-seed migration BOOT-SMOKE — the dynamic complement to the static lint above.
# Spins a throwaway PG and REPLAYS every libs/papercusp/libs/db/sql/*.sql in order
# (000-baseline then 104…N), exactly as the packaged operator's embedded-pg does on
# a clean install's first boot, and fails if ANY migration crashes. The lint catches
# the KNOWN 631 pattern statically in seconds; this catches the GENERAL class (any
# migration-vs-seed / ordering / dup-key crash) that the ordinary integration suite
# misses because it provisions from the squashed baseline, never a from-scratch
# replay. Docker/testcontainers required. A registered release:cut invocation may
# skip only after an independent exact-source replay passes and its proof is
# audited before launch; a direct shell may set the flag on a Docker-less box.
# The skip flag is PAPERCUSP_SKIP_MIGRATION_BOOTSMOKE=1. Plan
# release-readiness-preflight-gate-2026-07-19 P-001.
if [[ "${PAPERCUSP_SKIP_MIGRATION_BOOTSMOKE:-0}" != "1" ]]; then
  echo "==> checking migration boot-smoke (from-scratch replay of all migrations)"
  # This file's `afterAll` takes no explicit timeout, so it alone falls back to the integration
  # hookTimeout (90s default, libs/test-config/src/vitest-config.ts). Several green-checkpoint gate
  # runs share ONE `.withReuse()` Postgres container with this preflight, so a 90s CLEANUP budget
  # can expire on load rather than on any defect. The gate already granted itself exactly this
  # headroom for the same reason (green-checkpoint.ts buildGreenCheckpointEnv, EI-21863578695350444
  # after the 2026-08-29 timeout); the cut's preflight ran the same file at the bare default and
  # died on it during the 0.0.20 cut (2026-09-17). A pre-set value still wins.
  # The seeded replay's case budget grows with the migration corpus. The test:file
  # watchdog is a separate deadline; leave room for that case, the other two cases,
  # setup, and teardown so it cannot kill a still-progressing proof at 10 minutes.
  migration_sql_count="$(find "$ROOT/../libs/papercusp/libs/db/sql" -maxdepth 1 -name '*.sql' -type f | wc -l)"
  migration_file_timeout_ms="$((600000 + migration_sql_count * 2100))"
  ( cd "$ROOT/.." && VITEST_INTEGRATION_HOOK_TIMEOUT_MS="${VITEST_INTEGRATION_HOOK_TIMEOUT_MS:-180000}" PAPERCUSP_TEST_FILE_TIMEOUT_MS="${PAPERCUSP_TEST_FILE_TIMEOUT_MS:-$migration_file_timeout_ms}" npm run test:file -- packages/operator-core/lib/release-preflight-migration-boot-smoke.integration.test.ts ) \
    || { echo "ERROR: migration boot-smoke failed (above) — a migration may crash on a from-scratch replay. Fix it, or independently prove the exact source and use release:cut's audited migrationBootSmokeOverride (direct shell skip remains for Docker-less boxes)."; exit 1; }
fi

# Build-set architecture invariant — fail FAST (seconds, no build) if this cut's
# effective PAPERCUSP_BUILD_ROLES drops a required product. On mac/win the GUI
# attaches to a separately-installed Papercusp Server, so a gui-only role set ships
# a dead GUI (the 0.0.12 "Server dropped from the cut" class,
# desktop-build-speed-2026-07-16#D-004 — NOT this section's plan, which has no
# D-004). For a deliberate fast-iteration cut set
# PAPERCUSP_ALLOW_INCOMPLETE_ROLES=1 (a conscious warning). Plan
# release-readiness-preflight-gate-2026-07-19 P-002.
if [[ "${PAPERCUSP_SKIP_BUILDSET_CHECK:-0}" != "1" ]]; then
  echo "==> checking build-set completeness (roles=${PAPERCUSP_BUILD_ROLES})"
  ( cd "$ROOT/.." && npx tsx apps/operator/lib/release/preflight-build-set.ts ) \
    || { echo "ERROR: build-set check failed (above) — this release cut would drop a required product (e.g. the Server the mac/win GUI attaches to). Set PAPERCUSP_BUILD_ROLES=\"gui server\", or PAPERCUSP_ALLOW_INCOMPLETE_ROLES=1 for a deliberate partial cut."; exit 1; }
fi

# A caller-supplied TAURI_SIGNING_PRIVATE_KEY (key CONTENT or a path) satisfies this
# preflight on its own — it is what the sibling producers' own error text tells you to
# reach for, and hard-failing on the conventional FILE regardless made that advice inert
# on the one script that drives a real cut.
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && ! -f "$KEY_FILE" ]]; then
  echo "ERROR: signing key not found at $KEY_FILE"
  echo "       Run bin/setup-signing-key.sh, set TAURI_SIGNING_PRIVATE_KEY_PATH,"
  echo "       or export TAURI_SIGNING_PRIVATE_KEY (key content or a path) first."
  exit 1
fi

# NOTE: there is deliberately NO `gh` CLI preflight here. It used to hard-fail
# the cut when gh was missing or unauthenticated — dead weight once the GitHub
# publish leg was removed (2026-07-12), and an active landmine: it blocked a cut
# on any machine without an authenticated gh (e.g. the mac/windows VM legs, which
# drive this same script). A local build must never require a GitHub credential.

# Refuse to publish from a dirty tree on a STRICT channel (stable/beta). The
# lenient channels (alpha, nightly) allow it for fast iteration — nightly is cut
# from trunk daily on a tree the fleet edits continuously, so a clean-tree
# requirement there would block every cut.
#
# Asks the channel's `strict` property rather than testing `!= "alpha"`: that
# spelling means "every channel except alpha", which silently swept in each new
# lenient channel as it was added.
if desktop_channel_is_strict "$CHANNEL"; then
  if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
    echo "ERROR: tree dirty — commit or stash before a $CHANNEL release"
    git -C "$ROOT" status --short
    exit 1
  fi
fi

# WI-3047: guard against cutting a release from a STALE `libs/papercusp`
# submodule checkout — the actual root cause of the 2026-07-05 incident where a
# seeded Linux .deb shipped the pre-505/506 schema (agent_facts REPLICA
# IDENTITY sweep failure, the WI-2914 bug 505 fixes). build-desktop-sidecar.sh
# bakes db-seed.dump from whatever is CURRENTLY checked out under
# libs/papercusp/libs/db/sql/ — internally consistent by construction, but
# silently stale if the submodule pointer lags its remote (new migrations
# merged upstream, never pulled locally). Fail loud on stable/beta; warn on
# alpha (matches the dirty-tree check's channel split above).
# P-412 (2026-07-25, su-055ae): a freshness check that COULD NOT RUN must never score as
# "fresh" on a shipping channel. Both skip paths below (fetch failed / not a git repo) used
# to WARN and continue on EVERY channel, which silently downgraded a blocking stable/beta
# gate to nothing — one transient network blip on the build box and the WI-3047 guard is
# simply absent from the cut, with no signal distinguishing "verified fresh" from "never
# checked". That is the same can-falsely-pass shape as WI-5788/P-411, at the highest-stakes
# point in the system: it decides what ships to public users.
#
# Note the pre-existing asymmetry this fixes: an unknown commit COUNT already failed closed
# ('?' != '0' → the error path below), but an unknown FETCH failed open. Now both do.
#
# Channel split matches the dirty-tree check above: alpha warns, stable/beta blocks. An
# intentional offline cut is still possible, but must be DELIBERATE and is logged as such.
_wi3047_unverified() {
  local reason="$1"
  if ! desktop_channel_is_strict "$CHANNEL"; then
    echo "WARN: $reason — libs/papercusp freshness UNVERIFIED (continuing — lenient '$CHANNEL' channel)"
  elif [[ "${PAPERCUSP_ALLOW_UNVERIFIED_SUBMODULE:-0}" == "1" ]]; then
    echo "WARN: $reason — libs/papercusp freshness UNVERIFIED; continuing because"
    echo "      PAPERCUSP_ALLOW_UNVERIFIED_SUBMODULE=1 (deliberate operator override)."
  else
    echo "ERROR: $reason"
    echo "       Cannot verify libs/papercusp is not STALE, and this is a '$CHANNEL' cut."
    echo "       An unverifiable freshness check is NOT a pass: the 2026-07-05 WI-3047"
    echo "       incident shipped a pre-505/506 schema precisely because a stale submodule"
    echo "       went unnoticed. Refusing to cut rather than ship an unverified schema."
    echo "       Fix the cause (network / auth / remote), or re-run with"
    echo "       PAPERCUSP_ALLOW_UNVERIFIED_SUBMODULE=1 if you are deliberately cutting"
    echo "       offline AND have confirmed submodule freshness by hand."
    exit 1
  fi
}

PAPERCUSP_SUBMODULE_DIR="$(cd "$ROOT/.." && pwd)/libs/papercusp"
echo "==> checking libs/papercusp submodule freshness (WI-3047)"
if git -C "$PAPERCUSP_SUBMODULE_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  SUBMODULE_BRANCH="$(git -C "$PAPERCUSP_SUBMODULE_DIR" branch --show-current 2>/dev/null || true)"
  SUBMODULE_BRANCH="${SUBMODULE_BRANCH:-main}"
  # Capture the fetch's stderr instead of discarding it — when this fails on a shipping
  # channel it now blocks the cut, so the operator needs the actual reason (auth? DNS?
  # renamed branch?), not a bare "could not fetch". `|| _rc=$?` keeps it set -e safe.
  _sub_fetch_err="$(git -C "$PAPERCUSP_SUBMODULE_DIR" fetch --quiet origin "$SUBMODULE_BRANCH" 2>&1)" && _sub_fetch_rc=0 || _sub_fetch_rc=$?
  if [[ "$_sub_fetch_rc" -eq 0 ]]; then
    SUB_LOCAL_SHA="$(git -C "$PAPERCUSP_SUBMODULE_DIR" rev-parse HEAD)"
    SUB_REMOTE_SHA="$(git -C "$PAPERCUSP_SUBMODULE_DIR" rev-parse "origin/$SUBMODULE_BRANCH")"
    # WI-3047 is a STALENESS guard: block only when local is genuinely BEHIND origin
    # (missing merged migrations/code). `rev-list LOCAL..REMOTE` counts commits in
    # origin but NOT local = how far local is BEHIND. A local that is merely AHEAD of
    # origin (SUB_BEHIND=0, SHAs differ) is the NORMAL state on this shared tree —
    # git-sync commits the submodule locally faster than origin/$SUBMODULE_BRANCH
    # advances (a lagging green-checkpoint FF), and the superproject gitlink already
    # points at this local HEAD — so it ships a SUPERSET of what's merged, not a stale
    # subset, and must NOT block the cut. Only behind>0 (or an unknown '?' count) is
    # the real WI-3047 risk. (Previously this errored on ANY local!=remote mismatch,
    # which blocked EVERY stable/beta cut whenever local led a lagging origin.)
    SUB_BEHIND="$(git -C "$PAPERCUSP_SUBMODULE_DIR" rev-list --count "$SUB_LOCAL_SHA..$SUB_REMOTE_SHA" 2>/dev/null || echo '?')"
    if [[ "$SUB_BEHIND" != "0" ]]; then
      SUB_MSG="libs/papercusp is $SUB_BEHIND commit(s) behind origin/$SUBMODULE_BRANCH (local=${SUB_LOCAL_SHA:0:12} remote=${SUB_REMOTE_SHA:0:12}) — a release cut now may ship migrations/code that lag what's already merged (WI-3047 class)."
      if desktop_channel_is_strict "$CHANNEL"; then
        echo "ERROR: $SUB_MSG"
        echo "       Run: git -C libs/papercusp pull origin $SUBMODULE_BRANCH   (then re-stage the submodule pointer)"
        exit 1
      else
        echo "WARN: $SUB_MSG (continuing — lenient '$CHANNEL' channel)"
      fi
    elif [[ "$SUB_LOCAL_SHA" != "$SUB_REMOTE_SHA" ]]; then
      SUB_AHEAD="$(git -C "$PAPERCUSP_SUBMODULE_DIR" rev-list --count "$SUB_REMOTE_SHA..$SUB_LOCAL_SHA" 2>/dev/null || echo '?')"
      echo "    ✓ libs/papercusp is $SUB_AHEAD commit(s) AHEAD of origin/$SUBMODULE_BRANCH (${SUB_LOCAL_SHA:0:12}) — contains all merged code (not stale); origin lags the local tree"
    else
      echo "    ✓ libs/papercusp is up to date with origin/$SUBMODULE_BRANCH (${SUB_LOCAL_SHA:0:12})"
    fi
  else
    # NB: an `if`, not `[[ … ]] && echo` — under `set -e` a standalone AND-list whose test
    # is FALSE returns non-zero and kills the script, so the empty-stderr case would abort
    # the cut before ever reaching the channel decision below.
    if [[ -n "$_sub_fetch_err" ]]; then echo "       git fetch said: ${_sub_fetch_err//$'\n'/ }"; fi
    _wi3047_unverified "could not fetch libs/papercusp origin/$SUBMODULE_BRANCH (offline / network / auth?)"
  fi
else
  _wi3047_unverified "$PAPERCUSP_SUBMODULE_DIR is not a git repo"
fi

# ── Dogfood-pin tag precondition (read-only) ────────────────────────────────
# EI-24611322499942803: the exact remote tag was first checked AFTER the manifest
# bump below, so a cut run before op:prepare-tag failed with package.json,
# tauri.conf.json and Cargo.toml already rewritten. The follow-up prepare-tag then
# refused root_not_clean. Check the remote tag here, before the first write; the
# post-bump block below still aligns the LOCAL tag and re-verifies both.
# The shipped dogfood clone comes from GitHub, so certify against that exact public
# remote, not whichever origin the cut checkout inherited. operator-core's
# DOGFOOD_CANONICAL_REMOTE (release-cut-launch.ts) is pinned to this value by test.
PAPERCUP_DOGFOOD_CANONICAL_REMOTE="https://github.com/Papercusp/papercup"
if ! git -C "$MONOREPO" rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: dogfood pin: $MONOREPO is not a git repo; refusing an unpinned release" >&2
  exit 1
fi
_dogfood_pin_remote_sha="$(release_tag_remote_sha "$MONOREPO" "$TAG" "$PAPERCUP_DOGFOOD_CANONICAL_REMOTE")"
if [[ "$_dogfood_pin_remote_sha" != "$EXPECTED_SOURCE_SHA" ]]; then
  echo "ERROR: dogfood pin: $PAPERCUP_DOGFOOD_CANONICAL_REMOTE refs/tags/$TAG is ${_dogfood_pin_remote_sha:-<missing>}, expected $EXPECTED_SOURCE_SHA" >&2
  echo "       Nothing has been modified. Create the tag first with release:cut{op:'prepare-tag',...,confirm:true}" >&2
  echo "       (or PAPERCUSP_RELEASE_PREPARE_TAG_SHA=<sha> PAPERCUSP_RELEASE_PREPARE_TAG_CONFIRM=1 $0 $VERSION $CHANNEL)." >&2
  exit 1
fi
echo "==> dogfood pin precondition: $TAG is at ${EXPECTED_SOURCE_SHA:0:12} on $PAPERCUP_DOGFOOD_CANONICAL_REMOTE"

# ── PRECHECK-ONLY EXIT ────────────────────────────────────────────────────────
# THE LAST POINT AT WHICH THIS SCRIPT HAS TOUCHED NOTHING. Everything above is
# validation, provenance and preflight; the very next statement is the first
# WRITE to the shared working tree.
#
# WHY THIS EXISTS (2026-08-09). An agent verifying the channel-identity guards
# ~250 lines above ran `release-local.sh 9.9.9 alpha` as a probe, expecting it to
# refuse early. Nothing refuses an alpha cut, so it ran on to the version bump
# and stamped 9.9.9 into all FOUR manifests below. On this shared tree that is
# not a local mistake: git-sync swept it into a commit within a minute, and
# because every running `tauri dev` watches this same source tree, the write to
# src-tauri/tauri.conf.json rebuilt and restarted EVERY desktop on the box —
# the owner's included. Target-dir isolation does not prevent that; the two
# mechanisms are independent.
#
# The trap is that the script READS as a preflight for its first ~550 lines, so
# "just run it and see where it stops" is the natural way to test a guard, and
# it is wrong. Rather than warn about it, make the safe run available:
#
#   PAPERCUSP_RELEASE_PRECHECK_ONLY=1 bin/release-local.sh <version> <channel>
#
# runs every gate above and exits 0 having written nothing. Use it to verify a
# preflight change; use a real cut for a real cut.
if [[ "${PAPERCUSP_RELEASE_PRECHECK_ONLY:-0}" == "1" ]]; then
  echo "==> PRECHECK-ONLY: all preflight gates passed for version=$VERSION channel=$CHANNEL tag=$TAG"
  echo "    Stopping HERE — the next step writes package.json, src-tauri/Cargo.toml,"
  echo "    src-tauri/tauri.conf.json and src-tauri/Cargo.lock. Nothing has been modified."
  exit 0
fi

# ── Verification-harness contract (expensive-verification-loops P-006) ───────
# Everything above is this cut's own preflight: it fails in seconds and writes nothing, so it
# runs before the contract starts. From here the cut is expensive, so each section is a
# bracketed phase (bump → sidecar → gates → build → tag): an abort names the phase and step it
# died in, every cut keeps one evidence dir, and a HARNESS_RESULT line lands on stderr.
# Bracket mode keeps `set -e` exactly as it was; VH_FAIL_OPEN means instrumentation that cannot
# start never blocks a cut. cleanup_release_local finalizes it via vh_exit.
VH_SH="$ROOT/../libs/generic/verification-harness/bin/vh.sh"
if [[ -f "$VH_SH" ]]; then
  # shellcheck source=../../libs/generic/verification-harness/bin/vh.sh
  source "$VH_SH"
  VH_LOG_FD="${VH_LOG_FD:-2}"
  VH_FAIL_OPEN="${VH_FAIL_OPEN:-1}"
  vh_phase bump ""
  vh_phase sidecar bump
  vh_phase gates sidecar
  vh_phase build gates
  vh_phase tag build
  vh_init release-local "${PAPERCUSP_RELEASE_EVIDENCE_ROOT:-$(vh_default_root release-local)}"
  vh_begin bump
else
  echo "VH_DISABLED harness=release-local reason=vh.sh-missing:$VH_SH" >&2
  vh_begin() { :; }; vh_step() { :; }
fi

# The task-ledger intent is the managed cut's first mutation boundary.  It runs
# only after every precheck (and after PRECHECK_ONLY returned), but before the
# cut-start decision and the first release-tree write.  A restart therefore has
# an authoritative spent request to reconcile even if the shell dies during the
# version/seed/build sequence below.
papercusp_export_rust_path_remap
PAPERCUSP_LINUX_RUSTFLAGS="$(papercusp_rustflags_with_lld linux "${RUSTFLAGS:-}")"
release_task_leg_start linux || exit $?
# The Windows receipt opens at the same mutation boundary, but only for a cut that
# actually builds Windows — minting release.build.windows for a Linux-only cut would
# leave a receipt no leg can ever settle. Note the ordering consequence: the rootfs
# and ISCC preflights above are keyed on PAPERCUSP_REUSE_WIN, which the journal may
# only set HERE, so a journal-driven Windows resume still pays those (seconds) and
# fails closed if the wine/Inno toolchain is gone. That is deliberate — the intent
# boundary must stay after every precheck.
if [[ "$WITH_WINDOWS" == "1" ]]; then
  release_task_leg_start windows || exit $?
fi
# The mac receipt opens at the same boundary, under the same rule: only a cut that
# actually builds mac may mint release.build.mac, or a mac-less cut would leave a
# receipt no leg can settle.
if [[ "$WITH_MAC" == "1" ]]; then
  release_task_leg_start mac || exit $?
fi

# EI-20551860898590077: bind every artifact to THIS cut before the first tree
# write. A failed cut may leave correctly named/signed same-version bytes behind;
# publishers compare each artifact mtime to this tag-scoped stamp and refuse any
# byte that predates it. Keep the stamp for upload and incremental hand-offs.
#
# EI-21027458250695727: a SAME-VERSION salvage must preserve the original cut
# boundary. Replacing it here would make every deliberately reused artifact
# predate the new stamp, so upload-release would correctly reject the whole set
# as stale. `ensure` validates/preserves an existing stamp and creates one only
# when a direct producer had none; an all-fresh cut still writes a new boundary.
if [[ "${PAPERCUSP_REUSE_LINUX:-0}" == "1" || "${PAPERCUSP_REUSE_WIN:-0}" == "1" || "${PAPERCUSP_REUSE_MAC:-0}" == "1" ]]; then
  PAPERCUSP_RELEASE_CUT_START_NS="$(release_artifacts_cut_start_ensure "$TAG")"
  echo "==> release artifact freshness: preserving original cut-start for same-version reuse"
else
  PAPERCUSP_RELEASE_CUT_START_NS="$(release_artifacts_cut_start_write "$TAG")"
fi
export PAPERCUSP_RELEASE_CUT_START_NS
export PAPERCUSP_RELEASE_TAG="$TAG"
# Bound this cut's retention lease. release_artifacts_retention_lease_acquire
# documents exactly two ways to keep a lease from becoming permanent -- a TTL, or
# an explicit release -- and the release workflow used NEITHER, so every cut wrote
# expires_ns=0 and pinned its target slot forever. Measured 2026-09-22:
# lease-desktop-v0.0.19-alpha.tsv had held the whole dev2 slot since 2026-09-07,
# and because its tag is foreign to any later cut the (correctly) tag-aware slot
# picker refuses it permanently -- pushing each new cut toward the private per-pid
# cold-build fallback that accumulated ~99GB of orphaned slots (WI-10002441).
#
# A TTL is the fail-safe half of that contract: too long only delays reclaim, it
# never deletes early. Seven days is far beyond any build->upload->verify cycle
# (hours) while guaranteeing no slot is pinned indefinitely. An explicit override
# is honoured, so a workflow needing a longer window can still set one.
export PAPERCUSP_RELEASE_RETENTION_TTL_SEC="${PAPERCUSP_RELEASE_RETENTION_TTL_SEC:-604800}"
echo "==> release artifact freshness: cut-start=$PAPERCUSP_RELEASE_CUT_START_NS (tag=$TAG)"

# Write the release version into ONE checkout's manifests.
#   $1 = checkout root
#   $2 = "with-lock" to ALSO rewrite src-tauri/Cargo.lock's own package entry.
#
# Factored out of the single inline bump so the canonical writeback below gets
# byte-identical treatment to the cut worktree. Keep it that way: release:cut's
# reuseSeed residue validator (expectedVersionFile / RELEASE_RESUME_VERSION_PATHS
# in packages/operator-core/lib/agent-tools/release/cut.ts) re-derives these exact
# rewrites to decide whether a dirty root is cutter-owned, so a divergence here
# makes every retry refuse the root it is meant to resume.
#
# ⚠ The worktree call deliberately does NOT pass with-lock: cargo regenerates the
# lock during the build, and RELEASE_RESUME_VERSION_PATHS lists only the three
# paths below as cutter-owned dirt — writing a fourth would make that validator
# report "non-cutter path: src-tauri/Cargo.lock" and refuse the resume. The
# canonical call DOES pass it, because nothing regenerates the lock over there.
bump_version_manifests() {
  python3 - "$VERSION" "$1" "${2:-}" <<'PY'
import json, sys, re, pathlib
version, root = sys.argv[1], pathlib.Path(sys.argv[2])
with_lock = len(sys.argv) > 3 and sys.argv[3] == "with-lock"

pkg = root / "package.json"
if pkg.exists():
    d = json.loads(pkg.read_text())
    d["version"] = version
    pkg.write_text(json.dumps(d, indent=2) + "\n")
    print(f"  package.json → {version}")

tauri_conf = root / "src-tauri" / "tauri.conf.json"
d = json.loads(tauri_conf.read_text())
d["version"] = version
tauri_conf.write_text(json.dumps(d, indent=2) + "\n")
print(f"  tauri.conf.json → {version}")

cargo = root / "src-tauri" / "Cargo.toml"
text = cargo.read_text()
text = re.sub(r'(?m)^version = "[^"]+"', f'version = "{version}"', text, count=1)
cargo.write_text(text)
print(f"  Cargo.toml → {version}")

if with_lock:
    lock = root / "src-tauri" / "Cargo.lock"
    if lock.exists():
        text = lock.read_text()
        # Anchor on the package NAME so a dependency that merely shares a version
        # string is never touched. Requiring exactly one hit is the point: a 0 means
        # the lock format moved under us and the bump silently did nothing.
        pattern = re.compile(
            r'(?m)^(\[\[package\]\]\nname = "papercusp-desktop"\nversion = )"[^"]+"'
        )
        new_text, n = pattern.subn(lambda m: f'{m.group(1)}"{version}"', text)
        if n != 1:
            print(
                f"  !! Cargo.lock: expected exactly 1 papercusp-desktop package entry, found {n}",
                file=sys.stderr,
            )
            sys.exit(3)
        lock.write_text(new_text)
        print(f"  Cargo.lock → {version}")
PY
}

echo "==> bumping version in manifests"
bump_version_manifests "$ROOT"

# ── Dogfood version pin (clone-progress + version-pin) ──────────────────────
# The shipped app clones the `papercusp` dogfood hive from the MONOREPO
# (github.com/Papercusp/papercup) on first boot. Pin that clone to THIS build's
# commit so the dogfooded source matches the binary exactly (without it, a fresh
# install clones whatever `main` is NOW — drift). We:
#   1. verify the monorepo superproject ($ROOT/.. — papercusp-desktop is a
#      submodule of it) already has the SAME release tag on origin at the exact
#      expected source SHA, aligning only the LOCAL ref when needed, and
#   2. export PAPERCUP_DOGFOOD_REPO_REF=$TAG so build-desktop-sidecar.sh bakes it
#      into the sidecar (esbuild --define). bootstrap-papercusp-hive reads it.
# Fail-closed: LOCAL-only cuts never mutate origin. A missing/mismatched remote
# pin is a precondition failure, not an invitation for the cutter to force-push.
if git -C "$MONOREPO" rev-parse --git-dir >/dev/null 2>&1; then
  export PAPERCUP_DOGFOOD_REPO_REF="$TAG"
  echo "==> dogfood pin: verifying $TAG at expected source ${EXPECTED_SOURCE_SHA:0:12}"
  # Certify against PAPERCUP_DOGFOOD_CANONICAL_REMOTE (set by the read-only
  # precondition above the PRECHECK-ONLY exit), not the inherited origin.
  release_tag_prepare_local_exact "$MONOREPO" "$TAG" "$EXPECTED_SOURCE_SHA" "$PAPERCUP_DOGFOOD_CANONICAL_REMOTE"
else
  echo "ERROR: dogfood pin: $MONOREPO is not a git repo; refusing an unpinned release" >&2
  exit 1
fi

# P-003 clause 3 (D-008). The fallback's two DECISIONS, split out as pure
# predicates over (rc, sparse-requested, cut log). The cut itself shells out to
# `npx tsx` inside a subshell, so logic left inline with it is reachable only by
# running a real seed cut — which is why the sibling's fallback has never had a
# test. These are the parts worth testing, and they are testable in isolation.
release_seed_sparse_refused() { # <rc> <sparse-arg-count> <cut-log>
  [[ "${1:-0}" -ne 0 && "${2:-0}" -gt 0 ]] || return 1
  grep -q -- '--sparse requires a fresh head snapshot' "${3:-/dev/null}"
}

# --no-force-backfill ONLY when the refused attempt proves its refresh completed.
# Re-enqueueing the whole corpus otherwise would recreate the concurrent-cut
# incident this recovery exists to handle; forcing it when refresh did NOT
# complete is the safe default, so silence here means "force-backfill".
release_seed_fallback_args() { # <cut-log> — prints the extra args, or nothing
  grep -Eq '\[cut-seed\] refreshed (corestore source|via the live operator)' "${1:-/dev/null}" \
    && printf '%s\n' --no-force-backfill
  return 0
}

release_seed_cut_is_quiesced() {
  local runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  [[ -f "$runtime_dir/papercusp-seed-cut.quiesce" ]] && return 0
  local unit="${SEED_CUT_BG_HOST_UNIT:-papercusp-bg-host.service}"
  local state
  state="$(systemctl --user is-enabled "$unit" 2>/dev/null || true)"
  [[ "$state" == "masked" || "$state" == "masked-runtime" ]]
}

cut_release_seed() {
  if [[ "${PAPERCUSP_SKIP_SEED_CUT:-0}" == "1" ]]; then
    echo "==> seed: PAPERCUSP_SKIP_SEED_CUT=1 — leaving src-tauri/seed as-is"
    return 0
  fi
  # Owner directive 2026-07-07 (supersedes WI-2903 option A's full-history
  # default): release seeds ship DEPTH-1 — a one-commit snapshot of --rev, not
  # the ~1.75GiB full-history bundle. Full history stays on GitHub; first-boot
  # fetch back-fills it from origin when online. Escape hatch: export
  # PAPERCUSP_SEED_DEPTH= (empty) forces full history; git-only stays opt-in
  # via PAPERCUSP_SEED_CORESTORE=0. The cut runs HERE on the owner box —
  # cut-seed-cli refuses an epoch seal without the live hive keychain
  # (load-don't-mint) and refuses a missing corestore dir.
  local seed_hive="${PAPERCUSP_SEED_HIVE:-papercusp}"
  local seed_workspace="${PAPERCUSP_SEED_WORKSPACE_ID:-papercusp-workspace}"
  local seed_origin="${PAPERCUSP_SEED_ORIGIN:-https://github.com/Papercusp/papercup}"
  local seed_rev="${PAPERCUSP_SEED_REV:-HEAD}"
  local seed_depth="${PAPERCUSP_SEED_DEPTH-1}"
  local operator_dir="$MONOREPO/apps/operator"
  local seed_out="$ROOT/src-tauri/seed"
  if [[ ! -d "$operator_dir" ]]; then
    echo "ERROR: seed cutter not found at $operator_dir"
    echo "       Set PAPERCUSP_SKIP_SEED_CUT=1 only for a deliberate placeholder build."
    exit 1
  fi
  local core_args=()
  if [[ "${PAPERCUSP_SEED_CORESTORE:-1}" != "1" ]]; then
    core_args+=(--no-corestore)
  fi
  if [[ -n "${PAPERCUSP_SEED_STORE_DIR:-}" ]]; then
    core_args+=(--store-dir "$PAPERCUSP_SEED_STORE_DIR")
  fi
  # EI-17143: this path ran HERE on the shared dev box (the same box the whole
  # fleet lives on) and, unlike mac-vm-build.sh, had NO --reuse-corestore escape
  # hatch at all — it ALWAYS cut a fresh corestore, so it ALWAYS hit
  # cut-seed-cli's waitForOperatorDrain hard-fail on a busy box (live-hit
  # 2026-07-19: a 64-agent fleet's outbox sat at ~15,217 rows with zero drain
  # progress for 120s). Mirrors mac-vm-build.sh's fix + ensure-release-seed.sh's
  # WI-3346 "auto" mode: reuse the committed corestore snapshot when one exists
  # (safe, non-mutating, never fd-locks/waits on the live operator) and only
  # attempt a fresh from-live-store snapshot when there's nothing committed to
  # reuse yet. A deliberate up-to-date FULL refresh (current hive state baked
  # in) is still available — force it with PAPERCUSP_SEED_REUSE_CORESTORE=0 on
  # a quiesced box.
  local seed_reuse="${PAPERCUSP_SEED_REUSE_CORESTORE:-auto}"
  # WI-10003231: src-tauri/seed is gitignored and setup-release-checkout.sh
  # re-extracts this submodule from git on every fire, so an isolated cut root
  # (the managed nightly, a relcut) NEVER holds a snapshot to auto-reuse. It then
  # fell to the fresh-from-live-store branch below, which demands a quiesced
  # operator a managed cut never has. Hydrate from the persistent snapshot store
  # first. Copy rather than hardlink: the reuse cut writes into $seed_out. An
  # empty PAPERCUSP_SEED_SNAPSHOT_DIR disables hydration.
  local seed_snapshot="${PAPERCUSP_SEED_SNAPSHOT_DIR-$HOME/.papercusp/release-seeds/current}"
  if [[ "$seed_reuse" == "auto" && -n "$seed_snapshot" && ! -d "$seed_out/corestore" \
        && -d "$seed_snapshot/corestore" && -f "$seed_snapshot/manifest.json" ]]; then
    echo "==> seed: hydrating $seed_out from snapshot store $seed_snapshot (WI-10003231)"
    local seed_tmp="$seed_out.hydrate.$$"
    rm -rf "$seed_tmp"
    mkdir -p "$seed_tmp"
    if ! cp -a --reflink=auto "$seed_snapshot/." "$seed_tmp/"; then
      rm -rf "$seed_tmp"
      echo "ERROR: could not hydrate the release seed from $seed_snapshot" >&2
      return 1
    fi
    rm -rf "$seed_out"
    mv "$seed_tmp" "$seed_out"
  fi
  if [[ "$seed_reuse" == "auto" ]]; then
    if [[ -d "$seed_out/corestore" && -f "$seed_out/manifest.json" ]]; then
      seed_reuse=1
      echo "==> seed: corestore auto-reuse (committed snapshot present) — refreshing git+epoch-keys only; avoids the live-operator fd-lock/outbox-drain hard-fail on a busy box (EI-17143)"
    else
      seed_reuse=0
      echo "==> seed: no committed corestore to reuse — cutting FRESH from the live store (requires a quiesced operator)"
    fi
  fi
  if [[ "$seed_reuse" == "1" ]]; then
    core_args+=(--reuse-corestore "$seed_out")
    [[ -n "${PAPERCUSP_SEED_STORE_DIR:-}" ]] && echo "WARN: PAPERCUSP_SEED_STORE_DIR ignored under seed-reuse (PAPERCUSP_SEED_REUSE_CORESTORE=$seed_reuse)" >&2
  fi
  if [[ "${PAPERCUSP_SEED_CORESTORE:-1}" == "1" && "$seed_reuse" != "1" ]] \
      && ! release_seed_cut_is_quiesced; then
    echo "ERROR: fresh release seed cut requires a quiesced operator; run bin/cut-seed-quiesced.sh." >&2
    return 1
  fi
  # Offline dogfood restores need the bundled epoch keys too. Keep parity with
  # mac-vm-build.sh; opt out only for diagnostic cuts.
  local emit_args=()
  [[ "${PAPERCUSP_SEED_EMIT_EPOCH_KEY:-1}" == "1" ]] && emit_args+=(--emit-epoch-key)
  # P-004 trim: --sparse ships only the head-snapshot span (~40MB vs ~2.1GB) of a
  # FRESH corestore cut. Gated off under seed-reuse (a grafted corestore ships
  # as-cut, preserving its coreSparseFrom) — cut-seed-cli THROWS if --sparse meets
  # --reuse-corestore/--no-corestore. Default-ON; PAPERCUSP_SEED_SPARSE=0 forces
  # full history on a fresh cut.
  local sparse_args=()
  [[ "${PAPERCUSP_SEED_CORESTORE:-1}" == "1" && "$seed_reuse" != "1" && "${PAPERCUSP_SEED_SPARSE:-1}" == "1" ]] && sparse_args+=(--sparse)
  local depth_args=()
  if [[ -n "$seed_depth" ]]; then
    depth_args+=(--depth "$seed_depth")
  fi
  echo "==> cutting installer seed (hive=$seed_hive rev=$seed_rev depth=${seed_depth:-full} corestore=${PAPERCUSP_SEED_CORESTORE:-1} reuse=$seed_reuse sparse=$([[ ${#sparse_args[@]} -gt 0 ]] && echo 1 || echo 0))"
  # ── P-003 clause 3 (D-008): the sparse-to-full fallback ──────────────────────
  # PORTED from ensure-release-seed.sh:230-297 (P-014 / D-012), which has carried
  # this recovery since the 2026-07-21 release shipped 461,475 blocks / 1.9 GB
  # labelled sparse. This script kept its own duplicate of the cut and never got
  # the fallback, so a `--sparse` refusal aborted the whole release cut here while
  # the sibling recovered from it.
  #
  # NOT converged onto that script (revising D-008's preference on measurement):
  # ensure-release-seed.sh EXITS 0 on a failed cut and will ship seedless
  # (:299-310). That tolerance is right for a dev bundle and wrong for a release,
  # so calling it would quietly widen what a release cut may publish. The cut
  # becomes a FUNCTION for the same reason the sibling did — so the fallback can
  # re-run it verbatim with a different flag set.
  local cut_log cut_rc fallback_args errexit_was
  cut_log="$(mktemp -t papercusp-release-seed-cut-XXXXXX.log)"
  run_seed_cut() { # <extra cut-seed-cli args...>
  (
    cd "$operator_dir"
    OPATH="$PATH"
    set -a
    [[ -f ./.env.local ]] && . ./.env.local
    set +a
    export PATH="$OPATH:$PATH"
    # rc=134 'Ineffective mark-compacts near heap limit' at the default ~4GB V8 heap —
    # 0.0.19 cut #2 died 81% through the filtered-source-scan on a 252GB box. cut-seed-cli.ts
    # spawns with inherited env, so this reaches the bwrap re-exec. Mirrors
    # cut-seed-quiesced.sh:100; a NODE_OPTIONS from the .env.local sourced above still wins.
    export NODE_OPTIONS="${NODE_OPTIONS:-${SEED_CUT_NODE_OPTIONS:---max-old-space-size=24576}}"
    PAPERCUSP_ALLOW_DEV_RESTART=1 PAPERCUSP_WORKSPACE_ROOT="$MONOREPO" \
      npx tsx lib/release/cut-seed-cli.ts \
        --out "$seed_out" \
        --repo "$MONOREPO" \
        --origin "$seed_origin" \
        --workspace-id "$seed_workspace" \
        --hive "$seed_hive" \
        --rev "$seed_rev" \
        "${depth_args[@]}" \
        "${core_args[@]}" \
        "${emit_args[@]}" \
        "$@"
  ) 2>&1 | tee -a "$cut_log"
  }
  # errexit off ONLY across the attempts — a refused sparse cut is a state this
  # function RECOVERS from, not a reason to abort the release. Restored before
  # returning, or every later stage of the cut would silently lose errexit.
  # `pipefail` deliberately stays ON, so $? after the tee pipeline is the CLI's
  # exit code rather than tee's (the same property ensure-release-seed.sh relies on).
  errexit_was=0
  [[ $- == *e* ]] && errexit_was=1
  set +e
  run_seed_cut "${sparse_args[@]}"
  cut_rc=$?

  # cut-seed-cli REFUSES --sparse when it cannot append a fresh head __snapshot__
  # (only a writable/quiesced open can). Before that refusal existed the cut
  # "succeeded" and silently shipped the FULL core. Retry ONCE as a full cut: the
  # release still gets a CURRENT, honestly-labelled seed, and the size cost is
  # stated out loud with its remedy instead of hidden behind a warn.
  if release_seed_sparse_refused "$cut_rc" "${#sparse_args[@]}" "$cut_log"; then
    echo "WARN: SPARSE CUT REFUSED — the live operator holds the store, so no fresh head" >&2
    echo "WARN: snapshot could be appended, and a sparse cut without one silently ships the FULL core." >&2
    echo "WARN: retrying as a FULL cut: the bundle will carry the ENTIRE own-log history (~2GB)." >&2
    echo "WARN: to ship a genuinely sparse seed, quiesce the operator on this box and re-run." >&2
    # The refused attempt may already have completed the expensive refresh/drain
    # before the sparse-only step refused. Re-enqueueing the whole corpus would
    # recreate the concurrent-cut incident this recovery exists to handle — so
    # resume without force-backfill ONLY when the log proves refresh completed.
    mapfile -t fallback_args < <(release_seed_fallback_args "$cut_log")
    if [[ ${#fallback_args[@]} -gt 0 ]]; then
      echo "WARN: first sparse attempt completed refresh; full fallback will use --no-force-backfill." >&2
    else
      echo "WARN: first sparse attempt did not log refresh completion; full fallback will force-backfill." >&2
    fi
    run_seed_cut "${fallback_args[@]}"
    cut_rc=$?
  fi
  (( errexit_was )) && set -e
  rm -f "$cut_log"
  # Unlike the dev-bundle sibling, a release that cannot cut a seed FAILS. It
  # never silently falls back to the stale committed seed or ships seedless.
  if [[ "$cut_rc" -ne 0 ]]; then
    echo "ERROR: installer seed cut failed (rc=$cut_rc); refusing to continue the release cut." >&2
    return 1
  fi
}

cut_release_seed

# Belt-and-braces (0.0.11 cut r3, WI-4736): cut-seed-cli now prunes RocksDB's
# info log at cut time, but a reused/as-is seed (PAPERCUSP_SKIP_SEED_CUT=1) or a
# later store re-open can regenerate it — and `LOG` embeds the build box's
# hostname + absolute paths, which reds the AppDir identity gate. Exact names
# only: the numbered <NNN>.log WALs are data and must survive.
if [[ -d "$ROOT/src-tauri/seed/corestore/db" ]]; then
  rm -f "$ROOT/src-tauri/seed/corestore/db/LOG" "$ROOT/src-tauri/seed/corestore/db"/LOG.old* 2>/dev/null || true
fi

# ── P-006 (desktop-build-hardening-tri-platform-2026-07-11), per D-005 ────────
# The release cut is the VICTIM of host load, not its cause: WI-3792's 05:20Z
# 0.0.7 death was runaway staging hono-hosts + the Gemma ONNX all-core spin
# STARVING the win VM mid-build, not the build overloading the box. So the fix is
# protect + be polite, NOT throttle the victim:
#   (1) POLITE LOCAL LEG — the local Linux cargo/tauri compile spins all cores and
#       runs CONCURRENTLY with the windows+mac VM builds on the SAME host (see the
#       parallel-legs comment below), so an un-niced local leg can starve its own
#       sibling qemu VM legs (the 05:20Z failure, self-inflicted). Wrap every local
#       CPU-heavy step (sidecar esbuild + the tauri compiles) with nice + ionice so
#       it yields to the CPUWeight-protected critical services and the qemu VM host
#       processes — that lowered relative priority is what "protect the build FROM
#       contention" (D-005) means here: the VM legs get scheduled ahead of the
#       local compile. Disable with PAPERCUSP_RELEASE_NICE=0.
#   (2) NO SHORT-COMMAND SLOT / NEVER DENIED — export PC_HEAVY_BYPASS=1 so that if
#       this cut is ever launched under scripts/pc-heavy.sh (or spawns a hooked
#       heavy child), the WI-3821 admission gate never REFUSES a step when the box
#       is loaded (a load spike must not kill a cut) and the ~35-min VM builds
#       never sit in / hold a pc-heavy admission slot tuned for short tsc/vitest
#       (D-005: give long builds a dedicated lane OR exempt them — exemption IS the
#       lane). The gate keeps throttling the actual CAUSES (other agents' raw
#       vitest/tsc/build); it just never throttles this victim.
export PC_HEAVY_BYPASS=1
# WI-4781 (build-box-identity hygiene, cosmetic — not a security fix; parity
# with mac-vm-build.sh's identical export): without --remap-path-prefix, Rust
# DEPENDENCY source-paths embed this build box's $HOME (e.g.
# /home/<build-user>/.cargo/registry/src/…/<crate>/src/*.rs) in shipped
# binaries' panic/debug strings. Non-sensitive (no credentials) but worth
# stripping. Exported before the sidecar build + every local `tauri build`
# call below; a plain `export` also reaches build-appimage.sh, which this
# script invokes as a child process later. A RUSTFLAGS change busts the cargo
# incremental cache once — expected, not a regression. Cargo suppresses the
# config.toml LLD flag whenever this environment is present, so compute a
# Linux-native value below and apply it only to Linux cargo calls. Exporting it
# globally would also feed `-fuse-ld=lld` to the wasm32 sidecar linker.
# The matching helper was sourced from ORCHESTRATOR_HERE during startup; do not
# re-resolve it through target-tree HERE here.
papercusp_export_rust_path_remap
PAPERCUSP_LINUX_RUSTFLAGS="$(papercusp_rustflags_with_lld linux "${RUSTFLAGS:-}")"
# WI-5083 (desktop-build-speed-2026-07-16#P-004): RUSTC_WRAPPER=sccache backed
# by a persistent ~/.cache/sccache, exported HERE (before the Linux leg forks
# below + the optional arm64 cross-compile section) so both inherit it via
# plain process-env inheritance — no ssh boundary to cross for either. The
# mac/windows VM legs DO cross an ssh boundary (env does not travel over ssh,
# see the PAPERCUSP_RELEASE_HOST notes throughout this file) so they set up
# their own sccache env remotely: mac-vm-build.sh sources this same lib;
# build-windows-on-vm.sh carries a PowerShell-native equivalent
# (Ensure-Sccache) in its generated build script. Best-effort throughout —
# see lib/sccache.sh.
# shellcheck source=lib/sccache.sh
source "$ORCHESTRATOR_HERE/lib/sccache.sh"
setup_sccache_env "30G"
PC_NICE=()
if [[ "${PAPERCUSP_RELEASE_NICE:-1}" != "0" ]]; then
  command -v nice   >/dev/null 2>&1 && PC_NICE=(nice -n "${PAPERCUSP_RELEASE_NICE_ADJ:-10}")
  command -v ionice >/dev/null 2>&1 && PC_NICE=(ionice -c2 -n "${PAPERCUSP_RELEASE_IONICE:-7}" "${PC_NICE[@]}")
fi
[[ ${#PC_NICE[@]} -gt 0 ]] && echo "==> local build legs run niced (P-006): ${PC_NICE[*]}"

vh_begin sidecar
echo "==> building sidecar"
# P-004 (desktop-build-hardening-tri-platform-2026-07-11): record the cut-start
# epoch BEFORE the sidecar build so the freshness stamp it writes is guaranteed
# >= this — the Windows leg's guard then proves the packed serve.mjs was rebuilt
# for THIS cut, not a stale leftover.
export PAPERCUSP_SIDECAR_MIN_EPOCH_SEC="$(date +%s)"
# WI-4419 follow-up: this is a RELEASE build, so arm build-desktop-sidecar.sh's
# unconditional identity-scan of the assembled sidecar (the ultimate backstop the
# source.tar.zst audit structurally cannot be — it never sees the sidecar's
# docs-qa copies). Prune runs regardless; this flag makes the scan a HARD gate.
export PAPERCUSP_RELEASE_AUDIT=1
# D-186 / EI-21904084277182116: a release cut never consumes the immutable
# dependency generation produced by npm-install-safe. build-desktop-sidecar.sh
# defaults to the source-rich dogfood profile here, so its vm-release branch
# cannot supply this invariant for us. Declare it at the release orchestrator
# before invoking the target-tree producer — especially important for an
# exact-source retry, where $ROOT names the frozen target while this current
# orchestration owns the retry policy. Keep an explicit opt-in available for a
# diagnostic cut that genuinely needs to exercise generation publication.
export PAPERCUSP_SKIP_DEP_GENERATION="${PAPERCUSP_SKIP_DEP_GENERATION:-1}"
# The sidecar packages the superproject, while the installer provenance above
# names the desktop submodule. Keep the sidecar's cut-start identity in the
# same repository as its source-drift check; BUILD_SHA stays the desktop label.
PAPERCUSP_SIDECAR_BUILD_LOCK_WAIT_SEC="${PAPERCUSP_SIDECAR_BUILD_LOCK_WAIT_SEC:-3600}" \
PAPERCUSP_SIDECAR_MIN_FREE_GB=0 \
PROVENANCE_SOURCE_GIT_HEAD="$EXPECTED_SOURCE_SHA" \
PAPERCUSP_DESKTOP_TARGET_ROOT="$ROOT" \
"${PC_NICE[@]}" bash "$ORCHESTRATOR_HERE/build-desktop-sidecar.sh"
papercusp_release_disk_reservation
# P-004: the exact sha of the serve.mjs we just built — exported so every leg's
# packer asserts it packs THIS byte-identical sidecar (fail-closed on a
# concurrent rebuild swapping it mid-cut). Doubles as a self-check that the
# sidecar build actually produced a serve.mjs.
PAPERCUSP_EXPECTED_SERVE_SHA="$(sha256sum "$ROOT/src-tauri/sidecar/serve.mjs" 2>/dev/null | cut -d' ' -f1)"
if [[ -z "$PAPERCUSP_EXPECTED_SERVE_SHA" ]]; then
  echo "ERROR: sidecar build did not produce src-tauri/sidecar/serve.mjs — cannot proceed"; exit 1
fi
export PAPERCUSP_EXPECTED_SERVE_SHA
echo "==> sidecar freshness (P-004): serve.mjs sha=${PAPERCUSP_EXPECTED_SERVE_SHA:0:12}… cut-epoch=$PAPERCUSP_SIDECAR_MIN_EPOCH_SEC"

# WI-3287 / env-switcher-packaged-all-platforms-2026-07-06: stage the bundled
# env-sidecars/staging bundle inside sidecar/ so the existing `sidecar/**/*`
# resources glob ships it — see bin/stage-env-sidecars.sh for the contract.
bash "$ROOT/bin/stage-env-sidecars.sh"

# WI-3308 / same plan: the "all-5-buttons" dogfood bundle — stage a PRE-installed
# runnable monorepo tree as sidecar/source.tar.zst so the dev(:3270)/local(:3055)
# env buttons run from SOURCE on an install (no npm/npx needed; the bundled node
# runs the tree's own tsx/vite). DEFAULT-ON since VM-verified end-to-end on Linux
# (WI-3308, 2026-07-07); opt out with PAPERCUSP_STAGE_SOURCE=0 for a smaller build.
bash "$ROOT/bin/stage-source-tree.sh"

# ── IDENTITY-LITERAL LINT GATE (WI-4776) — fail in SECONDS, not after a build ──
# stage-source-tree.sh already runs audit-release-bundle.py against the just-tarred
# source.tar.zst (fast-ish: catches it after the tar, not after a full cut), and
# build-desktop-sidecar.sh's --scan-dir runs even earlier against the assembled
# sidecar. Both are real gates, but every one of the FOUR observed 0.0.9 leaks
# (a `[owner:<name> …]` provenance tag or a stray box-identity literal in a hand-
# authored comment/doc) is something that can be caught on the TRACKED SOURCE
# ALONE, in seconds, before any staging/tar/build work happens at all. Run all
# three identity lints here, immediately, so a leaked literal reds the cut before
# stage-source-tree.sh's ~multi-minute tar+scan even starts — recurrence
# prevention for the class that has already killed multiple 0.0.9 cuts ~10min in.
#
# EI-18147177863084708: these three used to be `&&`-chained, so a run only ever
# showed the FIRST failing lint's leaks — the 0.0.12 Windows Server cut
# (2026-07-20, 24 leaks across 13 files) turned fixing them into whack-a-mole
# across multiple ~30min build attempts, one lint at a time. Run all three
# UNCONDITIONALLY (never short-circuited by the one before it) and report every
# leak across all three classes together. (These now ALSO run at every
# green-checkpoint tick — apps/operator/lib/release/green-checkpoint.ts — so a
# leak reds the tick it lands on `staging`, long before a release attempt; this
# gate stays as defense-in-depth for a cut running off a snapshot older than the
# latest green tick.)
vh_begin gates
echo "==> identity-literal lint gate (WI-4776): tracked source, before any staging work"
_MONO="$(cd "$ROOT/.." && pwd)"
_IDENTITY_LINT_STATUS=0
( cd "$_MONO" && node scripts/check-no-owner-name-tags.mjs ) || _IDENTITY_LINT_STATUS=1
( cd "$_MONO" && node scripts/check-no-box-identity.mjs ) || _IDENTITY_LINT_STATUS=1
( cd "$_MONO" && node scripts/check-no-identity-literals.mjs ) || _IDENTITY_LINT_STATUS=1
if [[ "$_IDENTITY_LINT_STATUS" != "0" ]]; then
  echo "ERROR: tracked source carries an owner-name / box-identity literal — refusing to stage a leaky cut (WI-4776). Fix every leak listed above (all 3 lints ran; see each lint's own FIX note)." >&2
  exit 1
fi

# ── ASSEMBLED-BUNDLE IDENTITY GATE (EI-20304355477263736) ─────────────────────
# WHY THIS IS NOT REDUNDANT WITH THE TWO SCANS ABOVE. build-desktop-sidecar.sh
# identity-scans the sidecar it assembles, but that scan cannot be the last word:
# `stage-env-sidecars.sh` and `stage-source-tree.sh` both write into
# src-tauri/sidecar AFTER it returns, so everything they add is structurally
# invisible to it. The 0.0.16-alpha attempt-5 cut log shows the size of that blind
# spot: the in-sidecar scan reported 10,635 file(s) / 0 archive(s) while the per-leg
# AppDir gate (bin/build-appimage.sh step 3d) reported 17,560 / 3 — the SAME scanner
# and the SAME rule, 40 minutes apart, judging two very different populations.
#
# That gap cost 0.0.16-alpha attempt 5 a whole cut: an owner handle in a RETIRED
# blueprint's YAML comment reached both sidecar/harness/** and
# sidecar/env-sidecars/staging/harness/**, and was caught by the per-leg gate
# ~40 MINUTES in, after four parallel Rust builds had already run.
#
# No scrub could have neutralised it first, and NOT for the extension reason it
# looks like: stage-source-tree.sh's scrub has no extension filter at all (it
# redacts whatever --source-leakers names, .yaml included) but only ever rewrites
# what goes INTO source.tar.zst, while --scrub-text's .md/.mdx/.html/.htm/.txt/
# .json suffix list applies only to the two doc trees build-desktop-sidecar.sh
# points it at (internal-docs, apps/operator-docs). NOTHING scrubs
# sidecar/harness/** or sidecar/env-sidecars/**. For those paths a SCAN is the
# only remedy — which is precisely why its position is the whole ballgame.
#
# ORDERING + SCOPE fix, not a new rule and not a weakening: same scanner, same
# literal set, same fail-closed semantics as the per-leg gate. Nothing that passes
# today starts failing — anything this catches would have been caught by the leg
# gate anyway, just after the builds. The leg gates stay exactly where they are and
# become a cheap idempotent re-assert.
#
# ⚠ INVARIANT: this must run AFTER every bin/stage-*.sh call (they write into the
# bundle) and BEFORE the first leg launches. Pinned by
# packages/operator-core/lib/release-identity-gate-ordering.test.ts — a new staging
# step added below this line reds that test instead of silently re-opening the gap.
# Both bundled resource roots, because `resources` in src-tauri/tauri.conf.json is
# exactly ["sidecar/**/*", "resources/*"] — scanning only the sidecar would leave a
# 5-file / 1-archive hole (resources/papercup-runtime.tar.gz IS the third archive
# the leg scan expands) and reproduce the unequal-scope defect in miniature.
# Measured 2026-08-13 by running this exact command: 17,559 file(s) / 3 archive(s)
# in 136s — ONE file off the per-leg AppDir gate's 17,560 / 3, for ~2 minutes
# against the ~40 minutes of builds it now front-runs.
echo "==> assembled-bundle identity gate (EI-20304355477263736): scanning the FULLY-staged bundle (scope-identical to the per-leg gate, ~40min earlier)"
if ! python3 "$ROOT/bin/audit-release-bundle.py" --scan-dir "$ROOT/src-tauri/sidecar" "$ROOT/src-tauri/resources"; then
  echo "ERROR: the fully-assembled bundle (sidecar + bundled resources) carries a sensitive/build-box identity — refusing to launch the platform legs (EI-20304355477263736)." >&2
  echo "       This is the SAME rule the per-leg AppDir/.app gate enforces; it now fires BEFORE ~40 minutes of Rust builds instead of after them." >&2
  echo "       Fix the leak at its SOURCE in the monorepo (not in src-tauri/sidecar — that is regenerated build output), then re-run the cut." >&2
  exit 1
fi

# ── ASSEMBLED-BUNDLE GITLEAKS GATE (EI-21546652106775901) ─────────────────────
# The Python audit above owns build-box/identity literals. Gitleaks is a
# supplementary credential detector: run it after every staging step, over the
# same two resource roots, with a release-local config whose generated-byte
# exceptions require BOTH a known path and a known line marker. Keep values
# fully redacted in release logs; a finding still fails the cut. The report is
# retained in a private run-scoped directory long enough to print only its
# non-secret locator fields on refusal.
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "ERROR: gitleaks is required for the assembled-bundle release gate (EI-21546652106775901)." >&2
  exit 1
fi
_GITLEAKS_REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/papercusp-release-gitleaks.XXXXXX")"
_GITLEAKS_STATUS=0
_GITLEAKS_FAILED_ROOTS=()
for _gitleaks_root in "src-tauri/sidecar" "src-tauri/resources"; do
  _gitleaks_report_path="$_GITLEAKS_REPORT_DIR/$(basename "$_gitleaks_root").json"
  if ! ( cd "$ROOT" && gitleaks dir "$_gitleaks_root" \
      --config "$ORCHESTRATOR_HERE/release-gitleaks.toml" \
      --no-banner --log-level=error --redact=100 \
      --report-format=json --report-path="$_gitleaks_report_path" ); then
    _GITLEAKS_STATUS=1
    _GITLEAKS_FAILED_ROOTS+=("$_gitleaks_root")
  fi
done
if [[ "$_GITLEAKS_STATUS" != "0" ]]; then
  echo "ERROR: gitleaks found an unallowlisted credential pattern in the fully-assembled bundle — refusing to launch the platform legs (EI-21546652106775901)." >&2
  echo "       Findings are redacted. Safe locator fields follow; fix the source or add a narrowly path+line-constrained allowlist only after verifying the bytes are public/generated." >&2
  for _gitleaks_root in "${_GITLEAKS_FAILED_ROOTS[@]}"; do
    _gitleaks_report_path="$_GITLEAKS_REPORT_DIR/$(basename "$_gitleaks_root").json"
    echo "       Scan root: $_gitleaks_root" >&2
    python3 "$ORCHESTRATOR_HERE/lib/print-gitleaks-findings.py" \
      "$_gitleaks_report_path" "$_gitleaks_root" >&2 \
      || echo "       Could not read the redacted gitleaks report; the gate remains failed." >&2
  done
  exit 1
fi

# ── BOOT GATE (desktop-release-0-0-8) — the sidecar must actually START ────────
# 0.0.9 shipped a sidecar that could not boot on ANY platform (sharp native
# missing from the closure copy). FIVE green cuts missed it, because a dev box
# falls back to a :3070 operator that no user has — so the failure is invisible
# exactly where we verify. This runs the JUST-STAGED serve.mjs with the bundled
# node in an isolated root (no ancestor node_modules to lend it a missing native)
# and FAILS THE CUT if it can't serve — BEFORE we spend ~30min on three platform
# builds that would pack a DOA sidecar. It validates the LINUX bundle (this build
# box); win/mac carry their own natives and are proven at install-time (the ARRIVES
# probe). Opt out only for a deliberate diagnostic cut: PAPERCUSP_SKIP_BOOT_GATE=1.
if [[ "${PAPERCUSP_SKIP_BOOT_GATE:-0}" != "1" ]]; then
  echo "==> boot gate: verifying the staged sidecar actually starts (pre-pack)"
  bash "$ROOT/bin/gate-sidecar-boots.sh" "$ROOT/src-tauri/sidecar" \
    || { echo "ERROR: staged sidecar failed the boot gate — refusing to pack a DOA bundle. See the boot log above."; exit 1; }
else
  echo "==> ⚠ boot gate SKIPPED (PAPERCUSP_SKIP_BOOT_GATE=1) — diagnostic cut only"
fi

vh_begin build
echo "==> building Tauri Linux x86_64 (signed)"
# Tauri v2 reads TAURI_SIGNING_PRIVATE_KEY (value = key content OR a path);
# the v1-style _PATH variant is silently ignored and the build dies at the
# updater-artifact signing step ("public key found, but no private key").
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$KEY_FILE"
else
  # An unconditional export here silently CLOBBERED a caller-supplied key, which is why
  # no launch-env workaround could rescue the dead 0.0.17 cut. Same contract as
  # build-and-archive-deb.sh:55-67, which was already right.
  echo "==> updater signing key: supplied via TAURI_SIGNING_PRIVATE_KEY"
fi
# Empty passphrase by default. If the user set one at keygen time
# they should `export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...` before
# running this script.
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# Resolve the claimed cargo output root before any build leg reads or writes it.
# claim-target-dir.sh exports CARGO_TARGET_DIR, and cargo metadata is the source
# of truth that maps that selection to the bundle tree for every target triple.
CARGO_TARGET_ROOT="$(cd "$ROOT/src-tauri" && cargo metadata --no-deps --format-version 1 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("target_directory",""))' 2>/dev/null)"
[[ -n "$CARGO_TARGET_ROOT" ]] || CARGO_TARGET_ROOT="$ROOT/src-tauri/target"

# Tauri CLI does the platform-native bundling + signing in one shot.
# Two-bundle split (ONE binary, two roles — see src-tauri/src/app_role.rs):
# GUI (base tauri.conf.json) + Server (tauri.server.conf.json override).
# Distinct productNames → distinct deb/appimage/rpm filenames; the version-
# scoped globs below pick up both. PAPERCUSP_BUILD_ROLES="gui" (or "server")
# builds just one.
# ── Build ALL THREE platforms CONCURRENTLY (owner request 2026-07-08): Linux is
# LOCAL (cargo → external ~/.cargo-target, does not mutate the source tree) while
# Windows + macOS build on their OWN QEMU VMs over SSH, so nothing contends. Each
# leg is a background subshell → its own log; we join all three below and collect
# artifacts in the PARENT (a subshell's `ARTIFACTS+=` would not survive the fork).
# ── P-005 (desktop-build-hardening-tri-platform-2026-07-11): verify the REUSE
# salvage path, don't just flag it ──────────────────────────────────────────
# PAPERCUSP_REUSE_LINUX/REUSE_MAC/REUSE_WIN skip a rebuild and ship artifacts SALVAGED from a
# prior cut — but they get re-labelled with THIS cut's version/sha (baked into
# the binary at its ORIGINAL build; the provenance emit only stamps reused:true).
# Salvaging a DIFFERENT version's bytes and shipping them as $VERSION is the
# LABELED!=PACKED lie. Reuse is only honest for a SAME-VERSION re-cut (e.g. a
# 0.0.7 cut that failed at a later step, reusing 0.0.7's already-built leg). So
# before trusting salvaged artifacts, read the prior cut's build-provenance.json
# (restored alongside them) and FAIL LOUD if its version != $VERSION, or if it's
# missing (then the true version is unknowable → unsafe to re-label). Run in the
# reuse blocks BELOW, before the late provenance emit overwrites the file.
# Overrides: PAPERCUSP_ALLOW_REUSE_UNVERIFIED=1 (no prior provenance) /
# PAPERCUSP_ALLOW_REUSE_VERSION_MISMATCH=1 (deliberate cross-version salvage).
_prov_version() {  # $1 = build-provenance.json path → prints the version string
  # `|| true` as on the two siblings below: `grep | head -1` under `set -o pipefail`
  # returns 141 when head exits first and SIGPIPEs grep, which `set -e` would turn into
  # an aborted release. Callers test the captured string for emptiness, not the status.
  grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"$/\1/' || true
}
_prov_string() {  # $1 = json path, $2 = top-level string field
  grep -oE '"'"$2"'"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"$/\1/' || true
}
_prov_bool() {  # $1 = json path, $2 = top-level boolean field
  grep -oE '"'"$2"'"[[:space:]]*:[[:space:]]*(true|false)' "$1" 2>/dev/null | head -1 | grep -oE '(true|false)$' || true
}
assert_reused_provenance() {  # $1 = artifact dir, $2 = leg label
  local dir="$1" leg="$2"
  local prov="$dir/build-provenance.json"
  if [[ "${PAPERCUSP_ALLOW_REUSE_UNVERIFIED:-0}" == "1" ]]; then
    echo "==> ⚠ PAPERCUSP_ALLOW_REUSE_UNVERIFIED=1 — skipping the $leg reuse-provenance verification (P-005)"
    case "$leg" in
      linux)
        LINUX_REUSE_BUILD_SHA="$BUILD_SHA"; LINUX_REUSE_GIT_HEAD="$PROVENANCE_SOURCE_GIT_HEAD"; LINUX_REUSE_GIT_DIRTY="$PROVENANCE_SOURCE_GIT_DIRTY" ;;
      windows)
        WINDOWS_REUSE_BUILD_SHA="$BUILD_SHA"; WINDOWS_REUSE_GIT_HEAD="$PROVENANCE_SOURCE_GIT_HEAD"; WINDOWS_REUSE_GIT_DIRTY="$PROVENANCE_SOURCE_GIT_DIRTY" ;;
      mac)
        MAC_REUSE_BUILD_SHA="$BUILD_SHA"; MAC_REUSE_GIT_HEAD="$PROVENANCE_SOURCE_GIT_HEAD"; MAC_REUSE_GIT_DIRTY="$PROVENANCE_SOURCE_GIT_DIRTY" ;;
      *) echo "ERROR: unknown reuse provenance leg '$leg'" >&2; exit 2 ;;
    esac
    return 0
  fi
  [[ -f "$prov" ]] || { echo "ERROR: REUSE_$leg but no prior build-provenance.json at $prov — the salvaged bytes' true version is unknown, so re-labelling them $VERSION would be a LABELED!=PACKED lie (P-005). Restore a cut that includes build-provenance.json, or override: PAPERCUSP_ALLOW_REUSE_UNVERIFIED=1."; exit 1; }
  local prior_ver; prior_ver="$(_prov_version "$prov")"
  [[ -n "$prior_ver" ]] || { echo "ERROR: could not read a version from $prov — refusing to reuse unverifiable salvaged $leg artifacts (P-005). Override: PAPERCUSP_ALLOW_REUSE_UNVERIFIED=1."; exit 1; }
  if [[ "$prior_ver" != "$VERSION" ]]; then
    if [[ "${PAPERCUSP_ALLOW_REUSE_VERSION_MISMATCH:-0}" == "1" ]]; then
      echo "==> ⚠ PAPERCUSP_ALLOW_REUSE_VERSION_MISMATCH=1 — proceeding despite $leg salvage version mismatch ($prior_ver != $VERSION)"
    else
      echo "ERROR: REUSE_$leg salvaged artifacts are version '$prior_ver' but this cut is '$VERSION' — refusing to re-label a DIFFERENT version's bytes as $VERSION (the silent-relabel P-005 kills). Rebuild the $leg leg for $VERSION, or (same-version re-cut only) override: PAPERCUSP_ALLOW_REUSE_VERSION_MISMATCH=1."
      exit 1
    fi
  else
    echo "==> ✓ REUSE_$leg provenance verified: salvaged version $prior_ver == cut $VERSION (P-005)"
  fi

  # A reused artifact keeps the identity baked into ITS bytes. Relabelling it
  # with this collector run's BUILD_SHA is LABELED!=PACKED even when the version
  # happens to match — and a post-cut collector often sees the cutter-authored
  # dirty tree. Preserve the prior source identity before the late emitter
  # replaces build-provenance.json.
  local prior_sha prior_head prior_dirty
  prior_sha="$(_prov_string "$prov" buildSha)"
  prior_head="$(_prov_string "$prov" gitHead)"
  prior_dirty="$(_prov_bool "$prov" gitDirty)"
  [[ -n "$prior_sha" && -n "$prior_head" && -n "$prior_dirty" ]] || {
    echo "ERROR: REUSE_$leg prior provenance lacks buildSha/gitHead/gitDirty — refusing to relabel unverifiable bytes (P-005). Rebuild the leg, or use PAPERCUSP_ALLOW_REUSE_UNVERIFIED=1 for a deliberate local-only bypass." >&2
    exit 1
  }
  case "$leg" in
    linux)
      LINUX_REUSE_BUILD_SHA="$prior_sha"; LINUX_REUSE_GIT_HEAD="$prior_head"; LINUX_REUSE_GIT_DIRTY="$prior_dirty" ;;
    windows)
      WINDOWS_REUSE_BUILD_SHA="$prior_sha"; WINDOWS_REUSE_GIT_HEAD="$prior_head"; WINDOWS_REUSE_GIT_DIRTY="$prior_dirty" ;;
    mac)
      MAC_REUSE_BUILD_SHA="$prior_sha"; MAC_REUSE_GIT_HEAD="$prior_head"; MAC_REUSE_GIT_DIRTY="$prior_dirty" ;;
    *) echo "ERROR: unknown reuse provenance leg '$leg'" >&2; exit 2 ;;
  esac
}

assert_linux_artifact_cardinality() {  # $1 = Linux bundle dir
  local dir="$1"
  local expected_appimages=0 expected_debs=0 appimages appimage_sigs debs deb_sigs role artifact
  local -a artifacts=()
  [[ " $PAPERCUSP_BUILD_ROLES " == *" gui "* ]] && expected_appimages=1
  for role in $PAPERCUSP_BUILD_ROLES; do
    case "$role" in gui|server) expected_debs=$((expected_debs + 1)) ;; esac
  done
  appimages="$(find "$dir/appimage" -maxdepth 1 -type f -name "*_${VERSION}_*.AppImage" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  appimage_sigs="$(find "$dir/appimage" -maxdepth 1 -type f -name "*_${VERSION}_*.AppImage.sig" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  debs="$(find "$dir/deb" -maxdepth 1 -type f -name "*_${VERSION}_*.deb" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  deb_sigs="$(find "$dir/deb" -maxdepth 1 -type f -name "*_${VERSION}_*.deb.sig" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  if [[ "$appimages" != "$expected_appimages" || "$appimage_sigs" != "$expected_appimages" \
        || "$debs" != "$expected_debs" || "$deb_sigs" != "$expected_debs" ]]; then
    echo "ERROR: Linux $VERSION bundle is ambiguous/incomplete for roles '$PAPERCUSP_BUILD_ROLES': expected appimages=$expected_appimages signatures=$expected_appimages debs=$expected_debs deb-signatures=$expected_debs; found appimages=$appimages signatures=$appimage_sigs debs=$debs deb-signatures=$deb_sigs. Quarantine stale/failed same-version bytes before collection (EI-21025181491857558)." >&2
    exit 1
  fi
  for artifact in "$dir"/appimage/*_"$VERSION"_*.AppImage "$dir"/appimage/*_"$VERSION"_*.AppImage.sig \
                  "$dir"/deb/*_"$VERSION"_*.deb "$dir"/deb/*_"$VERSION"_*.deb.sig; do
    [[ -f "$artifact" ]] && artifacts+=("$artifact")
  done
  if [[ ${#artifacts[@]} -gt 0 ]]; then
    release_artifacts_assert_fresh "$TAG" "${artifacts[@]}" || return $?
  fi
}

# The Windows sibling of the check above. It is reached only from the JOURNALLED
# path (release_task_verify_windows_artifacts); the unjournalled collection block
# keeps its historical "at least one artifact" gate, exactly as Linux's did before
# its receipt landed. This is the check verify-provenance.sh cannot stand in for:
# that script verifies the artifacts build-provenance.json NAMES, so a surplus
# installer left by another lane is invisible to it while the version-scoped
# collection glob would still sweep the bytes into the release.
assert_windows_artifact_cardinality() {  # $1 = inno output dir  # assert-integrity-ok: reached via dynamic dispatch "release_task_verify_${leg}_artifacts" (leg=windows, release_task_leg_prepare/commit)
  local dir="$1"
  local expected=0 setups setup_sigs role
  for role in $PAPERCUSP_BUILD_ROLES; do
    case "$role" in gui|server) expected=$((expected + 1)) ;; esac
  done
  setups="$(find "$dir" -maxdepth 1 -type f -name "*_${VERSION}_x64-setup.exe" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  setup_sigs="$(find "$dir" -maxdepth 1 -type f -name "*_${VERSION}_x64-setup.exe.sig" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  if [[ "$setups" != "$expected" || "$setup_sigs" != "$expected" ]]; then
    echo "ERROR: Windows $VERSION installer set is ambiguous/incomplete for roles '$PAPERCUSP_BUILD_ROLES': expected setups=$expected signatures=$expected; found setups=$setups signatures=$setup_sigs. Quarantine stale/failed same-version bytes in $dir before collection." >&2
    exit 1
  fi
}

# The mac sibling, reached only from the JOURNALLED path
# (release_task_verify_mac_artifacts); the unjournalled collection block keeps its
# historical "at least one artifact" gate plus the P-009 cross-count assertion.
# Note the .app.tar.gz counts are EXACT here rather than merely "not more than the
# dmgs": by the time a receipt is being verified the expected role set is known,
# so an unversioned bundle set that is short is just as disqualifying as one that
# is surplus — and verify-provenance.sh cannot see either, because it iterates the
# artifacts build-provenance.json NAMES and never enumerates the directory.
assert_mac_artifact_cardinality() {  # $1 = mac bundle dir ($MAC_OUT)  # assert-integrity-ok: reached via dynamic dispatch "release_task_verify_${leg}_artifacts" (leg=mac, release_task_leg_prepare/commit)
  local dir="$1"
  local expected=0 dmgs dmg_sigs tgzs tgz_sigs role
  for role in $PAPERCUSP_BUILD_ROLES; do
    case "$role" in gui|server) expected=$((expected + 1)) ;; esac
  done
  dmgs="$(find "$dir/dmg" -maxdepth 1 -type f -name "*_${VERSION}_*.dmg" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  dmg_sigs="$(find "$dir/dmg" -maxdepth 1 -type f -name "*_${VERSION}_*.dmg.sig" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  tgzs="$(find "$dir/macos" -maxdepth 1 -type f -name "*.app.tar.gz" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  tgz_sigs="$(find "$dir/macos" -maxdepth 1 -type f -name "*.app.tar.gz.sig" -printf x 2>/dev/null | wc -c | tr -d ' ')"
  if [[ "$dmgs" != "$expected" || "$dmg_sigs" != "$expected" \
        || "$tgzs" != "$expected" || "$tgz_sigs" != "$expected" ]]; then
    echo "ERROR: mac $VERSION artifact set is ambiguous/incomplete for roles '$PAPERCUSP_BUILD_ROLES': expected dmgs=$expected dmg-signatures=$expected updater-bundles=$expected updater-signatures=$expected; found dmgs=$dmgs dmg-signatures=$dmg_sigs updater-bundles=$tgzs updater-signatures=$tgz_sigs. The .app.tar.gz set is UNVERSIONED, so a stale one from a prior cut is indistinguishable by name — clean $dir/macos/ and re-cut, or use PAPERCUSP_REUSE_MAC=1 (provenance-verified salvage)." >&2
    exit 1
  fi
}

# A completed Linux child must leave its receipt alongside its final bytes,
# BEFORE a failed sibling can stop the parent collector (EI-22598852936937011).
# Reuse keeps the original baked identity; the shared emitter preserves its
# existing receipt history and verifies the reused bytes.
emit_linux_build_provenance() {
  local bundle="$CARGO_TARGET_ROOT/release/bundle"
  local sha="$BUILD_SHA" head="$PROVENANCE_SOURCE_GIT_HEAD" dirty="$PROVENANCE_SOURCE_GIT_DIRTY"
  local reused=false tc_rustc tc_node
  if [[ "$LINUX_REUSE" == "1" ]]; then
    sha="$LINUX_REUSE_BUILD_SHA"; head="$LINUX_REUSE_GIT_HEAD"; dirty="$LINUX_REUSE_GIT_DIRTY"
    reused=true
  fi
  tc_rustc="$(rustc --version 2>/dev/null | awk '{print $2}')"
  tc_node="$(node --version 2>/dev/null)"
  # Host == Linux builder. Hash primary installers only; .sig presence is
  # recorded per artifact, after repacking and final updater signing.
  PROVENANCE_TOOLCHAIN="$(printf '{ "rustc": "%s", "node": "%s", "tauriCli": "%s" }' "${tc_rustc:-unknown}" "${tc_node:-unknown}" "$TAURI_CLI_VERSION")" \
  PROVENANCE_SIDECAR_DIR="$ROOT/src-tauri/sidecar" \
  PROVENANCE_SOURCE_GIT_HEAD="$head" \
  PROVENANCE_SOURCE_GIT_DIRTY="$dirty" \
  PROVENANCE_GIT_ROOT="$ROOT" bash "$ROOT/bin/emit-build-provenance.sh" \
    "$bundle" "$VERSION" "$sha" "$reused" \
    "$bundle"/deb/*_"$VERSION"_*.deb "$bundle"/appimage/*_"$VERSION"_*.AppImage
}

LINUX_LEG_LOG="/tmp/papercusp-linuxleg-${TAG}.log"
LINUX_PID=""; LINUX_REUSE=0
if [[ "${RELEASE_TASK_JOURNAL_ENABLED:-0}" == "1" ]]; then
  release_task_leg_prepare linux "$CARGO_TARGET_ROOT/release/bundle" || exit $?
fi
if [[ "${PAPERCUSP_REUSE_LINUX:-0}" == "1" ]]; then
  # EI-21024313639787521: Linux is just as salvageable as Windows/macOS. A late
  # post-package gate must not force a multi-hour rebuild (or clobber repaired,
  # already-audited bytes) when this SAME version's artifacts and provenance are
  # present in the canonical bundle tree.
  LINUX_BUNDLE="$CARGO_TARGET_ROOT/release/bundle"
  echo "==> [reuse] PAPERCUSP_REUSE_LINUX=1 — skipping linux build; reusing artifacts in $LINUX_BUNDLE"
  linux_reuse_found=0
  for f in "$LINUX_BUNDLE"/deb/*_"$VERSION"_*.deb "$LINUX_BUNDLE"/deb/*_"$VERSION"_*.deb.sig \
           "$LINUX_BUNDLE"/appimage/*_"$VERSION"_*.AppImage "$LINUX_BUNDLE"/appimage/*_"$VERSION"_*.AppImage.sig; do
    [[ -f "$f" ]] && { echo "    reuse: $(basename "$f")"; linux_reuse_found=1; }
  done
  if [[ "$linux_reuse_found" != "1" ]]; then
    echo "ERROR: PAPERCUSP_REUSE_LINUX=1 but no $VERSION linux artifacts in $LINUX_BUNDLE — restore them there first"; exit 1
  fi
  assert_linux_artifact_cardinality "$LINUX_BUNDLE"
  # P-005: refuse to re-label a different version's salvaged linux bytes as $VERSION.
  assert_reused_provenance "$LINUX_BUNDLE" linux
  LINUX_REUSE=1
else
  echo "==> [parallel] launching Linux x86_64 build (local, log: $LINUX_LEG_LOG)"
  (
    set -euo pipefail
    PAPERCUSP_BUILD_ROLES="${PAPERCUSP_BUILD_ROLES:-gui server}"
    for role in $PAPERCUSP_BUILD_ROLES; do
      role_cfg=(); [[ "$role" == "server" ]] && role_cfg=(--config src-tauri/tauri.server.conf.json)
      # rpm DROPPED (2026-07-08): it is never collected (Linux ships deb+AppImage only —
      # see the collection globs) AND its multi-GB payload compression wedged the
      # 0.0.3-alpha linux leg for 33min+. deb only.
      echo "==> tauri build (linux x86_64, role=$role) — deb only (AppImage separate WI-2918; rpm not shipped)"
      (cd "$ROOT" && RUSTFLAGS="$PAPERCUSP_LINUX_RUSTFLAGS" PAPERCUSP_BUILD_SHA="$BUILD_SHA" PAPERCUSP_BUILD_VERSION="$VERSION" env "${DESKTOP_CHANNEL_BUILD_ENV[@]}" "${PC_NICE[@]}" npx --yes -p @tauri-apps/cli@"$TAURI_CLI_VERSION" tauri build --bundles deb "${role_cfg[@]}" "${DESKTOP_CHANNEL_BUILD_CFG[@]}")
    done
    # Repack BOTH role artifacts after Tauri finishes writing them. The helper
    # verifies the ar structure and dpkg readability, atomically replaces each
    # deb, and regenerates its updater signature over the final bytes.
    for deb in "$CARGO_TARGET_ROOT"/release/bundle/deb/*_"$VERSION"_*.deb; do
      [[ -f "$deb" ]] && PAPERCUSP_TAURI_CLI_VERSION="$TAURI_CLI_VERSION" bash "$ROOT/bin/repack-deb-xz.sh" "$deb"
    done
    # AppImage — built SEPARATELY (WI-2918): tauri's appimage target crashes linuxdeploy
    # on the sidecar tree; build-appimage.sh finishes with appimagetool (no ELF-scan).
    if [[ " $PAPERCUSP_BUILD_ROLES " == *" gui "* ]]; then
      echo "==> building Linux AppImage (gui, via bin/build-appimage.sh — linuxdeploy workaround)"
      APPIMAGE_PRODUCER="$ORCHESTRATOR_HERE/build-appimage.sh"
      (cd "$ROOT" && PAPERCUSP_BUILD_SHA="$BUILD_SHA" PAPERCUSP_BUILD_VERSION="$VERSION" \
         TAURI_SIGNING_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY:-$KEY_FILE}" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
         PAPERCUSP_RELEASE_CHANNEL="$CHANNEL" PAPERCUSP_DESKTOP_TARGET_ROOT="$ROOT" \
         "${PC_NICE[@]}" bash "$APPIMAGE_PRODUCER")
    fi
    assert_linux_artifact_cardinality "$CARGO_TARGET_ROOT/release/bundle"
    # Required for honest salvage: failure must fail this leg, not be swallowed
    # by the later all-platform collector or reported as Linux success.
    emit_linux_build_provenance
    # Commit inside the successful child, before a failed sibling can prevent
    # the parent collector from running.  If this response is lost, the next
    # process reconciles the exact provenance bytes and the same request ID.
    if [[ "${RELEASE_TASK_JOURNAL_ENABLED:-0}" == "1" ]]; then
      release_task_leg_commit linux "$CARGO_TARGET_ROOT/release/bundle" 0
    fi
  ) >"$LINUX_LEG_LOG" 2>&1 &
  LINUX_PID=$!
fi

# ── Mobile (Android) leg — parallel + fatal when enabled (see WITH_ANDROID above).
# Builds fresh design tokens + UniFFI Kotlin bindings, cross-compiles the 4 ABIs,
# and assembles the APK — but NOT install-and-launch (that needs an adb device,
# which a headless release host does not have). The APK lands in the mobile repo's
# own output tree; record-release-cli accepts it only through the builder's
# requested-version/current-source/path/size/hash provenance manifest.
ANDROID_LEG_LOG="/tmp/papercusp-androidleg-${TAG}.log"
ANDROID_PID=""
if [[ "$WITH_ANDROID" == "1" ]]; then
  echo "==> [parallel] launching Android APK+AAB build in $MOBILE_ROOT (required; log: $ANDROID_LEG_LOG)"
  (
    set -euo pipefail
    cd "$MOBILE_ROOT"
    make tokens bindings-kotlin
    # A desktop cut must request store-ready mobile artifacts explicitly.
    # The script's default stays debug-only for developer installs.
    PAPERCUP_RELEASE_VERSION="$VERSION" bash tools/build-scripts/build-android.sh release
  ) >"$ANDROID_LEG_LOG" 2>&1 &
  ANDROID_PID=$!
else
  echo "==> Android leg SKIPPED (WITH_ANDROID=$WITH_ANDROID — sibling papercup-rust-mobile repo/Android SDK absent, or PAPERCUSP_SKIP_MOBILE=1). Desktop-only cut; mobile stays dormant."
fi

WIN_LEG_LOG="/tmp/papercusp-winleg-${TAG}.log"
MAC_LEG_LOG="/tmp/papercusp-macleg-${TAG}.log"
WIN_PID=""; MAC_PID=""; MAC_REUSE=0; WIN_REUSE=0
# Must precede the reuse branch below: prepare is what resolves a committed or
# reconcilable receipt into PAPERCUSP_REUSE_WIN=1 (or refuses a spent request and
# mints a fresh attempt), and that branch reads the flag.
if [[ "${RELEASE_TASK_JOURNAL_ENABLED:-0}" == "1" && "$WITH_WINDOWS" == "1" ]]; then
  release_task_leg_prepare windows "$ROOT/src-tauri/target/windows-vm/bundle/inno" || exit $?
fi
# Same ordering rule for mac: prepare is what resolves a committed or reconcilable
# receipt into PAPERCUSP_REUSE_MAC=1, so it must precede the branch that reads the
# flag. MAC_OUT is bound here rather than inside those branches because prepare
# needs the bundle dir before either has run; the later assignments repeat this
# exact literal (build-mac-cross.sh's own OUT_BUNDLE, via PAPERCUSP_MAC_OUT).
MAC_OUT="$ROOT/src-tauri/target/universal-apple-darwin/release/bundle"
if [[ "${RELEASE_TASK_JOURNAL_ENABLED:-0}" == "1" && "$WITH_MAC" == "1" ]]; then
  release_task_leg_prepare mac "$MAC_OUT" || exit $?
fi
if [[ "$WITH_WINDOWS" == "1" && "${PAPERCUSP_REUSE_WIN:-0}" == "1" ]]; then
  # SALVAGE PATH (2026-07-09, mirror of PAPERCUSP_REUSE_MAC below): the Windows VM
  # + target/windows-vm/bundle/inno are SHARED across lanes and clobber each other
  # (b0fbf windows-parity note) — when a good win 0.0.5 build already exists on the
  # host (e.g. restored/rescued into the inno dir), skip the VM rebuild entirely and
  # let the collection block below sweep the existing artifacts (WIN_REUSE=1 keeps
  # its gate + emptiness check).
  echo "==> [reuse] PAPERCUSP_REUSE_WIN=1 — skipping windows build; reusing artifacts in $ROOT/src-tauri/target/windows-vm/bundle/inno"
  win_reuse_found=0
  for f in "$ROOT"/src-tauri/target/windows-vm/bundle/inno/*; do
    [[ -f "$f" ]] && { echo "    reuse: $(basename "$f")"; win_reuse_found=1; }
  done
  if [[ "$win_reuse_found" != "1" ]]; then
    echo "ERROR: PAPERCUSP_REUSE_WIN=1 but no windows artifacts in $ROOT/src-tauri/target/windows-vm/bundle/inno — restore them there first"; exit 1
  fi
  # P-005: refuse to re-label a different version's salvaged windows bytes as $VERSION.
  assert_reused_provenance "$ROOT/src-tauri/target/windows-vm/bundle/inno" windows
  WIN_REUSE=1
elif [[ "$WITH_WINDOWS" == "1" ]]; then
  # WI-5651: the Windows installer is built NATIVELY on this Linux box by
  # cross-compiling (cargo-xwin) + packing Inno under wine — no QEMU Windows VM,
  # no SSH, no lease contention (the VM's heartbeat deaths caused 3 of WI-5600's
  # failed builds, EI-18152964860625919). This is now the ONLY Windows producer:
  # the QEMU Windows VM (:2223) and bin/build-windows-on-vm.sh were RETIRED after
  # the cross path was validated end-to-end (gates 1-4 proven; a real 0.0.12
  # gui+server cross cut produced byte-shape-identical, minisign-signed artifacts
  # into the SAME OUT_DIR the collect + span->zip + record path below consumes).
  # The cross producer never cuts seed — release-local cut it once above (it
  # ignores the VM-only PAPERCUSP_SKIP_SEED_CUT). The old PAPERCUSP_WINDOWS_CROSS
  # opt-in is gone (cross is unconditional); passing it is now a harmless no-op.
  # Exact-source salvage combines the CURRENT producer logic with the FROZEN
  # target tree, just like release-local itself. Source the current producer
  # while setting $0 to the frozen entrypoint so its ROOT/artifact paths remain
  # pinned to the release source instead of silently switching to canonical.
  WIN_PRODUCER="$ORCHESTRATOR_HERE/build-windows-cross.sh"
  WIN_TARGET_ENTRYPOINT="$ROOT/bin/build-windows-cross.sh"
  echo "==> [parallel] launching Windows x86_64 build NATIVELY on Linux (cross-compile, no VM) (log: $WIN_LEG_LOG)"
  # Native MSVC build (VM: in the QEMU Windows 11 VM, windows-desktop-release-
  # readiness-2026-06-11 D-001; cross: on this box, WI-5651). SKIP the per-build
  # seed cut: release-local already cut src-tauri/seed ONCE above; the producer REUSES it.
  (
    set -euo pipefail
    win_env=(PAPERCUSP_SKIP_SEED_CUT=1 "PAPERCUSP_BUILD_SHA=$BUILD_SHA" "PAPERCUSP_BUILD_VERSION=$VERSION")
    # WI-5600: forward the resolved PAPERCUSP_BUILD_ROLES into the Windows leg,
    # exactly like the mac leg (which must export it because env does not cross
    # ssh). Windows now defaults to gui+server too (build-windows-on-vm.sh), so
    # even an unset caller builds a launchable Windows build (GUI + Server). An
    # explicit `PAPERCUSP_BUILD_ROLES=gui release-local.sh` still reaches Windows
    # verbatim for a deliberate fast gui-only cut. (WI-5559 previously stripped
    # roles here to force gui-only — reversed: that shipped a dead Windows build.)
    win_env+=("PAPERCUSP_BUILD_ROLES=$PAPERCUSP_BUILD_ROLES")
    env "${win_env[@]}" bash -c 'source "$1"' "$WIN_TARGET_ENTRYPOINT" "$WIN_PRODUCER"
  ) >"$WIN_LEG_LOG" 2>&1 &
  WIN_PID=$!
fi
if [[ "$WITH_ARM64" == "1" ]]; then
  echo "==> building Linux arm64 (cross)"
  for role in ${PAPERCUSP_BUILD_ROLES:-gui server}; do
    role_cfg=(); [[ "$role" == "server" ]] && role_cfg=(--config src-tauri/tauri.server.conf.json)
    echo "==> tauri build (linux arm64, role=$role)"
    (cd "$ROOT" && RUSTFLAGS="$PAPERCUSP_LINUX_RUSTFLAGS" PAPERCUSP_BUILD_SHA="$BUILD_SHA" PAPERCUSP_BUILD_VERSION="$VERSION" env "${DESKTOP_CHANNEL_BUILD_ENV[@]}" "${PC_NICE[@]}" npx --yes -p @tauri-apps/cli@"$TAURI_CLI_VERSION" tauri build --target aarch64-unknown-linux-gnu "${role_cfg[@]}" "${DESKTOP_CHANNEL_BUILD_CFG[@]}")
  done
  # The base Tauri config includes deb among the unfiltered arm64 targets.
  # Repack both role artifacts before they enter ARTIFACTS, regenerating updater
  # signatures over the final xz + hardlink-deduplicated bytes.
  for deb in "$CARGO_TARGET_ROOT"/aarch64-unknown-linux-gnu/release/bundle/deb/*_"$VERSION"_*.deb; do
    [[ -f "$deb" ]] && PAPERCUSP_TAURI_CLI_VERSION="$TAURI_CLI_VERSION" bash "$ROOT/bin/repack-deb-xz.sh" "$deb"
  done
  # NOTE: collection deliberately does NOT happen here. The canonical collector
  # below resets ARTIFACTS=() post-join, so an append at this point is discarded
  # — arm64 was the only leg appending before that reset, and its entries never
  # survived. The single live arm64 collection is in that collector block.
fi
if [[ "$WITH_MAC" == "1" && "${PAPERCUSP_REUSE_MAC:-0}" == "1" ]]; then
  # EMERGENCY SALVAGE PATH (last resort — NOT first-class; see EI-12853). REUSE the
  # good mac artifacts already restored into $MAC_OUT from a backed-up successful cut
  # instead of rebuilding. This SHIPS STALE BYTES from a PRIOR cut, so it is only ever
  # a stopgap when a fresh mac build is genuinely impossible — the routine path is to
  # reclaim the VM's regenerable caches (see the disk-preflight branch below) and build
  # fresh. Skip the mac build subshell entirely (MAC_PID stays empty) AND skip the
  # pre-scp clean; the collection block below fires on MAC_REUSE=1. (P-005
  # assert_reused_provenance refuses to relabel a different version's bytes — the guard
  # that stops this stopgap silently mis-shipping an old release as a new one.)
  MAC_OUT="$ROOT/src-tauri/target/universal-apple-darwin/release/bundle"
  echo "==> [reuse] PAPERCUSP_REUSE_MAC=1 — skipping mac build; reusing artifacts in $MAC_OUT"
  mac_reuse_found=0
  for f in "$MAC_OUT"/dmg/*.dmg "$MAC_OUT"/macos/*.app.tar.gz "$MAC_OUT"/macos/*.app.tar.gz.sig; do
    [[ -f "$f" ]] && { echo "    reuse: $(basename "$f")"; mac_reuse_found=1; }
  done
  if [[ "$mac_reuse_found" != "1" ]]; then
    echo "ERROR: PAPERCUSP_REUSE_MAC=1 but no mac artifacts in $MAC_OUT — restore the backup there first"; exit 1
  fi
  # P-005: refuse to re-label a different version's salvaged mac bytes as $VERSION.
  assert_reused_provenance "$MAC_OUT" mac
  MAC_REUSE=1
elif [[ "$WITH_MAC" == "1" ]]; then
  # WI-5651: macOS universal build, cross-compiled NATIVELY on this Linux box
  # (cargo-zigbuild per arch -> llvm-lipo -> hand-assembled .app -> rcodesign ->
  # libdmg-hfsplus dmg) by bin/build-mac-cross.sh -- no QEMU mac VM, no ssh/rsync,
  # no detached-poll, no lease contention (the fragile legs the owner asked to
  # retire). Mirrors the Windows cross leg above. mac-vm-build.sh + the VM
  # systemd/disk are intentionally LEFT IN PLACE (dormant, for on-device TESTING);
  # this leg no longer touches them.
  MAC_PRODUCER="$ROOT/bin/build-mac-cross.sh"
  MAC_OUT="$ROOT/src-tauri/target/universal-apple-darwin/release/bundle"
  # build-mac-cross bundles a fully-DARWIN sidecar (Mach-O node/pg/zellij/...) -- a
  # SEPARATE artifact from the linux sidecar cut above (that one is native/linux).
  # Build it here with TARGET_OS=darwin and hand it to the producer.
  MAC_SIDECAR_DIR="${PAPERCUSP_DARWIN_SIDECAR_DIR:-$ROOT/src-tauri/target/darwin-sidecar}"
  echo "==> [parallel] launching macOS universal build NATIVELY on Linux (cross-compile, no VM) (log: $MAC_LEG_LOG)"
  # Clean stale artifacts FIRST: the mac collection glob is UNSCOPED (app.tar.gz
  # has no version in its filename), so a prior cut's dmg/app would contaminate
  # this release (a stale 0.0.2 dmg nearly shipped in 0.0.3-alpha, 2026-07-08).
  mkdir -p "$MAC_OUT/dmg" "$MAC_OUT/macos"
  release_artifacts_guarded_delete "$MAC_OUT"/dmg/*.dmg "$MAC_OUT"/dmg/*.dmg.sig "$MAC_OUT"/macos/*.app.tar.gz "$MAC_OUT"/macos/*.app.tar.gz.sig \
    || { echo "ERROR: release-retention guard refused stale macOS output cleanup" >&2; exit 1; }
  (
    set -euo pipefail
    # 1) darwin sidecar (Mach-O). Inherits the release env exported above
    #    (PAPERCUSP_SIDECAR_MIN_EPOCH_SEC freshness stamp, PAPERCUSP_RELEASE_AUDIT=1
    #    hard identity-scan, PAPERCUP_DOGFOOD_* bake) exactly like the linux sidecar
    #    build at the top of this script; only TARGET_OS + OUT differ, so it lands
    #    BESIDE -- not on top of -- src-tauri/sidecar/. verify-sidecar-bundle.sh
    #    (incl. the WI-5651 dangling-@loader_path gate) runs inside it.
    echo "==> building darwin sidecar -> $MAC_SIDECAR_DIR (TARGET_OS=darwin, for the mac .app)"
    rm -rf "$MAC_SIDECAR_DIR"
    # The Linux leg exports PAPERCUSP_EXPECTED_SERVE_SHA for consumers that pack
    # that exact sidecar (Windows and the Linux artifacts). Darwin builds a
    # platform-specific sidecar here, so carrying the Linux hash into this leg
    # is a false freshness assertion. Clear the inherited value while building,
    # then bind the mac producer to the hash of the freshly assembled Darwin
    # sidecar. This still catches a concurrent rebuild between assembly and
    # packaging without making cross-platform JavaScript byte identity an
    # accidental release invariant.
    unset PAPERCUSP_EXPECTED_SERVE_SHA
    env \
      TARGET_OS=darwin \
      TARGET_ARCH=x64 \
      PAPERCUSP_SIDECAR_OUT="$MAC_SIDECAR_DIR" \
      "PAPERCUSP_BUILD_SHA=$BUILD_SHA" \
      "PAPERCUSP_BUILD_VERSION=$VERSION" \
      "PROVENANCE_SOURCE_GIT_HEAD=$EXPECTED_SOURCE_SHA" \
      "PROVENANCE_SOURCE_GIT_DIRTY=$PROVENANCE_SOURCE_GIT_DIRTY" \
      "PAPERCUSP_DESKTOP_TARGET_ROOT=$ROOT" \
      bash "$ORCHESTRATOR_HERE/build-desktop-sidecar.sh"
    mac_expected_serve_sha="$(sha256sum "$MAC_SIDECAR_DIR/serve.mjs" 2>/dev/null | cut -d' ' -f1)"
    if [[ -z "$mac_expected_serve_sha" ]]; then
      echo "ERROR: Darwin sidecar build did not produce $MAC_SIDECAR_DIR/serve.mjs — cannot proceed" >&2
      exit 1
    fi
    export PAPERCUSP_EXPECTED_SERVE_SHA="$mac_expected_serve_sha"
    echo "==> mac sidecar freshness (P-004): serve.mjs sha=${mac_expected_serve_sha:0:12}…"
    # 2) universal .app + .app.tar.gz(+.sig) + dmg, bundling that darwin sidecar.
    #    env does not cross a child on its own, so forward the build identity like
    #    the Windows leg. PAPERCUSP_RELEASE_HOST is deliberately NOT forced here:
    #    build-mac-cross loads it from ~/.papercusp/release-host.env (override-safe)
    #    and HARD-GATES that it baked into the binary -- forcing an empty value
    #    would silently skip that gate (the 0.0.8 empty-update-host defect). The
    #    updater signing key defaults to $KEY_FILE inside the producer.
    mac_env=(
      PAPERCUSP_SKIP_SEED_CUT=1
      "PAPERCUSP_BUILD_SHA=$BUILD_SHA"
      "PAPERCUSP_BUILD_VERSION=$VERSION"
      "PAPERCUSP_BUILD_ROLES=$PAPERCUSP_BUILD_ROLES"
      "PAPERCUSP_DARWIN_SIDECAR_DIR=$MAC_SIDECAR_DIR"
      "PAPERCUSP_EXPECTED_SERVE_SHA=$mac_expected_serve_sha"
      "PAPERCUSP_MAC_OUT=$MAC_OUT"
      MAC_BUILD_TARGET=universal-apple-darwin
    )
    env "${mac_env[@]}" bash "$MAC_PRODUCER"
  ) >"$MAC_LEG_LOG" 2>&1 &
  MAC_PID=$!
fi

# ── SUPERVISE all parallel legs CONCURRENTLY; fail fast, salvage the survivors ──
# EI-20549139616021387. The legs are launched in PARALLEL but used to be JOINED in a
# FIXED ORDER (linux → win → mac → android), each join blocking until that ONE leg
# finished. Two defects fell out of that ordering, and the second one is the expensive
# one:
#
#   1. INVISIBILITY. A leg that died at minute 1 was not observed at minute 1 — the
#      parent sat blocked on `joining linux leg` and surfaced NOTHING until the join
#      pointer reached the corpse. Observed on the 0.0.17 cut: ~10 minutes. For that
#      whole window every cheap health signal an observer has produced a confident
#      FALSE HEALTHY — the parent log read healthy, `release:cut status` said running
#      (it was), and a cgroup CPU probe read healthy too, because "three healthy legs"
#      and "three healthy legs plus one corpse" are the same 20-cores-busy reading.
#   2. REAPING. Reaching the corpse then did `exit 1`, and the EXIT trap that fires on
#      it (reap_release_legs, :189) SIGTERMs every still-running build descendant of
#      this cut. On the 0.0.17 cut that was about to destroy a SIGNED 3.34 GB linux
#      .deb minutes from completion, killed by a win leg that had already been dead
#      for ~10 minutes.
#
# So: supervise every leg CONCURRENTLY (`wait -n`), and separate two things the old
# code conflated into one `exit 1`.
#   • The VERDICT is IMMEDIATE. The first death is announced within one wait wakeup,
#     not at its join-order position. From that moment the cut is doomed and WILL exit
#     non-zero; nothing downstream runs. That alone removes the blind spot.
#   • The TEARDOWN is NOT immediate. Healthy siblings are left to FINISH so their
#     artifacts land on disk, because the retry path for exactly that is already in
#     this script: PAPERCUSP_REUSE_LINUX / PAPERCUSP_REUSE_WIN /
#     PAPERCUSP_REUSE_MAC ship
#     artifacts salvaged from a previous attempt. The old behaviour was destroying its
#     own salvage input. RELEASE_ABORT_ON_LEG_FAILURE=1 restores tear-it-down-now, and
#     RELEASE_SALVAGE_GRACE_S=<seconds> bounds the wait for an automated caller.
#
# The same loop emits a per-leg heartbeat, so the parent log stops implying a health it
# has not verified. It grades a leg by PID LIVENESS + LOG MTIME ADVANCING, never by
# grepping the leg log for the word "error": that regex produced 7 false hits in the win
# leg and 5 in mac on the 0.0.17 cut — win's were the identity gate's own prose ("…would
# still have FAILED the file"), mac's were `error: &NSError,`, a Rust struct field quoted
# inside a compiler warning.
LEG_NAMES=(); LEG_PIDS=(); LEG_LOGS=(); LEG_STATE=(); LEG_RC=()
register_leg() {  # $1=name  $2=pid  $3=logfile
  LEG_NAMES+=("$1"); LEG_PIDS+=("$2"); LEG_LOGS+=("$3"); LEG_STATE+=("alive"); LEG_RC+=("")
}
[[ -n "$LINUX_PID"   ]] && register_leg linux   "$LINUX_PID"   "$LINUX_LEG_LOG"
[[ -n "$WIN_PID"     ]] && register_leg win     "$WIN_PID"     "$WIN_LEG_LOG"
[[ -n "$MAC_PID"     ]] && register_leg mac     "$MAC_PID"     "$MAC_LEG_LOG"
[[ -n "$ANDROID_PID" ]] && register_leg android "$ANDROID_PID" "$ANDROID_LEG_LOG"

LEG_HEARTBEAT_S="${RELEASE_LEG_HEARTBEAT_S:-60}"
LEG_TICK_PID=""; LEG_GRACE_PID=""

leg_heartbeat_line() {  # per-leg verdict: liveness + whether the leg's log is still moving
  local i out='' now mt age
  now="$(date +%s)"
  for i in "${!LEG_NAMES[@]}"; do
    case "${LEG_STATE[$i]}" in
      done)   out+=" ${LEG_NAMES[$i]}=done" ;;
      failed) out+=" ${LEG_NAMES[$i]}=FAILED(rc=${LEG_RC[$i]})" ;;
      *)      mt="$(stat -c %Y "${LEG_LOGS[$i]}" 2>/dev/null || true)"
              if [[ -n "$mt" ]]; then
                age=$(( now - mt ))
                out+=" ${LEG_NAMES[$i]}=alive(log+${age}s)"
              else
                out+=" ${LEG_NAMES[$i]}=alive(no-log-yet)"
              fi ;;
    esac
  done
  echo "==> [legs]${out}"
}

supervise_legs() {
  local alive=() kept=() i p rc finished collected idx name first_failed='' grace_expired=0
  for i in "${!LEG_PIDS[@]}"; do alive+=("${LEG_PIDS[$i]}"); done
  (( ${#alive[@]} > 0 )) || return 0
  echo "==> supervising ${#alive[@]} parallel leg(s) CONCURRENTLY: ${LEG_NAMES[*]} — the FIRST death fails the cut immediately; healthy siblings are left to finish (salvage)"
  leg_heartbeat_line

  while (( ${#alive[@]} > 0 )); do
    local wait_set=("${alive[@]}")
    if (( LEG_HEARTBEAT_S > 0 )) && [[ -z "$LEG_TICK_PID" ]]; then
      sleep "$LEG_HEARTBEAT_S" & LEG_TICK_PID=$!
    fi
    [[ -n "$LEG_TICK_PID"  ]] && wait_set+=("$LEG_TICK_PID")
    [[ -n "$LEG_GRACE_PID" ]] && wait_set+=("$LEG_GRACE_PID")

    finished=''
    if wait -n -p finished "${wait_set[@]}"; then rc=0; else rc=$?; fi
    # ⚠ `wait -n -p VAR` UNSETS VAR when it collected no child — it does not leave the
    # pre-set empty value in place — so under this script's `set -u` the very next read
    # of $finished is an "unbound variable" abort. Measured, not theorised: a SIGUSR1
    # storm against the supervising shell killed this loop on its first interrupted
    # wait. Read it through a default ONCE, here, and use $collected below.
    collected="${finished:-}"

    # WI-4230 (0.0.8 false-FAIL): a signal-interrupted `wait` returns >128 — or a
    # spurious 127 — IMMEDIATELY while every leg is still running. The 0.0.8 cut
    # declared the linux leg FAILED mid-appimagetool on exactly that. `wait -n -p`
    # REPORTS the pid it collected, so "no pid reported" IS the no-verdict case and is
    # the whole guard: never grade a leg on a wakeup that named no child.
    # A completed child can be absent from wait -n's candidate set even though
    # its PID is still tracked. In that case bash returns 127 with no PID;
    # probe the tracked legs and synchronously reap a dead one so its actual
    # exit status still reaches the normal leg-accounting path. Without this,
    # the stale PID stays in alive forever and the loop prints "no such job"
    # every five seconds.
    if [[ -z "$collected" && $rc -eq 127 ]]; then
      for p in "${alive[@]}"; do
        if ! kill -0 "$p" 2>/dev/null; then
          collected="$p"
          if wait "$p" 2>/dev/null; then rc=0; else rc=$?; fi
          break
        fi
      done
    fi
    if [[ -z "$collected" ]]; then
      (( rc == 127 )) && sleep 5   # non-child rc: poll instead of hot-spinning
      continue
    fi

    if [[ -n "$LEG_TICK_PID" && "$collected" == "$LEG_TICK_PID" ]]; then
      LEG_TICK_PID=''
      leg_heartbeat_line
      continue
    fi
    if [[ -n "$LEG_GRACE_PID" && "$collected" == "$LEG_GRACE_PID" ]]; then
      LEG_GRACE_PID=''; grace_expired=1
      echo "==> SALVAGE GRACE (${RELEASE_SALVAGE_GRACE_S}s) EXPIRED — no longer waiting on the remaining leg(s). The cut has already failed; the survivors keep running and their artifacts are whatever landed."
      break
    fi

    idx=''
    for i in "${!LEG_PIDS[@]}"; do [[ "${LEG_PIDS[$i]}" == "$collected" ]] && { idx="$i"; break; }; done
    [[ -n "$idx" ]] || continue   # not a leg we track

    name="${LEG_NAMES[$idx]}"
    kept=(); for p in "${alive[@]}"; do [[ "$p" == "$collected" ]] || kept+=("$p"); done
    alive=("${kept[@]}")

    if (( rc == 0 )); then
      LEG_STATE[$idx]='done'
      [[ -f "${LEG_LOGS[$idx]}" ]] && sed "s/^/  [$name] /" "${LEG_LOGS[$idx]}"
      echo "==> $name leg SUCCEEDED"
    else
      LEG_STATE[$idx]='failed'; LEG_RC[$idx]="$rc"
      echo "ERROR: $name leg FAILED (rc=$rc) — full leg log:"
      [[ -f "${LEG_LOGS[$idx]}" ]] && sed "s/^/  [$name] /" "${LEG_LOGS[$idx]}"
      if [[ -z "$first_failed" ]]; then
        first_failed="$name"
        echo "⛔ FIRST LEG DEATH: $name (rc=$rc) at $(date -u +%Y-%m-%dT%H:%M:%SZ) — THIS CUT IS DOOMED and will exit non-zero."
        if (( ${#alive[@]} > 0 )); then
          if [[ "${RELEASE_ABORT_ON_LEG_FAILURE:-0}" == "1" ]]; then
            echo "   RELEASE_ABORT_ON_LEG_FAILURE=1 — tearing down ${#alive[@]} still-running leg(s) NOW (their partial artifacts are forfeit)."
            break
          fi
          echo "   SALVAGE: ${#alive[@]} sibling leg(s) still building. Letting them FINISH so their artifacts"
          echo "   land on disk and a retry can reuse them (PAPERCUSP_REUSE_LINUX / PAPERCUSP_REUSE_WIN / PAPERCUSP_REUSE_MAC), instead"
          echo "   of reaping work that may be minutes from done — the 0.0.17 cut nearly lost a signed 3.34GB"
          echo "   .deb this way. Abort now instead: RELEASE_ABORT_ON_LEG_FAILURE=1. Bound the wait:"
          echo "   RELEASE_SALVAGE_GRACE_S=<seconds>."
          if [[ -n "${RELEASE_SALVAGE_GRACE_S:-}" ]] && (( RELEASE_SALVAGE_GRACE_S > 0 )); then
            sleep "$RELEASE_SALVAGE_GRACE_S" & LEG_GRACE_PID=$!
          fi
        fi
      fi
    fi
    leg_heartbeat_line
  done

  [[ -n "$LEG_TICK_PID"  ]] && { kill "$LEG_TICK_PID"  2>/dev/null || true; LEG_TICK_PID=''; }
  [[ -n "$LEG_GRACE_PID" ]] && { kill "$LEG_GRACE_PID" 2>/dev/null || true; LEG_GRACE_PID=''; }

  local failed=() survived=()
  for i in "${!LEG_NAMES[@]}"; do
    case "${LEG_STATE[$i]}" in
      failed) failed+=("${LEG_NAMES[$i]}(rc=${LEG_RC[$i]})") ;;
      done)   survived+=("${LEG_NAMES[$i]}") ;;
    esac
  done
  if (( ${#failed[@]} > 0 )); then
    echo "ERROR: release cut FAILED — leg(s): ${failed[*]}"
    if (( ${#survived[@]} > 0 )); then
      echo "==> SALVAGED (completed before the cut ended, artifacts are on disk): ${survived[*]}"
      echo "    Re-run with PAPERCUSP_REUSE_LINUX=1 / PAPERCUSP_REUSE_WIN=1 / PAPERCUSP_REUSE_MAC=1 to ship those bytes instead of rebuilding them."
    fi
    (( grace_expired == 1 )) && echo "    (salvage grace expired; leg(s) still running were NOT waited for)"
    exit 1
  fi
  return 0
}
supervise_legs

# Android remains OUTSIDE ARTIFACTS[] (that array feeds the desktop-only updater), but an
# enabled leg is a release promise and is therefore supervised exactly like every desktop
# leg above — its death fails the cut. Then exercise the recorder's manifest verifier and
# require the complete APK+AAB pair before the cut can continue.
if [[ -n "$ANDROID_PID" ]]; then
  PAPERCUSP_ROOT="$(cd "$ROOT/.." && pwd)"
  if ! android_scan="$(cd "$PAPERCUSP_ROOT" && npx tsx apps/operator/lib/release/record-release-cli.ts \
      --scan-mobile --version "$VERSION" --mobile-root "$MOBILE_ROOT")"; then
    echo "ERROR: enabled Android leg built bytes, but provenance validation failed" >&2
    exit 1
  fi
  android_apk_count="$(printf '%s\n' "$android_scan" | awk -F '\t' '$2 ~ /_android\.apk$/ { n++ } END { print n+0 }')"
  android_aab_count="$(printf '%s\n' "$android_scan" | awk -F '\t' '$2 ~ /_android\.aab$/ { n++ } END { print n+0 }')"
  if [[ "$android_apk_count" != "1" || "$android_aab_count" != "1" ]]; then
    echo "ERROR: enabled Android leg must yield exactly one provenanced APK and one AAB (apk=$android_apk_count aab=$android_aab_count)" >&2
    exit 1
  fi
  echo "==> android leg SUCCEEDED — complete provenanced APK+AAB pair for $VERSION"
fi

# ── Collect artifacts in the PARENT, post-join (a subshell's ARTIFACTS+= would not
# survive the fork). Version-scoped globs so a stale older-version bundle can't
# sweep in (desktop-v0.0.2-alpha incident 2026-06-11). ──
ARTIFACTS=()
LINUX_BUNDLE="$CARGO_TARGET_ROOT/release/bundle"
if [[ ! -d "$LINUX_BUNDLE" ]]; then
  echo "ERROR: expected Linux bundles at $LINUX_BUNDLE — Linux leg produced none?"; exit 1
fi
linux_found=0
for f in "$LINUX_BUNDLE"/deb/*_"$VERSION"_*.deb "$LINUX_BUNDLE"/appimage/*_"$VERSION"_*.AppImage \
         "$LINUX_BUNDLE"/appimage/*_"$VERSION"_*.AppImage.sig "$LINUX_BUNDLE"/deb/*_"$VERSION"_*.deb.sig; do
  [[ -f "$f" ]] && ARTIFACTS+=("$f") && linux_found=1
done
[[ "$linux_found" == "1" ]] || { echo "ERROR: no $VERSION linux artifacts in $LINUX_BUNDLE $([[ "$LINUX_REUSE" == "1" ]] && echo '(reuse)' || echo '(fresh build)')"; exit 1; }
assert_linux_artifact_cardinality "$LINUX_BUNDLE"
# Fresh receipts were emitted by the completed Linux child. Only reused bytes
# need collection-time stamping; assert_reused_provenance captured their original
# identity above. Both paths use the same fail-closed shared emitter.
if [[ "$LINUX_REUSE" == "1" ]]; then
  emit_linux_build_provenance
fi
# The child records fresh success early; this idempotent parent settle covers a
# manual reuse path and proves the collected bytes did not change before the
# all-platform join continued.
if [[ "${RELEASE_TASK_JOURNAL_ENABLED:-0}" == "1" ]]; then
  release_task_leg_commit linux "$LINUX_BUNDLE" "$LINUX_REUSE" || exit $?
fi
if [[ "$WITH_ARM64" == "1" ]]; then
  arm64_found=0
  for f in "$CARGO_TARGET_ROOT"/aarch64-unknown-linux-gnu/release/bundle/{deb,appimage}/*_"$VERSION"_*; do
    [[ -f "$f" ]] && ARTIFACTS+=("$f") && arm64_found=1
  done
  # Parity with the linux/win/mac legs, each of which fails the cut on an empty
  # glob. arm64 alone collected silently, so WITH_ARM64=1 could contribute ZERO
  # bytes and still publish a release advertising arm64 support.
  [[ "$arm64_found" == "1" ]] || { echo "ERROR: WITH_ARM64=1 but no $VERSION arm64 artifacts in $CARGO_TARGET_ROOT/aarch64-unknown-linux-gnu/release/bundle"; exit 1; }
fi
if [[ -n "$WIN_PID" || "$WIN_REUSE" == "1" ]]; then
  win_found=0
  # P-009: version-scope so a stale prior-cut installer left in the SHARED inno
  # dir (it isn't cleaned between cuts) can't be swept into this release. The Inno
  # output is "<AppName>_<version>_x64-setup.exe" (+ .sig + any .bin slices), all
  # carrying _<version>_, so this captures every this-version win artifact.
  for f in "$ROOT"/src-tauri/target/windows-vm/bundle/inno/*_"$VERSION"_*; do
    [[ -f "$f" ]] && ARTIFACTS+=("$f") && win_found=1
  done
  [[ "$win_found" == "1" ]] || { echo "ERROR: WITH_WINDOWS=1 but no windows artifacts $([[ "$WIN_REUSE" == "1" ]] && echo "in the inno dir (reuse)" || echo "came back from the VM")"; exit 1; }
  # WI-5600 / EI-20118266632432430: normalize the Server span through the
  # shared helper so this full cut, the direct cross-builder, and incremental
  # publishing all make the same decision. A failure remains safe for this
  # legacy full-cut path: the raw set stays recorded and record-release-cli
  # skips the unusable stub, requiring a manual publish instead of advertising
  # a payload-less download.
  _win_inno_dir="$ROOT/src-tauri/target/windows-vm/bundle/inno"
  if papercusp_normalize_spanned_server "$_win_inno_dir" "$VERSION"; then
    _win_kept=()
    for _a in "${ARTIFACTS[@]}"; do
      papercusp_spanned_server_artifact "$_a" && continue
      _win_kept+=("$_a")
    done
    # OUTPUTS, not the bare zip: the normalization also emits the zip's updater
    # signature, and naming the zip directly is how it shipped unsigned in 0.0.16
    # and 0.0.17 (EI-20595279927716716).
    ARTIFACTS=( "${_win_kept[@]}" "${PAPERCUSP_SPANNED_SERVER_OUTPUTS[@]}" )
    echo "==> [win] spanned Server normalized → $(basename "$PAPERCUSP_SPANNED_SERVER_ZIP") ($(du -h "$PAPERCUSP_SPANNED_SERVER_ZIP" | cut -f1); stub + ${#PAPERCUSP_SPANNED_SERVER_SLICES[@]} slice(s)) — the single download the release page offers"
  elif [[ -n "$PAPERCUSP_SPANNED_SERVER_STUB" && ${#PAPERCUSP_SPANNED_SERVER_SLICES[@]} -gt 0 ]]; then
    echo "WARNING: [win] could not zip the spanned Server set (zip missing or failed) — leaving the raw stub+slices; record-release-cli will SKIP the stub, so publish the Windows Server manually (WI-5600)" >&2
  fi
  # Settled AFTER normalization, so the receipt is taken over the bytes this cut
  # will actually publish. Both paths verify: a fresh build proves its own output,
  # and a reuse re-proves provenance/identity before the receipt is honoured.
  if [[ "${RELEASE_TASK_JOURNAL_ENABLED:-0}" == "1" ]]; then
    release_task_leg_commit windows "$_win_inno_dir" "$WIN_REUSE" || exit $?
  fi
fi
if [[ -n "$MAC_PID" || "$MAC_REUSE" == "1" ]]; then
  MAC_OUT="$ROOT/src-tauri/target/universal-apple-darwin/release/bundle"
  mac_found=0
  # P-009: version-scope the dmg (named "<Product>_<version>_universal-apple-darwin.dmg")
  # so a stale prior-version dmg — 0.0.6 AND 0.0.7 dmgs were found coexisting in this
  # dir — can't be swept in. The .app.tar.gz updater bundle is UNVERSIONED by tauri, so
  # it rides the pre-collection clean (fresh path) / P-005 verification (reuse) plus the
  # cross-version-count assertion below.
  # WI-10003589: the dmg's minisign sibling is part of the published set (D-019 put
  # .dmg in RELEASE_ARTIFACTS_SIGNABLE_SUFFIXES). Omitting it here failed the 0.0.22
  # cut at release.manifest with both .dmg.sig files sitting on disk.
  for f in "$MAC_OUT"/dmg/*_"$VERSION"_*.dmg "$MAC_OUT"/dmg/*_"$VERSION"_*.dmg.sig \
           "$MAC_OUT"/macos/*.app.tar.gz "$MAC_OUT"/macos/*.app.tar.gz.sig; do
    [[ -f "$f" ]] && ARTIFACTS+=("$f") && mac_found=1
  done
  [[ "$mac_found" == "1" ]] || { echo "ERROR: WITH_MAC=1 but no mac artifacts $([[ "$MAC_REUSE" == "1" ]] && echo "in $MAC_OUT (reuse)" || echo "came back from the VM")"; exit 1; }
  # P-009 pre-collection clean ASSERTION: the .app.tar.gz can't be version-filtered, so
  # guard against a stale unversioned bundle by asserting there are no MORE of them than
  # this-version dmgs (tauri emits one dmg + one .app.tar.gz per role).
  _mac_dmg_n=$(find "$MAC_OUT/dmg" -maxdepth 1 -name "*_${VERSION}_*.dmg" 2>/dev/null | wc -l | tr -d ' ')
  _mac_tgz_n=$(find "$MAC_OUT/macos" -maxdepth 1 -name "*.app.tar.gz" 2>/dev/null | wc -l | tr -d ' ')
  if (( _mac_tgz_n > _mac_dmg_n )); then
    echo "ERROR: mac collection has ${_mac_tgz_n} .app.tar.gz updater bundle(s) but only ${_mac_dmg_n} ${VERSION} .dmg — the UNVERSIONED .app.tar.gz set is contaminated by a prior cut (P-009). Clean $MAC_OUT/macos/ and re-cut, or use PAPERCUSP_REUSE_MAC=1 (provenance-verified salvage)."; exit 1
  fi
  # WI-10003577: scan the finished dmgs with THE canonical release gate, not the
  # retired bin/audit-bundle.sh. That script carried its OWN copy of the PostHog-key
  # allowlist (only our public key), which drifted from audit-release-bundle.py's
  # BENIGN_ERE — so the 0.0.22 cut failed on lost-pixel's vendor key, which ships in
  # the Server sidecar ON PURPOSE (design comparison, build-desktop-sidecar.sh) and
  # which the canonical gate already classifies as benign. One gate, one allowlist.
  python3 "$ROOT/bin/audit-release-bundle.py" --scan-artifact "$MAC_OUT"/dmg/*_"$VERSION"_*.dmg
  # EI-8914 parity: the Windows leg records build-provenance.json (⚠ CORRECTED
  # 2026-09-22: via the shared bin/emit-build-provenance.sh called from
  # bin/build-windows-cross.sh — the build-windows-on-vm.sh this line used to name
  # NO LONGER EXISTS, and believing that stale reference is what produced the wrong
  # "windows cannot be journalled" conclusion retracted as plan D-005); the Mac leg
  # never did, so a mac installer was
  # untraceable to its source and — worst on the PAPERCUSP_REUSE_MAC salvage
  # path — a SALVAGED artifact inherited THIS cut's version/sha label with no
  # record of what was actually inside (the LABELED!=PACKED class). Emit the
  # same provenance (each file's sha256 + a `reused` flag) next to the mac
  # artifacts. MANDATORY, not best-effort (P-002 / plan D-006): the .app.tar.gz
  # updater bundle is UNVERSIONED, so the per-artifact sha256 recorded here is
  # the only thing that can tell this cut's bundle from a prior cut's — which
  # makes it the mac phase receipt's completeness ORACLE, not a cross-check.
  # Letting a "hiccup" pass would ship bytes nothing can attribute, and would
  # make a COMPLETE mac build read as retryable-absent to the receipt below.
  # NOTE: PROVENANCE_SIDECAR_DIR is deliberately NOT set here, so `sidecar` records
  # null — "this leg did not record which sidecar was packed" (EI-20086238555902880).
  # Setting it to a local path would be actively WRONG on both of this block's paths:
  # these artifacts were built on the mac VM (their sidecar is the darwin one, not
  # $ROOT/src-tauri/sidecar), and on the MAC_REUSE path they were SALVAGED from an
  # earlier cut entirely. Naming a local directory here would stamp a provenance
  # record for bytes it never packed — manufacturing exactly the LABELED != PACKED
  # claim this file exists to prevent. An honest null beats a confident wrong value.
  # The darwin sidecar IS recorded, at the leg that actually packs it: build-mac-cross.sh.
  _mac_prov_sha="$BUILD_SHA"
  _mac_prov_head="$PROVENANCE_SOURCE_GIT_HEAD"
  _mac_prov_dirty="$PROVENANCE_SOURCE_GIT_DIRTY"
  if [[ "$MAC_REUSE" == "1" ]]; then
    _mac_prov_sha="$MAC_REUSE_BUILD_SHA"
    _mac_prov_head="$MAC_REUSE_GIT_HEAD"
    _mac_prov_dirty="$MAC_REUSE_GIT_DIRTY"
  fi
  PROVENANCE_SOURCE_GIT_HEAD="$_mac_prov_head" \
  PROVENANCE_SOURCE_GIT_DIRTY="$_mac_prov_dirty" \
  PROVENANCE_GIT_ROOT="$ROOT" bash "$ROOT/bin/emit-build-provenance.sh" \
    "$MAC_OUT" "$VERSION" "$_mac_prov_sha" "$([[ "${MAC_REUSE:-0}" == "1" ]] && echo true || echo false)" \
    "$MAC_OUT"/dmg/*_"$VERSION"_*.dmg "$MAC_OUT"/macos/*.app.tar.gz \
    || { echo "ERROR: mac build-provenance.json emit failed — refusing to ship mac artifacts WITHOUT a provenance record (the .app.tar.gz is unversioned; nothing else can prove which cut these bytes belong to)." >&2; exit 1; }
  if [[ "${RELEASE_TASK_JOURNAL_ENABLED:-0}" == "1" ]]; then
    release_task_leg_commit mac "$MAC_OUT" "$MAC_REUSE" || exit $?
  fi
fi

# WI-10003589 / EI-23962107353168459: every leg collector above must carry the
# on-disk .sig of each signable artifact it collected. Without this, a dropped
# signature surfaces only at release.manifest, as the publish-time guard's
# misleading "NO sibling .sig", after the whole cut has run.
release_artifacts_assert_collected_sigs_complete "release-local" "${ARTIFACTS[@]}" \
  || { echo "ERROR: a release-local leg collector dropped an on-disk signature (see above) — fix its glob" >&2; exit 1; }

# Retain all final target/artifact roots only after every enabled leg has
# finished and ARTIFACTS contains the exact bytes this cut will publish.
papercusp_retain_release_paths \
  "$CARGO_TARGET_ROOT" \
  "$ROOT/src-tauri/target/release" \
  "$ROOT/src-tauri/target/windows-vm" \
  "$ROOT/src-tauri/target/universal-apple-darwin" \
  "${ARTIFACTS[@]}" \
  || { echo "ERROR: could not retain final release target/artifact paths" >&2; exit 1; }

# EI-18101626616739029: the manifest-generation logic itself now lives in
# lib/gen-latest-manifest.sh (sourced above) so a single-leg cut
# (bin/gen-latest-manifest.sh) can produce the identical manifest — one
# implementation, no drift between "the real multi-leg release" and a
# manual/single-platform publish.
LATEST_JSON="$(gen_latest_manifest_json_path "$TAG")"
LATEST_SERVER_JSON="$(gen_latest_manifest_server_json_path "$TAG")"
NOTES_FILE="$(gen_latest_manifest_notes_path "$TAG")"
ARTIFACTS_MANIFEST="$(release_artifacts_manifest_path "$TAG")"

# A committed manifest receipt never bypasses the bytes: the prepare call
# hashes the exact artifact inputs, reproduces the canonical generator in an
# isolated namespace, and compares its normalized outputs plus the exact
# artifact ledger.  Only a fully verified match skips regeneration.
release_task_prepare_manifest_stage "${ARTIFACTS[@]}" || exit $?
if [[ "$RELEASE_TASK_MANIFEST_SKIP" != "1" ]]; then
  echo "==> generating latest.json + latest-server.json"
  gen_latest_manifest "$VERSION" "$CHANNEL" "$TAG" "${ARTIFACTS[@]}"

  # EI-12913: record the EXACT artifact set (inno .exe + .sig + every DiskSpanning
  # .bin slice, all mac + linux bundles) that this cut produced, so upload-release.sh
  # publishes THIS list instead of re-deriving its own (which drifted: it scanned the
  # wrong tree and excluded .bin, dropping the Server payload). ARTIFACTS[] here is
  # authoritative — it already caught the inno dir + .bin slices via the version-scoped
  # globs above. Written next to latest.json in /tmp (same TAG-scoped lifecycle).
  ARTIFACTS_MANIFEST="$(release_artifacts_write "$TAG" "${ARTIFACTS[@]}")"
  echo "==> artifact manifest: $ARTIFACTS_MANIFEST (${#ARTIFACTS[@]} files — upload-release.sh reads this)"
  release_task_commit_manifest_stage "${ARTIFACTS[@]}" || exit $?
else
  echo "==> artifact manifest: $ARTIFACTS_MANIFEST (${#ARTIFACTS[@]} verified files — journal reuse)"
fi

vh_begin tag
echo "==> committing version bump"
git -C "$ROOT" add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git -C "$ROOT" commit -m "release: $TAG" 2>&1 | tail -3 || echo "(nothing to commit)"

echo "==> tagging $TAG (local)"
git -C "$ROOT" tag -f "$TAG"

# ── Canonical version writeback (WI-10001570) ───────────────────────────────
# $ROOT is derived from where THIS script lives, so a cut launched against an
# isolated worktree (release:cut { root }) bumps ONLY that throwaway checkout.
# That worktree's papercusp-desktop/.git is an INDEPENDENT clone, not a linked
# worktree sharing an object store, and the GitHub publish/push leg below is
# DELETED under LOCAL-only — so the commit and tag just made reach the canonical
# repo by NO route at all and die with the worktree. That is how 0.0.18 shipped
# while every canonical manifest still read 0.0.17, and why the desktop app kept
# reporting a version that was never cut.
#
# Write the same fields into the canonical checkout and STOP. Deliberately NO
# commit and NO push: git-sync owns commit+push for the shared tree and sweeps
# the submodule on its own schedule.
CANONICAL_WRITEBACK_STATUS=0
if [[ -z "${PAPERCUSP_RELEASE_CANONICAL_DESKTOP_ROOT:-}" ]]; then
  echo "==> canonical writeback: skipped (PAPERCUSP_RELEASE_CANONICAL_DESKTOP_ROOT unset)"
elif ! _canon="$(cd "${PAPERCUSP_RELEASE_CANONICAL_DESKTOP_ROOT}" 2>/dev/null && pwd)"; then
  echo "⛔ canonical writeback: PAPERCUSP_RELEASE_CANONICAL_DESKTOP_ROOT=${PAPERCUSP_RELEASE_CANONICAL_DESKTOP_ROOT} is not a readable directory" >&2
  CANONICAL_WRITEBACK_STATUS=1
elif [[ "$_canon" == "$ROOT" ]]; then
  echo "==> canonical writeback: not needed (cut ran in the canonical checkout)"
elif [[ ! -f "$_canon/src-tauri/tauri.conf.json" ]]; then
  echo "⛔ canonical writeback: $_canon is not a papercusp-desktop checkout (no src-tauri/tauri.conf.json)" >&2
  CANONICAL_WRITEBACK_STATUS=1
else
  echo "==> canonical writeback: $VERSION → $_canon (files only; git-sync commits)"
  if ! bump_version_manifests "$_canon" with-lock; then
    echo "⛔ canonical writeback: rewriting manifests FAILED" >&2
    CANONICAL_WRITEBACK_STATUS=1
  # Re-read what is actually on disk. A rewrite reporting success is not proof the
  # canonical repo received it, and a silent miss here is invisible until a release
  # later, when every source build still reports the previous version.
  elif ! python3 - "$VERSION" "$_canon" <<'PY'
import json, re, sys, pathlib
version, root = sys.argv[1], pathlib.Path(sys.argv[2])
bad = []

pkg = root / "package.json"
if pkg.exists() and json.loads(pkg.read_text()).get("version") != version:
    bad.append("package.json")

tauri_conf = root / "src-tauri" / "tauri.conf.json"
if json.loads(tauri_conf.read_text()).get("version") != version:
    bad.append("src-tauri/tauri.conf.json")

m = re.search(r'(?m)^version = "([^"]+)"', (root / "src-tauri" / "Cargo.toml").read_text())
if not m or m.group(1) != version:
    bad.append("src-tauri/Cargo.toml")

lock = root / "src-tauri" / "Cargo.lock"
if lock.exists():
    m = re.search(
        r'(?m)^\[\[package\]\]\nname = "papercusp-desktop"\nversion = "([^"]+)"',
        lock.read_text(),
    )
    if not m or m.group(1) != version:
        bad.append("src-tauri/Cargo.lock")

if bad:
    print("  !! not at " + version + ": " + ", ".join(bad), file=sys.stderr)
    sys.exit(1)
print(f"  verified: canonical checkout reads {version}")
PY
  then
    echo "⛔ canonical writeback: verification FAILED — the canonical checkout is NOT at $VERSION" >&2
    CANONICAL_WRITEBACK_STATUS=1
  fi
fi

# ── ⛔ LOCAL-only. The GitHub publish leg was REMOVED (2026-07-12, WI-desktop-release-0-0-8).
# Owner directive (2026-07-08, restated 2026-07-12): "We are no longer using github for our
# releases so just build the installer locally and I will upload it to the right spot."
# This script therefore builds + signs + writes latest.json and STOPS. The signed artifacts
# on disk ARE the deliverable; hand the owner the paths + sha256s below.
#
# There is deliberately NO publish flag. The former PAPERCUSP_PUBLISH_GITHUB=1 opt-out — and
# the `git push origin HEAD "$TAG"` + `gh release create/upload` it guarded — are DELETED
# rather than left dormant: a superseded outward-facing path kept "just in case" is exactly
# the footgun that publishes a release nobody meant to publish. Restore from git history if
# GitHub releases ever come back.
echo
echo "==> done (LOCAL-only — nothing was pushed to GitHub)"
echo "    tag:       $TAG (local, not pushed)"
echo "    manifest:  $LATEST_JSON"
[[ -f "$LATEST_SERVER_JSON" ]] && echo "    manifest (server): $LATEST_SERVER_JSON"
echo "    notes:     $NOTES_FILE"
echo "    artifacts: ${#ARTIFACTS[@]}"
echo "    hand-off:  give the owner the paths + sha256 below."
for f in "${ARTIFACTS[@]}"; do
  [[ -f "$f" ]] && echo "      $f  sha256:$(sha256sum "$f" 2>/dev/null | cut -d' ' -f1)"
done

# Reported AFTER the handoff above so a writeback failure can never cost the
# operator the artifact paths + sha256s — but it still FAILS the cut, because the
# whole point is that this loss is otherwise silent until a release later.
if [[ "${CANONICAL_WRITEBACK_STATUS:-0}" -ne 0 ]]; then
  echo
  echo "⛔ FAILED: the canonical version writeback did not land (see the error above)."
  echo "   The artifacts listed above are valid and signed — nothing about them is in doubt."
  echo "   What is wrong: the canonical papercusp-desktop checkout is NOT at $VERSION, so a"
  echo "   source build there will keep reporting the previous version. Fix that, then"
  echo "   leave the files for git-sync (do NOT commit or push them yourself)."
  exit 1
fi
